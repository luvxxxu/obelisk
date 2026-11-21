import { z } from 'zod';
import { isISODate, isISOTime, isValidTimeZone, spanInOrder } from './dates';
import { PROJECT_COLORS } from './types';

export const isoDate = z
  .string()
  .refine(isISODate, { message: 'YYYY-MM-DD 형식의 올바른 날짜여야 합니다' })
  .describe('Calendar date, YYYY-MM-DD');

export const isoTime = z
  .string()
  .refine(isISOTime, { message: 'HH:MM(24시간) 형식의 시각이어야 합니다' })
  .describe('Time of day, HH:MM (24h) in the user\'s time zone');

type Span = {
  startDate?: string | null;
  startTime?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
};

/** Times need their date, and start may not come after due. Shared by create and bulk create. */
export function spanIssues(v: Span): { message: string; path: string[] }[] {
  const out: { message: string; path: string[] }[] = [];
  if (v.startTime && !v.startDate) out.push({ message: '시작 시각은 시작일과 함께 정하세요', path: ['startTime'] });
  if (v.dueTime && !v.dueDate) out.push({ message: '마감 시각은 마감일과 함께 정하세요', path: ['dueTime'] });
  if (!out.length && v.startDate && v.dueDate && v.startDate > v.dueDate) {
    out.push({ message: '시작일은 마감일보다 늦을 수 없습니다', path: ['startDate'] });
  } else if (!out.length && !spanInOrder(v.startDate, v.startTime, v.dueDate, v.dueTime)) {
    out.push({ message: '시작 시각은 마감 시각보다 늦을 수 없습니다', path: ['startTime'] });
  }
  return out;
}

const checkSpan = (v: Span, ctx: z.RefinementCtx) => {
  for (const issue of spanIssues(v)) ctx.addIssue({ code: 'custom', ...issue });
};

export const taskStatus = z.enum(['todo', 'doing', 'done', 'canceled']);
export const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const projectColor = z.enum(PROJECT_COLORS);
export const uuid = z.uuid();

const title = z.string().trim().min(1, '제목을 입력하세요').max(500);
/** Minutes a task is expected to take. */
const estimate = z.number().int().min(1, '예상 시간은 1분 이상이어야 해요').max(24 * 60, '예상 시간은 24시간까지 적을 수 있어요');
const notes = z.string().max(20_000);

export const createTaskInput = z
  .object({
    title,
    notes: notes.optional(),
    status: taskStatus.optional(),
    priority: priority.optional(),
    projectId: uuid.nullable().optional(),
    startDate: isoDate.nullable().optional(),
    startTime: isoTime.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    dueTime: isoTime.nullable().optional(),
    fixed: z.boolean().optional(),
    estimateMinutes: estimate.nullable().optional(),
    assigneeId: uuid.nullable().optional(),
    blockedBy: z.array(uuid).max(50).optional(),
  })
  .superRefine(checkSpan);
export type CreateTaskInput = z.infer<typeof createTaskInput>;

