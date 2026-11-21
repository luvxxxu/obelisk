/**
 * Time planning — how long work takes, when in the day it happens, and how long it really took.
 *
 *  - Work hours: the days and hours someone works, with breaks, and how much of that time usually
 *    goes to tasks (focus). Everything that turns "minutes of work" into "which day" reads these.
 *  - Estimates: minutes a task is expected to take (`~1h30m` in quick add).
 *  - Time entries: what was actually spent. Three sources: `auto` (the task was in progress),
 *    `timer` (started and stopped by hand) and `manual` (typed in). Auto time only counts working
 *    hours once it runs long, so a task left in progress overnight doesn't claim the night.
 *  - Day plan: blocks of time for tasks in one day, packed around timed tasks (meetings) and breaks.
 *    A block can be one of several for the same task. Blocks the user placed or moved are locked
 *    and a re-plan works around them.
 *
 * Pure TypeScript: the server plans and records, the clients render and drag.
 */
import { z } from 'zod';
import {
  addDays,
  DAY_MINUTES,
  diffDays,
  fromMinutes,
  isISOTime,
  nowIn,
  toMinutes,
  weekday,
  type Clock,
  type ISODate,
  type ISOTime,
} from './dates';
import type { PlanDependency } from './impact';
import type { OverviewProject, OverviewTask } from './overview';
import { isoDate, isoTime, uuid } from './schemas';
import type { Priority, TaskStatus } from './types';

// ───────────────────────────── work hours

export interface TimeSpan {
  start: ISOTime;
  end: ISOTime;
}

export interface WorkHours {
  /** Days worked, 0 = Sunday … 6 = Saturday. */
  days: number[];
  start: ISOTime;
  end: ISOTime;
  /** Breaks inside the day (lunch); no planning happens in them. */
  breaks: TimeSpan[];
  /** Share of working time that goes to tasks (the rest: mail, chats, interruptions). null = learn it. */
  focus: number | null;
  /** Minutes assumed for a task without an estimate. null = learn it. */
  defaultEstimate: number | null;
}

export const DEFAULT_WORK_HOURS: WorkHours = {
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
  breaks: [{ start: '12:00', end: '13:00' }],
  focus: null,
  defaultEstimate: null,
};

/** Focus assumed until there is tracked time to learn from. */
export const DEFAULT_FOCUS = 0.7;
/** Estimate assumed for a task without one, until there is history to learn from. */
export const DEFAULT_ESTIMATE = 60;

const span = z
  .object({ start: isoTime, end: isoTime })
  .refine((v) => v.start < v.end, { message: '끝나는 시각이 시작보다 늦어야 해요' });

export const workHoursInput = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).max(7),
    start: isoTime,
    end: isoTime,
    breaks: z.array(span).max(4),
    focus: z.number().min(0.1).max(1).nullable(),
    defaultEstimate: z.number().int().min(5).max(24 * 60).nullable(),
  })
  .refine((v) => v.start < v.end, { message: '퇴근 시각이 출근 시각보다 늦어야 해요', path: ['end'] })
  .refine((v) => v.breaks.every((b) => b.start >= v.start && b.end <= v.end), {
    message: '쉬는 시간은 근무 시간 안에 있어야 해요',
    path: ['breaks'],
  })
  .transform((v) => ({ ...v, days: [...new Set(v.days)].sort((a, b) => a - b) }));

