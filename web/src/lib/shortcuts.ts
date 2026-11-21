'use client';

import type { Priority } from '@obelisk/core';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { clearPicks, extendRange, getPicked, isPickable, pickableRowIds, selectAllIds, setPicked } from './selection';
import { getState, selectTask } from './store';
import {
  actionTargets,
  completeTasks,
  copyTasks,
  duplicateTasks,
  moveToToday,
  pasteContext,
  pasteTasks,
  postponeTasks,
  renameTask,
  setPriority,
  textForCopy,
  trashTasks,
} from './task-actions';
import { toast } from './toast';
import { DESKTOP_QUERY, isApple, toggleSidebar } from './ui-helpers';
import { getUi, setUi } from './ui-state';
import { redo, undo } from './undo';

/**
 * The app-wide keyboard. One window listener in the bubble phase, so a row, the home dashboard or
 * a page that handles a key itself (and calls preventDefault) wins. Task shortcuts act on
 * `actionTargets()`: the picks, else the focused row, else the open task while nothing else has focus.
 */

/** G then a letter within this long goes to a page (so T right after G is not 오늘로). */
const G_WINDOW_MS = 900;

const PAGES: Record<string, string> = {
  h: '/',
  o: '/overview',
  t: '/today',
  u: '/upcoming',
  i: '/inbox',
  f: '/forecast',
  a: '/all',
  l: '/logbook',
};

/** Like quick add's p1–p4: 1 is the highest. */
const PRIORITY_KEYS: Record<string, Priority> = { '1': 3, '2': 2, '3': 1, '4': 0 };

/** A text field (or anything editable) owns its keys: its ⌘A, ⌘Z and ⌘C stay native. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * The letter a key stands for: the typed one on Latin layouts, the key's place when the layout
 * types Hangul (ㅅ is T), so shortcuts keep working with the Korean input on.
 */
export function keyLetter(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return e.key;
}

/** Something that takes the keyboard for itself: a modal, the palette, quick add, help, or the task menu. */
function layerOpen(): boolean {
  const u = getUi();
  if (u.palette || u.quickAdd || u.shortcuts || u.taskMenu || u.confirmTrash) return true;
  return !!document.querySelector('[role="dialog"][aria-modal="true"]');
}

/** Any popover or menu: a key pressed while it is open must not change the tasks under it. */
function popupOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="menu"]');
}

/**
 * What a task key acts on (`actionTargets`). Nothing while focus sits in the sidebar: a Backspace
 * there is about the sidebar, not the task open in the panel.
 */
function targets(): string[] {
  const active = document.activeElement;
  if (active instanceof Element && active.closest('#app-sidebar')) return [];
  return actionTargets();
}

function hasTextSelection(): boolean {
  const sel = typeof window === 'undefined' ? null : window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
}

function isDesktop() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DESKTOP_QUERY).matches;
}

// ─────────────────────────────── focus moves (j/k, arrows, Home/End)

type Step = 'next' | 'prev' | 'first' | 'last';

/** Move focus along the list rows; with Shift the picks follow from the anchor, like Finder. */
function moveFocus(e: KeyboardEvent, step: Step, extend: boolean) {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('main [data-task-row]'));
  if (!rows.length) return;
  const active = document.activeElement;
  const curRow = active instanceof HTMLElement ? active.closest<HTMLElement>('main [data-task-row]') : null;
  // Home/End also scroll whatever has focus (the side panel): only take them from the list itself.
  if ((step === 'first' || step === 'last') && !curRow && active && active !== document.body) {
    if (!document.querySelector('main')?.contains(active)) return;
  }
  e.preventDefault();
  const cur = curRow ? rows.indexOf(curRow) : -1;
  const last = rows.length - 1;
  const next =
    step === 'first' ? 0 : step === 'last' ? last : cur < 0 ? (step === 'next' ? 0 : last) : Math.max(0, Math.min(last, cur + (step === 'next' ? 1 : -1)));
  const target = rows[next]!;
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
  if (!extend) return;
  const to = target.dataset.taskRow;
  const from = (curRow ?? target).dataset.taskRow;
  if (to && from && isPickable(to) && isPickable(from)) extendRange(pickableRowIds(), from, to);
}

// ─────────────────────────────── copy and paste

/**
 * ⌘C and ⌘V go through the document's copy and paste events (no clipboard permission needed).
 * Safari sends neither when nothing is selected or editable, so there the keydown also arms a
 * fallback through the async clipboard. Chrome and Firefox always send the event (Chrome on a Mac
 * a moment later, through its Edit menu), so they get no fallback.
 *
 * Each ⌘C / ⌘V press is one `Press`: whichever path reaches it first (the event or the fallback)
 * claims it, and the other one only keeps the browser from acting, so a press never pastes twice.
 */
