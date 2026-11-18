import { describe, expect, test } from 'bun:test';
import {
  formatDurationKo,
  formatTimeKo,
  formatTimeRangeKo,
  isISOTime,
  isPastDue,
  minutesUntil,
  nowIn,
  spanInOrder,
} from '../src/dates';
import type { PlanItem } from '../src/impact';
import { parseDateTimePhrase, parseQuickAdd, parseTimePhrase } from '../src/quickadd';
import { createTaskInput, spanIssues, updateTaskInput } from '../src/schemas';
import { compareTasks, isOverdue, selectView } from '../src/views';
import { parseIncoming, reminderAlerts, reminderSummary, scheduleAlerts, scheduleSummary } from '../src/webhooks';

const TODAY = '2026-11-13'; // Friday
const at = (hhmm: string, date = TODAY) => {
  const [h, m] = hhmm.split(':').map(Number);
  return { date, minutes: h! * 60 + m! };
};

describe('time helpers', () => {
  test('valid times and Korean labels', () => {
    expect(isISOTime('09:05')).toBe(true);
    expect(isISOTime('24:00')).toBe(false);
    expect(isISOTime('9:05')).toBe(false);
    expect(formatTimeKo('09:05')).toBe('오전 9:05');
    expect(formatTimeKo('15:00')).toBe('오후 3:00');
    expect(formatTimeKo('12:30')).toBe('오후 12:30');
    expect(formatTimeKo('00:10')).toBe('오전 12:10');
    expect(formatTimeRangeKo('10:00', '11:30')).toBe('오전 10:00 – 11:30');
    expect(formatTimeRangeKo('11:00', '13:00')).toBe('오전 11:00 – 오후 1:00');
    expect(formatDurationKo(40)).toBe('40분');
    expect(formatDurationKo(135)).toBe('2시간 15분');
    expect(formatDurationKo(60)).toBe('1시간');
  });

  test('wall clock in a time zone', () => {
    // 2026-11-13 06:30 UTC is 15:30 in Seoul.
    expect(nowIn('Asia/Seoul', new Date('2026-11-13T06:30:00Z'))).toEqual({ date: '2026-11-13', minutes: 930 });
    expect(nowIn('America/New_York', new Date('2026-11-13T03:00:00Z'))).toEqual({ date: '2026-11-12', minutes: 22 * 60 });
  });

  test('past due: by day without a time, by minute with one', () => {
    expect(isPastDue(TODAY, null, at('23:59'))).toBe(false);
    expect(isPastDue(TODAY, '15:00', at('14:59'))).toBe(false);
    expect(isPastDue(TODAY, '15:00', at('15:00'))).toBe(true);
    expect(isPastDue('2026-11-12', null, at('00:00'))).toBe(true);
    expect(minutesUntil('2026-11-14', '01:00', at('23:30'))).toBe(90);
  });

  test('span order compares times only on the same day', () => {
    expect(spanInOrder(TODAY, '15:00', TODAY, '10:00')).toBe(false);
    expect(spanInOrder(TODAY, '15:00', '2026-11-14', '10:00')).toBe(true);
    expect(spanInOrder(TODAY, '15:00', TODAY, null)).toBe(true);
  });
});

describe('schemas', () => {
  test('a time needs its date, and start may not pass due', () => {
    expect(spanIssues({ dueTime: '15:00' })[0]?.path).toEqual(['dueTime']);
    expect(spanIssues({ startDate: TODAY, startTime: '15:00', dueDate: TODAY, dueTime: '10:00' })[0]?.message).toContain('시작 시각');
    expect(createTaskInput.safeParse({ title: 'x', dueDate: TODAY, dueTime: '15:30' }).success).toBe(true);
    expect(createTaskInput.safeParse({ title: 'x', dueDate: TODAY, dueTime: '3pm' }).success).toBe(false);
    expect(updateTaskInput.safeParse({ dueTime: null }).success).toBe(true);
  });
});

