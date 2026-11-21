'use client';

import type { Announcement } from '@obelisk/core';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useJevAutoPilot } from '@/lib/jev';
import { clearPicks, useHasInlineBar } from '@/lib/selection';
import { useShortcuts } from '@/lib/shortcuts';
import { getState, load, selectTask, startSync, useApp } from '@/lib/store';
import { DESKTOP_QUERY, modCombo, restoreSidebar, toggleSidebar, useMediaQuery } from '@/lib/ui-helpers';
import { getUi, setUi, useUi } from '@/lib/ui-state';
import { SelectionDock } from './BulkBar';
import { Icon, Logo } from './Icon';
import { GateScreen } from './GateScreen';
import { ListGestures } from './ListGestures';
import { CommandPalette, QuickAddModal, ShortcutsHelp, Toaster } from './Overlays';
import { JevDialogs } from './JevDialogs';
import { CommitDialog } from './CommitDialog';
import { ActualDialog, RunningPill } from './TimeTracking';
import { watchRunning } from '@/lib/timeplan';
import { PostponeDialog } from './PostponeDialog';
import { tip, TooltipLayer, ui } from './primitives';
import { Sidebar } from './Sidebar';
import { TaskDetail } from './TaskDetail';
import { TaskMenuLayer, TrashConfirm } from './TaskMenu';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import s from './AppShell.module.css';

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

      <div className={s.topRight}>
        <RunningPill />
        {sidebarHidden && (
          <>
            <button className={s.topBtn} onClick={() => setUi({ palette: true })} aria-label="검색" {...tip('검색', { side: 'bottom', kbd: modCombo('K') })}>
              <Icon name="search" size={18} />
            </button>
            <button className={s.topBtn} onClick={() => setUi({ quickAdd: true })} aria-label="새 작업" {...tip('새 작업', { side: 'bottom', kbd: 'N' })}>
              <Icon name="squarePen" size={18} />
            </button>
          </>
        )}
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
  // The page scroller: list gestures listen on it and auto-scroll it.
  const [main, setMain] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (getState().status === 'idle' || getState().status === 'unauthenticated') void load();
  }, []);
  useEffect(() => startSync(), []);
  useEffect(() => (app.status === 'ready' ? watchRunning() : undefined), [app.status]);
  useEffect(() => restoreSidebar(), []);
  useEffect(() => {
    if (app.status === 'unauthenticated') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [app.status, router, pathname]);
  // Growing past the sheet breakpoint closes the off-canvas sheet.
  useEffect(() => {
    if (desktop && getUi().nav) setUi({ nav: false });
  }, [desktop]);
  useShortcuts();
  // A selection (and a rename or menu on one of its rows) belongs to the page it was made on.
  const workspaceId = app.workspace?.id;
  useEffect(() => {
    clearPicks();
    const u = getUi();
    if (u.renaming || u.taskMenu) setUi({ renaming: null, taskMenu: null });
  }, [pathname, workspaceId]);
  const inlineBar = useHasInlineBar();

  if (app.status === 'gated' && app.gate) return <GateScreen gate={app.gate} />;

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

      <main className={s.main} ref={setMain}>
        {app.server.announcement && <NoticeBanner notice={app.server.announcement} />}
        <TopBar desktop={desktop} collapsed={collapsed} nav={nav} />
        <div key={pathname} className={s.route}>
          {children}
        </div>
        {/* 휴지통 draws its own bar for its rows. */}
        <SelectionDock hidden={inlineBar || pathname.startsWith('/trash')} />
      </main>
      <ListGestures main={main} />

      {app.selectedTaskId && (
        <>
          <div className={s.panelScrim} onClick={() => selectTask(null)} />
          <aside className={s.panel} aria-label="작업 상세" data-task-panel="">
            <TaskDetail taskId={app.selectedTaskId} />
          </aside>
        </>
      )}

      <QuickAddModal />
      <CommandPalette />
      <ShortcutsHelp />
      <PostponeDialog />
      <JevDialogs />
      <CommitDialog />
      <ActualDialog />
      <JevAutoPilot />
      <TaskMenuLayer />
      <TrashConfirm />
      <Toaster />
      <TooltipLayer />
    </div>
  );
}

const NOTICE_KEY = 'obelisk:notice-dismissed';

/**
 * The operators' announcement, one quiet line above the top bar. Closing it hides this one in this
 * browser; a changed announcement shows again.
 */
function NoticeBanner({ notice }: { notice: Announcement }) {
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(NOTICE_KEY) === notice.at);
    } catch {
      setHidden(false);
    }
  }, [notice.at]);
  if (hidden) return null;
  return (
    <div className={s.notice} role="status">
      <Icon name="info" size={15} className={s.noticeIcon} />
      <p className={s.noticeText}>{notice.text}</p>
      <button
        className={s.noticeClose}
        aria-label="공지 닫기"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(NOTICE_KEY, notice.at);
          } catch {}
        }}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

/** Opt-in auto-apply of high-confidence Jev priorities (renders nothing). */
function JevAutoPilot() {
  useJevAutoPilot();
  return null;
}
