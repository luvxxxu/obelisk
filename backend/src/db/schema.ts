import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export const ACCESS_LEVELS = ['view', 'edit', 'manage'] as const;
export const MEMBER_ACCESS = ['none', 'view', 'edit'] as const;

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  timezone: text('timezone').notNull().default('Asia/Seoul'),
  /** Where REST and MCP calls land when they don't name a workspace. */
  defaultWorkspaceId: uuid('default_workspace_id').references((): AnyPgColumn => workspaces.id, {
    onDelete: 'set null',
  }),
  /** The user's own TypeSafe (Jev) API key, sealed with AES-256-GCM (common/secret.ts). */
  jevKey: text('jev_key'),
  /** Last characters of the key, shown in settings. */
  jevKeyHint: text('jev_key_hint'),
  /** Apply high-confidence Jev judgments without asking. */
  jevAutoApply: boolean('jev_auto_apply').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256 of the cookie token
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// ───────────────────────────── workspaces (personal space + organizations)

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['personal', 'org'] }).notNull(),
  name: text('name').notNull(),
  /** Set only for a personal space: its one and only member. */
  personalUserId: uuid('personal_user_id')
    .unique()
    .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  /** Task numbers (#12) are unique per workspace. */
  taskSeq: integer('task_seq').notNull().default(0),
  membersCanCreateProjects: boolean('members_can_create_projects').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: WORKSPACE_ROLES }).notNull().default('member'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('workspace_members_user_idx').on(t.userId)],
);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('teams_workspace_name_idx').on(t.workspaceId, t.name)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index('team_members_user_idx').on(t.userId)],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Last characters of the link, so admins can tell links apart. */
    hint: text('hint').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: ts('expires_at'),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('invites_workspace_idx').on(t.workspaceId)],
);

// ───────────────────────────── planner

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** What every workspace member gets on this project. New org projects start private. */
    memberAccess: text('member_access', { enum: MEMBER_ACCESS }).notNull().default('none'),
    name: text('name').notNull(),
    color: text('color').notNull().default('blue'),
    position: doublePrecision('position').notNull().default(0),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('projects_workspace_idx').on(t.workspaceId)],
);

/** A person's own grant on a project (on top of the project's memberAccess). */
export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    level: text('level', { enum: ACCESS_LEVELS }).notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index('project_members_user_idx').on(t.userId)],
);

/** A team's grant on a project: every member of the team gets it. */
export const projectTeams = pgTable(
  'project_teams',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    level: text('level', { enum: ACCESS_LEVELS }).notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.teamId] }), index('project_teams_team_idx').on(t.teamId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    number: integer('number').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    notes: text('notes').notNull().default(''),
    status: text('status', { enum: ['todo', 'doing', 'done', 'canceled'] }).notNull().default('todo'),
    priority: smallint('priority').notNull().default(0),
    startDate: date('start_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    fixed: boolean('fixed').notNull().default(false),
    position: doublePrecision('position').notNull().default(0),
    postponedCount: integer('postponed_count').notNull().default(0),
    completedAt: ts('completed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tasks_workspace_number_idx').on(t.workspaceId, t.number),
    index('tasks_workspace_status_idx').on(t.workspaceId, t.status),
    index('tasks_project_idx').on(t.projectId),
    index('tasks_assignee_idx').on(t.assigneeId),
  ],
);

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnId: uuid('depends_on_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnId] }),
    index('deps_workspace_idx').on(t.workspaceId),
    index('deps_depends_on_idx').on(t.dependsOnId),
  ],
);

/**
 * Who changed what, when, and through which door (web, API token, AI app).
 * Task and project ids are kept without foreign keys so history survives deletion;
 * `subject` snapshots the name at the time.
 */
export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name').notNull(),
    via: text('via', { enum: ['session', 'api_token', 'oauth', 'system'] }).notNull(),
    client: text('client'),
    action: text('action').notNull(),
    projectId: uuid('project_id'),
    taskId: uuid('task_id'),
    subject: text('subject').notNull().default(''),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('activity_workspace_idx').on(t.workspaceId, t.createdAt),
    index('activity_task_idx').on(t.taskId, t.createdAt),
    index('activity_project_idx').on(t.projectId, t.createdAt),
  ],
);

// ───────────────────────────── AI access

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    lastUsedAt: ts('last_used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
);

export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  secretHash: text('secret_hash'),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  authMethod: text('auth_method').notNull().default('none'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  clientName: text('client_name').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope').notNull().default(''),
  resource: text('resource'),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    clientName: text('client_name').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessHash: text('access_hash').notNull().unique(),
    refreshHash: text('refresh_hash').notNull().unique(),
    scope: text('scope').notNull().default(''),
    accessExpiresAt: ts('access_expires_at').notNull(),
    refreshExpiresAt: ts('refresh_expires_at').notNull(),
    lastUsedAt: ts('last_used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('oauth_grants_user_idx').on(t.userId)],
);

export type UserRow = typeof users.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type MemberAccess = (typeof MEMBER_ACCESS)[number];

export const now = sql`now()`;
