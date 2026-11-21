'use client';

import { diffDays, formatRelativeKo, formatShortKo, todayIn, TRASH_DAYS, type Project, type TrashItem } from '@obelisk/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarButton, Dock, PickBar } from '@/components/BulkBar';
import { Icon } from '@/components/Icon';
import { buttonClass, ConfirmModal, tip, ui } from '@/components/primitives';
import { ContextMenu, type MenuEntry } from '@/components/TaskMenu';
import r from '@/components/TaskRow.module.css';
import { EmptyState, Page, ViewHeader } from '@/components/View';
import { cx } from '@/lib/format';
import { clearPicks, getPicked, pickRange, setPicked, unpick, usePicked, visibleRowIds } from '@/lib/selection';
import { emptyTrash, listTrash, purgeTrash, restoreTasks, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { isApple } from '@/lib/ui-helpers';
import { getUi } from '@/lib/ui-state';
import s from '../views.module.css';
import t from './trash.module.css';

type Confirm = { kind: 'purge'; ids: string[] } | { kind: 'empty' };

function isField(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

/**
 * 휴지통: deleted tasks wait here for 30 days. Rows pick like a list (click, ⌘/Shift+click, ⌘A, a
 * sweep or a box), but they are not in the task list, so the list's own shortcuts skip them; this
 * page answers Enter (되살리기) and Delete (영구 삭제, asked first) itself and draws its own bar.
 */
export default function TrashPage() {
  const app = useApp();
  const workspaceId = app.workspace?.id;
  const org = app.workspace?.kind === 'org';
  const tz = app.user?.timezone ?? 'UTC';
  /** null while the first answer is on its way. */
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const picked = usePicked();
  const loads = useRef(0);

  // The newest request wins: an answer that left before a switch or an action must not land after it.
  const reload = useCallback(async () => {
    const n = ++loads.current;
    const list = await listTrash();
    if (n !== loads.current) return;
    setItems((prev) => list ?? prev ?? []);
  }, []);

  useEffect(() => {
    setItems(null);
    void reload();
  }, [workspaceId, reload]);

  // Tasks leaving or coming back elsewhere (⌘Z of a restore, another window, a sync) change what is here.
  const live = Object.keys(app.tasks).length;
  const seen = useRef(live);
  useEffect(() => {
    if (seen.current === live) return;
    seen.current = live;
    const id = window.setTimeout(() => void reload(), 300);
    return () => window.clearTimeout(id);
  }, [live, reload]);

  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.task.id, i])), [items]);
  const groups = useMemo(() => {
    const days = new Map<string, TrashItem[]>();
    for (const it of items ?? []) {
      const day = todayIn(tz, new Date(it.deletedAt));
      const list = days.get(day) ?? [];
      list.push(it);
      days.set(day, list);
    }
    return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, list]) => ({ date, list }));
  }, [items, tz]);
  const projects = useMemo(() => new Map(app.projects.map((p) => [p.id, p])), [app.projects]);

  const pickedIds = (items ?? []).filter((i) => picked.has(i.task.id)).map((i) => i.task.id);
  const restorable = (items ?? []).filter((i) => i.canRestore).length;

  /** The ones you may restore or delete; says so when some are not. */
  const allowed = (ids: string[]) => {
    const ok = ids.filter((id) => byId.get(id)?.canRestore);
    const blocked = ids.length - ok.length;
    if (blocked) toast.error(ok.length ? `권한이 없는 작업 ${blocked}개는 건너뛰었어요` : '이 작업을 되살리거나 지울 권한이 없어요');
    return ok;
  };

  /** Off the list at once; the reload that follows brings the server's word. */
  const drop = (ids: string[]) => {
    const gone = new Set(ids);
    unpick(ids);
    setItems((prev) => prev && prev.filter((i) => !gone.has(i.task.id)));
  };

  // Back to the list with their links; the store's toast has the 실행 취소 that moves them back here.
  const restore = async (ids: string[]) => {
    const ok = allowed(ids);
    if (!ok.length) return;
    const res = await restoreTasks(ok);
    if (!res) return;
    // Restored, or already gone from the trash (`missing`): either way not here any more.
    drop(ok);
    void reload();
  };

  const askPurge = (ids: string[]) => {
    const ok = allowed(ids);
    if (ok.length) setConfirm({ kind: 'purge', ids: ok });
  };

  const purge = async (ids: string[]) => {
    if ((await purgeTrash(ids)) === null) return;
    drop(ids);
    void reload();
  };

  const empty = async () => {
    if ((await emptyTrash()) === null) return;
    clearPicks();
    void reload();
  };

  /** The picks, else the row that has focus. */
  const targets = (): string[] => {
    if (pickedIds.length) return pickedIds;
    const row = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-task-row]') : null;
    const id = row?.dataset.taskRow;
    return id && byId.has(id) ? [id] : [];
  };

  // ⌘A, Enter and Delete belong to this page here, in the capture phase ahead of the list shortcuts:
  // those look for these ids among the tasks, which they are not.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isField(e.target) || menu || confirm) return;
      const u = getUi();
      if (u.palette || u.quickAdd || u.shortcuts || u.taskMenu) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        if (!items?.length) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setPicked(
          items.map((i) => i.task.id),
          { anchor: items[0]!.task.id },
        );
        return;
      }
      const del = e.key === 'Delete' || e.key === 'Backspace';
      const enter = e.key === 'Enter' && !e.isComposing;
      if ((!del && !enter) || e.altKey || e.shiftKey || (mod && !del)) return;
      // A button inside a row keeps Enter for itself.
      if (enter && e.target instanceof Element && e.target.closest('button, a')) return;
      const ids = targets();
      if (!ids.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (del) askPurge(ids);
      else void restore(ids);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Finder picking, kept off the open task: these rows are not tasks of the list.
  const onRowClick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey) return pickRange(visibleRowIds(), id);
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(getPicked());
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return setPicked(next, { anchor: id });
    }
    setPicked([id], { anchor: id });
  };

  const onRowMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, ids: getPicked().has(id) && pickedIds.length ? pickedIds : [id] });
  };

  const menuEntries = (ids: string[]): MenuEntry[] => {
    const can = ids.some((id) => byId.get(id)?.canRestore);
    return [
      ...(ids.length > 1 ? [{ title: `작업 ${ids.length}개` }] : []),
      { id: 'restore', label: '되살리기', hint: '↵', icon: <Icon name="undo" size={16} />, disabled: !can, run: () => void restore(ids) },
      'sep',
      {
        id: 'purge',
        label: '영구 삭제',
        hint: isApple() ? '⌫' : 'Del',
        icon: <Icon name="trash" size={16} />,
        danger: true,
        disabled: !can,
        run: () => askPurge(ids),
      },
    ];
  };

  const purgeIds = confirm?.kind === 'purge' ? confirm.ids : [];
  const purgeOne = purgeIds.length === 1 ? byId.get(purgeIds[0]!) : undefined;

  return (
    <Page>
      <ViewHeader
        title="휴지통"
        description={`지운 작업은 ${TRASH_DAYS}일 동안 여기 있다가 자동으로 영구 삭제돼요.`}
        actions={
          restorable > 0 && (
            <button type="button" className={buttonClass({ variant: 'outline', size: 'sm' })} onClick={() => setConfirm({ kind: 'empty' })}>
              <Icon name="trash" size={15} />
              휴지통 비우기
            </button>
          )
        }
      />

      <div className={s.agenda}>
        {groups.map((g) => {
          const rel = formatRelativeKo(g.date, app.today);
          return (
            <section key={g.date} className={s.day} aria-label={`${rel}에 지운 작업`}>
              <div className={s.dayHeader}>
                <span className={s.dayRel}>{rel}</span>
                {/* "오늘"/"어제" carry no date: show it next to them. */}
                {!/\d월/.test(rel) && <span className={s.dayDate}>{formatShortKo(g.date)}</span>}
                <span className={s.dayCount}>{g.list.length}</span>
              </div>
              <div className={s.dayRows}>
                {g.list.map((it) => (
                  <TrashRow
                    key={it.task.id}
                    item={it}
                    project={it.task.projectId ? projects.get(it.task.projectId) : undefined}
                    org={org}
                    tz={tz}
                    picked={picked.has(it.task.id)}
                    onClick={onRowClick}
                    onMenu={onRowMenu}
                    onRestore={(id) => void restore([id])}
                    onPurge={(id) => askPurge([id])}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {items?.length === 0 && (
        <EmptyState icon="trash" title="휴지통이 비어 있어요" body={`목록에서 ${isApple() ? '⌫' : 'Delete'} 키나 우클릭으로 지운 작업이 여기로 와요.`} />
      )}

      {pickedIds.length > 0 && (
        <Dock>
          <PickBar variant="floating" count={pickedIds.length} label="고른 휴지통 작업" onClear={clearPicks}>
            <BarButton icon="undo" label="되살리기" kbd="↵" onClick={() => void restore(pickedIds)} />
            <BarButton icon="trash" label="영구 삭제" kbd={isApple() ? '⌫' : 'Del'} danger onClick={() => askPurge(pickedIds)} />
          </PickBar>
        </Dock>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.ids.length > 1 ? `휴지통 작업 ${menu.ids.length}개 메뉴` : '휴지통 작업 메뉴'}
          width={220}
          entries={menuEntries(menu.ids)}
          onClose={() => setMenu(null)}
        />
      )}

      <ConfirmModal
        open={confirm?.kind === 'purge'}
        onClose={() => setConfirm(null)}
        title={purgeOne ? `“${purgeOne.task.title}”을(를) 영구 삭제할까요?` : `작업 ${purgeIds.length}개를 영구 삭제할까요?`}
        body="휴지통에서 지우면 되살릴 수 없어요."
        confirmLabel="영구 삭제"
        onConfirm={() => void purge(purgeIds)}
      />
      <ConfirmModal
        open={confirm?.kind === 'empty'}
        onClose={() => setConfirm(null)}
        title="휴지통을 비울까요?"
        body={
          restorable < (items?.length ?? 0)
            ? `작업 ${restorable}개를 영구 삭제해요. 지울 권한이 없는 ${(items?.length ?? 0) - restorable}개는 남아요. 지우면 되살릴 수 없어요.`
            : `작업 ${restorable}개를 영구 삭제해요. 지우면 되살릴 수 없어요.`
        }
        confirmLabel="비우기"
        onConfirm={() => void empty()}
      />
    </Page>
  );
}

function TrashRow({
  item,
  project,
  org,
  tz,
  picked,
  onClick,
  onMenu,
  onRestore,
  onPurge,
}: {
  item: TrashItem;
  project: Project | undefined;
  org: boolean;
  tz: string;
  picked: boolean;
  onClick: (e: React.MouseEvent, id: string) => void;
  onMenu: (e: React.MouseEvent, id: string) => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
}) {
  const { task } = item;
  // Calendar days in your timezone, as on iOS: the day it goes is the day its tooltip names.
  const purgeDay = todayIn(tz, new Date(item.purgeAt));
  const left = diffDays(purgeDay, todayIn(tz));
  const status = task.status === 'done' ? 'checkCircle' : task.status === 'canceled' ? 'xCircle' : 'circle';
  return (
    <div
      className={cx(r.row, task.status === 'done' && r.done, task.status === 'canceled' && r.canceled, picked && r.picked)}
      data-task-row={task.id}
      aria-selected={picked || undefined}
      tabIndex={0}
      // Shift would otherwise extend a text selection across the rows.
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={(e) => onClick(e, task.id)}
      onContextMenu={(e) => onMenu(e, task.id)}
    >
      <span className={t.mark} aria-hidden="true">
        <Icon name={status} size={18} />
      </span>
      <div className={r.main}>
        <div className={r.content}>
          <div className={r.titleLine}>
            <span className={r.title}>{task.title}</span>
          </div>
          <div className={r.meta}>
            {!item.canRestore && (
              <span className={r.item} {...tip('되살리거나 지울 권한이 없어요', { side: 'top' })}>
                <Icon name="eye" size={13} /> 보기 전용
              </span>
            )}
            {org && item.deletedByName && (
              <span className={r.item} {...tip(`${item.deletedByName}님이 휴지통으로 옮겼어요`, { side: 'top' })}>
                <Icon name="user" size={13} /> {item.deletedByName}
              </span>
            )}
            <span className={r.item} data-tone={left <= 3 ? 'warn' : undefined} {...tip(`${formatShortKo(purgeDay)}에 영구 삭제돼요`, { side: 'top' })}>
              {left <= 0 ? '오늘 영구 삭제' : `${left}일 후 영구 삭제`}
            </span>
            {project ? (
              <span className={cx(r.item, r.project)}>
                <span className={r.swatch} style={{ background: `var(--c-${project.color})` }} aria-hidden="true" />
                <span className={r.projectName}>{project.name}</span>
              </span>
            ) : (
              <span className={r.item} {...tip(task.projectId ? '프로젝트가 없어져 인박스로 돌아가요' : null, { side: 'top' })}>
                <Icon name="inbox" size={13} /> 인박스
              </span>
            )}
          </div>
        </div>
      </div>
      <div className={cx(r.actions, t.actions)}>
        <button
          type="button"
          className={buttonClass({ variant: 'ghost', size: 'xs' })}
          disabled={!item.canRestore}
          onClick={(e) => {
            e.stopPropagation();
            onRestore(task.id);
          }}
          {...tip(item.canRestore && '되살리기', { side: 'top', kbd: '↵' })}
        >
          <Icon name="undo" size={14} />
          되살리기
        </button>
        <button
          type="button"
          className={ui.iconBtn}
          aria-label="영구 삭제"
          disabled={!item.canRestore}
          onClick={(e) => {
            e.stopPropagation();
            onPurge(task.id);
          }}
          {...tip(item.canRestore && '영구 삭제', { side: 'top', kbd: isApple() ? '⌫' : 'Del' })}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  );
}
