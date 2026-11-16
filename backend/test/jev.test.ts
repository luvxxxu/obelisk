import { describe, expect, test } from 'bun:test';
import { priorityFromScore, priorityScore, suggestPriority, type TaskJudgment } from '@obelisk/core';
import { seal, unseal } from '../src/common/secret';
import { askJev, JEV_ENDPOINT, JevError, type JevQuestion, type Transport } from '../src/jev/jev.client';
import { deferrableQ, importanceQ, othersQ, relationQ, taskState } from '../src/jev/jev.questions';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const questions: Record<string, JevQuestion> = {
  imp: importanceQ('`task`'),
  def: deferrableQ('`task`'),
  rel: relationQ('`candidate`', '`task`'),
};

describe('Jev client', () => {
  test('sends the model, state and questions with the bearer key, and reads typed answers', async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const transport: Transport = async (url, init) => {
      sent = { url, init };
      return json({
        model: 'jev-1.14.0',
        answers: {
          imp: { type: 'score', score: 2.4, confidence: 0.9, probabilities: { '2': 0.6, '3': 0.4 } },
          def: { type: 'noul', noul: 0.2 },
          rel: { type: 'choice', choice: 'before', confidence: 0.8, probabilities: { before: 0.9, after: 0.05, independent: 0.05 } },
        },
        usage: { input_tokens: 120, output_tokens: 9 },
      });
    };
    const r = await askJev('key_123', { state: { task: { title: '세금 신고' } }, questions }, { fetch: transport });
    expect(sent!.url).toBe(JEV_ENDPOINT);
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe('Bearer key_123');
    const body = JSON.parse(String(sent!.init.body));
    expect(body.model).toBe('jev-latest');
    expect(Object.keys(body.questions)).toEqual(['imp', 'def', 'rel']);
    expect(r.model).toBe('jev-1.14.0');
    expect(r.answers.imp).toMatchObject({ type: 'score', score: 2.4, confidence: 0.9 });
    expect(r.answers.def).toEqual({ type: 'noul', noul: 0.2 });
    expect(r.answers.rel).toMatchObject({ type: 'choice', choice: 'before' });
  });

  test('drops malformed answers instead of failing the whole call', async () => {
    const transport: Transport = async () =>
      json({
        answers: {
          imp: { type: 'score', score: 'high' },
          def: { type: 'noul', noul: 7 },
          rel: { type: 'choice', choice: 'sideways', probabilities: {} },
        },
      });
    const r = await askJev('k'.repeat(20), { state: 's', questions }, { fetch: transport });
    expect(r.answers.imp).toBeUndefined();
    expect(r.answers.def).toEqual({ type: 'noul', noul: 1 }); // clamped
    expect(r.answers.rel).toBeUndefined();
  });

  test('a rejected key fails fast with a Korean message; rate limits are retried', async () => {
    let calls = 0;
    const unauthorized: Transport = async () => (calls++, json({ error: 'unauthorized' }, 401));
    const err = await askJev('bad', { state: 's', questions }, { fetch: unauthorized }).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).code).toBe('auth');
    expect((err as JevError).message).toContain('설정 → Jev');
    expect(calls).toBe(1);

    calls = 0;
    const flaky: Transport = async () => (++calls < 2 ? json({}, 429) : json({ answers: { def: { type: 'noul', noul: 0.5 } } }));
    const ok = await askJev('k', { state: 's', questions: { def: questions.def! } }, { fetch: flaky });
    expect(calls).toBe(2);
    expect(ok.answers.def).toEqual({ type: 'noul', noul: 0.5 });
  });

  test('network failures become a JevError, not an unhandled exception', async () => {
    const down: Transport = async () => {
      throw new TypeError('fetch failed');
    };
    const err = await askJev('k', { state: 's', questions }, { fetch: down, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).code).toBe('network');
  });
});

describe('sealed keys', () => {
  test('round-trips and refuses tampering', () => {
    const sealed = seal('apikey_secret_value');
    expect(sealed).not.toContain('apikey_secret_value');
    expect(unseal(sealed)).toBe('apikey_secret_value');
    const parts = sealed.split('.');
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('A') ? 'BB' : 'AA');
    expect(unseal(parts.join('.'))).toBeNull();
    expect(unseal('not-sealed')).toBeNull();
    expect(seal('x')).not.toBe(seal('x'));
  });
});

test('task state never carries ids, only what a person would read', () => {
  const s = taskState(
    { title: '  출시   공지 ', notes: '', status: 'doing', dueDate: '2026-11-18', startDate: null, fixed: false, postponedCount: 2 },
    { project: '런칭', waiting: ['베타 오픈'], waitsOn: [] },
    '2026-11-16',
  );
  expect(s).toEqual({
    title: '출시 공지',
    project: '런칭',
    status: 'in progress',
    due: '2026-11-18 Wed (in 2 days)',
    tasks_waiting_for_it: ['베타 오픈'],
    times_postponed: 2,
  });
});

/**
 * Real Jev on a few Korean tasks (sends only these sample titles). Run with
 *   TYPESAFE_API_KEY=… OBELISK_LIVE_JEV=1 bun test backend/test/jev.test.ts
 */
test.skipIf(process.env.OBELISK_LIVE_JEV !== '1')('hosted Jev ranks real Korean tasks sensibly', async () => {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('Set TYPESAFE_API_KEY');
  const titles = ['종합소득세 신고 마감', '책상 정리', '팀 주간 회의', '블로그 글 아이디어 메모'];
  const qs: Record<string, JevQuestion> = {};
  titles.forEach((_, i) => {
    qs[`imp_${i}`] = importanceQ(`\`tasks.t${i}\``);
    qs[`oth_${i}`] = othersQ(`\`tasks.t${i}\``);
    qs[`def_${i}`] = deferrableQ(`\`tasks.t${i}\``);
  });
  const state = { today: '2026-11-16 Mon', tasks: Object.fromEntries(titles.map((title, i) => [`t${i}`, { title, status: 'not started', due: '2026-11-16 Mon (today)' }])) };
  const r = await askJev(key, { state, questions: qs });
  const j = (i: number): TaskJudgment => {
    const imp = r.answers[`imp_${i}`];
    const n = (id: string) => (r.answers[id]?.type === 'noul' ? (r.answers[id] as { noul: number }).noul : 0.5);
    return { importance: imp?.type === 'score' ? imp.score : 1.5, importanceConfidence: imp?.type === 'score' ? imp.confidence : 0, others: n(`oth_${i}`), deferrable: n(`def_${i}`) };
  };
  const p = (i: number) => suggestPriority({ id: String(i), priority: 0, dueDate: '2026-11-16', startDate: null, fixed: false, status: 'todo' }, j(i), undefined, '2026-11-16').suggested;
  expect(p(0)).toBe(3);
  expect(p(1)).toBeLessThanOrEqual(1);
  expect(j(1).deferrable).toBeGreaterThan(j(0).deferrable);
  expect(j(2).others).toBeGreaterThan(0.6);
  expect(priorityFromScore(priorityScore(j(3), 0.1, 0))).toBeLessThanOrEqual(1);
}, 30_000);
