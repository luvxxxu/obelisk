'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { getState, selectTask } from './store';

/**
 * Tasks picked for a bulk action, shared by every list and the timeline so a selection survives
 * switching a project between 리스트 and 타임라인. Cleared when the page or the space changes.
 *
 * Lists follow Finder: ⌘/Ctrl+click adds or removes one, Shift+click takes everything between the
 * anchor (the last row clicked that way) and the clicked row. The timeline keeps Shift+click for one.
 */

const EMPTY: ReadonlySet<string> = new Set();
let picked: ReadonlySet<string> = EMPTY;
/** Where a Shift range starts. */
let anchor: string | null = null;
/** The picks a Shift range is added to: successive Shift+clicks re-draw the range instead of piling up. */
let rangeBase: ReadonlySet<string> = EMPTY;
/** Views that draw the action bar themselves (the timeline); while one is mounted the floating bar stays away. */
let inlineBars = 0;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function usePicked(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => picked, () => EMPTY);
}

/** One row's state, so a click re-renders only the rows that changed. */
export function useIsPicked(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => picked.has(id),
    () => false,
  );
}

export function getPicked(): ReadonlySet<string> {
  return picked;
}

/** Picking closes the side panel: the action bar takes over. */
function closePanel() {
  if (getState().selectedTaskId) selectTask(null);
}

export function setPicked(ids: Iterable<string>, opts: { anchor?: string | null } = {}) {
  const next = new Set(ids);
  if (next.size === picked.size && [...next].every((id) => picked.has(id)) && opts.anchor === undefined) return;
  picked = next.size ? next : EMPTY;
  if (opts.anchor !== undefined) anchor = opts.anchor;
  if (!picked.size) anchor = null;
  rangeBase = picked;
  emit();
  if (picked.size) closePanel();
}

export function clearPicks() {
  if (!picked.size && !anchor) return;
  picked = EMPTY;
  anchor = null;
  rangeBase = EMPTY;
  emit();
}

/** Add or remove one task. The task open in the side panel joins the first pick. */
export function togglePick(id: string) {
  const next = new Set(picked);
  const open = getState().selectedTaskId;
  if (!next.size && open && open !== id && getState().tasks[open]) next.add(open);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked = next.size ? next : EMPTY;
  anchor = id;
  rangeBase = picked;
  emit();
  closePanel();
}

/**
 * Shift+click in a list: the rows from the anchor to `id`, in on-screen `order`, on top of what was
 * picked before the range started. Without an anchor the open task (or else just this row) starts it.
 */
export function pickRange(order: readonly string[], id: string) {
  const from = anchor ?? getState().selectedTaskId ?? id;
  let a = order.indexOf(from);
  const b = order.indexOf(id);
  if (b < 0) return;
  if (a < 0) a = b;
  const next = new Set(rangeBase);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order[i]!);
  picked = next;
  anchor = order[a]!;
  emit();
  closePanel();
}

/** Task ids of the list rows on screen, top to bottom (what a Shift range spans). */
export function visibleRowIds(): string[] {
  if (typeof document === 'undefined') return [];
  const out: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('main [data-task-row]')) {
    const id = el.dataset.taskRow;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** A view that shows the action bar itself (the timeline) registers while it is mounted. */
export function useInlineBar() {
  useEffect(() => {
    inlineBars++;
    emit();
    return () => {
      inlineBars--;
      emit();
    };
  }, []);
}

export function useHasInlineBar(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => inlineBars > 0,
    () => false,
  );
}
