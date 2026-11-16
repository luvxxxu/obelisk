'use client';

/**
 * Jev in the web app: settings, the shared priority result (home focus, the priority dialog
 * and auto-apply read the same one), and helpers that apply a suggestion through the ordinary
 * task endpoints so permissions and the activity log work exactly as for a manual edit.
 */

import {
  autoApplicable,
  type DependencySuggestion,
  type JevStatus,
  type JevTriageInput,
  type PostponeCandidate,
  type PostponePlan,
  type Priority,
  type PrioritySuggestion,
  type Task,
  type TriageSuggestion,
  type User,
} from '@obelisk/core';
import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { canEdit, getState, load, reschedule, setUser, updateTask, useApp } from './store';
import { toast } from './toast';

const OFF: JevStatus = { connected: false, keyUnreadable: false, hint: null, autoApply: false };

export function useJev(): JevStatus {
  return useApp().user?.jev ?? OFF;
}

export function jevMessage(e: unknown, fallback = 'Jev에 묻지 못했어요'): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

// ─────────────────────────────── settings

export async function saveJevSettings(patch: { apiKey?: string | null; autoApply?: boolean }): Promise<JevStatus | null> {
  try {
    const { user, jev } = await api<{ user: User; jev: JevStatus }>('PUT', '/api/jev/settings', patch);
    setUser(user);
    resetPriorities();
    return jev;
  } catch (e) {
    toast.error(jevMessage(e, '설정을 저장하지 못했어요'));
    return null;
  }
}

// ─────────────────────────────── A. priorities (one shared result)

export interface PrioritiesResult {
  today: string;
  model: string | null;
  suggestions: PrioritySuggestion[];
  focus: { taskId: string; reasons: string[] } | null;
}

interface PriorityStore {
  key: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: PrioritiesResult | null;
  error: string | null;
}

let store: PriorityStore = { key: null, status: 'idle', data: null, error: null };
const listeners = new Set<() => void>();
const emit = (patch: Partial<PriorityStore>) => {
  store = { ...store, ...patch };
  for (const l of listeners) l();
};

/** Changes whenever something Jev or the engine looks at changes (not priority itself). */
function planKey(): string | null {
  const s = getState();
  if (!s.workspace || !s.user?.jev.connected) return null;
  let h = 5381;
  const parts = Object.values(s.tasks)
    .filter((t) => t.status === 'todo' || t.status === 'doing')
    .map((t) => `${t.id}:${t.title}:${t.notes.length}:${t.status}:${t.startDate}:${t.dueDate}:${t.fixed}:${t.projectId}`)
    .sort();
  for (const p of [...parts, ...s.deps.map((d) => `${d.taskId}>${d.dependsOnId}`).sort()]) {
    for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) | 0;
  }
  return `${s.workspace.id}|${s.today}|${h}`;
}

let inflight: Promise<void> | null = null;

export function refreshPriorities(force = false): Promise<void> {
  const key = planKey();
  if (!key) return Promise.resolve();
  if (!force && store.key === key && (store.status === 'ready' || store.status === 'loading')) return inflight ?? Promise.resolve();
  emit({ key, status: 'loading', error: null });
  const run = (async () => {
    try {
      const data = await api<PrioritiesResult>('POST', '/api/jev/priorities', {});
      if (store.key === key) emit({ status: 'ready', data });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (store.key === key) emit({ status: 'error', error: jevMessage(e) });
    }
  })();
  inflight = run;
  return run.finally(() => {
    if (inflight === run) inflight = null;
  });
}

export function resetPriorities() {
  emit({ key: null, status: 'idle', data: null, error: null });
}

/**
 * The current priority result, fetched (debounced) when `enabled` and the plan changed.
 * The server caches Jev's per-task answers, so a refetch after an edit only asks about what changed.
 */
export function usePriorities(enabled: boolean): PriorityStore {
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => store,
    () => store,
  );
  const app = useApp();
  const key = enabled ? planKey() : null;
  useEffect(() => {
    if (!key || key === store.key) return;
    const t = window.setTimeout(() => void refreshPriorities(), store.key ? 1200 : 0);
    return () => window.clearTimeout(t);
    // `app` keeps the effect in step with task edits; `key` is derived from it.
  }, [key, app]);
  return snap;
}

