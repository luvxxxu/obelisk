/**
 * Delay-impact engine — "if this slips, what else slips?"
 *
 * Model
 *  - Every scheduled task occupies [start, due] (inclusive calendar days).
 *    A task with only a due date is a one-day task; only a start date likewise.
 *  - A dependency `B dependsOn A` is finish-to-start with zero lag:
 *    B may start on the day A is due, not earlier.
 *  - When A moves later, B is pushed by exactly the amount that would newly
 *    violate the constraint. Slack between A.due and B.start absorbs the delay,
 *    and pre-existing violations are never amplified.
 *  - Fixed tasks (meetings, hard deadlines) never move. A push into a fixed task
 *    is reported as a conflict, and the ripple stops there.
 *  - Done/canceled tasks neither move nor constrain.
 *  - Unscheduled tasks pass the delay through to their own successors.
 *
 * Pure TypeScript, no I/O: the browser runs it live while you drag, the server
 * runs it for the REST API and the MCP tools.
 */
import { fromDay, toDay, type ISODate, type ISOTime } from './dates';
import type { TaskStatus } from './types';

export interface PlanItem {
  id: string;
  title: string;
  status: TaskStatus;
  startDate: ISODate | null;
  dueDate: ISODate | null;
  /** Times ride along with their dates; the delay model itself works in whole days. */
  startTime?: ISOTime | null;
  dueTime?: ISOTime | null;
  fixed: boolean;
  projectId: string | null;
  number?: number;
}

export interface PlanDependency {
  taskId: string;
  dependsOnId: string;
}

export type ImpactKind = 'root' | 'shifted' | 'conflict' | 'absorbed' | 'unscheduled';

export interface DateSpan {
  startDate: ISODate | null;
  dueDate: ISODate | null;
}

export interface TaskImpact {
  taskId: string;
  title: string;
  number?: number;
  projectId: string | null;
  kind: ImpactKind;
  /** How far the task moves (root/shifted). 0 for conflict/absorbed. */
  shiftDays: number;
  /** For conflicts: how many days the upstream work now overruns this fixed task. */
  overrunDays: number;
  /** For absorbed: slack days still left after absorbing the delay. */
  slackDays: number | null;
  from: DateSpan;
  to: DateSpan;
  /** Hops from the nearest root. Root = 0. */
  depth: number;
  /** The upstream task whose delay caused this impact. */
  viaId: string | null;
}

export interface ProjectSlip {
  projectId: string;
  from: ISODate;
  to: ISODate;
  shiftDays: number;
}

export interface ImpactSummary {
  delayedCount: number;
  conflictCount: number;
  absorbedCount: number;
  unscheduledCount: number;
  maxShiftDays: number;
  projectSlips: ProjectSlip[];
  /** Latest due date across all active scheduled work, before and after. */
  finishFrom: ISODate | null;
  finishTo: ISODate | null;
}

export interface ImpactReport {
  rootIds: string[];
  impacts: TaskImpact[];
  summary: ImpactSummary;
}

export interface DateChange {
  taskId: string;
  startDate: ISODate | null;
  dueDate: ISODate | null;
  /** Omitted = the task keeps its time (a cleared date clears it). */
  startTime?: ISOTime | null;
  dueTime?: ISOTime | null;
}

const isActiveStatus = (s: TaskStatus) => s === 'todo' || s === 'doing';

interface Span {
  s: number | null;
  e: number | null;
}

function spanOf(item: PlanItem): Span {
  const s = item.startDate ? toDay(item.startDate) : item.dueDate ? toDay(item.dueDate) : null;
  const e = item.dueDate ? toDay(item.dueDate) : item.startDate ? toDay(item.startDate) : null;
  return { s, e };
}

class PlanGraph {
  readonly items = new Map<string, PlanItem>();
  readonly preds = new Map<string, string[]>();
  readonly succs = new Map<string, string[]>();
  readonly spans = new Map<string, Span>();
  private oldEffMemo = new Map<string, number | null>();

