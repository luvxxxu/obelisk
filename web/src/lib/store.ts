'use client';

import {
  canEditTask,
  formatDurationKo,
  type AccessView,
  type AccountGate,
  type Bootstrap,
  type BulkCreateTasksInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type DateChange,
  type Dependency,
  type Member,
  type PlanItem,
  type Project,
  type RestoreResult,
  type ServerInfo,
  type Task,
  type TaskStatus,
  type Team,
  type TrashItem,
  type UpdateProjectInput,
  type UpdateTaskInput,
  type User,
  type Workspace,
  type WorkspaceSummary,
  todayIn,
} from '@obelisk/core';
import { useSyncExternalStore } from 'react';
import { api, ApiError, setWorkspaceHeader } from './api';
import { unpick } from './selection';
import { toast } from './toast';
import { setUi } from './ui-state';
import { clearUndo, notify, pushUndo, type UndoEntry } from './undo';

export interface AppState {
  /** gated: signed in, but the account isn't let in yet (see `gate`). */
  status: 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'gated' | 'error';
  error: string | null;
  gate: AccountGate | null;
  /** Server-wide: the operators' announcement and whether you may create organizations. */
  server: ServerInfo;
  user: User | null;
  today: string;
  /** The open workspace (personal space or an organization) and what the user may do there. */
  workspace: Workspace | null;
  workspaces: WorkspaceSummary[];
  members: Member[];
  teams: Team[];
  projects: Project[];
  tasks: Record<string, Task>;
  deps: Dependency[];
  selectedTaskId: string | null;
}

const NO_SERVER: ServerInfo = { announcement: null, canCreateOrg: true };

let state: AppState = {
  status: 'idle',
  error: null,
  gate: null,
  server: NO_SERVER,
  user: null,
  today: todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone),
  workspace: null,
  workspaces: [],
  members: [],
  teams: [],
  projects: [],
  tasks: {},
  deps: [],
  selectedTaskId: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getState() {
  return state;
}

export function useApp(): AppState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

// ─────────────────────────────── helpers

/**
 * Bumped by every local task write. A background refresh that was already in flight when one
 * happened carries a snapshot from before it — applying that would undo the optimistic change
 * (a card dragged right after the window regained focus would jump back), so it is dropped.
 */
let localWrites = 0;

/** Tasks changed elsewhere (a timer, time entries): take them if they belong to the open space. */
export function applyTasks(list: Task[]) {
  const mine = list.filter((t) => t.workspaceId === state.workspace?.id);
  if (mine.length) upsertTasks(mine);
}

/** Called after a task's status was saved (the time-tracking store follows its clock). */
const statusListeners = new Set<(task: Task, prev: Task) => void>();
export function onStatusSaved(fn: (task: Task, prev: Task) => void) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function upsertTasks(list: Task[]) {
  localWrites++;
  set((s) => {
    const tasks = { ...s.tasks };
    for (const t of list) tasks[t.id] = t;
    return { tasks };
  });
}

// ─────────────────────────────── permissions (the server enforces; this only hides what you can't do)

export const READ_ONLY_MESSAGE = '보기 전용 작업이에요. 프로젝트 관리자에게 쓰기 권한을 요청하세요.';

export function accessView(s: AppState = state): AccessView {
  return {
    userId: s.user?.id ?? '',
    kind: s.workspace?.kind ?? 'personal',
    projectLevel: (id) => s.projects.find((p) => p.id === id)?.access ?? null,
  };
}

export function canEdit(task: Pick<Task, 'projectId' | 'createdBy' | 'assigneeId'>, s: AppState = state): boolean {
  return canEditTask(task, accessView(s));
}

/** Can the user add tasks to this project (null = their inbox)? */
export function canWriteProject(projectId: string | null | undefined, s: AppState = state): boolean {
  if (!projectId) return true;
  const level = s.projects.find((p) => p.id === projectId)?.access;
  return level === 'edit' || level === 'manage';
}

export function memberName(id: string | null | undefined, s: AppState = state): string | null {
  if (!id) return null;
  return s.members.find((m) => m.id === id)?.name ?? null;
}

/** A member's photo, or null (the Avatar then shows their initial). */
export function memberAvatar(id: string | null | undefined, s: AppState = state): string | null {
  if (!id) return null;
  if (id === s.user?.id) return s.user.avatarUrl; // freshest right after changing your own photo
  return s.members.find((m) => m.id === id)?.avatarUrl ?? null;
}

function guard(task: Task | undefined): task is Task {
  if (!task) return false;
  if (canEdit(task)) return true;
  toast.error(READ_ONLY_MESSAGE);
  return false;
}

