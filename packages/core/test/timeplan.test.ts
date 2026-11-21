import { describe, expect, test } from 'bun:test';
import { parseQuickAdd } from '../src/quickadd';
import {
  countedMinutes,
  DEFAULT_WORK_HOURS,
  formatDurationShort,
  parseDuration,
  planDay,
  remainingWork,
  subtractIntervals,
  workdaysBetween,
  workHoursInput,
  workHoursOf,
  workMinutesBetween,
  workMinutesOn,
  type PlannerTask,
  type PlanDayInput,
} from '../src/timeplan';

const TODAY = '2026-11-20'; // Friday
const H = DEFAULT_WORK_HOURS; // Mon–Fri 09–18, lunch 12–13

let n = 0;
const T = (p: Partial<PlannerTask> = {}): PlannerTask => ({
  id: p.id ?? `t${++n}`,
  title: p.id ?? `task ${n}`,
  number: n,
  projectId: null,
  status: 'todo',
  priority: 0,
  fixed: false,
  startDate: null,
  startTime: null,
  dueDate: TODAY,
  dueTime: null,
  estimateMinutes: 60,
  actualMinutes: 0,
  postponedCount: 0,
  ...p,
});
const plan = (tasks: PlannerTask[], extra: Partial<PlanDayInput> = {}) =>
  planDay({ date: TODAY, now: { date: TODAY, minutes: 8 * 60 }, hours: H, tasks, deps: [], blocks: [], defaultEstimate: 60, ...extra });
const spans = (p: ReturnType<typeof plan>, id: string) => p.blocks.filter((b) => b.taskId === id).map((b) => `${b.start}-${b.end}`);

describe('durations', () => {
  test('parses what people type', () => {
    expect(parseDuration('90m')).toBe(90);
    expect(parseDuration('1.5h')).toBe(90);
    expect(parseDuration('1h30m')).toBe(90);
    expect(parseDuration('1h30')).toBe(90);
    expect(parseDuration('90분')).toBe(90);
    expect(parseDuration('1시간 30분')).toBe(90);
    expect(parseDuration('1시간반')).toBe(90);
    expect(parseDuration('2시간')).toBe(120);
    expect(parseDuration('반나절')).toBe(240);
    expect(parseDuration('30분정도')).toBe(30);
    expect(parseDuration('30')).toBeNull();
    expect(parseDuration('3시')).toBeNull();
    expect(parseDuration('25h')).toBeNull();
    expect(parseDuration('1.5h30m')).toBeNull();
    expect(formatDurationShort(90)).toBe('1h30m');
    expect(formatDurationShort(120)).toBe('2h');
    expect(formatDurationShort(45)).toBe('45m');
  });

  test('quick add reads ~estimates and leaves ranges alone', () => {
    const a = parseQuickAdd('보고서 초안 금요일 ~2h #런칭', TODAY);
    expect(a).toMatchObject({ title: '보고서 초안', estimateMinutes: 120, projectName: '런칭' });
    expect(parseQuickAdd('기획 회의 준비 ~1시간 30분', TODAY)).toMatchObject({ title: '기획 회의 준비', estimateMinutes: 90 });
    expect(parseQuickAdd('메일 정리 ~ 45분', TODAY)).toMatchObject({ title: '메일 정리', estimateMinutes: 45 });
    expect(parseQuickAdd('1:1 미팅 ~30m 내일', TODAY)).toMatchObject({ title: '1:1 미팅', estimateMinutes: 30, dueDate: '2026-11-21' });
    const w = parseQuickAdd('워크숍 11/20~11/22', TODAY);
    expect(w).toMatchObject({ title: '워크숍', estimateMinutes: null, startDate: '2026-11-20', dueDate: '2026-11-22' });
    expect(parseQuickAdd('물결 ~표시 테스트', TODAY)).toMatchObject({ title: '물결 ~표시 테스트', estimateMinutes: null });
    expect(parseQuickAdd('회의 10시 ~11시', TODAY)).toMatchObject({ startTime: '10:00', dueTime: '11:00', estimateMinutes: null });
  });
});

