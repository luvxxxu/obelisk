'use client';

/**
 * Time planning in the browser: the running clock, a task's time entries, day plans and
 * finish-date odds. The server owns the maths (core timeplan/odds); this keeps small caches and
 * hands changed tasks back to the app store.
 */
import type {
  CommitInput,
  CommitResponse,
  DayProposalResponse,
  DayView,
  ISODate,
  ISOTime,
  OddsResponse,
  RunningTimer,
  Task,
  TaskOdds,
  TimeBlock,
  TimeEntry,
  WorkHours,
  User,
} from '@obelisk/core';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { applyTasks, getState, onStatusSaved, setUser, useApp } from './store';
import { toast } from './toast';

const fail = (e: unknown, fallback = '요청을 처리하지 못했어요') => toast.error(e instanceof ApiError ? e.message : fallback);

// ─────────────────────────────── a tiny store

function cell<T>(initial: T) {
  let value = initial;
  const ls = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      ls.forEach((l) => l());
    },
    use: () =>
      useSyncExternalStore(
        (l) => {
          ls.add(l);
          return () => ls.delete(l);
        },
        () => value,
        () => value,
      ),
  };
}

// ─────────────────────────────── the running clock

const running = cell<RunningTimer | null>(null);
/** Bumped whenever recorded time may have changed (entry lists and day plans re-read). */
const timeVersion = cell(0);
let runningLoaded = false;

export const useRunning = running.use;
export const useTimeVersion = timeVersion.use;

export async function refreshRunning() {
  try {
    const r = await api<{ running: RunningTimer | null }>('GET', '/api/time/running');
    running.set(r.running);
    runningLoaded = true;
  } catch {
    /* signed out or offline: keep what we had */
  }
}

let watching = false;
/** Keep the clock fresh: on load, on focus, and after a status change (the server starts and stops clocks). */
export function watchRunning() {
  if (watching || typeof window === 'undefined') return () => {};
  watching = true;
  if (!runningLoaded) void refreshRunning();
  const onFocus = () => document.visibilityState === 'visible' && void refreshRunning();
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  const off = onStatusSaved((task, prev) => {
    if (task.status === 'doing' || prev.status === 'doing') {
      void refreshRunning();
      timeVersion.set(timeVersion.get() + 1);
    }
  });
  return () => {
    watching = false;
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    off();
  };
}

export async function startTimer(taskId: string) {
  try {
    const r = await api<{ running: RunningTimer | null; task: Task }>('POST', '/api/time/timer', { taskId, action: 'start' });
    running.set(r.running);
    applyTasks([r.task]);
    timeVersion.set(timeVersion.get() + 1);
    return true;
  } catch (e) {
    fail(e, '타이머를 켜지 못했어요');
    return false;
  }
}

export async function stopTimer(taskId: string) {
  try {
    const r = await api<{ running: RunningTimer | null; task: Task }>('POST', '/api/time/timer', { taskId, action: 'stop' });
    running.set(r.running);
    applyTasks([r.task]);
    timeVersion.set(timeVersion.get() + 1);
    return r.task;
  } catch (e) {
    fail(e, '타이머를 멈추지 못했어요');
    return null;
  }
}

export async function logTime(taskId: string, minutes: number, date?: ISODate) {
  try {
    const r = await api<{ task: Task }>('POST', '/api/time/entries', { taskId, minutes, ...(date ? { date } : {}) });
    applyTasks([r.task]);
    timeVersion.set(timeVersion.get() + 1);
    return r.task;
  } catch (e) {
    fail(e, '시간을 기록하지 못했어요');
    return null;
  }
}

export async function setActual(taskId: string, minutes: number) {
  try {
    const r = await api<{ task: Task; running: RunningTimer | null }>('PUT', `/api/tasks/${taskId}/actual`, { minutes });
    applyTasks([r.task]);
    running.set(r.running);
    timeVersion.set(timeVersion.get() + 1);
    return r.task;
  } catch (e) {
    fail(e, '시간을 고치지 못했어요');
    return null;
  }
}

