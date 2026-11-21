import { describe, expect, test } from 'bun:test';
import { addDays } from '../src/dates';
import {
  calibrate,
  commitOdds,
  forecastOdds,
  NO_HISTORY,
  rng,
  type Calibration,
  type FinishedSample,
  type OddsInput,
  type OddsTask,
} from '../src/odds';
import { DEFAULT_WORK_HOURS } from '../src/timeplan';

const TODAY = '2026-11-16'; // Monday
const H = DEFAULT_WORK_HOURS; // 8h days, Mon–Fri

let n = 0;
const T = (p: Partial<OddsTask> = {}): OddsTask => ({
  id: p.id ?? `t${++n}`,
  title: p.id ?? `task ${n}`,
  number: ++n,
  projectId: 'p',
  status: 'todo',
  priority: 0,
  fixed: false,
  startDate: null,
  startTime: null,
  dueDate: null,
  dueTime: null,
  estimateMinutes: 60,
  actualMinutes: 0,
  queues: ['me'],
  ...p,
});

const people = (cal: Calibration = NO_HISTORY) => new Map([['me', { hours: H, calibration: { ...cal, focus: 0.75 } }]]);
const input = (tasks: OddsTask[], extra: Partial<OddsInput> = {}): OddsInput => ({
  today: TODAY,
  nowMinutes: 9 * 60,
  tasks,
  deps: [],
  people: people(),
  runs: 300,
  ...extra,
});
const odds = (r: ReturnType<typeof forecastOdds>, id: string) => r.tasks.find((t) => t.taskId === id)!;

describe('calibration', () => {
  test('learns how long estimates run, focus and the deadline record', () => {
    const finished: FinishedSample[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ estimateMinutes: 60, actualMinutes: 90, firstDueDate: addDays(TODAY, -i - 2), completedOn: addDays(TODAY, -i - 1) })),
      ...Array.from({ length: 10 }, (_, i) => ({ estimateMinutes: null, actualMinutes: 0, firstDueDate: addDays(TODAY, -i - 2), completedOn: addDays(TODAY, -i - 2) })),
    ];
    const cal = calibrate({ finished, trackedPerDay: [240, 260, 250, 300, 200], today: TODAY, hours: H });
    expect(cal.medianRatio).toBe(1.5);
    expect(cal.ratios.length).toBe(10);
    expect(cal.focus).toBeCloseTo(250 / 480, 5);
    expect(cal.focusSource).toBe('history');
    expect(cal.onTimeRate).toBe(0.5);
    expect(cal.meanLateDays).toBe(1);
    expect(cal.defaultEstimate).toBe(90);
    expect(cal.defaultEstimateSource).toBe('history');
  });

  test('settings win; pace gives a default estimate before tracked time exists', () => {
    const finished = Array.from({ length: 20 }, (_, i) => ({ estimateMinutes: null, actualMinutes: 0, firstDueDate: null, completedOn: addDays(TODAY, -1 - (i % 14)) }));
    const pace = calibrate({ finished, trackedPerDay: [], today: TODAY, hours: H });
    expect(pace.defaultEstimateSource).toBe('pace');
    // 20 tasks over 20 workdays = 1 a day, 0.7 × 480 minutes of focus.
    expect(pace.defaultEstimate).toBe(Math.round((0.7 * 480) / (20 / 20)) > 240 ? 240 : Math.round((0.7 * 480) / 1));
    const set = calibrate({ finished, trackedPerDay: [], today: TODAY, hours: { ...H, focus: 0.5, defaultEstimate: 45 } });
    expect(set).toMatchObject({ focus: 0.5, focusSource: 'setting', defaultEstimate: 45, defaultEstimateSource: 'setting' });
  });

  test('the generator is seeded', () => {
    const a = rng(42);
    const b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('forecast odds', () => {
  test('light work with room to spare is near certain; the same answer twice', () => {
    const tasks = [T({ id: 'a', dueDate: addDays(TODAY, 4) }), T({ id: 'b', dueDate: addDays(TODAY, 4) })];
    const r = forecastOdds(input(tasks));
    expect(odds(r, 'a').onTime).toBeGreaterThan(0.97);
    expect(odds(r, 'a').p50).toBe(TODAY);
    expect(forecastOdds(input(tasks))).toEqual(r);
  });

  test('more work than fits before the deadline gets low odds', () => {
    // 3 days × 6h of focus = 18h of capacity, 30h of work due Wednesday.
    const tasks = Array.from({ length: 10 }, (_, i) => T({ id: `w${i}`, dueDate: addDays(TODAY, 2), estimateMinutes: 180 }));
    const r = forecastOdds(input(tasks));
    const late = r.tasks.filter((t) => (t.onTime ?? 1) < 0.5);
    expect(late.length).toBeGreaterThanOrEqual(4);
    const proj = r.projects.find((p) => p.projectId === 'p')!;
    expect(proj.tasks).toBe(10);
    expect(proj.p85! > addDays(TODAY, 2)).toBe(true);
    expect(proj.p50! <= proj.p85!).toBe(true);
  });

  test('a chain pushes the fixed date at its end into risk', () => {
    const tasks = [
      T({ id: 'design', dueDate: addDays(TODAY, 1), estimateMinutes: 600 }),
      T({ id: 'build', dueDate: addDays(TODAY, 2), estimateMinutes: 600 }),
      T({ id: 'launch', fixed: true, estimateMinutes: null, dueDate: addDays(TODAY, 3) }),
    ];
    const deps = [
      { taskId: 'build', dependsOnId: 'design' },
      { taskId: 'launch', dependsOnId: 'build' },
    ];
    const r = forecastOdds(input(tasks, { deps }));
    expect(odds(r, 'launch').conflict).toBeGreaterThan(0.5);
    expect(odds(r, 'launch').onTime).toBeNull();
    // Without the chain, nothing threatens launch.
    const free = forecastOdds(input(tasks));
    expect(odds(free, 'launch').conflict).toBeNull();
  });

  test('history of long-running estimates lowers the odds', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => T({ id: `x${i}`, dueDate: addDays(TODAY, 1), estimateMinutes: 150 }));
    const slow: Calibration = { ...NO_HISTORY, ratios: Array.from({ length: 40 }, () => 2.2) };
    const fast: Calibration = { ...NO_HISTORY, ratios: Array.from({ length: 40 }, () => 0.8) };
    const a = forecastOdds(input(tasks, { people: people(slow) }));
    const b = forecastOdds(input(tasks, { people: people(fast) }));
    const avg = (r: typeof a) => r.tasks.reduce((s, t) => s + (t.onTime ?? 0), 0) / r.tasks.length;
    expect(avg(a)).toBeLessThan(avg(b) - 0.2);
  });

  test("an unestimated task follows the person's deadline record", () => {
    const task = T({ id: 'u', dueDate: addDays(TODAY, 3), estimateMinutes: null });
    const late: Calibration = { ...NO_HISTORY, slips: Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? 0 : 2)) };
    const r = forecastOdds(input([task], { people: people(late) }));
    // History says one in four on time; the prior pulls that up a little.
    expect(odds(r, 'u').onTime).toBeGreaterThan(0.2);
    expect(odds(r, 'u').onTime).toBeLessThan(0.45);
  });

  test("other spaces' work takes time but isn't reported", () => {
    const mine = T({ id: 'mine', dueDate: addDays(TODAY, 1), estimateMinutes: 120 });
    const other = Array.from({ length: 6 }, (_, i) => T({ id: `o${i}`, dueDate: TODAY, estimateMinutes: 120, external: true, projectId: null }));
    const r = forecastOdds(input([mine, ...other]));
    expect(r.tasks.map((t) => t.taskId)).toEqual(['mine']);
    expect(odds(r, 'mine').onTime!).toBeLessThan(forecastOdds(input([mine])).tasks[0]!.onTime!);
  });
});

