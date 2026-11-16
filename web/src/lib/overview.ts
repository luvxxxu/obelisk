'use client';

/**
 * 모아보기 data: the user's own work in every space, merged.
 *
 * The open space comes live from the app store (so quick adds, completions and the 20s sync show at
 * once); every other space comes from GET /api/overview. When a space was seen live more recently than
 * the last fetch started (you just switched away from it), its live rows are kept until a newer fetch.
 */

import {
  inOverview,
  type Overview,
  type OverviewProject,
  type Task,
  type TaskStatus,
  type WorkspaceSummary,
} from '@obelisk/core';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { canEdit, selectTask, switchWorkspace, toggleDone, useApp, type AppState } from './store';
import { toast } from './toast';

export interface OverviewItem {
  task: Task;
  editable: boolean;
  space: WorkspaceSummary;
  project: OverviewProject | null;
  /** Lives in the open space: changes go through the app store, opening needs no switch. */
  live: boolean;
}

interface OverviewState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: Overview | null;
  /** When the request behind `data` started. */
  fetchedAt: number;
  error: string | null;
}

let state: OverviewState = { status: 'idle', data: null, fetchedAt: 0, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<OverviewState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

let inflight: Promise<void> | null = null;

export function loadOverview(): Promise<void> {
  if (inflight) return inflight;
  const startedAt = Date.now();
  if (!state.data) set({ status: 'loading' });
  inflight = (async () => {
    try {
      const data = await api<Overview>('GET', '/api/overview');
      set({ status: 'ready', data, fetchedAt: startedAt, error: null });
    } catch (e) {
      // Keep showing what we had; only an empty page reports the failure.
      if (!state.data) set({ status: 'error', error: e instanceof Error ? e.message : '불러오지 못했습니다' });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Rows of the open space as last seen live, per space, with when. */
const liveCache = new Map<string, { at: number; items: OverviewItem[] }>();

function merge(app: AppState, ov: OverviewState): { spaces: WorkspaceSummary[]; items: OverviewItem[] } {
  const spaces = ov.data?.spaces ?? app.workspaces;
  const byId = new Map(spaces.map((w) => [w.id, w]));
  const projects = new Map((ov.data?.projects ?? []).map((p) => [p.id, p]));
  const open = app.status === 'ready' && app.workspace && app.user ? app.workspace : null;

  const items: OverviewItem[] = [];
  if (open) {
    const space = byId.get(open.id) ?? open;
    const live = Object.values(app.tasks)
      .filter((t) => inOverview(t, open.kind, app.user!.id, app.today))
      .map<OverviewItem>((t) => {
        const p = t.projectId ? app.projects.find((x) => x.id === t.projectId) : undefined;
        return {
          task: t,
          editable: canEdit(t, app),
          space,
          project: p ? { id: p.id, workspaceId: p.workspaceId, name: p.name, color: p.color } : null,
          live: true,
        };
      });
    liveCache.set(open.id, { at: Date.now(), items: live });
    items.push(...live);
  }

  for (const space of spaces) {
    if (space.id === open?.id) continue;
    const cached = liveCache.get(space.id);
    if (cached && cached.at > ov.fetchedAt) {
      items.push(...cached.items.map((i) => ({ ...i, space, live: false })));
      continue;
    }
    for (const t of ov.data?.tasks ?? []) {
      if (t.workspaceId !== space.id) continue;
      const { editable, ...task } = t;
      items.push({ task, editable, space, project: t.projectId ? (projects.get(t.projectId) ?? null) : null, live: false });
    }
  }
  return { spaces, items };
}

/**
 * Everything the 모아보기 page and the home widget need. Fetches on first use, when the open space
 * changes, when the window regains focus and every minute while something is showing it.
 */
export function useOverview() {
  const app = useApp();
  const ov = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );

  useEffect(() => {
    void loadOverview();
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadOverview();
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const openId = app.status === 'ready' ? app.workspace?.id : undefined;
  useEffect(() => {
    if (openId && state.status !== 'idle') void loadOverview();
  }, [openId]);

  const { tasks, projects, workspace, workspaces, user, status, today } = app;
  const merged = useMemo(
    () => merge(app, ov),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the fields merge() reads
    [tasks, projects, workspace, workspaces, user, status, today, ov],
  );

  return {
    /** Other spaces have arrived at least once (the open one is always there). */
    loaded: ov.data !== null,
    error: ov.status === 'error' ? ov.error : null,
    today: app.today,
    openId: openId ?? null,
    ...merged,
  };
}

// ─────────────────────────────── space colours

const ORG_HUES = ['blue', 'violet', 'teal', 'orange', 'pink', 'green', 'indigo', 'amber'] as const;
export type SpaceHue = 'slate' | (typeof ORG_HUES)[number];

/** A tag colour per space, stable for a given membership order: personal is neutral, orgs take turns. */
export function spaceHues(spaces: readonly WorkspaceSummary[]): Map<string, SpaceHue> {
  const out = new Map<string, SpaceHue>();
  let i = 0;
  for (const w of spaces) out.set(w.id, w.kind === 'personal' ? 'slate' : ORG_HUES[i++ % ORG_HUES.length]!);
  return out;
}

// ─────────────────────────────── changes from the page

function patchRemote(id: string, patch: Partial<Task>) {
  if (!state.data) return;
  set({ data: { ...state.data, tasks: state.data.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) } });
}

async function setRemoteStatus(item: OverviewItem, status: TaskStatus): Promise<boolean> {
  const prev = item.task;
  patchRemote(prev.id, { status, completedAt: status === 'done' ? new Date().toISOString() : null });
  try {
    const { task } = await api<{ task: Task }>('PATCH', `/api/tasks/${prev.id}`, { status });
    patchRemote(task.id, task);
    return true;
  } catch (e) {
    patchRemote(prev.id, { status: prev.status, completedAt: prev.completedAt });
    if (!(e instanceof ApiError && e.status === 401)) toast.error(e instanceof Error ? e.message : '변경 사항을 저장하지 못했습니다');
    return false;
  }
}

/** Tick a row: through the store for the open space, straight to the server for the others. */
export async function completeOverviewItem(item: OverviewItem) {
  if (item.live) return toggleDone(item.task.id);
  if (!item.editable) return;
  const prevStatus = item.task.status;
  if (await setRemoteStatus(item, 'done')) {
    void loadOverview();
    toast.show(`“${item.task.title}” 완료`, {
      action: {
        label: '실행 취소',
        run: () =>
          void setRemoteStatus({ ...item, task: { ...item.task, status: 'done' } }, prevStatus).then((ok) => {
            if (ok) void loadOverview();
          }),
      },
    });
  }
}

/** Open a row: in place for the open space, otherwise switch to its space with the task selected. */
export async function openOverviewItem(item: OverviewItem, spaceName: string) {
  if (item.live) return selectTask(item.task.id);
  await switchWorkspace(item.space.id, { selectTaskId: item.task.id });
  toast.show(`${spaceName}(으)로 전환했어요`);
}