  constructor(items: readonly PlanItem[], deps: readonly PlanDependency[]) {
    for (const it of items) {
      this.items.set(it.id, it);
      this.spans.set(it.id, spanOf(it));
    }
    for (const d of deps) {
      if (d.taskId === d.dependsOnId) continue;
      if (!this.items.has(d.taskId) || !this.items.has(d.dependsOnId)) continue;
      push(this.preds, d.taskId, d.dependsOnId);
      push(this.succs, d.dependsOnId, d.taskId);
    }
  }

  active(id: string): boolean {
    const it = this.items.get(id);
    return !!it && isActiveStatus(it.status);
  }

  activePreds(id: string): string[] {
    return (this.preds.get(id) ?? []).filter((p) => this.active(p));
  }

  activeSuccs(id: string): string[] {
    return (this.succs.get(id) ?? []).filter((s) => this.active(s));
  }

  /** Effective finish day in the current plan (unscheduled tasks inherit from preds). */
  oldEff(id: string, visiting = new Set<string>()): number | null {
    if (this.oldEffMemo.has(id)) return this.oldEffMemo.get(id)!;
    if (!this.active(id)) return null;
    const { e } = this.spans.get(id)!;
    if (e !== null) {
      this.oldEffMemo.set(id, e);
      return e;
    }
    if (visiting.has(id)) return null;
    visiting.add(id);
    let best: number | null = null;
    for (const p of this.activePreds(id)) {
      const v = this.oldEff(p, visiting);
      if (v !== null && (best === null || v > best)) best = v;
    }
    visiting.delete(id);
    this.oldEffMemo.set(id, best);
    return best;
  }

  /** Active transitive successors of the given roots, roots included. */
  reach(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const r of roots) {
      if (this.active(r) && !seen.has(r)) {
        seen.add(r);
        queue.push(r);
      }
    }
    while (queue.length) {
      const n = queue.shift()!;
      for (const s of this.activeSuccs(n)) {
        if (!seen.has(s)) {
          seen.add(s);
          queue.push(s);
        }
      }
    }
    return seen;
  }

  /** Kahn topological order restricted to `nodes`. Cycle members (shouldn't exist) go last. */
  topo(nodes: Set<string>): string[] {
    const indeg = new Map<string, number>();
    for (const n of nodes) indeg.set(n, this.activePreds(n).filter((p) => nodes.has(p)).length);
    const queue = [...nodes].filter((n) => indeg.get(n) === 0);
    const order: string[] = [];
    while (queue.length) {
      const n = queue.shift()!;
      order.push(n);
      for (const s of this.activeSuccs(n)) {
        if (!nodes.has(s)) continue;
        const d = indeg.get(s)! - 1;
        indeg.set(s, d);
        if (d === 0) queue.push(s);
      }
    }
    if (order.length < nodes.size) {
      const placed = new Set(order);
      for (const n of nodes) if (!placed.has(n)) order.push(n);
    }
    return order;
  }
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const iso = (d: number | null) => (d === null ? null : fromDay(d));

/**
 * Core propagation. `shifts` maps root task ids to the number of days they move
 * (negative = earlier). Returns every task the change touches.
 */
