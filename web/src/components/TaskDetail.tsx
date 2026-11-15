'use client';

import {
  addDays,
  diffDays,
  formatRelativeKo,
  formatShortKo,
  PRIORITY_LABEL_KO,
  STATUS_LABEL_KO,
  wouldCreateCycle,
  type ISODate,
  type Priority,
  type Task,
  type TaskStatus,
} from '@obelisk/core';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cx, daysLabel, overdueLabel } from '@/lib/format';
import { previewFor, requestDateChange } from '@/lib/reschedule';
import {
  addDependency,
  createProject,
  deleteTask,
  removeDependency,
  reschedule,
  selectTask,
  toggleDone,
  updateTask,
  useApp,
} from '@/lib/store';
import { toast } from '@/lib/toast';
import { DatePickerPanel } from './DatePicker';
import { Icon, type IconName } from './Icon';
import { ImpactView } from './ImpactView';
import { AutoTextarea, Badge, ConfirmModal, isEnter, Popover, Separator, Switch, tip, ui, useDisclosure } from './primitives';
import { Checkbox, shiftSpan } from './TaskRow';
import s from './TaskDetail.module.css';

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done', 'canceled'];
const PRIORITIES: Priority[] = [0, 1, 2, 3];
const PRIORITY_COLOR: Record<Priority, string> = {
  0: 'var(--text-3)',
  1: 'var(--info)',
  2: 'var(--warn)',
  3: 'var(--danger)',
};
const FIXED_HINT = '회의·출시일처럼 움직일 수 없는 약속. 앞 작업이 늦어져도 밀리지 않고 ‘충돌’로 알려줘요.';

/* ───────── small presentational helpers (UI only) */

/** Focus something inside a just-opened popover. Popovers render hidden for one frame while they
 *  measure, so `autoFocus` alone can miss; this retries once they are visible. Fine pointers only,
 *  so phones don't pop the keyboard over the panel. */
function useFocusWhenOpen(open: boolean, ref: RefObject<HTMLElement | null>, selector?: string) {
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    if (!selector && !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    const id = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      const el = selector ? root.querySelector<HTMLElement>(selector) : root;
      el?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open, ref, selector]);
}

/** Arrow / Home / End move between items of a menu (and keep the global j/k handler out of it). */
function menuKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)'));
  if (!items.length) return;
  e.preventDefault();
  e.stopPropagation();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const n =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? (i + 1) % items.length
          : (i - 1 + items.length) % items.length;
  items[n]?.focus();
}

function Chevron() {
  return <Icon name="chevronDown" size={14} className={s.chev} />;
}

function StatusIcon({ status, size = 15 }: { status: TaskStatus; size?: number }) {
  // Inline colours so menu-item icon rules can't flatten them (colour = meaning: doing info, done ok).
  if (status === 'done') return <Icon name="checkCircle" size={size} style={{ color: 'var(--ok)' }} />;
  if (status === 'canceled') return <Icon name="xCircle" size={size} style={{ color: 'var(--text-4)' }} />;
  if (status === 'doing') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: 'var(--info)' }}>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.9" />
        <path d="M12 6.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" />
      </svg>
    );
  }
  return <Icon name="circle" size={size} style={{ color: 'var(--text-3)' }} />;
}

function PriorityIcon({ p, size = 14 }: { p: Priority; size?: number }) {
  if (p === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: 'var(--text-3)' }}>
        <path d="M5 12h2.5M10.75 12h2.5M16.5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return <Icon name="flag" size={size} style={{ color: PRIORITY_COLOR[p] }} />;
}

/** relative label ("금요일") gets the plain date next to it ("11/20"); full dates don't. */
function dateMeta(d: ISODate, today: ISODate): string | null {
  const rel = formatRelativeKo(d, today);
  if (rel.includes('월 ')) return null;
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
}

/* ───────── panel */

export function TaskDetail({ taskId }: { taskId: string }) {
  const app = useApp();
  const task = app.tasks[taskId];
  if (!task) {
    return (
      <div className={s.panel}>
        <div className={s.top}>
          <span className={s.topLabel}>작업 상세</span>
          <div className={s.topActions}>
            <button className={ui.iconBtn} onClick={() => selectTask(null)} aria-label="닫기" {...tip('닫기', { side: 'bottom', kbd: 'Esc' })}>
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className={s.missing}>
          <span className={s.missingIcon}>
            <Icon name="search" size={18} />
          </span>
          <div className={s.missingTitle}>작업을 찾을 수 없어요</div>
          <div className={s.missingBody}>삭제되었을 수 있어요.</div>
        </div>
      </div>
    );
  }
  return <TaskDetailInner key={task.id} task={task} />;
}

