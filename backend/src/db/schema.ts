import type { Dependency, HomeLayout, Task, WebhookPayload, WorkHours } from '@obelisk/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
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
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

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
  /** The user's own key for their System One service (TypeSafe Jev by default), sealed with AES-256-GCM (common/secret.ts). */
  jevKey: text('jev_key'),
  /** That service's base URL or endpoint; null = TypeSafe. */
  jevBaseUrl: text('jev_base_url'),
  /** Model id as that service names it; null = JEV_MODEL. */
  jevModel: text('jev_model'),
  /** Last characters of the key, shown in settings. */
  jevKeyHint: text('jev_key_hint'),
  /** Apply high-confidence Jev judgments without asking. */
  jevAutoApply: boolean('jev_auto_apply').notNull().default(false),
  /** Home dashboard arrangement (core HomeLayout); null = default layout. */
  homeLayout: jsonb('home_layout').$type<HomeLayout>(),
  /** Work days, hours, breaks, focus share (core WorkHours); null = the defaults. */
  workHours: jsonb('work_hours').$type<Partial<WorkHours>>(),
  /** Profile photo (avatars row); null = the initial is shown. */
  avatarId: uuid('avatar_id').references((): AnyPgColumn => avatars.id, { onDelete: 'set null' }),
  /** Runs this server: 서버 관리 (users, sign-up, settings). Never sees what people wrote. */
  admin: boolean('admin').notNull().default(false),
  /** The current address was confirmed by a link mailed to it. */
  emailVerifiedAt: ts('email_verified_at'),
  /** Signed up while the server required a confirmed address: kept out of the app until confirmed. */
  mustVerifyEmail: boolean('must_verify_email').notNull().default(false),
  /** Applied while sign-up needed an operator's approval; null once approved. */
  pendingApprovalAt: ts('pending_approval_at'),
  /** Suspended by an operator: can't sign in, every credential was ended. */
  suspendedAt: ts('suspended_at'),
  /** Last request with any credential, written at most every few minutes. */
  lastSeenAt: ts('last_seen_at'),
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

/** One-time links mailed by "비밀번호 찾기". Only the hash is stored; a link works once, for an hour. */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: text('id').primaryKey(), // sha256 of the token in the link
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('password_resets_user_idx').on(t.userId)],
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
  /** Organization photo (avatars row); null = the initial is shown. Personal spaces keep the Obelisk mark. */
  avatarId: uuid('avatar_id').references((): AnyPgColumn => avatars.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Profile photos of people and organizations: a small square image the browser already cut and
 * shrank (256 px WebP or PNG). Each upload is a new row with a new id, so its URL can be cached
 * forever; the owner's previous row is deleted. Rows go with their owner.
 */
export const avatars = pgTable(
  'avatars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references((): AnyPgColumn => workspaces.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    data: bytea('data').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('avatars_user_idx').on(t.userId),
    index('avatars_workspace_idx').on(t.workspaceId),
    check('avatars_one_owner', sql`num_nonnulls(${t.userId}, ${t.workspaceId}) = 1`),
  ],
);

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
    /** "HH:MM" wall-clock time on the start/due date, in the user's time zone; null = the whole day. */
    startTime: text('start_time'),
    dueTime: text('due_time'),
    fixed: boolean('fixed').notNull().default(false),
    /** Minutes it is expected to take; null = not estimated. */
    estimateMinutes: integer('estimate_minutes'),
    /** Sum of the finished time entries' minutes (kept in step by TimeService). */
    actualMinutes: integer('actual_minutes').notNull().default(0),
    /** The first due date it ever had: postponing doesn't move it, so finish-date odds can learn how dates slip. */
    firstDueDate: date('first_due_date', { mode: 'string' }),
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
    // A time is "HH:MM" and only exists with its date.
    check('tasks_start_time_check', sql`${t.startTime} is null or (${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.startDate} is not null)`),
    check('tasks_estimate_check', sql`${t.estimateMinutes} is null or ${t.estimateMinutes} between 1 and 1440`),
    check('tasks_due_time_check', sql`${t.dueTime} is null or (${t.dueTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.dueDate} is not null)`),
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
 * 휴지통: deleted tasks wait here for config.trashDays, then the hourly sweep removes them.
 * The row leaves `tasks` (so no reader has to filter it out) and is kept as a snapshot with the
 * dependency links it had, so a restore puts back the same id, #number and links.
 * The user and project columns mirror the snapshot so deletions elsewhere null them, like on `tasks`.
 */