export function simulate(
  items: readonly PlanItem[],
  deps: readonly PlanDependency[],
  shifts: Record<string, number> | Map<string, number>,
): ImpactReport {
  const g = new PlanGraph(items, deps);
  const shiftMap = shifts instanceof Map ? shifts : new Map(Object.entries(shifts));
  const rootIds = [...shiftMap.keys()].filter((id) => g.active(id));
  const nodes = g.reach(rootIds);
  const order = g.topo(nodes);

  const newEff = new Map<string, number | null>();
  const effNow = (id: string) => (newEff.has(id) ? newEff.get(id)! : g.oldEff(id));
  const depthOf = new Map<string, number>();
  const impacts: TaskImpact[] = [];

  for (const id of order) {
    const item = g.items.get(id)!;
    const { s, e } = g.spans.get(id)!;
    const rootShift = shiftMap.get(id);
    const isRoot = rootShift !== undefined && g.active(id);
    const preds = g.activePreds(id);

    const movedPreds = preds.filter((p) => {
      const o = g.oldEff(p);
      const n = effNow(p);
      return n !== null && (o === null || n > o);
    });

    const base = {
      taskId: id,
      title: item.title,
      number: item.number,
      projectId: item.projectId,
      from: { startDate: item.startDate, dueDate: item.dueDate },
    };

    if (s !== null && e !== null) {
      let v0 = 0;
      let v1 = 0;
      let via: string | null = null;
      let viaEnd = -Infinity;
      for (const p of preds) {
        const o = g.oldEff(p);
        const n = effNow(p);
        if (o !== null) v0 = Math.max(v0, o - s);
        if (n !== null) v1 = Math.max(v1, n - s);
        if (n !== null && movedPreds.includes(p) && n > viaEnd) {
          viaEnd = n;
          via = p;
        }
      }
      const depShift = Math.max(0, v1 - v0);

      if (isRoot) {
        const shift = Math.max(rootShift!, depShift);
        newEff.set(id, e + shift);
        depthOf.set(id, 0);
        impacts.push({
          ...base,
          kind: 'root',
          shiftDays: shift,
          overrunDays: 0,
          slackDays: null,
          to: { startDate: shiftIso(item.startDate, shift), dueDate: shiftIso(item.dueDate, shift) },
          depth: 0,
          viaId: null,
        });
        continue;
      }

      const depth = via ? (depthOf.get(via) ?? 0) + 1 : 1;
      if (depShift > 0 && item.fixed) {
        newEff.set(id, e);
        depthOf.set(id, depth);
        impacts.push({
          ...base,
          kind: 'conflict',
          shiftDays: 0,
          overrunDays: depShift,
          slackDays: null,
          to: { startDate: item.startDate, dueDate: item.dueDate },
          depth,
          viaId: via,
        });
      } else if (depShift > 0) {
        newEff.set(id, e + depShift);
        depthOf.set(id, depth);
        impacts.push({
          ...base,
          kind: 'shifted',
          shiftDays: depShift,
          overrunDays: 0,
          slackDays: null,
          to: {
            startDate: shiftIso(item.startDate, depShift),
            dueDate: shiftIso(item.dueDate, depShift),
          },
          depth,
          viaId: via,
        });
      } else if (movedPreds.length > 0) {
        newEff.set(id, e);
        depthOf.set(id, depth);
        let slack = Infinity;
        for (const p of movedPreds) slack = Math.min(slack, s - (effNow(p) ?? s));
        impacts.push({
          ...base,
          kind: 'absorbed',
          shiftDays: 0,
          overrunDays: 0,
          slackDays: Math.max(0, slack === Infinity ? 0 : slack),
          to: { startDate: item.startDate, dueDate: item.dueDate },
          depth,
          viaId: via,
        });
      } else {
        newEff.set(id, e);
      }
    } else {
      // Unscheduled: inherits the latest upstream finish.
      const o = g.oldEff(id);
      let n: number | null = null;
      let via: string | null = null;
      for (const p of preds) {
        const v = effNow(p);
        if (v !== null && (n === null || v > n)) {
          n = v;
          via = p;
        }
      }
      if (!isRoot && n !== null && movedPreds.length > 0 && (o === null || n > o)) {
        const depth = via ? (depthOf.get(via) ?? 0) + 1 : 1;
        newEff.set(id, n);
        depthOf.set(id, depth);
        impacts.push({
          ...base,
          kind: 'unscheduled',
          shiftDays: o === null ? 0 : n - o,
          overrunDays: 0,
          slackDays: null,
          to: { startDate: null, dueDate: null },
          depth,
          viaId: via,
        });
      } else {
        newEff.set(id, o);
      }
    }
  }

  const kindRank: Record<ImpactKind, number> = {
    root: 0,
    conflict: 1,
    shifted: 2,
    unscheduled: 3,
    absorbed: 4,
  };
  impacts.sort(
    (a, b) =>
      (a.kind === 'root' ? 0 : 1) - (b.kind === 'root' ? 0 : 1) ||
      a.depth - b.depth ||
      kindRank[a.kind] - kindRank[b.kind] ||
      (a.to.dueDate ?? '').localeCompare(b.to.dueDate ?? ''),
  );

  return { rootIds, impacts, summary: summarize(g, impacts, newEff) };
}

