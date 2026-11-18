import { describe, expect, test } from 'bun:test';
import {
  autoApplicable,
  capacityFromHistory,
  cloudflareJevUrl,
  DEFAULT_JEV_BASE_URL,
  jevEndpoint,
  jevPresetOf,
  pickFocus,
  planPostpone,
  priorityFromScore,
  priorityScore,
  suggestPriority,
  urgencyOf,
  type TaskJudgment,
} from '../src/jev';
import type { Task } from '../src/types';

const TODAY = '2026-11-16';
let seq = 0;
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  workspaceId: 'w',
  number: ++seq,
  title: id,
  notes: '',
  status: 'todo',
  priority: 0,
  projectId: null,
  startDate: null,
  startTime: null,
  dueDate: null,
  dueTime: null,
  fixed: false,
  position: seq,
  postponedCount: 0,
  assigneeId: null,
  createdBy: 'me',
  completedAt: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...extra,
});
const J = (importance: number, deferrable = 0.5, others = 0.2, importanceConfidence = 0.95): TaskJudgment => ({
  importance,
  deferrable,
  others,
  importanceConfidence,
});

describe('urgency', () => {
  test('grows as the due date nears and saturates once overdue', () => {
    const at = (dueDate: string) => urgencyOf({ dueDate, startDate: null, fixed: false, status: 'todo' }, TODAY);
    expect(at('2026-11-14')).toMatchObject({ value: 1, days: -2, label: '2일 지남' });
    expect(at('2026-11-16').label).toBe('오늘 마감');
    expect(at('2026-11-17').value).toBeGreaterThan(at('2026-11-20').value);
    expect(at('2026-12-20').value).toBeLessThan(0.2);
  });

  test('a fixed commitment this week counts as urgent', () => {
    const u = urgencyOf({ dueDate: null, startDate: '2026-11-20', fixed: true, status: 'todo' }, TODAY);
    expect(u.value).toBeGreaterThanOrEqual(0.6);
  });
});

describe('priority (Jev importance × engine urgency)', () => {
  // Importance levels as Jev returned them for real Korean tasks (probe, 2026-11-16).
  test('high stakes due today → 높음, desk tidying due today → 낮음', () => {
    const tax = suggestPriority(task('tax', { dueDate: TODAY }), J(2.95), undefined, TODAY);
    const desk = suggestPriority(task('desk', { dueDate: TODAY }), J(0.99), undefined, TODAY);
    expect(tax.suggested).toBe(3);
    expect(desk.suggested).toBe(1);
    expect(tax.reasons[0]).toBe('놓치면 손해가 큰 일');
    expect(tax.reasons).toContain('오늘 마감');
  });

  test('an important task far away is 보통 until its date nears', () => {
    const far = suggestPriority(task('far', { dueDate: '2026-12-08' }), J(3), undefined, TODAY);
    const near = suggestPriority(task('near', { dueDate: '2026-11-17' }), J(3), undefined, TODAY);
    expect(far.suggested).toBe(2);
    expect(near.suggested).toBe(3);
  });

  test('someday ideas get no priority; blocking work gets a bump', () => {
    expect(suggestPriority(task('idea'), J(0.2), undefined, TODAY).suggested).toBe(0);
    const lev = { taskId: 'x', downstreamCount: 3, slackDays: 0, delayedIfLate: 2, conflictsIfLate: 1 };
    const plain = priorityScore(J(2), 0.5, 0);
    const holding = priorityScore(J(2), 0.5, 1);
    expect(holding).toBeGreaterThan(plain);
    const s = suggestPriority(task('x', { dueDate: '2026-11-20' }), J(2), lev, TODAY);
    expect(s.reasons).toContain('하루 늦으면 고정 일정과 충돌');
    expect(priorityFromScore(s.score)).toBe(s.suggested);
  });

  test('confidence drops on a cut point and auto-apply only fills missing priorities', () => {
    const sure = suggestPriority(task('a', { dueDate: TODAY }), J(2.95, 0.5, 0.2, 0.97), undefined, TODAY);
    expect(sure.confidence).toBeGreaterThan(0.8);
    expect(autoApplicable(sure)).toBe(true);
    expect(autoApplicable({ ...sure, current: 1 })).toBe(false);
    const unsure = suggestPriority(task('b', { dueDate: TODAY }), J(2.95, 0.5, 0.2, 0.5), undefined, TODAY);
    expect(autoApplicable(unsure)).toBe(false);
  });
});

