import { describe, expect, test } from 'bun:test';
import { fixedDate, inOverview, isMine, overviewSections, OVERVIEW_DAYS, type Task } from '../src';

const TODAY = '2026-11-17';
let n = 0;
const task = (p: Partial<Task> = {}): Task => ({
  id: `t${++n}`,
  workspaceId: 'w',
  number: n,
  title: `task ${n}`,
  notes: '',
  status: 'todo',
  priority: 0,
  projectId: null,
  startDate: null,
  dueDate: null,
  fixed: false,
  position: n,
  postponedCount: 0,
  assigneeId: null,
  createdBy: 'me',
  completedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...p,
});

describe('whose work', () => {
  test('personal space: everything; organization: only what is assigned to me', () => {
    expect(isMine(task(), 'personal', 'me')).toBe(true);
    expect(isMine(task({ assigneeId: 'me' }), 'org', 'me')).toBe(true);
    expect(isMine(task({ assigneeId: 'kim' }), 'org', 'me')).toBe(false);
    expect(isMine(task({ assigneeId: null, createdBy: 'me' }), 'org', 'me')).toBe(false);
    expect(isMine(task({ assigneeId: null }), 'org', '')).toBe(false);
  });

  test('org tasks of teammates never make it in, whatever their date', () => {
    expect(inOverview(task({ dueDate: TODAY, assigneeId: 'kim' }), 'org', 'me', TODAY)).toBe(false);
    expect(inOverview(task({ dueDate: TODAY, assigneeId: 'me' }), 'org', 'me', TODAY)).toBe(true);
  });
});

describe('which dates', () => {
  test('overdue, today, started, in progress and the next 7 days are in', () => {
    const inn = (p: Partial<Task>) => inOverview(task(p), 'personal', 'me', TODAY);
    expect(inn({ dueDate: '2026-11-10' })).toBe(true);
    expect(inn({ dueDate: TODAY })).toBe(true);
    expect(inn({ startDate: '2026-11-15', dueDate: '2026-11-30' })).toBe(true);
    expect(inn({ status: 'doing' })).toBe(true);
    expect(inn({ dueDate: '2026-11-24' })).toBe(true);
    expect(inn({ dueDate: '2026-11-25' })).toBe(false);
    expect(inn({})).toBe(false);
  });

  test('closed tasks are out', () => {
    expect(inOverview(task({ status: 'done', dueDate: TODAY }), 'personal', 'me', TODAY)).toBe(false);
    expect(inOverview(task({ status: 'canceled', dueDate: TODAY }), 'personal', 'me', TODAY)).toBe(false);
  });

  test('fixed commitments count up to 30 days ahead', () => {
    expect(inOverview(task({ fixed: true, dueDate: '2026-12-10' }), 'personal', 'me', TODAY)).toBe(true);
    expect(inOverview(task({ fixed: true, dueDate: '2026-12-18' }), 'personal', 'me', TODAY)).toBe(false);
    expect(inOverview(task({ dueDate: '2026-12-10' }), 'personal', 'me', TODAY)).toBe(false);
  });

  test('fixedDate: a start still ahead, else the last day; nothing once it is over', () => {
    expect(fixedDate(task({ fixed: true, startDate: '2026-11-20', dueDate: '2026-11-22' }), TODAY)).toBe('2026-11-20');
    expect(fixedDate(task({ fixed: true, startDate: '2026-11-15', dueDate: '2026-11-22' }), TODAY)).toBe('2026-11-22');
    expect(fixedDate(task({ fixed: true, dueDate: '2026-11-16' }), TODAY)).toBeNull();
    expect(fixedDate(task({ dueDate: '2026-11-20' }), TODAY)).toBeNull();
  });
});

describe('sections', () => {
  test('each task lands in exactly one list; fixed ones are also listed apart', () => {
    const overdue = task({ dueDate: '2026-11-12' });
    const today = task({ dueDate: TODAY });
    const doing = task({ status: 'doing', dueDate: '2026-11-20' });
    const fri = task({ dueDate: '2026-11-20' });
    const meeting = task({ fixed: true, dueDate: '2026-11-19' });
    const far = task({ fixed: true, dueDate: '2026-12-05' });
    const s = overviewSections([far, fri, meeting, doing, today, overdue], TODAY);

    expect(s.overdue.map((t) => t.id)).toEqual([overdue.id]);
    expect(s.today.map((t) => t.id)).toEqual([doing.id, today.id]);
    expect(s.week).toHaveLength(OVERVIEW_DAYS);
    expect(s.week[0]!.date).toBe('2026-11-18');
    expect(s.week.find((d) => d.date === '2026-11-19')!.tasks.map((t) => t.id)).toEqual([meeting.id]);
    expect(s.week.find((d) => d.date === '2026-11-20')!.tasks.map((t) => t.id)).toEqual([fri.id]);
    expect(s.fixed.map((f) => [f.task.id, f.date])).toEqual([
      [meeting.id, '2026-11-19'],
      [far.id, '2026-12-05'],
    ]);
    const listed = [...s.overdue, ...s.today, ...s.week.flatMap((d) => d.tasks)];
    expect(new Set(listed.map((t) => t.id)).size).toBe(listed.length);
  });

  test('a task due after the week but starting inside it waits for its due date (as on Upcoming)', () => {
    const s = overviewSections([task({ startDate: '2026-11-19', dueDate: '2026-11-28' })], TODAY);
    expect(s.week.every((d) => d.tasks.length === 0)).toBe(true);
  });
});