export const taskTrash = pgTable(
  'task_trash',
  {
    /** The task's own id. */
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: ts('deleted_at').notNull().defaultNow(),
    /** The task as it was (core Task: dates as strings). */
    task: jsonb('task').$type<Task>().notNull(),
    /** Links touching the task at delete time (both directions). */
    dependencies: jsonb('dependencies').$type<Dependency[]>().notNull().default([]),
  },
  (t) => [index('task_trash_workspace_idx').on(t.workspaceId, t.deletedAt)],
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
    via: text('via', { enum: ['session', 'api_token', 'oauth', 'webhook', 'system'] }).notNull(),
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

// ───────────────────────────── time tracking and day plans

/**
 * Time spent on a task. `auto` runs while the task is in progress, `timer` was started/stopped by
 * hand, `manual` was typed in. One entry at most runs per user (ended_at null).
 */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** null: the person left (deleted account) or hasn't joined this server yet; their time stays on the task. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    source: text('source', { enum: ['auto', 'timer', 'manual'] }).notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    /** Counted minutes once it stops (auto time beyond a few hours counts working hours only). */
    minutes: integer('minutes'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('time_entries_task_idx').on(t.taskId),
    index('time_entries_user_idx').on(t.userId, t.startedAt),
    uniqueIndex('time_entries_one_running_idx').on(t.userId).where(sql`${t.endedAt} is null`),
    check('time_entries_minutes_check', sql`${t.minutes} is null or ${t.minutes} >= 0`),
  ],
);

/** A user's own plan for a day: time held for a task. Nobody else sees it. */
export const timeBlocks = pgTable(
  'time_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    /** "HH:MM" in the user's time zone. */
    start: text('start_time').notNull(),
    end: text('end_time').notNull(),
    /** Placed or moved by hand: re-planning works around it. */
    locked: boolean('locked').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('time_blocks_user_date_idx').on(t.userId, t.date),
    index('time_blocks_task_idx').on(t.taskId),
    check('time_blocks_span_check', sql`${t.start} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.end} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.start} < ${t.end}`),
  ],
);

// ───────────────────────────── webhooks

export const WEBHOOK_FORMATS = ['json', 'slack', 'discord'] as const;
export const DELIVERY_STATUSES = ['pending', 'success', 'failed'] as const;

/** Outgoing: activity events and schedule alerts POSTed to a URL (Slack, Discord or any JSON receiver). */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    format: text('format', { enum: WEBHOOK_FORMATS }).notNull().default('json'),
    /** Subscribed event keys (core WEBHOOK_EVENT_KEYS). */
    events: jsonb('events').$type<string[]>().notNull(),
    /** Only these projects' events; null = every project. */
    projectIds: jsonb('project_ids').$type<string[] | null>(),
    /** Local hour schedule alerts start going out, in `timezone`. */
    alertHour: smallint('alert_hour').notNull().default(9),
    /** Minutes before a task's start/due time that its reminder goes out. */
    remindMinutes: smallint('remind_minutes').notNull().default(30),
    timezone: text('timezone').notNull().default('Asia/Seoul'),
    /** HMAC signing secret, sealed (common/secret.ts) with "webhook-secret:<id>" as context. */
    secret: text('secret').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Set when the server turns a webhook off after repeated failures. */
    disabledReason: text('disabled_reason'),
    /** Consecutive deliveries that failed for good; reset by a success. */
    failureCount: integer('failure_count').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('webhooks_workspace_idx').on(t.workspaceId)],
);

/** Outbox + history: queued in the same transaction as the change, sent and retried by a worker. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    /** Schedule alerts: "<event>:<task id>:<date>", so each goes out once a day. */
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').$type<WebhookPayload>().notNull(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(6),
    /** When the worker may pick it up next (also its lease while a send is in flight). */
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lastAttemptAt: ts('last_attempt_at'),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
    uniqueIndex('webhook_deliveries_dedupe_idx').on(t.webhookId, t.dedupeKey),
  ],
);

