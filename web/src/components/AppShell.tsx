'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { useJevAutoPilot } from '@/lib/jev';
import { clearPicks, getPicked, useHasInlineBar } from '@/lib/selection';
import { getState, load, selectTask, startSync, useApp } from '@/lib/store';
import {
  DESKTOP_QUERY,
  isApple,
  modCombo,
  restoreSidebar,
  toggleSidebar,
  useMediaQuery,
} from '@/lib/ui-helpers';
import { getUi, setUi, useUi } from '@/lib/ui-state';
import { SelectionDock } from './BulkBar';
import { Icon, Logo } from './Icon';
import { CommandPalette, QuickAddModal, ShortcutsHelp, Toaster } from './Overlays';
import { JevDialogs } from './JevDialogs';
import { PostponeDialog } from './PostponeDialog';
import { tip, TooltipLayer, ui } from './primitives';
import { Sidebar } from './Sidebar';
import { TaskDetail } from './TaskDetail';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import s from './AppShell.module.css';

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function isDesktop() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DESKTOP_QUERY).matches;
}

function useShortcuts() {
  const router = useRouter();
  const gPressed = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const u = getUi();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setUi({ palette: !u.palette });
        return;
      }
      // ⌘B / Ctrl+B — collapse/expand the sidebar (sheet on small screens).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        // On Apple, Ctrl+B in a text field is the native "cursor back" — leave it alone.
        if (e.ctrlKey && !e.metaKey && isApple() && isTyping(e)) return;
        e.preventDefault();
        if (isDesktop()) toggleSidebar();
        else setUi({ nav: !u.nav });
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (u.palette || u.quickAdd || u.shortcuts) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;

      if (Date.now() - gPressed.current < 900) {
        const dest: Record<string, string> = {
          h: '/',
          o: '/overview',
          t: '/today',
          u: '/upcoming',
          i: '/inbox',
          f: '/forecast',
          a: '/all',
          l: '/logbook',
        };
        gPressed.current = 0;
        if (dest[e.key]) {
          e.preventDefault();
          router.push(dest[e.key]!);
          return;
        }
      }

      switch (e.key) {
        case 'n':
        case 'c':
          e.preventDefault();
          setUi({ quickAdd: true });
          break;
        case '/':
          e.preventDefault();
          setUi({ palette: true });
          break;
        case '?':
          e.preventDefault();
          setUi({ shortcuts: true });
          break;
        case 'g':
          gPressed.current = Date.now();
          break;
        case 'Escape':
          if (getPicked().size) clearPicks();
          else if (getState().selectedTaskId) selectTask(null);
          else if (u.nav) setUi({ nav: false });
          break;
        case 'j':
        case 'k':
        case 'ArrowDown':
        case 'ArrowUp': {
          const rows = Array.from(document.querySelectorAll<HTMLElement>('main [data-task-row]'));
          if (!rows.length) return;
          e.preventDefault();
          const cur = rows.indexOf(document.activeElement as HTMLElement);
          const down = e.key === 'j' || e.key === 'ArrowDown';
          const next = cur < 0 ? (down ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, cur + (down ? 1 : -1)));
          rows[next]?.focus();
          rows[next]?.scrollIntoView({ block: 'nearest' });
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);
}

/**
 * Top bar, ChatGPT style: the space switcher is the title ("개인 공간 ⌄"); nothing else competes with it.
 * When the sidebar is hidden (collapsed on desktop, sheet on phones) its two main actions, 검색 and 새 작업,
 * move up here so they are always one click away.
 */