function shiftIso(date: ISODate | null, days: number): ISODate | null {
  return date ? fromDay(toDay(date) + days) : null;
}

function summarize(
  g: PlanGraph,
  impacts: TaskImpact[],
  newEff: Map<string, number | null>,
): ImpactSummary {
  let delayedCount = 0;
  let conflictCount = 0;
  let absorbedCount = 0;
  let unscheduledCount = 0;
  let maxShiftDays = 0;
  const touchedProjects = new Set<string>();
  for (const im of impacts) {
    if (im.kind === 'shifted') {
      delayedCount++;
      maxShiftDays = Math.max(maxShiftDays, im.shiftDays);
    } else if (im.kind === 'conflict') {
      conflictCount++;
      maxShiftDays = Math.max(maxShiftDays, im.overrunDays);
    } else if (im.kind === 'absorbed') absorbedCount++;
    else if (im.kind === 'unscheduled') unscheduledCount++;
    else if (im.kind === 'root') maxShiftDays = Math.max(maxShiftDays, im.shiftDays);
    if (im.projectId && im.kind !== 'absorbed') touchedProjects.add(im.projectId);
  }

  const projectFinish = new Map<string, { from: number; to: number }>();
  let finishFrom: number | null = null;
  let finishTo: number | null = null;
  for (const [id, item] of g.items) {
    if (!g.active(id)) continue;
    const { e } = g.spans.get(id)!;
    if (e === null) continue;
    const ne = newEff.has(id) ? (newEff.get(id) ?? e) : e;
    finishFrom = finishFrom === null ? e : Math.max(finishFrom, e);
    finishTo = finishTo === null ? ne : Math.max(finishTo, ne);
    if (item.projectId && touchedProjects.has(item.projectId)) {
      const cur = projectFinish.get(item.projectId);
      if (!cur) projectFinish.set(item.projectId, { from: e, to: ne });
      else {
        cur.from = Math.max(cur.from, e);
        cur.to = Math.max(cur.to, ne);
      }
    }
  }
  const projectSlips: ProjectSlip[] = [];
  for (const [projectId, f] of projectFinish) {
    if (f.to !== f.from) {
      projectSlips.push({ projectId, from: fromDay(f.from), to: fromDay(f.to), shiftDays: f.to - f.from });
    }
  }
  projectSlips.sort((a, b) => b.shiftDays - a.shiftDays);

  return {
    delayedCount,
    conflictCount,
    absorbedCount,
    unscheduledCount,
    maxShiftDays,
    projectSlips,
    finishFrom: iso(finishFrom),
    finishTo: iso(finishTo),
  };
}

/** "What if I push this task by N days / to this date?" */
export function simulateDelay(
  items: readonly PlanItem[],
  deps: readonly PlanDependency[],
  change: { taskId: string; days?: number; toDate?: ISODate },
): ImpactReport {
  const item = items.find((i) => i.id === change.taskId);
  if (!item) throw new Error('Task not found');
  const days = resolveDelayDays(item, change);
  return simulate(items, deps, { [item.id]: days });
}

