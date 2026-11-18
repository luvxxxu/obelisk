'use client';

import {
  addDays,
  diffDays,
  formatDaysKo,
  formatShortKo,
  weekday,
  type DateChangePreview,
  type DateSpan,
  type ISODate,
  type Task,
} from '@obelisk/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { previewFor, requestDateChange } from '@/lib/reschedule';
import { selectTask, useApp } from '@/lib/store';
import { Icon } from './Icon';
import s from './Timeline.module.css';

const DAY_W = 36;
const ROW_H = 40;
const HEAD_H = 52;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

type DragMode = 'move' | 'start' | 'end';

interface Drag {
  taskId: string;
  mode: DragMode;
  originX: number;
  delta: number;
  moved: boolean;
}

function spanOf(t: Pick<Task, 'startDate' | 'dueDate'>): { s: ISODate; e: ISODate } | null {
  const a = t.startDate ?? t.dueDate;
  const b = t.dueDate ?? t.startDate;
  return a && b ? { s: a, e: b } : null;
}

function nextSpan(t: Task, mode: DragMode, delta: number): DateSpan {
  const sp = spanOf(t)!;
  if (mode === 'move') {
    return {
      startDate: t.startDate ? addDays(t.startDate, delta) : null,
      dueDate: t.dueDate ? addDays(t.dueDate, delta) : null,
    };
  }
  if (mode === 'end') {
    const e = addDays(sp.e, delta);
    const end = e < sp.s ? sp.s : e;
    return { startDate: t.startDate ?? (t.dueDate ? sp.s : null), dueDate: end };
  }
  const st = addDays(sp.s, delta);
  const start = st > sp.e ? sp.e : st;
  return { startDate: start, dueDate: t.dueDate ?? sp.e };
}

/** Presentation only: "11/16 (월)" or "11/16 – 11/18" for the drag tooltip. */
function spanLabel(sp: { s: ISODate; e: ISODate }): string {
  const md = (d: ISODate) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  return sp.s === sp.e ? formatShortKo(sp.s) : `${md(sp.s)} – ${md(sp.e)}`;
}

