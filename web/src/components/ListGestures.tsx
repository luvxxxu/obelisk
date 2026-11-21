'use client';

import { useEffect, useRef } from 'react';
import { clearPicks, closedSomething, getPicked, isPickable, pickableRowIds, pickSpan, setPicked } from '@/lib/selection';
import { getState } from '@/lib/store';
import { dropTasksOn, openTaskMenu } from '@/lib/task-actions';
import { isApple } from '@/lib/ui-helpers';
import s from './ListGestures.module.css';

/**
 * Mouse gestures on the list rows inside `main` (pen too; never touch, where a drag is a scroll):
 *
 * - sweep: press on a row that is not picked and drag, the rows between become picked
 * - box: press on empty space (gutters, between groups, under the list) and drag, every row the
 *   box touches becomes picked; a plain click there drops the picks
 * - drag: press on a picked row and drag, the picks travel to a `[data-task-drop]` target in the
 *   sidebar (인박스, 오늘, a project)
 * - right-click on a row opens the task menu (for the picks when the row is one of them)
 *
 * ⌘/Ctrl or Shift at the press adds to the picks instead of replacing them. The timeline
 * (`data-gesture="off"`) has its own bars and Shift+drag box, so it is left alone.
 */

/** Movement before a press becomes a gesture (below it, it is a click). */
const SLOP = 5;
/** Auto-scroll zone at the top and bottom of `main`, and the fastest step per frame. */
const EDGE = 48;
const MAX_SCROLL = 16;
/** Presses this close to `main`'s right edge are on its scrollbar. */
const SCROLLBAR = 16;
/** A press here is a click on something, never the start of a gesture. */
const NO_GESTURE =
  'button, a, input, textarea, select, label, summary, header, [contenteditable="true"], [role="button"], [role="toolbar"], [role="menu"], [role="dialog"], [role="slider"], [role="status"], [data-gesture="off"]';

type Mode = 'sweep' | 'box' | 'drag';

interface Session {
  pointerId: number;
  mode: Mode;
  active: boolean;
  /** Esc went in mid-gesture: the release only has to swallow its click. */
  cancelled: boolean;
  /** The press's event time, to tell whether it only closed a menu or a popover. */
  pressedAt: number;
  start: { x: number; y: number };
  /** `main.scrollTop` at the press, so the box's corner stays on the content while it scrolls. */
  startScroll: number;
  last: { x: number; y: number };
  /** Picks when the press happened (Esc puts them back). */
  before: ReadonlySet<string>;
  /** What a sweep or a box adds to: the picks with ⌘/Shift held, else nothing. */
  base: ReadonlySet<string>;
  /** Sweep: the pressed row; the range is drawn from it. */
  from: string | null;
  /** Sweep: the row the range currently ends on. */
  over: string | null;
  /** Drag: the tasks being carried. */
  ids: string[];
  drop: HTMLElement | null;
  /** Something moved since the last frame (pointer or scroll). */
  dirty: boolean;
  lastScroll: number;
  /** No list to box-pick from here (timeline, 모아보기): a plain click still lets go of the picks, a drag is left to the page. */
  clickOnly: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

function speed(distToEdge: number): number {
  const t = Math.min(1, Math.max(0, (EDGE - distToEdge) / EDGE));
  return Math.round(MAX_SCROLL * t * t);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * The click the browser fires right after a gesture's release must not open the row under it.
 * Only that one: the guard also lifts on the next press or once the current task is done.
 */
function swallowNextClick() {
  const swallow = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
    off();
  };
  const off = () => {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerdown', off, true);
  };
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerdown', off, true);
  window.setTimeout(off, 0);
}

/** Rows that can be picked, in DOM order (a task listed twice appears twice). */
function rowEls(main: HTMLElement): HTMLElement[] {
  return Array.from(main.querySelectorAll<HTMLElement>('[data-task-row]')).filter((el) => isPickable(el.dataset.taskRow ?? ''));
}

/** The row whose band is nearest to `y` (the pointer may be between rows, above the list or outside `main`). */
function rowNearest(els: HTMLElement[], y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestDist = Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bestDist) {
      best = el;
      bestDist = d;
      if (d === 0) break;
    }
  }
  return best;
}

/** A `[data-task-drop]` under the point, unless it sits in a hidden (inert) sidebar. */
function dropAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-task-drop]') ?? null;
  return el && !el.closest('[inert]') ? el : null;
}

