'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
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

/** Drop tasks that left the list (moved to the trash), so an undo does not bring them back picked. */
export function unpick(ids: Iterable<string>) {
  const gone = new Set(ids);
  if (![...picked].some((id) => gone.has(id)) && !(anchor && gone.has(anchor))) return;
  const next = [...picked].filter((id) => !gone.has(id));
  picked = next.length ? new Set(next) : EMPTY;
  if (anchor && gone.has(anchor)) anchor = null;
  if (!picked.size) anchor = null;
  rangeBase = new Set([...rangeBase].filter((id) => !gone.has(id)));
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

/**
 * A sweep (press on a row and drag): `base` plus the rows from `from` to `to`. `from` becomes the
 * anchor, so a later Shift+click or Shift+↓ re-draws the same range instead of piling up.
 */
export function pickSpan(order: readonly string[], from: string, to: string, base: ReadonlySet<string>) {
  anchor = from;
  rangeBase = base;
  pickRange(order, to);
}

/**
 * Keyboard range (Shift+↑/↓, Shift+Home/End): the rows from the anchor to `id`. With no anchor on
 * screen yet, `from` (the row focus is leaving) becomes one, and what was picked stays picked.
 */
export function extendRange(order: readonly string[], from: string, id: string) {
  if (!anchor || !order.includes(anchor)) {
    anchor = from;
    rangeBase = picked;
  }
  pickRange(order, id);
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

/**
 * Whether a row can be picked. 모아보기 (/overview) mixes every space's tasks and its rows draw no
 * picked state, so nothing there can be picked; elsewhere every row can (휴지통 rows are not in the
 * task list, yet its own bar acts on them).
 */
export function isPickable(_id: string): boolean {
  return typeof location === 'undefined' || !location.pathname.startsWith('/overview');
}

/**
 * The press that closed a menu or a popover (its event time). It only dismissed that, so the list
 * must not also read it as a click on empty space that lets go of the picks.
 */
let dismissedAt = -Infinity;

/** A menu's or popover's outside-press handler calls this with the press that closes it. */
export function markDismissPress(e: Event) {
  dismissedAt = e.timeStamp;
}

/** Whether the press made at `pressedAt` (its pointerdown's time) closed a menu or popover. */
export function closedSomething(pressedAt: number): boolean {
  // The popover hears the mousedown that follows the pointerdown of the same press.
  return dismissedAt >= pressedAt - 16;
}

/** `visibleRowIds()` without the rows that cannot be picked (what ⌘A, a sweep and a box take). */
export function pickableRowIds(): string[] {
  return visibleRowIds().filter(isPickable);
}

/**
 * ⌘A. A view without list rows (the timeline) registers what it shows instead; the newest
 * registration wins while it is mounted.
 */
let selectAllSources: (() => string[])[] = [];

export function useSelectAll(source: () => string[]) {
  const ref = useRef(source);
  ref.current = source;
  useEffect(() => {
    const read = () => ref.current();
    selectAllSources = [...selectAllSources, read];
    return () => {
      selectAllSources = selectAllSources.filter((s) => s !== read);
    };
  }, []);
}

/** What ⌘A picks on this page: the registered view's tasks, else every pickable row. */
export function selectAllIds(): string[] {
  const source = selectAllSources[selectAllSources.length - 1];
  return source ? source() : pickableRowIds();
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
