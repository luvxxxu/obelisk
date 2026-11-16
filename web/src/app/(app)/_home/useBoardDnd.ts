'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import s from '../home.module.css';
import { prefersReducedMotion } from './motion';

/**
 * Pointer-driven drag and drop for board cards (mouse, pen, and touch via long-press).
 *
 * DOM contract inside `boardRef`:
 *   [data-col="<key>"]           a column (drop target)
 *     [data-col-cards]           its card stack (position: relative — offsets are measured from it)
 *       [data-card="<id>"]       a card; the one being dragged is not rendered while it's lifted
 *       [data-placeholder]       the slot the caller renders at the landing index
 *
 * The lifted card is a DOM clone that follows the pointer on a fixed layer. On release it flies
 * into the placeholder's box, then `onDrop` commits inside flushSync so the real card replaces the
 * slot in the same frame the clone disappears.
 */

export interface BoardDrag<C extends string> {
  id: string;
  from: C;
  /** Column under the pointer; null once the pointer leaves the board (release = cancel). */
  to: C | null;
  /** Insertion index among the other cards of `to`, from the pointer's height. */
  pointerIndex: number;
  /** Where the card was picked up, among the other cards of `from`. */
  originIndex: number;
  height: number;
}

interface Options<C extends string> {
  boardRef: RefObject<HTMLElement | null>;
  /** FLIP snapshot taken before every layout-changing update. */
  capture: () => void;
  /** Commit the move. Runs synchronously, as the card lands. */
  onDrop: (drag: BoardDrag<C> & { to: C }) => void;
}

const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 260;
const EDGE = 56;
const MAX_SCROLL = 16;
const OUTSIDE = 72;