function TaskDetailInner({ task }: { task: Task }) {
  const { today, projects, tasks, deps } = useApp();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const del = useDisclosure();
  const more = useDisclosure();
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setNotes(task.notes), [task.notes]);

  const saveTitle = () => {
    const t = title.trim();
    if (!t) return setTitle(task.title);
    if (t !== task.title) void updateTask(task.id, { title: t });
  };
  const saveNotes = () => {
    if (notes !== task.notes) void updateTask(task.id, { notes });
  };

  const project = projects.find((p) => p.id === task.projectId) ?? null;
  const blockers = deps.filter((d) => d.taskId === task.id).map((d) => tasks[d.dependsOnId]).filter(Boolean) as Task[];
  const dependents = deps.filter((d) => d.dependsOnId === task.id).map((d) => tasks[d.taskId]).filter(Boolean) as Task[];
  const active = task.status === 'todo' || task.status === 'doing';

  const setStart = (d: ISODate | null) => {
    let due = task.dueDate;
    if (d && due && d > due) {
      const len = task.startDate ? diffDays(due, task.startDate) : 0;
      due = addDays(d, len);
    }
    requestDateChange(task.id, { startDate: d, dueDate: due });
  };
  const setDue = (d: ISODate | null) => {
    let start = task.startDate;
    if (d && start && start > d) start = d;
    if (!d) start = task.startDate;
    requestDateChange(task.id, { startDate: start, dueDate: d });
  };

  const dueOverdue = active && !!task.dueDate && task.dueDate < today;

  return (
    <div className={s.panel}>
      <div className={s.top}>
        <span className={s.ref}>#{task.number}</span>
        {project && (
          <span className={s.crumb}>
            <span className={ui.dot} style={{ background: `var(--c-${project.color})` }} />
            <span className={ui.truncate}>{project.name}</span>
          </span>
        )}
        <div className={s.topActions}>
          <button
            className={ui.iconBtn}
            aria-label="링크 복사"
            {...tip('링크 복사', { side: 'bottom' })}
            onClick={() => {
              void navigator.clipboard?.writeText(`${location.origin}/t/${task.id}`);
              toast.show('작업 링크를 복사했어요');
            }}
          >
            <Icon name="link" size={15} />
          </button>
          <button
            ref={moreRef}
            className={ui.iconBtn}
            onClick={more.toggle}
            aria-label="더 보기"
            aria-haspopup="menu"
            aria-expanded={more.open}
            data-active={more.open}
            {...tip(!more.open && '더 보기', { side: 'bottom' })}
          >
            <Icon name="more" size={18} />
          </button>
          <Separator orientation="vertical" className={s.topSep} />
          <button
            className={ui.iconBtn}
            onClick={() => selectTask(null)}
            aria-label="닫기 (Esc)"
            {...tip('닫기', { side: 'bottom', kbd: 'Esc' })}
          >
            <Icon name="x" />
          </button>
        </div>
        <Popover anchor={moreRef} open={more.open} onClose={more.close} align="end" width={208}>
          <button
            className={ui.menuItem}
            onClick={() => {
              more.close();
              void updateTask(task.id, { status: task.status === 'canceled' ? 'todo' : 'canceled' });
            }}
          >
            <Icon name="archive" size={15} />
            {task.status === 'canceled' ? '취소 해제' : '작업 취소 (보관)'}
          </button>
          <div className={ui.menuSep} />
          <button
            className={ui.menuItem}
            data-tone="danger"
            onClick={() => {
              more.close();
              del.setOpen(true);
            }}
          >
            <Icon name="trash" size={15} />
            삭제
          </button>
        </Popover>
      </div>

      <div className={s.scroll}>
        <div className={s.titleRow}>
          <span className={s.checkWrap}>
            <Checkbox task={task} onToggle={() => void toggleDone(task.id)} size={22} />
          </span>
          <div className={s.titleField}>
            <AutoTextarea
              className={cx(s.title, task.status === 'done' && s.titleDone)}
              value={title}
              onChange={setTitle}
              onBlur={saveTitle}
              placeholder="작업 제목"
              onKeyDown={(e) => {
                if (isEnter(e)) {
                  e.preventDefault();
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
            />
          </div>
        </div>

        <div className={s.props}>
          <Prop icon="circleDashed" label="상태">
            <SelectMenu
              label="상태"
              value={task.status}
              options={STATUSES.map((st) => ({ value: st, label: STATUS_LABEL_KO[st], icon: <StatusIcon status={st} /> }))}
              onSelect={(st) => void updateTask(task.id, { status: st })}
            />
          </Prop>

          <Prop icon="flag" label="우선순위">
            <SelectMenu
              label="우선순위"
              value={task.priority}
              options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL_KO[p], icon: <PriorityIcon p={p} /> }))}
              onSelect={(p) => void updateTask(task.id, { priority: p })}
            />
          </Prop>

          <Prop icon="calendar" label="시작일">
            <DateField
              label="시작"
              placeholder="시작일 설정"
              value={task.startDate}
              today={today}
              onChange={setStart}
              range={[task.startDate, task.dueDate]}
            />
          </Prop>

          <Prop icon="calendarClock" label="마감일">
            <DateField
              label="마감"
              placeholder="마감일 설정"
              value={task.dueDate}
              today={today}
              onChange={setDue}
              range={[task.startDate, task.dueDate]}
              overdue={dueOverdue}
            />
            {dueOverdue && task.dueDate && <Badge tone="danger">{overdueLabel(task.dueDate, today)}</Badge>}
          </Prop>

          <Prop icon="folder" label="프로젝트">
            <ProjectPicker value={task.projectId} onChange={(pid) => void updateTask(task.id, { projectId: pid })} />
          </Prop>

          <Prop icon="pin" label="고정 일정" hint={FIXED_HINT}>
            <Switch checked={task.fixed} onChange={(v) => void updateTask(task.id, { fixed: v })} label="고정 일정" />
            <span className={s.switchText}>{task.fixed ? '늦어져도 밀리지 않아요' : '회의·출시일처럼 못 옮기는 일정'}</span>
          </Prop>
        </div>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <h3 className={s.sectionTitle}>
              <Icon name="list" size={14} />
              메모
            </h3>
          </div>
          <div className={s.notesField}>
            <AutoTextarea
              className={s.notes}
              value={notes}
              onChange={setNotes}
              onBlur={saveNotes}
              placeholder="메모, 링크, 체크리스트…"
              minRows={3}
            />
          </div>
        </section>

        <DependencySection
          title="먼저 끝나야 하는 작업"
          empty="이 작업을 막고 있는 작업이 없어요"
          list={blockers}
          task={task}
          mode="blockedBy"
        />
        <DependencySection
          title="이 작업을 기다리는 작업"
          empty="이 작업 뒤에 이어지는 작업이 없어요"
          list={dependents}
          task={task}
          mode="blocks"
        />

        {active && (task.dueDate || task.startDate) && <DelaySimulator task={task} dependents={dependents} />}

        <footer className={s.footer}>
          <span className={s.footerItem}>#{task.number}</span>
          <span className={s.footerItem}>
            {new Date(task.createdAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })} 생성
          </span>
          {task.postponedCount > 0 && <span className={s.footerItem}>{task.postponedCount}회 미룸</span>}
          {task.completedAt && (
            <span className={s.footerItem}>
              {new Date(task.completedAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })} 완료
            </span>
          )}
        </footer>
      </div>

      <ConfirmModal
        open={del.open}
        onClose={del.close}
        title="작업을 삭제할까요?"
        body={
          <>
            “{task.title}”과(와) 연결된 의존 관계가 모두 삭제돼요. 되돌릴 수 없어요.
          </>
        }
        onConfirm={() => void deleteTask(task.id)}
      />
    </div>
  );
}

