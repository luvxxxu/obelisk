import { describe, expect, test } from 'bun:test';
import type { PlanItem } from '../src/impact';
import {
  chatMessage,
  createWebhookInput,
  detectWebhookFormat,
  maskWebhookUrl,
  parseIncoming,
  scheduleAlerts,
  scheduleSummary,
  webhookEventFor,
  webhookText,
  type WebhookPayload,
} from '../src/webhooks';

const TODAY = '2026-11-13'; // Friday

describe('webhookEventFor', () => {
  test('task events map to their own keys; completing is its own event', () => {
    expect(webhookEventFor('task.created', {})).toEqual({ key: 'task.created', event: 'task.created' });
    expect(webhookEventFor('task.updated', { changes: { dueDate: { from: '2026-11-20', to: '2026-11-22' } } })).toEqual({
      key: 'task.updated',
      event: 'task.updated',
    });
    expect(webhookEventFor('task.updated', { changes: { status: { from: 'doing', to: 'done' } } })).toEqual({
      key: 'task.completed',
      event: 'task.completed',
    });
    expect(webhookEventFor('task.updated', { changes: { status: { from: 'done', to: 'todo' } } })?.key).toBe('task.updated');
    expect(webhookEventFor('task.postponed', {})?.key).toBe('task.postponed');
    expect(webhookEventFor('task.deleted', {})).toEqual({ key: 'task.deleted', event: 'task.deleted' });
  });

  test('a restore reaches 새 작업 subscribers under its own event name', () => {
    expect(webhookEventFor('task.restored', {})).toEqual({ key: 'task.created', event: 'task.restored' });
  });

  test('dependencies, projects and organization events group under one key', () => {
    expect(webhookEventFor('dependency.added', {})).toEqual({ key: 'task.dependency', event: 'dependency.added' });
    expect(webhookEventFor('project.archived', {})).toEqual({ key: 'project', event: 'project.archived' });
    expect(webhookEventFor('member.joined', {})).toEqual({ key: 'organization', event: 'member.joined' });
    expect(webhookEventFor('invite.created', {})?.key).toBe('organization');
    expect(webhookEventFor('something.else', {})).toBeNull();
  });
});

describe('formats', () => {
  test('detects Slack and Discord incoming-webhook URLs', () => {
    expect(detectWebhookFormat('https://hooks.slack.com/services/T0/B0/xyz')).toBe('slack');
    expect(detectWebhookFormat('https://discord.com/api/webhooks/1/abc')).toBe('discord');
    expect(detectWebhookFormat('https://discordapp.com/api/webhooks/1/abc')).toBe('discord');
    expect(detectWebhookFormat('https://discord.com/channels/1')).toBe('json');
    expect(detectWebhookFormat('https://example.com/hook')).toBe('json');
    expect(detectWebhookFormat('not a url')).toBe('json');
  });

  test('masks the secret part of a URL', () => {
    expect(maskWebhookUrl('https://hooks.slack.com/services/T0AAA/B0BBB/abcdef123456')).toBe('hooks.slack.com/services/…3456');
    expect(maskWebhookUrl('https://example.com/hook')).toBe('example.com/hook');
    expect(maskWebhookUrl('https://example.com')).toBe('example.com');
  });

  test('event inputs are de-duplicated and need at least one event', () => {
    const ok = createWebhookInput.safeParse({ name: 'a', url: 'https://x.com', events: ['task.created', 'task.created'] });
    expect(ok.success && ok.data.events).toEqual(['task.created']);
    expect(createWebhookInput.safeParse({ name: 'a', url: 'https://x.com', events: [] }).success).toBe(false);
    expect(createWebhookInput.safeParse({ name: 'a', url: 'ftp://x.com', events: ['task.created'] }).success).toBe(false);
  });
});

