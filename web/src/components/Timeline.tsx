'use client';

import {
  addDays,
  DAY_MINUTES,
  diffDays,
  formatDaysKo,
  formatDurationKo,
  formatShortKo,
  toDay,
  weekday,
  type DateChangePreview,
  type ISODate,
  type Task,
} from '@obelisk/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useClock } from '@/lib/clock';
import { cx, spanLabel as relativeSpanLabel } from '@/lib/format';
import { previewFor, previewGroup, requestDateChange, requestGroupChange, type TimedSpan } from '@/lib/reschedule';
import { clearPicks, setPicked, togglePick, useInlineBar, usePicked, useSelectAll } from '@/lib/selection';
import { selectTask, useApp } from '@/lib/store';
import { openTaskMenu } from '@/lib/task-actions';
import {
  applySpan,
  clampScale,
  clockSpan,
  daySpan,
  DEFAULT_SCALE,
  hasTime,
  HOUR_SCALE,
  hourStep,
  MAX_SCALE,
  MIN_SCALE,
  nextByDays,
  nextByMinutes,
  snapMinutes,
  stepScale,
  type DragMode,
  type Timed,
} from '@/lib/timeline';
import { isApple, modKey } from '@/lib/ui-helpers';
import { useUi } from '@/lib/ui-state';
import { Icon } from './Icon';
import { BulkBar } from './BulkBar';
import { tip } from './primitives';
import s from './Timeline.module.css';

const ROW_H = 40;
const HEAD_H = 52;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const SCALE_KEY = 'obelisk-timeline-scale';

interface Drag {
  /** The bar under the pointer. */
  taskId: string;
  /** Everything that moves with it: the picked group for a move, else just this bar. */
  ids: string[];
  mode: DragMode;
  originX: number;
  /** Snapped distance: days at day scale, minutes at hour scale. */
  delta: number;
  moved: boolean;
  /** Started with Shift or ⌘/Ctrl: a click (no movement) toggles the bar in the selection. */
  toggle: boolean;
}

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** What was picked before this box started (the box adds to it). */
  base: Set<string>;
}

const isActive = (t: Task) => t.status === 'todo' || t.status === 'doing';

/** Presentation only: "11/16 (월)" or "11/16 – 11/18" for the drag tooltip at day scale. */
function daysLabel(sp: { s: ISODate; e: ISODate }): string {
  const md = (d: ISODate) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  return sp.s === sp.e ? formatShortKo(sp.s) : `${md(sp.s)} – ${md(sp.e)}`;
}

/** "9:00" for the start (or "~18:00" for a due time alone) shown inside a timed bar. */
function barTime(t: Timed): string | null {
  const short = (v: string) => v.replace(/^0/, '');
  if (t.startDate && t.startTime) return short(t.startTime);
  if (t.dueDate && t.dueTime) return `~${short(t.dueTime)}`;
  return null;
}

function readScale(): number {
  try {
    const v = Number(localStorage.getItem(SCALE_KEY));
    return v ? clampScale(v) : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE;
  }
}

function saveScale(v: number) {
  try {
    localStorage.setItem(SCALE_KEY, String(Math.round(v)));
  } catch {}
}

