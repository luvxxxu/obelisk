'use client';

import { addDays, isOverdue, isToday, positionBetween, spread, type ProjectColor, type Task, type TaskStatus } from '@obelisk/core';
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { tip, ui } from '@/components/primitives';
import { cx, overdueLabel, spanLabel } from '@/lib/format';
import { usePref, useTasks } from '@/lib/hooks';
import { moveTasks, selectTask, toggleDone, useApp, type TaskMove } from '@/lib/store';
import { toast } from '@/lib/toast';
import { isApple } from '@/lib/ui-helpers';
import s from '../home.module.css';
import { Board, BoardCard, CardMeta, CardProps, CardSlot, Column, ColumnAdd, ColumnMore, Database, DropHint, type Hue, Tag } from './blocks';
import { useFlip } from './motion';
import { useBoardDnd, type BoardDrag } from './useBoardDnd';

/** Cards per board column before "외 n개 더 보기". */
const COLUMN_CAP = 6;
/** "급한 업무" = overdue, today, due within this many days, in progress, or high priority. */
const URGENT_DAYS = 3;

type Col = 'doing' | 'todo' | 'done';
/** 긴급도순: computed from dates/priority. 직접 정렬: the manual `position` the user dragged into. */
type Order = 'urgency' | 'manual';

/** Left → right, as drawn. ⌥←/→ walk this order. */
const COLS: readonly Col[] = ['doing', 'todo', 'done'];
const STATUS_OF: Record<Col, TaskStatus> = { doing: 'doing', todo: 'todo', done: 'done' };
const COLUMN: Record<Col, { title: string; hue: Hue; more: string }> = {
  doing: { title: '진행 중', hue: 'green', more: '/all' },
  todo: { title: '시작 전', hue: 'amber', more: '/today' },
  done: { title: '오늘 완료', hue: 'slate', more: '/logbook' },
};

const PRIORITY_TAG: Record<number, { label: string; hue: Hue } | undefined> = {
  3: { label: '높음', hue: 'red' },
  2: { label: '보통', hue: 'amber' },
  1: { label: '낮음', hue: 'slate' },
};

const KEY_SHORTCUTS = 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight';

/** Overdue first, then earliest date, then priority, then #number. */
function byUrgency(today: string) {
  return (a: Task, b: Task) => {
    const oa = isOverdue(a, today) ? 0 : 1;
    const ob = isOverdue(b, today) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const da = a.dueDate ?? a.startDate ?? '9999-12-31';
    const db = b.dueDate ?? b.startDate ?? '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    return b.priority - a.priority || a.number - b.number;
  };
}

const toMoves = (list: { id: string; position: number }[]): TaskMove[] => list.map((p) => ({ taskId: p.id, position: p.position }));

/**
 * 급한 업무 board: 진행 중 · 시작 전 · 오늘 완료.
 * Drag a card to reorder it or drop it in another column to change its status (long-press on touch);
 * ▶ on a 시작 전 card starts it; ⌥+arrows do the same from the keyboard.
 * The first reorder while sorted by urgency freezes what's on screen into manual positions and
 * switches the board to 직접 정렬 (one click on the toolbar chip goes back).
 */