/** Stored settings (possibly from an older release) with every field filled in. */
export function workHoursOf(stored: Partial<WorkHours> | null | undefined): WorkHours {
  const parsed = workHoursInput.safeParse({ ...DEFAULT_WORK_HOURS, ...(stored ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_WORK_HOURS;
}

export function isWorkday(hours: Pick<WorkHours, 'days'>, date: ISODate): boolean {
  return hours.days.includes(weekday(date));
}

/** A half-open interval of minutes in one day, [start, end). */
export interface Interval {
  start: number;
  end: number;
}

function sortMerge(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** `free` minus every interval in `busy`. */
export function subtractIntervals(free: readonly Interval[], busy: readonly Interval[]): Interval[] {
  let out = sortMerge(free.map((i) => ({ ...i })));
  for (const b of sortMerge(busy.map((i) => ({ ...i })))) {
    const next: Interval[] = [];
    for (const f of out) {
      if (b.end <= f.start || b.start >= f.end) next.push(f);
      else {
        if (b.start > f.start) next.push({ start: f.start, end: b.start });
        if (b.end < f.end) next.push({ start: b.end, end: f.end });
      }
    }
    out = next;
  }
  return out;
}

export const intervalMinutes = (list: readonly Interval[]) => list.reduce((n, i) => n + Math.max(0, i.end - i.start), 0);

/** Working intervals of one day (start–end minus breaks), whether or not it is a workday. */
export function workIntervals(hours: WorkHours): Interval[] {
  return subtractIntervals(
    [{ start: toMinutes(hours.start), end: toMinutes(hours.end) }],
    hours.breaks.map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) })),
  );
}

/** Working minutes on a date: 0 on a day off. */
export function workMinutesOn(hours: WorkHours, date: ISODate): number {
  return isWorkday(hours, date) ? intervalMinutes(workIntervals(hours)) : 0;
}

/** Workdays from `from` to `to`, both included (at least 1, so a share never divides by zero). */
export function workdaysBetween(hours: WorkHours, from: ISODate, to: ISODate): number {
  const n = diffDays(to, from);
  if (n < 0) return 1;
  let count = 0;
  for (let k = 0; k <= Math.min(n, 366); k++) if (isWorkday(hours, addDays(from, k))) count++;
  return Math.max(1, count);
}

// ───────────────────────────── estimates

/**
 * A length of time as people type it: "90m", "1.5h", "1h30m", "90분", "1시간 30분", "1시간반",
 * "2시간", "반나절", "하루". Returns minutes, or null for anything else (a bare number included).
 */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '').replace(/(정도|쯤|걸림|소요)$/, '');
  if (!s) return null;
  if (s === '반나절') return 240;
  if (s === '하루' || s === '1일') return 480;
  if (s === '반시간') return 30;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}(?:\.\d{1,2})?)(?:h|hr|hrs|hour|hours|시간)(?:(\d{1,2})(?:m|min|mins|분)?|(반))?$/.exec(s))) {
    const h = Number(m[1]);
    const extra = m[3] ? 30 : m[2] ? Number(m[2]) : 0;
    if (m[2] && (m[1]!.includes('.') || extra > 59)) return null;
    const total = Math.round(h * 60 + extra);
    return total >= 1 && total <= 24 * 60 ? total : null;
  }
  if ((m = /^(\d{1,4})(?:m|min|mins|minutes?|분)$/.exec(s))) {
    const total = Number(m[1]);
    return total >= 1 && total <= 24 * 60 ? total : null;
  }
  return null;
}

