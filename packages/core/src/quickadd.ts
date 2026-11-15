/**
 * Natural-language quick add, Korean + English.
 *
 *   "디자인 리뷰 내일 #런칭 !높음"        → due tomorrow, project 런칭, high priority
 *   "보고서 다음주 수요일까지 p1"          → due next-week Wednesday, high priority
 *   "워크숍 11/20~11/22 @고정"            → start 11/20, due 11/22, fixed
 *   "Ship beta next friday #launch !2"   → due next Friday, project launch, medium
 */
import { addDays, endOfMonth, fromDay, isISODate, startOfWeek, weekday, type ISODate } from './dates';
import type { Priority } from './types';

export type QuickAddKind = 'date' | 'project' | 'priority' | 'fixed';

export interface QuickAddToken {
  kind: QuickAddKind;
  /** Exactly as typed */
  text: string;
  /** Normalised value: ISO date, project name, priority digit, "true" */
  value: string;
}

export interface QuickAddResult {
  title: string;
  startDate: ISODate | null;
  dueDate: ISODate | null;
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

export function parseQuickAdd(
  input: string,
  today: ISODate,
  opts: { disabled?: readonly QuickAddKind[] } = {},
): QuickAddResult {
  const disabled = new Set(opts.disabled ?? []);
  const words = input.trim().split(/\s+/).filter(Boolean);
  const titleWords: string[] = [];
  const tokens: QuickAddToken[] = [];
  const dates: ISODate[] = [];
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

    if (!disabled.has('date') && dates.length < 2) {
      // Range in a single token: "11/20~11/22", "내일~금요일"
      if (w.includes('~')) {
        const [a, b] = w.split('~');
        const da = a ? parseDatePhrase(a, today) : null;
        const db = b ? parseDatePhrase(b, today) : null;
        if (da && db) {
          dates.push(da, db);
          tokens.push({ kind: 'date', text: w, value: `${da}~${db}` });
          i++;
          continue;
        }
      }
      let matched = false;
      for (let len = Math.min(3, words.length - i); len >= 1; len--) {
        const phrase = words.slice(i, i + len).join(' ');
        const d = parseDatePhrase(phrase, today);
        if (d) {
          dates.push(d);
          tokens.push({ kind: 'date', text: phrase, value: d });
          i += len;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    titleWords.push(w);
    i++;
  }

  let startDate: ISODate | null = null;
  let dueDate: ISODate | null = null;
  if (dates.length === 1) dueDate = dates[0]!;
  else if (dates.length >= 2) {
    const [a, b] = [dates[0]!, dates[1]!];
    startDate = a <= b ? a : b;
    dueDate = a <= b ? b : a;
  }

  return {
    title: titleWords.join(' ').trim(),
    startDate,
    dueDate,
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