describe('work hours', () => {
  test('defaults fill gaps and validation catches nonsense', () => {
    expect(workHoursOf(null)).toEqual(H);
    expect(workHoursOf({ start: '10:00' }).start).toBe('10:00');
    expect(workHoursInput.safeParse({ ...H, end: '08:00' }).success).toBe(false);
    expect(workHoursInput.safeParse({ ...H, breaks: [{ start: '19:00', end: '20:00' }] }).success).toBe(false);
    expect(workMinutesOn(H, TODAY)).toBe(480);
    expect(workMinutesOn(H, '2026-11-21')).toBe(0);
    expect(workdaysBetween(H, TODAY, '2026-11-24')).toBe(3); // Fri, Mon, Tue
    expect(subtractIntervals([{ start: 0, end: 100 }], [{ start: 20, end: 30 }, { start: 90, end: 120 }])).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 90 },
    ]);
  });

  test('auto time left overnight only counts working hours', () => {
    // Seoul: 10:00 Fri → 11:00 Mon (UTC+9).
    const start = new Date('2026-11-20T01:00:00Z');
    const end = new Date('2026-11-23T02:00:00Z');
    expect(workMinutesBetween(start, end, 'Asia/Seoul', H)).toBe(7 * 60 + 2 * 60);
    expect(countedMinutes('auto', start, end, 'Asia/Seoul', H)).toBe(9 * 60);
    // A timer counts as it ran; short auto runs too.
    const short = new Date('2026-11-20T03:30:00Z'); // 12:30, inside lunch
    expect(countedMinutes('auto', start, short, 'Asia/Seoul', H)).toBe(150);
    expect(countedMinutes('timer', start, end, 'Asia/Seoul', H)).toBe(73 * 60);
    // Late at night, outside hours, a long auto run still keeps the first three hours.
    const night = new Date('2026-11-20T12:00:00Z'); // 21:00
    const later = new Date('2026-11-20T14:00:00Z');
    expect(countedMinutes('auto', night, new Date(later.getTime() + 3 * 3600_000), 'Asia/Seoul', H)).toBe(180);
  });

  test('remaining work never drops below a small chunk', () => {
    expect(remainingWork({ estimateMinutes: 90, actualMinutes: 40 }, 60)).toBe(50);
    expect(remainingWork({ estimateMinutes: 30, actualMinutes: 45 }, 60)).toBe(15);
    expect(remainingWork({ estimateMinutes: null, actualMinutes: 0 }, 45)).toBe(45);
  });
});