const payload = (over: Partial<WebhookPayload> = {}): WebhookPayload => ({
  id: 'e1',
  event: 'task.updated',
  createdAt: '2026-11-13T00:00:00.000Z',
  workspace: { id: 'w', name: '디자인팀', kind: 'org' },
  actor: { id: 'u', name: '민겸', via: 'session', client: null },
  subject: '#12 기획서',
  summary: '마감일 11/20 → 11/22',
  text: '',
  url: 'https://obelisk.test/t/1',
  ...over,
});

describe('messages', () => {
  test('text line: actor · subject — summary, with the door it came through', () => {
    expect(webhookText(payload())).toBe('민겸 · #12 기획서 — 마감일 11/20 → 11/22');
    expect(webhookText(payload({ actor: { id: 'u', name: '민겸', via: 'webhook', client: 'CI' } }))).toBe(
      '민겸 (웹훅 “CI” 통해) · #12 기획서 — 마감일 11/20 → 11/22',
    );
    expect(webhookText(payload({ actor: null, summary: '오늘 마감' }))).toBe('#12 기획서 — 오늘 마감');
  });

  test('Slack: mrkdwn link, escaped names, no unfurl', () => {
    const m = chatMessage(payload({ subject: '#12 A<B>&C', event: 'task.completed', summary: '완료' }), 'slack');
    expect(m.text).toBe('✅ *민겸* · <https://obelisk.test/t/1|#12 A&lt;B&gt;&amp;C> — 완료');
    expect(m.unfurl_links).toBe(false);
  });

  test('Discord: masked link without embed, markdown escaped, mentions off', () => {
    const m = chatMessage(payload({ actor: { id: 'u', name: '@everyone', via: 'session', client: null } }), 'discord');
    expect(m.content).toBe('**@​everyone** · [\\#12 기획서](<https://obelisk.test/t/1>) — 마감일 11/20 → 11/22');
    expect(m.allowed_mentions).toEqual({ parse: [] });
  });
});

const item = (id: string, over: Partial<PlanItem> = {}): PlanItem => ({
  id,
  title: id,
  status: 'todo',
  startDate: null,
  dueDate: null,
  fixed: false,
  projectId: 'p',
  ...over,
});

describe('scheduleAlerts', () => {
  test('due today, due tomorrow and overdue (with days)', () => {
    const alerts = scheduleAlerts(
      [
        item('a', { dueDate: TODAY }),
        item('b', { dueDate: '2026-11-14' }),
        item('c', { dueDate: '2026-11-10' }),
        item('d', { dueDate: '2026-11-20' }),
        item('e', { dueDate: '2026-11-10', status: 'done' }),
      ],
      [],
      TODAY,
    );
    expect(alerts).toEqual([
      { key: 'task.due_today', taskId: 'a' },
      { key: 'task.due_soon', taskId: 'b' },
      { key: 'task.overdue', taskId: 'c', daysOverdue: 3 },
    ]);
  });

  test('fixed-date conflict names the late task at the start of the chain', () => {
    const alerts = scheduleAlerts(
      [
        item('late', { startDate: '2026-11-09', dueDate: '2026-11-11' }),
        item('mid', { startDate: '2026-11-12', dueDate: '2026-11-16' }),
        item('demo', { startDate: '2026-11-16', dueDate: '2026-11-16', fixed: true }),
      ],
      [
        { taskId: 'mid', dependsOnId: 'late' },
        { taskId: 'demo', dependsOnId: 'mid' },
      ],
      TODAY,
    );
    const conflict = alerts.find((a) => a.key === 'fixed.conflict');
    expect(conflict).toMatchObject({ taskId: 'demo', causeId: 'late' });
    expect(conflict!.overrunDays).toBeGreaterThan(0);
    expect(scheduleSummary(conflict!, '#3 시안')).toBe(`고정 일정 충돌 · #3 시안 지연으로 ${conflict!.overrunDays}일 넘침`);
    expect(scheduleSummary({ key: 'task.overdue', daysOverdue: 2 })).toBe('마감 2일 지남');
  });
});

