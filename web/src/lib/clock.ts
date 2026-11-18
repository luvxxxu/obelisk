'use client';

import { nowIn, type Clock } from '@obelisk/core';
import { useSyncExternalStore } from 'react';
import { getState } from './store';

/**
 * The user's wall clock (date + minutes past midnight in their time zone), ticking on the minute.
 * Only components that show a time-sensitive label subscribe, so a list of all-day tasks never
 * re-renders on the tick.
 */
let current: Clock | null = null;
let currentZone = '';
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function zone(): string {
  return getState().user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function read(): Clock {
  const z = zone();
  const next = nowIn(z);
  if (!current || currentZone !== z || current.date !== next.date || current.minutes !== next.minutes) {
    current = next;
    currentZone = z;
  }
  return current;
}

function tick() {
  const before = current;
  read();
  if (current !== before) for (const l of listeners) l();
}

function schedule() {
  timer = setTimeout(
    () => {
      tick();
      schedule();
    },
    60_000 - (Date.now() % 60_000) + 50,
  );
}

const onVisible = () => {
  if (document.visibilityState === 'visible') tick();
};

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) {
    schedule();
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size) {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

const still = () => () => {};

/** `live = false` reads the clock once without re-rendering on every minute. */
export function useClock(live = true): Clock {
  return useSyncExternalStore(live ? subscribe : still, read, read);
}

export function clockNow(): Clock {
  return read();
}