describe('focus', () => {
  test('picks the best startable task for today; blocked work waits', () => {
    const a = task('a', { dueDate: TODAY });
    const b = task('b', { dueDate: TODAY });
    const c = task('c', { dueDate: '2026-11-25' });
    const scores = new Map([
      ['a', 0.5],
      ['b', 0.9],
      ['c', 0.99],
    ]);
    expect(pickFocus([a, b, c], [], scores, TODAY)).toBe('b');
    expect(pickFocus([a, b, c], [{ taskId: 'b', dependsOnId: 'a' }], scores, TODAY)).toBe('a');
  });

  test('in-progress work wins a near tie', () => {
    const a = task('a', { dueDate: TODAY, status: 'doing' });
    const b = task('b', { dueDate: TODAY });
    expect(pickFocus([a, b], [], new Map([['a', 0.6], ['b', 0.63]]), TODAY)).toBe('a');
  });
});

describe('what to postpone', () => {
  const mine = () => true;
  const editable = () => true;

  test('an overloaded day sheds the tasks Jev says can wait, onto lighter days', () => {
    const tasks = [
      task('tax', { dueDate: TODAY }),
      task('desk', { dueDate: TODAY }),
      task('gym', { dueDate: TODAY }),
      task('deck', { dueDate: TODAY }),
      task('meeting', { dueDate: TODAY, fixed: true }),
      task('blog', { dueDate: '2026-11-14' }),
    ];
    const judgments = new Map([
      ['tax', J(2.95, 0.32)],
      ['desk', J(0.99, 0.87)],
      ['gym', J(0.95, 0.89)],
      ['deck', J(2.2, 0.17, 0.9)],
      ['meeting', J(2, 0.16)],
      ['blog', J(1, 0.8)],
    ]);
    const plan = planPostpone({ tasks, deps: [], mine, editable, judgments, today: TODAY, scope: 'today', capacity: 4, capacitySource: 'input' });
    expect(plan.overloaded).toBe(true);
    const moved = plan.candidates.filter((c) => c.verdict === 'postpone').map((c) => c.taskId);
    expect(moved).toHaveLength(2);
    expect(moved).toEqual(expect.arrayContaining(['gym']));
    expect(moved).not.toContain('tax');
    expect(plan.candidates.find((c) => c.taskId === 'meeting')!.verdict).toBe('fixed');
    expect(plan.days[0]).toMatchObject({ load: 6, after: 4 });
    for (const c of plan.candidates.filter((x) => x.verdict === 'postpone')) {
      expect(c.toDate! > TODAY).toBe(true);
      expect(c.shiftDays).toBeGreaterThan(0);
    }
    // The overdue blog post moves from its old due date: the shift counts from 11/14.
    const blog = plan.candidates.find((c) => c.taskId === 'blog')!;
    if (blog.toDate) expect(blog.shiftDays).toBe(2 + (Date.parse(blog.toDate) - Date.parse(TODAY)) / 86_400_000);
  });

  test('never picks a slot that would break a fixed date downstream', () => {
    const prep = task('prep', { dueDate: TODAY });
    const talk = task('talk', { startDate: '2026-11-18', dueDate: '2026-11-18', fixed: true });
    const filler = ['f1', 'f2', 'f3'].map((id) => task(id, { dueDate: TODAY }));
    const tasks = [prep, talk, ...filler];
    const judgments = new Map<string, TaskJudgment>([['prep', J(0.5, 0.95)], ...filler.map((f) => [f.id, J(2.5, 0.1)] as [string, TaskJudgment])]);
    const plan = planPostpone({
      tasks,
      deps: [{ taskId: 'talk', dependsOnId: 'prep' }],
      mine,
      editable,
      judgments,
      today: TODAY,
      scope: 'today',
      capacity: 3,
      capacitySource: 'input',
    });
    const c = plan.candidates.find((x) => x.taskId === 'prep')!;
    // Moving prep one day still fits before the talk; two days would overrun it.
    expect(c.verdict).toBe('postpone');
    expect(c.toDate).toBe('2026-11-17');
  });

  test('a calm day recommends nothing but still lists what could wait', () => {
    const tasks = [task('a', { dueDate: TODAY }), task('b', { dueDate: TODAY })];
    const judgments = new Map([
      ['a', J(0.5, 0.9)],
      ['b', J(3, 0.1)],
    ]);
    const plan = planPostpone({ tasks, deps: [], mine, editable, judgments, today: TODAY, scope: 'today', capacity: 5, capacitySource: 'default' });
    expect(plan.overloaded).toBe(false);
    expect(plan.candidates.map((c) => c.verdict)).toEqual(['could', 'keep']);
  });

  test("other people's tasks and read-only tasks are left alone", () => {
    const tasks = [task('theirs', { dueDate: TODAY, assigneeId: 'other' }), task('ro', { dueDate: TODAY }), task('x', { dueDate: TODAY })];
    const plan = planPostpone({
      tasks,
      deps: [],
      mine: (t) => t.assigneeId !== 'other',
      editable: (t) => t.id !== 'ro',
      judgments: new Map([['ro', J(0, 1)], ['x', J(0, 1)]]),
      today: TODAY,
      scope: 'today',
      capacity: 1,
      capacitySource: 'input',
    });
    expect(plan.candidates.map((c) => c.taskId).sort()).toEqual(['ro', 'x']);
    expect(plan.candidates.find((c) => c.taskId === 'ro')!.verdict).toBe('keep');
    expect(plan.candidates.find((c) => c.taskId === 'x')!.verdict).toBe('postpone');
  });

  test('week scope evens out several overloaded days', () => {
    const d1 = '2026-11-17';
    const tasks = [...Array.from({ length: 4 }, (_, i) => task(`t${i}`, { dueDate: d1 }))];
    const judgments = new Map(tasks.map((t, i) => [t.id, J(1, 0.6 + i * 0.1)]));
    const plan = planPostpone({ tasks, deps: [], mine, editable, judgments, today: TODAY, scope: 'week', capacity: 2, capacitySource: 'input' });
    expect(plan.days).toHaveLength(7);
    expect(plan.days.find((d) => d.date === d1)).toMatchObject({ load: 4, after: 2 });
    expect(plan.candidates.filter((c) => c.verdict === 'postpone').map((c) => c.taskId).sort()).toEqual(['t2', 't3']);
  });
});

