'use client';

import {
  type Bootstrap,
  type CreateProjectInput,
  type CreateTaskInput,
  type DateChange,
  type Dependency,
  type PlanItem,
  type Project,
  type Task,
  type UpdateProjectInput,
  type UpdateTaskInput,
  type User,
  todayIn,
} from '@obelisk/core';
import { useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { toast } from './toast';

export interface AppState {
  status: 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'error';
  error: string | null;
  user: User | null;
  today: string;
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

function upsertTasks(list: Task[]) {
  set((s) => {
    const tasks = { ...s.tasks };
    for (const t of list) tasks[t.id] = t;
    return { tasks };
  });
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

export function load(silent = false): Promise<void> {
  if (inflight) return inflight;
  if (!silent) set({ status: state.status === 'ready' ? 'ready' : 'loading' });
  inflight = (async () => {
    try {
      const b = await api<Bootstrap>('GET', '/api/bootstrap');
      const tasks: Record<string, Task> = {};
      for (const t of b.tasks) tasks[t.id] = t;
      set({
        status: 'ready',
        error: null,
        user: b.user,
        today: b.today,
        projects: b.projects,
        tasks,
        deps: b.dependencies,
      });
    } catch (e) {
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
  set({ status: 'unauthenticated', user: null, projects: [], tasks: {}, deps: [], selectedTaskId: null });
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
  if (!prev) return null;
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
  if (!t) return;
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

export async function deleteTask(id: string) {
  const t = state.tasks[id];
  if (!t) return;
  const prevDeps = state.deps;
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
