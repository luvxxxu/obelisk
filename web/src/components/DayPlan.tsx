'use client';

import {
  addDays,
  formatDurationKo,
  formatRelativeKo,
  formatShortKo,
  formatTimeKo,
  formatTimeRangeKo,
  fromMinutes,
  toMinutes,
  type DayPlan as Proposal,
  type DayView,
  type ISODate,
  type OverviewTask,
  type TimeBlock,
} from '@obelisk/core';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cx } from '@/lib/format';
import { usePref } from '@/lib/hooks';
import { selectTask, useApp } from '@/lib/store';
import { applyPlan, clearDay, createBlock, deleteBlock, previewPlan, updateBlock, useDay, useRunning } from '@/lib/timeplan';
import { Icon } from './Icon';
import { Button, Spinner, Switch, tip, ui } from './primitives';
import s from './DayPlan.module.css';

const HOUR_PX = 64;
const PX = HOUR_PX / 60;
const SNAP = 15;
const snap = (m: number) => Math.round(m / SNAP) * SNAP;
const clampDay = (m: number) => Math.max(0, Math.min(1439, m));

interface Box {
  key: string;
  taskId: string;
  start: number;
  end: number;
  kind: 'event' | 'block' | 'ghost';
  block?: TimeBlock;
  locked?: boolean;
  fixed?: boolean;
}

/** Side-by-side columns for boxes that overlap (meetings over a block, two events at once). */
function layout(boxes: Box[]): (Box & { col: number; cols: number })[] {
  const sorted = [...boxes].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: (Box & { col: number; cols: number })[] = [];
  let group: (Box & { col: number; cols: number })[] = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...group.map((g) => g.col + 1));
    for (const g of group) g.cols = cols;
    out.push(...group);
    group = [];
  };
  for (const b of sorted) {
    if (b.start >= groupEnd && group.length) flush();
    const used = new Set(group.filter((g) => g.end > b.start).map((g) => g.col));
    let col = 0;
    while (used.has(col)) col++;
    group.push({ ...b, col, cols: 1 });
    groupEnd = Math.max(groupEnd, b.end);
  }
  if (group.length) flush();
  return out;
}

/** The first gap of at least `want` minutes (or the largest that fits a 25-minute piece) after `from`. */
function nextGap(view: DayView, want: number, from: number): { start: number; end: number } | null {
  const work = { start: toMinutes(view.hours.start), end: toMinutes(view.hours.end) };
  const busy = [
    ...view.hours.breaks.map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) })),
    ...view.events.map((e) => ({ start: toMinutes(e.start), end: toMinutes(e.end) })),
    ...view.blocks.map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) })),
  ].sort((a, b) => a.start - b.start);
  let cursor = Math.max(work.start, Math.ceil(from / 5) * 5);
  for (const b of [...busy, { start: work.end, end: work.end }]) {
    if (b.start > cursor) {
      const room = Math.min(b.start, work.end) - cursor;
      if (room >= Math.min(want, 25)) return { start: cursor, end: cursor + Math.min(want, room) };
    }
    cursor = Math.max(cursor, b.end);
    if (cursor >= work.end) break;
  }
  return null;
}