describe('day planner', () => {
  test('packs work around lunch and a meeting, deadlines first', () => {
    const meeting = T({ id: 'meet', startDate: TODAY, startTime: '10:00', dueTime: '11:00', fixed: true, estimateMinutes: null });
    const report = T({ id: 'report', dueTime: '15:00', estimateMinutes: 90, priority: 1 });
    const mail = T({ id: 'mail', estimateMinutes: 30, priority: 3 });
    const p = plan([meeting, report, mail]);
    expect(p.events).toEqual([{ taskId: 'meet', start: '10:00', end: '11:00', fixed: true }]);
    // The 15:00 deadline goes first even though mail has higher priority; 90 minutes split around the meeting.
    expect(spans(p, 'report')).toEqual(['09:00-10:00', '11:00-11:30']);
    expect(spans(p, 'mail')).toEqual(['11:30-12:00']);
    expect(p.unplaced).toEqual([]);
    expect(p.capacity).toBe(7 * 60);
    expect(p.needed).toBe(120);
  });

  test('nothing before now; overflow is reported, late deadlines flagged', () => {
    const a = T({ id: 'a', estimateMinutes: 120, dueTime: '17:00' });
    const b = T({ id: 'b', estimateMinutes: 240 });
    const p = plan([a, b], { now: { date: TODAY, minutes: 14 * 60 + 2 } });
    expect(spans(p, 'a')).toEqual(['14:05-16:05']);
    expect(spans(p, 'b')).toEqual(['16:05-18:00']);
    expect(p.unplaced).toEqual([{ taskId: 'b', minutes: 125, reason: 'no_time' }]);
    const tight = plan([T({ id: 'c', estimateMinutes: 120, dueTime: '15:00' })], { now: { date: TODAY, minutes: 14 * 60 } });
    expect(tight.late).toEqual([{ taskId: 'c', dueTime: '15:00', end: '16:00' }]);
  });

  test('blockers go first; work waiting on someone else stays unplaced', () => {
    const first = T({ id: 'first', estimateMinutes: 60, priority: 0 });
    const second = T({ id: 'second', estimateMinutes: 60, priority: 3 });
    const outside = T({ id: 'outside', dueDate: '2026-11-25' });
    const waits = T({ id: 'waits', estimateMinutes: 30 });
    const p = plan([first, second, outside, waits], {
      deps: [
        { taskId: 'second', dependsOnId: 'first' },
        { taskId: 'waits', dependsOnId: 'outside' },
      ],
    });
    expect(spans(p, 'first')).toEqual(['09:00-10:00']);
    expect(spans(p, 'second')).toEqual(['10:00-11:00']);
    expect(p.unplaced).toEqual([{ taskId: 'waits', minutes: 30, reason: 'blocked' }]);
  });

  test('locked and past blocks stay; a running timer goes first', () => {
    const a = T({ id: 'a', estimateMinutes: 60 });
    const b = T({ id: 'b', estimateMinutes: 60, status: 'doing' });
    const p = plan([a, b], {
      now: { date: TODAY, minutes: 10 * 60 + 30 },
      runningTaskId: 'b',
      blocks: [
        { taskId: 'a', start: '09:00', end: '09:30', locked: false },
        { taskId: 'a', start: '15:00', end: '15:30', locked: true },
      ],
    });
    // 30 of a's 60 are behind us, 30 are locked at 15:00: nothing more to place for a.
    expect(spans(p, 'a')).toEqual(['09:00-09:30', '15:00-15:30']);
    expect(spans(p, 'b')).toEqual(['10:30-11:30']);
    expect(p.blocks.filter((x) => x.kept).length).toBe(2);
  });

  test('multi-day work asks for its share; fill ahead only uses leftover time', () => {
    const big = T({ id: 'big', startDate: TODAY, dueDate: '2026-11-25', estimateMinutes: 480 }); // Fri–Wed: 4 workdays
    const soon = T({ id: 'soon', dueDate: '2026-11-23', estimateMinutes: 60 });
    const p = plan([big, soon]);
    expect(spans(p, 'big')).toEqual(['09:00-11:00']);
    expect(spans(p, 'soon')).toEqual([]);
    const q = plan([big, soon], { fillAhead: true });
    expect(spans(q, 'soon')).toEqual(['11:00-12:00']);
  });

  test('a fixed appointment at one time holds that time', () => {
    const dentist = T({ id: 'dentist', fixed: true, dueTime: '15:00', estimateMinutes: null });
    const p = plan([dentist, T({ id: 'x', estimateMinutes: 480 })]);
    expect(p.events).toEqual([{ taskId: 'dentist', start: '15:00', end: '16:00', fixed: true }]);
    expect(spans(p, 'x')).toEqual(['09:00-12:00', '13:00-15:00', '16:00-18:00']);
    expect(p.unplaced).toEqual([{ taskId: 'x', minutes: 60, reason: 'no_time' }]);
  });

  test('appointments are never planned as work, not even once they are missed', () => {
    const missed = T({ id: 'missed', startDate: '2026-11-19', startTime: '10:00', dueDate: '2026-11-19', dueTime: '11:00', fixed: true, estimateMinutes: null });
    const later = T({ id: 'later', startDate: '2026-11-23', startTime: '14:00', dueDate: '2026-11-23', estimateMinutes: 60 });
    const longWork = T({ id: 'long', startDate: '2026-11-19', startTime: '14:00', dueDate: '2026-11-24', estimateMinutes: 60 });
    const p = plan([missed, later, longWork]);
    expect(p.blocks.map((b) => b.taskId)).toEqual(['long']);
    expect(p.events).toEqual([]);
  });

  test('a past day returns what was saved', () => {
    const p = planDay({
      date: '2026-11-19',
      now: { date: TODAY, minutes: 600 },
      hours: H,
      tasks: [T({ id: 'old', dueDate: '2026-11-19' })],
      deps: [],
      blocks: [{ taskId: 'old', start: '09:00', end: '10:00', locked: false }],
      defaultEstimate: 60,
    });
    expect(p.blocks.map((b) => b.start)).toEqual(['09:00']);
    expect(p.unplaced).toEqual([]);
  });
});