function Prop({ icon, label, hint, children }: { icon: IconName; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={s.prop}>
      <div className={s.propLabel}>
        <Icon name={icon} size={15} />
        <span className={s.propLabelText}>{label}</span>
        {hint && (
          <span className={s.hint} tabIndex={0} role="img" aria-label={hint} {...tip(hint, { side: 'top' })}>
            <Icon name="info" size={13} />
          </span>
        )}
      </div>
      <div className={s.propValue}>{children}</div>
    </div>
  );
}

/** Ghost "select trigger" + radio menu (shadcn Select look). Selecting calls `onSelect` once. */
function SelectMenu<T extends string | number>({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon: ReactNode }[];
  onSelect: (v: T) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const d = useDisclosure();
  const current = options.find((o) => o.value === value);
  useFocusWhenOpen(d.open, menuRef, '[aria-checked="true"]');

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={s.trigger}
        data-open={d.open}
        aria-haspopup="menu"
        aria-expanded={d.open}
        aria-label={`${label}: ${current?.label ?? ''}`}
        onClick={d.toggle}
      >
        {current?.icon}
        <span className={s.triggerText}>{current?.label}</span>
        <Chevron />
      </button>
      <Popover anchor={ref} open={d.open} onClose={d.close} width={196}>
        <div ref={menuRef} role="menu" aria-label={label} onKeyDown={menuKeys}>
          {options.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              className={ui.menuItem}
              data-selected={o.value === value}
              onClick={() => {
                d.close();
                onSelect(o.value);
                ref.current?.focus();
              }}
            >
              {o.icon}
              <span className={ui.truncate}>{o.label}</span>
              {o.value === value && <Icon name="check" size={14} className={s.menuCheck} />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function DateField({
  label,
  placeholder,
  value,
  today,
  onChange,
  range,
  overdue,
}: {
  label: string;
  placeholder: string;
  value: ISODate | null;
  today: ISODate;
  onChange: (d: ISODate | null) => void;
  range: [ISODate | null, ISODate | null];
  overdue?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const d = useDisclosure();
  const meta = value ? dateMeta(value, today) : null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={s.trigger}
        data-empty={!value}
        data-overdue={overdue}
        data-open={d.open}
        aria-haspopup="dialog"
        aria-expanded={d.open}
        aria-label={`${label}: ${value ? formatRelativeKo(value, today) : '없음'}`}
        onClick={d.toggle}
      >
        <span className={s.triggerText}>{value ? formatRelativeKo(value, today) : placeholder}</span>
        {meta && <span className={s.triggerMeta}>{meta}</span>}
        <Chevron />
      </button>
      <Popover anchor={ref} open={d.open} onClose={d.close}>
        <DatePickerPanel
          value={value}
          today={today}
          rangeStart={range[0]}
          rangeEnd={range[1]}
          onPick={(v) => {
            d.close();
            onChange(v);
          }}
        />
      </Popover>
    </>
  );
}

function ProjectPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { projects } = useApp();
  const pathname = usePathname();
  const ref = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const d = useDisclosure();
  const [q, setQ] = useState('');
  const current = projects.find((p) => p.id === value);
  const list = projects.filter((p) => !p.archivedAt && p.name.toLowerCase().includes(q.toLowerCase()));
  const canCreate = !!q.trim() && !list.some((p) => p.name.toLowerCase() === q.trim().toLowerCase());
  const href = current ? `/projects/${current.id}` : null;
  useFocusWhenOpen(d.open, inputRef);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={s.trigger}
        data-open={d.open}
        aria-haspopup="dialog"
        aria-expanded={d.open}
        onClick={d.toggle}
      >
        {current ? (
          <>
            <span className={ui.dot} style={{ background: `var(--c-${current.color})` }} />
            <span className={s.triggerText}>{current.name}</span>
          </>
        ) : (
          <>
            <Icon name="inbox" size={14} className={s.triggerIcon} />
            <span className={s.triggerText}>인박스</span>
          </>
        )}
        <Chevron />
      </button>
      {href && pathname !== href && (
        <Link href={href} className={ui.iconBtn} aria-label="프로젝트 열기" {...tip('프로젝트 열기', { side: 'top' })}>
          <Icon name="arrowUpRight" size={14} />
        </Link>
      )}
      <Popover anchor={ref} open={d.open} onClose={() => (d.close(), setQ(''))} width={260}>
        <div className={s.cmdInput}>
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            placeholder="프로젝트 검색 또는 새로 만들기"
            aria-label="프로젝트 검색 또는 새로 만들기"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={async (e) => {
              if (isEnter(e) && q.trim()) {
                const hit = list[0];
                if (hit) onChange(hit.id);
                else {
                  const p = await createProject({ name: q.trim() });
                  if (p) onChange(p.id);
                }
                d.close();
                setQ('');
              }
            }}
          />
        </div>
        <div className={s.cmdList}>
          <button className={ui.menuItem} data-selected={!value} onClick={() => (onChange(null), d.close())}>
            <Icon name="inbox" size={15} />
            <span className={ui.truncate}>인박스</span>
            {!value && <Icon name="check" size={14} className={s.menuCheck} />}
          </button>
          {list.length > 0 && <div className={ui.menuTitle}>프로젝트</div>}
          {list.map((p, i) => (
            <button
              key={p.id}
              className={ui.menuItem}
              data-selected={p.id === value}
              data-active={!!q.trim() && i === 0}
              onClick={() => (onChange(p.id), d.close(), setQ(''))}
            >
              <span className={ui.dot} style={{ background: `var(--c-${p.color})` }} />
              <span className={ui.truncate}>{p.name}</span>
              {p.id === value && <Icon name="check" size={14} className={s.menuCheck} />}
            </button>
          ))}
          {canCreate && (
            <>
              {list.length > 0 && <div className={ui.menuSep} />}
              <button
                className={ui.menuItem}
                data-active={list.length === 0}
                onClick={async () => {
                  const p = await createProject({ name: q.trim() });
                  if (p) onChange(p.id);
                  d.close();
                  setQ('');
                }}
              >
                <Icon name="plus" size={15} />
                <span className={ui.truncate}>새 프로젝트 “{q.trim()}”</span>
              </button>
            </>
          )}
        </div>
      </Popover>
    </>
  );
}

function DependencySection({
  title,
  empty,
  list,
  task,
  mode,
}: {
  title: string;
  empty: string;
  list: Task[];
  task: Task;
  mode: 'blockedBy' | 'blocks';
}) {
  const { tasks, deps, today, projects } = useApp();
  const ref = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const d = useDisclosure();
  const [q, setQ] = useState('');
  useFocusWhenOpen(d.open, inputRef);

  const candidates = useMemo(() => {
    const existing = new Set(list.map((t) => t.id));
    return Object.values(tasks)
      .filter((t) => t.id !== task.id && !existing.has(t.id) && (t.status === 'todo' || t.status === 'doing'))
      .filter((t) =>
        mode === 'blockedBy' ? !wouldCreateCycle(deps, task.id, t.id) : !wouldCreateCycle(deps, t.id, task.id),
      )
      .filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()) || String(t.number) === q.replace('#', ''))
      .sort((a, b) => (a.projectId === task.projectId ? 0 : 1) - (b.projectId === task.projectId ? 0 : 1) || b.number - a.number)
      .slice(0, 30);
  }, [tasks, deps, task, list, mode, q]);

  const add = async (other: Task) => {
    d.close();
    setQ('');
    if (mode === 'blockedBy') await addDependency(task.id, other.id);
    else await addDependency(other.id, task.id);
  };

  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <h3 className={s.sectionTitle}>
          <Icon name={mode === 'blockedBy' ? 'lock' : 'link'} size={14} />
          {title}
          {list.length > 0 && <span className={s.count}>{list.length}</span>}
        </h3>
        <button
          ref={ref}
          type="button"
          className={`${ui.btn} ${ui.ghost} ${ui.xs} ${s.addBtn}`}
          onClick={d.toggle}
          aria-haspopup="dialog"
          aria-expanded={d.open}
          aria-label={`${title} 추가`}
        >
          <Icon name="plus" size={14} /> 추가
        </button>
      </div>
      {list.length === 0 ? (
        <div className={s.depEmpty}>{empty}</div>
      ) : (
        <ul className={s.depList}>
          {list.map((t) => {
            const done = t.status === 'done' || t.status === 'canceled';
            const p = projects.find((x) => x.id === t.projectId);
            return (
              <li key={t.id} className={cx(s.dep, done && s.depDone)}>
                <StatusIcon status={t.status} size={15} />
                <button className={s.depTitle} onClick={() => selectTask(t.id)}>
                  <span className={s.depNum}>#{t.number}</span>
                  {t.title}
                </button>
                {p && p.id !== task.projectId && (
                  <span className={ui.dot} style={{ background: `var(--c-${p.color})` }} {...tip(p.name, { side: 'top' })} />
                )}
                <span className={s.depDate}>{t.dueDate ? formatShortKo(t.dueDate) : ''}</span>
                <button
                  className={s.depRemove}
                  aria-label="연결 해제"
                  {...tip('연결 해제', { side: 'top' })}
                  onClick={() =>
                    void (mode === 'blockedBy' ? removeDependency(task.id, t.id) : removeDependency(t.id, task.id))
                  }
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Popover anchor={ref} open={d.open} onClose={() => (d.close(), setQ(''))} width={320} align="end">
        <div className={s.cmdInput}>
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            placeholder="작업 검색 (제목 또는 #번호)"
            aria-label="작업 검색 (제목 또는 #번호)"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (isEnter(e) && candidates[0]) void add(candidates[0]);
            }}
          />
        </div>
        <div className={s.cmdList}>
          {candidates.length === 0 && <div className={s.noResult}>연결할 수 있는 작업이 없어요</div>}
          {candidates.map((t, i) => (
            <button key={t.id} className={ui.menuItem} data-active={!!q && i === 0} onClick={() => void add(t)}>
              <span className={s.depNum}>#{t.number}</span>
              <span className={ui.truncate}>{t.title}</span>
              {t.dueDate && <span className={ui.menuHint}>{formatRelativeKo(t.dueDate, today)}</span>}
            </button>
          ))}
        </div>
      </Popover>
    </section>
  );
}

function DelaySimulator({ task, dependents }: { task: Task; dependents: Task[] }) {
  const { today } = useApp();
  const [days, setDays] = useState<number | null>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const pick = useDisclosure();
  const anchor = (task.dueDate ?? task.startDate)!;

  const activeDependents = dependents.filter((t) => t.status === 'todo' || t.status === 'doing');
  const slack = useMemo(() => {
    let min: number | null = null;
    for (const t of activeDependents) {
      const st = t.startDate ?? t.dueDate;
      if (!st) continue;
      const v = Math.max(0, diffDays(st, anchor));
      min = min === null ? v : Math.min(min, v);
    }
    return min;
  }, [activeDependents, anchor]);

  const preview = useMemo(() => (days ? previewFor(task.id, shiftSpan(task, days)) : null), [days, task]);
  const oneDay = useMemo(() => previewFor(task.id, shiftSpan(task, 1)), [task]);
  const custom = !!days && ![1, 3, 7].includes(days);

  return (
    <section className={s.sim} aria-label="지연 영향 미리보기">
      <div className={s.simHead}>
        <span className={s.simIcon}>
          <Icon name="ripple" size={16} />
        </span>
        <div className={s.simText}>
          <h3 className={s.simTitle}>이 작업이 늦어지면?</h3>
          <p className={s.simSub}>
            {activeDependents.length === 0
              ? '뒤에 이어지는 작업이 없어서 미뤄도 다른 일정에는 영향이 없어요.'
              : slack === null
                ? `후속 작업 ${activeDependents.length}개가 기다리고 있어요.`
                : slack === 0
                  ? `여유 없음 · 하루만 늦어도 ${oneDay.report.summary.delayedCount}개 작업이 밀려요${oneDay.report.summary.conflictCount ? ` (고정 일정 충돌 ${oneDay.report.summary.conflictCount})` : ''}.`
                  : `여유 ${slack}일 · ${formatRelativeKo(addDays(anchor, slack), today)}까지는 미뤄도 다른 일정이 그대로예요.`}
          </p>
        </div>
      </div>
      <div className={s.simButtons} role="group" aria-label="얼마나 늦어질지 골라 보세요">
        {[1, 3, 7].map((n) => (
          <button key={n} className={s.simBtn} aria-pressed={days === n} onClick={() => setDays(days === n ? null : n)}>
            +{daysLabel(n)}
          </button>
        ))}
        <button ref={pickRef} className={s.simBtn} aria-pressed={custom} onClick={pick.toggle}>
          <Icon name="calendar" size={13} />
          {custom ? `+${daysLabel(days!)}` : '날짜…'}
        </button>
        <Popover anchor={pickRef} open={pick.open} onClose={pick.close}>
          <DatePickerPanel
            value={null}
            today={today}
            clearable={false}
            min={addDays(anchor, 1)}
            onPick={(d) => {
              pick.close();
              if (d) setDays(diffDays(d, anchor));
            }}
          />
        </Popover>
      </div>
      {preview && days && (
        <div className={s.simResult}>
          <ImpactView report={preview.report} />
          <div className={s.simActions}>
            <button className={`${ui.btn} ${ui.sm} ${ui.ghost}`} onClick={() => setDays(null)}>
              닫기
            </button>
            <button
              className={`${ui.btn} ${ui.sm} ${ui.secondary}`}
              onClick={async () => {
                if (await reschedule(preview.only, task.id)) setDays(null);
              }}
            >
              이 작업만 미루기
            </button>
            {preview.cascade.length > 1 && (
              <button
                className={`${ui.btn} ${ui.sm} ${ui.primary}`}
                onClick={async () => {
                  if (await reschedule(preview.cascade, task.id)) {
                    toast.show(`${preview.cascade.length}개 작업 일정을 함께 옮겼어요`);
                    setDays(null);
                  }
                }}
              >
                연쇄 적용 · {preview.cascade.length}개
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