export async function deleteEntry(id: string) {
  try {
    const r = await api<{ task: Task }>('DELETE', `/api/time/entries/${id}`);
    applyTasks([r.task]);
    timeVersion.set(timeVersion.get() + 1);
    return true;
  } catch (e) {
    fail(e, '기록을 지우지 못했어요');
    return false;
  }
}

export interface EntryView extends TimeEntry {
  userName: string | null;
  mine: boolean;
}

/** A task's time entries, re-read when time changes. */
export function useEntries(taskId: string, actualMinutes: number) {
  const version = useTimeVersion();
  const [entries, setEntries] = useState<EntryView[] | null>(null);
  useEffect(() => {
    let live = true;
    api<{ entries: EntryView[] }>('GET', `/api/tasks/${taskId}/time`)
      .then((r) => live && setEntries(r.entries))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [taskId, version, actualMinutes]);
  return entries;
}

/** Seconds since an ISO instant, ticking every second while mounted. */
export function useElapsed(since: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [since]);
  return since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
}

/** "1:02:05", "12:09" */
export function clockText(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ─────────────────────────────── work hours

export async function saveWorkHours(hours: WorkHours) {
  try {
    const r = await api<{ user: User }>('PUT', '/api/auth/me/work-hours', hours);
    setUser(r.user);
    odds.set(null);
    toast.success('일정 계획 설정을 저장했어요');
    return true;
  } catch (e) {
    fail(e, '저장하지 못했어요');
    return false;
  }
}

// ─────────────────────────────── finish-date odds

const odds = cell<{ key: string; data: OddsResponse } | null>(null);
let oddsInflight: { key: string; p: Promise<void> } | null = null;

/** What the odds depend on: the open space's active work, its links, and recorded time. */
function oddsKey(): string {
  const s = getState();
  const parts: string[] = [s.workspace?.id ?? '', s.today, String(timeVersion.get())];
  for (const t of Object.values(s.tasks)) {
    if (t.status !== 'todo' && t.status !== 'doing') continue;
    parts.push(`${t.id}:${t.status}:${t.startDate}:${t.dueDate}:${t.dueTime}:${t.fixed ? 1 : 0}:${t.estimateMinutes}:${t.actualMinutes}:${t.assigneeId}:${t.priority}`);
  }
  parts.push(String(s.deps.length));
  return parts.join('|');
}

function loadOdds(key: string) {
  if (oddsInflight?.key === key) return oddsInflight.p;
  const p = api<OddsResponse>('GET', '/api/odds')
    .then((data) => odds.set({ key, data }))
    .catch(() => {})
    .finally(() => {
      if (oddsInflight?.key === key) oddsInflight = null;
    });
  oddsInflight = { key, p };
  return p;
}

/**
 * Finish-date odds for the open space. Refetched (debounced) when the plan changes; the last
 * answer stays on screen meanwhile.
 */
export function useOdds(enabled = true): { data: OddsResponse | null; byTask: Map<string, TaskOdds>; stale: boolean } {
  const app = useApp();
  const cur = odds.use();
  useTimeVersion();
  const key = useMemo(() => (app.status === 'ready' ? oddsKey() : ''), [app]);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled || !key || cur?.key === key) return;
    const wait = cur && cur.data.report && cur.key.split('|')[0] === key.split('|')[0] ? 700 : 0;
    timer.current = window.setTimeout(() => void loadOdds(key), wait);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [enabled, key, cur]);
  const sameSpace = !!cur && cur.key.split('|')[0] === key.split('|')[0];
  const data = sameSpace ? cur!.data : null;
  const byTask = useMemo(() => new Map((data?.report.tasks ?? []).map((t) => [t.taskId, t])), [data]);
  return { data, byTask, stale: !!cur && cur.key !== key };
}

export async function checkCommit(input: CommitInput): Promise<CommitResponse | null> {
  try {
    return await api<CommitResponse>('POST', '/api/odds/commit', input);
  } catch (e) {
    fail(e, '날짜를 계산하지 못했어요');
    return null;
  }
}

/** Quiet variant for live hints (no toast on failure). */
export function peekCommit(input: CommitInput): Promise<CommitResponse | null> {
  return api<CommitResponse>('POST', '/api/odds/commit', input).catch(() => null);
}

// ─────────────────────────────── day plans