/** "1h30m" style, for tools and quick-add round trips. */
export function formatDurationShort(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h${r}m` : `${h}h`;
}

/** Estimate chips offered in the apps, in minutes. */
export const ESTIMATE_PRESETS = [15, 30, 60, 90, 120, 240] as const;

export const estimateMinutes = z.number().int().min(1).max(24 * 60);

// ───────────────────────────── time entries

export type TimeEntrySource = 'auto' | 'timer' | 'manual';

export interface TimeEntry {
  id: string;
  workspaceId: string;
  taskId: string;
  /** null: someone who left (or hasn't joined this server yet). */
  userId: string | null;
  source: TimeEntrySource;
  startedAt: string;
  /** null while it runs. */
  endedAt: string | null;
  /** Counted minutes; null while it runs. */
  minutes: number | null;
  createdAt: string;
}

/** The one entry that runs for a user, with enough of its task to show anywhere. */
export interface RunningTimer {
  entry: TimeEntry;
  task: { id: string; number: number; title: string; workspaceId: string; projectId: string | null; status: TaskStatus; estimateMinutes: number | null; actualMinutes: number };
}

/** Auto time shorter than this is counted as it ran; longer runs only count working hours. */
export const AUTO_RAW_LIMIT = 180;

/** Working minutes between two instants, read on the wall clock of `timeZone`. */
export function workMinutesBetween(start: Date, end: Date, timeZone: string, hours: WorkHours): number {
  if (end <= start) return 0;
  const a = nowIn(timeZone, start);
  const b = nowIn(timeZone, end);
  const days = Math.min(diffDays(b.date, a.date), 120);
  const windows = workIntervals(hours);
  let total = 0;
  for (let k = 0; k <= days; k++) {
    const date = addDays(a.date, k);
    if (!isWorkday(hours, date)) continue;
    const from = k === 0 ? a.minutes : 0;
    const to = date === b.date ? b.minutes : DAY_MINUTES;
    for (const w of windows) total += Math.max(0, Math.min(w.end, to) - Math.max(w.start, from));
  }
  return total;
}

/**
 * Minutes an entry counts for when it stops. Timers count as they ran. Auto time (the task sat in
 * progress) counts as it ran up to AUTO_RAW_LIMIT; beyond that, only working hours (never less
 * than the limit, never more than it ran).
 */
export function countedMinutes(source: TimeEntrySource, start: Date, end: Date, timeZone: string, hours: WorkHours): number {
  const raw = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  if (source !== 'auto' || raw <= AUTO_RAW_LIMIT) return raw;
  const work = Math.round(workMinutesBetween(start, end, timeZone, hours));
  return Math.min(raw, Math.max(AUTO_RAW_LIMIT, work));
}

export const timerInput = z.object({
  taskId: uuid,
  action: z.enum(['start', 'stop']),
});

export const manualEntryInput = z.object({
  taskId: uuid,
  minutes: z.number().int().min(1).max(24 * 60),
  /** When it was done; default now. */
  date: isoDate.optional(),
});

/** Set the total you spent on a task (replaces your own entries on it with one). */
export const actualInput = z.object({ minutes: z.number().int().min(0).max(100 * 60) });

// ───────────────────────────── time blocks

export interface TimeBlock {
  id: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  date: ISODate;
  start: ISOTime;
  end: ISOTime;
  /** Placed or moved by hand: re-planning works around it. */
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

const blockSpan = { date: isoDate, start: isoTime, end: isoTime };
const checkBlock = (v: { start?: string; end?: string }) => !v.start || !v.end || v.start < v.end;

export const createBlockInput = z
  .object({ taskId: uuid, ...blockSpan })
  .refine(checkBlock, { message: '블록의 끝이 시작보다 늦어야 해요', path: ['end'] });

export const updateBlockInput = z
  .object({ date: isoDate.optional(), start: isoTime.optional(), end: isoTime.optional(), locked: z.boolean().optional() })
  .refine(checkBlock, { message: '블록의 끝이 시작보다 늦어야 해요', path: ['end'] });

export const autoPlanInput = z.object({
  /** Fill time left over with work due in the next days. */
  fillAhead: z.boolean().optional(),
  /** Save the plan (otherwise it is only a preview). */
  apply: z.boolean().optional(),
});

// ───────────────────────────── day planner

export interface PlannerTask {
  id: string;
  title: string;
  number?: number;
  workspaceId?: string;
  projectId: string | null;
  status: TaskStatus;
  priority: Priority;
  fixed: boolean;
  startDate: ISODate | null;
  startTime: ISOTime | null;
  dueDate: ISODate | null;
  dueTime: ISOTime | null;
  estimateMinutes: number | null;
  actualMinutes: number;
  postponedCount: number;
  position?: number;
}

export interface PlanBlockInput {
  id?: string;
  taskId: string;
  start: ISOTime;
  end: ISOTime;
  locked: boolean;
}

export interface ProposedBlock extends PlanBlockInput {
  /** Already saved and left as it is (locked, or in the past). */
  kept: boolean;
}

/** A task with a time of day: it holds that time and is not planned again. */
export interface DayEvent {
  taskId: string;
  start: ISOTime;
  end: ISOTime;
  fixed: boolean;
}

export type UnplacedReason = 'no_time' | 'blocked';

export interface DayPlan {
  date: ISODate;
  workday: boolean;
  window: TimeSpan;
  events: DayEvent[];
  /** The whole day after planning, saved blocks that stay included, by start time. */
  blocks: ProposedBlock[];
  /** Work for this day that didn't fit (or waits on something outside it). */
  unplaced: { taskId: string; minutes: number; reason: UnplacedReason }[];
  /** Placed, but its last block ends after the task's due time. */
  late: { taskId: string; dueTime: ISOTime; end: ISOTime }[];
  /** Working minutes still ahead in the day (after now), less breaks and timed tasks. */
  capacity: number;
  /** Minutes of blocks ahead in the day. */
  planned: number;
  /** Minutes the day's work asks for (ahead of now). */
  needed: number;
}

export interface PlanDayInput {
  date: ISODate;
  /** The user's wall clock. Nothing is planned before it. */
  now: Clock;
  hours: WorkHours;
  /** The user's own work across their spaces: active tasks and timed tasks. */
  tasks: readonly PlannerTask[];
  deps: readonly PlanDependency[];
  /** Saved blocks on that date. */
  blocks: readonly PlanBlockInput[];
  /** Minutes assumed for a task without an estimate. */
  defaultEstimate: number;
  /** The task whose timer runs now: it goes first. */
  runningTaskId?: string | null;
  /** Fill time left over with work due within the next week. */
  fillAhead?: boolean;
  /** Extra ranking (Jev), higher first. */
  scores?: ReadonlyMap<string, number>;
}

/** Shortest piece a task is split into (shorter remainders are placed whole). */
export const MIN_CHUNK = 25;
/** Smallest amount of work planned for a task that still has some left. */
export const MIN_WORK = 15;
const GRID = 5;
/** Work longer than this, due on a later day, is spread over the days until then. */
const SPLIT_ABOVE = 90;
const AHEAD_DAYS = 7;

const isActiveStatus = (s: TaskStatus) => s === 'todo' || s === 'doing';
const up = (n: number) => Math.ceil(n / GRID) * GRID;

/** When a timed task holds time on `date`, or null. */
export function eventOn(t: PlannerTask, date: ISODate, defaultMinutes = 30): DayEvent | null {
  const len = t.estimateMinutes ?? defaultMinutes;
  if (t.startDate === date && t.startTime) {
    const s = toMinutes(t.startTime);
    const e = t.dueDate === date && t.dueTime && t.dueTime > t.startTime ? toMinutes(t.dueTime) : Math.min(DAY_MINUTES - 1, s + len);
    return { taskId: t.id, start: t.startTime, end: fromMinutes(e), fixed: t.fixed };
  }
  // A fixed task with one time is an appointment that starts then ("치과 오후 3시 @고정").
  if (t.fixed && !t.startTime && t.dueDate === date && t.dueTime) {
    const s = toMinutes(t.dueTime);
    return { taskId: t.id, start: t.dueTime, end: fromMinutes(Math.min(DAY_MINUTES - 1, s + len)), fixed: true };
  }
  return null;
}

/**
 * Booked at a time of day (a meeting, an appointment): it holds that time on its day and is never
 * planned as work, on that day or any other (a past one that is still open is simply missed).
 */
export function isAppointment(t: Pick<PlannerTask, 'fixed' | 'startDate' | 'startTime' | 'dueDate' | 'dueTime'>): boolean {
  if (t.startDate && t.startTime) return !t.dueDate || t.dueDate === t.startDate;
  return t.fixed && !!t.dueDate && !!t.dueTime;
}

/** Fixed, no estimate, no time: a date to meet (a launch), not work to do. */
export function isMilestone(t: Pick<PlannerTask, 'fixed' | 'estimateMinutes' | 'startTime' | 'dueTime'>): boolean {
  return t.fixed && t.estimateMinutes == null && !t.startTime && !t.dueTime;
}

/** Minutes of work still left on a task (never below MIN_WORK while it is open). */
export function remainingWork(t: Pick<PlannerTask, 'estimateMinutes' | 'actualMinutes'>, defaultEstimate: number, spent = t.actualMinutes): number {
  const total = t.estimateMinutes ?? defaultEstimate;
  return up(Math.max(MIN_WORK, total - spent));
}

const toIv = (b: { start: ISOTime; end: ISOTime }): Interval => ({ start: toMinutes(b.start), end: toMinutes(b.end) });

/**
 * Pack a day. Order: the running task, overdue work, work due today at a time (earliest first),
 * the rest due today, work in progress, multi-day work (its share for the day), then — with
 * `fillAhead` — what's due soon. Within a group: earlier deadline, higher priority, Jev's score,
 * more often postponed. A task waits for its blockers placed earlier in the day; one waiting on
 * something that isn't (someone else's work, a later day) stays unplaced as `blocked`.
 * Long work is split across gaps, never into pieces shorter than MIN_CHUNK.
 */
export function planDay(input: PlanDayInput): DayPlan {
  const { date, now, hours } = input;
  const isToday = now.date === date;
  const past = now.date > date;
  const nowMin = isToday ? up(now.minutes) : past ? DAY_MINUTES : 0;
  const window: TimeSpan = { start: hours.start, end: hours.end };
  const byId = new Map(input.tasks.map((t) => [t.id, t]));

  const events = input.tasks
    .filter((t) => t.status !== 'canceled')
    .map((t) => eventOn(t, date, Math.min(input.defaultEstimate, 60)))
    .filter((e): e is DayEvent => !!e)
    .sort((a, b) => a.start.localeCompare(b.start));
  const eventIds = new Set(events.map((e) => e.taskId));

  // Saved blocks that stay: locked ones, and anything already behind us (or a block running now).
  const kept: ProposedBlock[] = [];
  for (const b of input.blocks) {
    const iv = toIv(b);
    const task = byId.get(b.taskId);
    const done = !task || !isActiveStatus(task.status);
    if (b.locked || past || iv.start < nowMin || (done && iv.end <= nowMin)) {
      kept.push({ ...b, kept: true });
    }
  }

  const keptAhead = (taskId: string) =>
    kept.filter((b) => b.taskId === taskId).reduce((n, b) => n + Math.max(0, toMinutes(b.end) - Math.max(toMinutes(b.start), nowMin)), 0);
  const keptBehind = (taskId: string) =>
    kept.filter((b) => b.taskId === taskId).reduce((n, b) => n + Math.max(0, Math.min(toMinutes(b.end), nowMin) - toMinutes(b.start)), 0);

  const base = subtractIntervals(workIntervals(hours), [{ start: 0, end: nowMin }]);
  const busy = [...events.map(toIv), ...kept.map(toIv)];
  let free = subtractIntervals(base, busy);
  const capacity = intervalMinutes(subtractIntervals(base, events.map(toIv)));

  if (past) {
    return {
      date,
      workday: isWorkday(hours, date),
      window,
      events,
      blocks: kept.sort((a, b) => a.start.localeCompare(b.start)),
      unplaced: [],
      late: [],
      capacity: 0,
      planned: 0,
      needed: 0,
    };
  }

  // ── what the day asks for
  interface Want {
    t: PlannerTask;
    group: number;
    minutes: number;
    deadline: number;
  }
  const horizon = addDays(date, AHEAD_DAYS);
  const overdueOn = (t: PlannerTask) =>
    !!t.dueDate && (t.dueDate < date || (isToday && t.dueDate === date && !!t.dueTime && toMinutes(t.dueTime) <= now.minutes));
  const wants: Want[] = [];
  for (const t of input.tasks) {
    if (!isActiveStatus(t.status) || eventIds.has(t.id) || isMilestone(t) || isAppointment(t)) continue;
    if (t.startDate && t.startDate > date) continue;
    const running = input.runningTaskId === t.id;
    const dueBy = !!t.dueDate && t.dueDate <= date;
    const started = !!t.startDate && t.startDate <= date;
    const ahead = !!input.fillAhead && !!t.dueDate && t.dueDate > date && t.dueDate <= horizon;
    if (!running && !dueBy && !started && t.status !== 'doing' && !ahead) continue;

    const spent = Math.max(t.actualMinutes, keptBehind(t.id));
    let minutes = remainingWork(t, input.defaultEstimate, spent);
    // Long work spread over several days asks for its share today (short work is done in one go).
    if (t.dueDate && t.dueDate > date && !running && minutes > SPLIT_ABOVE) {
      minutes = up(Math.max(Math.min(minutes, MIN_WORK * 2), minutes / workdaysBetween(hours, date, t.dueDate)));
    }
    minutes = Math.max(0, minutes - keptAhead(t.id));
    if (minutes <= 0) continue;

    const group = running
      ? 0
      : overdueOn(t)
        ? 1
        : t.dueDate === date && t.dueTime
          ? 2
          : t.dueDate === date
            ? 3
            : t.status === 'doing'
              ? 4
              : dueBy || started
                ? 5
                : 6;
    const deadline = t.dueDate ? diffDays(t.dueDate, date) * DAY_MINUTES + (t.dueTime ? toMinutes(t.dueTime) : DAY_MINUTES) : Infinity;
    wants.push({ t, group, minutes, deadline });
  }
  // Pulled-ahead work only fills what's left: it never pushes today's work out.
  const today = wants.filter((w) => w.group < 6);
  const ahead = wants.filter((w) => w.group === 6);

  const rank = (a: Want, b: Want) =>
    a.group - b.group ||
    a.deadline - b.deadline ||
    b.t.priority - a.t.priority ||
    (input.scores?.get(b.t.id) ?? 0) - (input.scores?.get(a.t.id) ?? 0) ||
    b.t.postponedCount - a.t.postponedCount ||
    (a.t.position ?? 0) - (b.t.position ?? 0) ||
    (a.t.number ?? 0) - (b.t.number ?? 0);

  const preds = new Map<string, string[]>();
  for (const d of input.deps) {
    if (d.taskId === d.dependsOnId) continue;
    const list = preds.get(d.taskId);
    if (list) list.push(d.dependsOnId);
    else preds.set(d.taskId, [d.dependsOnId]);
  }

  const placed: ProposedBlock[] = [];
  const finishAt = new Map<string, number>();
  const unplaced: DayPlan['unplaced'] = [];
  const late: DayPlan['late'] = [];
  const failed = new Set<string>();

  const place = (list: Want[]) => {
    const pending = [...list].sort(rank);
    const inList = new Set(pending.map((w) => w.t.id));
    let guard = pending.length * pending.length + 10;
    while (pending.length && guard-- > 0) {
      // Highest-ranked task whose blockers in this list are settled.
      const idx = pending.findIndex((w) => (preds.get(w.t.id) ?? []).every((p) => !inList.has(p) || finishAt.has(p) || failed.has(p)));
      const w = pending.splice(idx < 0 ? 0 : idx, 1)[0]!;
      let readyAt = nowMin;
      let blocked = false;
      for (const p of preds.get(w.t.id) ?? []) {
        const pt = byId.get(p);
        if (!pt || !isActiveStatus(pt.status)) continue;
        if (finishAt.has(p)) readyAt = Math.max(readyAt, finishAt.get(p)!);
        else if (eventIds.has(p)) readyAt = Math.max(readyAt, toMinutes(events.find((e) => e.taskId === p)!.end));
        else if (isMilestone(pt) && (pt.dueDate ?? pt.startDate ?? date) <= date) continue;
        else if (keptAhead(p) + keptBehind(p) > 0) {
          const last = Math.max(...kept.filter((b) => b.taskId === p).map((b) => toMinutes(b.end)));
          readyAt = Math.max(readyAt, last);
        } else blocked = true;
      }
      if (blocked) {
        failed.add(w.t.id);
        if (w.group < 6) unplaced.push({ taskId: w.t.id, minutes: w.minutes, reason: 'blocked' });
        continue;
      }

      let need = w.minutes;
      let lastEnd = -1;
      const next: Interval[] = [];
      for (const f of free) {
        if (need <= 0 || f.end <= readyAt) {
          next.push(f);
          continue;
        }
        const s = up(Math.max(f.start, readyAt));
        const room = f.end - s;
        if (room < Math.min(need, MIN_CHUNK)) {
          next.push(f);
          continue;
        }
        let take = Math.min(need, room);
        const rest = need - take;
        // Don't leave a remainder too short to be a block of its own.
        if (rest > 0 && rest < MIN_CHUNK && take - (MIN_CHUNK - rest) >= MIN_CHUNK) take -= MIN_CHUNK - rest;
        if (s > f.start) next.push({ start: f.start, end: s });
        placed.push({ taskId: w.t.id, start: fromMinutes(s), end: fromMinutes(s + take), locked: false, kept: false });
        need -= take;
        lastEnd = s + take;
        if (lastEnd < f.end) next.push({ start: lastEnd, end: f.end });
      }
      free = next;
      if (need > 0) {
        // Not finished today: what waits on it can't start today either.
        failed.add(w.t.id);
        if (w.group < 6) unplaced.push({ taskId: w.t.id, minutes: need, reason: 'no_time' });
        continue;
      }
      finishAt.set(w.t.id, lastEnd);
      const dueTime = w.t.dueDate === date ? w.t.dueTime : null;
      if (dueTime && lastEnd > toMinutes(dueTime)) late.push({ taskId: w.t.id, dueTime, end: fromMinutes(lastEnd) });
    }
  };
  place(today);
  if (ahead.length) place(ahead);

  const blocks = [...kept, ...placed].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const planned = blocks.reduce((n, b) => n + Math.max(0, toMinutes(b.end) - Math.max(toMinutes(b.start), nowMin)), 0);
  const needed = today.reduce((n, w) => n + w.minutes, 0) + kept.reduce((n, b) => n + Math.max(0, toMinutes(b.end) - Math.max(toMinutes(b.start), nowMin)), 0);
  return {
    date,
    workday: isWorkday(hours, date),
    window,
    events,
    blocks,
    unplaced,
    late,
    capacity,
    planned,
    needed,
  };
}

/** Time is "HH:MM": does a block fit in the day? */
export function validBlockSpan(start: string, end: string): boolean {
  return isISOTime(start) && isISOTime(end) && start < end;
}

// ───────────────────────────── a day as the apps show it

/** One person's day across all their spaces. */
export interface DayView {
  date: ISODate;
  today: ISODate;
  now: Clock;
  hours: WorkHours;
  workday: boolean;
  /** Minutes assumed for tasks without an estimate (from settings or history). */
  defaultEstimate: number;
  /** Saved blocks, by start time. */
  blocks: TimeBlock[];
  /** Tasks with a time that day (meetings, appointments). */
  events: DayEvent[];
  /** The day's work that has no block yet: what auto-fill would place, and what won't fit. */
  pending: { taskId: string; minutes: number; reason: UnplacedReason | null }[];
  /** Saved blocks that end after their task's due time. */
  late: { taskId: string; dueTime: ISOTime; end: ISOTime }[];
  /** Working minutes ahead (after now), less breaks and timed tasks. */
  capacity: number;
  /** Minutes of saved blocks ahead. */
  planned: number;
  /** Minutes the day's remaining work asks for. */
  needed: number;
  /** Every task the day mentions, from any space. */
  tasks: OverviewTask[];
  projects: OverviewProject[];
  running: RunningTimer | null;
}

export interface DayProposalResponse {
  /** The proposal (kept blocks marked). */
  plan: DayPlan;
  /** Every task the proposal mentions. */
  tasks: OverviewTask[];
  projects: OverviewProject[];
  /** The day after saving it (only with `apply`). */
  view: DayView | null;
}
