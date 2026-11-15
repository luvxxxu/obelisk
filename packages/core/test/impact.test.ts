import { describe, expect, test } from 'bun:test';
import {
  changesFromReport,
  forecast,
  leverage,
  previewDateChange,
  simulate,
  simulateDelay,
  wouldCreateCycle,
  type PlanDependency,
  type PlanItem,
} from '../src/impact';

const T = (
  id: string,
  startDate: string | null,
  dueDate: string | null,
  extra: Partial<PlanItem> = {},
): PlanItem => ({
  id,
  title: id,
  status: 'todo',
  startDate,
  dueDate,
  fixed: false,
  projectId: 'p1',
  ...extra,
});
const D = (taskId: string, dependsOnId: string): PlanDependency => ({ taskId, dependsOnId });
const byId = (r: ReturnType<typeof simulate>, id: string) => r.impacts.find((i) => i.taskId === id);

describe('simulate', () => {
  const items = [
    T('A', '2026-11-16', '2026-11-17'),
    T('B', '2026-11-18', '2026-11-20'),
    T('C', '2026-11-23', '2026-11-23', { fixed: true }),
  ];
  const deps = [D('B', 'A'), D('C', 'B')];

  test('small slip is pushed into B and absorbed by C', () => {
    const r = simulate(items, deps, { A: 3 });
    expect(byId(r, 'A')).toMatchObject({ kind: 'root', shiftDays: 3, to: { startDate: '2026-11-19', dueDate: '2026-11-20' } });
    expect(byId(r, 'B')).toMatchObject({ kind: 'shifted', shiftDays: 2, to: { startDate: '2026-11-20', dueDate: '2026-11-22' }, viaId: 'A', depth: 1 });
    expect(byId(r, 'C')).toMatchObject({ kind: 'absorbed', slackDays: 1, depth: 2 });
    expect(r.summary.delayedCount).toBe(1);
    expect(r.summary.conflictCount).toBe(0);
  });

  test('bigger slip collides with the fixed task', () => {
    const r = simulate(items, deps, { A: 5 });
    expect(byId(r, 'B')).toMatchObject({ kind: 'shifted', shiftDays: 4 });
    expect(byId(r, 'C')).toMatchObject({ kind: 'conflict', overrunDays: 1, shiftDays: 0 });
    expect(r.summary.conflictCount).toBe(1);
    expect(r.summary.projectSlips).toEqual([
      { projectId: 'p1', from: '2026-11-23', to: '2026-11-24', shiftDays: 1 },
    ]);
  });

  test('slack absorbs the delay entirely', () => {
    const r = simulate([T('A', null, '2026-11-16'), T('B', '2026-11-20', '2026-11-21')], [D('B', 'A')], { A: 2 });
    expect(byId(r, 'B')).toMatchObject({ kind: 'absorbed', slackDays: 2 });
    expect(r.summary.delayedCount).toBe(0);
  });

  test('pre-existing violations are not amplified', () => {
    const r = simulate([T('A', null, '2026-11-18'), T('B', '2026-11-16', '2026-11-17')], [D('B', 'A')], { A: 1 });
    expect(byId(r, 'B')).toMatchObject({ kind: 'shifted', shiftDays: 1 });
  });

  test('done predecessors neither move nor constrain', () => {
    const r = simulate(
      [T('A', null, '2026-11-16', { status: 'done' }), T('B', null, '2026-11-17')],
      [D('B', 'A')],
      { A: 5 },
    );
    expect(r.impacts).toHaveLength(0);
  });

  test('diamond takes the worst path', () => {
    const r = simulate(
      [
        T('A', null, '2026-11-16'),
        T('B', '2026-11-16', '2026-11-17'),
        T('C', '2026-11-19', '2026-11-19'),
        T('D', '2026-11-20', '2026-11-20'),
      ],
      [D('B', 'A'), D('C', 'A'), D('D', 'B'), D('D', 'C')],
      { A: 4 },
    );
    expect(byId(r, 'B')?.shiftDays).toBe(4); // 11-20..11-21
    expect(byId(r, 'C')?.shiftDays).toBe(1); // 11-20
    expect(byId(r, 'D')).toMatchObject({ shiftDays: 1, viaId: 'B' }); // must start ≥ 11-21
  });

  test('unscheduled tasks pass the delay through', () => {
    const r = simulate(
      [T('A', null, '2026-11-16'), T('U', null, null), T('C', '2026-11-17', '2026-11-17')],
      [D('U', 'A'), D('C', 'U')],
      { A: 3 },
    );
    expect(byId(r, 'U')).toMatchObject({ kind: 'unscheduled', shiftDays: 3 });
    expect(byId(r, 'C')).toMatchObject({ kind: 'shifted', shiftDays: 2, viaId: 'U' });
  });

  test('simulateDelay with a target date', () => {
    const r = simulateDelay(items, deps, { taskId: 'A', toDate: '2026-11-20' });
    expect(byId(r, 'A')?.shiftDays).toBe(3);
  });

  test('changesFromReport respects cascade', () => {
    const r = simulate(items, deps, { A: 5 });
    expect(changesFromReport(r, true).map((c) => c.taskId)).toEqual(['A', 'B']);
    expect(changesFromReport(r, false).map((c) => c.taskId)).toEqual(['A']);
  });
});

