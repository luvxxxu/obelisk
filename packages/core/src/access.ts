/**
 * Permission rules shared by the server (which enforces them) and the browser
 * (which hides what you can't do). The server is the only authority.
 *
 *  - Owners and admins manage every project of their workspace.
 *  - Everyone else gets the best of: the project's member access (what every
 *    member gets), their own grant, and the grants of teams they belong to.
 *  - view: see the project and its tasks. edit: create, change, delete, link
 *    tasks. manage: also rename/archive/delete/move the project and share it.
 *  - In an organization, a task without a project is visible only to the
 *    person who made it and its assignee. In a personal space you see everything.
 */
import type { AccessLevel, MemberAccess, WorkspaceKind, WorkspaceRole } from './types';

export const LEVEL_RANK: Record<AccessLevel | 'none', number> = { none: 0, view: 1, edit: 2, manage: 3 };

type AnyLevel = AccessLevel | MemberAccess | null | undefined;

export function atLeast(level: AnyLevel, min: AccessLevel): boolean {
  return LEVEL_RANK[level ?? 'none'] >= LEVEL_RANK[min];
}

/** The higher of the given levels; null when none of them grants anything. */
export function maxLevel(...levels: AnyLevel[]): AccessLevel | null {
  let best: AccessLevel | null = null;
  for (const l of levels) {
    if (!l || l === 'none') continue;
    if (!best || LEVEL_RANK[l] > LEVEL_RANK[best]) best = l;
  }
  return best;
}

export function isWorkspaceAdmin(role: WorkspaceRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export interface TaskAccessSubject {
  projectId: string | null;
  createdBy: string | null;
  assigneeId: string | null;
}

export interface AccessView {
  userId: string;
  kind: WorkspaceKind;
  /** The caller's level on a project of this workspace, or null when they cannot see it. */
  projectLevel(projectId: string): AccessLevel | null;
}

/** The caller's level on a task, or null when they cannot see it. */
export function taskAccess(task: TaskAccessSubject, a: AccessView): AccessLevel | null {
  if (task.projectId) return a.projectLevel(task.projectId);
  if (a.kind === 'personal') return 'manage';
  if (task.createdBy === a.userId || task.assigneeId === a.userId) return 'edit';
  return null;
}

export function canViewTask(task: TaskAccessSubject, a: AccessView): boolean {
  return taskAccess(task, a) !== null;
}

export function canEditTask(task: TaskAccessSubject, a: AccessView): boolean {
  return atLeast(taskAccess(task, a), 'edit');
}
