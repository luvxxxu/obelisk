'use client';

import {
  addDays,
  compareTasks,
  forecast,
  formatRelativeKo,
  isOverdue,
  isToday,
  PROJECT_COLORS,
  type ProjectColor,
} from '@obelisk/core';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { createProject, planItems, reset, selectTask, useApp } from '@/lib/store';
import { setUi } from '@/lib/ui-state';
import {
  applyThemePref,
  modCombo,
  PAGE_META,
  readThemePref,
  setSidebarCollapsed,
  type ThemePref,
} from '@/lib/ui-helpers';
import { Icon, Logo, type IconName } from './Icon';
import { Popover, tip, ui, useDisclosure } from './primitives';
import s from './Sidebar.module.css';

type Tone = 'danger' | 'warn';

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  count?: number;
  tone?: Tone;
}

const THEMES: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: 'light', label: '라이트', icon: 'sun' },
  { value: 'dark', label: '다크', icon: 'moon' },
  { value: 'system', label: '시스템', icon: 'monitor' },
];

/** Fixed commitments listed under "다가오는 일정". */
const EVENT_HORIZON_DAYS = 14;
const EVENT_CAP = 3;

function page(href: string, extra?: Partial<NavItem>): NavItem {
  const meta = PAGE_META[href]!;
  return { href, label: meta.label, icon: meta.icon, ...extra };
}

/**
 * ChatGPT-style sidebar: logo · 새 작업 · 검색 · pages · 프로젝트 · 다가오는 일정 · account.
 * Plain 36px rows with a quiet hover fill; counts are muted numbers (red only when something is overdue).
 * Desktop collapse hides it completely (the top bar brings it back); on small screens it is a sheet.
 */