/** Turns "to this date" into a day count, measured on the due date (or start date). */
export function resolveDelayDays(
  item: Pick<PlanItem, 'startDate' | 'dueDate'>,
  change: { days?: number; toDate?: ISODate },
): number {
  if (change.days !== undefined) return change.days;
  if (!change.toDate) return 0;
  const anchor = item.dueDate ?? item.startDate;
  if (!anchor) return 0;
  return toDay(change.toDate) - toDay(anchor);
}

/**
 * Live forecast: every unfinished task whose due date has passed can finish
 * today at the earliest. Propagate that reality through the plan.
 */
export function forecast(
  items: readonly PlanItem[],
  deps: readonly PlanDependency[],
  today: ISODate,
): ImpactReport {
  const t = toDay(today);
  const shifts = new Map<string, number>();
  for (const it of items) {
    // Only a passed *due* date makes a task late; a start date in the past just means "started".
    if (!isActiveStatus(it.status) || !it.dueDate) continue;
    const e = toDay(it.dueDate);
    if (e < t) shifts.set(it.id, t - e);
  }
  return simulate(items, deps, shifts);
}

export interface BlockerWarning {
  taskId: string;
  title: string;
  number?: number;
  /** The blocker's finish date. */
  dueDate: ISODate;
  /** How many days the edited task would start before that blocker is due. */
  overlapDays: number;
}

export interface DateChangePreview {
  report: ImpactReport;
  /** How far the task's finish moves (what propagates downstream). */
  shiftDays: number;
  /** Blockers the edited task would now start before (moving earlier than its dependencies allow). */
  startsBeforeBlockers: BlockerWarning[];
  /** True when something else would be pushed, a fixed date would break, or a blocker would be overrun. */
  hasImpact: boolean;
  /** Apply only the edited task. */
  only: DateChange[];
  /** Apply the edited task plus every task it pushes. */
  cascade: DateChange[];
}

/**
 * Preview an arbitrary edit of one task's dates (move, extend, shorten). Only the
 * movement of its finish propagates; the task itself takes exactly `next`.
 */
export function previewDateChange(
  items: readonly PlanItem[],
  deps: readonly PlanDependency[],
  taskId: string,
  next: DateSpan,
): DateChangePreview {
  const item = items.find((i) => i.id === taskId);
  const oldEnd = item ? (item.dueDate ?? item.startDate) : null;
  const newEnd = next.dueDate ?? next.startDate;
  const shiftDays = oldEnd && newEnd ? toDay(newEnd) - toDay(oldEnd) : 0;
  const report = simulate(items, deps, { [taskId]: shiftDays });
  for (const im of report.impacts) {
    if (im.taskId === taskId && im.kind === 'root') im.to = { ...next };
  }
  const only: DateChange[] = [{ taskId, startDate: next.startDate, dueDate: next.dueDate }];
  const cascade = [
    ...only,
    ...report.impacts
      .filter((im) => im.kind === 'shifted')
      .map((im) => ({ taskId: im.taskId, startDate: im.to.startDate, dueDate: im.to.dueDate })),
  ];

  // Moving a task earlier can make it start before its own blockers finish.
  const startsBeforeBlockers: BlockerWarning[] = [];
  const newStart = next.startDate ?? next.dueDate;
  const oldStart = item ? (item.startDate ?? item.dueDate) : null;
  if (newStart) {
    for (const d of deps) {
      if (d.taskId !== taskId) continue;
      const b = items.find((i) => i.id === d.dependsOnId);
      if (!b || !isActiveStatus(b.status)) continue;
      const bEnd = b.dueDate ?? b.startDate;
      if (!bEnd) continue;
      const overlap = toDay(bEnd) - toDay(newStart);
      const before = oldStart ? toDay(bEnd) - toDay(oldStart) : 0;
      if (overlap > 0 && overlap > Math.max(0, before)) {
        startsBeforeBlockers.push({ taskId: b.id, title: b.title, number: b.number, dueDate: bEnd, overlapDays: overlap });
      }
    }
  }

  return {
    report,
    shiftDays,
    startsBeforeBlockers,
    hasImpact:
      report.summary.delayedCount + report.summary.conflictCount > 0 || startsBeforeBlockers.length > 0,
    only,
    cascade,
  };
}

