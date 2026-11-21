'use client';

import { addDays, diffDays, PRIORITY_LABEL_KO, startOfWeek, type ISODate, type Priority, type Task } from '@obelisk/core';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/lib/format';
import { previewFor, requestGroupChange, type TimedSpan } from '@/lib/reschedule';
import { clearPicks, getPicked, markDismissPress } from '@/lib/selection';
import { canEdit, canWriteProject, selectTask, useApp } from '@/lib/store';
import {
  completeTasks,
  confirmTrash,
  copyTaskLinks,
  copyTasks,
  duplicateTasks,
  editableOnly,
  moveToProject,
  moveToToday,
  postponeTasks,
  renameTask,
  setPriority,
  trashTasks,
} from '@/lib/task-actions';
import { nextByDays } from '@/lib/timeline';
import { isApple, modCombo } from '@/lib/ui-helpers';
import { setUi, useUi } from '@/lib/ui-state';
import { DatePickerPanel } from './DatePicker';
import { Icon, type IconName } from './Icon';
import { ConfirmModal, ui } from './primitives';
import m from './TaskMenu.module.css';

/* ───────────────────────────── a context menu with one level of submenus */

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** The shortcut that does the same thing outside the menu, shown on the right (`⌘D`). */
  hint?: string;
  /** Pressing this key while the menu is open moves to the item (usually its shortcut letter). */
  key?: string;
  disabled?: boolean;
  danger?: boolean;
  /** In a choice submenu (우선순위, 프로젝트): whether this is the current value. */
  checked?: boolean;
  /** Extra content on the right, e.g. what a postpone option would push. */
  aside?: ReactNode;
  run?: () => void;
  /** A submenu, built only while it is open. */
  sub?: () => MenuEntry[];
  subWidth?: number;
  /** In a submenu: opening it swaps the submenu for this panel (날짜 선택… shows a calendar). `close` shuts the menu. */
  panel?: (close: () => void) => ReactNode;
}

export type MenuEntry = MenuItem | 'sep' | { title: string };

const isItem = (e: MenuEntry): e is MenuItem => typeof e === 'object' && 'id' in e;
const itemsOf = (entries: MenuEntry[]) => entries.filter(isItem);

/** The next enabled item after `from` going `dir` (wrapping); `from` -1 starts at an end. -1 when none. */
function step(items: MenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  const start = from < 0 ? (dir === 1 ? -1 : n) : from;
  for (let k = 1; k <= n; k++) {
    const i = (((start + dir * k) % n) + n) % n;
    if (!items[i]!.disabled) return i;
  }
  return -1;
}

/** The letter or digit pressed; with a Korean (IME) layout the physical key, so `T` still finds 오늘로. */
function pressedChar(e: KeyboardEvent): string | null {
  if (/^[a-z0-9]$/i.test(e.key)) return e.key.toLowerCase();
  return /^(?:Key|Digit)([A-Z0-9])$/.exec(e.code)?.[1]?.toLowerCase() ?? null;
}

type Pos = { left: number; top: number };

/**
 * A menu opened at a point (right-click). Keys: ↑↓ Home End move, → opens a submenu and ← closes it,
 * Enter or Space runs, Esc or Tab closes, a letter jumps to the item with that shortcut. It takes
 * keys in the capture phase and stops them, so the list's own shortcuts never act behind it. Closes
 * on a press outside, a scroll, a resize or leaving the window; focus goes back where it was.
 */