interface Press {
  at: number;
  claimed: boolean;
}

/** A late event still belongs to its press within this long; after it, an event is a new paste. */
const PRESS_MS = 1000;

let copyPress: Press | null = null;
let pastePress: Press | null = null;

/** Safari and every iOS browser (all WebKit), not Chromium or Firefox. */
function sendsNoClipboardEvent(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /AppleWebKit\//.test(ua) && !/Chrome\/|Chromium\//.test(ua);
}

/** The press this event belongs to, taken off the slot so no later event finds it. */
function takePress(kind: 'copy' | 'paste'): Press | null {
  const p = kind === 'copy' ? copyPress : pastePress;
  if (kind === 'copy') copyPress = null;
  else pastePress = null;
  return p && performance.now() - p.at < PRESS_MS ? p : null;
}

function copiedMessage(n: number) {
  return n === 1 ? '작업을 복사했어요' : `작업 ${n}개를 복사했어요`;
}

function canCopy(): boolean {
  return !isTypingTarget(document.activeElement) && !layerOpen() && !popupOpen() && !hasTextSelection();
}

function onCopy(e: ClipboardEvent) {
  const press = takePress('copy');
  if (!e.clipboardData || !canCopy()) return;
  const ids = targets();
  if (!ids.length) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', textForCopy(ids));
  // The fallback already copied and said so: the same text again, without a second toast.
  if (press?.claimed) return;
  if (press) press.claimed = true;
  toast.show(copiedMessage(ids.length));
}

function onPaste(e: ClipboardEvent) {
  const press = takePress('paste');
  if (isTypingTarget(document.activeElement) || isTypingTarget(e.target) || layerOpen() || popupOpen()) return;
  const ctx = pasteContext(location.pathname);
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!ctx || !text.trim()) return;
  e.preventDefault();
  // The fallback already read the clipboard for this press: nothing more to make.
  if (press?.claimed) return;
  if (press) press.claimed = true;
  void pasteTasks(text, ctx);
}

function armCopy() {
  if (!sendsNoClipboardEvent() || !canCopy()) return;
  const ids = targets();
  if (!ids.length) return;
  const press: Press = { at: performance.now(), claimed: false };
  copyPress = press;
  window.setTimeout(() => {
    if (press.claimed) return;
    press.claimed = true;
    void copyTasks(ids);
  }, 0);
}

function armPaste() {
  if (!sendsNoClipboardEvent() || popupOpen()) return;
  const ctx = pasteContext(location.pathname);
  if (!ctx || !navigator.clipboard?.readText) return;
  const press: Press = { at: performance.now(), claimed: false };
  pastePress = press;
  window.setTimeout(() => {
    if (press.claimed) return;
    press.claimed = true;
    navigator.clipboard.readText().then(
      (text) => {
        if (text.trim()) void pasteTasks(text, ctx);
      },
      () => {}, // declined: nothing to paste
    );
  }, 0);
}

// ─────────────────────────────── to the trash from the keys

/**
 * Delete on the focused row: focus moves on to the row below (above, at the end), so the next
 * Delete takes that one instead of falling through to the task open in the panel.
 */
function trashFromKeys(ids: string[]) {
  const active = document.activeElement;
  let next: HTMLElement | null = null;
  // List rows, home board cards and timeline labels each move on to the next one of their kind.
  for (const attr of ['taskRow', 'card', 'taskFocus'] as const) {
    const sel = `main [data-${attr === 'taskRow' ? 'task-row' : attr === 'card' ? 'card' : 'task-focus'}]`;
    const holder = active instanceof HTMLElement ? active.closest<HTMLElement>(sel) : null;
    if (!holder) continue;
    if (ids.length === 1 && holder.dataset[attr] === ids[0]) {
      const all = Array.from(document.querySelectorAll<HTMLElement>(sel));
      const at = all.indexOf(holder);
      const other = (el: HTMLElement) => el.dataset[attr] !== ids[0];
      next = all.slice(at + 1).find(other) ?? all.slice(0, at).reverse().find(other) ?? null;
    }
    break;
  }
  trashTasks(ids);
  if (!next) return;
  const to = next;
  requestAnimationFrame(() => {
    // Only once the row is gone and focus fell to the page (a refused delete keeps the row focused).
    const now = document.activeElement;
    if (!to.isConnected || (now && now !== document.body)) return;
    to.focus({ preventScroll: true });
    to.scrollIntoView({ block: 'nearest' });
  });
}

// ─────────────────────────────── the keys