function TopBar({ desktop, collapsed, nav }: { desktop: boolean; collapsed: boolean; nav: boolean }) {
  const sidebarHidden = !desktop || collapsed;

  return (
    <header className={s.topbar}>
      <div className={s.topLeft}>
        {desktop ? (
          collapsed && (
            <button
              className={s.topBtn}
              onClick={toggleSidebar}
              aria-label="사이드바 열기"
              aria-expanded={false}
              aria-controls="app-sidebar"
              {...tip('사이드바 열기', { side: 'bottom', kbd: modCombo('B') })}
            >
              <Icon name="panelLeft" size={18} />
            </button>
          )
        ) : (
          <button
            className={s.topBtn}
            onClick={() => setUi({ nav: true })}
            aria-label="메뉴 열기"
            aria-expanded={nav}
            aria-controls="app-sidebar"
          >
            <Icon name="menu" size={18} />
          </button>
        )}
        <WorkspaceSwitcher />
      </div>

      {sidebarHidden && (
        <div className={s.topRight}>
          <button className={s.topBtn} onClick={() => setUi({ palette: true })} aria-label="검색" {...tip('검색', { side: 'bottom', kbd: modCombo('K') })}>
            <Icon name="search" size={18} />
          </button>
          <button className={s.topBtn} onClick={() => setUi({ quickAdd: true })} aria-label="새 작업" {...tip('새 작업', { side: 'bottom', kbd: 'N' })}>
            <Icon name="squarePen" size={18} />
          </button>
        </div>
      )}
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const app = useApp();
  const { nav, sidebarCollapsed } = useUi();
  const router = useRouter();
  const pathname = usePathname();
  const desktop = useMediaQuery(DESKTOP_QUERY);

  useEffect(() => {
    if (getState().status === 'idle' || getState().status === 'unauthenticated') void load();
  }, []);
  useEffect(() => startSync(), []);
  useEffect(() => restoreSidebar(), []);
  useEffect(() => {
    if (app.status === 'unauthenticated') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [app.status, router, pathname]);
  // Growing past the sheet breakpoint closes the off-canvas sheet.
  useEffect(() => {
    if (desktop && getUi().nav) setUi({ nav: false });
  }, [desktop]);
  useShortcuts();
  // A selection belongs to the page it was made on.
  const workspaceId = app.workspace?.id;
  useEffect(() => clearPicks(), [pathname, workspaceId]);
  const inlineBar = useHasInlineBar();

  if (app.status !== 'ready') {
    return (
      <div className={s.splash}>
        {app.status === 'error' ? (
          <div className={s.splashError}>
            <span className={s.splashMark}>
              <Logo size={28} />
            </span>
            <p>{app.error}</p>
            <button className={`${ui.btn} ${ui.outline}`} onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        ) : (
          <div className={s.splashLogo}>
            <Logo size={36} />
          </div>
        )}
      </div>
    );
  }

  const collapsed = desktop && sidebarCollapsed;

  return (
    <div className={s.shell} data-panel={!!app.selectedTaskId} data-collapsed={collapsed}>
      <div id="app-sidebar" className={s.sidebar} data-open={nav} aria-hidden={collapsed || undefined} inert={collapsed || undefined}>
        <Sidebar mobile={!desktop} />
      </div>
      {nav && <div className={s.scrim} onClick={() => setUi({ nav: false })} />}

      <main className={s.main}>
        <TopBar desktop={desktop} collapsed={collapsed} nav={nav} />
        <div key={pathname} className={s.route}>
          {children}
        </div>
        <SelectionDock hidden={inlineBar} />
      </main>

      {app.selectedTaskId && (
        <>
          <div className={s.panelScrim} onClick={() => selectTask(null)} />
          <aside className={s.panel} aria-label="작업 상세">
            <TaskDetail taskId={app.selectedTaskId} />
          </aside>
        </>
      )}

      <QuickAddModal />
      <CommandPalette />
      <ShortcutsHelp />
      <PostponeDialog />
      <JevDialogs />
      <JevAutoPilot />
      <Toaster />
      <TooltipLayer />
    </div>
  );
}

/** Opt-in auto-apply of high-confidence Jev priorities (renders nothing). */
function JevAutoPilot() {
  useJevAutoPilot();
  return null;
}
