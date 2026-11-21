import { parseDatePhrase, type ISODate, type Task } from '@obelisk/core';

/**
 * Tasks as plain lines and back. A copied line reads like something typed into quick add
 * (`견적서 보내기 11/22 15:00 #런칭 !높음`), so pasting it, here or into a chat, says the same thing.
 * Kept free of the store so it can be checked on its own.
 *
 * What a line cannot carry: a start date without a due date (it comes back as the due date), and a
 * same-day start time without a due time; notes, assignee and status stay out on purpose. A title
 * that quick add would itself read words out of (`금요일 회의록`, `PR #123`, `3시 미팅`) still gets
 * its date and project written after it, because the text is mostly pasted into chats; a paste back
 * into Obelisk uses the copied tasks themselves (task-actions `textForCopy`), not this text.
 */

const PRIORITY_TOKEN: Record<number, string | undefined> = { 3: '!높음', 2: '!보통', 1: '!낮음' };

/** The shortest way to write `date` that quick add reads back as the same day: `11/22` within the next year, else `2027-03-01`. */
export function dateToken(date: ISODate, today: ISODate): string {
  const [, m, d] = date.split('-');
  const short = `${Number(m)}/${Number(d)}`;
  return parseDatePhrase(short, today) === date ? short : date;
}

type LineTask = Pick<Task, 'title' | 'priority' | 'startDate' | 'startTime' | 'dueDate' | 'dueTime' | 'fixed'>;

/** One task as a quick-add line. `projectName` null = 인박스 (no token). */
export function taskLine(t: LineTask, today: ISODate, projectName: string | null): string {
  const title = t.title.replace(/\s+/g, ' ').trim();
  const parts = [title];
  const start = t.startDate;
  const due = t.dueDate;
  if (start && due && start !== due) {
    // Two days: a range when neither end has a time, otherwise each end with its own time.
    if (!t.startTime && !t.dueTime) parts.push(`${dateToken(start, today)}~${dateToken(due, today)}`);
    else {
      parts.push(dateToken(start, today));
      if (t.startTime) parts.push(t.startTime);
      parts.push(dateToken(due, today));
      if (t.dueTime) parts.push(t.dueTime);
    }
  } else if (due || start) {
    parts.push(dateToken((due ?? start)!, today));
    if (start === due && t.startTime && t.dueTime) parts.push(`${t.startTime}~${t.dueTime}`);
    else {
      const time = t.dueTime ?? t.startTime;
      if (time) parts.push(time);
    }
  }
  if (projectName) parts.push(`#${projectName.trim().replace(/\s+/g, '_')}`);
  const p = PRIORITY_TOKEN[t.priority];
  if (p) parts.push(p);
  if (t.fixed) parts.push('@고정');
  return parts.join(' ');
}

/** List markers people paste along with the text: `- `, `* `, `• `, `1. `, `2) `, `[ ] `, `- [x] `. */
const MARKER = /^\s*(?:[-*•·]\s+|\d{1,3}[.)]\s+)?(?:\[[ xX]?\]\s*)?/;

/** Pasted text → one candidate task title (with quick-add tokens) per non-empty line. */
export function pasteLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(MARKER, '').trim())
    .filter(Boolean);
}
