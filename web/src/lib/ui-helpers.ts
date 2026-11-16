'use client';

/**
 * Pure presentation helpers shared by the shell and pages (no data mutations).
 * - PAGE_META / pageMeta(): Korean page names + icons for the header breadcrumb and nav.
 * - Sidebar collapse persistence (localStorage `obelisk:sidebar`).
 * - Theme preference helpers mirroring settings/page.tsx (localStorage `obelisk-theme` + dataset.theme).
 * - useMediaQuery, modKey (⌘ on Apple, Ctrl elsewhere).
 */

import { useSyncExternalStore } from 'react';
import type { IconName } from '@/components/Icon';
import { getUi, setUi } from './ui-state';

/* ───────────── pages */

export interface PageMeta {
  label: string;
  icon: IconName;
}

export const PAGE_META: Record<string, PageMeta> = {
  '/': { label: '홈', icon: 'home' },
  '/today': { label: '오늘', icon: 'sun' },
  '/inbox': { label: '인박스', icon: 'inbox' },
  '/upcoming': { label: '예정', icon: 'calendar' },
  '/mine': { label: '내 작업', icon: 'user' },
  '/all': { label: '전체 작업', icon: 'layers' },
  '/forecast': { label: '파급 예측', icon: 'ripple' },
  '/logbook': { label: '완료 기록', icon: 'checkCircle' },
  '/settings': { label: '설정', icon: 'settings' },
  '/settings/ai': { label: 'AI 연결', icon: 'sparkle' },
  '/settings/org': { label: '조직 설정', icon: 'building' },
};

/** Static page meta for a pathname (projects are resolved by the caller). */
export function pageMeta(pathname: string): PageMeta | null {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PAGE_META[clean] ?? null;
}

/** Project id from `/projects/[id]`, else null. */
export function projectIdFromPath(pathname: string): string | null {
  const m = /^\/projects\/([^/]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/* ───────────── platform */

export function isApple(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

/** Modifier key label for shortcut hints: "⌘" on Apple devices, "Ctrl" elsewhere. */
export function modKey(): string {
  return isApple() ? '⌘' : 'Ctrl';
}

/** "⌘K" on Apple devices, "Ctrl K" elsewhere. */
export function modCombo(key: string): string {
  return isApple() ? `⌘${key}` : `Ctrl ${key}`;
}

/* ───────────── media queries */

export function useMediaQuery(query: string, serverValue = true): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : serverValue),
    () => serverValue,
  );
}

/** ≥ 900px: docked sidebar (expanded or icon rail). Below: off-canvas sheet. */
export const DESKTOP_QUERY = '(min-width: 900px)';

/* ───────────── sidebar collapse */

export const SIDEBAR_STORAGE_KEY = 'obelisk:sidebar';

export function restoreSidebar() {
  try {
    const v = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (v === 'collapsed' || v === 'expanded') setUi({ sidebarCollapsed: v === 'collapsed' });
  } catch {}
}

export function setSidebarCollapsed(collapsed: boolean) {
  setUi({ sidebarCollapsed: collapsed });
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {}
}

export function toggleSidebar() {
  setSidebarCollapsed(!getUi().sidebarCollapsed);
}

/* ───────────── theme (same storage + dataset logic as settings/page.tsx) */

export type ThemePref = 'system' | 'light' | 'dark';

export function readThemePref(): ThemePref {
  try {
    const t = localStorage.getItem('obelisk-theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {}
  return 'system';
}

function setThemePref(t: ThemePref) {
  try {
    if (t === 'system') {
      localStorage.removeItem('obelisk-theme');
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem('obelisk-theme', t);
      document.documentElement.dataset.theme = t;
    }
  } catch {}
}

/**
 * Apply a theme preference. With an `origin` (the click point) and View Transitions support,
 * the new theme spreads from that point as a circle; otherwise it swaps instantly.
 */
export function applyThemePref(t: ThemePref, origin?: { x: number; y: number }) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!origin || !doc.startViewTransition || reduced) {
    setThemePref(t);
    return;
  }
  const { x, y } = origin;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const root = document.documentElement.style;
  root.setProperty('--vt-x', `${x}px`);
  root.setProperty('--vt-y', `${y}px`);
  root.setProperty('--vt-r', `${r}px`);
  doc.startViewTransition(() => setThemePref(t));
}