export function Sidebar({ mobile = false }: { collapsed?: boolean; mobile?: boolean }) {
  const app = useApp();
  const pathname = usePathname();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [theme, setTheme] = useState<ThemePref>('system');
  const userRef = useRef<HTMLButtonElement>(null);
  const menu = useDisclosure();

  const data = useMemo(() => {
    const list = Object.values(app.tasks);
    const active = list.filter((t) => t.status === 'todo' || t.status === 'doing');
    const byProject = new Map<string, number>();
    for (const t of active) if (t.projectId) byProject.set(t.projectId, (byProject.get(t.projectId) ?? 0) + 1);
    const fc = forecast(planItems(app), app.deps, app.today);
    const horizon = addDays(app.today, EVENT_HORIZON_DAYS);
    const events = active
      .filter((t) => t.fixed)
      .map((t) => {
        const last = t.dueDate ?? t.startDate;
        const date = t.startDate && t.startDate >= app.today ? t.startDate : last;
        return { task: t, date, last };
      })
      .filter((e): e is { task: typeof e.task; date: string; last: string } => !!e.date && !!e.last && e.last >= app.today && e.date <= horizon)
      .sort((a, b) => a.date.localeCompare(b.date) || compareTasks(a.task, b.task));
    return {
      mine: active.filter((t) => t.assigneeId && t.assigneeId === app.user?.id).length,
      today: list.filter((t) => isToday(t, app.today)).length,
      overdue: list.filter((t) => isOverdue(t, app.today)).length,
      inbox: active.filter((t) => !t.projectId).length,
      risk: fc.summary.delayedCount + fc.summary.conflictCount,
      conflicts: fc.summary.conflictCount,
      byProject,
      events,
    };
  }, [app]);

  const org = app.workspace?.kind === 'org';
  const pages: NavItem[] = [
    page('/'),
    // 모아보기 gathers every space, so it only earns a place once there is more than one.
    ...(app.workspaces.length > 1 ? [page('/overview')] : []),
    page('/inbox', { count: data.inbox || undefined }),
    page('/today', { count: data.today || undefined, tone: data.overdue ? 'danger' : undefined }),
    page('/upcoming'),
    ...(org ? [page('/mine', { count: data.mine || undefined })] : []),
    page('/all'),
    page('/forecast', { count: data.risk || undefined, tone: data.conflicts ? 'danger' : data.risk ? 'warn' : undefined }),
    page('/logbook'),
  ];

  const projects = app.projects.filter((p) => !p.archivedAt).sort((a, b) => a.position - b.position);
  const canCreate = app.workspace?.canCreateProjects ?? true;

  const submitProject = async () => {
    const n = name.trim();
    setAdding(false);
    setName('');
    if (!n) return;
    const color = PROJECT_COLORS[(projects.length + 6) % PROJECT_COLORS.length] as ProjectColor;
    const p = await createProject({ name: n, color });
    if (p) router.push(`/projects/${p.id}`);
  };

  const close = () => setUi({ nav: false });

  const toggleMenu = () => {
    if (!menu.open) setTheme(readThemePref());
    menu.toggle();
  };

  const initial = app.user?.name.slice(0, 1).toUpperCase();
  const visibleEvents = data.events.slice(0, EVENT_CAP);

  return (
    <nav className={s.sidebar} data-mobile={mobile} aria-label="주 메뉴">
      {/* ───── top: logo · collapse */}
      <div className={s.top}>
        <Link href="/" className={s.logo} onClick={close} aria-label="Obelisk 홈">
          <Logo size={20} />
        </Link>
        {mobile ? (
          <button className={s.topBtn} onClick={close} aria-label="메뉴 닫기">
            <Icon name="x" size={18} />
          </button>
        ) : (
          <button
            className={s.topBtn}
            onClick={() => setSidebarCollapsed(true)}
            aria-label="사이드바 닫기"
            {...tip('사이드바 닫기', { side: 'right', kbd: modCombo('B') })}
          >
            <Icon name="panelLeft" size={18} />
          </button>
        )}
      </div>

      {/* ───── everything between the top and the account scrolls */}
      <div className={s.content}>
        <ul className={s.menu}>
          <li>
            <button className={s.item} onClick={() => setUi({ quickAdd: true, nav: false })}>
              <span className={s.itemIcon}>
                <Icon name="squarePen" size={18} />
              </span>
              <span className={s.label}>새 작업</span>
              <kbd className={s.hint}>N</kbd>
            </button>
          </li>
          <li>
            <button className={s.item} onClick={() => setUi({ palette: true, nav: false })}>
              <span className={s.itemIcon}>
                <Icon name="search" size={18} />
              </span>
              <span className={s.label}>검색</span>
              <kbd className={s.hint}>{modCombo('K')}</kbd>
            </button>
          </li>
        </ul>

        <ul className={cx(s.menu, s.group)}>
          {pages.map((n) => {
            const active = pathname === n.href;
            return (
              <li key={n.href}>
                <Link href={n.href} className={s.item} data-active={active} aria-current={active ? 'page' : undefined} onClick={close}>
                  <span className={s.itemIcon}>
                    <Icon name={n.icon} size={18} />
                  </span>
                  <span className={s.label}>{n.label}</span>
                  {!!n.count && (
                    <span className={s.count} data-tone={n.tone}>
                      {n.count}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>

        <section className={s.section} aria-labelledby="sb-projects">
          <div className={s.sectionLabel}>
            <span id="sb-projects">프로젝트</span>
            {canCreate && (
              <button className={s.sectionAction} onClick={() => setAdding(true)} aria-label="프로젝트 추가" {...tip('프로젝트 추가', { side: 'right' })}>
                <Icon name="plus" size={16} />
              </button>
            )}
          </div>
          <ul className={s.menu}>
            {projects.map((p) => {
              const href = `/projects/${p.id}`;
              const active = pathname === href;
              const count = data.byProject.get(p.id);
              return (
                <li key={p.id}>
                  <Link href={href} className={s.item} data-active={active} aria-current={active ? 'page' : undefined} onClick={close}>
                    <span className={s.itemIcon}>
                      <span className={s.swatch} style={{ background: `var(--c-${p.color})` }} aria-hidden="true" />
                    </span>
                    <span className={s.label}>{p.name}</span>
                    {org && p.access === 'view' && (
                      <span className={s.access} aria-label="보기 전용" {...tip('보기 전용', { side: 'right' })}>
                        <Icon name="eye" size={14} />
                      </span>
                    )}
                    {!!count && <span className={s.count}>{count}</span>}
                  </Link>
                </li>
              );
            })}
            {adding ? (
              <li>
                <div className={s.item} data-editing="true">
                  <span className={s.itemIcon}>
                    <span className={s.swatch} aria-hidden="true" />
                  </span>
                  <input
                    className={s.projectInput}
                    autoFocus
                    placeholder="프로젝트 이름"
                    aria-label="새 프로젝트 이름"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => void submitProject()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitProject();
                      if (e.key === 'Escape') {
                        setAdding(false);
                        setName('');
                      }
                    }}
                  />
                </div>
              </li>
            ) : !canCreate ? (
              projects.length === 0 && <li className={s.emptyNote}>아직 볼 수 있는 프로젝트가 없어요. 관리자에게 공유를 요청하세요.</li>
            ) : (
              projects.length === 0 && (
                <li>
                  <button className={cx(s.item, s.addItem)} onClick={() => setAdding(true)}>
                    <span className={s.itemIcon}>
                      <Icon name="plus" size={16} />
                    </span>
                    <span className={s.label}>첫 프로젝트 만들기</span>
                  </button>
                </li>
              )
            )}
          </ul>
        </section>

        {visibleEvents.length > 0 && (
          <section className={s.section} aria-labelledby="sb-events">
            <div className={s.sectionLabel}>
              <span id="sb-events">다가오는 일정</span>
            </div>
            <ul className={s.menu}>
              {visibleEvents.map(({ task, date }) => (
                <li key={task.id}>
                  <button
                    className={s.item}
                    onClick={() => {
                      selectTask(task.id);
                      close();
                    }}
                  >
                    <span className={cx(s.label, s.eventLabel)}>{task.title}</span>
                    <span className={s.eventDate}>{formatRelativeKo(date, app.today)}</span>
                  </button>
                </li>
              ))}
              {data.events.length > EVENT_CAP && (
                <li>
                  <Link href="/upcoming" className={cx(s.item, s.addItem)} onClick={close}>
                    <span className={cx(s.label, s.eventLabel)}>외 {data.events.length - EVENT_CAP}개 더 보기</span>
                  </Link>
                </li>
              )}
            </ul>
          </section>
        )}
      </div>

      {/* ───── footer: account menu */}
      <div className={s.footer}>
        <button
          ref={userRef}
          className={s.account}
          onClick={toggleMenu}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          aria-label="계정 메뉴"
        >
          <span className={s.avatar}>{initial}</span>
          <span className={s.accountText}>
            <span className={s.accountName}>{app.user?.name ?? '계정'}</span>
            <span className={s.accountMeta}>{app.user?.email}</span>
          </span>
        </button>
        <Popover anchor={userRef} open={menu.open} onClose={menu.close} width={260}>
          <button className={ui.menuItem} onClick={() => (menu.close(), close(), router.push('/settings'))}>
            <Icon name="settings" size={18} /> 설정
          </button>
          <button className={ui.menuItem} onClick={() => (menu.close(), close(), router.push('/settings/ai'))}>
            <Icon name="link" size={18} /> AI 연결
          </button>
          <button className={ui.menuItem} onClick={() => (menu.close(), close(), setUi({ shortcuts: true }))}>
            <Icon name="keyboard" size={18} /> 단축키 <span className={ui.menuHint}>?</span>
          </button>
          <div className={ui.menuSep} />
          <div className={s.themeRow}>
            <div className={ui.segmented} data-full="true" data-size="sm" role="group" aria-label="테마">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  className={ui.segment}
                  aria-pressed={theme === t.value}
                  onClick={(e) => {
                    setTheme(t.value);
                    const r = e.currentTarget.getBoundingClientRect();
                    applyThemePref(t.value, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
                  }}
                >
                  <Icon name={t.icon} size={14} />
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className={ui.menuSep} />
          <button
            className={ui.menuItem}
            onClick={async () => {
              menu.close();
              await api('POST', '/api/auth/logout').catch(() => {});
              reset();
              router.replace('/login');
            }}
          >
            <Icon name="logout" size={18} /> 로그아웃
          </button>
        </Popover>
      </div>
    </nav>
  );
}
