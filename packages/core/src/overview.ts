/**
 * 모아보기: the user's own work across every space they belong to, in one list.
 *
 *  - Whose work: everything in the personal space; in an organization only tasks assigned to the user
 *    (the rest of an org's tasks belong to teammates and would drown the list).
 *  - Which dates: overdue, today (in progress and already started included, same as the Today page),
 *    the next OVERVIEW_DAYS days by due date (same bucketing as the Upcoming page), and fixed
 *    commitments within OVERVIEW_FIXED_DAYS.
 *  - Dependencies never cross spaces, so delay forecasts stay per space and are not merged here.
 *
 * The server uses `inOverview` to pick rows; the browser uses the same rules to place them, and to
 * pick live rows for the space it has open.
 */
import { addDays, type ISODate } from './dates';
import type { Project, Task, WorkspaceKind, WorkspaceSummary } from './types';
import { compareTasks, isOverdue, isToday } from './views';

export const OVERVIEW_DAYS = 7;
export const OVERVIEW_FIXED_DAYS = 30;

export interface OverviewTask extends Task {
  /** Whether the user may change it (view-only project tasks can be assigned to them too). */
  editable: boolean;
}

export type OverviewProject = Pick<Project, 'id' | 'workspaceId' | 'name' | 'color'>;

export interface Overview {
  today: ISODate;
  /** Every space the user belongs to, personal first. */
  spaces: WorkspaceSummary[];
  tasks: OverviewTask[];
  /** Projects of the listed tasks (name and colour only). */
  projects: OverviewProject[];
}

type OverviewSubject = Pick<
  Task,
  'status' | 'startDate' | 'dueDate' | 'fixed' | 'assigneeIds' | 'projectId' | 'priority' | 'number' | 'completedAt' | 'position'
>;

const active = (t: Pick<Task, 'status'>) => t.status === 'todo' || t.status === 'doing';

/** Personal space: all of it. Organization: what is assigned to the user. */
export function isMine(t: Pick<Task, 'assigneeIds'>, kind: WorkspaceKind, userId: string): boolean {
  return kind === 'personal' || (!!userId && t.assigneeIds.includes(userId));
}

/** The day a task sits on in the week list: its due date, else its start (as on the Upcoming page). */
export function overviewDay(t: Pick<Task, 'startDate' | 'dueDate'>): ISODate | null {
  return t.dueDate ?? t.startDate;
}

/**
 * When a fixed commitment matters next — a start still ahead, otherwise its last day — or null when it
 * is already over or further away than `horizonDays`.
 */
export function fixedDate(t: Pick<Task, 'startDate' | 'dueDate' | 'fixed'>, today: ISODate, horizonDays = OVERVIEW_FIXED_DAYS): ISODate | null {
  if (!t.fixed) return null;
  const last = t.dueDate ?? t.startDate;
  if (!last || last < today) return null;
  const date = t.startDate && t.startDate >= today ? t.startDate : last;
  return date <= addDays(today, horizonDays) ? date : null;
}

export function inOverview(t: OverviewSubject, kind: WorkspaceKind, userId: string, today: ISODate): boolean {
  if (!active(t) || !isMine(t, kind, userId)) return false;
  if (isToday(t, today)) return true;
  const day = overviewDay(t);
  if (day && day <= addDays(today, OVERVIEW_DAYS)) return true;
  return fixedDate(t, today) !== null;
}

export interface OverviewSections<T> {
  overdue: T[];
  /** Due or started today, or in progress. */
  today: T[];
  /** One entry per day after today, OVERVIEW_DAYS of them (empty days included). */
  week: { date: ISODate; tasks: T[] }[];
  /** Fixed commitments within OVERVIEW_FIXED_DAYS, soonest first (they may also sit in the lists above). */
  fixed: { task: T; date: ISODate }[];
}

/** Place overview tasks into the page's sections. Tasks outside the overview are ignored. */
export function overviewSections<T extends OverviewSubject>(tasks: readonly T[], today: ISODate): OverviewSections<T> {
  const overdue: T[] = [];
  const todays: T[] = [];
  const byDay = new Map<ISODate, T[]>();
  const fixed: { task: T; date: ISODate }[] = [];
  const horizon = addDays(today, OVERVIEW_DAYS);
  for (const t of tasks) {
    if (!active(t)) continue;
    const f = fixedDate(t, today);
    if (f) fixed.push({ task: t, date: f });
    if (isOverdue(t, today)) overdue.push(t);
    else if (isToday(t, today)) todays.push(t);
    else {
      const day = overviewDay(t);
      if (day && day > today && day <= horizon) byDay.set(day, [...(byDay.get(day) ?? []), t]);
    }
  }
  return {
    overdue: overdue.sort(compareTasks),
    today: todays.sort(compareTasks),
    week: Array.from({ length: OVERVIEW_DAYS }, (_, i) => addDays(today, i + 1)).map((date) => ({
      date,
      tasks: (byDay.get(date) ?? []).sort(compareTasks),
    })),
    fixed: fixed.sort((a, b) => a.date.localeCompare(b.date) || compareTasks(a.task, b.task)),
  };
}
