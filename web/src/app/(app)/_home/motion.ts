'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

function prefersReducedMotion(): boolean {
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