/** Apply chosen priorities as ordinary edits, with one undo for all of them. */
export async function applyPriorities(changes: { taskId: string; priority: Priority }[], label = '우선순위') {
  const s = getState();
  const prev = changes.flatMap((c) => (s.tasks[c.taskId] ? [{ taskId: c.taskId, priority: s.tasks[c.taskId]!.priority }] : []));
  const results = await Promise.all(changes.map((c) => updateTask(c.taskId, { priority: c.priority })));
  const ok = results.filter(Boolean).length;
  if (!ok) return 0;
  toast.show(`${label} ${ok}개를 바꿨어요`, {
    action: {
      label: '실행 취소',
      run: () => void Promise.all(prev.map((p) => updateTask(p.taskId, { priority: p.priority }))),
    },
  });
  return ok;
}

// ─────────────────────────────── auto-apply (opt-in, fills missing priorities only)

const DECLINED_KEY = 'obelisk:jev-declined';
const applied = new Set<string>();

function declined(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DECLINED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function decline(ids: string[]) {
  try {
    const all = [...declined(), ...ids].slice(-500);
    localStorage.setItem(DECLINED_KEY, JSON.stringify(all));
  } catch {}
}

/**
 * When the user turned on auto-apply: high-confidence suggestions for tasks without a priority
 * are applied once, with an undo that also stops Jev from filling those tasks again.
 */
export function useJevAutoPilot() {
  const jev = useJev();
  const app = useApp();
  const on = jev.connected && jev.autoApply && app.status === 'ready';
  const p = usePriorities(on);
  useEffect(() => {
    if (!on || p.status !== 'ready' || !p.data) return;
    const no = declined();
    const picks = p.data.suggestions.filter((sg) => {
      const t = app.tasks[sg.taskId];
      return t && t.priority === 0 && autoApplicable(sg) && !applied.has(t.id) && !no.has(t.id) && canEdit(t, app);
    });
    if (!picks.length) return;
    for (const sg of picks) applied.add(sg.taskId);
    void (async () => {
      const done = (await Promise.all(picks.map((sg) => updateTask(sg.taskId, { priority: sg.suggested })))).filter(Boolean) as Task[];
      if (!done.length) return;
      toast.show(`Jev가 작업 ${done.length}개의 우선순위를 정했어요`, {
        action: {
          label: '실행 취소',
          run: () => {
            decline(done.map((t) => t.id));
            void Promise.all(done.map((t) => updateTask(t.id, { priority: 0 })));
          },
        },
      });
    })();
  }, [on, p, app]);
}

// ─────────────────────────────── B. postpone

export async function fetchPostponePlan(scope: 'today' | 'week', capacity?: number): Promise<PostponePlan> {
  const { plan } = await api<{ plan: PostponePlan }>('POST', '/api/jev/postpone', { scope, ...(capacity ? { capacity } : {}) });
  return plan;
}

/**
 * Postpone each chosen task to its proposed date, cascading what it pushes (the engine already
 * checked no fixed date breaks). One undo restores every date that changed.
 */
export async function applyPostpone(picks: PostponeCandidate[]): Promise<number> {
  const before = new Map(Object.values(getState().tasks).map((t) => [t.id, { startDate: t.startDate, dueDate: t.dueDate }]));
  let moved = 0;
  const failed: string[] = [];
  for (const c of picks) {
    if (!c.toDate) continue;
    try {
      await api('POST', '/api/impact/postpone', { taskId: c.taskId, toDate: c.toDate, cascade: true });
      moved++;
    } catch (e) {
      failed.push(jevMessage(e, '미루지 못했어요'));
    }
  }
  await load(true);
  const after = getState().tasks;
  const undo = [...before]
    .filter(([id, d]) => after[id] && (after[id]!.startDate !== d.startDate || after[id]!.dueDate !== d.dueDate))
    .map(([taskId, d]) => ({ taskId, startDate: d.startDate, dueDate: d.dueDate }));
  if (failed.length) toast.error(failed[0]!);
  if (moved) {
    const others = undo.length - moved;
    toast.show(`작업 ${moved}개를 미뤘어요${others > 0 ? ` · 뒤따르는 ${others}개도 함께 옮겼어요` : ''}`, {
      action: undo.length ? { label: '실행 취소', run: () => void reschedule(undo) } : undefined,
    });
  }
  return moved;
}

// ─────────────────────────────── C. triage, D. dependencies

export async function fetchTriage(input: JevTriageInput, signal?: AbortSignal): Promise<TriageSuggestion | null> {
  if (signal?.aborted) return null;
  const { suggestion } = await api<{ suggestion: TriageSuggestion }>('POST', '/api/jev/triage', input);
  return signal?.aborted ? null : suggestion;
}

export async function fetchDependencySuggestions(taskId: string) {
  return api<{ taskId: string; blockedBy: DependencySuggestion[]; blocks: DependencySuggestion[] }>('POST', '/api/jev/dependencies', { taskId });
}