export const updateTaskInput = z.object({
  title: title.optional(),
  notes: notes.optional(),
  status: taskStatus.optional(),
  priority: priority.optional(),
  projectId: uuid.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  /** Clearing a date clears its time too. */
  startTime: isoTime.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  dueTime: isoTime.nullable().optional(),
  fixed: z.boolean().optional(),
  estimateMinutes: estimate.nullable().optional(),
  assigneeId: uuid.nullable().optional(),
  position: z.number().finite().optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;

export const bulkCreateTasksInput = z.object({
  projectId: uuid.nullable().optional(),
  tasks: z
    .array(
      z.object({
        key: z.string().min(1).max(64).optional(),
        title,
        notes: notes.optional(),
        priority: priority.optional(),
        projectId: uuid.nullable().optional(),
        startDate: isoDate.nullable().optional(),
        startTime: isoTime.nullable().optional(),
        dueDate: isoDate.nullable().optional(),
        dueTime: isoTime.nullable().optional(),
        fixed: z.boolean().optional(),
        estimateMinutes: estimate.nullable().optional(),
        assigneeId: uuid.nullable().optional(),
        /** keys of tasks in this batch, or ids / #numbers of existing tasks */
        blockedBy: z.array(z.string().min(1)).max(50).optional(),
      }).superRefine(checkSpan),
    )
    .min(1)
    .max(100),
});
export type BulkCreateTasksInput = z.infer<typeof bulkCreateTasksInput>;

export const dependencyInput = z.object({ dependsOnId: uuid });

/** Apply a precomputed set of date changes atomically (e.g. a cascade previewed in the browser). */
export const rescheduleInput = z.object({
  rootId: uuid.optional(),
  changes: z
    .array(
      z.object({
        taskId: uuid,
        startDate: isoDate.nullable(),
        dueDate: isoDate.nullable(),
        /** Omitted = keep the task's time (cleared with its date). */
        startTime: isoTime.nullable().optional(),
        dueTime: isoTime.nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type RescheduleInput = z.infer<typeof rescheduleInput>;

/** Move tasks on a board: new manual positions, optionally with a new status (one atomic write). */
export const reorderTasksInput = z.object({
  changes: z
    .array(z.object({ taskId: uuid, position: z.number().finite(), status: taskStatus.optional() }))
    .min(1)
    .max(500),
});
export type ReorderTasksInput = z.infer<typeof reorderTasksInput>;

export const delayInput = z
  .object({
    taskId: uuid,
    days: z.number().int().min(-365).max(365).optional(),
    toDate: isoDate.optional(),
  })
  .refine((v) => (v.days === undefined) !== (v.toDate === undefined), {
    message: 'days 또는 toDate 중 하나만 지정하세요',
  });
export type DelayInput = z.infer<typeof delayInput>;

export const postponeInput = z
  .object({
    taskId: uuid,
    days: z.number().int().min(-365).max(365).optional(),
    toDate: isoDate.optional(),
    cascade: z.boolean().default(true),
  })
  .refine((v) => (v.days === undefined) !== (v.toDate === undefined), {
    message: 'days 또는 toDate 중 하나만 지정하세요',
  });
export type PostponeInput = z.infer<typeof postponeInput>;

export const accessLevel = z.enum(['view', 'edit', 'manage']);
export const memberAccess = z.enum(['none', 'view', 'edit']);

export const createProjectInput = z.object({
  name: z.string().trim().min(1, '이름을 입력하세요').max(120),
  color: projectColor.optional(),
  memberAccess: memberAccess.optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInput>;

export const updateProjectInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  color: projectColor.optional(),
  position: z.number().finite().optional(),
  archived: z.boolean().optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;

export const timezone = z.string().refine(isValidTimeZone, { message: '알 수 없는 시간대입니다' });

export const signupInput = z.object({
  email: z.email('올바른 이메일을 입력하세요').transform((s) => s.toLowerCase()),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다').max(200),
  name: z.string().trim().min(1, '이름을 입력하세요').max(80),
  timezone: timezone.optional(),
  /** An organization invite lets you sign up even when the server is closed to sign-ups. */
  inviteToken: z.string().min(8).max(200).optional(),
});
export type SignupInput = z.infer<typeof signupInput>;

export const loginInput = z.object({
  email: z.email().transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(200),
});

export const passwordResetRequestInput = z.object({
  email: z.email('올바른 이메일을 입력하세요').transform((s) => s.toLowerCase()),
});

export const passwordResetCheckInput = z.object({
  token: z.string().min(8).max(200),
});

export const passwordResetInput = z.object({
  token: z.string().min(8).max(200),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다').max(200),
});

export const deleteAccountInput = z.object({
  password: z.string().min(1, '비밀번호를 입력하세요').max(200),
});

const widgetId = z.string().regex(/^[a-z][a-zA-Z0-9-]{0,39}$/);
const widgetIds = z.array(widgetId).max(40);

export const homeLayoutInput = z.object({
  v: z.literal(1),
  desktop: z.object({
    items: z
      .array(
        z.object({
          id: widgetId,
          x: z.number().int().min(0).max(11),
          y: z.number().int().min(0).max(1000),
          w: z.number().int().min(1).max(12),
          h: z.number().int().min(1).max(60),
          fixed: z.boolean().optional(),
        }),
      )
      .max(40),
    hidden: widgetIds,
  }),
  mobile: z.object({ order: widgetIds, hidden: widgetIds }),
});

export const updateMeInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: timezone.optional(),
  defaultWorkspaceId: uuid.optional(),
  /** null resets the home dashboard to its default layout. */
  homeLayout: homeLayoutInput.nullable().optional(),
});

export const createTokenInput = z.object({
  name: z.string().trim().min(1).max(80),
});

// ───────────────────────────── workspaces

const workspaceName = z.string().trim().min(1, '이름을 입력하세요').max(80);

export const createWorkspaceInput = z.object({ name: workspaceName });

export const updateWorkspaceInput = z.object({
  name: workspaceName.optional(),
  membersCanCreateProjects: z.boolean().optional(),
});

export const updateMemberInput = z.object({ role: z.enum(['owner', 'admin', 'member']) });

export const createInviteInput = z.object({
  role: z.enum(['admin', 'member']).default('member'),
  /** null = never expires */
  expiresInDays: z.number().int().min(1).max(365).nullable().default(7),
  /** null = unlimited */
  maxUses: z.number().int().min(1).max(1000).nullable().default(null),
});
export type CreateInviteInput = z.infer<typeof createInviteInput>;

const teamName = z.string().trim().min(1, '팀 이름을 입력하세요').max(60);
export const createTeamInput = z.object({ name: teamName, memberIds: z.array(uuid).max(500).optional() });
export const updateTeamInput = z.object({ name: teamName.optional(), memberIds: z.array(uuid).max(500).optional() });

/** Partial update of a project's sharing. level null removes that grant. */
export const updateProjectAccessInput = z.object({
  memberAccess: memberAccess.optional(),
  members: z.array(z.object({ userId: uuid, level: accessLevel.nullable() })).max(500).optional(),
  teams: z.array(z.object({ teamId: uuid, level: accessLevel.nullable() })).max(200).optional(),
});
export type UpdateProjectAccessInput = z.infer<typeof updateProjectAccessInput>;

export const moveProjectInput = z.object({ workspaceId: uuid });

export const activityQuery = z.object({
  taskId: uuid.optional(),
  projectId: uuid.optional(),
  actorId: uuid.optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ActivityQuery = z.infer<typeof activityQuery>;