describe('several assignees', () => {
  test('shared work is done when the busiest of them gets to it', () => {
    const two = new Map([
      ['me', { hours: H, calibration: { ...NO_HISTORY, focus: 0.75 } }],
      ['you', { hours: H, calibration: { ...NO_HISTORY, focus: 0.75 } }],
    ]);
    // "you" has three days of work ahead; the shared task waits for them even though "me" is free.
    const busy = [1, 2, 3].map((d) => T({ id: `you${d}`, queues: ['you'], dueDate: addDays(TODAY, d), estimateMinutes: 360 }));
    const shared = T({ id: 'shared', queues: ['me', 'you'], dueDate: addDays(TODAY, 10), estimateMinutes: 120 });
    const solo = T({ id: 'solo', queues: ['me'], dueDate: addDays(TODAY, 10), estimateMinutes: 120 });
    const r = forecastOdds(input([...busy, shared, solo], { people: two }));
    expect(odds(r, 'shared').p50! > odds(r, 'solo').p50!).toBe(true);
  });
});

describe('commitments', () => {
  test('the safe date never comes before the earliest; crowding shows who gets hurt', () => {
    const tasks = [
      T({ id: 'a', dueDate: addDays(TODAY, 2), estimateMinutes: 420 }),
      T({ id: 'b', dueDate: addDays(TODAY, 3), estimateMinutes: 420 }),
    ];
    const r = commitOdds(input(tasks, { runs: 200 }), {
      title: '새 견적서',
      estimateMinutes: 360,
      projectId: 'p',
      queues: ['me'],
      priority: 2,
      blockedBy: [],
    }, { date: TODAY });
    expect(r.earliest).not.toBeNull();
    expect(r.safe).not.toBeNull();
    expect(r.safe!.date >= r.earliest!.date).toBe(true);
    expect(r.safe!.harmed).toEqual([]);
    expect(r.safe!.probability).toBeGreaterThanOrEqual(0.85);
    expect(r.earliest!.harmed.length).toBeGreaterThan(0);
    expect(r.proposed!.probability).toBeLessThan(0.85);
    expect(r.days.length).toBeGreaterThan(3);
    expect(r.natural.p85).not.toBeNull();
  });

  test('blockers hold the new work back', () => {
    const tasks = [T({ id: 'blocker', dueDate: addDays(TODAY, 4), estimateMinutes: 60, startDate: addDays(TODAY, 4) })];
    const r = commitOdds(input(tasks, { runs: 120 }), { title: 'x', estimateMinutes: 30, projectId: 'p', queues: ['me'], priority: 0, blockedBy: ['blocker'] });
    expect(r.earliest!.date >= addDays(TODAY, 4)).toBe(true);
  });

  test('an existing task is dated without counting itself twice', () => {
    const tasks = [T({ id: 'mine', estimateMinutes: 120 })];
    const r = commitOdds(input(tasks, { runs: 120 }), { taskId: 'mine', title: 'mine', estimateMinutes: 120, projectId: 'p', queues: ['me'], priority: 0, blockedBy: [] });
    expect(r.earliest!.date <= addDays(TODAY, 1)).toBe(true);
    expect(r.earliest!.harmed).toEqual([]);
  });
});