export function ListGestures({ main }: { main: HTMLElement | null }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!main) return;
    let session: Session | null = null;
    let raf = 0;

    const topEdge = () => {
      // The sticky top bar covers the first stretch of `main`.
      const bar = main.querySelector<HTMLElement>(':scope > header');
      return bar ? bar.getBoundingClientRect().bottom : main.getBoundingClientRect().top;
    };

    const autoScroll = (ss: Session) => {
      const top = topEdge();
      const bottom = main.getBoundingClientRect().bottom;
      const y = ss.last.y;
      const dy = y < top + EDGE ? -speed(y - top) : y > bottom - EDGE ? speed(bottom - y) : 0;
      if (dy) main.scrollTop += dy;
    };

    const drawBox = (ss: Session) => {
      const box = boxRef.current;
      if (!box) return;
      const y0 = ss.start.y - (main.scrollTop - ss.startScroll);
      const m = main.getBoundingClientRect();
      const top = Math.max(Math.min(y0, ss.last.y), topEdge());
      const bottom = Math.min(Math.max(y0, ss.last.y), m.bottom);
      const left = Math.max(Math.min(ss.start.x, ss.last.x), m.left);
      const right = Math.min(Math.max(ss.start.x, ss.last.x), m.right);
      box.hidden = bottom <= top || right <= left;
      box.style.transform = `translate(${left}px, ${top}px)`;
      box.style.width = `${Math.max(0, right - left)}px`;
      box.style.height = `${Math.max(0, bottom - top)}px`;
      // Rows are hit against the whole box, also the part scrolled out of view.
      const hitTop = Math.min(y0, ss.last.y);
      const hitBottom = Math.max(y0, ss.last.y);
      const next = new Set(ss.base);
      for (const el of rowEls(main)) {
        const r = el.getBoundingClientRect();
        if (r.bottom < hitTop || r.top > hitBottom || r.right < Math.min(ss.start.x, ss.last.x) || r.left > Math.max(ss.start.x, ss.last.x)) continue;
        next.add(el.dataset.taskRow!);
      }
      if (!sameSet(next, getPicked())) setPicked(next);
    };

    const sweep = (ss: Session) => {
      const el = rowNearest(rowEls(main), ss.last.y);
      const id = el?.dataset.taskRow;
      if (!id || id === ss.over || !ss.from) return;
      ss.over = id;
      pickSpan(pickableRowIds(), ss.from, id, ss.base);
    };

    const aim = (ss: Session) => {
      const label = labelRef.current;
      if (label) {
        label.hidden = false;
        label.style.transform = `translate(${ss.last.x + 14}px, ${ss.last.y + 16}px)`;
      }
      const drop = dropAt(ss.last.x, ss.last.y);
      if (drop === ss.drop) return;
      ss.drop?.removeAttribute('data-drop-active');
      drop?.setAttribute('data-drop-active', 'true');
      ss.drop = drop;
    };

    const frame = () => {
      raf = 0;
      const ss = session;
      if (!ss?.active || ss.cancelled) return;
      if (ss.mode !== 'drag') autoScroll(ss);
      if (main.scrollTop !== ss.lastScroll) {
        ss.lastScroll = main.scrollTop;
        ss.dirty = true;
      }
      if (ss.dirty) {
        ss.dirty = false;
        if (ss.mode === 'sweep') sweep(ss);
        else if (ss.mode === 'box') drawBox(ss);
        else aim(ss);
      }
      raf = requestAnimationFrame(frame);
    };

    const hideVisuals = (ss: Session) => {
      cancelAnimationFrame(raf);
      raf = 0;
      if (boxRef.current) boxRef.current.hidden = true;
      if (labelRef.current) labelRef.current.hidden = true;
      ss.drop?.removeAttribute('data-drop-active');
      ss.drop = null;
    };

    const activate = (ss: Session) => {
      ss.active = true;
      ss.dirty = true;
      document.documentElement.dataset[ss.mode === 'drag' ? 'dragging' : 'selecting'] = '';
      window.getSelection()?.removeAllRanges();
      // Keep the moves coming when the pointer leaves the window, and no hover flicker on the way.
      try {
        main.setPointerCapture(ss.pointerId);
      } catch {}
      if (ss.mode === 'drag' && labelRef.current) labelRef.current.textContent = `작업 ${ss.ids.length}개`;
      raf = requestAnimationFrame(frame);
    };

    const end = () => {
      const ss = session;
      if (!ss) return;
      hideVisuals(ss);
      // Kept until the button is up, also after Esc, so the rest of the drag does not select text.
      delete document.documentElement.dataset.selecting;
      delete document.documentElement.dataset.dragging;
      try {
        if (main.hasPointerCapture(ss.pointerId)) main.releasePointerCapture(ss.pointerId);
      } catch {}
      session = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onCancel);
      document.removeEventListener('selectstart', onSelectStart, true);
    };

    const onSelectStart = (e: Event) => {
      if (session?.active) e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      const ss = session;
      if (!ss || e.pointerId !== ss.pointerId) return;
      if (ss.cancelled) {
        window.getSelection()?.removeAllRanges();
        return;
      }
      ss.last = { x: e.clientX, y: e.clientY };
      ss.dirty = true;
      if (!ss.active) {
        if (Math.hypot(e.clientX - ss.start.x, e.clientY - ss.start.y) < SLOP) return;
        if (ss.clickOnly) return void end();
        activate(ss);
      }
      window.getSelection()?.removeAllRanges();
    };

    const onUp = (e: PointerEvent) => {
      const ss = session;
      if (!ss || e.pointerId !== ss.pointerId) return;
      if (!ss.active) {
        // A plain click on empty space lets go of the picks (unless it only closed a menu or a
        // popover); on a row the row's own click decides.
        if (ss.mode === 'box' && !ss.cancelled && !closedSomething(ss.pressedAt)) clearPicks();
        end();
        return;
      }
      swallowNextClick();
      if (ss.mode === 'drag' && !ss.cancelled) {
        const target = dropAt(e.clientX, e.clientY)?.dataset.taskDrop;
        const ids = ss.ids;
        end();
        if (target) void dropTasksOn(target, ids);
        return;
      }
      end();
    };

    /** The pointer was taken away (window lost focus, the OS cancelled it): no drop; picks so far stay. */
    const onCancel = (e: Event) => {
      if (e instanceof PointerEvent && session && e.pointerId !== session.pointerId) return;
      end();
    };

    const onKey = (e: KeyboardEvent) => {
      const ss = session;
      if (e.key !== 'Escape' || !ss?.active || ss.cancelled) return;
      e.preventDefault();
      e.stopPropagation(); // the shell's Esc would also drop the picks
      ss.cancelled = true;
      hideVisuals(ss);
      if (ss.mode !== 'drag') setPicked(ss.before);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.isPrimary || e.pointerType === 'touch') return;
      // Control-click is the Mac's right click: the context menu takes it.
      if (e.ctrlKey && isApple()) return;
      if (session) end();
      const target = e.target instanceof Element ? e.target : null;
      if (!target || target.closest(NO_GESTURE)) return;
      // Its scrollbar (overlay ones too) runs along the right edge.
      if (e.clientX > main.getBoundingClientRect().right - SCROLLBAR) return;
      const row = target.closest<HTMLElement>('[data-task-row]');
      const additive = e.metaKey || e.ctrlKey || e.shiftKey;
      const picks = getPicked();
      let mode: Mode;
      let ids: string[] = [];
      let from: string | null = null;
      if (row) {
        const id = row.dataset.taskRow ?? '';
        if (!isPickable(id)) return;
        const tasks = getState().tasks;
        ids = picks.has(id) ? [...picks].filter((p) => tasks[p]) : [];
        // Picked rows travel; on 휴지통 (not in the task list) they have nowhere to go, so a drag sweeps.
        mode = ids.length ? 'drag' : 'sweep';
        from = id;
      } else {
        // A box only where there is a list to pick from (not 모아보기); elsewhere a drag stays a text selection.
        mode = 'box';
      }
      const clickOnly = mode === 'box' && !rowEls(main).length;
      const at = { x: e.clientX, y: e.clientY };
      session = {
        pointerId: e.pointerId,
        mode,
        active: false,
        cancelled: false,
        pressedAt: e.timeStamp,
        start: at,
        startScroll: main.scrollTop,
        last: at,
        before: picks,
        base: additive ? picks : EMPTY,
        from,
        over: null,
        ids,
        drop: null,
        dirty: false,
        lastScroll: main.scrollTop,
        clickOnly,
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', onCancel);
      document.addEventListener('selectstart', onSelectStart, true);
    };

    const onContextMenu = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || session?.active) return;
      // Fields and links keep the browser's menu (paste, open in a new tab); the timeline has its own.
      if (target.closest('input, textarea, select, a, [contenteditable="true"], [data-gesture="off"]')) return;
      const row = target.closest<HTMLElement>('[data-task-row]');
      const id = row?.dataset.taskRow;
      const tasks = getState().tasks;
      if (!row || !id || !tasks[id]) return;
      e.preventDefault();
      const picks = getPicked();
      const ids = picks.has(id) ? [...picks].filter((p) => tasks[p]) : [id];
      // The context-menu key has no pointer position: open under the row instead.
      let { clientX: x, clientY: y } = e;
      if (x === 0 && y === 0) {
        const r = row.getBoundingClientRect();
        x = r.left + 24;
        y = r.bottom;
      }
      openTaskMenu(x, y, ids);
    };

    main.addEventListener('pointerdown', onDown);
    main.addEventListener('contextmenu', onContextMenu);
    return () => {
      main.removeEventListener('pointerdown', onDown);
      main.removeEventListener('contextmenu', onContextMenu);
      end();
    };
  }, [main]);

  return (
    <>
      <div ref={boxRef} className={s.box} hidden aria-hidden="true" />
      <div ref={labelRef} className={s.dragLabel} hidden aria-hidden="true" />
    </>
  );
}
