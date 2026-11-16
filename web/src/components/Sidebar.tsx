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
import { Icon, type IconName } from './Icon';
import { Popover, tip, ui, useDisclosure } from './primitives';
import s from './Sidebar.module.css';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

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
 * Notion-style workspace sidebar.
 * search · home switcher (홈 / 인박스 / 예정) · 다가오는 일정 · 작업 · 프로젝트 · AI card · account footer.
 * Desktop collapse hides it completely (the top bar shows » to bring it back); on small screens it is a sheet.
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

  // 모아보기 gathers every space, so it only earns a place once there is more than one.
  const switcher: NavItem[] = [
    page('/'),
    ...(app.workspaces.length > 1 ? [page('/overview')] : []),
    page('/inbox', { count: data.inbox }),
    page('/upcoming'),
  ];
  const activeSwitch = switcher.find((n) => pathname === n.href)?.href ?? null;

  const org = app.workspace?.kind === 'org';
  const views: NavItem[] = [
    page('/today', { count: data.today, tone: data.overdue ? 'danger' : undefined }),
    ...(org ? [page('/mine', { count: data.mine || undefined })] : []),
    page('/all'),
    page('/forecast', { count: data.risk || undefined, tone: data.conflicts ? 'danger' : 'warn' }),
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
      {/* ───── top: brand · collapse · new */}
      <div className={s.top}>
        <WorkspaceSwitcher onNavigate={close} />
        <div className={s.topActions}>
          {mobile ? (
            <button className={s.topBtn} onClick={close} aria-label="메뉴 닫기">
              <Icon name="x" size={18} />
            </button>
          ) : (
            <button
              className={cx(s.topBtn, s.collapseBtn)}
              onClick={() => setSidebarCollapsed(true)}
              aria-label="사이드바 접기"
              {...tip('사이드바 접기', { side: 'bottom', kbd: modCombo('B') })}
            >
              <Icon name="chevronsLeft" size={18} />
            </button>
          )}
          <button
            className={s.topBtn}
            onClick={() => setUi({ quickAdd: true, nav: false })}
            aria-label="새 작업"
            {...tip('새 작업', { side: 'bottom', kbd: 'N' })}
          >
            <Icon name="squarePen" size={17} />
          </button>
        </div>
      </div>

      <div className={s.head}>
        <button className={s.search} onClick={() => setUi({ palette: true, nav: false })} aria-label="검색 및 명령">
          <span className={s.searchText}>검색 또는 명령</span>
          <kbd className={s.searchKbd}>{modCombo('K')}</kbd>
        </button>

        <div className={s.switcher} role="group" aria-label="빠른 이동">
          {switcher.map((n) => {
            const active = pathname === n.href;
            const expanded = active || (!activeSwitch && n.href === '/');
            return (
              <Link
                key={n.href}
                href={n.href}
                className={s.switch}
                data-active={active}
                data-expanded={expanded}
                aria-current={active ? 'page' : undefined}
                aria-label={n.label}
                onClick={close}
                {...tip(!expanded && n.label, { side: 'bottom', meta: n.count || undefined })}
              >
                <Icon name={n.icon} size={17} strokeWidth={active ? 2 : 1.75} />
                <span className={s.switchLabel} aria-hidden={!expanded || undefined}>
                  {n.label}
                </span>
                {!expanded && !!n.count && <span className={s.switchDot} aria-hidden="true" />}
              </Link>
            );
          })}
        </div>
      </div>

      {/* ───── scrollable sections */}
      <div className={s.content}>
        <section className={s.section}>
          <div className={s.sectionLabel}>다가오는 일정</div>
          {visibleEvents.length ? (
            <ul className={s.events}>
              {visibleEvents.map(({ task, date }) => {
                const project = task.projectId ? app.projects.find((p) => p.id === task.projectId) : undefined;
                return (
                  <li key={task.id}>
                    <button
                      className={s.event}
                      onClick={() => {
                        selectTask(task.id);
                        close();
                      }}
                    >
                      <span className={s.eventBar} style={{ background: `var(--c-${project?.color ?? 'red'})` }} />
                      <span className={s.eventText}>
                        <span className={s.eventTitle}>{task.title}</span>
                        <span className={s.eventMeta}>
                          {formatRelativeKo(date, app.today)}
                          {project ? ` · ${project.name}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {data.events.length > EVENT_CAP && (
                <li>
                  <Link href="/upcoming" className={s.eventMore} onClick={close}>
                    외 {data.events.length - EVENT_CAP}개 일정
                  </Link>
                </li>
              )}
            </ul>
          ) : (
            <button className={s.eventEmpty} onClick={() => setUi({ quickAdd: true, nav: false })}>
              <Icon name="plus" size={16} />
              <span className={s.eventText}>
                <span className={s.eventTitle}>고정 일정 추가</span>
                <span className={s.eventMeta}>회의·마감을 @고정 으로 적으면 2주 안의 일정이 여기에 보여요.</span>
              </span>
            </button>
          )}
        </section>

        <section className={s.section}>
          <div className={s.sectionLabel}>작업</div>
          <ul className={s.menu}>
            {views.map((n) => {
              const active = pathname === n.href;
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    className={s.item}
                    data-active={active}
                    aria-current={active ? 'page' : undefined}
                    onClick={close}
                  >
                    <span className={s.itemIcon}>
                      <Icon name={n.icon} size={17} />
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
        </section>

        <section className={s.section}>
          <div className={s.sectionLabel}>
            <span>프로젝트</span>
            {canCreate && (
              <button className={s.sectionAction} onClick={() => setAdding(true)} aria-label="프로젝트 추가" {...tip('프로젝트 추가')}>
                <Icon name="plus" size={15} />
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
                  <Link
                    href={href}
                    className={s.item}
                    data-active={active}
                    aria-current={active ? 'page' : undefined}
                    onClick={close}
                  >
                    <span className={s.itemIcon} style={{ color: `var(--c-${p.color})` }}>
                      <Icon name="folder" size={17} />
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
                    <Icon name="folder" size={17} />
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
              projects.length === 0 && (
                <li className={s.emptyNote}>아직 볼 수 있는 프로젝트가 없어요. 관리자에게 공유를 요청하세요.</li>
              )
            ) : (
              <li>
                <button className={cx(s.item, s.addItem)} onClick={() => setAdding(true)}>
                  <span className={s.itemIcon}>
                    <Icon name="plus" size={16} />
                  </span>
                  <span className={s.label}>{projects.length ? '새 프로젝트' : '첫 프로젝트 만들기'}</span>
                </button>
              </li>
            )}
          </ul>
        </section>
      </div>

      {/* ───── AI card */}
      {pathname !== '/settings/ai' && (
        <div className={s.cardWrap}>
          <Link href="/settings/ai" className={s.aiCard} onClick={close}>
            <span className={s.aiIcon}>
              <Icon name="sparkle" size={16} />
            </span>
            <span className={s.aiText}>
              <span className={s.aiTitle}>Claude·ChatGPT 연결</span>
              <span className={s.aiBody}>AI에게 할 일 정리와 일정 조정을 맡겨 보세요.</span>
              <span className={s.aiCta}>
                연결하기 <Icon name="arrowRight" size={13} strokeWidth={2} />
              </span>
            </span>
          </Link>
        </div>
      )}

      {/* ───── footer: account switcher · help · settings */}
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
          <span className={s.accountName}>{app.user?.name ?? '계정'}</span>
          <Icon name="chevronDown" size={14} className={s.accountChevron} />
        </button>
        <div className={s.footerActions}>
          <button
            className={s.topBtn}
            onClick={() => setUi({ shortcuts: true, nav: false })}
            aria-label="단축키 도움말"
            {...tip('단축키', { side: 'top', kbd: '?' })}
          >
            <Icon name="help" size={18} />
          </button>
          <Link
            href="/settings"
            className={s.topBtn}
            data-active={pathname === '/settings'}
            onClick={close}
            aria-label="설정"
            {...tip('설정', { side: 'top' })}
          >
            <Icon name="settings" size={18} />
          </Link>
        </div>
        <Popover anchor={userRef} open={menu.open} onClose={menu.close} width={264}>
          <div className={s.menuUser}>
            <span className={s.avatar} data-size="lg">
              {initial}
            </span>
            <span className={s.userText}>
              <span className={s.userName}>{app.user?.name}</span>
              <span className={s.userEmail}>{app.user?.email}</span>
            </span>
          </div>
          <div className={ui.menuSep} />
          <button className={ui.menuItem} onClick={() => (menu.close(), close(), router.push('/settings'))}>
            <Icon name="settings" size={16} /> 설정
          </button>
          <button className={ui.menuItem} onClick={() => (menu.close(), close(), router.push('/settings/ai'))}>
            <Icon name="sparkle" size={16} /> AI 연결
          </button>
          <button className={ui.menuItem} onClick={() => (menu.close(), setUi({ shortcuts: true }))}>
            <Icon name="keyboard" size={16} /> 단축키 <span className={ui.menuHint}>?</span>
          </button>
          <div className={ui.menuSep} />
          <div className={ui.menuTitle}>테마</div>
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
            <Icon name="logout" size={16} /> 로그아웃
          </button>
        </Popover>
      </div>
    </nav>
  );
}