describe('previewDateChange', () => {
  const items = [T('A', '2026-11-16', '2026-11-18'), T('B', '2026-11-19', '2026-11-20')];
  const deps = [D('B', 'A')];

  test('extending a due date pushes dependents; the edited task keeps its exact new span', () => {
    const p = previewDateChange(items, deps, 'A', { startDate: '2026-11-16', dueDate: '2026-11-21' });
    expect(p.shiftDays).toBe(3);
    expect(p.hasImpact).toBe(true);
    expect(p.cascade).toEqual([
      { taskId: 'A', startDate: '2026-11-16', dueDate: '2026-11-21' },
      { taskId: 'B', startDate: '2026-11-21', dueDate: '2026-11-22' },
    ]);
    expect(p.only).toHaveLength(1);
  });

  test('pulling a task in front of its blocker is flagged', () => {
    const p = previewDateChange(items, deps, 'B', { startDate: '2026-11-16', dueDate: '2026-11-17' });
    expect(p.startsBeforeBlockers).toEqual([
      { taskId: 'A', title: 'A', number: undefined, dueDate: '2026-11-18', overlapDays: 2 },
    ]);
    expect(p.hasImpact).toBe(true);
  });

  test('moving earlier within slack is harmless', () => {
    const p = previewDateChange(items, deps, 'B', { startDate: '2026-11-18', dueDate: '2026-11-19' });
    expect(p.startsBeforeBlockers).toHaveLength(0);
    expect(p.hasImpact).toBe(false);
  });
});

describe('forecast', () => {
  test('a past start date alone is not "late"', () => {
    const r = forecast([T('S', '2026-11-10', null), T('N', '2026-11-11', '2026-11-12')], [D('N', 'S')], '2026-11-13');
    expect(r.rootIds).toEqual(['N']);
  });

  test('overdue work finishes today at the earliest', () => {
    const r = forecast(
      [T('A', null, '2026-11-10'), T('B', '2026-11-12', '2026-11-14'), T('Z', null, '2026-11-20')],
      [D('B', 'A')],
      '2026-11-13',
    );
    expect(r.rootIds).toEqual(['A']);
    expect(byId(r, 'A')).toMatchObject({ kind: 'root', shiftDays: 3 });
    expect(byId(r, 'B')).toMatchObject({ kind: 'shifted', shiftDays: 1 });
  });
});

describe('graph helpers', () => {
  test('cycle detection', () => {
    const deps = [D('B', 'A'), D('C', 'B')];
    expect(wouldCreateCycle(deps, 'A', 'C')).toBe(true);
    expect(wouldCreateCycle(deps, 'C', 'A')).toBe(false);
    expect(wouldCreateCycle(deps, 'A', 'A')).toBe(true);
  });

  test('leverage ranks bottlenecks', () => {
    const items = [
      T('A', null, '2026-11-16'),
      T('B', '2026-11-16', '2026-11-17'),
      T('C', '2026-11-17', '2026-11-18', { fixed: true }),
      T('X', null, '2026-11-16'),
      T('Y', '2026-11-25', '2026-11-25'),
    ];
    const lv = leverage(items, [D('B', 'A'), D('C', 'B'), D('Y', 'X')]);
    expect(lv[0]).toMatchObject({ taskId: 'A', downstreamCount: 2, slackDays: 0, delayedIfLate: 1, conflictsIfLate: 1 });
    expect(lv.find((l) => l.taskId === 'X')).toMatchObject({ slackDays: 9, delayedIfLate: 0 });
  });
});
