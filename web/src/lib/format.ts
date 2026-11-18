import {
  diffDays,
  formatDaysKo,
  formatDurationKo,
  formatRelativeKo,
  formatShortKo,
  formatTimeKo,
  formatTimeRangeKo,
  isPastDue,
  minutesUntil,
  toMinutes,
  type Clock,
  type ISODate,
  type ISOTime,
  type Task,
} from '@obelisk/core';

export type DateTone = 'overdue' | 'today' | 'soon' | 'default' | 'done';

type Timed = Partial<Pick<Task, 'startTime' | 'dueTime'>>;

/** With `now`, a due time that passed today already counts as overdue. */
export function dateTone(task: Pick<Task, 'status' | 'dueDate' | 'startDate'> & Timed, today: ISODate, now?: Clock | null): DateTone {
  if (task.status === 'done' || task.status === 'canceled') return 'done';
  const d = task.dueDate ?? task.startDate;
  if (!d) return 'default';
  if (task.dueDate && (task.dueDate < today || (now && now.date === today && isPastDue(task.dueDate, task.dueTime, now))))
    return 'overdue';
  if (d === today || (task.startDate && task.startDate <= today && (!task.dueDate || task.dueDate >= today)))
    return 'today';
  if (diffDays(d, today) <= 2) return 'soon';
  return 'default';
}

/** "오늘 오후 3:00" (or the date alone without a time). */
export function withTime(label: string, time: ISOTime | null | undefined): string {
  return time ? `${label} ${formatTimeKo(time)}` : label;
}

/**
 * "오늘", "내일 오후 3:00", "금요일 오전 10:00 – 11:30", "11월 20일 (목)",
 * ranges as "11/18 (화) – 11/20 (목) 오후 6:00", running ones as "금요일 오후 6:00까지".
 */
export function spanLabel(task: Pick<Task, 'startDate' | 'dueDate'> & Timed, today: ISODate): string | null {
  const { startDate: s, dueDate: d } = task;
  const st = s ? (task.startTime ?? null) : null;
  const dt = d ? (task.dueTime ?? null) : null;
  if (s && d && s !== d) {
    if (s <= today && d >= today) return `${withTime(formatRelativeKo(d, today), dt)}까지`;
    return `${formatShortKo(s)} – ${withTime(formatShortKo(d), dt)}`;
  }
  if (s && d && st && dt) return `${formatRelativeKo(d, today)} ${formatTimeRangeKo(st, dt)}`;
  if (s && d && st) return `${withTime(formatRelativeKo(d, today), st)}부터`;
  const one = d ?? s;
  return one ? withTime(formatRelativeKo(one, today), d ? dt : st) : null;
}

/** Inside a day group the header names the day: rows say only the time ("오후 3:00", "오전 10:00 – 11:30"). */
export function timeLabel(task: Pick<Task, 'startDate' | 'dueDate'> & Timed): string | null {
  const st = task.startDate ? (task.startTime ?? null) : null;
  const dt = task.dueDate ? (task.dueTime ?? null) : null;
  if (st && dt && task.startDate === task.dueDate) return formatTimeRangeKo(st, dt);
  if (dt) return formatTimeKo(dt);
  if (st && (!task.dueDate || task.startDate === task.dueDate)) return formatTimeKo(st);
  return null;
}

/** "3일 지남", "어제 마감", or for a time that passed today "40분 지남". */
export function overdueLabel(due: ISODate, today: ISODate, dueTime?: ISOTime | null, now?: Clock | null): string {
  const n = diffDays(today, due);
  if (n <= 0 && dueTime && now) return `${formatDurationKo(now.minutes - toMinutes(dueTime))} 지남`;
  if (n <= 0) return '마감 지남';
  return n === 1 ? '어제 마감' : `${n}일 지남`;
}

/** "40분 남음" when a timed due falls within the next hour, else null. */
export function dueSoonLabel(task: Pick<Task, 'status' | 'dueDate'> & Timed, now: Clock): string | null {
  if (task.status === 'done' || task.status === 'canceled' || !task.dueDate || !task.dueTime) return null;
  const left = minutesUntil(task.dueDate, task.dueTime, now);
  return left > 0 && left <= 60 ? `${formatDurationKo(left)} 남음` : null;
}

export function daysLabel(n: number): string {
  return formatDaysKo(n);
}

export function longDateKo(date: ISODate): string {
  const [y, m, d] = date.split('-').map(Number);
  const wd = ['일', '월', '화', '수', '목', '금', '토'][new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()];
  return `${m}월 ${d}일 ${wd}요일`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '사용 기록 없음';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR');
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