/** Date updates needed to commit a report. `cascade: false` moves only the roots. */
export function changesFromReport(report: ImpactReport, cascade = true): DateChange[] {
  return report.impacts
    .filter((im) => im.kind === 'root' || (cascade && im.kind === 'shifted'))
    .filter((im) => im.shiftDays !== 0)
    .map((im) => ({ taskId: im.taskId, startDate: im.to.startDate, dueDate: im.to.dueDate }));
}

export interface TaskLeverage {
  taskId: string;
  /** Active tasks transitively waiting on this one. */
  downstreamCount: number;
  /** Days this task can slip before anything else moves (null = nothing scheduled downstream). */
  slackDays: number | null;
  /** If this slips by one day: how many tasks move / how many fixed dates break. */
  delayedIfLate: number;
  conflictsIfLate: number;
}

/** Which tasks hold the plan together? Ranks by what a one-day slip would cost. */
export function leverage(
  items: readonly PlanItem[],
  deps: readonly PlanDependency[],
): TaskLeverage[] {
  const g = new PlanGraph(items, deps);
  const out: TaskLeverage[] = [];
  for (const [id] of g.items) {
    if (!g.active(id)) continue;
    const succs = g.activeSuccs(id);
    if (succs.length === 0) continue;
    const downstream = g.reach([id]);
    downstream.delete(id);
    const { e } = g.spans.get(id)!;
    let slack: number | null = null;
    if (e !== null) {
      for (const sId of succs) {
        const ss = g.spans.get(sId)!.s;
        if (ss === null) continue;
        const v = Math.max(0, ss - e);
        slack = slack === null ? v : Math.min(slack, v);
      }
    }
    let delayedIfLate = 0;
    let conflictsIfLate = 0;
    if (e !== null) {
      const r = simulate(items, deps, { [id]: 1 });
      delayedIfLate = r.summary.delayedCount;
      conflictsIfLate = r.summary.conflictCount;
    }
    out.push({ taskId: id, downstreamCount: downstream.size, slackDays: slack, delayedIfLate, conflictsIfLate });
  }
  out.sort(
    (a, b) =>
      b.conflictsIfLate - a.conflictsIfLate ||
      b.delayedIfLate - a.delayedIfLate ||
      b.downstreamCount - a.downstreamCount,
  );
  return out;
}

/** Would `taskId dependsOn dependsOnId` close a loop? */
export function wouldCreateCycle(
  deps: readonly PlanDependency[],
  taskId: string,
  dependsOnId: string,
): boolean {
  if (taskId === dependsOnId) return true;
  // Cycle iff dependsOnId is already (transitively) downstream of taskId.
  const succs = new Map<string, string[]>();
  for (const d of deps) push(succs, d.dependsOnId, d.taskId);
  const seen = new Set<string>([taskId]);
  const stack = [taskId];
  while (stack.length) {
    const n = stack.pop()!;
    for (const s of succs.get(n) ?? []) {
      if (s === dependsOnId) return true;
      if (!seen.has(s)) {
        seen.add(s);
        stack.push(s);
      }
    }
  }
  return false;
}

/** All task ids transitively depending on `id` (any status). */
export function downstreamOf(deps: readonly PlanDependency[], id: string): string[] {
  const succs = new Map<string, string[]>();
  for (const d of deps) push(succs, d.dependsOnId, d.taskId);
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const n = stack.pop()!;
    for (const s of succs.get(n) ?? []) {
      if (!seen.has(s) && s !== id) {
        seen.add(s);
        stack.push(s);
      }
    }
  }
  return [...seen];
}