export function ContextMenu({
  x,
  y,
  label,
  entries,
  width = 248,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  entries: MenuEntry[];
  width?: number;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [rootPos, setRootPos] = useState<Pos | null>(null);
  const [subPos, setSubPos] = useState<Pos | null>(null);
  /** The root item whose submenu is open. */
  const [subOf, setSubOf] = useState<string | null>(null);
  /** The submenu item whose panel replaced the submenu. */
  const [swap, setSwap] = useState<string | null>(null);
  /** Where the keys move: 0 = the menu, 1 = its open submenu. */
  const [level, setLevel] = useState<0 | 1>(0);
  /** The highlighted item of each level (-1 = none). */
  const [active, setActive] = useState<[number, number]>([-1, -1]);
  const hoverTimer = useRef(0);
  /** The last highlight came from the keys (scroll it into view) rather than the pointer (leave the list still). */
  const byKeys = useRef(false);
  const closed = useRef(false);
  // The row that was right-clicked (or focused) gets focus back when the menu closes.
  const [returnTo] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));

  const rootItems = itemsOf(entries);
  const subItem = subOf ? (rootItems.find((i) => i.id === subOf && i.sub && !i.disabled) ?? null) : null;
  const subEntries = subItem?.sub?.() ?? [];
  const subItems = itemsOf(subEntries);

  const close = (restore: boolean) => {
    if (closed.current) return;
    closed.current = true;
    window.clearTimeout(hoverTimer.current);
    if (restore && returnTo && returnTo !== document.body && returnTo.isConnected) returnTo.focus({ preventScroll: true });
    onClose();
  };
  const panelItem = swap ? subItems.find((i) => i.id === swap && i.panel) : undefined;
  const panel = panelItem?.panel?.(() => close(true)) ?? null;

  const showSub = (id: string | null) => {
    setSubOf(id);
    setSwap(null);
  };

  const openSub = (item: MenuItem) => {
    window.clearTimeout(hoverTimer.current);
    showSub(item.id);
    setLevel(1);
    setActive((a) => [a[0], step(itemsOf(item.sub?.() ?? []), -1, 1)]);
  };

  const activate = (lvl: 0 | 1, i: number) => {
    const item = (lvl === 0 ? rootItems : subItems)[i];
    if (!item || item.disabled) return;
    if (lvl === 0 && item.sub) return openSub(item);
    if (lvl === 1 && item.panel) {
      setSwap(item.id);
      return;
    }
    close(true);
    item.run?.();
  };

  const highlight = (lvl: 0 | 1, i: number) => setActive((a) => (lvl === 0 ? [i, a[1]] : [a[0], i]));

  const hover = (lvl: 0 | 1, i: number, item: MenuItem) => {
    // Brushing past the owner of an open calendar must not pull focus out of its date field.
    if (lvl === 0 && swap && item.id === subOf) return;
    byKeys.current = false;
    setLevel(lvl);
    highlight(lvl, i);
    window.clearTimeout(hoverTimer.current);
    if (lvl === 1) return;
    const want = item.sub ? item.id : null;
    if (want === subOf) return;
    // A short wait, so cutting across a neighbour on the way into an open submenu does not swap it.
    hoverTimer.current = window.setTimeout(
      () => {
        showSub(want);
        setActive((a) => [a[0], -1]);
      },
      subOf ? 180 : 80,
    );
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close(true);
      return;
    }
    // The calendar's field and day buttons keep their own keys.
    if (panel && e.target instanceof Node && subRef.current?.contains(e.target)) return;
    // Everything else belongs to the menu: the list's shortcuts must not act behind it.
    e.stopImmediatePropagation();
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    byKeys.current = true;
    const items = level === 0 ? rootItems : panel ? [] : subItems;
    const cur = active[level];
    const moveTo = (i: number) => {
      if (i < 0) return;
      highlight(level, i);
      // Moving off the item that owns the open submenu closes it.
      if (level === 0 && subOf && items[i]!.id !== subOf) showSub(null);
    };
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        moveTo(step(items, cur, e.key === 'ArrowDown' ? 1 : -1));
        return;
      case 'Home':
      case 'End':
        e.preventDefault();
        moveTo(step(items, -1, e.key === 'Home' ? 1 : -1));
        return;
      case 'ArrowRight': {
        e.preventDefault();
        const item = level === 0 ? items[cur] : undefined;
        if (item?.sub && !item.disabled) openSub(item);
        return;
      }
      case 'ArrowLeft':
        e.preventDefault();
        if (level === 1) {
          setLevel(0);
          showSub(null);
          setActive((a) => [a[0], -1]);
        }
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (cur >= 0) activate(level, cur);
        return;
      case 'Tab':
        e.preventDefault();
        close(true);
        return;
    }
    const ch = pressedChar(e);
    if (!ch || !items.length) return;
    e.preventDefault();
    for (let k = 1; k <= items.length; k++) {
      const i = (cur + k + items.length) % items.length;
      const it = items[i]!;
      if (!it.disabled && (it.key === ch || it.label.toLowerCase().startsWith(ch))) return moveTo(i);
    }
  };

  // The listeners below are added once; they call whatever this render's handlers are.
  const latest = useRef({ onKey, close });
  useLayoutEffect(() => {
    latest.current = { onKey, close };
  });

  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && (!!rootRef.current?.contains(t) || !!subRef.current?.contains(t));
    const onKeyDown = (e: KeyboardEvent) => latest.current.onKey(e);
    const onDown = (e: PointerEvent) => {
      if (inside(e.target)) return;
      // The press only closes the menu: the list under it must not also drop its picks.
      markDismissPress(e);
      latest.current.close(false);
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) latest.current.close(false);
    };
    const onLeave = () => latest.current.close(false);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onLeave);
      window.removeEventListener('blur', onLeave);
      window.clearTimeout(hoverTimer.current);
    };
  }, []);

  // Right and below the pointer; the other side where it would not fit.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = x + w > window.innerWidth - 8 ? Math.max(8, x - w) : x;
    let top = y;
    if (top + h > window.innerHeight - 8) top = y - h >= 8 ? y - h : Math.max(8, window.innerHeight - h - 8);
    setRootPos({ left, top });
  }, [x, y]);

  // Beside the item that opened it, its first row level with that item; re-placed when a panel swaps in.
  useLayoutEffect(() => {
    const el = subRef.current;
    if (!subOf || !el || !rootPos) {
      setSubPos(null);
      return;
    }
    const place = () => {
      const box = rootRef.current?.getBoundingClientRect();
      const owner = rootRef.current?.querySelector(`[data-menu-id="${subOf}"]`)?.getBoundingClientRect();
      if (!box || !owner) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = box.right + 4;
      if (left + w > window.innerWidth - 8) left = Math.max(8, box.left - w - 4);
      const top = Math.max(8, Math.min(owner.top - 6, window.innerHeight - h - 8));
      setSubPos({ left, top });
    };
    place();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [subOf, rootPos]);

  // Focus follows the highlight (screen readers read the item); with none, the menu itself holds focus.
  const hasPanel = !!panel;
  useLayoutEffect(() => {
    if (!rootPos || (level === 1 && (!subPos || hasPanel))) return;
    const box = level === 0 ? rootRef.current : subRef.current;
    const i = active[level];
    const target = i >= 0 ? box?.querySelector<HTMLElement>(`[data-menu-idx="${i}"]`) : box;
    target?.focus({ preventScroll: i < 0 || !byKeys.current });
  }, [level, active, rootPos, subPos, hasPanel]);

  const render = (list: MenuEntry[], lvl: 0 | 1) => {
    let idx = -1;
    return list.map((e, k) => {
      if (e === 'sep') return <div key={`sep-${k}`} className={ui.menuSep} role="separator" />;
      if (!isItem(e)) {
        return (
          <div key={`title-${k}`} className={ui.menuTitle} role="presentation">
            {e.title}
          </div>
        );
      }
      const i = ++idx;
      const owns = lvl === 0 && !!subItem && subItem.id === e.id;
      return (
        <button
          key={e.id}
          type="button"
          tabIndex={-1}
          role={e.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={e.checked}
          aria-haspopup={e.sub ? 'menu' : undefined}
          aria-expanded={e.sub ? owns : undefined}
          className={ui.menuItem}
          data-menu-idx={i}
          data-menu-id={e.id}
          data-active={(level === lvl && active[lvl] === i) || owns}
          data-selected={e.checked || undefined}
          data-tone={e.danger ? 'danger' : undefined}
          disabled={e.disabled}
          onMouseEnter={() => hover(lvl, i, e)}
          onClick={() => activate(lvl, i)}
        >
          {e.icon}
          <span className={m.label}>{e.label}</span>
          {e.aside}
          {e.checked && <Icon name="check" size={15} />}
          {e.hint && <span className={ui.menuHint}>{e.hint}</span>}
          {(e.sub || e.panel) && <Icon name="chevronRight" size={14} className={m.caret} />}
        </button>
      );
    });
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div
        ref={rootRef}
        className={cx(ui.popover, m.menu)}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        // Lets other key handlers see that a menu has the keys, wherever it was opened from.
        data-context-menu=""
        style={{ width, left: rootPos?.left ?? -9999, top: rootPos?.top ?? -9999, visibility: rootPos ? 'visible' : 'hidden' }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {render(entries, 0)}
      </div>
      {subItem && (
        <div
          ref={subRef}
          className={cx(ui.popover, m.menu)}
          role={panel ? 'dialog' : 'menu'}
          aria-label={panelItem?.label ?? subItem.label}
          tabIndex={-1}
          style={{
            width: panel ? undefined : (subItem.subWidth ?? 232),
            left: subPos?.left ?? -9999,
            top: subPos?.top ?? -9999,
            visibility: subPos ? 'visible' : 'hidden',
          }}
          onMouseEnter={() => {
            // Made it into the submenu: keep it, and keep its owner highlighted.
            window.clearTimeout(hoverTimer.current);
            setActive((a) => [rootItems.findIndex((i) => i.id === subItem.id), a[1]]);
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {panel ?? render(subEntries, 1)}
        </div>
      )}
    </>,
    document.body,
  );
}

/* ───────────────────────────── the task menu */

const isActive = (t: Task) => t.status === 'todo' || t.status === 'doing';
const PRIORITIES: Priority[] = [3, 2, 1, 0];

const icon = (name: IconName) => <Icon name={name} size={16} />;

/** Moved so it ends on `day`, keeping its length; without dates, `day` becomes its due date. */
function endingOn(t: Task, day: ISODate): TimedSpan {
  const end = t.dueDate ?? t.startDate;
  return end ? nextByDays(t, 'move', diffDays(day, end)) : { startDate: null, dueDate: day };
}

/** What a postpone option would push, in the same words as the row's postpone menu. */
function ImpactBadge({ taskId, next }: { taskId: string; next: TimedSpan }) {
  const { delayedCount, conflictCount } = previewFor(taskId, next).report.summary;
  return (
    <span className={cx(ui.badge, m.effect)} data-tone={conflictCount ? 'danger' : delayedCount ? 'warn' : 'ok'}>
      {conflictCount ? `충돌 ${conflictCount}` : delayedCount ? `${delayedCount}개 밀림` : '영향 없음'}
    </span>
  );
}

/** The task context menu at `ui.taskMenu` (right-click on a row or a bar). Mounted once in AppShell. */
export function TaskMenuLayer() {
  const { taskMenu } = useUi();
  if (!taskMenu) return null;
  // A new right-click is a new menu: fresh highlight, fresh focus to return to.
  return <TaskMenu key={`${taskMenu.x},${taskMenu.y},${taskMenu.ids.join(',')}`} x={taskMenu.x} y={taskMenu.y} ids={taskMenu.ids} />;
}

function TaskMenu({ x, y, ids }: { x: number; y: number; ids: string[] }) {
  const app = useApp();
  const pathname = usePathname();
  const workspaceId = app.workspace?.id;
  // A menu belongs to the page and the space it was opened on.
  const [openedOn] = useState({ pathname, workspaceId });
  const list = ids.map((id) => app.tasks[id]).filter((t): t is Task => !!t);
  const stale = !list.length || pathname !== openedOn.pathname || workspaceId !== openedOn.workspaceId;
  useEffect(() => {
    if (stale) setUi({ taskMenu: null });
  }, [stale]);
  if (stale) return null;

  const n = list.length;
  const one = n === 1 ? list[0]! : null;
  const targets = list.map((t) => t.id);
  const editable = list.filter((t) => canEdit(t, app));
  const open = editable.filter(isActive);
  const dated = open.filter((t) => t.startDate || t.dueDate);
  const reopen = editable.length > 0 && editable.every((t) => t.status === 'done');
  const noEdit = !editable.length;
  const projects = app.projects.filter((p) => !p.archivedAt && canWriteProject(p.id, app)).sort((a, b) => a.position - b.position);
  const sameProject = list.every((t) => t.projectId === list[0]!.projectId) ? list[0]!.projectId : undefined;
  const samePriority = list.every((t) => t.priority === list[0]!.priority) ? list[0]!.priority : undefined;
  const picks = getPicked();
  const onPicks = picks.size > 0 && targets.every((id) => picks.has(id));

  /** Every open task ends on `day`, keeping its length (one undo, the impact dialog when others slip). */
  const endOn = (day: ISODate) => {
    const ok = new Set(editableOnly(targets).ok);
    const moves = list
      .filter((t) => ok.has(t.id) && isActive(t))
      .map((t) => ({ t, next: endingOn(t, day) }))
      .filter(({ t, next }) => next.startDate !== t.startDate || next.dueDate !== t.dueDate)
      .map(({ t, next }) => ({ taskId: t.id, next }));
    requestGroupChange(moves);
  };

  const moveTo = async (projectId: string | null) => {
    // A selection that moved to another project usually leaves this list, as from the selection bar.
    if ((await moveToProject(targets, projectId)) && onPicks) clearPicks();
  };

  const postponeSub = (): MenuEntry[] => {
    const nextMon = addDays(startOfWeek(app.today), 7);
    // One dated task: each option says what it would push, like the row's postpone menu.
    const single = one && dated.length === 1 ? one : null;
    const byDays = (id: string, label: string, days: number, key?: string): MenuItem => ({
      id,
      label,
      ...(key ? { hint: key.toUpperCase(), key } : {}),
      icon: icon('postpone'),
      disabled: !dated.length,
      aside: single ? <ImpactBadge taskId={single.id} next={nextByDays(single, 'move', days)} /> : undefined,
      run: () => postponeTasks(targets, days),
    });
    return [
      byDays('day', '하루', 1, 'p'),
      byDays('two', '이틀', 2),
      byDays('week', '일주일', 7),
      {
        id: 'monday',
        label: '다음 주 월요일',
        icon: icon('calendar'),
        aside: single ? <ImpactBadge taskId={single.id} next={endingOn(single, nextMon)} /> : undefined,
        run: () => endOn(nextMon),
      },
      'sep',
      {
        id: 'pick',
        label: '날짜 선택…',
        icon: icon('calendar'),
        panel: (close) => (
          <DatePickerPanel
            value={one?.dueDate ?? null}
            today={app.today}
            clearable={false}
            onPick={(d) => {
              close();
              if (d) endOn(d);
            }}
          />
        ),
      },
    ];
  };

  const prioritySub = (): MenuEntry[] =>
    PRIORITIES.map((p, i) => ({
      id: `priority-${p}`,
      label: PRIORITY_LABEL_KO[p],
      hint: String(i + 1),
      key: String(i + 1),
      icon: <span className={m.priorityDot} data-priority={p} aria-hidden="true" />,
      checked: samePriority === p,
      run: () => void setPriority(targets, p),
    }));

  const projectSub = (): MenuEntry[] => [
    { id: 'inbox', label: '인박스', icon: icon('inbox'), checked: sameProject === null, run: () => void moveTo(null) },
    ...(projects.length ? (['sep'] as const) : []),
    ...projects.map((p) => ({
      id: `project-${p.id}`,
      label: p.name,
      icon: <span className={m.swatch} style={{ background: `var(--c-${p.color})` }} aria-hidden="true" />,
      checked: sameProject === p.id,
      run: () => void moveTo(p.id),
    })),
  ];

  const entries: MenuEntry[] = [
    ...(n > 1 ? [{ title: `작업 ${n}개` }] : noEdit ? [{ title: '보기 전용 작업' }] : []),
    ...(one
      ? [
          {
            id: 'open',
            label: '열기',
            hint: '↵',
            icon: icon('arrowUpRight'),
            run: () => {
              if (getPicked().size) clearPicks();
              selectTask(one.id);
            },
          },
        ]
      : []),
    {
      id: 'complete',
      label: reopen ? '완료 취소' : '완료',
      hint: modCombo('↵'),
      icon: icon(reopen ? 'circle' : 'checkCircle'),
      disabled: !reopen && !open.length,
      run: () => void completeTasks(targets),
    },
    { id: 'today', label: '오늘로', hint: 'T', key: 't', icon: icon('sun'), disabled: !open.length, run: () => moveToToday(targets) },
    { id: 'postpone', label: '미루기', key: 'p', icon: icon('postpone'), disabled: !open.length, sub: postponeSub, subWidth: 280 },
    { id: 'priority', label: '우선순위', icon: icon('flag'), disabled: noEdit, sub: prioritySub, subWidth: 200 },
    { id: 'project', label: '프로젝트로 옮기기', icon: icon('folder'), disabled: noEdit, sub: projectSub, subWidth: 248 },
    'sep',
    ...(one ? [{ id: 'rename', label: '제목 바꾸기', hint: 'E', key: 'e', icon: icon('squarePen'), disabled: noEdit, run: () => renameTask(one.id) }] : []),
    {
      id: 'duplicate',
      label: '복제',
      hint: modCombo('D'),
      icon: icon('copy'),
      disabled: !list.some((t) => canWriteProject(t.projectId, app)),
      run: () => void duplicateTasks(targets),
    },
    { id: 'copy', label: '텍스트로 복사', hint: modCombo('C'), icon: icon('fileText'), run: () => void copyTasks(targets) },
    ...(one ? [{ id: 'link', label: '링크 복사', icon: icon('link'), run: () => void copyTaskLinks(targets) }] : []),
    'sep',
    {
      id: 'trash',
      label: '휴지통으로 옮기기',
      hint: isApple() ? '⌫' : 'Del',
      icon: icon('trash'),
      danger: true,
      disabled: noEdit,
      run: () => trashTasks(targets),
    },
  ];

  return <ContextMenu x={x} y={y} label={one ? `“${one.title}” 메뉴` : `작업 ${n}개 메뉴`} entries={entries} onClose={() => setUi({ taskMenu: null })} />;
}

/* ───────────────────────────── 10 or more to the trash */

/** A batch of 10 or more asks before it goes to the trash; fewer go at once with an undo toast. */
export function TrashConfirm() {
  const { confirmTrash: ids } = useUi();
  const n = ids?.length ?? 0;
  return (
    <ConfirmModal
      open={n > 0}
      onClose={() => setUi({ confirmTrash: null })}
      title={`작업 ${n}개를 휴지통으로 옮길까요?`}
      body="30일 동안 휴지통에 보관돼요. 그 안에는 언제든 되살릴 수 있어요."
      confirmLabel="휴지통으로 옮기기"
      onConfirm={() => void confirmTrash()}
    />
  );
}
