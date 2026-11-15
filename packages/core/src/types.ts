import type { ISODate } from './dates';

export type TaskStatus = 'todo' | 'doing' | 'done' | 'canceled';
/** 0 = none, 1 = low, 2 = medium, 3 = high */
export type Priority = 0 | 1 | 2 | 3;

export interface User {
  id: string;
  email: string;
  name: string;
  timezone: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  color: ProjectColor;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  /** Short per-user sequence number, shown as #12. Handy for AI tools. */
  number: number;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: Priority;
  projectId: string | null;
  startDate: ISODate | null;
  dueDate: ISODate | null;
  /** Fixed tasks (meetings, hard deadlines) never move when something upstream slips. */
  fixed: boolean;
  position: number;
  postponedCount: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `taskId` cannot start until `dependsOnId` is finished. */
export interface Dependency {
  taskId: string;
  dependsOnId: string;
}

export interface Bootstrap {
  user: User;
  today: ISODate;
  projects: Project[];
  tasks: Task[];
  dependencies: Dependency[];
}

export const PROJECT_COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink',
] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

export const PRIORITY_LABEL_KO: Record<Priority, string> = {
  0: '없음',
  1: '낮음',
  2: '보통',
  3: '높음',
};

export const PRIORITY_NAME: Record<Priority, 'none' | 'low' | 'medium' | 'high'> = {
  0: 'none',
  1: 'low',
  2: 'medium',
  3: 'high',
};

export const STATUS_LABEL_KO: Record<TaskStatus, string> = {
  todo: '할 일',
  doing: '진행 중',
  done: '완료',
  canceled: '취소',
};

export function isActive(task: { status: TaskStatus }): boolean {
  return task.status === 'todo' || task.status === 'doing';
}