/** Incoming: a secret URL that creates (and optionally changes) tasks as the person who made it. */
export const incomingWebhooks = pgTable(
  'incoming_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The hook acts as this person, with their current permissions. */
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    hint: text('hint').notNull(),
    /** New tasks go here (null = inbox); when set, it is also the only project the hook may change. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    allowUpdates: boolean('allow_updates').notNull().default(true),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    lastError: text('last_error'),
    lastErrorAt: ts('last_error_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('incoming_webhooks_workspace_idx').on(t.workspaceId)],
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

// ───────────────────────────── moving between servers

/** One-time 이전 링크 codes: another server pulls a workspace with it, once, within 30 minutes. */
export const migrationCodes = pgTable(
  'migration_codes',
  {
    id: text('id').primaryKey(), // sha256 of the omg_ code
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('migration_codes_user_idx').on(t.userId)],
);

/** Bundles imported here, so the same export isn't imported twice by accident. */
export const migrationImports = pgTable(
  'migration_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    exportId: uuid('export_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Where it landed. */
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceUrl: text('source_url').notNull(),
    kind: text('kind', { enum: ['personal', 'org'] }).notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('migration_imports_user_export_idx').on(t.userId, t.exportId)],
);

/** What a reserved person gets once they join: the rows the import left empty for them. */
export interface ReservationClaims {
  projects: { projectId: string; level: AccessLevel }[];
  teams: string[];
  assigned: string[];
  created: string[];
  projectsCreated: string[];
  activity: string[];
  webhooks: string[];
  /** Had left the organization on the source: only authorship waits here, and joining makes them a member again. */
  former?: boolean;
}

/**
 * A member of an imported organization who hasn't joined here. They join only through a claim link
 * (obr_…) an admin hands them. An account with the same email is noted in matched_user_id and gets
 * nothing from it (sign-up doesn't prove the address).
 */
export const memberReservations = pgTable(
  'member_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Lowercase. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: WORKSPACE_ROLES }).notNull().default('member'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    claims: jsonb('claims').$type<ReservationClaims>().notNull(),
    /** sha256 of the current claim link's token; null until an admin makes one. */
    tokenHash: text('token_hash').unique(),
    tokenHint: text('token_hint'),
    /** An account with this email exists here. Informational only: it still needs the claim link. */
    matchedUserId: uuid('matched_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('member_reservations_workspace_email_idx').on(t.workspaceId, t.email)],
);

// ───────────────────────────── running the server (서버 관리)

/**
 * The server's own settings, one row (id = 1). A null signup_mode means SIGNUP_MODE from the
 * environment applies; everything else starts at its default and is changed in 서버 관리.
 */
export const serverSettings = pgTable(
  'server_settings',
  {
    id: smallint('id').primaryKey().default(1),
    signupMode: text('signup_mode', { enum: ['open', 'approval', 'invite', 'closed'] }),
    requireEmailVerification: boolean('require_email_verification').notNull().default(false),
    allowedEmailDomains: jsonb('allowed_email_domains').$type<string[]>().notNull().default([]),
    orgCreation: text('org_creation', { enum: ['everyone', 'admins'] }).notNull().default('everyone'),
    updateCheck: boolean('update_check').notNull().default(true),
    announcementText: text('announcement_text'),
    announcementAt: ts('announcement_at'),
    /** sha256 of the one-time link the server logs at start while it has no operator. */
    adminClaimHash: text('admin_claim_hash'),
    adminClaimExpiresAt: ts('admin_claim_expires_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('server_settings_single_row', sql`${t.id} = 1`)],
);

/** Links that let one person (or a few) sign up when sign-up is invite-only, without joining an organization. */
export const serverInvites = pgTable('server_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  hint: text('hint').notNull(),
  note: text('note').notNull().default(''),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * What operators did (suspend, delete, approve, settings…). The target is a snapshot so the line
 * survives the account; ids are kept without foreign keys for the same reason.
 */
export const adminLog = pgTable(
  'admin_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    targetId: uuid('target_id'),
    targetLabel: text('target_label').notNull().default(''),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('admin_log_created_idx').on(t.createdAt)],
);

/**
 * One-time links mailed to confirm an address: the account's own (verify) or a new one (change).
 * Only the hash is kept; a link works once, for a day.
 */
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: text('id').primaryKey(), // sha256 of the token in the link
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['verify', 'change'] }).notNull(),
    /** The address the link was mailed to (lowercase). */
    email: text('email').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('email_tokens_user_idx').on(t.userId)],
);

export type UserRow = typeof users.$inferSelect;
export type ServerSettingsRow = typeof serverSettings.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskTrashRow = typeof taskTrash.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type AvatarRow = typeof avatars.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type IncomingWebhookRow = typeof incomingWebhooks.$inferSelect;
export type MemberReservationRow = typeof memberReservations.$inferSelect;
export type TimeEntryRow = typeof timeEntries.$inferSelect;
export type TimeBlockRow = typeof timeBlocks.$inferSelect;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type MemberAccess = (typeof MEMBER_ACCESS)[number];

export const now = sql`now()`;