describe('parse times', () => {
  test('time phrases', () => {
    expect(parseTimePhrase('오후 3시')).toBe('15:00');
    expect(parseTimePhrase('오후3시 30분')).toBe('15:30');
    expect(parseTimePhrase('3시 반')).toBe('15:30');
    expect(parseTimePhrase('9시')).toBe('09:00');
    expect(parseTimePhrase('저녁 7시')).toBe('19:00');
    expect(parseTimePhrase('밤 12시')).toBe('23:59');
    expect(parseTimePhrase('15:30')).toBe('15:30');
    expect(parseTimePhrase('09:00')).toBe('09:00');
    expect(parseTimePhrase('3pm')).toBe('15:00');
    expect(parseTimePhrase('9:30am')).toBe('09:30');
    expect(parseTimePhrase('정오')).toBe('12:00');
    expect(parseTimePhrase('1:1')).toBeNull();
    expect(parseTimePhrase('3')).toBeNull();
    expect(parseTimePhrase('오전 15시')).toBeNull();
  });

  test('quick add with a date and a time', () => {
    expect(parseQuickAdd('치과 내일 오후 3시', TODAY)).toMatchObject({
      title: '치과',
      dueDate: '2026-11-14',
      dueTime: '15:00',
      startDate: null,
      startTime: null,
    });
    expect(parseQuickAdd('3시 내일 회의', TODAY)).toMatchObject({ title: '회의', dueDate: '2026-11-14', dueTime: '15:00' });
    expect(parseQuickAdd('1:1 미팅 내일', TODAY)).toMatchObject({ title: '1:1 미팅', dueTime: null });
  });

  test('a slot within one day becomes start and due', () => {
    expect(parseQuickAdd('회의 금요일 10시~11시 반', '2026-11-11')).toMatchObject({
      title: '회의',
      startDate: '2026-11-13',
      startTime: '10:00',
      dueDate: '2026-11-13',
      dueTime: '11:30',
    });
    expect(parseQuickAdd('워크숍 오후 2시-4시', TODAY, { nowMinutes: 9 * 60 })).toMatchObject({
      startDate: TODAY,
      startTime: '14:00',
      dueDate: TODAY,
      dueTime: '16:00',
    });
  });

  test('a time alone is the next time it comes round', () => {
    expect(parseQuickAdd('보고서 3시까지', TODAY, { nowMinutes: 10 * 60 })).toMatchObject({ dueDate: TODAY, dueTime: '15:00' });
    expect(parseQuickAdd('보고서 3시까지', TODAY, { nowMinutes: 16 * 60 })).toMatchObject({ dueDate: '2026-11-14', dueTime: '15:00' });
  });

  test('a time on a date range lands on the due end', () => {
    expect(parseQuickAdd('워크숍 11/20~11/22 18시', TODAY)).toMatchObject({
      startDate: '2026-11-20',
      startTime: null,
      dueDate: '2026-11-22',
      dueTime: '18:00',
    });
  });

  test('a date field phrase', () => {
    expect(parseDateTimePhrase('내일 오후 3시', TODAY)).toEqual({ date: '2026-11-14', time: '15:00' });
    expect(parseDateTimePhrase('다음 주 금요일', TODAY)).toEqual({ date: '2026-11-20', time: null });
    expect(parseDateTimePhrase('보고서', TODAY)).toBeNull();
  });
});

