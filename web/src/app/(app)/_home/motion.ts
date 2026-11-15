'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Animated integer: counts from the previous value (0 on mount) to `value` with an ease-out curve.
 * Jumps straight to the value when the user prefers reduced motion.
 */
export function useCountUp(value: number, duration = 750): number {
  const [n, setN] = useState(() => (prefersReducedMotion() ? value : 0));
  const shown = useRef(n);

  useEffect(() => {
    if (prefersReducedMotion()) {
      shown.current = value;
      setN(value);
      return;
    }
    const from = shown.current;
    if (from === value) return;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = Math.round(from + (value - from) * eased);
      shown.current = next;
      setN(next);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return n;
}

/** Stagger index for `.reveal` blocks: style={stagger(2)} → animation-delay = 2 × step. */
export function stagger(i: number): CSSProperties {
  return { '--i': i } as CSSProperties;
}

const FLIP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * FLIP for reordering: call the returned `capture()` right before a state change that moves
 * `[data-flip="<id>"]` elements inside `root`; after the next commit each one glides from where
 * it was to where it landed (even into another column — ids are matched, not DOM nodes).
 * Elements marked `data-flip-still` are measured but never animated (the drag placeholder).
 */
export function useFlip(root: RefObject<HTMLElement | null>): () => void {
  const snap = useRef<{ at: number; rects: Map<string, DOMRect> } | null>(null);

  const capture = useCallback(() => {
    const el = root.current;
    if (!el || prefersReducedMotion()) return;
    const rects = new Map<string, DOMRect>();
    el.querySelectorAll<HTMLElement>('[data-flip]').forEach((n) => rects.set(n.dataset.flip!, n.getBoundingClientRect()));
    snap.current = { at: performance.now(), rects };
  }, [root]);

  useLayoutEffect(() => {
    const s = snap.current;
    const el = root.current;
    if (!s || !el) return;
    snap.current = null;
    if (performance.now() - s.at > 800) return; // the change never re-rendered us; don't replay stale rects
    el.querySelectorAll<HTMLElement>('[data-flip]').forEach((n) => {
      if (n.dataset.flipStill !== undefined) return;
      const before = s.rects.get(n.dataset.flip!);
      if (!before) return;
      // Stop an in-flight glide (and a remounted card's entrance) so we measure the real layout box.
      n.getAnimations().forEach((a) => a.cancel());
      const after = n.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: FLIP_EASE });
    });
  });

  return capture;
}