export function Timeline({ tasks, emptyHint }: { tasks: Task[]; emptyHint?: string }) {
  const app = useApp();
  const { today, deps, projects } = app;
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const rows = useMemo(
    () =>
      tasks
        .filter((t) => spanOf(t))
        .sort((a, b) => spanOf(a)!.s.localeCompare(spanOf(b)!.s) || spanOf(a)!.e.localeCompare(spanOf(b)!.e) || a.number - b.number),
    [tasks],
  );
  const unscheduled = tasks.filter((t) => !spanOf(t) && (t.status === 'todo' || t.status === 'doing'));

  const range = useMemo(() => {
    let min = addDays(today, -4);
    let max = addDays(today, 28);
    for (const t of rows) {
      const sp = spanOf(t)!;
      if (sp.s < min) min = sp.s;
      if (sp.e > max) max = sp.e;
    }
    min = addDays(min, -3);
    max = addDays(max, 14);
    const days = Math.min(400, diffDays(max, min) + 1);
    return { start: min, days };
  }, [rows, today]);

  const x = (d: ISODate) => diffDays(d, range.start) * DAY_W;
  const dates = useMemo(() => Array.from({ length: range.days }, (_, i) => addDays(range.start, i)), [range]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, x(today) - DAY_W * 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start]);

  /** UI only: bring today back into view (same offset as the initial scroll). */
  const scrollToToday = () => {
    const el = scroller.current;
    if (!el) return;
    let smooth = true;
    try {
      smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {}
    el.scrollTo({ left: Math.max(0, x(today) - DAY_W * 4), behavior: smooth ? 'smooth' : 'auto' });
  };

  const dragged = drag ? app.tasks[drag.taskId] : undefined;
  const preview: { next: DateSpan; p: DateChangePreview } | null = useMemo(() => {
    if (!drag || !dragged || drag.delta === 0) return null;
    const next = nextSpan(dragged, drag.mode, drag.delta);
    return { next, p: previewFor(dragged.id, next) };
  }, [drag, dragged]);

  const impactById = useMemo(() => {
    const m = new Map<string, DateChangePreview['report']['impacts'][number]>();
    for (const im of preview?.p.report.impacts ?? []) m.set(im.taskId, im);
    return m;
  }, [preview]);

  /** Where a row's bar is drawn right now (live during a drag). */
  const liveSpan = (t: Task): { s: ISODate; e: ISODate } => {
    if (preview && t.id === drag?.taskId) return spanOf(preview.next)!;
    const im = impactById.get(t.id);
    if (im && im.kind === 'shifted') return spanOf(im.to)!;
    return spanOf(t)!;
  };

  const rowIndex = new Map(rows.map((t, i) => [t.id, i]));
  const arrows = deps
    .filter((d) => rowIndex.has(d.taskId) && rowIndex.has(d.dependsOnId))
    .map((d) => {
      const pred = app.tasks[d.dependsOnId]!;
      const succ = app.tasks[d.taskId]!;
      const ps = liveSpan(pred);
      const ss = liveSpan(succ);
      const x1 = x(ps.e) + DAY_W - 3;
      const y1 = rowIndex.get(pred.id)! * ROW_H + ROW_H / 2;
      const x2 = x(ss.s) + 3;
      const y2 = rowIndex.get(succ.id)! * ROW_H + ROW_H / 2;
      const active = (pred.status === 'todo' || pred.status === 'doing') && (succ.status === 'todo' || succ.status === 'doing');
      const violated = active && ss.s < ps.e;
      let path: string;
      if (x2 - x1 >= 14) {
        const mx = x1 + 7;
        path = `M${x1},${y1} H${mx} V${y2} H${x2}`;
      } else {
        const midY = y1 + (y2 > y1 ? ROW_H / 2 : -ROW_H / 2);
        path = `M${x1},${y1} h7 V${midY} H${x2 - 9} V${y2} H${x2}`;
      }
      return { key: `${d.dependsOnId}-${d.taskId}`, path, violated, active };
    });

  // ── pointer handling
  const onPointerDown = (e: React.PointerEvent, t: Task, mode: DragMode) => {
    if (e.button !== 0) return;
    if (!(t.status === 'todo' || t.status === 'doing')) {
      selectTask(t.id);
      return;
    }
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ taskId: t.id, mode, originX: e.clientX, delta: 0, moved: false });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.originX;
    const delta = Math.round(dx / DAY_W);
    setHover({ x: e.clientX, y: e.clientY });
    if (delta !== drag.delta || (!drag.moved && Math.abs(dx) > 3)) {
      setDrag({ ...drag, delta, moved: drag.moved || Math.abs(dx) > 3 });
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    setHover(null);
    const t = app.tasks[d.taskId];
    if (!t) return;
    if (!d.moved || d.delta === 0) {
      if (!d.moved) selectTask(t.id);
      return;
    }
    requestDateChange(t.id, nextSpan(t, d.mode, d.delta));
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrag(null);
        setHover(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  const width = range.days * DAY_W;
  const height = rows.length * ROW_H;
  const summary = preview?.p.report.summary;
  const nextSp = preview ? spanOf(preview.next) : null;

  return (
    <div className={s.wrap} data-dragging={drag?.moved ? 'true' : undefined}>
      <div className={s.viewport}>
        <div className={s.scroller} ref={scroller}>
          <div className={s.canvas} style={{ width: width + 220 }}>
            {/* header */}
            <div className={s.head} style={{ height: HEAD_H }}>
              <div className={s.corner}>
                <span className={s.cornerCount}>{rows.length}개 작업</span>
                <button type="button" className={s.todayBtn} onClick={scrollToToday} aria-label="오늘 날짜로 스크롤">
                  오늘
                </button>
              </div>
              <div className={s.days} style={{ width }}>
                {dates.map((d, i) => {
                  const first = d.endsWith('-01') || i === 0;
                  const wd = weekday(d);
                  const isToday = d === today;
                  return (
                    <div
                      key={d}
                      className={cx(
                        s.dayHead,
                        (wd === 0 || wd === 6) && s.weekend,
                        isToday && s.isToday,
                        wd === 1 && s.weekStart,
                        d.endsWith('-01') && i > 0 && s.monthStart,
                      )}
                      style={{ left: i * DAY_W, width: DAY_W }}
                    >
                      {first && <span className={s.month}>{Number(d.slice(5, 7))}월</span>}
                      {isToday && !first && <span className={s.todayTag}>오늘</span>}
                      <span className={s.wd}>{WEEKDAYS[wd]}</span>
                      <span className={s.dnum}>{Number(d.slice(8))}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* body */}
            <div className={s.body} style={{ height: Math.max(height, ROW_H * 3) }}>
              <div className={s.labels}>
                {rows.map((t) => {
                  const p = projects.find((pp) => pp.id === t.projectId);
                  const im = impactById.get(t.id);
                  return (
                    <button
                      key={t.id}
                      className={cx(s.label, app.selectedTaskId === t.id && s.labelActive)}
                      style={{ height: ROW_H }}
                      onClick={() => selectTask(t.id)}
                      data-kind={im?.kind}
                      title={t.title}
                    >
                      {p ? (
                        <span className={s.labelDot} style={{ background: `var(--c-${p.color})` }} />
                      ) : (
                        <span className={cx(s.labelDot, s.labelDotEmpty)} aria-hidden="true" />
                      )}
                      <span className={cx(s.labelText, t.status === 'done' && s.labelDone)}>{t.title}</span>
                      {t.fixed && <Icon name="pin" size={12} className={s.labelPin} />}
                    </button>
                  );
                })}
              </div>

              <div
                className={s.tracks}
                style={{ width, height: Math.max(height, ROW_H * 3), ['--day-w' as string]: `${DAY_W}px` }}
              >
                {dates.map((d, i) => {
                  const wd = weekday(d);
                  const weekend = wd === 0 || wd === 6;
                  const monthStart = i > 0 && d.endsWith('-01');
                  if (!weekend && wd !== 1 && !monthStart) return null;
                  return (
                    <div
                      key={d}
                      className={cx(s.col, weekend && s.weekendCol, wd === 1 && s.weekCol, monthStart && s.monthCol)}
                      style={{ left: i * DAY_W, width: DAY_W }}
                    />
                  );
                })}
                {rows.map((t, i) => (
                  <div key={t.id} className={s.rowLine} style={{ top: (i + 1) * ROW_H - 1 }} />
                ))}
                <div className={s.todayCol} style={{ left: x(today), width: DAY_W }} />
                <div className={s.todayLine} style={{ left: x(today) + DAY_W / 2 }} />

                <svg className={s.arrows} width={width} height={Math.max(height, 1)}>
                  <defs>
                    <marker id="ob-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M0,0 L8,4 L0,8 z" fill="var(--text-4)" />
                    </marker>
                    <marker id="ob-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" />
                    </marker>
                  </defs>
                  {arrows.map((a) => (
                    <path
                      key={a.key}
                      d={a.path}
                      className={cx(s.arrow, a.violated && s.arrowBad, !a.active && s.arrowDone)}
                      markerEnd={`url(#${a.violated ? 'ob-arrow-bad' : 'ob-arrow'})`}
                    />
                  ))}
                </svg>

                {rows.map((t, i) => {
                  const orig = spanOf(t)!;
                  const live = liveSpan(t);
                  const im = impactById.get(t.id);
                  const isDragged = drag?.taskId === t.id;
                  const moved = live.s !== orig.s || live.e !== orig.e;
                  const p = projects.find((pp) => pp.id === t.projectId);
                  const done = t.status === 'done' || t.status === 'canceled';
                  const top = i * ROW_H + 7;
                  const barH = ROW_H - 14;
                  return (
                    <div key={t.id}>
                      {moved && (
                        <div
                          className={s.ghost}
                          style={{ left: x(orig.s) + 3, width: (diffDays(orig.e, orig.s) + 1) * DAY_W - 6, top, height: barH }}
                        />
                      )}
                      <div
                        className={cx(
                          s.bar,
                          done && s.barDone,
                          t.fixed && s.barFixed,
                          isDragged && s.barDragging,
                          im?.kind === 'shifted' && s.barShifted,
                          im?.kind === 'conflict' && s.barConflict,
                          im?.kind === 'absorbed' && s.barAbsorbed,
                          app.selectedTaskId === t.id && s.barSelected,
                          !done && t.dueDate && t.dueDate < today && s.barOverdue,
                        )}
                        style={{
                          left: x(live.s) + 3,
                          width: (diffDays(live.e, live.s) + 1) * DAY_W - 6,
                          top,
                          height: barH,
                          ['--bar' as string]: `var(--c-${p?.color ?? 'slate'})`,
                        }}
                        onPointerDown={(e) => onPointerDown(e, t, 'move')}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={() => setDrag(null)}
                        title={`${t.title}${t.fixed ? ' (고정)' : ''}`}
                      >
                        {!done && !t.fixed && (
                          <span className={s.handleL} onPointerDown={(e) => onPointerDown(e, t, 'start')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                        )}
                        <span className={s.barText}>
                          {t.fixed && <Icon name="pin" size={11} className={s.barPin} />}
                          {t.title}
                        </span>
                        {!done && !t.fixed && (
                          <span className={s.handleR} onPointerDown={(e) => onPointerDown(e, t, 'end')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                        )}
                      </div>
                      {im?.kind === 'shifted' && !isDragged && (
                        <span className={s.shiftTag} style={{ left: x(live.e) + DAY_W + 2, top: top + 4 }}>
                          +{formatDaysKo(im.shiftDays)}
                        </span>
                      )}
                      {im?.kind === 'conflict' && (
                        <span className={cx(s.shiftTag, s.conflictTag)} style={{ left: x(live.e) + DAY_W + 2, top: top + 4 }}>
                          {formatDaysKo(im.overrunDays)} 충돌
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {rows.length === 0 && (
          <div className={s.empty} style={{ top: HEAD_H }}>
            <span className={s.emptyText}>{emptyHint ?? '날짜가 있는 작업이 없어요. 작업에 시작일·마감일을 넣으면 여기에 그려져요.'}</span>
          </div>
        )}
      </div>

      {drag?.moved && hover && (
        <div className={s.dragTip} style={{ left: hover.x + 14, top: hover.y + 16 }} data-tone={summary?.conflictCount ? 'danger' : summary?.delayedCount ? 'warn' : 'ok'}>
          <span className={s.dragTipHead}>
            <strong>{drag.delta === 0 ? '변경 없음' : `${drag.delta > 0 ? '+' : '−'}${formatDaysKo(Math.abs(drag.delta))}`}</strong>
            {nextSp && drag.delta !== 0 && <span className={s.dragTipDate}>{spanLabel(nextSp)}</span>}
          </span>
          {summary && drag.delta !== 0 && (
            <span className={s.dragTipImpact}>
              {summary.delayedCount || summary.conflictCount
                ? [summary.delayedCount && `${summary.delayedCount}개 밀림`, summary.conflictCount && `충돌 ${summary.conflictCount}`].filter(Boolean).join(' · ')
                : '다른 일정 영향 없음'}
            </span>
          )}
        </div>
      )}

      {unscheduled.length > 0 && (
        <div className={s.unscheduled}>
          <span className={s.unschedTitle}>
            <Icon name="calendar" size={13} />
            날짜 없음
            <span className={s.unschedCount}>{unscheduled.length}</span>
          </span>
          {unscheduled.map((t) => (
            <button key={t.id} className={s.unschedItem} onClick={() => selectTask(t.id)} title={`${t.title} · 열어서 날짜 넣기`}>
              {t.title}
            </button>
          ))}
        </div>
      )}

      <div className={s.legend}>
        <span className={s.legendHint}>
          <Icon name="grip" size={13} />
          끌어서 이동 · 양 끝을 끌어 기간 조절
          <span className={s.legendEsc}>
            · <kbd>Esc</kbd> 취소
          </span>
        </span>
        <span className={s.legendItems}>
          <span>
            <i className={s.lgBar} /> 작업
          </span>
          <span>
            <i className={s.lgFixed} /> 고정 일정
          </span>
          <span>
            <i className={s.lgShift} /> 밀리는 작업
          </span>
          <span>
            <i className={s.lgConflict} /> 고정 일정 충돌
          </span>
          <span>
            <i className={s.lgToday} /> 오늘
          </span>
        </span>
      </div>
    </div>
  );
}