export function UrgentBoard({ today, doneToday, onNew }: { today: string; doneToday: Task[]; onNew: () => void }) {
  const app = useApp();
  const tasks = useTasks();
  const [order, setOrder] = usePref<Order>('home-urgent-order', 'urgency');
  /** Cards moved here stay on the board even if they no longer look urgent (e.g. 진행 중 → 시작 전). */
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const boardRef = useRef<HTMLDivElement>(null);
  const capture = useFlip(boardRef);
  const cmp = useMemo(() => byUrgency(today), [today]);

  const lists = useMemo<Record<Col, Task[]>>(() => {
    const soon = addDays(today, URGENT_DAYS);
    const urgent = (t: Task) => {
      const d = t.dueDate ?? t.startDate;
      return t.status === 'doing' || t.priority === 3 || isOverdue(t, today) || isToday(t, today) || (!!d && d <= soon);
    };
    const sort = order === 'manual' ? (a: Task, b: Task) => a.position - b.position || cmp(a, b) : cmp;
    const open = tasks.filter((t) => (t.status === 'todo' || t.status === 'doing') && (kept.has(t.id) || urgent(t))).sort(sort);
    return {
      doing: open.filter((t) => t.status === 'doing'),
      todo: open.filter((t) => t.status === 'todo'),
      done: doneToday,
    };
  }, [tasks, today, order, kept, cmp, doneToday]);

  /** Index among the other cards of `to` where a card from `from` lands, given where the user aimed. */
  const landingIndex = useCallback(
    (id: string, from: Col, to: Col, aimed: number): number => {
      const others = lists[to].filter((t) => t.id !== id);
      if (to === 'done') return 0; // newest completion first
      if (order === 'urgency' && from !== to) {
        // Sorted by urgency, a status change lands where the sort puts it.
        const task = app.tasks[id];
        if (!task) return others.length;
        const i = others.findIndex((t) => cmp(task, t) < 0);
        return i < 0 ? others.length : i;
      }
      return Math.max(0, Math.min(aimed, others.length));
    },
    [lists, order, app.tasks, cmp],
  );

  const keep = useCallback((id: string) => setKept((k) => (k.has(id) ? k : new Set(k).add(id))), []);

  const commit = useCallback(
    (id: string, from: Col, to: Col, index: number) => {
      const task = app.tasks[id];
      if (!task) return;
      keep(id);

      if (to === 'done') {
        if (from !== 'done') void toggleDone(id); // its own toast + undo
        return;
      }

      const others = lists[to].filter((t) => t.id !== id);
      if (from === to && index === lists[from].findIndex((t) => t.id === id)) return;
      const status = task.status !== STATUS_OF[to] ? STATUS_OF[to] : undefined;
      let changes: TaskMove[];
      let switched = false;

      if (order === 'urgency' && from !== to) {
        changes = [{ taskId: id, position: task.position, status }];
      } else {
        const ids = [...others.slice(0, index).map((t) => t.id), id, ...others.slice(index).map((t) => t.id)];
        if (order === 'urgency') {
          // First manual move: freeze both open columns exactly as they look, then go manual.
          const other: Col = to === 'doing' ? 'todo' : 'doing';
          changes = [...toMoves(spread(ids)), ...toMoves(spread(lists[other].map((t) => t.id)))];
          switched = true;
        } else {
          const pos = positionBetween(others[index - 1]?.position, others[index]?.position);
          changes = pos === null ? toMoves(spread(ids)) : [{ taskId: id, position: pos }];
        }
        if (status) changes = changes.map((c) => (c.taskId === id ? { ...c, status } : c));
      }

      changes = changes.filter((c) => {
        const t = app.tasks[c.taskId];
        return !!t && (t.position !== c.position || (!!c.status && c.status !== t.status));
      });
      if (!changes.length) return;
      const undo: TaskMove[] = changes.map((c) => ({
        taskId: c.taskId,
        position: app.tasks[c.taskId]!.position,
        ...(c.status ? { status: app.tasks[c.taskId]!.status } : {}),
      }));

      if (switched) setOrder('manual');
      void moveTasks(changes).then((ok) => {
        if (!ok && switched) setOrder('urgency');
      });
      if (switched) {
        toast.show('직접 정렬로 바꿨어요 · 끌어 놓은 순서가 그대로 남아요', {
          action: {
            label: '긴급도순으로',
            run: () => {
              capture();
              setOrder('urgency');
            },
          },
        });
      } else if (status) {
        toast.show(`“${task.title}” ${COLUMN[to].title}으로 옮겼어요`, {
          action: {
            label: '실행 취소',
            run: () => {
              capture();
              void moveTasks(undo);
            },
          },
        });
      }
    },
    [app.tasks, lists, order, setOrder, capture, keep],
  );

  const onDrop = useCallback(
    (d: BoardDrag<Col> & { to: Col }) => commit(d.id, d.from, d.to, landingIndex(d.id, d.from, d.to, d.pointerIndex)),
    [commit, landingIndex],
  );
  const { drag, onPointerDown } = useBoardDnd<Col>({ boardRef, capture, onDrop });

  /** Buttons and keyboard: animate, move, and keep focus on the card that moved. */
  const moveBy = (id: string, from: Col, to: Col, aimed: number) => {
    capture();
    commit(id, from, to, landingIndex(id, from, to, aimed));
    requestAnimationFrame(() => boardRef.current?.querySelector<HTMLElement>(`[data-card="${id}"] [data-card-main]`)?.focus({ preventScroll: true }));
  };

  const onCardKey = (e: KeyboardEvent<HTMLButtonElement>, t: Task, col: Col, i: number) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (col === 'done') return;
      const next = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (next < 0 || next >= Math.min(lists[col].length, COLUMN_CAP)) return;
      moveBy(t.id, col, col, next);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const to = COLS[COLS.indexOf(col) + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (to) moveBy(t.id, col, to, Math.min(i, COLUMN_CAP - 1));
    }
  };

  const alt = isApple() ? '⌥' : 'Alt ';
  const projectOf = (id: string | null) => (id ? app.projects.find((p) => p.id === id) : undefined);

  const column = (col: Col) => {
    const all = lists[col];
    const others = drag ? all.filter((t) => t.id !== drag.id) : all;
    const visible = others.slice(0, COLUMN_CAP);
    const target = !!drag && drag.to === col;
    const lifting = !!drag && drag.from !== 'done';
    if (col === 'done' && !all.length && !lifting) return null;

    const items: ReactNode[] = visible.map((t, i) => (
      <TaskCard
        key={t.id}
        task={t}
        today={today}
        project={projectOf(t.projectId)}
        index={i}
        onPointerDown={(e) => onPointerDown(e, t.id, col, i)}
        onKeyDown={(e) => onCardKey(e, t, col, i)}
        onStart={col === 'todo' ? () => moveBy(t.id, 'todo', 'doing', 0) : undefined}
        onCheck={() => {
          keep(t.id);
          void toggleDone(t.id);
        }}
        startKbd={`${alt}←`}
      />
    ));
    if (target) {
      const at = Math.min(landingIndex(drag.id, drag.from, col, drag.pointerIndex), visible.length);
      items.splice(at, 0, <CardSlot key="__slot" id={drag.id} height={drag.height} />);
    } else if (col === 'done' && !visible.length) {
      items.push(
        <DropHint key="__hint" icon="check">
          여기에 놓으면 완료
        </DropHint>,
      );
    }
    const count = others.length + (target ? 1 : 0);
    const hidden = others.length - visible.length;

    return (
      <Column
        key={col}
        dropKey={col}
        dropTarget={target && drag.from !== col}
        ghost={col === 'done' && !all.length}
        hue={COLUMN[col].hue}
        title={COLUMN[col].title}
        count={count}
        footer={
          col === 'done' ? (
            hidden > 0 && <ColumnMore href={COLUMN[col].more} n={hidden} />
          ) : (
            <>
              {hidden > 0 && <ColumnMore href={COLUMN[col].more} n={hidden} />}
              <ColumnAdd label="새 작업" onClick={onNew} />
            </>
          )
        }
      >
        {items}
      </Column>
    );
  };

  const toggleOrder = () => {
    capture();
    setOrder(order === 'manual' ? 'urgency' : 'manual');
  };

  return (
    <Database
      icon="board"
      title="작업"
      href="/today"
      hrefLabel="오늘 보기"
      onNew={onNew}
      newLabel="새 작업"
      tools={
        <button
          type="button"
          className={cx(ui.btn, ui.ghost, ui.sm, s.dbChip)}
          onClick={toggleOrder}
          aria-label={`정렬: ${order === 'manual' ? '직접 정렬' : '긴급도순'}`}
          {...tip(order === 'manual' ? '긴급도순으로 보기' : '직접 정렬로 보기', {
            side: 'bottom',
            meta: '카드를 끌어 순서·상태를 바꿀 수 있어요',
          })}
        >
          <Icon name="sort" size={14} />
          {order === 'manual' ? '직접 정렬' : '긴급도순'}
        </button>
      }
    >
      <Board label="급한 업무 보드" ref={boardRef} dragging={!!drag}>
        {COLS.map(column)}
      </Board>
    </Database>
  );
}