function fail(e: unknown, fallback = '변경 사항을 저장하지 못했습니다') {
  if (e instanceof ApiError && e.status === 401) {
    set({ status: 'unauthenticated' });
    return;
  }
  toast.error(e instanceof Error ? e.message : fallback);
}

export function planItems(s: AppState = state): PlanItem[] {
  return Object.values(s.tasks).map((t) => ({
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
  }));
}

// ─────────────────────────────── loading

let inflight: Promise<void> | null = null;
/** Bumped on every workspace switch: a response for the previous workspace is thrown away. */
let generation = 0;

const WORKSPACE_KEY = 'obelisk:workspace';

function storedWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function storeWorkspace(id: string | null) {
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {}
  setWorkspaceHeader(id);
}

export function load(silent = false): Promise<void> {
  if (inflight) return inflight;
  if (!silent) set({ status: state.status === 'ready' ? 'ready' : 'loading' });
  if (!state.workspace) setWorkspaceHeader(storedWorkspace());
  const gen = generation;
  inflight = (async () => {
    const writes = localWrites;
    try {
      let b: Bootstrap;
      try {
        b = await api<Bootstrap>('GET', '/api/bootstrap');
      } catch (e) {
        // The remembered workspace is gone (left, removed, deleted): fall back to the default one.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
        storeWorkspace(null);
        b = await api<Bootstrap>('GET', '/api/bootstrap');
        if (state.workspace) toast.show('그 공간에 더 이상 접근할 수 없어 기본 공간을 열었어요');
      }
      if (gen !== generation) return;
      if (state.status === 'ready' && localWrites !== writes && state.workspace?.id === b.workspace.id) return; // stale; the next sync catches up
      storeWorkspace(b.workspace.id);
      // Fell back to another space (the remembered one is gone): its undo entries point at tasks there.
      if (state.workspace && state.workspace.id !== b.workspace.id) clearUndo();
      const tasks: Record<string, Task> = {};
      for (const t of b.tasks) tasks[t.id] = t;
      set((s) => ({
        status: 'ready',
        error: null,
        gate: null,
        server: b.server ?? NO_SERVER,
        user: b.user,
        today: b.today,
        workspace: b.workspace,
        workspaces: b.workspaces,
        members: b.members,
        teams: b.teams,
        projects: b.projects,
        tasks,
        deps: b.dependencies,
        selectedTaskId: s.selectedTaskId && !tasks[s.selectedTaskId] && s.workspace?.id !== b.workspace.id ? null : s.selectedTaskId,
      }));
    } catch (e) {
      if (gen !== generation) return;
      if (e instanceof ApiError && e.status === 401) set({ status: 'unauthenticated' });
      else if (e instanceof ApiError && e.status === 403 && (e.code === 'email_unverified' || e.code === 'pending_approval')) {
        set({ status: 'gated', gate: e.code, error: e.message });
      }
      // A background refresh may share this request with the first load — never leave the splash hanging.
      else if (!silent || state.status !== 'ready') {
        set({ status: 'error', error: e instanceof Error ? e.message : '불러오지 못했습니다' });
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function reset() {
  generation++;
  clearUndo();
  storeWorkspace(null);
  set({
    status: 'unauthenticated',
    gate: null,
    server: NO_SERVER,
    user: null,
    workspace: null,
    workspaces: [],
    members: [],
    teams: [],
    projects: [],
    tasks: {},
    deps: [],
    selectedTaskId: null,
  });
}

// ─────────────────────────────── workspaces

/** Open another workspace in this tab. Its data replaces the current one's. */
export async function switchWorkspace(id: string, opts: { selectTaskId?: string } = {}) {
  if (state.workspace?.id === id && state.status === 'ready') {
    if (opts.selectTaskId) selectTask(opts.selectTaskId);
    return;
  }
  generation++;
  inflight = null;
  // Undo entries act on the tasks of the space being left.
  clearUndo();
  storeWorkspace(id);
  set({ status: 'loading', projects: [], tasks: {}, deps: [], members: [], teams: [], selectedTaskId: opts.selectTaskId ?? null });
  await load();
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary | null> {
  try {
    const { workspace } = await api<{ workspace: WorkspaceSummary }>('POST', '/api/workspaces', { name });
    await switchWorkspace(workspace.id);
    return workspace;
  } catch (e) {
    fail(e, '조직을 만들지 못했습니다');
    return null;
  }
}

/** Follow a /t/:id link: the task may live in another workspace. */
export async function openTaskLink(id: string) {
  try {
    const { task } = await api<{ task: Task }>('GET', `/api/tasks/${id}`);
    await switchWorkspace(task.workspaceId, { selectTaskId: task.id });
  } catch {
    selectTask(id);
  }
}

export function setUser(user: User) {
  set({ user, today: todayIn(user.timezone) });
}

// ─────────────────────────────── selection

export function selectTask(id: string | null) {
  set({ selectedTaskId: id });
}

// ─────────────────────────────── tasks

/**
 * Every task and dependency change takes these. `record` (default true) pushes an undo entry once
 * the server agreed; undo/redo themselves and callers that push one entry for a whole batch pass
 * false. `quiet` skips the change's own toast (undo/redo show theirs).
 */
export interface MutationOpts {
  record?: boolean;
  label?: string;
  quiet?: boolean;
}

/** How undo and redo call back in: no new entry, no second toast. */
const REPLAY: MutationOpts = { record: false, quiet: true };

const depKey = (d: Dependency) => `${d.taskId}:${d.dependsOnId}`;

/**
 * Add links the server reports (created, restored), skipping ones already here. `bothEnds` keeps only
 * links whose two tasks are in the list, as a bootstrap in an organization would.
 */
function mergeDeps(list: Dependency[], { bothEnds = false } = {}) {
  if (!list.length) return;
  localWrites++;
  set((s) => {
    const have = new Set(s.deps.map(depKey));
    const add: Dependency[] = [];
    for (const d of list) {
      if (have.has(depKey(d))) continue;
      if (bothEnds && !(s.tasks[d.taskId] && s.tasks[d.dependsOnId])) continue;
      have.add(depKey(d));
      add.push({ taskId: d.taskId, dependsOnId: d.dependsOnId });
    }
    return add.length ? { deps: [...s.deps, ...add] } : {};
  });
}

/** Take tasks (and every link touching them) out of the list. */
function dropTasks(gone: ReadonlySet<string>) {
  const touches = (d: Dependency) => gone.has(d.taskId) || gone.has(d.dependsOnId);
  if (![...gone].some((id) => state.tasks[id]) && !state.deps.some(touches)) return;
  set((s) => {
    const tasks = { ...s.tasks };
    for (const id of gone) delete tasks[id];
    return {
      tasks,
      deps: s.deps.filter((d) => !touches(d)),
      selectedTaskId: s.selectedTaskId && gone.has(s.selectedTaskId) ? null : s.selectedTaskId,
    };
  });
}

/**
 * Tasks the server changed through a call that is not one of the store's own (Jev's postpone):
 * merged in at once, and a background refresh that started earlier is dropped.
 */
export function applyServerTasks(list: Task[]) {
  if (list.length) upsertTasks(list);
}

/**
 * A change that makes a task done again carries the time it was done, so an undo of 완료 취소 (or a
 * redo of 완료) leaves it on the same day in 완료 기록 instead of stamping now.
 */
function doneAt(t: Pick<Task, 'status' | 'completedAt'> | undefined): { completedAt?: string } {
  return t?.status === 'done' && t.completedAt ? { completedAt: t.completedAt } : {};
}

/** The fields `patch` touches, as they are on `prev`: what puts the task back. A date brings its time along. */
export function inversePatch(prev: Task, patch: UpdateTaskInput): UpdateTaskInput {
  const back: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && k !== 'completedAt') back[k] = prev[k as keyof Task];
  }
  if ('startDate' in back) back.startTime = prev.startTime;
  if ('dueDate' in back) back.dueTime = prev.dueTime;
  if (back.status === 'done') Object.assign(back, doneAt(prev));
  return back as UpdateTaskInput;
}

/** `patch` once more, a completion with the time the server gave it the first time. */
function againPatch(patch: UpdateTaskInput, after: Task | undefined): UpdateTaskInput {
  return patch.status === 'done' ? { ...patch, ...doneAt(after) } : patch;
}

/** The server takes this many changes per request; a larger batch goes in turns. */
const CHUNK = 500;

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/** A patch that leaves the task as it is (a blur without an edit) is not worth an undo step. */
function changesNothing(prev: Task, patch: UpdateTaskInput): boolean {
  return Object.entries(patch).every(([k, v]) => v === undefined || prev[k as keyof Task] === v);
}

/** The short noun an undo toast shows for an edit (`실행 취소함 · 제목 변경`). */
export function patchLabel(prev: Pick<Task, 'status'>, patch: UpdateTaskInput): string {
  const has = (k: keyof UpdateTaskInput) => patch[k] !== undefined;
  if (has('status')) return patch.status === 'done' ? '완료' : prev.status === 'done' ? '완료 취소' : '상태 변경';
  if (has('startDate') || has('dueDate')) return '날짜 변경';
  if (has('startTime') || has('dueTime')) return '시간 변경';
  if (has('title')) return '제목 변경';
  if (has('notes')) return '메모 변경';
  if (has('priority')) return '우선순위 변경';
  if (has('projectId')) return '프로젝트 이동';
  if (has('assigneeId')) return '담당자 변경';
  if (has('fixed')) return '고정 변경';
  if (has('position')) return '순서 변경';
  if (has('estimateMinutes')) return '예상 시간 변경';
  return '작업 수정';
}

/** Undo of a create moves the new tasks to the trash; redo brings the same ones (same #number) back. */
function recordCreated(ids: string[], label: string): UndoEntry {
  return pushUndo({
    label,
    undo: () => deleteTasks(ids, REPLAY),
    redo: async () => !!(await restoreTasks(ids, REPLAY)),
  });
}

export async function createTask(input: CreateTaskInput, opts: MutationOpts = {}): Promise<Task | null> {
  try {
    const { task } = await api<{ task: Task }>('POST', '/api/tasks', input);
    upsertTasks([task]);
    if (input.blockedBy?.length) mergeDeps(input.blockedBy.map((d) => ({ taskId: task.id, dependsOnId: d })));
    if (opts.record !== false) recordCreated([task.id], opts.label ?? '작업 추가');
    return task;
  } catch (e) {
    fail(e, '작업을 만들지 못했습니다');
    return null;
  }
}

/** Several new tasks in one transaction (duplicate, paste). Links between them come back with them. */
export async function createTasks(input: BulkCreateTasksInput, opts: MutationOpts = {}): Promise<Task[] | null> {
  try {
    const res = await api<{ tasks: Task[]; dependencies: Dependency[] }>('POST', '/api/tasks/bulk', input);
    applyServerTasks(res.tasks);
    mergeDeps(res.dependencies);
    if (opts.record !== false && res.tasks.length) {
      recordCreated(
        res.tasks.map((t) => t.id),
        opts.label ?? (res.tasks.length === 1 ? '작업 추가' : `작업 ${res.tasks.length}개 추가`),
      );
    }
    return res.tasks;
  } catch (e) {
    fail(e, '작업을 만들지 못했습니다');
    return null;
  }
}

export async function updateTask(id: string, patch: UpdateTaskInput, opts: MutationOpts = {}): Promise<Task | null> {
  const prev = state.tasks[id];
  if (!guard(prev)) return null;
  const optimistic: Task = { ...prev, ...(patch as Partial<Task>) };
  // A time goes with its date.
  if (!optimistic.startDate) optimistic.startTime = null;
  if (!optimistic.dueDate) optimistic.dueTime = null;
  if (patch.status && patch.status !== prev.status) {
    optimistic.completedAt = patch.status === 'done' ? (patch.completedAt ?? new Date().toISOString()) : null;
  }
  upsertTasks([optimistic]);
  try {
    const { task } = await api<{ task: Task }>('PATCH', `/api/tasks/${id}`, patch);
    upsertTasks([task]);
    if (task.status !== prev.status) statusListeners.forEach((fn) => fn(task, prev));
    if (opts.record !== false && !changesNothing(prev, patch)) {
      const back = inversePatch(prev, patch);
      const again = againPatch(patch, task);
      pushUndo({
        label: opts.label ?? patchLabel(prev, patch),
        undo: async () => !!(await updateTask(id, back, REPLAY)),
        redo: async () => !!(await updateTask(id, again, REPLAY)),
      });
    }
    return task;
  } catch (e) {
    upsertTasks([prev]);
    fail(e);
    return null;
  }
}

export async function toggleDone(id: string, opts: MutationOpts = {}) {
  const t = state.tasks[id];
  if (!guard(t)) return;
  const done = t.status !== 'done';
  const next = done ? 'done' : 'todo';
  const res = await updateTask(id, { status: next }, { record: false });
  if (!res) return;
  const entry =
    opts.record === false
      ? null
      : pushUndo({
          label: opts.label ?? (done ? '완료' : '완료 취소'),
          undo: async () => !!(await updateTask(id, { status: t.status, ...doneAt(t) }, REPLAY)),
          redo: async () => !!(await updateTask(id, { status: next, ...doneAt(res) }, REPLAY)),
        });
  if (done && !opts.quiet) {
    const unblocked = state.deps
      .filter((d) => d.dependsOnId === id)
      .map((d) => state.tasks[d.taskId])
      .filter((x): x is Task => !!x && (x.status === 'todo' || x.status === 'doing'))
      .filter((x) =>
        state.deps
          .filter((d) => d.taskId === x.id)
          .every((d) => {
            const b = state.tasks[d.dependsOnId];
            return !b || b.status === 'done' || b.status === 'canceled';
          }),
      );
    // Time was recorded: say how it compares to the estimate, and offer to fix it.
    const spent = res.actualMinutes
      ? ` · 실제 ${formatDurationKo(res.actualMinutes)}${res.estimateMinutes ? ` (예상 ${formatDurationKo(res.estimateMinutes)})` : ''}`
      : '';
    notify(
      unblocked.length ? `완료 · 이제 ${unblocked.length}개 작업을 시작할 수 있어요${spent}` : `“${t.title}” 완료${spent}`,
      entry,
      res.actualMinutes ? { secondary: { label: '시간 고치기', run: () => setUi({ actual: { taskId: id } }) } } : {},
    );
  }
}

/**
 * Atomically apply a set of date changes (single task or a previewed cascade). Its undo puts every
 * date and time back without a `rootId`, so taking a postpone back does not count as another one.
 * True when every change was saved.
 */
export async function reschedule(changes: DateChange[], rootId?: string, opts: MutationOpts = {}): Promise<boolean> {
  const saved = await rescheduleSaved(changes, rootId, opts);
  return saved.length > 0 && saved.length === changes.length;
}

/**
 * `reschedule`, saying which changes the server saved. More than 500 go in parts of 500, each one
 * all or nothing; the first refusal stops the rest and puts those tasks back. The undo it records
 * covers the parts that went through.
 */
export async function rescheduleSaved(changes: DateChange[], rootId?: string, opts: MutationOpts = {}): Promise<DateChange[]> {
  const prev = changes.map((c) => state.tasks[c.taskId]).filter((t): t is Task => !!t);
  if (!prev.length) return [];
  if (!prev.every((t) => canEdit(t))) {
    const blocked = prev.filter((t) => !canEdit(t));
    toast.error(
      blocked.length === prev.length
        ? READ_ONLY_MESSAGE
        : `함께 밀리는 작업 중 ${blocked.map((t) => `#${t.number}`).join(', ')}은(는) 보기 전용이라 옮길 수 없어요. ‘이 작업만’ 옮겨 보세요.`,
    );
    return [];
  }
  upsertTasks(
    changes
      .map((c) => {
        const t = state.tasks[c.taskId];
        if (!t) return null;
        return {
          ...t,
          startDate: c.startDate,
          dueDate: c.dueDate,
          startTime: c.startDate ? (c.startTime !== undefined ? c.startTime : t.startTime) : null,
          dueTime: c.dueDate ? (c.dueTime !== undefined ? c.dueTime : t.dueTime) : null,
        };
      })
      .filter((t): t is Task => !!t),
  );
  const saved: DateChange[] = [];
  try {
    for (const part of chunks(changes)) {
      const { tasks } = await api<{ tasks: Task[] }>('POST', '/api/tasks/reschedule', { changes: part, rootId });
      upsertTasks(tasks);
      saved.push(...part);
    }
  } catch (e) {
    const done = new Set(saved.map((c) => c.taskId));
    upsertTasks(prev.filter((t) => !done.has(t.id)));
    fail(e);
  }
  if (opts.record !== false && saved.length) {
    const done = new Set(saved.map((c) => c.taskId));
    const before = datesOf(prev.filter((t) => done.has(t.id)));
    pushUndo({
      label: opts.label ?? (before.length === 1 ? '날짜 변경' : `작업 ${before.length}개 날짜 변경`),
      undo: () => reschedule(before, undefined, REPLAY),
      redo: () => reschedule(saved, undefined, REPLAY),
    });
  }
  return saved;
}

/** Dates and times exactly as they are now: what an undo of a date move sends back. */
export function datesOf(list: Task[]): DateChange[] {
  return list.map((t) => ({ taskId: t.id, startDate: t.startDate, dueDate: t.dueDate, startTime: t.startTime, dueTime: t.dueTime }));
}

export interface TaskMove {
  taskId: string;
  position: number;
  status?: TaskStatus;
  /** With status `done`: when it was done (an undo of 완료 취소 keeps the old day); otherwise ignored. */
  completedAt?: string;
}

/**
 * Where `changes` would take the tasks from: their position, and their status when it changes (a
 * done task with the time it was done). Called after a move, it gives where the tasks are now: a redo.
 */
export function movesBack(changes: TaskMove[], s: AppState = state): TaskMove[] {
  return changes.flatMap((c) => {
    const t = s.tasks[c.taskId];
    return t ? [{ taskId: t.id, position: t.position, ...(c.status ? { status: t.status, ...doneAt(t) } : {}) }] : [];
  });
}

function movesLabel(changes: TaskMove[], s: AppState): string {
  const st = changes.find((c) => c.status);
  if (!st) return '순서 변경';
  const n = changes.filter((c) => c.status).length;
  if (st.status === 'done') return n > 1 ? `작업 ${n}개 완료` : '완료';
  if (s.tasks[st.taskId]?.status === 'done') return n > 1 ? `작업 ${n}개 완료 취소` : '완료 취소';
  return '상태 변경';
}

/** Board moves (manual order, and a new status when a card changes column), applied optimistically. True when every change was saved. */
export async function moveTasks(changes: TaskMove[], opts: MutationOpts = {}): Promise<boolean> {
  if (!changes.length) return true;
  return (await moveTasksSaved(changes, opts)).length === changes.length;
}

/**
 * `moveTasks`, saying which changes the server saved. More than 500 go in parts of 500, each one
 * all or nothing; the first refusal stops the rest and puts those tasks back. The undo it records
 * covers the parts that went through.
 */
export async function moveTasksSaved(changes: TaskMove[], opts: MutationOpts = {}): Promise<TaskMove[]> {
  const prev = changes.map((c) => state.tasks[c.taskId]).filter((t): t is Task => !!t);
  if (!prev.length) return [];
  if (!prev.every((t) => canEdit(t))) {
    toast.error(READ_ONLY_MESSAGE);
    return [];
  }
  const before = movesBack(changes);
  const was = state;
  const now = new Date().toISOString();
  upsertTasks(
    changes.flatMap((c) => {
      const t = state.tasks[c.taskId];
      if (!t) return [];
      const next: Task = { ...t, position: c.position };
      if (c.status && c.status !== t.status) {
        next.status = c.status;
        next.completedAt = c.status === 'done' ? (c.completedAt ?? now) : null;
      }
      return [next];
    }),
  );
  const saved: TaskMove[] = [];
  try {
    for (const part of chunks(changes)) {
      const { tasks } = await api<{ tasks: Task[] }>('POST', '/api/tasks/reorder', { changes: part });
      upsertTasks(tasks);
      saved.push(...part);
    }
  } catch (e) {
    const done = new Set(saved.map((c) => c.taskId));
    upsertTasks(prev.filter((t) => !done.has(t.id)));
    fail(e);
  }
  if (opts.record !== false && saved.length) {
    const done = new Set(saved.map((c) => c.taskId));
    const back = before.filter((c) => done.has(c.taskId));
    const again = movesBack(saved);
    pushUndo({ label: opts.label ?? movesLabel(saved, was), undo: () => moveTasks(back, REPLAY), redo: () => moveTasks(again, REPLAY) });
  }
  return saved;
}

/** One task to the trash (it can be restored for 30 days). */
export function deleteTask(id: string, opts: MutationOpts = {}): Promise<boolean> {
  return deleteTasks([id], opts);
}

/**
 * Change several tasks at once (multi-select: project, priority), each with its own patch so an undo
 * can put every task back as it was. Applied optimistically; any that fail come back.
 */
export async function patchTasks(changes: { id: string; patch: UpdateTaskInput }[], opts: MutationOpts = {}): Promise<boolean> {
  const tried = changes.filter((c) => state.tasks[c.id]).length;
  const saved = await patchTasksSaved(changes, opts);
  return tried > 0 && saved.length === tried;
}

/** `patchTasks`, saying which task ids the server saved (the rest came back as they were). */
export async function patchTasksSaved(changes: { id: string; patch: UpdateTaskInput }[], opts: MutationOpts = {}): Promise<string[]> {
  const list = changes.flatMap((c) => (state.tasks[c.id] ? [{ ...c, prev: state.tasks[c.id]! }] : []));
  if (!list.length) return [];
  if (!list.every((c) => canEdit(c.prev))) {
    toast.error(READ_ONLY_MESSAGE);
    return [];
  }
  upsertTasks(list.map((c) => ({ ...c.prev, ...(c.patch as Partial<Task>) })));
  const results = await Promise.allSettled(list.map((c) => api<{ task: Task }>('PATCH', `/api/tasks/${c.id}`, c.patch)));
  const saved: Task[] = [];
  const failed: Task[] = [];
  results.forEach((r, i) => (r.status === 'fulfilled' ? saved.push(r.value.task) : failed.push(list[i]!.prev)));
  upsertTasks([...saved, ...failed]);
  // The ones that did change can be taken back even when others failed.
  const done = list.filter((_, i) => results[i]!.status === 'fulfilled');
  if (opts.record !== false && done.length) {
    const back = done.map((c) => ({ id: c.id, patch: inversePatch(c.prev, c.patch) }));
    const again = done.map((c) => ({ id: c.id, patch: againPatch(c.patch, state.tasks[c.id]) }));
    pushUndo({
      label: opts.label ?? patchLabel(done[0]!.prev, done[0]!.patch),
      undo: () => patchTasks(back, REPLAY),
      redo: () => patchTasks(again, REPLAY),
    });
  }
  if (failed.length) fail((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason);
  return done.map((c) => c.id);
}

/**
 * Move tasks to the trash (휴지통), all or nothing, in one request. They leave the list (and the
 * picks) at once and come back with every link if the server says no; an undo restores the same rows.
 */
export async function deleteTasks(ids: string[], opts: MutationOpts = {}): Promise<boolean> {
  const list = [...new Set(ids)].map((id) => state.tasks[id]).filter((t): t is Task => !!t);
  if (!list.length) return false;
  if (!list.every((t) => canEdit(t))) {
    toast.error(READ_ONLY_MESSAGE);
    return false;
  }
  const gone = new Set(list.map((t) => t.id));
  const goneIds = [...gone];
  const prevDeps = state.deps;
  unpick(goneIds);
  localWrites++;
  dropTasks(gone);
  try {
    await api<{ deleted: string[] }>('POST', '/api/tasks/delete', { ids: goneIds });
  } catch (e) {
    localWrites++;
    set((s) => {
      const tasks = { ...s.tasks };
      for (const t of list) tasks[t.id] = t;
      const have = new Set(s.deps.map(depKey));
      const back = prevDeps.filter((d) => (gone.has(d.taskId) || gone.has(d.dependsOnId)) && !have.has(depKey(d)));
      return { tasks, deps: [...s.deps, ...back] };
    });
    fail(e, '휴지통으로 옮기지 못했습니다');
    return false;
  }
  // A background refresh that read the server before the delete landed may have put them back.
  localWrites++;
  dropTasks(gone);
  const n = list.length;
  const entry =
    opts.record === false
      ? null
      : pushUndo({
          label: opts.label ?? (n === 1 ? '작업 삭제' : `작업 ${n}개 삭제`),
          undo: async () => !!(await restoreTasks(goneIds, REPLAY)),
          redo: () => deleteTasks(goneIds, REPLAY),
        });
  if (!opts.quiet) notify(n === 1 ? `“${list[0]!.title}”을(를) 휴지통으로 옮겼어요` : `작업 ${n}개를 휴지통으로 옮겼어요`, entry);
  return true;
}

/**
 * Bring tasks back from the trash: the same rows (id, #number, dates), plus the links whose other
 * end still exists. Undo moves them back to the trash.
 */
export async function restoreTasks(ids: string[], opts: MutationOpts = {}): Promise<RestoreResult | null> {
  if (!ids.length) return null;
  try {
    const res = await api<RestoreResult>('POST', '/api/trash/restore', { ids: [...new Set(ids)] });
    // Picked as 휴지통 rows, they must not come back picked in the list (the bar would act on them unseen).
    unpick(ids);
    // Tasks first: a link is only kept once both of its tasks are back in the list.
    applyServerTasks(res.tasks);
    mergeDeps(res.dependencies, { bothEnds: true });
    const back = res.tasks.map((t) => t.id);
    const entry =
      opts.record === false || !back.length
        ? null
        : pushUndo({
            label: opts.label ?? '복원',
            undo: () => deleteTasks(back, REPLAY),
            redo: async () => !!(await restoreTasks(back, REPLAY)),
          });
    if (!opts.quiet && back.length) {
      notify(back.length === 1 ? `“${res.tasks[0]!.title}”을(를) 되살렸어요` : `작업 ${back.length}개를 되살렸어요`, entry);
    }
    // In an organization a task from a deleted project goes back to its maker's (or assignee's)
    // inbox, which only they can see: it is restored, just not into this list.
    const elsewhere = new Set(ids).size - back.length - res.missing.length;
    if (!opts.quiet && elsewhere > 0) {
      toast.show(`작업 ${elsewhere}개는 만든 사람이나 담당자의 인박스로 되살렸어요`);
    }
    return res;
  } catch (e) {
    fail(e, '되살리지 못했습니다');
    return null;
  }
}

export async function addDependency(taskId: string, dependsOnId: string, opts: MutationOpts = {}): Promise<boolean> {
  if (!guard(state.tasks[taskId])) return false;
  const had = state.deps.some((d) => d.taskId === taskId && d.dependsOnId === dependsOnId);
  try {
    await api('POST', `/api/tasks/${taskId}/dependencies`, { dependsOnId });
    mergeDeps([{ taskId, dependsOnId }]);
    if (opts.record !== false && !had) {
      pushUndo({
        label: opts.label ?? '의존 관계 추가',
        undo: () => removeDependency(taskId, dependsOnId, REPLAY),
        redo: () => addDependency(taskId, dependsOnId, REPLAY),
      });
    }
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function removeDependency(taskId: string, dependsOnId: string, opts: MutationOpts = {}): Promise<boolean> {
  if (!guard(state.tasks[taskId])) return false;
  const link = { taskId, dependsOnId };
  const had = state.deps.some((d) => depKey(d) === depKey(link));
  localWrites++;
  set((s) => ({ deps: s.deps.filter((d) => depKey(d) !== depKey(link)) }));
  try {
    await api('DELETE', `/api/tasks/${taskId}/dependencies/${dependsOnId}`);
    if (opts.record !== false && had) {
      pushUndo({
        label: opts.label ?? '의존 관계 해제',
        undo: () => addDependency(taskId, dependsOnId, REPLAY),
        redo: () => removeDependency(taskId, dependsOnId, REPLAY),
      });
    }
    return true;
  } catch (e) {
    if (had) mergeDeps([link]);
    fail(e);
    return false;
  }
}

// ─────────────────────────────── trash (휴지통; purging is final, so no undo: the page confirms first)

export async function listTrash(): Promise<TrashItem[] | null> {
  try {
    const { items } = await api<{ items: TrashItem[] }>('GET', '/api/trash');
    return items;
  } catch (e) {
    fail(e, '휴지통을 불러오지 못했습니다');
    return null;
  }
}

/** Delete trashed tasks for good. Returns how many went, or null when it failed (already toasted). */
export async function purgeTrash(ids: string[], opts: { quiet?: boolean } = {}): Promise<number | null> {
  if (!ids.length) return 0;
  try {
    const { purged } = await api<{ purged: number }>('POST', '/api/trash/purge', { ids: [...new Set(ids)] });
    if (!opts.quiet && purged) toast.show(purged === 1 ? '작업을 영구 삭제했어요' : `작업 ${purged}개를 영구 삭제했어요`);
    return purged;
  } catch (e) {
    fail(e, '영구 삭제하지 못했습니다');
    return null;
  }
}

export async function emptyTrash(opts: { quiet?: boolean } = {}): Promise<number | null> {
  try {
    const { purged } = await api<{ purged: number }>('POST', '/api/trash/empty');
    if (!opts.quiet) toast.show(purged ? `휴지통을 비웠어요 · 작업 ${purged}개` : '휴지통이 이미 비어 있어요');
    return purged;
  } catch (e) {
    fail(e, '휴지통을 비우지 못했습니다');
    return null;
  }
}

// ─────────────────────────────── projects

export async function createProject(input: CreateProjectInput): Promise<Project | null> {
  if (state.workspace && !state.workspace.canCreateProjects) {
    toast.error('이 조직에서는 소유자와 관리자만 프로젝트를 만들 수 있어요');
    return null;
  }
  try {
    const { project } = await api<{ project: Project }>('POST', '/api/projects', input);
    set((s) => ({ projects: [...s.projects, project] }));
    return project;
  } catch (e) {
    fail(e, '프로젝트를 만들지 못했습니다');
    return null;
  }
}

export async function updateProject(id: string, patch: UpdateProjectInput) {
  try {
    const { project } = await api<{ project: Project }>('PATCH', `/api/projects/${id}`, patch);
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
    return project;
  } catch (e) {
    fail(e);
    return null;
  }
}

/** After changing sharing, membership or settings: reload what this workspace looks like. */
export function refresh() {
  return load(true);
}

export async function moveProject(id: string, workspaceId: string) {
  try {
    const res = await api<{ workspace: { id: string; name: string }; tasks: number; linksCut: number }>(
      'POST',
      `/api/projects/${id}/move`,
      { workspaceId },
    );
    return res;
  } catch (e) {
    fail(e, '프로젝트를 옮기지 못했습니다');
    return null;
  }
}

export async function deleteProject(id: string, deleteTasks = false) {
  try {
    await api('DELETE', `/api/projects/${id}?deleteTasks=${deleteTasks}`);
    await load(true);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

// ─────────────────────────────── background sync (AI tools edit the same data)

let syncing = false;
export function startSync() {
  if (syncing || typeof window === 'undefined') return () => {};
  syncing = true;
  const refresh = () => {
    if (document.visibilityState === 'visible' && state.status === 'ready') void load(true);
  };
  const timer = window.setInterval(refresh, 20_000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => {
    syncing = false;
    window.clearInterval(timer);
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', refresh);
  };
}
