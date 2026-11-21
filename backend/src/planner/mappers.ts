import type { AccessLevel, PlanItem, Priority, Project, ProjectColor, Task } from '@obelisk/core';
import type { ProjectRow, TaskRow } from '../db/schema';

export function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    number: r.number,
    title: r.title,
    notes: r.notes,
    status: r.status,
    priority: r.priority as Priority,
    projectId: r.projectId,
    startDate: r.startDate,
    startTime: r.startDate ? r.startTime : null,
    dueDate: r.dueDate,
    dueTime: r.dueDate ? r.dueTime : null,
    fixed: r.fixed,
    estimateMinutes: r.estimateMinutes ?? null,
    actualMinutes: r.actualMinutes ?? 0,
    position: r.position,
    postponedCount: r.postponedCount,
    assigneeIds: r.assigneeIds ?? [],
    createdBy: r.createdBy,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toProject(r: ProjectRow, access: AccessLevel): Project {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    color: r.color as ProjectColor,
    position: r.position,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    access,
    memberAccess: r.memberAccess,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toPlanItem(t: Task | TaskRow): PlanItem {
  return {
    id: t.id,
    title: t.title,
    number: t.number,
    status: t.status,
    startDate: t.startDate,
    dueDate: t.dueDate,
    startTime: t.startTime,
    dueTime: t.dueTime,
    fixed: t.fixed,
    projectId: t.projectId,
  };
}