export function DayPlanView() {
  const app = useApp();
  const [date, setDate] = useState<ISODate>(app.today);
  useEffect(() => setDate(app.today), [app.today]);
  const { view, loading } = useDay(date);
  const running = useRunning();
  const [fillAhead, setFillAhead] = usePref<'on' | 'off'>('plan-fill-ahead', 'off');
  const [proposal, setProposal] = useState<{ plan: Proposal; tasks: OverviewTask[] } | null>(null);
  const [planning, setPlanning] = useState(false);
  useEffect(() => setProposal(null), [date]);

  const tasks = useMemo(() => {
    const m = new Map<string, OverviewTask>();
    for (const t of view?.tasks ?? []) m.set(t.id, t);
    for (const t of proposal?.tasks ?? []) m.set(t.id, t);
    return m;
  }, [view, proposal]);
  const colors = useMemo(() => new Map((view?.projects ?? []).map((p) => [p.id, p.color])), [view]);
  const spaceName = (id: string) => {
    if (id === app.workspace?.id) return null;
    const w = app.workspaces.find((x) => x.id === id);
    return w ? (w.kind === 'personal' ? '개인 공간' : w.name) : null;
  };

  if (!view) {
    return (
      <div className={s.loading}>
        <Spinner label="하루 계획을 불러오는 중" />
      </div>
    );
  }

  const past = date < view.today;
  const isToday = date === view.today;
  const nowMin = isToday ? view.now.minutes : null;
  const workStart = toMinutes(view.hours.start);
  const workEnd = toMinutes(view.hours.end);
  const from = Math.max(0, Math.floor(workStart / 60) - 1) * 60;
  const to = Math.min(24, Math.ceil(workEnd / 60) + 1) * 60;
  const height = (to - from) * PX;
  const over = view.needed - view.capacity;

  const boxes: Box[] = [
    ...view.events.map((e) => ({ key: `e${e.taskId}`, taskId: e.taskId, start: toMinutes(e.start), end: Math.max(toMinutes(e.end), toMinutes(e.start) + 15), kind: 'event' as const, fixed: e.fixed })),
    ...view.blocks.map((b) => ({ key: b.id, taskId: b.taskId, start: toMinutes(b.start), end: toMinutes(b.end), kind: 'block' as const, block: b, locked: b.locked })),
    ...(proposal?.plan.blocks.filter((b) => !b.kept).map((b, i) => ({ key: `g${i}`, taskId: b.taskId, start: toMinutes(b.start), end: toMinutes(b.end), kind: 'ghost' as const })) ?? []),
  ];

  const startPreview = async () => {
    setPlanning(true);
    const r = await previewPlan(date, fillAhead === 'on');
    setPlanning(false);
    if (r) setProposal({ plan: r.plan, tasks: r.tasks });
  };
  const save = async () => {
    setPlanning(true);
    const ok = await applyPlan(date, fillAhead === 'on');
    setPlanning(false);
    if (ok) setProposal(null);
  };
  const place = (taskId: string, minutes: number) => {
    const gap = nextGap(view, minutes, nowMin ?? 0);
    if (!gap) return;
    void createBlock({ taskId, date, start: fromMinutes(gap.start), end: fromMinutes(gap.end) });
  };

  const pending = proposal ? proposal.plan.unplaced.map((u) => ({ ...u })) : view.pending;
  const newCount = proposal?.plan.blocks.filter((b) => !b.kept).length ?? 0;

  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <div className={s.nav}>
          <button type="button" className={ui.iconBtn} onClick={() => setDate(addDays(date, -1))} aria-label="전날" {...tip('전날', { side: 'top' })}>
            <Icon name="chevronLeft" size={16} />
          </button>
          <span className={s.dateLabel}>
            {formatRelativeKo(date, view.today)}
            {!formatRelativeKo(date, view.today).includes('월') && <span className={s.dateSub}>{formatShortKo(date)}</span>}
          </span>
          <button type="button" className={ui.iconBtn} onClick={() => setDate(addDays(date, 1))} aria-label="다음 날" {...tip('다음 날', { side: 'top' })}>
            <Icon name="chevronRight" size={16} />
          </button>
          {!isToday && (
            <button type="button" className={s.todayBtn} onClick={() => setDate(view.today)}>
              오늘
            </button>
          )}
          {loading && <span className={cx(ui.spinner, s.spin)} aria-hidden="true" />}
        </div>
        {!past && (
          <div className={s.tools}>
            <label className={s.ahead} {...tip('계획한 일을 다 넣고도 시간이 남으면 일주일 안에 마감인 일을 당겨 와요', { side: 'top' })}>
              <Switch checked={fillAhead === 'on'} onChange={(v) => setFillAhead(v ? 'on' : 'off')} label="남는 시간에 다가오는 일 채우기" />
              <span>다가오는 일도</span>
            </label>
            {view.blocks.some((b) => !b.locked) && !proposal && (
              <Button variant="ghost" size="sm" onClick={() => void clearDay(date, true)} {...tip('직접 놓은 블록(고정)은 남겨요', { side: 'top' })}>
                비우기
              </Button>
            )}
            <Button size="sm" onClick={() => void startPreview()} disabled={planning}>
              <Icon name="sliders" size={14} />
              {view.blocks.length ? '다시 짜기' : '자동으로 채우기'}
            </Button>
          </div>
        )}
      </div>

      <div className={s.stats}>
        <Stat label="일할 수 있는 시간" value={view.capacity} />
        <Stat label="계획" value={view.planned} />
        <Stat label="필요한 시간" value={view.needed} tone={over > 0 ? 'warn' : undefined} />
        {!view.workday && <span className={s.offday}>쉬는 날이에요</span>}
        {over > 0 && !past && (
          <span className={s.overflow}>
            <Icon name="alert" size={14} />
            {formatDurationKo(over)} 넘쳐요. 미루거나 나눌 일을 골라 보세요
          </span>
        )}
      </div>

      {proposal && (
        <div className={s.proposal} role="status">
          <Icon name="sliders" size={15} />
          <span className={s.proposalText}>
            블록 {newCount}개를 제안했어요{proposal.plan.unplaced.length ? ` · ${proposal.plan.unplaced.length}개는 들어가지 않아요` : ''}
            {proposal.plan.late.length ? ` · ${proposal.plan.late.length}개는 마감 시각을 넘겨요` : ''}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setProposal(null)}>
            취소
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={planning || !newCount}>
            이대로 저장
          </Button>
        </div>
      )}

      <div className={s.layout}>
        <Grid
          date={date}
          view={view}
          boxes={boxes}
          tasks={tasks}
          colors={colors}
          spaceName={spaceName}
          from={from}
          to={to}
          height={height}
          nowMin={nowMin}
          runningTaskId={running?.task.id ?? null}
          readOnly={past || !!proposal}
          openTask={(t) => t.workspaceId === app.workspace?.id && selectTask(t.id)}
          onDropTask={(taskId, start, minutes) => void createBlock({ taskId, date, start: fromMinutes(start), end: fromMinutes(clampDay(start + minutes)) })}
        />

        <aside className={s.side}>
          <h3 className={s.sideTitle}>
            계획에 없는 일
            {pending.length > 0 && <span className={s.count}>{pending.length}</span>}
          </h3>
          {pending.length === 0 ? (
            <p className={s.sideEmpty}>{view.blocks.length || proposal ? '오늘 할 일이 모두 시간표에 있어요.' : '오늘 할 일이 없어요.'}</p>
          ) : (
            <ul className={s.pending}>
              {pending.map((p) => {
                const t = tasks.get(p.taskId);
                if (!t) return null;
                const space = spaceName(t.workspaceId);
                return (
                  <li
                    key={p.taskId}
                    className={s.pendingItem}
                    draggable={!past && !proposal}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/x-obelisk-task', JSON.stringify({ taskId: p.taskId, minutes: p.minutes }));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                  >
                    <span className={s.swatch} style={{ background: t.projectId && colors.get(t.projectId) ? `var(--c-${colors.get(t.projectId)})` : 'var(--text-4)' }} />
                    <button type="button" className={s.pendingTitle} onClick={() => t.workspaceId === app.workspace?.id && selectTask(t.id)} {...tip(t.workspaceId === app.workspace?.id ? null : '다른 공간의 작업이에요', { side: 'top' })}>
                      <span className={s.ref}>#{t.number}</span> {t.title}
                      {space && <span className={s.space}>{space}</span>}
                    </button>
                    <span className={s.pendingMeta} data-reason={p.reason ?? undefined}>
                      {formatDurationKo(p.minutes)}
                      {p.reason === 'blocked' ? ' · 선행 작업 대기' : p.reason === 'no_time' ? ' · 시간 부족' : ''}
                    </span>
                    {!past && !proposal && p.reason !== 'blocked' && (
                      <button type="button" className={s.placeBtn} onClick={() => place(p.taskId, p.minutes)} aria-label="빈 시간에 넣기" {...tip('다음 빈 시간에 넣기', { side: 'top' })}>
                        <Icon name="plus" size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {(proposal?.plan.late ?? view.late).length > 0 && (
            <div className={s.late}>
              <Icon name="clock" size={14} />
              <div>
                {(proposal?.plan.late ?? view.late).map((l) => {
                  const t = tasks.get(l.taskId);
                  return (
                    <p key={l.taskId}>
                      <strong>#{t?.number}</strong> {t?.title}: 마감 {formatTimeKo(l.dueTime)}인데 {formatTimeKo(l.end)}에 끝나요
                    </p>
                  );
                })}
              </div>
            </div>
          )}
          <p className={s.sideHint}>
            {past ? '지난 날의 계획이에요.' : '목록을 시간표로 끌어다 놓거나 + 로 빈 시간에 넣어요. 블록은 끌어서 옮기고 아래 끝을 끌어 길이를 바꿔요. 직접 옮긴 블록은 다시 짜도 그대로예요.'}
          </p>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <span className={s.stat} data-tone={tone}>
      <span className={s.statLabel}>{label}</span>
      <span className={s.statValue}>{value ? formatDurationKo(value) : '0분'}</span>
    </span>
  );
}

function Grid({
  date,
  view,
  boxes,
  tasks,
  colors,
  spaceName,
  from,
  to,
  height,
  nowMin,
  runningTaskId,
  readOnly,
  onDropTask,
  openTask,
}: {
  openTask: (t: OverviewTask) => void;
  date: ISODate;
  view: DayView;
  boxes: Box[];
  tasks: Map<string, OverviewTask>;
  colors: Map<string, string>;
  spaceName: (id: string) => string | null;
  from: number;
  to: number;
  height: number;
  nowMin: number | null;
  runningTaskId: string | null;
  readOnly: boolean;
  onDropTask: (taskId: string, start: number, minutes: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; mode: 'move' | 'resize'; y0: number; start: number; end: number; dy: number } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const hours = Array.from({ length: (to - from) / 60 + 1 }, (_, i) => from + i * 60);
  const y = (m: number) => (m - from) * PX;
  const minuteAt = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    return from + (clientY - r.top) / PX;
  };
  const workStart = toMinutes(view.hours.start);
  const workEnd = toMinutes(view.hours.end);

  const onPointerDown = (e: ReactPointerEvent, box: Box, mode: 'move' | 'resize') => {
    if (readOnly || !box.block || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: box.block.id, mode, y0: e.clientY, start: box.start, end: box.end, dy: 0 });
  };
  const moved = (d: NonNullable<typeof drag>) => {
    const delta = snap(d.dy / PX);
    if (d.mode === 'move') {
      const len = d.end - d.start;
      const start = Math.max(from, Math.min(to - len, d.start + delta));
      return { start, end: start + len };
    }
    return { start: d.start, end: Math.max(d.start + SNAP, Math.min(to, d.end + delta)) };
  };

  return (
    <div
      className={s.grid}
      onDragOver={(e) => {
        if (readOnly || !e.dataTransfer.types.includes('application/x-obelisk-task')) return;
        e.preventDefault();
        setDropAt(snap(minuteAt(e.clientY)));
      }}
      onDragLeave={() => setDropAt(null)}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData('application/x-obelisk-task');
        setDropAt(null);
        if (!raw || readOnly) return;
        e.preventDefault();
        const { taskId, minutes } = JSON.parse(raw) as { taskId: string; minutes: number };
        onDropTask(taskId, Math.max(from, snap(minuteAt(e.clientY))), Math.max(15, minutes));
      }}
    >
      <div className={s.hours} style={{ height }}>
        {hours.map((h) => (
          <span key={h} className={s.hourLabel} style={{ top: y(h) }}>
            {h < 1440 ? formatTimeKo(fromMinutes(h)).replace(':00', '시') : ''}
          </span>
        ))}
      </div>
      <div ref={ref} className={s.canvas} style={{ height }}>
        {/* outside working hours and breaks are tinted */}
        <span className={s.off} style={{ top: 0, height: Math.max(0, y(workStart)) }} />
        <span className={s.off} style={{ top: y(workEnd), height: Math.max(0, height - y(workEnd)) }} />
        {view.hours.breaks.map((b) => (
          <span key={b.start} className={s.break} style={{ top: y(toMinutes(b.start)), height: (toMinutes(b.end) - toMinutes(b.start)) * PX }}>
            <span className={s.breakLabel}>쉬는 시간</span>
          </span>
        ))}
        {hours.map((h) => (
          <span key={h} className={s.line} style={{ top: y(h) }} />
        ))}
        {nowMin !== null && nowMin >= from && nowMin <= to && (
          <span className={s.now} style={{ top: y(nowMin) }}>
            <span className={s.nowDot} />
          </span>
        )}
        {dropAt !== null && <span className={s.dropLine} style={{ top: y(dropAt) }} />}

        {layout(boxes).map((b) => {
          const live = drag && b.block?.id === drag.id ? moved(drag) : null;
          const start = live?.start ?? b.start;
          const end = live?.end ?? b.end;
          const t = tasks.get(b.taskId);
          const color = t?.projectId ? colors.get(t.projectId) : undefined;
          const done = t?.status === 'done' || t?.status === 'canceled';
          const short = end - start < 40;
          const space = t ? spaceName(t.workspaceId) : null;
          return (
            <div
              key={b.key}
              className={cx(s.box, s[b.kind], done && s.boxDone, live && s.dragging)}
              data-color={color}
              style={{
                top: y(start),
                height: Math.max(14, (end - start) * PX - 2),
                left: `calc(${(b.col / b.cols) * 100}% + 2px)`,
                width: `calc(${100 / b.cols}% - 4px)`,
                ...(color && b.kind !== 'event' ? ({ '--box-bg': `var(--c-${color}-bg)`, '--box-ink': `var(--c-${color}-text)`, '--box-edge': `var(--c-${color})` } as React.CSSProperties) : {}),
              }}
              onPointerDown={(e) => onPointerDown(e, b, 'move')}
              onPointerMove={(e) => drag && b.block?.id === drag.id && setDrag({ ...drag, dy: e.clientY - drag.y0 })}
              onPointerUp={() => {
                if (!drag || b.block?.id !== drag.id) return;
                const next = moved(drag);
                setDrag(null);
                if (Math.abs(drag.dy) < 3) {
                  if (t) openTask(t);
                  return;
                }
                if (next.start !== b.start || next.end !== b.end) void updateBlock(b.block!, { start: fromMinutes(next.start), end: fromMinutes(clampDay(next.end)) });
              }}
              onClick={() => b.kind !== 'block' && t && openTask(t)}
              title={t ? `#${t.number} ${t.title}` : undefined}
            >
              <span className={s.boxTitle} data-short={short || undefined}>
                {b.kind === 'event' && b.fixed && <Icon name="lock" size={11} />}
                {b.locked && <Icon name="pin" size={11} />}
                {runningTaskId === b.taskId && <span className={s.liveDot} aria-label="기록 중" />}
                <span className={s.boxText}>{t ? t.title : '볼 수 없는 작업'}</span>
                {short && <span className={s.boxTime}>{formatTimeKo(fromMinutes(start))}</span>}
              </span>
              {!short && (
                <span className={s.boxTime}>
                  {formatTimeRangeKo(fromMinutes(start), fromMinutes(clampDay(end)))}
                  {space ? ` · ${space}` : ''}
                </span>
              )}
              {b.block && !readOnly && (
                <>
                  <button
                    type="button"
                    className={s.boxRemove}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteBlock(b.block!);
                    }}
                    aria-label="블록 지우기"
                  >
                    <Icon name="x" size={12} />
                  </button>
                  <span className={s.resize} onPointerDown={(e) => onPointerDown(e, b, 'resize')} aria-hidden="true" />
                </>
              )}
            </div>
          );
        })}
      </div>
      <span className={s.srOnly}>{date}</span>
    </div>
  );
}