export function useBoardDnd<C extends string>({ boardRef, capture, onDrop }: Options<C>) {
  const [drag, setDragState] = useState<BoardDrag<C> | null>(null);
  const dragRef = useRef<BoardDrag<C> | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const cleanupRef = useRef<(() => void) | null>(null);
  const busy = useRef(false);

  const setDrag = useCallback((d: BoardDrag<C> | null) => {
    dragRef.current = d;
    setDragState(d);
  }, []);

  useEffect(() => () => cleanupRef.current?.(), []);

  /** Column + insertion index under (x, y), or null when the pointer is well outside the board. */
  const hitTest = useCallback(
    (x: number, y: number): { to: C; pointerIndex: number } | null => {
      const board = boardRef.current;
      if (!board) return null;
      const br = board.getBoundingClientRect();
      if (x < br.left - OUTSIDE || x > br.right + OUTSIDE || y < br.top - OUTSIDE || y > br.bottom + OUTSIDE) return null;
      let col: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const c of board.querySelectorAll<HTMLElement>('[data-col]')) {
        const r = c.getBoundingClientRect();
        const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        if (d < bestDist) {
          bestDist = d;
          col = c;
        }
      }
      if (!col) return null;
      const stack = col.querySelector<HTMLElement>('[data-col-cards]');
      let pointerIndex = 0;
      if (stack && stack.offsetParent !== null) {
        // Layout offsets ignore FLIP transforms, so the index can't flicker mid-glide.
        const rel = y - stack.getBoundingClientRect().top;
        for (const card of stack.querySelectorAll<HTMLElement>(':scope > [data-card]')) {
          if (card.offsetTop + card.offsetHeight / 2 < rel) pointerIndex++;
        }
      }
      return { to: col.dataset.col as C, pointerIndex };
    },
    [boardRef],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, id: string, from: C, originIndex: number) => {
      if (busy.current || dragRef.current || e.button !== 0 || !e.isPrimary) return;
      if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
      const wrap = e.currentTarget;
      const touch = e.pointerType === 'touch';
      const start = { x: e.clientX, y: e.clientY };
      const last = { x: e.clientX, y: e.clientY };
      let active = false;
      let layer: HTMLDivElement | null = null;
      let lift: HTMLDivElement | null = null;
      let grab = { x: 0, y: 0 };
      let raf = 0;
      let scroller: HTMLElement | null = null;
      const timer = touch ? window.setTimeout(() => activate(), LONG_PRESS_MS) : 0;

      const place = () => {
        if (layer) layer.style.transform = `translate3d(${last.x - grab.x}px, ${last.y - grab.y}px, 0)`;
      };

      const retarget = () => {
        const cur = dragRef.current;
        if (!cur) return;
        const hit = hitTest(last.x, last.y);
        const to = hit?.to ?? null;
        const pointerIndex = hit?.pointerIndex ?? cur.pointerIndex;
        if (to === cur.to && pointerIndex === cur.pointerIndex) return;
        capture();
        setDrag({ ...cur, to, pointerIndex });
      };

      const autoScroll = () => {
        const board = boardRef.current;
        if (board) {
          const br = board.getBoundingClientRect();
          let dx = 0;
          if (last.y > br.top - OUTSIDE && last.y < br.bottom + OUTSIDE) {
            if (last.x < br.left + EDGE) dx = -speed(last.x - br.left);
            else if (last.x > br.right - EDGE) dx = speed(br.right - last.x);
          }
          let dy = 0;
          if (scroller) {
            const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
            const bottom = scroller === document.scrollingElement ? window.innerHeight : scroller.getBoundingClientRect().bottom;
            if (last.y < top + EDGE) dy = -speed(last.y - top);
            else if (last.y > bottom - EDGE) dy = speed(bottom - last.y);
          }
          const beforeX = board.scrollLeft;
          const beforeY = scroller?.scrollTop ?? 0;
          if (dx) board.scrollLeft += dx;
          if (dy && scroller) scroller.scrollTop += dy;
          if (board.scrollLeft !== beforeX || (scroller?.scrollTop ?? 0) !== beforeY) retarget();
        }
        raf = requestAnimationFrame(autoScroll);
      };

      function activate() {
        if (active) return;
        active = true;
        window.clearTimeout(timer);
        const rect = wrap.getBoundingClientRect();
        grab = { x: start.x - rect.left, y: start.y - rect.top };

        layer = document.createElement('div');
        layer.className = s.dragLayer!;
        layer.style.width = `${rect.width}px`;
        layer.style.height = `${rect.height}px`;
        lift = document.createElement('div');
        lift.className = s.dragLift!;
        const clone = wrap.cloneNode(true) as HTMLElement;
        clone.removeAttribute('data-card');
        clone.removeAttribute('data-flip');
        clone.style.animation = 'none';
        lift.appendChild(clone);
        layer.appendChild(lift);
        document.body.appendChild(layer);
        place();

        scroller = scrollParent(boardRef.current);
        document.documentElement.dataset.dragging = '';
        window.getSelection()?.removeAllRanges();
        setDrag({ id, from, to: from, pointerIndex: originIndex, originIndex, height: rect.height });
        raf = requestAnimationFrame(autoScroll);
      }

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        last.x = ev.clientX;
        last.y = ev.clientY;
        if (!active) {
          const dist = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
          if (touch) {
            if (dist > TOUCH_SLOP) teardown(); // a scroll, not a press
            return;
          }
          if (dist <= MOUSE_SLOP) return;
          activate(); // …and aim right away: a fast flick may not send another move
        }
        place();
        retarget();
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        if (!active) return teardown();
        last.x = ev.clientX;
        last.y = ev.clientY;
        flushSync(retarget); // the slot must be where the pointer let go before we fly to it
        swallowNextClick();
        finish(false);
      };

      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        if (!active) return teardown();
        finish(true);
      };

      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape' || !active) return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);
      };

      // Once a long-press has lifted the card, the finger drags it instead of scrolling the page.
      const onTouchMove = (ev: TouchEvent) => {
        if (active) ev.preventDefault();
      };
      const onContextMenu = (ev: Event) => {
        if (touch) ev.preventDefault();
      };
      const onBlur = () => {
        if (active) finish(true);
        else teardown();
      };

      function finish(cancel: boolean) {
        cancelAnimationFrame(raf);
        removeListeners();
        busy.current = true;
        const cur = dragRef.current;
        let landing: BoardDrag<C> | null = cur;
        if (cur && (cancel || cur.to === null)) {
          landing = { ...cur, to: cur.from, pointerIndex: cur.originIndex };
          capture();
          flushSync(() => setDrag(landing));
        }
        const commit = () => {
          capture();
          flushSync(() => {
            if (landing && !cancel && cur?.to !== null) onDropRef.current(landing as BoardDrag<C> & { to: C });
            setDrag(null);
          });
          teardown();
          busy.current = false;
        };

        const slot = boardRef.current?.querySelector<HTMLElement>('[data-placeholder]');
        if (!layer || !lift || !slot || prefersReducedMotion()) return commit();
        const r = slot.getBoundingClientRect();
        const fly = layer.animate([{ transform: layer.style.transform }, { transform: `translate3d(${r.left}px, ${r.top}px, 0)` }], {
          duration: 200,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'forwards',
        });
        lift.animate([{ transform: getComputedStyle(lift).transform }, { transform: 'none' }], {
          duration: 200,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'forwards',
        });
        lift.classList.add(s.dragSettle!);
        fly.onfinish = commit;
        fly.oncancel = commit;
      }

      function removeListeners() {
        window.clearTimeout(timer);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('contextmenu', onContextMenu, true);
        window.removeEventListener('blur', onBlur);
      }

      function teardown() {
        cancelAnimationFrame(raf);
        removeListeners();
        layer?.remove();
        layer = null;
        delete document.documentElement.dataset.dragging;
        if (cleanupRef.current === dispose) cleanupRef.current = null;
      }

      /** Unmount (or a stray earlier session): drop everything without committing. */
      function dispose() {
        teardown();
        if (dragRef.current) setDrag(null);
        busy.current = false;
      }

      cleanupRef.current?.();
      cleanupRef.current = dispose;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('contextmenu', onContextMenu, true);
      window.addEventListener('blur', onBlur);
    },
    [boardRef, capture, hitTest, setDrag],
  );

  return { drag, onPointerDown };
}

/**
 * The click the browser fires right after a drag's pointerup must not open the card underneath.
 * Only that one click: the guard also lifts on the next press or after the current task.
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

/** Scroll speed that ramps up as the pointer gets closer to (or past) an edge. */
function speed(distToEdge: number): number {
  const t = Math.min(1, Math.max(0, (EDGE - distToEdge) / EDGE));
  return Math.round(MAX_SCROLL * t * t);
}

export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}
