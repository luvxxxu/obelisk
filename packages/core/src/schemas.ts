import { z } from 'zod';
import { isISODate, isValidTimeZone } from './dates';
import { PROJECT_COLORS } from './types';

export const isoDate = z
  .string()
  .refine(isISODate, { message: 'YYYY-MM-DD 형식의 올바른 날짜여야 합니다' })
  .describe('Calendar date, YYYY-MM-DD');

export const taskStatus = z.enum(['todo', 'doing', 'done', 'canceled']);
export const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const projectColor = z.enum(PROJECT_COLORS);
export const uuid = z.uuid();

const title = z.string().trim().min(1, '제목을 입력하세요').max(500);
const notes = z.string().max(20_000);

export const createTaskInput = z
  .object({
    title,
    notes: notes.optional(),
    status: taskStatus.optional(),
    priority: priority.optional(),
    projectId: uuid.nullable().optional(),
    startDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    fixed: z.boolean().optional(),
    blockedBy: z.array(uuid).max(50).optional(),
  })
  .refine((v) => !v.startDate || !v.dueDate || v.startDate <= v.dueDate, {
    message: '시작일은 마감일보다 늦을 수 없습니다',
    path: ['startDate'],
  });
export type CreateTaskInput = z.infer<typeof createTaskInput>;

export const updateTaskInput = z.object({
  title: title.optional(),
  notes: notes.optional(),
  status: taskStatus.optional(),
  priority: priority.optional(),
  projectId: uuid.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  fixed: z.boolean().optional(),
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
        dueDate: isoDate.nullable().optional(),
        fixed: z.boolean().optional(),
        /** keys of tasks in this batch, or ids / #numbers of existing tasks */
        blockedBy: z.array(z.string().min(1)).max(50).optional(),
      }),
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
    .array(z.object({ taskId: uuid, startDate: isoDate.nullable(), dueDate: isoDate.nullable() }))
    .min(1)
    .max(500),
});
export type RescheduleInput = z.infer<typeof rescheduleInput>;

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

export const createProjectInput = z.object({
  name: z.string().trim().min(1, '이름을 입력하세요').max(120),
  color: projectColor.optional(),
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
});
export type SignupInput = z.infer<typeof signupInput>;

export const loginInput = z.object({
  email: z.email().transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(200),
});

export const updateMeInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: timezone.optional(),
});

export const createTokenInput = z.object({
  name: z.string().trim().min(1).max(80),
});