test('capacity follows the recent pace', () => {
  expect(capacityFromHistory([], TODAY)).toEqual({ capacity: 5, source: 'default' });
  const days = Array.from({ length: 56 }, (_, i) => `2026-11-${String(2 + (i % 14)).padStart(2, '0')}`);
  expect(capacityFromHistory(days, TODAY)).toEqual({ capacity: 5, source: 'history' });
});

describe('System One endpoints', () => {
  test('a base URL gets /systemone; a full endpoint or a Workers AI run path is kept', () => {
    expect(jevEndpoint(DEFAULT_JEV_BASE_URL)).toBe('https://api.typesafe.ai/v1/systemone');
    expect(jevEndpoint('https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api/v1/systemone');
    expect(jevEndpoint('https://openrouter.ai/api/v1/systemone')).toBe('https://openrouter.ai/api/v1/systemone');
    const cf = cloudflareJevUrl('0123456789abcdef0123456789abcdef', 'clef-flash');
    expect(cf).toBe('https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef-flash');
    expect(jevEndpoint(cf)).toBe(cf);
  });

  test('presets are recognised by host', () => {
    expect(jevPresetOf(null)).toBe('typesafe');
    expect(jevPresetOf('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(jevPresetOf(cloudflareJevUrl('0123456789abcdef0123456789abcdef', 'clef'))).toBe('cloudflare');
    expect(jevPresetOf('https://decide.example.com/v1')).toBeNull();
  });
});
