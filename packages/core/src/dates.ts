/**
 * Calendar-date helpers. Obelisk stores plan dates as plain ISO dates
 * ("YYYY-MM-DD") with no time or zone, so all arithmetic happens on
 * "day numbers" (days since the Unix epoch, UTC) to stay DST-proof.
 */

export type ISODate = string;

const DAY_MS = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function toDay(date: ISODate): number {
  const m = ISO_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

export function fromDay(day: number): ISODate {
  const dt = new Date(day * DAY_MS);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromDay(toDay(date) + days);
}

/** a - b in days */
export function diffDays(a: ISODate, b: ISODate): number {
  return toDay(a) - toDay(b);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: ISODate): number {
  return new Date(toDay(date) * DAY_MS).getUTCDay();
}

export function todayIn(timeZone = 'UTC', now: Date = new Date()): ISODate {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return fromDay(Math.floor(now.getTime() / DAY_MS));
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Monday-based start of week */
export function startOfWeek(date: ISODate): ISODate {
  const wd = weekday(date);
  const offset = wd === 0 ? -6 : 1 - wd;
  return addDays(date, offset);
}

export function endOfMonth(date: ISODate): ISODate {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0));
  return fromDay(Math.round(last.getTime() / DAY_MS));
}

export function minDate(a: ISODate | null, b: ISODate | null): ISODate | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function maxDate(a: ISODate | null, b: ISODate | null): ISODate | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** "오늘", "내일", "어제", "금요일", "11월 20일 (목)", "2027년 1월 3일 (일)" */
export function formatRelativeKo(date: ISODate, today: ISODate): string {
  const diff = diffDays(date, today);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === 2) return '모레';
  if (diff === -1) return '어제';
  const wd = WEEKDAYS_KO[weekday(date)];
  if (diff > 2 && diff < 7) return `${wd}요일`;
  const [y, m, d] = date.split('-').map(Number);
  const [ty] = today.split('-').map(Number);
  if (y === ty) return `${m}월 ${d}일 (${wd})`;
  return `${y}년 ${m}월 ${d}일 (${wd})`;
}

export function formatShortKo(date: ISODate): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}/${d} (${WEEKDAYS_KO[weekday(date)]})`;
}

export function formatDaysKo(days: number): string {
  const abs = Math.abs(days);
  if (abs >= 7 && abs % 7 === 0) return `${abs / 7}주`;
  return `${abs}일`;
}

// ───────────────────────────── times of day

/**
 * A wall-clock time "HH:MM" (24h) that refines a plan date. Like the dates, it has no zone of its
 * own: it is read in the user's time zone. A date without a time means "some time that day".
 */
export type ISOTime = string;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const DAY_MINUTES = 1440;

export function isISOTime(value: unknown): value is ISOTime {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** "15:30" → 930 */
export function toMinutes(time: ISOTime): number {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid time: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 930 → "15:30" (clamped to the day) */
export function fromMinutes(minutes: number): ISOTime {
  const m = Math.min(DAY_MINUTES - 1, Math.max(0, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Where a wall clock in `timeZone` stands at `now`: its date and minutes past midnight. */
export interface Clock {
  date: ISODate;
  minutes: number;
}

export function nowIn(timeZone = 'UTC', now: Date = new Date()): Clock {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
  } catch {
    const ms = now.getTime();
    return { date: fromDay(Math.floor(ms / DAY_MS)), minutes: Math.floor((ms % DAY_MS) / 60_000) };
  }
}

/** Minutes since the epoch on the wall clock: a plain number to compare and subtract. */
export function clockIndex(date: ISODate, minutes: number): number {
  return toDay(date) * DAY_MINUTES + minutes;
}

/** Minutes from `now` until `date time` (negative once it has passed). */
export function minutesUntil(date: ISODate, time: ISOTime, now: Clock): number {
  return clockIndex(date, toMinutes(time)) - clockIndex(now.date, now.minutes);
}

/**
 * Has a due date (and time) passed? Without a time the whole day counts, so it is only past
 * from the next day on; with one, it is past from that minute.
 */
export function isPastDue(dueDate: ISODate, dueTime: ISOTime | null | undefined, now: Clock): boolean {
  if (dueDate !== now.date) return dueDate < now.date;
  return !!dueTime && toMinutes(dueTime) <= now.minutes;
}

/**
 * Sort key for a date and an optional time. A time-less due date counts as the end of its day,
 * a time-less start date as its beginning.
 */
export function dateTimeKey(date: ISODate, time: ISOTime | null | undefined, missing: 'start' | 'end' = 'end'): string {
  return `${date}T${time ?? (missing === 'end' ? '24:00' : '00:00')}`;
}

/** Start must not come after due: by date, and by time when both fall on the same day. */
export function spanInOrder(
  startDate: ISODate | null | undefined,
  startTime: ISOTime | null | undefined,
  dueDate: ISODate | null | undefined,
  dueTime: ISOTime | null | undefined,
): boolean {
  if (!startDate || !dueDate) return true;
  if (startDate !== dueDate) return startDate < dueDate;
  return !startTime || !dueTime || startTime <= dueTime;
}

/** "오전 9:05", "오후 3:00", "오후 12:30" */
export function formatTimeKo(time: ISOTime): string {
  const total = toMinutes(time);
  const h = Math.floor(total / 60);
  const m = String(total % 60).padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h < 12 ? '오전' : '오후'} ${h12}:${m}`;
}

/** "오전 10:00 – 11:30", "오전 11:00 – 오후 1:00" */
export function formatTimeRangeKo(from: ISOTime, to: ISOTime): string {
  const a = formatTimeKo(from);
  const b = formatTimeKo(to);
  return a.slice(0, 2) === b.slice(0, 2) ? `${a} – ${b.slice(3)}` : `${a} – ${b}`;
}

/** "40분", "1시간", "2시간 15분", "3일" */
export function formatDurationKo(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  if (abs < 60) return `${Math.max(1, abs)}분`;
  if (abs < DAY_MINUTES) {
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  }
  return `${Math.floor(abs / DAY_MINUTES)}일`;
}
