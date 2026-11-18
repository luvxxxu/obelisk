/**
 * Natural-language quick add, Korean + English.
 *
 *   "디자인 리뷰 내일 #런칭 !높음"        → due tomorrow, project 런칭, high priority
 *   "보고서 다음주 수요일까지 p1"          → due next-week Wednesday, high priority
 *   "워크숍 11/20~11/22 @고정"            → start 11/20, due 11/22, fixed
 *   "Ship beta next friday #launch !2"   → due next Friday, project launch, medium
 *   "치과 내일 오후 3시"                   → due tomorrow 15:00
 *   "회의 금요일 10시~11시 반"              → Friday 10:00 – 11:30
 */
import { addDays, endOfMonth, fromDay, isISODate, startOfWeek, weekday, type ISODate, type ISOTime } from './dates';
import type { Priority } from './types';

export type QuickAddKind = 'date' | 'time' | 'project' | 'priority' | 'fixed';

export interface QuickAddToken {
  kind: QuickAddKind;
  /** Exactly as typed */
  text: string;
  /** Normalised value: ISO date, "HH:MM" (or "HH:MM~HH:MM"), project name, priority digit, "true" */
  value: string;
}

export interface QuickAddResult {
  title: string;
  startDate: ISODate | null;
  startTime: ISOTime | null;
  dueDate: ISODate | null;
  dueTime: ISOTime | null;
  projectName: string | null;
  priority: Priority | null;
  fixed: boolean;
  tokens: QuickAddToken[];
}

const KO_WD: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const EN_WD: Record<string, number> = {
  sunday: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
};
const EN_WD_LOOSE: Record<string, number> = { ...EN_WD, sat: 6, sun: 0 };

const PARTICLE = /(까지|부터|에서|에)$/;

/** Next occurrence strictly after today (1..7 days ahead). */
function nextWeekday(today: ISODate, wd: number): ISODate {
  const diff = (wd - weekday(today) + 7) % 7 || 7;
  return addDays(today, diff);
}

/** Weekday within the Monday-based week that starts at `monday`. */
function weekdayOfWeek(monday: ISODate, wd: number): ISODate {
  return addDays(monday, wd === 0 ? 6 : wd - 1);
}