/* ───────────────────────── task card */

function TaskCard({
  task,
  today,
  project,
  index,
  onPointerDown,
  onKeyDown,
  onStart,
  onCheck,
  startKbd,
}: {
  task: Task;
  today: string;
  project?: { name: string; color: ProjectColor };
  index: number;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  /** Shown on 시작 전 cards: move straight to 진행 중. */
  onStart?: () => void;
  onCheck: () => void;
  startKbd: string;
}) {
  const done = task.status === 'done';
  const overdue = isOverdue(task, today);
  const date = overdue && task.dueDate ? overdueLabel(task.dueDate, today) : spanLabel(task, today);
  const pr = PRIORITY_TAG[task.priority];

  return (
    <BoardCard
      icon={task.fixed ? 'pin' : 'fileText'}
      iconColor={task.fixed ? 'var(--c-red)' : undefined}
      title={task.title}
      done={done}
      index={index}
      onOpen={() => selectTask(task.id)}
      dragId={task.id}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      keyShortcuts={KEY_SHORTCUTS}
      actions={onStart ? 2 : 1}
      aside={
        <>
          {onStart && (
            <button className={s.cardStart} onClick={onStart} aria-label="진행 중으로 옮기기" {...tip('진행 중으로', { side: 'top', kbd: startKbd })}>
              <Icon name="play" size={11} strokeWidth={2.6} />
            </button>
          )}
          <button
            className={s.cardCheck}
            data-done={done || undefined}
            onClick={onCheck}
            aria-label={done ? '완료 취소' : '완료로 표시'}
            {...tip(done ? '완료 취소' : '완료', { side: 'top', kbd: 'X' })}
          >
            <Icon name="check" size={12} strokeWidth={3} />
          </button>
        </>
      }
    >
      {(pr || project) && (
        <CardProps>
          {pr && <Tag hue={pr.hue}>{pr.label}</Tag>}
          {project && <Tag hue={project.color}>{project.name}</Tag>}
        </CardProps>
      )}
      {date && !done && (
        <CardMeta icon={overdue ? 'alertCircle' : 'calendar'} tone={overdue ? 'danger' : undefined}>
          {date}
        </CardMeta>
      )}
      {task.postponedCount >= 2 && !done && <CardMeta icon="postpone">{task.postponedCount}회 미룸</CardMeta>}
    </BoardCard>
  );
}