describe('views', () => {
  const t = (over: Record<string, unknown>) =>
    ({ status: 'todo', startDate: null, dueDate: null, projectId: null, priority: 0, number: 1, completedAt: null, position: 0, ...over }) as never;

  test('a due time that passed today is overdue', () => {
    const task = t({ dueDate: TODAY, dueTime: '09:00' });
    expect(isOverdue(task, TODAY)).toBe(false);
    expect(isOverdue(task, TODAY, at('08:59'))).toBe(false);
    expect(isOverdue(task, TODAY, at('09:00'))).toBe(true);
    expect(selectView([task], 'overdue', TODAY, at('10:00'))).toHaveLength(1);
  });

  test('within a day: timed by time, then the ones without a time', () => {
    const a = t({ number: 1, dueDate: TODAY });
    const b = t({ number: 2, dueDate: TODAY, dueTime: '15:00' });
    const c = t({ number: 3, dueDate: TODAY, dueTime: '09:30' });
    expect([a, b, c].sort(compareTasks).map((x: { number: number }) => x.number)).toEqual([3, 2, 1]);
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

describe('schedule alerts with times', () => {
  test('same-day overdue once the due time passes, with the time in the text', () => {
    const items = [item('a', { dueDate: TODAY, dueTime: '15:00' }), item('b', { dueDate: '2026-11-14', dueTime: '09:30' })];
    expect(scheduleAlerts(items, [], TODAY, at('09:00'))).toEqual([
      { key: 'task.due_today', taskId: 'a', time: '15:00' },
      { key: 'task.due_soon', taskId: 'b', time: '09:30' },
    ]);
    const late = scheduleAlerts(items, [], TODAY, at('15:10'));
    expect(late[0]).toEqual({ key: 'task.overdue', taskId: 'a', daysOverdue: 0, time: '15:00' });
    expect(scheduleSummary(late[0]!)).toBe('마감 시각 오후 3:00 지남');
    expect(scheduleSummary({ key: 'task.due_soon', time: '09:30' })).toBe('내일 오전 9:30 마감');
  });

  test('reminders open `lead` minutes before and close at the moment', () => {
    const items = [
      item('due', { dueDate: TODAY, dueTime: '15:00' }),
      item('start', { startDate: TODAY, startTime: '10:00', dueDate: TODAY }),
      item('doing', { status: 'doing', startDate: TODAY, startTime: '10:00' }),
      item('allday', { dueDate: TODAY }),
    ];
    expect(reminderAlerts(items, at('14:29'), 30)).toEqual([]);
    expect(reminderAlerts(items, at('14:30'), 30)).toEqual([
      { key: 'task.due_reminder', taskId: 'due', date: TODAY, time: '15:00', minutesLeft: 30 },
    ]);
    expect(reminderAlerts(items, at('15:00'), 30)).toEqual([]);
    // Started tasks get no start reminder.
    expect(reminderAlerts(items, at('09:50'), 30).map((r) => r.taskId)).toEqual(['start']);
    expect(reminderAlerts(items, at('09:50'), 30, ['task.due_reminder'])).toEqual([]);
    // "At the time": a short grace after it.
    expect(reminderAlerts(items, at('15:05'), 0).map((r) => r.minutesLeft)).toEqual([-5]);
    expect(reminderAlerts(items, at('15:10'), 0)).toEqual([]);
  });

  test('reminders a day ahead cross midnight', () => {
    const items = [item('early', { dueDate: '2026-11-14', dueTime: '08:00' })];
    const [r] = reminderAlerts(items, at('09:00'), 1440);
    expect(r).toMatchObject({ minutesLeft: 23 * 60 });
    expect(reminderSummary(r!, TODAY)).toBe('23시간 뒤 마감 · 내일 오전 8:00');
    expect(reminderSummary({ key: 'task.start_reminder', date: TODAY, time: '10:00', minutesLeft: 0 }, TODAY)).toBe(
      '지금 시작 · 오전 10:00',
    );
  });
});

describe('incoming with times', () => {
  const cmd = (body: unknown, opts?: Parameters<typeof parseIncoming>[2]) => {
    const r = parseIncoming(body, TODAY, opts);
    if (!r.ok) throw new Error(r.error);
    return r.command;
  };

  test('text commands carry times', () => {
    expect(cmd('치과 내일 오후 3시')).toMatchObject({ kind: 'create', title: '치과', dueDate: '2026-11-14', dueTime: '15:00' });
    expect(cmd('#12 내일 15:30까지')).toEqual({ kind: 'update', task: '#12', patch: { dueDate: '2026-11-14', dueTime: '15:30' } });
  });

  test('JSON dates with a time, separate time fields, offsets and plain midnights', () => {
    expect(cmd({ title: 'x', dueDate: '2026-11-20T15:30' })).toMatchObject({ dueDate: '2026-11-20', dueTime: '15:30' });
    expect(cmd({ title: 'x', dueDate: '2026-11-20', dueTime: '오후 3시' })).toMatchObject({ dueDate: '2026-11-20', dueTime: '15:00' });
    expect(cmd({ title: 'x', due: '2026-11-20T06:30:00Z' }, { timeZone: 'Asia/Seoul' })).toMatchObject({
      dueDate: '2026-11-20',
      dueTime: '15:30',
    });
    expect(cmd({ title: 'x', dueDate: '2026-11-20T00:00:00Z' }, { timeZone: 'Asia/Seoul' })).toEqual({
      kind: 'create',
      title: 'x',
      dueDate: '2026-11-20',
    });
    expect(cmd({ action: 'update', task: '#3', dueTime: null })).toEqual({ kind: 'update', task: '#3', patch: { dueTime: null } });
    const bad = parseIncoming({ title: 'x', startDate: TODAY, startTime: '15:00', dueDate: TODAY, dueTime: '10:00' }, TODAY);
    expect(bad.ok).toBe(false);
  });
});
