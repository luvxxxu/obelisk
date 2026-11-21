'use client';

import { useSyncExternalStore } from 'react';
import { toast, type Toast } from './toast';

/**
 * One undo/redo history for the session. Every task change that can be taken back pushes an entry
 * (the store does it after the server agreed; composite actions push one entry for the whole batch),
 * so ⌘Z, ⌘⇧Z and a toast's 실행 취소 all walk the same list.
 *
 * Entry functions return false when they could not be applied, and the entry is then dropped from
 * the history (the next ⌘Z reaches the change before it). This file adds no message of its own: a
 * task deleted elsewhere drops the entry silently, while a permission change shows the store's
 * read-only notice and a failed request (say, a task purged from the trash) its error.
 */

export interface UndoEntry {
  id: number;
  label: string;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
}

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

const CAP = 100;

let past: UndoEntry[] = [];
let future: UndoEntry[] = [];
let seq = 0;
/** Bumped by `clearUndo`: an operation still running for the old workspace must not come back. */
let epoch = 0;
let running = false;

const EMPTY_STATE: UndoState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
let snapshot: UndoState = EMPTY_STATE;
const listeners = new Set<() => void>();

function emit() {
  const top = past[past.length - 1];
  const next = future[future.length - 1];
  snapshot = { canUndo: !!top, canRedo: !!next, undoLabel: top?.label ?? null, redoLabel: next?.label ?? null };
  listeners.forEach((l) => l());
}

export function pushUndo(e: { label: string; undo: () => Promise<boolean>; redo: () => Promise<boolean> }): UndoEntry {
  const entry: UndoEntry = { id: ++seq, label: e.label, undo: e.undo, redo: e.redo };
  past = [...past, entry].slice(-CAP);
  future = [];
  emit();
  return entry;
}

/**
 * Run one side of an entry, then move it to the other list. Presses that arrive while one is
 * running are ignored rather than queued: a queued ⌘Z would act on a state the user never saw.
 */
async function run(entry: UndoEntry, dir: 'undo' | 'redo') {
  if (running) return;
  const from = dir === 'undo' ? past : future;
  if (!from.some((e) => e.id === entry.id)) return; // already taken back (or cleared) elsewhere
  running = true;
  const at = epoch;
  const pushedBefore = seq;
  if (dir === 'undo') past = past.filter((e) => e.id !== entry.id);
  else future = future.filter((e) => e.id !== entry.id);
  emit();
  let ok = false;
  try {
    ok = await (dir === 'undo' ? entry.undo() : entry.redo());
  } catch {
    ok = false;
  } finally {
    running = false;
  }
  if (at !== epoch || !ok) {
    emit();
    return;
  }
  if (dir === 'undo') {
    // Something new was done while this ran: redoing the old change on top of it would surprise.
    if (seq === pushedBefore) future = [...future, entry].slice(-CAP);
    emit();
    toast.show(`실행 취소함 · ${entry.label}`, { action: { label: '다시 실행', run: () => void run(entry, 'redo') } });
  } else {
    past = [...past, entry].slice(-CAP);
    emit();
    toast.show(`다시 실행함 · ${entry.label}`, { action: { label: '실행 취소', run: () => void run(entry, 'undo') } });
  }
}

/** ⌘Z: the newest entry. */
export async function undo(): Promise<void> {
  if (running) return;
  const top = past[past.length - 1];
  if (!top) {
    toast.show('되돌릴 작업이 없어요');
    return;
  }
  await run(top, 'undo');
}

/** ⌘⇧Z / Ctrl+Y: the entry undone last. */
export async function redo(): Promise<void> {
  if (running) return;
  const next = future[future.length - 1];
  if (!next) {
    toast.show('다시 실행할 작업이 없어요');
    return;
  }
  await run(next, 'redo');
}

/** A toast's 실행 취소: that entry, wherever it sits in the history (a no-op once it was undone). */
export async function undoEntry(entry: UndoEntry): Promise<void> {
  await run(entry, 'undo');
}

/** Workspace switch, reset, sign-out: the entries point at tasks of a space that is no longer open. */
export function clearUndo(): void {
  epoch++;
  past = [];
  future = [];
  emit();
}

export function useUndoState(): UndoState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => EMPTY_STATE,
  );
}

/** The usual "done" toast, whose 실행 취소 takes back exactly this entry (the same as ⌘Z while it is the newest). */
export function notify(message: string, entry: UndoEntry | null, opts: { secondary?: Toast['secondary'] } = {}): void {
  toast.show(message, { ...(entry ? { action: { label: '실행 취소', run: () => void undoEntry(entry) } } : {}), secondary: opts.secondary });
}