/** ⌘/Ctrl shortcuts. Returns true when the key was one of ours. */
function onModKey(e: KeyboardEvent, k: string): boolean {
  if (popupOpen()) return false;
  if (k === 'z' || (k === 'y' && e.ctrlKey && !e.metaKey)) {
    e.preventDefault();
    if (!e.repeat) void (k === 'y' || e.shiftKey ? redo() : undo());
    return true;
  }
  if (e.shiftKey) return false;
  if (k === 'a') {
    const ids = selectAllIds();
    // Nothing to pick: the browser's own select-all is still useful (settings, dashboards).
    if (!ids.length) return false;
    e.preventDefault();
    setPicked(ids);
    return true;
  }
  if (k === 'c') {
    armCopy();
    return false; // the copy event still has to happen
  }
  if (k === 'v') {
    armPaste();
    return false;
  }
  const isEnter = e.key === 'Enter';
  const isDelete = e.key === 'Backspace' || e.key === 'Delete';
  if (k !== 'd' && !isEnter && !isDelete) return false;
  const ids = targets();
  if (!ids.length) return false;
  e.preventDefault();
  if (e.repeat) return true;
  if (k === 'd') void duplicateTasks(ids);
  else if (isEnter) void completeTasks(ids);
  else trashFromKeys(ids);
  return true;
}

/** Single keys that change the target tasks. */
function onTaskKey(e: KeyboardEvent, k: string): boolean {
  const priority = PRIORITY_KEYS[k];
  const isDelete = k === 'Delete' || k === 'Backspace';
  if (priority === undefined && !isDelete && !['t', 'p', 'e', 'F2', 'x'].includes(k)) return false;
  if (popupOpen()) return false;
  const ids = targets();
  if (!ids.length) return false;
  e.preventDefault();
  if (e.repeat) return true;
  if (priority !== undefined) void setPriority(ids, priority);
  else if (isDelete) trashFromKeys(ids);
  else if (k === 't') moveToToday(ids);
  else if (k === 'p') postponeTasks(ids);
  else if (k === 'x') void completeTasks(ids);
  else rename(ids);
  return true;
}

/** E / F2: the title in its row; with no such row on screen (timeline, 모아보기, a folded group) the panel has the field. */
function rename(ids: string[]) {
  if (ids.length > 1) {
    toast.show('제목은 하나씩 바꿀 수 있어요');
    return;
  }
  renameTask(ids[0]!);
}

export function useShortcuts() {
  const router = useRouter();
  const gPressed = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const u = getUi();
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
      const k = keyLetter(e);
      if (mod && k === 'k') {
        e.preventDefault();
        setUi({ palette: !u.palette });
        return;
      }
      // ⌘B / Ctrl+B — collapse/expand the sidebar (sheet on small screens).
      if (mod && !e.shiftKey && k === 'b') {
        // On Apple, Ctrl+B in a text field is the native "cursor back" — leave it alone.
        if (e.ctrlKey && !e.metaKey && isApple() && isTypingTarget(e.target)) return;
        e.preventDefault();
        if (isDesktop()) toggleSidebar();
        else setUi({ nav: !u.nav });
        return;
      }
      // A row, the dashboard's edit mode or a page (휴지통) already took this key.
      if (e.defaultPrevented) return;
      if (isTypingTarget(e.target) || layerOpen()) return;
      if (mod) {
        onModKey(e, k);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (Date.now() - gPressed.current < G_WINDOW_MS) {
        gPressed.current = 0;
        const dest = e.shiftKey ? undefined : PAGES[k];
        if (dest) {
          e.preventDefault();
          router.push(dest);
          return;
        }
      }

      // Shift + a letter is not a shortcut, except J/K that extend the picks.
      if (e.shiftKey && /^[a-z]$/.test(k) && k !== 'j' && k !== 'k') return;

      switch (k) {
        case 'n':
        case 'c':
          e.preventDefault();
          setUi({ quickAdd: true });
          return;
        case '/':
          e.preventDefault();
          setUi({ palette: true });
          return;
        case '?':
          e.preventDefault();
          setUi({ shortcuts: true });
          return;
        case 'g':
          gPressed.current = Date.now();
          return;
        case 'Escape':
          if (getPicked().size) clearPicks();
          else if (getState().selectedTaskId) selectTask(null);
          else if (u.nav) setUi({ nav: false });
          return;
        case 'j':
        case 'ArrowDown':
          moveFocus(e, 'next', e.shiftKey);
          return;
        case 'k':
        case 'ArrowUp':
          moveFocus(e, 'prev', e.shiftKey);
          return;
        case 'Home':
          moveFocus(e, 'first', e.shiftKey);
          return;
        case 'End':
          moveFocus(e, 'last', e.shiftKey);
          return;
      }
      if (!e.shiftKey) onTaskKey(e, k);
    };

    // ⌘C on a key press the browser turns into the copy event; same for ⌘V and paste.
    window.addEventListener('keydown', onKey);
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, [router]);
}
