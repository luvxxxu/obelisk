import { diffDays, formatDaysKo, formatRelativeKo, formatShortKo, type ISODate, type Task } from '@obelisk/core';

export type DateTone = 'overdue' | 'today' | 'soon' | 'default' | 'done';

export function dateTone(task: Pick<Task, 'status' | 'dueDate' | 'startDate'>, today: ISODate): DateTone {
  if (task.status === 'done' || task.status === 'canceled') return 'done';
  const d = task.dueDate ?? task.startDate;
  if (!d) return 'default';
  if (task.dueDate && task.dueDate < today) return 'overdue';
  if (d === today || (task.startDate && task.startDate <= today && (!task.dueDate || task.dueDate >= today)))
    return 'today';
  if (diffDays(d, today) <= 2) return 'soon';
  return 'default';
}

/** "오늘", "내일", "11월 20일 (목)", ranges as "11/18 – 11/20". */
export function spanLabel(task: Pick<Task, 'startDate' | 'dueDate'>, today: ISODate): string | null {
  const { startDate: s, dueDate: d } = task;
  if (s && d && s !== d) {
    if (s <= today && d >= today) return `${formatRelativeKo(d, today)}까지`;
    return `${formatShortKo(s)} – ${formatShortKo(d)}`;
  }
  const one = d ?? s;
  return one ? formatRelativeKo(one, today) : null;
}

export function overdueLabel(due: ISODate, today: ISODate): string {
  const n = diffDays(today, due);
  return n === 1 ? '어제 마감' : `${n}일 지남`;
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
