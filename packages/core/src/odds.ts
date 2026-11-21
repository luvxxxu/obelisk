/**
 * Finish-date odds — "when will this really be done, and how sure is that?"
 *
 * The delay engine (impact.ts) answers what moves when a date moves. This answers how likely the
 * dates are in the first place, from the person's own history:
 *
 *  - Estimates run long. Finished tasks with an estimate and tracked time give actual ÷ estimate
 *    ratios; each simulated run draws one per task (mixed with a prior while there are few).
 *  - Days aren't all work. Each person's work hours × focus (learned from tracked time) is their
 *    capacity per day, less meetings (timed tasks). Days vary a little from run to run.
 *  - Deadlines slip. For tasks without an estimate, the minutes are only a guess, so their finish is
 *    also held to the person's record of finishing against their first due date.
 *
 * Each run walks the days: every person works through their ready tasks, most urgent first (a
 * task inherits the deadline of what waits on it), and a task can't start before its blockers are
 * done. Hundreds of runs give, per task, the chance to finish by its due date and its P50/P85
 * finish; per project the same for its last task; per fixed date the chance something runs into it.
 *
 * A seeded generator keeps answers stable between calls. Pure TypeScript, no I/O.
 */
import { addDays, diffDays, fromDay, toDay, toMinutes, type ISODate } from './dates';
import type { PlanDependency } from './impact';
import { isAppointment, isMilestone, workIntervals, workMinutesOn, isWorkday, type WorkHours, DEFAULT_ESTIMATE, DEFAULT_FOCUS, MIN_WORK } from './timeplan';
import type { Priority, TaskStatus } from './types';
import { z } from 'zod';
import { isoDate, uuid } from './schemas';

export const UNASSIGNED = 'unassigned';

export interface OddsTask {
  id: string;
  title: string;
  number?: number;
  projectId: string | null;
  status: TaskStatus;
  priority: Priority;
  fixed: boolean;
  startDate: ISODate | null;
  startTime: string | null;
  dueDate: ISODate | null;
  dueTime: string | null;
  estimateMinutes: number | null;
  actualMinutes: number;
  /** Whose time it takes: a user id, or UNASSIGNED. */
  queue: string;
  /** The person's work in another space: it takes their time but isn't reported here. */
  external?: boolean;
}

// ───────────────────────────── calibration

export interface FinishedSample {
  estimateMinutes: number | null;
  actualMinutes: number;
  /** The first due date the task ever had (later postponements don't move it). */
  firstDueDate: ISODate | null;
  completedOn: ISODate;
}

export interface Calibration {
  /** actual ÷ estimate of finished tasks (clamped to 0.2–6). */
  ratios: number[];
  /** Days finished after the first due date (negative = early). */
  slips: number[];
  focus: number;
  focusSource: 'setting' | 'history' | 'default';
  defaultEstimate: number;
  defaultEstimateSource: 'setting' | 'history' | 'pace' | 'default';
  /** Median of `ratios`, null without any. */
  medianRatio: number | null;
  /** Share of dated finishes on or before their first due date, null without any. */
  onTimeRate: number | null;
  /** Average days late among the late ones. */
  meanLateDays: number | null;
  /** Days of tracked time `focus` was learned from. */
  trackedDays: number;
}

export interface CalibrateInput {
  /** Finished tasks, newest first (the last ~120 days is plenty). */
  finished: readonly FinishedSample[];
  /** Minutes tracked on each recent workday that has any tracked time. */
  trackedPerDay: readonly number[];
  today: ISODate;
  hours: WorkHours;
}

const RATIO_MIN = 0.2;
const RATIO_MAX = 6;
/** Before there is history: estimates run ~25% long, with a wide spread. */
const PRIOR_RATIO = 1.25;
const PRIOR_SIGMA = 0.45;
/** A task without an estimate is a guess around the default: wider still. */
const GUESS_SIGMA = 0.7;
/** History counts as much as this many prior samples. */
const PRIOR_WEIGHT = 8;