describe('parseIncoming', () => {
  const ok = (body: unknown) => {
    const r = parseIncoming(body, TODAY);
    if (!r.ok) throw new Error(r.error);
    return r.command;
  };
  const err = (body: unknown) => {
    const r = parseIncoming(body, TODAY);
    if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.command)}`);
    return r.error;
  };

  test('plain text creates with quick-add syntax; later lines become notes', () => {
    expect(ok('보고서 초안 내일 !높음 #런칭')).toEqual({
      kind: 'create',
      title: '보고서 초안',
      dueDate: '2026-11-14',
      priority: 3,
      project: '런칭',
    });
    expect(ok('배포 확인\n로그 먼저 보기\n롤백 준비')).toEqual({ kind: 'create', title: '배포 확인', notes: '로그 먼저 보기\n롤백 준비' });
    expect(ok({ text: '회의록 정리' })).toEqual({ kind: 'create', title: '회의록 정리' });
  });

  test('"#12 …" changes an existing task', () => {
    expect(ok('#12 완료')).toEqual({ kind: 'update', task: '#12', patch: { status: 'done' } });
    expect(ok('#12 done.')).toEqual({ kind: 'update', task: '#12', patch: { status: 'done' } });
    expect(ok('#7 다시 열기')).toEqual({ kind: 'update', task: '#7', patch: { status: 'todo' } });
    expect(ok('#12 시작')).toEqual({ kind: 'update', task: '#12', patch: { status: 'doing' } });
    expect(ok('#12 금요일까지')).toEqual({ kind: 'update', task: '#12', patch: { dueDate: '2026-11-20' } });
    expect(ok('#12 !높음')).toEqual({ kind: 'update', task: '#12', patch: { priority: 3 } });
    expect(err('#12 이상한 말')).toContain('이해하지 못했습니다');
    expect(err('#12')).toContain('#12 완료');
  });

  test('JSON create with friendly values', () => {
    expect(
      ok({ title: ' 배포 확인 ', dueDate: '내일', priority: 'high', project: '런칭', assignee: 'me', fixed: 'true', notes: 'n' }),
    ).toEqual({
      kind: 'create',
      title: '배포 확인',
      dueDate: '2026-11-14',
      priority: 3,
      project: '런칭',
      assignee: 'me',
      fixed: true,
      notes: 'n',
    });
    expect(ok({ title: 'x', dueDate: '2026-11-20T09:00:00Z', priority: '보통' })).toMatchObject({ dueDate: '2026-11-20', priority: 2 });
    expect(err({ title: 'x', dueDate: '언젠가' })).toContain('dueDate');
    expect(err({ title: 'x', priority: 9 })).toContain('priority');
    expect(err({ title: 'x', startDate: '2026-11-20', dueDate: '2026-11-18' })).toContain('시작일');
    expect(err({})).toContain('title');
  });

  test('JSON actions change a task by number or id only', () => {
    expect(ok({ action: 'complete', task: '#12' })).toEqual({ kind: 'update', task: '#12', patch: { status: 'done' } });
    expect(ok({ action: 'complete', task: 12 })).toEqual({ kind: 'update', task: '#12', patch: { status: 'done' } });
    expect(ok({ action: 'update', task: '#3', dueDate: null, priority: 'low' })).toEqual({
      kind: 'update',
      task: '#3',
      patch: { dueDate: null, priority: 1 },
    });
    expect(ok({ task: '#3', status: '진행 중' })).toEqual({ kind: 'update', task: '#3', patch: { status: 'doing' } });
    expect(err({ action: 'update', task: '#3' })).toContain('바꿀 내용');
    expect(err({ action: 'complete', task: '기획서' })).toContain('작업 번호');
    expect(err({ action: 'explode', task: '#1' })).toContain('action');
    expect(err({ action: 'complete', task: '#1', status: 'todo' })).toContain('서로 다릅니다');
  });

  test('rejects bodies that are neither text nor an object', () => {
    expect(err([1, 2])).toContain('JSON 객체');
    expect(err('   ')).toContain('비어');
  });
});