function addMonths(date: ISODate, months: number): ISODate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = endOfMonth(fromDay(Math.round(target.getTime() / 86_400_000)));
  const lastDay = Number(last.slice(8));
  return `${last.slice(0, 8)}${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

function monthDay(today: ISODate, month: number, day: number): ISODate | null {
  const year = Number(today.slice(0, 4));
  const pad = (n: number) => String(n).padStart(2, '0');
  let candidate = `${year}-${pad(month)}-${pad(day)}`;
  if (!isISODate(candidate)) return null;
  if (candidate < today) candidate = `${year + 1}-${pad(month)}-${pad(day)}`;
  return isISODate(candidate) ? candidate : null;
}

/** Parse one date phrase (already lower-cased, particles stripped). */
export function parseDatePhrase(raw: string, today: ISODate): ISODate | null {
  const s = raw.trim().toLowerCase().replace(PARTICLE, '');
  if (!s) return null;
  let m: RegExpExecArray | null;

  switch (s) {
    case '오늘':
    case 'today':
    case 'tod':
      return today;
    case '내일':
    case 'tomorrow':
    case 'tmr':
    case 'tmrw':
      return addDays(today, 1);
    case '모레':
      return addDays(today, 2);
    case '글피':
      return addDays(today, 3);
    case '주말':
    case '이번주말':
    case '이번 주말':
    case 'weekend':
    case 'this weekend': {
      const wd = weekday(today);
      return wd === 6 || wd === 0 ? today : nextWeekday(today, 6);
    }
    case '다음주':
    case '다음 주':
    case '담주':
    case '차주':
    case 'next week':
      return addDays(startOfWeek(today), 7);
    case '이번주':
    case '이번 주':
    case 'this week': {
      const fri = weekdayOfWeek(startOfWeek(today), 5);
      return fri >= today ? fri : weekdayOfWeek(startOfWeek(today), 0);
    }
    case '월말':
    case '이번달말':
    case '이번 달 말':
    case 'eom':
    case 'end of month':
      return endOfMonth(today);
    case '다음달':
    case '다음 달':
    case 'next month':
      return addMonths(`${today.slice(0, 8)}01`, 1);
  }

  if ((m = /^(월|화|수|목|금|토|일)(요일|욜)$/.exec(s))) return nextWeekday(today, KO_WD[m[1]!]!);
  if ((m = /^(?:다음\s?주|담주|차주)\s?(월|화|수|목|금|토|일)(?:요일|욜)?$/.exec(s)))
    return weekdayOfWeek(addDays(startOfWeek(today), 7), KO_WD[m[1]!]!);
  if ((m = /^이번\s?주\s?(월|화|수|목|금|토|일)(?:요일|욜)?$/.exec(s)))
    return weekdayOfWeek(startOfWeek(today), KO_WD[m[1]!]!);
  if (EN_WD[s] !== undefined) return nextWeekday(today, EN_WD[s]!);
  if ((m = /^next ([a-z]+)$/.exec(s)) && EN_WD_LOOSE[m[1]!] !== undefined)
    return weekdayOfWeek(addDays(startOfWeek(today), 7), EN_WD_LOOSE[m[1]!]!);
  if ((m = /^this ([a-z]+)$/.exec(s)) && EN_WD_LOOSE[m[1]!] !== undefined)
    return weekdayOfWeek(startOfWeek(today), EN_WD_LOOSE[m[1]!]!);

  if ((m = /^(\d{1,3})\s?(일|주|개월|달)\s?(?:후|뒤)$/.exec(s))) {
    const n = Number(m[1]);
    if (m[2] === '일') return addDays(today, n);
    if (m[2] === '주') return addDays(today, n * 7);
    return addMonths(today, n);
  }
  if ((m = /^in (\d{1,3}) (days?|weeks?|months?)$/.exec(s))) {
    const n = Number(m[1]);
    if (m[2]!.startsWith('day')) return addDays(today, n);
    if (m[2]!.startsWith('week')) return addDays(today, n * 7);
    return addMonths(today, n);
  }
  if ((m = /^\+(\d{1,3})([dw]?)$/.exec(s))) return addDays(today, Number(m[1]) * (m[2] === 'w' ? 7 : 1));

  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    const d = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
    return isISODate(d) ? d : null;
  }
  if ((m = /^(\d{1,2})[./](\d{1,2})$/.exec(s))) return monthDay(today, Number(m[1]), Number(m[2]));
  if ((m = /^(\d{1,2})월\s?(\d{1,2})일$/.exec(s))) return monthDay(today, Number(m[1]), Number(m[2]));
  if ((m = /^(\d{1,2})일$/.exec(s))) {
    const day = Number(m[1]);
    if (day < 1 || day > 31) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    let candidate = `${today.slice(0, 8)}${pad(day)}`;
    if (!isISODate(candidate) || candidate < today) {
      const next = addMonths(`${today.slice(0, 8)}01`, 1);
      candidate = `${next.slice(0, 8)}${pad(day)}`;
    }
    return isISODate(candidate) ? candidate : null;
  }
  return null;
}

// ───────────────────────────── times

type Meridiem = 'am' | 'pm' | 'day' | 'night';

const MERIDIEM_WORDS: Record<string, Meridiem> = {
  오전: 'am',
  아침: 'am',
  새벽: 'am',
  am: 'am',
  'a.m.': 'am',
  오후: 'pm',
  저녁: 'pm',
  pm: 'pm',
  'p.m.': 'pm',
  낮: 'day',
  밤: 'night',
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** An hour on a 12- or 24-hour clock plus what was said around it → 0–23. */
function hour24(h: number, meridiem: Meridiem | null): number | null {
  if (h < 0 || h > 24) return null;
  if (h > 12) return meridiem === 'am' || h === 24 ? null : h;
  switch (meridiem) {
    case 'am':
      return h === 12 ? 0 : h;
    case 'pm':
      return h === 12 ? 12 : h + 12;
    case 'day':
      return h <= 6 ? h + 12 : h;
    case 'night':
      return h === 12 ? 24 : h >= 5 ? h + 12 : h;
    default:
      // A bare "3시" is almost always the afternoon; "9시" the morning.
      return h >= 1 && h <= 6 ? h + 12 : h;
  }
}

function clock(h: number | null, m: number): ISOTime | null {
  if (h === null || m < 0 || m > 59) return null;
  // "밤 12시", "자정까지": the end of that day.
  if (h === 24) return m === 0 ? '23:59' : null;
  return `${pad2(h)}:${pad2(m)}`;
}

/**
 * One time phrase: "15:30", "오후 3시", "3시 반", "저녁 7시 30분", "9am", "3:30pm", "정오".
 * Returns null for anything else, so titles like "1:1 미팅" stay titles.
 */
export function parseTimePhrase(raw: string, inherit: Meridiem | null = null): ISOTime | null {
  return parseTime(raw, inherit)?.time ?? null;
}

function parseTime(raw: string, inherit: Meridiem | null): { time: ISOTime; meridiem: Meridiem | null } | null {
  let s = raw.trim().toLowerCase().replace(PARTICLE, '').replace(/^at\s+/, '').trim();
  if (!s) return null;
  if (s === '정오' || s === 'noon') return { time: '12:00', meridiem: 'pm' };
  if (s === '자정' || s === 'midnight') return { time: '23:59', meridiem: 'night' };

  let meridiem: Meridiem | null = null;
  const lead = /^(오전|오후|아침|저녁|새벽|낮|밤)\s?/.exec(s);
  if (lead) {
    meridiem = MERIDIEM_WORDS[lead[1]!]!;
    s = s.slice(lead[0].length);
  }
  const trail = /\s?(am|pm|a\.m\.|p\.m\.)$/.exec(s);
  if (trail) {
    if (meridiem) return null;
    meridiem = MERIDIEM_WORDS[trail[1]!]!;
    s = s.slice(0, -trail[0].length);
  }
  const said = meridiem;
  meridiem ??= inherit;

  let m: RegExpExecArray | null;
  let out: ISOTime | null = null;
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) {
    const h = Number(m[1]);
    // "15:30" and "09:00" are on a 24-hour clock; a loose "3:30" reads like "3시 30분".
    const literal = !said && (m[1]!.length === 2 && m[1]!.startsWith('0') || h > 12 || h === 0);
    out = clock(literal ? h : hour24(h, meridiem), Number(m[2]));
  } else if ((m = /^(\d{1,2})\s?시(?:\s?(반|(\d{1,2})\s?분))?$/.exec(s))) {
    out = clock(hour24(Number(m[1]), meridiem), m[2] === '반' ? 30 : m[3] ? Number(m[3]) : 0);
  } else if ((m = /^(\d{1,2})$/.exec(s)) && said && trail) {
    out = clock(hour24(Number(m[1]), meridiem), 0);
  } else return null;
  return out ? { time: out, meridiem } : null;
}

/** "10:00~11:30", "오후 2시-4시", "10시~11시 반": both ends, the second inheriting the first's meridiem. */
function parseTimeRange(raw: string): [ISOTime, ISOTime] | null {
  const parts = raw.split(/~|–|(?<=\d|시|반|분|m)-(?=\s?\d|오|저|아|밤|낮|새)/);
  if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) return null;
  const a = parseTime(parts[0]!, null);
  if (!a) return null;
  const b = parseTime(parts[1]!, a.meridiem);
  if (!b) return null;
  return [a.time, b.time];
}

/** A date with an optional time, as typed into a date field: "내일 오후 3시", "11/20 15:30", "금요일". */
export function parseDateTimePhrase(
  raw: string,
  today: ISODate,
  nowMinutes?: number | null,
): { date: ISODate; time: ISOTime | null } | null {
  const q = parseQuickAdd(raw, today, { disabled: ['project', 'priority', 'fixed'], nowMinutes });
  if (q.title || !q.dueDate || q.startDate) return null;
  return { date: q.dueDate, time: q.dueTime };
}

function parsePriority(word: string): Priority | null {
  const w = word.toLowerCase();
  if (w === '!!!') return 3;
  if (w === '!!') return 2;
  let m: RegExpExecArray | null;
  if ((m = /^p([1-3])$/.exec(w))) return (4 - Number(m[1])) as Priority;
  if (!(m = /^!(.+)$/.exec(w))) return null;
  switch (m[1]) {
    case '3':
    case '높음':
    case '긴급':
    case 'high':
    case 'h':
      return 3;
    case '2':
    case '보통':
    case '중간':
    case 'medium':
    case 'med':
    case 'm':
      return 2;
    case '1':
    case '낮음':
    case 'low':
    case 'l':
      return 1;
    case '0':
    case '없음':
    case 'none':
      return 0;
  }
  return null;
}

interface Slot {
  date: ISODate | null;
  time: ISOTime | null;
}

export function parseQuickAdd(
  input: string,
  today: ISODate,
  opts: {
    disabled?: readonly QuickAddKind[];
    /** Minutes past midnight now; a time alone that has already passed today then means tomorrow. */
    nowMinutes?: number | null;
  } = {},
): QuickAddResult {
  const disabled = new Set(opts.disabled ?? []);
  const words = input.trim().split(/\s+/).filter(Boolean);
  const titleWords: string[] = [];
  const tokens: QuickAddToken[] = [];
  /** Up to two points in time (start, due), each a date and/or a time as they were typed. */
  const slots: Slot[] = [];
  const last = () => slots[slots.length - 1];
  const canDate = () => slots.length < 2 || (!!last() && !last()!.date);
  const canTime = () => slots.length < 2 || (!!last() && !last()!.time);
  const addDate = (d: ISODate) => {
    const l = last();
    if (l && !l.date && l.time) l.date = d;
    else slots.push({ date: d, time: null });
  };
  const addTime = (t: ISOTime) => {
    const l = last();
    if (l && l.date && !l.time) l.time = t;
    else slots.push({ date: null, time: t });
  };
  let projectName: string | null = null;
  let priority: Priority | null = null;
  let fixed = false;

  for (let i = 0; i < words.length; ) {
    const w = words[i]!;

    if (!disabled.has('project') && projectName === null && /^#\S+/.test(w)) {
      projectName = w.slice(1).replace(/_/g, ' ');
      tokens.push({ kind: 'project', text: w, value: projectName });
      i++;
      continue;
    }
    if (!disabled.has('priority') && priority === null) {
      const p = parsePriority(w);
      if (p !== null) {
        priority = p;
        tokens.push({ kind: 'priority', text: w, value: String(p) });
        i++;
        continue;
      }
    }
    if (!disabled.has('fixed') && /^@(고정|fixed|fix)$/i.test(w)) {
      fixed = true;
      tokens.push({ kind: 'fixed', text: w, value: 'true' });
      i++;
      continue;
    }

    const dateOn = !disabled.has('date') && canDate();
    const timeOn = !disabled.has('time') && canTime();

    // Range in a single token: "11/20~11/22", "내일~금요일"
    if (dateOn && slots.length === 0 && w.includes('~')) {
      const [a, b] = w.split('~');
      const da = a ? parseDatePhrase(a, today) : null;
      const db = b ? parseDatePhrase(b, today) : null;
      if (da && db) {
        slots.push({ date: da, time: null }, { date: db, time: null });
        tokens.push({ kind: 'date', text: w, value: `${da}~${db}` });
        i++;
        continue;
      }
    }

    let matched = false;
    for (let len = Math.min(3, words.length - i); len >= 1 && !matched; len--) {
      const phrase = words.slice(i, i + len).join(' ');
      if (dateOn) {
        const d = parseDatePhrase(phrase, today);
        if (d) {
          addDate(d);
          tokens.push({ kind: 'date', text: phrase, value: d });
          i += len;
          matched = true;
          break;
        }
      }
      if (timeOn) {
        const t = parseTimePhrase(phrase);
        if (t) {
          addTime(t);
          tokens.push({ kind: 'time', text: phrase, value: t });
          i += len;
          matched = true;
          break;
        }
        // "10시~11시", "오후 2시-4시": a span within one day.
        const range = slots.length === 0 || (slots.length === 1 && !slots[0]!.time) ? parseTimeRange(phrase) : null;
        if (range) {
          addTime(range[0]);
          slots.push({ date: null, time: range[1] });
          tokens.push({ kind: 'time', text: phrase, value: `${range[0]}~${range[1]}` });
          i += len;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;

    titleWords.push(w);
    i++;
  }

  // A time without a date takes the date said next to it; with none at all, the next time it comes round.
  for (const [k, sl] of slots.entries()) {
    sl.date ??= slots[k - 1]?.date ?? slots.find((o) => o.date)?.date ?? null;
  }
  if (slots.length && slots.every((sl) => !sl.date)) {
    const first = slots[0]!.time!;
    const [h, m] = first.split(':').map(Number) as [number, number];
    const passed = opts.nowMinutes != null && h * 60 + m <= opts.nowMinutes;
    for (const sl of slots) sl.date = passed ? addDays(today, 1) : today;
  }

  let start: Slot | null = null;
  let due: Slot | null = null;
  if (slots.length === 1) due = slots[0]!;
  else if (slots.length >= 2) {
    const key = (sl: Slot) => `${sl.date}T${sl.time ?? ''}`;
    const [a, b] = [slots[0]!, slots[1]!];
    [start, due] = key(a) <= key(b) ? [a, b] : [b, a];
  }

  return {
    title: titleWords.join(' ').trim(),
    startDate: start?.date ?? null,
    startTime: start?.date ? (start.time ?? null) : null,
    dueDate: due?.date ?? null,
    dueTime: due?.date ? (due.time ?? null) : null,
    projectName,
    priority,
    fixed,
    tokens,
  };
}

/** Loose project lookup: exact → ignoring spaces → prefix → unique substring. */
export function matchProject<T extends { name: string }>(projects: readonly T[], name: string): T | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const contains = projects.filter((p) => squash(p.name).includes(squash(n)));
  return (
    projects.find((p) => p.name.toLowerCase() === n) ??
    projects.find((p) => squash(p.name) === squash(n)) ??
    projects.find((p) => p.name.toLowerCase().startsWith(n)) ??
    (contains.length === 1 ? contains[0]! : null)
  );
}
