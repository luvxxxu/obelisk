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