const days = cell<Record<string, DayView>>({});

export async function loadDay(date: ISODate | 'today'): Promise<DayView | null> {
  try {
    const view = await api<DayView>('GET', `/api/plan/day/${date}`);
    days.set({ ...days.get(), [view.date]: view });
    return view;
  } catch (e) {
    fail(e, '하루 계획을 불러오지 못했어요');
    return null;
  }
}

/** One day's plan, re-read when tasks or recorded time change. */
export function useDay(date: ISODate) {
  const all = days.use();
  const version = useTimeVersion();
  const app = useApp();
  const sig = useMemo(
    () =>
      Object.values(app.tasks)
        .map((t) => `${t.id}${t.status}${t.dueDate}${t.dueTime}${t.startDate}${t.startTime}${t.estimateMinutes}`)
        .join(),
    [app.tasks],
  );
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const id = window.setTimeout(() => {
      void loadDay(date).finally(() => live && setLoading(false));
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [date, version, sig]);
  return { view: all[date] ?? null, loading, reload: () => loadDay(date) };
}

function patchDay(date: ISODate, fn: (v: DayView) => DayView) {
  const cur = days.get()[date];
  if (cur) days.set({ ...days.get(), [date]: fn(cur) });
}

export async function previewPlan(date: ISODate, fillAhead: boolean): Promise<DayProposalResponse | null> {
  try {
    return await api<DayProposalResponse>('POST', `/api/plan/day/${date}/auto`, { fillAhead });
  } catch (e) {
    fail(e, '계획을 짜지 못했어요');
    return null;
  }
}

export async function applyPlan(date: ISODate, fillAhead: boolean): Promise<boolean> {
  try {
    const r = await api<DayProposalResponse>('POST', `/api/plan/day/${date}/auto`, { fillAhead, apply: true });
    if (r.view) days.set({ ...days.get(), [date]: r.view });
    return true;
  } catch (e) {
    fail(e, '계획을 저장하지 못했어요');
    return false;
  }
}

export async function createBlock(input: { taskId: string; date: ISODate; start: ISOTime; end: ISOTime }) {
  try {
    const r = await api<{ block: TimeBlock }>('POST', '/api/plan/blocks', input);
    patchDay(input.date, (v) => ({ ...v, blocks: [...v.blocks, r.block].sort((a, b) => a.start.localeCompare(b.start)) }));
    void loadDay(input.date);
    return r.block;
  } catch (e) {
    fail(e, '블록을 만들지 못했어요');
    return null;
  }
}

export async function updateBlock(block: TimeBlock, patch: { date?: ISODate; start?: ISOTime; end?: ISOTime; locked?: boolean }) {
  // Optimistic: the block moves at once and comes back if the server says no.
  patchDay(block.date, (v) => ({ ...v, blocks: v.blocks.map((b) => (b.id === block.id ? { ...b, ...patch, locked: patch.locked ?? true } : b)) }));
  try {
    await api<{ block: TimeBlock }>('PATCH', `/api/plan/blocks/${block.id}`, patch);
    void loadDay(block.date);
    if (patch.date && patch.date !== block.date) void loadDay(patch.date);
    return true;
  } catch (e) {
    patchDay(block.date, (v) => ({ ...v, blocks: v.blocks.map((b) => (b.id === block.id ? block : b)) }));
    fail(e, '블록을 옮기지 못했어요');
    return false;
  }
}

export async function deleteBlock(block: TimeBlock) {
  patchDay(block.date, (v) => ({ ...v, blocks: v.blocks.filter((b) => b.id !== block.id) }));
  try {
    await api('DELETE', `/api/plan/blocks/${block.id}`);
    void loadDay(block.date);
    return true;
  } catch (e) {
    void loadDay(block.date);
    fail(e, '블록을 지우지 못했어요');
    return false;
  }
}

export async function clearDay(date: ISODate, onlyUnlocked: boolean) {
  try {
    await api('DELETE', `/api/plan/day/${date}${onlyUnlocked ? '?unlocked=true' : ''}`);
    await loadDay(date);
    return true;
  } catch (e) {
    fail(e, '계획을 비우지 못했어요');
    return false;
  }
}
