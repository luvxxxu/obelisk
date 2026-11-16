'use client';

import type { Project } from '@obelisk/core';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { longDateKo } from '@/lib/format';
import { useJevAutoPilot } from '@/lib/jev';
import { getState, load, selectTask, startSync, useApp } from '@/lib/store';
import {
  DESKTOP_QUERY,
  isApple,
  modCombo,
  pageMeta,
  projectIdFromPath,
  restoreSidebar,
  toggleSidebar,
  useMediaQuery,
} from '@/lib/ui-helpers';
import { getUi, setUi, useUi } from '@/lib/ui-state';
import { Icon, Logo } from './Icon';
import { CommandPalette, QuickAddModal, ShortcutsHelp, Toaster } from './Overlays';
import { JevDialogs } from './JevDialogs';
import { PostponeDialog } from './PostponeDialog';
import { tip, TooltipLayer, ui } from './primitives';
import { Sidebar } from './Sidebar';
import { TaskDetail } from './TaskDetail';
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
          if (getState().selectedTaskId) selectTask(null);
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

/** Header breadcrumb, Notion style: "◭ Obelisk / ☀ 오늘"; projects read "◭ Obelisk / 📁 이름". */
function Breadcrumb({ pathname, projects }: { pathname: string; projects: Project[] }) {
  const pid = projectIdFromPath(pathname);
  const project = pid ? projects.find((p) => p.id === pid) : undefined;
  const meta = pageMeta(pathname);

  let current: ReactNode = null;
  if (pid) {
    current = (
      <li className={s.crumbCurrent} aria-current="page">
        <Icon name="folder" size={16} className={s.crumbIcon} style={project ? { color: `var(--c-${project.color})` } : undefined} />
        <span className={s.crumbText}>{project?.name ?? '프로젝트'}</span>
      </li>
    );
  } else if (meta && pathname !== '/') {
    current = (
      <li className={s.crumbCurrent} aria-current="page">
        <Icon name={meta.icon} size={16} className={s.crumbIcon} />
        <span className={s.crumbText}>{meta.label}</span>
      </li>
    );
  }

  return (
    <nav className={s.crumbs} aria-label="현재 위치">
      <ol>
        <li className={s.crumbRoot}>
          <Link href="/" className={s.crumbLink} aria-current={pathname === '/' ? 'page' : undefined}>
            <span className={s.crumbMark}>
              <Logo size={11} />
            </span>
            <span className={s.crumbText}>{pathname === '/' ? '홈' : 'Obelisk'}</span>
          </Link>
        </li>
        {pathname === '/settings/ai' && (
          <>
            <li className={s.crumbSep} aria-hidden="true">
              /
            </li>
            <li>
              <Link href="/settings" className={s.crumbLink}>
                <Icon name="settings" size={16} className={s.crumbIcon} />
                <span className={s.crumbText}>설정</span>
              </Link>
            </li>
          </>
        )}
        {current && (
          <>
            <li className={s.crumbSep} aria-hidden="true">
              /
            </li>
            {current}
          </>
        )}
      </ol>
    </nav>
  );
}

function TopBar({ desktop, collapsed, nav }: { desktop: boolean; collapsed: boolean; nav: boolean }) {
  const app = useApp();
  const pathname = usePathname();

  return (
    <header className={s.topbar}>
      <div className={s.topLeft}>
        {desktop ? (
          collapsed && (
            <button
              className={s.topBtn}
              onClick={toggleSidebar}
              aria-label="사이드바 펼치기"
              aria-expanded={false}
              aria-controls="app-sidebar"
              {...tip('사이드바 펼치기', { side: 'bottom', kbd: modCombo('B') })}
            >
              <Icon name="chevronsRight" size={18} />
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
        <Breadcrumb pathname={pathname} projects={app.projects} />
      </div>

      <div className={s.topRight}>
        <span className={s.topDate}>{longDateKo(app.today)}</span>
        <button
          className={s.topText}
          onClick={() => setUi({ quickAdd: true })}
          aria-label="새 작업"
          {...tip('새 작업 추가', { side: 'bottom', kbd: 'N' })}
        >
          <Icon name="plus" size={16} />
          <span className={s.topTextLabel}>새 작업</span>
        </button>
        <button
          className={s.topBtn}
          onClick={() => setUi({ palette: true })}
          aria-label="검색"
          {...tip('검색', { side: 'bottom', kbd: modCombo('K') })}
        >
          <Icon name="search" size={17} />
        </button>
        <button
          className={s.topBtn}
          onClick={() => setUi({ shortcuts: true })}
          aria-label="단축키"
          {...tip('단축키', { side: 'bottom', kbd: '?' })}
        >
          <Icon name="more" size={18} strokeWidth={2.4} />
        </button>
      </div>
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
      </main>

      {app.selectedTaskId && (
        <>
          <div className={s.panelScrim} onClick={() => selectTask(null)} />
          <aside className={s.panel} aria-label="작업 상세">
            <TaskDetail taskId={app.selectedTaskId} />
          </aside>
        </>
      )}

      <button className={s.fab} onClick={() => setUi({ quickAdd: true })} aria-label="새 작업">
        <Icon name="plus" size={22} strokeWidth={2.2} />
      </button>

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
