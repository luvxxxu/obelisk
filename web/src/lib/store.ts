'use client';

import {
  canEditTask,
  type AccessView,
  type Bootstrap,
  type CreateProjectInput,
  type CreateTaskInput,
  type DateChange,
  type Dependency,
  type Member,
  type PlanItem,
  type Project,
  type Task,
  type TaskStatus,
  type Team,
  type UpdateProjectInput,
  type UpdateTaskInput,
  type User,
  type Workspace,
  type WorkspaceSummary,
  todayIn,
} from '@obelisk/core';
import { useSyncExternalStore } from 'react';
import { api, ApiError, setWorkspaceHeader } from './api';
import { toast } from './toast';

export interface AppState {
  status: 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'error';
  error: string | null;
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

let state: AppState = {
  status: 'idle',
  error: null,
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
      const tasks: Record<string, Task> = {};
      for (const t of b.tasks) tasks[t.id] = t;
      set((s) => ({
        status: 'ready',
        error: null,
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
  storeWorkspace(null);
  set({
    status: 'unauthenticated',
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

export async function createTask(input: CreateTaskInput): Promise<Task | null> {
  try {
    const { task } = await api<{ task: Task }>('POST', '/api/tasks', input);
    upsertTasks([task]);
    if (input.blockedBy?.length) {
      set((s) => ({ deps: [...s.deps, ...input.blockedBy!.map((d) => ({ taskId: task.id, dependsOnId: d }))] }));
    }
    return task;
  } catch (e) {
    fail(e, '작업을 만들지 못했습니다');
    return null;
  }
}

export async function updateTask(id: string, patch: UpdateTaskInput): Promise<Task | null> {
  const prev = state.tasks[id];
  if (!guard(prev)) return null;
  const optimistic: Task = { ...prev, ...(patch as Partial<Task>) };
  if (patch.status && patch.status !== prev.status) {
    optimistic.completedAt = patch.status === 'done' ? new Date().toISOString() : null;
  }
  upsertTasks([optimistic]);
  try {
    const { task } = await api<{ task: Task }>('PATCH', `/api/tasks/${id}`, patch);
    upsertTasks([task]);
    return task;
  } catch (e) {
    upsertTasks([prev]);
    fail(e);
    return null;
  }
}

export async function toggleDone(id: string) {
  const t = state.tasks[id];
  if (!guard(t)) return;
  const done = t.status !== 'done';
  const res = await updateTask(id, { status: done ? 'done' : 'todo' });
  if (res && done) {
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
    toast.show(
      unblocked.length ? `완료 · 이제 ${unblocked.length}개 작업을 시작할 수 있어요` : `“${t.title}” 완료`,
      { action: { label: '실행 취소', run: () => void updateTask(id, { status: t.status }) } },
    );
  }
}

/** Atomically apply a set of date changes (single task or a previewed cascade). */
export async function reschedule(changes: DateChange[], rootId?: string): Promise<boolean> {
  const prev = changes.map((c) => state.tasks[c.taskId]).filter((t): t is Task => !!t);
  if (!prev.every((t) => canEdit(t))) {
    const blocked = prev.filter((t) => !canEdit(t));
    toast.error(
      blocked.length === prev.length
        ? READ_ONLY_MESSAGE
        : `함께 밀리는 작업 중 ${blocked.map((t) => `#${t.number}`).join(', ')}은(는) 보기 전용이라 옮길 수 없어요. ‘이 작업만’ 옮겨 보세요.`,
    );
    return false;
  }
  upsertTasks(
    changes
      .map((c) => state.tasks[c.taskId] && { ...state.tasks[c.taskId]!, startDate: c.startDate, dueDate: c.dueDate })
      .filter((t): t is Task => !!t),
  );
  try {
    const { tasks } = await api<{ tasks: Task[] }>('POST', '/api/tasks/reschedule', { changes, rootId });
    upsertTasks(tasks);
    return true;
  } catch (e) {
    upsertTasks(prev);
    fail(e);
    return false;
  }
}

export interface TaskMove {
  taskId: string;
  position: number;
  status?: TaskStatus;
}

/** Board moves (manual order, and a new status when a card changes column), applied optimistically. */
export async function moveTasks(changes: TaskMove[]): Promise<boolean> {
  if (!changes.length) return true;
  const prev = changes.map((c) => state.tasks[c.taskId]).filter((t): t is Task => !!t);
  if (!prev.every((t) => canEdit(t))) {
    toast.error(READ_ONLY_MESSAGE);
    return false;
  }
  const now = new Date().toISOString();
  upsertTasks(
    changes.flatMap((c) => {
      const t = state.tasks[c.taskId];
      if (!t) return [];
      const next: Task = { ...t, position: c.position };
      if (c.status && c.status !== t.status) {
        next.status = c.status;
        next.completedAt = c.status === 'done' ? now : null;
      }
      return [next];
    }),
  );
  try {
    const { tasks } = await api<{ tasks: Task[] }>('POST', '/api/tasks/reorder', { changes });
    upsertTasks(tasks);
    return true;
  } catch (e) {
    upsertTasks(prev);
    fail(e);
    return false;
  }
}

export async function deleteTask(id: string) {
  const t = state.tasks[id];
  if (!guard(t)) return;
  const prevDeps = state.deps;
  localWrites++;
  set((s) => {
    const tasks = { ...s.tasks };
    delete tasks[id];
    return {
      tasks,
      deps: s.deps.filter((d) => d.taskId !== id && d.dependsOnId !== id),
      selectedTaskId: s.selectedTaskId === id ? null : s.selectedTaskId,
    };
  });
  try {
    await api('DELETE', `/api/tasks/${id}`);
    toast.show(`“${t.title}” 삭제됨`);
  } catch (e) {
    set((s) => ({ tasks: { ...s.tasks, [id]: t }, deps: prevDeps }));
    fail(e);
  }
}

export async function addDependency(taskId: string, dependsOnId: string) {
  if (!guard(state.tasks[taskId])) return false;
  try {
    await api('POST', `/api/tasks/${taskId}/dependencies`, { dependsOnId });
    set((s) => ({
      deps: s.deps.some((d) => d.taskId === taskId && d.dependsOnId === dependsOnId)
        ? s.deps
        : [...s.deps, { taskId, dependsOnId }],
    }));
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function removeDependency(taskId: string, dependsOnId: string) {
  if (!guard(state.tasks[taskId])) return;
  const prev = state.deps;
  set((s) => ({ deps: s.deps.filter((d) => !(d.taskId === taskId && d.dependsOnId === dependsOnId)) }));
  try {
    await api('DELETE', `/api/tasks/${taskId}/dependencies/${dependsOnId}`);
  } catch (e) {
    set({ deps: prev });
    fail(e);
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
