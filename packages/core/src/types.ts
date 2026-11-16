import type { ISODate } from './dates';

export type TaskStatus = 'todo' | 'doing' | 'done' | 'canceled';
/** 0 = none, 1 = low, 2 = medium, 3 = high */
export type Priority = 0 | 1 | 2 | 3;

export interface User {
  id: string;
  email: string;
  name: string;
  timezone: string;
  /** Where REST and MCP calls land when they don't name a workspace. */
  defaultWorkspaceId: string | null;
  createdAt: string;
}

export interface ProjectGrant {
  level: AccessLevel;
}

/** Who can reach a project, for the share dialog. */
export interface ProjectAccessInfo {
  projectId: string;
  memberAccess: MemberAccess;
  members: { userId: string; level: AccessLevel }[];
  teams: { teamId: string; level: AccessLevel }[];
  /** Every workspace member's resulting access (null = cannot see the project). */
  effective: { userId: string; level: AccessLevel | null; source: 'role' | 'member' | 'team' | 'everyone' | null }[];
}

export interface Invite {
  id: string;
  role: 'admin' | 'member';
  /** Last characters of the link, to tell links apart. */
  hint: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  createdBy: string | null;
  createdAt: string;
}

/** What an invite link shows before you accept it. */
export interface InvitePreview {
  workspace: { id: string; name: string; memberCount: number };
  role: 'admin' | 'member';
  invitedBy: string | null;
  valid: boolean;
  reason?: 'expired' | 'revoked' | 'used_up';
  alreadyMember?: boolean;
}

export type ActivityVia = 'session' | 'api_token' | 'oauth' | 'system';

export interface ActivityEntry {
  id: string;
  action: string;
  actor: { id: string | null; name: string };
  via: ActivityVia;
  client: string | null;
  projectId: string | null;
  taskId: string | null;
  subject: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export type WorkspaceKind = 'personal' | 'org';
export type WorkspaceRole = 'owner' | 'admin' | 'member';
/** view < edit < manage. Owners and admins manage every project in their workspace. */
export type AccessLevel = 'view' | 'edit' | 'manage';
/** What every member of a workspace gets on a project. */
export type MemberAccess = 'none' | 'view' | 'edit';

export interface WorkspaceSummary {
  id: string;
  kind: WorkspaceKind;
  name: string;
  role: WorkspaceRole;
  memberCount: number;
}

export interface Workspace extends WorkspaceSummary {
  membersCanCreateProjects: boolean;
  /** Whether the current user may create projects here. */
  canCreateProjects: boolean;
  createdAt: string;
}

export interface Member {
  /** The member's user id. */
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
  teamIds: string[];
}

export interface Team {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  color: ProjectColor;
  position: number;
  archivedAt: string | null;
  /** The current user's effective access. Projects without access are never sent. */
  access: AccessLevel;
  memberAccess: MemberAccess;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  /** Short per-workspace sequence number, shown as #12. Handy for AI tools. */
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
  assigneeId: string | null;
  createdBy: string | null;
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
  workspace: Workspace;
  workspaces: WorkspaceSummary[];
  members: Member[];
  teams: Team[];
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

export const ROLE_LABEL_KO: Record<WorkspaceRole, string> = {
  owner: '소유자',
  admin: '관리자',
  member: '멤버',
};

export const LEVEL_LABEL_KO: Record<AccessLevel | 'none', string> = {
  none: '권한 없음',
  view: '보기',
  edit: '쓰기',
  manage: '관리',
};

export function isActive(task: { status: TaskStatus }): boolean {
  return task.status === 'todo' || task.status === 'doing';
}
