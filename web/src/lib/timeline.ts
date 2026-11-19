import { addDays, DAY_MINUTES, fromDay, toDay, toMinutes, type ISODate, type ISOTime, type Task } from '@obelisk/core';
import type { TimedSpan } from './reschedule';

/**
 * Timeline geometry and drag math, kept free of React so it can be reasoned about (and tested) alone.
 *
 * Scale is "pixels per day". Below HOUR_SCALE a bar fills whole day columns (the delay model counts
 * days); from HOUR_SCALE up the grid shows hours and timed tasks sit at their start/due times.
 */

/** Zoom stops for the −/+ buttons; pinch and ⌘-scroll move smoothly between MIN and MAX. */
export const ZOOM_STOPS = [24, 36, 56, 88, 140, 220, 360, 576, 960, 1440, 2160, 2880] as const;
export const MIN_SCALE = ZOOM_STOPS[0];
export const MAX_SCALE = ZOOM_STOPS[ZOOM_STOPS.length - 1];
export const DEFAULT_SCALE = 36;
/** From here up the timeline draws hours and places timed tasks at their times. */
export const HOUR_SCALE = 300;

export const clampScale = (w: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, w));

/** The next stop in a direction (from an in-between value after a pinch, too). */
export function stepScale(w: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STOPS.find((z) => z > w * 1.02) ?? MAX_SCALE;
  return [...ZOOM_STOPS].reverse().find((z) => z < w / 1.02) ?? MIN_SCALE;
}

/** Drag snapping in hour scale: the finest of 15/30/60 minutes that is still at least ~10px wide. */
export function snapMinutes(scale: number): number {
  const ppm = scale / DAY_MINUTES;
  if (15 * ppm >= 10) return 15;
  if (30 * ppm >= 10) return 30;
  return 60;
}

/** Hour labels in the header: every 1, 2, 3 or 6 hours, whichever leaves ~44px between them. */
export function hourStep(scale: number): number {
  const perHour = scale / 24;
  return [1, 2, 3, 6, 12].find((h) => h * perHour >= 44) ?? 12;
}

export type Timed = Pick<Task, 'startDate' | 'dueDate' | 'startTime' | 'dueTime'>;
export type DragMode = 'move' | 'start' | 'end';

/** First and last day a task occupies (a lone date counts for both), or null if it has none. */
export function daySpan(t: Pick<Task, 'startDate' | 'dueDate'>): { s: ISODate; e: ISODate } | null {
  const a = t.startDate ?? t.dueDate;
  const b = t.dueDate ?? t.startDate;
  return a && b ? { s: a, e: b } : null;
}

export function hasTime(t: Timed): boolean {
  return !!((t.startDate && t.startTime) || (t.dueDate && t.dueTime));
}

/** Minutes since the epoch day 0 (wall clock) for a date and minute-of-day. */
const at = (date: ISODate, minutes: number) => toDay(date) * DAY_MINUTES + minutes;

function split(index: number): { date: ISODate; time: ISOTime } {
  const day = Math.floor(index / DAY_MINUTES);
  const m = index - day * DAY_MINUTES;
  return { date: fromDay(day), time: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` };
}

/**
 * Where a task sits on the clock, as [from, to) in absolute minutes. A date without a time spans
 * its whole day; a one-day task with only one time is shown as an hour-long block at that time
 * (calendars do the same), so it stays visible and draggable.
 */
export function clockSpan(t: Timed): { a: number; b: number } | null {
  const sp = daySpan(t);
  if (!sp) return null;
  const st = t.startDate && t.startTime ? toMinutes(t.startTime) : null;
  const dt = t.dueDate && t.dueTime ? toMinutes(t.dueTime) : null;
  let a = at(sp.s, st ?? 0);
  let b = at(sp.e, dt ?? DAY_MINUTES);
  if (sp.s === sp.e) {
    if (st !== null && dt === null) b = Math.min(at(sp.e, DAY_MINUTES), a + 60);
    if (st === null && dt !== null) a = Math.max(at(sp.s, 0), b - 60);
  }
  if (b - a < 15) b = a + 15;
  return { a, b };
}

/** Whole-day move or resize (day scale, and untimed edges in hour scale). Times stay as they are. */
export function nextByDays(t: Task, mode: DragMode, delta: number): TimedSpan {
  const sp = daySpan(t)!;
  if (mode === 'move') {
    return {
      startDate: t.startDate ? addDays(t.startDate, delta) : null,
      dueDate: t.dueDate ? addDays(t.dueDate, delta) : null,
    };
  }
  if (mode === 'end') {
    const e = addDays(sp.e, delta);
    const end = e < sp.s ? sp.s : e;
    return { startDate: t.startDate ?? (t.dueDate ? sp.s : null), dueDate: end };
  }
  const st = addDays(sp.s, delta);
  const start = st > sp.e ? sp.e : st;
  return { startDate: start, dueDate: t.dueDate ?? sp.e };
}

/**
 * Move or resize by minutes (hour scale). Timed ends move by the minute; an untimed end keeps having
 * no time and follows along by however many days the timed end crossed. A task without any time,
 * or an untimed edge being resized, moves by whole days.
 */
export function nextByMinutes(t: Task, mode: DragMode, minutes: number, snap: number): TimedSpan {
  const st = t.startDate && t.startTime ? at(t.startDate, toMinutes(t.startTime)) : null;
  const dt = t.dueDate && t.dueTime ? at(t.dueDate, toMinutes(t.dueTime)) : null;
  const days = Math.round(minutes / DAY_MINUTES);

  if (mode === 'move') {
    if (st === null && dt === null) return nextByDays(t, 'move', days);
    const anchor = (st ?? dt)!;
    const dayShift = Math.floor((anchor + minutes) / DAY_MINUTES) - Math.floor(anchor / DAY_MINUTES);
    const out: TimedSpan = { startDate: t.startDate, dueDate: t.dueDate };
    if (st !== null) {
      const n = split(st + minutes);
      out.startDate = n.date;
      out.startTime = n.time;
    } else if (t.startDate) out.startDate = addDays(t.startDate, dayShift);
    if (dt !== null) {
      const n = split(dt + minutes);
      out.dueDate = n.date;
      out.dueTime = n.time;
    } else if (t.dueDate) out.dueDate = addDays(t.dueDate, dayShift);
    return out;
  }

  // A resized end may not cross the other end (an untimed one counts as the edge of its day).
  if (mode === 'end') {
    if (dt === null) return nextByDays(t, 'end', days);
    const floor = t.startDate ? (st ?? at(t.startDate, 0)) + snap : -Infinity;
    const n = split(Math.max(floor, dt + minutes));
    return { startDate: t.startDate, dueDate: n.date, dueTime: n.time };
  }
  if (st === null) return nextByDays(t, 'start', days);
  const ceil = t.dueDate ? (dt ?? at(t.dueDate, DAY_MINUTES)) - snap : Infinity;
  const n = split(Math.min(ceil, st + minutes));
  return { startDate: n.date, startTime: n.time, dueDate: t.dueDate };
}

/** The task as it would read after `next` (an undefined time keeps the old one; no date, no time). */
export function applySpan(t: Task, next: TimedSpan): Timed {
  return {
    startDate: next.startDate,
    dueDate: next.dueDate,
    startTime: next.startDate ? (next.startTime !== undefined ? next.startTime : t.startTime) : null,
    dueTime: next.dueDate ? (next.dueTime !== undefined ? next.dueTime : t.dueTime) : null,
  };
}