const median = (xs: readonly number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Average working minutes on a workday. */
function workdayMinutes(hours: WorkHours): number {
  return workIntervals(hours).reduce((n, i) => n + i.end - i.start, 0);
}

export function calibrate(input: CalibrateInput): Calibration {
  const { hours } = input;
  const ratios = input.finished
    .filter((f) => f.estimateMinutes && f.estimateMinutes > 0 && f.actualMinutes > 0)
    .slice(0, 200)
    .map((f) => Math.min(RATIO_MAX, Math.max(RATIO_MIN, f.actualMinutes / f.estimateMinutes!)));
  const slips = input.finished
    .filter((f) => f.firstDueDate)
    .slice(0, 200)
    .map((f) => Math.max(-30, Math.min(60, diffDays(f.completedOn, f.firstDueDate!))));

  const perDay = workdayMinutes(hours) || 480;
  let focus = DEFAULT_FOCUS;
  let focusSource: Calibration['focusSource'] = 'default';
  if (hours.focus != null) {
    focus = hours.focus;
    focusSource = 'setting';
  } else if (input.trackedPerDay.length >= 5) {
    focus = Math.min(1, Math.max(0.2, median(input.trackedPerDay)! / perDay));
    focusSource = 'history';
  }

  let defaultEstimate = DEFAULT_ESTIMATE;
  let defaultEstimateSource: Calibration['defaultEstimateSource'] = 'default';
  const actuals = input.finished.filter((f) => f.actualMinutes > 0).map((f) => f.actualMinutes);
  const from = addDays(input.today, -28);
  const recent = input.finished.filter((f) => f.completedOn >= from && f.completedOn < input.today).length;
  let workdays = 0;
  for (let k = 1; k <= 28; k++) if (isWorkday(hours, addDays(input.today, -k))) workdays++;
  if (hours.defaultEstimate != null) {
    defaultEstimate = hours.defaultEstimate;
    defaultEstimateSource = 'setting';
  } else if (actuals.length >= 5) {
    defaultEstimate = Math.round(Math.min(480, Math.max(10, median(actuals)!)));
    defaultEstimateSource = 'history';
  } else if (recent >= 10 && workdays > 0) {
    // Finishing n tasks a day with f minutes of focus: a task is about f ÷ n minutes.
    defaultEstimate = Math.round(Math.min(240, Math.max(15, (focus * perDay) / (recent / workdays))));
    defaultEstimateSource = 'pace';
  }

  const late = slips.filter((s) => s > 0);
  return {
    ratios,
    slips,
    focus,
    focusSource,
    defaultEstimate,
    defaultEstimateSource,
    medianRatio: median(ratios),
    onTimeRate: slips.length ? slips.filter((s) => s <= 0).length / slips.length : null,
    meanLateDays: late.length ? late.reduce((a, b) => a + b, 0) / late.length : null,
    trackedDays: input.trackedPerDay.length,
  };
}

/** What the apps show about a calibration (the raw samples stay on the server). */
export type CalibrationSummary = Omit<Calibration, 'ratios' | 'slips'> & { ratioSamples: number; slipSamples: number };

export function summarizeCalibration(c: Calibration): CalibrationSummary {
  const { ratios, slips, ...rest } = c;
  return { ...rest, ratioSamples: ratios.length, slipSamples: slips.length };
}

/** GET /api/odds */
export interface OddsResponse {
  today: ISODate;
  report: OddsReport;
  /** The caller's own calibration. */
  calibration: CalibrationSummary;
  /** Tasks of the caller's other spaces counted as load. */
  external: number;
}

/** POST /api/odds/commit */
export interface CommitResponse {
  today: ISODate;
  report: CommitReport;
  /** Minutes assumed for the work (its estimate, else the default). */
  minutes: number;
  estimated: boolean;
}

export const NO_HISTORY: Calibration = calibrate({ finished: [], trackedPerDay: [], today: '2026-01-01', hours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', breaks: [], focus: null, defaultEstimate: null } });

// ───────────────────────────── randomness

/** Small seeded generator (mulberry32): the same seed gives the same runs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number): number {
  const u = Math.max(1e-12, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const logNormal = (r: () => number, median: number, sigma: number) => median * Math.exp(sigma * normal(r));

function sampleRatio(r: () => number, cal: Calibration): number {
  const n = cal.ratios.length;
  if (n && r() < n / (n + PRIOR_WEIGHT)) return cal.ratios[Math.floor(r() * n)]! * Math.exp(0.1 * normal(r));
  return Math.min(RATIO_MAX, logNormal(r, PRIOR_RATIO, PRIOR_SIGMA));
}

/** Days after the due date a task gets finished, from the record (or a mild prior). */
function sampleSlip(r: () => number, cal: Calibration): number {
  const n = cal.slips.length;
  if (n && r() < n / (n + PRIOR_WEIGHT)) return cal.slips[Math.floor(r() * n)]!;
  // Prior: two in three on time (a day or two early), the rest a few days late.
  if (r() < 0.65) return -Math.floor(r() * 3);
  return 1 + Math.floor(-Math.log(Math.max(1e-9, r())) * 2);
}

// ───────────────────────────── the simulation

export interface OddsPerson {
  hours: WorkHours;
  calibration: Calibration;
}

export interface OddsInput {
  today: ISODate;
  /** Minutes past midnight now: only what's left of today is capacity. */
  nowMinutes: number;
  tasks: readonly OddsTask[];
  deps: readonly PlanDependency[];
  /** Queue id → work hours and calibration. Missing queues get default hours and no history. */
  people: ReadonlyMap<string, OddsPerson>;
  runs?: number;
  seed?: number;
  /** How far to simulate (default 180 days). Later finishes count as "beyond". */
  horizonDays?: number;
}

type Kind = 'work' | 'milestone' | 'event';

interface Prepared {
  n: number;
  ids: string[];
  tasks: OddsTask[];
  kind: Kind[];
  /** Day offset (from today) a task can start, and its due / date offset. */
  startOff: Int32Array;
  dueOff: Int32Array; // NONE when undated
  /** The day a fixed date happens (its start, else its due). */
  dayOff: Int32Array;
  /** Minutes of work left, before the estimate error. */
  base: Float64Array;
  estimated: Uint8Array;
  /** Held to the slip record. */
  slips: Uint8Array;
  preds: number[][];
  queueOf: Int32Array;
  /** Per-task stream seeds. */
  seeds: Uint32Array;
  queues: { id: string; person: OddsPerson; order: number[]; cap: Float64Array }[];
  horizon: number;
}

const NONE = 1 << 29;
const DEFAULT_PERSON = (hours: WorkHours): OddsPerson => ({ hours, calibration: NO_HISTORY });
const FALLBACK_HOURS: WorkHours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', breaks: [{ start: '12:00', end: '13:00' }], focus: null, defaultEstimate: null };

const active = (t: { status: TaskStatus }) => t.status === 'todo' || t.status === 'doing';

/** Booked at a time: it holds that time and isn't queued work. */
const isEvent = (t: OddsTask) => isAppointment(t);

function eventMinutes(t: OddsTask): number {
  if (t.startTime && t.dueTime && t.startDate === t.dueDate) return Math.max(0, toMinutes(t.dueTime) - toMinutes(t.startTime));
  return t.estimateMinutes ?? 30;
}

function prepare(input: OddsInput): Prepared {
  const t0 = toDay(input.today);
  const horizon = input.horizonDays ?? 180;
  const tasks = input.tasks.filter(active);
  const index = new Map(tasks.map((t, i) => [t.id, i]));
  const n = tasks.length;
  const kind: Kind[] = [];
  const startOff = new Int32Array(n);
  const dueOff = new Int32Array(n);
  const dayOff = new Int32Array(n);
  const base = new Float64Array(n);
  const estimated = new Uint8Array(n);
  const slips = new Uint8Array(n);
  const queueOf = new Int32Array(n);
  const preds: number[][] = Array.from({ length: n }, () => []);
  const succs: number[][] = Array.from({ length: n }, () => []);
  for (const d of input.deps) {
    const a = index.get(d.taskId);
    const b = index.get(d.dependsOnId);
    if (a === undefined || b === undefined || a === b) continue;
    preds[a]!.push(b);
    succs[b]!.push(a);
  }

  const queueIds: string[] = [];
  const queueIndex = new Map<string, number>();
  const person = (q: string) => input.people.get(q) ?? DEFAULT_PERSON(input.people.values().next().value?.hours ?? FALLBACK_HOURS);
  for (const [i, t] of tasks.entries()) {
    if (!queueIndex.has(t.queue)) {
      queueIndex.set(t.queue, queueIds.length);
      queueIds.push(t.queue);
    }
    queueOf[i] = queueIndex.get(t.queue)!;
    const cal = person(t.queue).calibration;
    const off = (d: ISODate | null) => (d ? toDay(d) - t0 : NONE);
    const due = off(t.dueDate ?? (isMilestone(t) ? t.startDate : null));
    dueOff[i] = due;
    startOff[i] = t.startDate ? Math.max(0, toDay(t.startDate) - t0) : 0;
    dayOff[i] = t.startDate ? toDay(t.startDate) - t0 : due;
    if (isEvent(t)) {
      // A meeting happens on its day (one that passed while still open counts as today).
      kind.push('event');
      dueOff[i] = Math.max(0, off(t.dueDate ?? t.startDate));
    } else if (isMilestone(t)) {
      kind.push('milestone');
    } else {
      kind.push('work');
      estimated[i] = t.estimateMinutes != null ? 1 : 0;
      const total = t.estimateMinutes ?? cal.defaultEstimate;
      base[i] = Math.max(t.estimateMinutes != null ? 5 : MIN_WORK, total - t.actualMinutes, t.estimateMinutes == null ? total * 0.3 : 0);
      slips[i] = !t.fixed && t.estimateMinutes == null && due !== NONE ? 1 : 0;
    }
  }

  // A task is as urgent as the most urgent thing waiting on it (reverse topological order).
  const eff = Int32Array.from(dueOff);
  const order = topo(n, preds, succs);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]!;
    for (const s of succs[i]!) if (eff[s]! < eff[i]!) eff[i] = eff[s]!;
  }

  const queues = queueIds.map((id) => {
    const p = person(id);
    const cap = new Float64Array(horizon + 1);
    const windows = workIntervals(p.hours);
    for (let d = 0; d <= horizon; d++) {
      const date = fromDay(t0 + d);
      let minutes = workMinutesOn(p.hours, date);
      if (d === 0 && minutes > 0) {
        minutes = windows.reduce((sum, w) => sum + Math.max(0, w.end - Math.max(w.start, input.nowMinutes)), 0);
      }
      cap[d] = minutes * p.calibration.focus;
    }
    return { id, person: p, order: [] as number[], cap };
  });
  // Meetings take their time from that day.
  for (let i = 0; i < n; i++) {
    if (kind[i] !== 'event') continue;
    const d = dueOff[i]!;
    if (d < 0 || d > horizon) continue;
    const q = queues[queueOf[i]!]!;
    q.cap[d] = Math.max(0, q.cap[d]! - eventMinutes(tasks[i]!));
  }
  for (let i = 0; i < n; i++) if (kind[i] === 'work') queues[queueOf[i]!]!.order.push(i);
  for (const q of queues) {
    q.order.sort(
      (a, b) =>
        eff[a]! - eff[b]! ||
        (tasks[a]!.status === 'doing' ? 0 : 1) - (tasks[b]!.status === 'doing' ? 0 : 1) ||
        tasks[b]!.priority - tasks[a]!.priority ||
        (tasks[a]!.number ?? 0) - (tasks[b]!.number ?? 0),
    );
  }
  const seeds = Uint32Array.from(tasks.map((t) => hash(t.id)));
  return { n, ids: tasks.map((t) => t.id), tasks, kind, startOff, dueOff, dayOff, base, estimated, slips, preds, queueOf, seeds, queues, horizon };
}

function topo(n: number, preds: number[][], succs: number[][]): number[] {
  const indeg = new Int32Array(n);
  for (let i = 0; i < n; i++) indeg[i] = preds[i]!.length;
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (!indeg[i]) queue.push(i);
  const out: number[] = [];
  while (queue.length) {
    const i = queue.shift()!;
    out.push(i);
    for (const s of succs[i]!) if (--indeg[s]! === 0) queue.push(s);
  }
  if (out.length < n) for (let i = 0; i < n; i++) if (!out.includes(i)) out.push(i);
  return out;
}

/** FNV-1a: a stable number per task or person, so each keeps its own random stream. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * One run: the finish day (offset from today, horizon+1 = beyond) of every task, and conflicts.
 * Every task and every person draws from a stream of its own (seeded by id and run), so adding or
 * removing one task leaves everyone else's luck as it was: differences between two plans are real.
 */
function runOnce(p: Prepared, seed: number, run: number, finish: Int32Array, conflict: Uint8Array) {
  const { n, kind, startOff, dueOff, preds, queues, horizon } = p;
  const remaining = new Float64Array(n);
  const hold = new Int32Array(n);
  let open = 0;
  for (let i = 0; i < n; i++) {
    conflict[i] = 0;
    if (kind[i] !== 'work') {
      finish[i] = Math.max(0, Math.min(dueOff[i]!, horizon + 1));
      continue;
    }
    finish[i] = -1;
    open++;
    const r = rng((p.seeds[i]! ^ seed) + run * 0x9e3779b1);
    const cal = queues[p.queueOf[i]!]!.person.calibration;
    remaining[i] = p.estimated[i] ? p.base[i]! * sampleRatio(r, cal) : logNormal(r, p.base[i]!, GUESS_SIGMA);
    hold[i] = p.slips[i] ? dueOff[i]! + sampleSlip(r, cal) : -NONE;
  }
  const days = queues.map((q) => rng((hash(q.id) ^ seed) + run * 0x85ebca6b));
  const firstOpen = new Int32Array(queues.length);
  const left = new Float64Array(queues.length);
  for (let day = 0; day <= horizon && open > 0; day++) {
    for (let q = 0; q < queues.length; q++) {
      const c = queues[q]!.cap[day]!;
      // Some days go better than others.
      const luck = Math.exp(0.25 * normal(days[q]!));
      left[q] = c > 0 ? c * Math.min(1.5, Math.max(0.35, luck)) : 0;
    }
    for (let pass = 0; pass < 4; pass++) {
      let progressed = false;
      for (let q = 0; q < queues.length; q++) {
        if (left[q]! <= 0) continue;
        const order = queues[q]!.order;
        while (firstOpen[q]! < order.length && finish[order[firstOpen[q]!]!]! >= 0) firstOpen[q]!++;
        for (let k = firstOpen[q]!; k < order.length && left[q]! > 0; k++) {
          const i = order[k]!;
          if (finish[i]! >= 0 || startOff[i]! > day) continue;
          let ready = true;
          for (const b of preds[i]!) {
            const f = finish[b]!;
            if (f < 0 || f > day) {
              ready = false;
              break;
            }
          }
          if (!ready) continue;
          const use = Math.min(left[q]!, remaining[i]!);
          remaining[i]! -= use;
          left[q]! -= use;
          if (remaining[i]! <= 1e-6) {
            finish[i] = Math.max(day, hold[i]!);
            open--;
            progressed = true;
          }
        }
      }
      if (!progressed) break;
    }
  }
  for (let i = 0; i < n; i++) {
    if (finish[i]! < 0) finish[i] = horizon + 1;
    if (kind[i] === 'work') continue;
    if (!p.tasks[i]!.fixed) continue;
    // A fixed date conflicts when a blocker is still open on its day.
    const at = Math.max(0, p.dayOff[i]!);
    for (const b of preds[i]!) if (finish[b]! > at) conflict[i] = 1;
  }
}

interface Sims {
  p: Prepared;
  runs: number;
  /** finishes[run * n + i] */
  finishes: Int32Array;
  conflicts: Uint8Array;
}

function simulateRuns(p: Prepared, runs: number, seed: number): Sims {
  const finishes = new Int32Array(runs * p.n);
  const conflicts = new Uint8Array(runs * p.n);
  const f = new Int32Array(p.n);
  const c = new Uint8Array(p.n);
  for (let k = 0; k < runs; k++) {
    runOnce(p, seed, k, f, c);
    finishes.set(f, k * p.n);
    conflicts.set(c, k * p.n);
  }
  return { p, runs, finishes, conflicts };
}

// ───────────────────────────── reports

export interface DateOdds {
  p50: ISODate | null;
  p85: ISODate | null;
  p95: ISODate | null;
}

export interface TaskOdds extends DateOdds {
  taskId: string;
  /** Chance it is done by its due date (null without one). */
  onTime: number | null;
  /** Fixed dates: chance a blocker is still open on the day. */
  conflict: number | null;
}

export interface ProjectOdds extends DateOdds {
  /** null = tasks without a project. */
  projectId: string | null;
  tasks: number;
}

export interface OddsReport {
  today: ISODate;
  runs: number;
  /** Finishes later than this are reported as null ("beyond"). */
  horizon: ISODate;
  tasks: TaskOdds[];
  projects: ProjectOdds[];
  /** All of the reported work. */
  overall: DateOdds | null;
}

function quantiles(values: Int32Array | number[], today: ISODate, horizon: number): DateOdds {
  const s = Array.from(values).sort((a, b) => a - b);
  const at = (q: number) => {
    const v = s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
    return v > horizon ? null : addDays(today, v);
  };
  return { p50: at(0.5), p85: at(0.85), p95: at(0.95) };
}

function column(s: Sims, i: number): Int32Array {
  const out = new Int32Array(s.runs);
  for (let k = 0; k < s.runs; k++) out[k] = s.finishes[k * s.p.n + i]!;
  return out;
}

function taskOdds(s: Sims, i: number, today: ISODate): TaskOdds {
  const { p } = s;
  const col = column(s, i);
  const due = p.dueOff[i]!;
  let onTime: number | null = null;
  if (due !== NONE && p.kind[i] === 'work') {
    let ok = 0;
    for (const v of col) if (v <= Math.max(0, due)) ok++;
    onTime = ok / s.runs;
  }
  let conflict: number | null = null;
  if (p.kind[i] !== 'work' && p.tasks[i]!.fixed && p.preds[i]!.length) {
    let c = 0;
    for (let k = 0; k < s.runs; k++) c += s.conflicts[k * p.n + i]!;
    conflict = c / s.runs;
  }
  return { taskId: p.ids[i]!, ...quantiles(col, today, p.horizon), onTime, conflict };
}

/** Odds for every task, project and the whole of the reported work. */
export function forecastOdds(input: OddsInput): OddsReport {
  const runs = input.runs ?? 400;
  const p = prepare(input);
  const s = simulateRuns(p, runs, input.seed ?? seedOf(input.today));
  const reported = p.tasks.map((t) => !t.external);
  const tasks: TaskOdds[] = [];
  for (let i = 0; i < p.n; i++) if (reported[i]) tasks.push(taskOdds(s, i, input.today));

  const groups = new Map<string | null, number[]>();
  for (let i = 0; i < p.n; i++) {
    if (!reported[i]) continue;
    const key = p.tasks[i]!.projectId;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const latest = (members: number[]) => {
    const out = new Int32Array(runs);
    for (let k = 0; k < runs; k++) {
      let m = 0;
      for (const i of members) m = Math.max(m, s.finishes[k * p.n + i]!);
      out[k] = m;
    }
    return out;
  };
  const projects: ProjectOdds[] = [...groups].map(([projectId, members]) => ({
    projectId,
    tasks: members.length,
    ...quantiles(latest(members), input.today, p.horizon),
  }));
  const all = [...groups.values()].flat();
  return {
    today: input.today,
    runs,
    horizon: addDays(input.today, p.horizon),
    tasks,
    projects,
    overall: all.length ? quantiles(latest(all), input.today, p.horizon) : null,
  };
}

/** Same day, same answer. */
export function seedOf(today: ISODate): number {
  return toDay(today) * 2654435761;
}

// ───────────────────────────── commitments

export interface CommitSubject {
  /** An existing task to date, or omitted for new work. */
  taskId?: string;
  title: string;
  estimateMinutes: number | null;
  projectId: string | null;
  queue: string;
  priority: Priority;
  blockedBy: readonly string[];
  /** Can't start before this. */
  startDate?: ISODate | null;
}

export interface CommitHarm {
  taskId: string;
  /** 'late': a dated task's chance to make its due date drops. 'conflict': a fixed date's risk rises. */
  kind: 'late' | 'conflict';
  before: number;
  after: number;
}

export interface CommitOption {
  date: ISODate;
  /** Chance the new work is done by `date` when it is due then. */
  probability: number;
  /** Other work that gets riskier (≥ HARM_STEP) when this is due on `date`. */
  harmed: CommitHarm[];
}

export interface CommitReport {
  confidence: number;
  /** Without a due date, after everything already dated: when it gets done on its own. */
  natural: DateOdds;
  /** The first date reaching `confidence`, whatever it does to other work. */
  earliest: CommitOption | null;
  /** The first date reaching `confidence` that makes no other work riskier. */
  safe: CommitOption | null;
  /** The date asked about. */
  proposed: CommitOption | null;
  /** Dates around the answer, for a picker. */
  days: { date: ISODate; probability: number; harmed: number }[];
}

/** Another task's odds have to move at least this much to count as harmed. */
export const HARM_STEP = 0.05;
/** Days walked one by one before the search halves the range. */
const SCAN_DAYS = 45;
export const DEFAULT_CONFIDENCE = 0.85;

export const commitInput = z.object({
  /** An existing task to find a due date for (its estimate, blockers and assignee are used). */
  taskId: uuid.optional(),
  title: z.string().trim().max(500).optional(),
  estimateMinutes: z.number().int().min(1).max(100 * 60).nullable().optional(),
  projectId: uuid.nullable().optional(),
  assigneeId: uuid.nullable().optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  blockedBy: z.array(uuid).max(50).optional(),
  startDate: isoDate.nullable().optional(),
  /** A date to check. */
  date: isoDate.optional(),
  confidence: z.number().min(0.5).max(0.99).optional(),
});
export type CommitInput = z.infer<typeof commitInput>;

const SUBJECT = '__commit__';

export function commitOdds(input: OddsInput, subject: CommitSubject, opts: { confidence?: number; date?: ISODate; runs?: number } = {}): CommitReport {
  const confidence = opts.confidence ?? DEFAULT_CONFIDENCE;
  const runs = opts.runs ?? 240;
  const seed = input.seed ?? seedOf(input.today);
  const subjectId = subject.taskId ?? SUBJECT;
  const existing = subject.taskId ? input.tasks.find((t) => t.id === subject.taskId) : undefined;
  const others = input.tasks.filter((t) => t.id !== subjectId);
  const deps = input.deps;
  const extraDeps = subject.taskId ? [] : subject.blockedBy.map((b) => ({ taskId: SUBJECT, dependsOnId: b }));
  const make = (due: ISODate | null): OddsTask => ({
    id: subjectId,
    title: subject.title,
    number: existing?.number,
    projectId: subject.projectId,
    status: existing?.status === 'doing' ? 'doing' : 'todo',
    priority: subject.priority,
    fixed: false,
    startDate: subject.startDate ?? null,
    startTime: null,
    dueDate: due,
    dueTime: null,
    estimateMinutes: subject.estimateMinutes,
    actualMinutes: existing?.actualMinutes ?? 0,
    queue: subject.queue,
  });

  // Baseline: the plan as it is (an existing subject without its due date, so it doesn't count twice).
  const baseInput = { ...input, tasks: [...others, ...(existing ? [make(null)] : [])], deps: [...deps] };
  const baseP = prepare(baseInput);
  const baseS = simulateRuns(baseP, runs, seed);
  const baseOdds = new Map<string, TaskOdds>();
  for (let i = 0; i < baseP.n; i++) if (!baseP.tasks[i]!.external) baseOdds.set(baseP.ids[i]!, taskOdds(baseS, i, input.today));

  const evaluate = (due: ISODate | null) => {
    const p = prepare({ ...input, tasks: [...others, make(due)], deps: [...deps, ...extraDeps] });
    const s = simulateRuns(p, runs, seed);
    const idx = p.ids.indexOf(subjectId);
    return { p, s, idx };
  };

  const natural = (() => {
    const { s, idx } = evaluate(null);
    return quantiles(column(s, idx), input.today, s.p.horizon);
  })();

  const memo = new Map<number, CommitOption>();
  const at = (off: number): CommitOption => {
    const hit = memo.get(off);
    if (hit) return hit;
    const date = addDays(input.today, off);
    const { p, s, idx } = evaluate(date);
    const col = column(s, idx);
    let ok = 0;
    for (const v of col) if (v <= off) ok++;
    const harmed: CommitHarm[] = [];
    for (let i = 0; i < p.n; i++) {
      if (i === idx || p.tasks[i]!.external) continue;
      const before = baseOdds.get(p.ids[i]!);
      if (!before) continue;
      const after = taskOdds(s, i, input.today);
      if (before.onTime != null && after.onTime != null && before.onTime - after.onTime >= HARM_STEP) {
        harmed.push({ taskId: p.ids[i]!, kind: 'late', before: before.onTime, after: after.onTime });
      }
      if (before.conflict != null && after.conflict != null && after.conflict - before.conflict >= HARM_STEP) {
        harmed.push({ taskId: p.ids[i]!, kind: 'conflict', before: before.conflict, after: after.conflict });
      }
    }
    harmed.sort((a, b) => b.before - b.after - (a.before - a.after));
    const out = { date, probability: ok / runs, harmed };
    memo.set(off, out);
    return out;
  };

  const horizon = baseP.horizon;
  const earliestFrom = subject.startDate ? Math.max(0, diffDays(subject.startDate, input.today)) : 0;
  const reach = (o: CommitOption) => o.probability >= confidence;
  const harmless = (o: CommitOption) => reach(o) && o.harmed.length === 0;
  // The odds aren't monotone in the date: an early due date jumps the queue (and may hurt others),
  // a later one waits its turn. Walk the near days one by one; past the natural finish the new work
  // only waits behind what's due earlier, so the odds only grow and halving the range is safe.
  const naturalOff = natural.p85 ? diffDays(natural.p85, input.today) : horizon;
  const walkTo = Math.min(horizon, Math.max(earliestFrom, naturalOff) + 2, earliestFrom + SCAN_DAYS);
  let earliestOff: number | null = null;
  let safeOff: number | null = null;
  for (let o = earliestFrom; o <= walkTo && safeOff === null; o++) {
    const x = at(o);
    if (earliestOff === null && reach(x)) earliestOff = o;
    if (harmless(x)) safeOff = o;
  }
  /** First offset in [lo, hi] where `good` holds, once it holds for good. */
  const first = (lo: number, hi: number, good: (o: CommitOption) => boolean): number | null => {
    if (lo > hi || !good(at(hi))) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (good(at(mid))) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  earliestOff ??= first(walkTo + 1, horizon, reach);
  safeOff ??= first(Math.max(walkTo + 1, earliestOff ?? 0), horizon, harmless);
  const proposedOff = opts.date ? Math.max(0, diffDays(opts.date, input.today)) : null;

  const days: CommitReport['days'] = [];
  const centre = earliestOff ?? (natural.p85 ? diffDays(natural.p85, input.today) : 7);
  const from = Math.max(earliestFrom, centre - 3);
  const to = Math.min(horizon, Math.max(safeOff ?? centre, proposedOff ?? centre, centre) + 3, from + 20);
  for (let o = from; o <= to; o++) {
    const x = at(o);
    days.push({ date: x.date, probability: x.probability, harmed: x.harmed.length });
  }

  return {
    confidence,
    natural,
    earliest: earliestOff === null ? null : at(earliestOff),
    safe: safeOff === null ? null : at(safeOff),
    proposed: proposedOff === null ? null : at(Math.min(horizon, proposedOff)),
    days,
  };
}

/** "85%" */
export const percentKo = (p: number) => `${Math.round(p * 100)}%`;