/** Pointer capture keeps a drag alive outside the element; it can throw for a pointer that already ended. */
function capture(el: Element, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {}
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function Timeline({ tasks, emptyHint }: { tasks: Task[]; emptyHint?: string }) {
  const app = useApp();
  const { today, deps, projects } = app;
  const scroller = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const picked = usePicked();
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  useInlineBar();

  // ── zoom: pixels per day (persisted per browser)
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const scaleRef = useRef(scale);
  const [zooming, setZooming] = useState(false);
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Point to keep under the pointer (or centre) while the scale changes: minutes from range start + its offset in the track view. */
  const anchor = useRef<{ minutes: number; px: number } | null>(null);
  /** The saved zoom is read before the first scroll so "today" lands in the right place. */
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const v = readScale();
    scaleRef.current = v;
    setScale(v);
    setReady(true);
  }, []);

  const hourMode = scale >= HOUR_SCALE;
  const ppm = scale / DAY_MINUTES;
  const snap = snapMinutes(scale);
  const clock = useClock(hourMode);

  const rows = useMemo(
    () =>
      tasks
        .filter((t) => daySpan(t))
        .sort((a, b) => {
          const A = clockSpan(a)!;
          const B = clockSpan(b)!;
          return A.a - B.a || A.b - B.b || a.number - b.number;
        }),
    [tasks],
  );
  const unscheduled = tasks.filter((t) => !daySpan(t) && isActive(t));
  const rowIndex = useMemo(() => new Map(rows.map((t, i) => [t.id, i])), [rows]);
  // ⌘A here: there are no list rows, so the bars on the timeline are what "all" means.
  useSelectAll(() => rows.map((t) => t.id));

  // Right-click on a bar or its label: the menu for the picks when it is one of them, else for it alone.
  const { taskMenu } = useUi();
  const contextId = taskMenu?.ids.length === 1 ? taskMenu.ids[0] : null;
  const openMenu = (e: React.MouseEvent, t: Task) => {
    if (drag?.moved) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = picked.has(t.id) ? [...picked].filter((id) => app.tasks[id]) : [t.id];
    openTaskMenu(e.clientX, e.clientY, ids);
  };

  const range = useMemo(() => {
    let min = addDays(today, -4);
    let max = addDays(today, 28);
    for (const t of rows) {
      const sp = daySpan(t)!;
      if (sp.s < min) min = sp.s;
      if (sp.e > max) max = sp.e;
    }
    min = addDays(min, -3);
    max = addDays(max, 14);
    const days = Math.min(400, diffDays(max, min) + 1);
    return { start: min, days };
  }, [rows, today]);
  const origin = toDay(range.start) * DAY_MINUTES;

  const x = (d: ISODate) => diffDays(d, range.start) * scale;
  const width = range.days * scale;
  const height = rows.length * ROW_H;

  /** Where a task's bar is drawn: whole days at day scale, its clock span at hour scale. */
  const geo = (t: Timed): { left: number; width: number } => {
    if (!hourMode) {
      const sp = daySpan(t)!;
      return { left: x(sp.s) + 3, width: Math.max(6, (diffDays(sp.e, sp.s) + 1) * scale - 6) };
    }
    const c = clockSpan(t)!;
    return { left: (c.a - origin) * ppm + 1, width: Math.max(4, (c.b - c.a) * ppm - 2) };
  };

  // ── visible window (header cells, grid columns and hour ticks are only drawn for these days)
  const [view, setView] = useState({ from: 0, to: 60 });
  const measureView = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const labelsW = labelsRef.current?.offsetWidth ?? 220;
    const sc = scaleRef.current;
    const from = Math.max(0, Math.floor(el.scrollLeft / sc) - 2);
    const to = Math.ceil((el.scrollLeft + el.clientWidth - labelsW) / sc) + 2;
    setView((v) => (v.from === from && v.to === to ? v : { from, to }));
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measureView();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => measureView());
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [measureView]);

  const trackViewWidth = () => {
    const el = scroller.current;
    return el ? el.clientWidth - (labelsRef.current?.offsetWidth ?? 220) : 600;
  };

  /** scrollLeft that puts today (or now, at hour scale) a little in from the left edge. */
  const todayScroll = (sc = scaleRef.current) => {
    const viewW = trackViewWidth();
    const todayX = diffDays(today, range.start) * sc;
    if (sc >= HOUR_SCALE) return Math.max(0, todayX + (clock.minutes / DAY_MINUTES) * sc - viewW * 0.25);
    return Math.max(0, todayX - Math.min(sc * 4, viewW * 0.3));
  };

  // Initial position (and again when the range shifts): today near the left.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !ready) return;
    el.scrollLeft = todayScroll(scale);
    measureView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, ready]);

  // After a zoom: keep the anchored moment where it was on screen.
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (el && a) {
      anchor.current = null;
      el.scrollLeft = Math.max(0, (a.minutes / DAY_MINUTES) * scale - a.px);
    }
    measureView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const zoomTo = useCallback((target: number, clientX?: number) => {
    const el = scroller.current;
    if (!el) return;
    const cur = scaleRef.current;
    const next = clampScale(target);
    if (Math.abs(next - cur) < 0.01) return;
    if (!anchor.current) {
      const labelsW = labelsRef.current?.offsetWidth ?? 220;
      const viewW = el.clientWidth - labelsW;
      const rect = el.getBoundingClientRect();
      const px = clientX === undefined ? viewW / 2 : Math.min(viewW, Math.max(0, clientX - rect.left - labelsW));
      anchor.current = { minutes: ((el.scrollLeft + px) / cur) * DAY_MINUTES, px };
    }
    scaleRef.current = next;
    setScale(next);
    saveScale(next);
    // Bars slide when their dates change; during a zoom they should simply rescale.
    setZooming(true);
    clearTimeout(zoomTimer.current);
    zoomTimer.current = setTimeout(() => setZooming(false), 180);
  }, []);

  const zoomStep = (dir: 1 | -1) => zoomTo(stepScale(scaleRef.current, dir));

  // Pinch on a trackpad (Chrome/Edge/Firefox send ctrl+wheel; Safari sends gesture events) and ⌘/Ctrl+scroll.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomTo(scaleRef.current * Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01), e.clientX);
    };
    let base = 1;
    type GestureEvent = Event & { scale: number; clientX: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      base = scaleRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      zoomTo(base * g.scale, g.clientX);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart, { passive: false } as AddEventListenerOptions);
    el.addEventListener('gesturechange', onGestureChange, { passive: false } as AddEventListenerOptions);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, [zoomTo]);

  useEffect(() => () => clearTimeout(zoomTimer.current), []);

  /** UI only: bring today (now, at hour scale) back into view. */
  const scrollToToday = () => {
    scroller.current?.scrollTo({ left: todayScroll(), behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  // ── drag preview (one bar, or the picked group moving together)
  const nextFor = useCallback(
    (t: Task, mode: DragMode, delta: number): TimedSpan => (hourMode ? nextByMinutes(t, mode, delta, snap) : nextByDays(t, mode, delta)),
    [hourMode, snap],
  );

  const moving = useMemo(() => {
    if (!drag || drag.delta === 0) return null;
    const nexts = new Map<string, TimedSpan>();
    for (const id of drag.ids) {
      const t = app.tasks[id];
      if (t) nexts.set(id, nextFor(t, drag.mode, drag.delta));
    }
    if (!nexts.size) return null;
    const p: DateChangePreview =
      nexts.size === 1
        ? previewFor(drag.taskId, nexts.get(drag.taskId) ?? [...nexts.values()][0]!)
        : previewGroup([...nexts].map(([taskId, next]) => ({ taskId, next })));
    return { nexts, p };
  }, [drag, app.tasks, nextFor]);

  const impactById = useMemo(() => {
    const m = new Map<string, DateChangePreview['report']['impacts'][number]>();
    for (const im of moving?.p.report.impacts ?? []) m.set(im.taskId, im);
    return m;
  }, [moving]);

  /** A row as it is drawn right now (live during a drag). */
  const live = (t: Task): Timed => {
    const next = moving?.nexts.get(t.id);
    if (next) return applySpan(t, next);
    const im = impactById.get(t.id);
    if (im && im.kind === 'shifted') return applySpan(t, im.to);
    return t;
  };

  const arrows = deps
    .filter((d) => rowIndex.has(d.taskId) && rowIndex.has(d.dependsOnId))
    .map((d) => {
      const pred = app.tasks[d.dependsOnId]!;
      const succ = app.tasks[d.taskId]!;
      const lp = live(pred);
      const ls = live(succ);
      const gp = geo(lp);
      const gs = geo(ls);
      const x1 = gp.left + gp.width;
      const y1 = rowIndex.get(pred.id)! * ROW_H + ROW_H / 2;
      const x2 = gs.left;
      const y2 = rowIndex.get(succ.id)! * ROW_H + ROW_H / 2;
      const active = isActive(pred) && isActive(succ);
      // Days decide a violation (the delay model counts days); two timed tasks are compared by the clock.
      const violated =
        active && (hourMode && hasTime(lp) && hasTime(ls) ? clockSpan(ls)!.a < clockSpan(lp)!.b : daySpan(ls)!.s < daySpan(lp)!.e);
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

  // ── pointer handling (bars)
  const onPointerDown = (e: React.PointerEvent, t: Task, mode: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Control-click is the Mac's right click: the context menu takes it.
    if (e.ctrlKey && isApple()) return;
    const toggle = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!isActive(t)) {
      if (toggle) togglePick(t.id);
      else {
        clearPicks();
        selectTask(t.id);
      }
      return;
    }
    capture(e.currentTarget, e.pointerId);
    let ids = [t.id];
    if (mode === 'move' && (picked.has(t.id) || (toggle && picked.size))) {
      ids = [...new Set([...picked, t.id])].filter((id) => {
        const task = app.tasks[id];
        return !!task && isActive(task) && rowIndex.has(id);
      });
    }
    setDrag({ taskId: t.id, ids, mode, originX: e.clientX, delta: 0, moved: false, toggle });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.originX;
    const delta = hourMode ? Math.round(dx / ppm / snap) * snap : Math.round(dx / scale);
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
    if (!d.moved) {
      if (d.toggle) togglePick(t.id);
      else {
        clearPicks();
        selectTask(t.id);
      }
      return;
    }
    if (d.delta === 0) return;
    if (d.ids.length > 1) {
      setPicked(d.ids);
      requestGroupChange(d.ids.flatMap((id) => (app.tasks[id] ? [{ taskId: id, next: nextFor(app.tasks[id]!, 'move', d.delta) }] : [])));
    } else {
      requestDateChange(t.id, nextFor(t, d.mode, d.delta));
    }
  };

  // ── Shift + drag on empty track: box selection
  const marqueeHits = (m: Marquee): string[] => {
    const left = Math.min(m.x0, m.x1);
    const right = Math.max(m.x0, m.x1);
    const top = Math.min(m.y0, m.y1);
    const bottom = Math.max(m.y0, m.y1);
    const out: string[] = [];
    rows.forEach((t, i) => {
      const barTop = i * ROW_H + 7;
      const barBottom = barTop + ROW_H - 14;
      if (barBottom < top || barTop > bottom) return;
      const g = geo(t);
      if (g.left + g.width < left || g.left > right) return;
      out.push(t.id);
    });
    return out;
  };

  const onTracksPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.ctrlKey && isApple())) return;
    if (!e.shiftKey) {
      clearPicks();
      return;
    }
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    capture(e.currentTarget, e.pointerId);
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    setMarquee({ x0: px, y0: py, x1: px, y1: py, base: new Set(picked) });
    selectTask(null);
  };

  const onTracksPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee) return;
    const r = e.currentTarget.getBoundingClientRect();
    const m = { ...marquee, x1: e.clientX - r.left, y1: e.clientY - r.top };
    setMarquee(m);
    setPicked([...m.base, ...marqueeHits(m)]);
  };

  const onTracksPointerUp = () => setMarquee(null);

  // Esc cancels a drag or a box first (capture, so the shell doesn't also drop the selection).
  useEffect(() => {
    if (!drag && !marquee) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (drag) {
        setDrag(null);
        setHover(null);
      } else if (marquee) {
        setPicked(marquee.base);
        setMarquee(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag, marquee]);

  // ── header cells for the visible days
  const firstDay = Math.max(0, view.from);
  const lastDay = Math.min(range.days - 1, view.to);
  const visibleDays: { d: ISODate; i: number }[] = [];
  for (let i = firstDay; i <= lastDay; i++) visibleDays.push({ d: addDays(range.start, i), i });
  const step = hourStep(scale);

  const summary = moving?.p.report.summary;
  const dragged = drag ? app.tasks[drag.taskId] : undefined;
  const draggedNext = moving && drag ? moving.nexts.get(drag.taskId) : undefined;
  const draggedTimed = !!dragged && hourMode && hasTime(dragged);
  const deltaText = (() => {
    if (!drag || drag.delta === 0) return '변경 없음';
    const sign = drag.delta > 0 ? '+' : '−';
    if (!hourMode) return `${sign}${formatDaysKo(Math.abs(drag.delta))}`;
    if (!draggedTimed && drag.ids.length === 1) {
      const days = Math.round(drag.delta / DAY_MINUTES);
      return days ? `${days > 0 ? '+' : '−'}${formatDaysKo(Math.abs(days))}` : '변경 없음';
    }
    return `${sign}${formatDurationKo(Math.abs(drag.delta))}`;
  })();
  const whenText = (() => {
    if (!dragged || !draggedNext || drag?.ids.length !== 1) return null;
    const after = applySpan(dragged, draggedNext);
    return hourMode ? relativeSpanLabel(after, today) : daysLabel(daySpan(after)!);
  })();

  const mod = modKey();
  const nowX = (diffDays(clock.date, range.start) * DAY_MINUTES + clock.minutes) * ppm;

  return (
    <div
      className={s.wrap}
      // The list gestures (sweep, box, drag to the sidebar) stay out: bars and the Shift+box live here.
      data-gesture="off"
      data-dragging={drag?.moved ? 'true' : undefined}
      data-scale={hourMode ? 'hour' : 'day'}
      data-zooming={zooming || undefined}
      data-marquee={marquee ? 'true' : undefined}
    >
      <div className={s.viewport}>
        <div className={s.scroller} ref={scroller}>
          <div className={s.canvas} style={{ width: width + 220 }}>
            {/* header */}
            <div className={s.head} style={{ height: HEAD_H }}>
              <div className={s.corner}>
                <span className={s.cornerCount}>{rows.length}개 작업</span>
                <span className={s.cornerTools}>
                  <span className={s.zoom} role="group" aria-label="타임라인 확대">
                    <button
                      type="button"
                      className={s.zoomBtn}
                      onClick={() => zoomStep(-1)}
                      disabled={scale <= MIN_SCALE}
                      aria-label="축소"
                      {...tip('축소', { side: 'bottom', meta: `핀치 · ${mod} 스크롤` })}
                    >
                      <Icon name="minus" size={14} />
                    </button>
                    <button
                      type="button"
                      className={s.zoomBtn}
                      onClick={() => zoomStep(1)}
                      disabled={scale >= MAX_SCALE}
                      aria-label="확대"
                      {...tip(hourMode ? '확대' : '확대 · 더 키우면 시간 단위', { side: 'bottom', meta: `핀치 · ${mod} 스크롤` })}
                    >
                      <Icon name="plus" size={14} />
                    </button>
                  </span>
                  <button type="button" className={s.todayBtn} onClick={scrollToToday} aria-label={hourMode ? '지금 시각으로 스크롤' : '오늘 날짜로 스크롤'}>
                    {hourMode ? '지금' : '오늘'}
                  </button>
                </span>
              </div>
              <div className={s.days} style={{ width }}>
                {hourMode
                  ? visibleDays.map(({ d, i }) => {
                      const wd = weekday(d);
                      const isToday = d === today;
                      const ticks: number[] = [];
                      for (let h = 0; h < 24; h += step) ticks.push(h);
                      return (
                        <div
                          key={d}
                          className={cx(s.dayBlock, (wd === 0 || wd === 6) && s.weekend, isToday && s.isTodayBlock)}
                          style={{ left: i * scale, width: scale }}
                        >
                          <span className={s.dayBlockLabel}>
                            <span className={s.dayBlockDate}>
                              {Number(d.slice(5, 7))}월 {Number(d.slice(8))}일
                            </span>
                            <span className={s.dayBlockWd}>{WEEKDAYS[wd]}</span>
                            {isToday && <span className={s.dayBlockToday}>오늘</span>}
                          </span>
                          {ticks.map((h) => (
                            <span key={h} className={cx(s.hourTick, h === 0 && s.hourTickDay)} style={{ left: (h / 24) * scale }}>
                              {h}시
                            </span>
                          ))}
                        </div>
                      );
                    })
                  : visibleDays.map(({ d, i }) => {
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
                          style={{ left: i * scale, width: scale }}
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
              <div className={s.labels} ref={labelsRef}>
                {rows.map((t) => {
                  const p = projects.find((pp) => pp.id === t.projectId);
                  const im = impactById.get(t.id);
                  return (
                    <button
                      key={t.id}
                      className={cx(
                        s.label,
                        app.selectedTaskId === t.id && s.labelActive,
                        picked.has(t.id) && s.labelPicked,
                        contextId === t.id && s.labelContext,
                      )}
                      style={{ height: ROW_H }}
                      onContextMenu={(e) => openMenu(e, t)}
                      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                      onClick={(e) => {
                        if (e.shiftKey || e.metaKey || e.ctrlKey) togglePick(t.id);
                        else {
                          clearPicks();
                          selectTask(t.id);
                        }
                      }}
                      data-kind={im?.kind === 'root' ? undefined : im?.kind}
                      // Focused, the task keys act on this task (lib/task-actions actionTargets).
                      data-task-focus={t.id}
                      aria-pressed={picked.size ? picked.has(t.id) : undefined}
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
                ref={tracksRef}
                className={s.tracks}
                style={{
                  width,
                  height: Math.max(height, ROW_H * 3),
                  ['--day-w' as string]: `${scale}px`,
                  ['--hour-w' as string]: `${(scale / 24) * step}px`,
                }}
                onPointerDown={onTracksPointerDown}
                onPointerMove={onTracksPointerMove}
                onPointerUp={onTracksPointerUp}
                onPointerCancel={onTracksPointerUp}
              >
                {visibleDays.map(({ d, i }) => {
                  const wd = weekday(d);
                  const weekend = wd === 0 || wd === 6;
                  const monthStart = i > 0 && d.endsWith('-01');
                  if (!weekend && wd !== 1 && !monthStart && !hourMode) return null;
                  return (
                    <div
                      key={d}
                      className={cx(s.col, weekend && s.weekendCol, (wd === 1 || hourMode) && s.weekCol, monthStart && s.monthCol)}
                      style={{ left: i * scale, width: scale }}
                    />
                  );
                })}
                {rows.map((t, i) => (
                  <div key={t.id} className={s.rowLine} style={{ top: (i + 1) * ROW_H - 1 }} />
                ))}
                <div className={s.todayCol} style={{ left: x(today), width: scale }} />
                <div className={s.todayLine} style={{ left: hourMode ? nowX : x(today) + scale / 2 }} />

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
                  const now = live(t);
                  const g = geo(now);
                  const og = geo(t);
                  const im = impactById.get(t.id);
                  const isMoving = !!moving?.nexts.has(t.id);
                  const moved = g.left !== og.left || g.width !== og.width;
                  const p = projects.find((pp) => pp.id === t.projectId);
                  const done = !isActive(t);
                  const top = i * ROW_H + 7;
                  const barH = ROW_H - 14;
                  // The time label only when the bar has room for it and the title.
                  const time = hourMode && g.width >= 96 ? barTime(now) : null;
                  const when = relativeSpanLabel(t, today);
                  return (
                    <div key={t.id}>
                      {moved && <div className={s.ghost} style={{ left: og.left, width: og.width, top, height: barH }} />}
                      <div
                        className={cx(
                          s.bar,
                          done && s.barDone,
                          t.fixed && s.barFixed,
                          (isMoving || drag?.taskId === t.id) && drag?.moved && s.barDragging,
                          im?.kind === 'shifted' && s.barShifted,
                          im?.kind === 'conflict' && s.barConflict,
                          im?.kind === 'absorbed' && s.barAbsorbed,
                          app.selectedTaskId === t.id && s.barSelected,
                          picked.has(t.id) && s.barPicked,
                          contextId === t.id && !picked.has(t.id) && s.barContext,
                          !done && t.dueDate && t.dueDate < today && s.barOverdue,
                        )}
                        style={{
                          left: g.left,
                          width: g.width,
                          top,
                          height: barH,
                          ['--bar' as string]: `var(--c-${p?.color ?? 'slate'})`,
                        }}
                        onPointerDown={(e) => onPointerDown(e, t, 'move')}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={() => setDrag(null)}
                        onContextMenu={(e) => openMenu(e, t)}
                        title={`${t.title}${when ? ` · ${when}` : ''}${t.fixed ? ' (고정)' : ''}`}
                      >
                        {!done && !t.fixed && (
                          <span className={s.handleL} onPointerDown={(e) => onPointerDown(e, t, 'start')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                        )}
                        <span className={s.barText}>
                          {t.fixed && <Icon name="pin" size={11} className={s.barPin} />}
                          {time && <span className={s.barTime}>{time}</span>}
                          {t.title}
                        </span>
                        {!done && !t.fixed && (
                          <span className={s.handleR} onPointerDown={(e) => onPointerDown(e, t, 'end')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                        )}
                      </div>
                      {im?.kind === 'shifted' && !isMoving && (
                        <span className={s.shiftTag} style={{ left: g.left + g.width + 5, top: top + 4 }}>
                          +{formatDaysKo(im.shiftDays)}
                        </span>
                      )}
                      {im?.kind === 'conflict' && (
                        <span className={cx(s.shiftTag, s.conflictTag)} style={{ left: g.left + g.width + 5, top: top + 4 }}>
                          {formatDaysKo(im.overrunDays)} 충돌
                        </span>
                      )}
                    </div>
                  );
                })}

                {marquee && (
                  <div
                    className={s.marquee}
                    style={{
                      left: Math.min(marquee.x0, marquee.x1),
                      top: Math.min(marquee.y0, marquee.y1),
                      width: Math.abs(marquee.x1 - marquee.x0),
                      height: Math.abs(marquee.y1 - marquee.y0),
                    }}
                  />
                )}
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
            <strong>{deltaText}</strong>
            {drag.ids.length > 1 ? <span className={s.dragTipDate}>작업 {drag.ids.length}개</span> : whenText && drag.delta !== 0 && <span className={s.dragTipDate}>{whenText}</span>}
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
            <button key={t.id} className={s.unschedItem} onClick={() => selectTask(t.id)} data-task-focus={t.id} title={`${t.title} · 열어서 날짜 넣기`}>
              {t.title}
            </button>
          ))}
        </div>
      )}

      {[...picked].some((id) => app.tasks[id]) ? (
        <BulkBar variant="inline" />
      ) : (
        <div className={s.legend}>
          <span className={s.legendHint}>
            <Icon name="grip" size={13} />
            끌어서 이동 · 양 끝을 끌어 기간 조절
            <span className={s.legendEsc}>
              · <kbd>Shift</kbd> 또는 <kbd>{mod}</kbd> 클릭으로 여러 개 · <kbd>Shift</kbd> 드래그로 범위 선택 · <kbd>{mod}</kbd>
              <kbd>A</kbd> 모두 선택 · 우클릭으로 메뉴 · 핀치나 <kbd>{mod}</kbd> 스크롤로 확대
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
              <i className={s.lgToday} /> {hourMode ? '지금' : '오늘'}
            </span>
          </span>
        </div>
      )}

    </div>
  );
}
