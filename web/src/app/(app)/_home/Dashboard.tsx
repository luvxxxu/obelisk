'use client';

import type { HomeLayout } from '@obelisk/core';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Icon } from '@/components/Icon';
import { tip, ui } from '@/components/primitives';
import { cx } from '@/lib/format';
import { stagger } from './motion';
import { boxOf, bottom, clampItem, COLS, effectiveItems, GAP, mobileSpans, ROW, settle, type Item, type WidgetDef } from './layout';
import { scrollParent } from './useBoardDnd';
import s from './dashboard.module.css';

const EDGE = 56;
const MAX_SCROLL = 18;
const SLOP = 4;
/** Mobile edit list: row height + gap. */
const ROW_PITCH = 60;
/** .head margin-bottom (dashboard.module.css). */
const HEAD_GAP = 12;

export type DashMode = 'desktop' | 'mobile';

interface Props {
  mode: DashMode;
  width: number;
  defs: WidgetDef[];
  layout: HomeLayout;
  editing: boolean;
  render: (id: string) => ReactNode;
  onChange: (next: HomeLayout) => void;
  /** Id of a widget just added back, to bring into view. */
  focusId: string | null;
  onFocused: () => void;
}

/**
 * The home page as a dashboard. Desktop: a 12-column grid; widgets follow their content's height unless
 * the user fixed one by hand (then a list scrolls inside it).
 * Mobile: one column (summary tiles pair up) at natural height, rearranged in a compact list while editing.
 */
export function Dashboard(props: Props) {
  const byId = useMemo(() => new Map(props.defs.map((d) => [d.id, d])), [props.defs]);
  const [empty, setEmpty] = useState<ReadonlySet<string>>(new Set());
  const [say, setSay] = useState('');

  const reportEmpty = useCallback((id: string, isEmpty: boolean) => {
    setEmpty((prev) => {
      if (prev.has(id) === isEmpty) return prev;
      const next = new Set(prev);
      if (isEmpty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  return (
    <>
      {props.mode === 'desktop' ? (
        <DesktopGrid {...props} byId={byId} empty={empty} reportEmpty={reportEmpty} announce={setSay} />
      ) : props.editing ? (
        <MobileEditor {...props} byId={byId} announce={setSay} />
      ) : (
        <MobileStack {...props} byId={byId} empty={empty} reportEmpty={reportEmpty} />
      )}
      <div className={s.srOnly} role="status" aria-live="polite">
        {say}
      </div>
    </>
  );
}

/* ───────────────────────── widget frame (heading + body) */

function Frame({
  def,
  children,
  scroll,
  reportEmpty,
  onMeasure,
}: {
  def: WidgetDef;
  children: ReactNode;
  /** Desktop: the box has a set height, so a list body may scroll inside it. */
  scroll: boolean;
  reportEmpty: (id: string, empty: boolean) => void;
  /** Desktop: natural content height in grid rows, re-reported whenever it changes. */
  onMeasure?: (id: string, rows: number) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const listBody = scroll && def.chrome === 'section';

  // Widgets that render nothing (e.g. a dismissed Jev invite) collapse out of the layout.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => reportEmpty(def.id, el.childElementCount === 0);
    check();
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true });
    return () => mo.disconnect();
  }, [def.id, reportEmpty]);

  // Natural height: measured with the "fill the box" stretch switched off for one synchronous read,
  // then again whenever the content or the widget's width changes (data loads, text wraps, Jev answers).
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content || !onMeasure) return;
    frame.dataset.measuring = '';
    const head = headRef.current ? headRef.current.offsetHeight + HEAD_GAP : 0;
    const px = head + content.offsetHeight;
    delete frame.dataset.measuring;
    onMeasure(def.id, Math.max(1, Math.ceil((px + GAP) / ROW)));
  }, [def.id, onMeasure]);

  useLayoutEffect(measure);

  useEffect(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content || !onMeasure) return;
    let raf = 0;
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    let lastWidth = frame.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (frame.offsetWidth !== lastWidth) {
        lastWidth = frame.offsetWidth;
        soon();
      }
    });
    ro.observe(frame);
    const mo = new MutationObserver(soon);
    mo.observe(content, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(soon);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure, onMeasure]);

  // A soft fade at the bottom of a scrolling list says "there is more below". Cards never get it.
  useEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!listBody || !body || !content) {
      setMore(false);
      return;
    }
    const check = () => setMore(body.scrollTop + body.clientHeight < body.scrollHeight - 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(body);
    ro.observe(content);
    body.addEventListener('scroll', check, { passive: true });
    return () => {
      ro.disconnect();
      body.removeEventListener('scroll', check);
    };
  }, [listBody]);

  return (
    <div ref={frameRef} className={s.frame} data-chrome={def.chrome} data-scroll={listBody || undefined}>
      {def.chrome === 'section' && (
        <header ref={headRef} className={s.head}>
          <h2 className={cx(ui.pageSection, s.title)}>{def.name}</h2>
          {def.lead && <p className={s.lead}>{def.lead}</p>}
        </header>
      )}
      <div ref={bodyRef} className={s.body} data-more={more || undefined}>
        <div ref={contentRef} className={s.content}>
          {children}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── desktop grid */

interface DragState {
  id: string;
  kind: 'move' | 'resize';
  left: number;
  top: number;
  width: number;
  height: number;
  items: Item[];
}

function DesktopGrid({
  width,
  defs,
  layout,
  editing,
  render,
  onChange,
  byId,
  empty,
  reportEmpty,
  announce,
  focusId,
  onFocused,
}: Props & {
  byId: Map<string, WidgetDef>;
  empty: ReadonlySet<string>;
  reportEmpty: (id: string, empty: boolean) => void;
  announce: (msg: string) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [natural, setNatural] = useState<ReadonlyMap<string, number>>(new Map());
  const onMeasure = useCallback((id: string, rows: number) => {
    setNatural((prev) => (prev.get(id) === rows ? prev : new Map(prev).set(id, rows)));
  }, []);

  // Heights as shown: content-sized unless fixed by hand (layout.ts effectiveItems), then re-packed.
  const items = useMemo(() => settle(effectiveItems(layout.desktop.items, byId, natural)), [layout.desktop.items, byId, natural]);

  // Outside edit mode, empty widgets give their space back.
  const shown = useMemo(() => (editing ? items : settle(items.filter((i) => !empty.has(i.id)))), [editing, items, empty]);
  const live = drag?.items ?? shown;

  const setItems = useCallback(
    (next: Item[]) => onChange({ ...layout, desktop: { ...layout.desktop, items: next } }),
    [layout, onChange],
  );

  const hide = useCallback(
    (id: string) => {
      onChange({
        ...layout,
        desktop: { items: settle(items.filter((i) => i.id !== id)), hidden: [...layout.desktop.hidden, id] },
      });
      announce(`${byId.get(id)?.name ?? '위젯'}을 숨겼어요`);
    },
    [announce, byId, items, layout, onChange],
  );

  useEffect(() => {
    if (!focusId) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-widget="${focusId}"] [data-overlay]`);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    onFocused();
  }, [focusId, onFocused, live]);

  const startDrag = (e: ReactPointerEvent<HTMLElement>, id: string, kind: DragState['kind']) => {
    if (e.button !== 0 || !gridRef.current) return;
    if ((e.target as HTMLElement).closest('button') && kind === 'move') return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget.closest('[data-overlay]') as HTMLElement | null)?.focus({ preventScroll: true });

    const grid = gridRef.current;
    const orig = items.find((i) => i.id === id);
    const def = byId.get(id);
    if (!orig || !def) return;
    const r0 = grid.getBoundingClientRect();
    const box = boxOf(orig, width);
    const start = { x: e.clientX, y: e.clientY };
    const last = { ...start };
    const grab = { x: start.x - r0.left - box.left, y: start.y - r0.top - box.top };
    const offR = box.left + box.width - (start.x - r0.left);
    const offB = box.top + box.height - (start.y - r0.top);
    const minW = boxOf({ x: 0, y: 0, w: def.min.w, h: def.min.h }, width);
    const scroller = scrollParent(grid);
    let active = false;
    let raf = 0;
    let current: DragState | null = null;

    const compute = () => {
      const r = grid.getBoundingClientRect();
      const pitch = box.col + GAP;
      if (kind === 'move') {
        const left = Math.max(-8, Math.min(width - box.width + 8, last.x - r.left - grab.x));
        const top = Math.max(-8, last.y - r.top - grab.y);
        const target = clampItem({ ...orig, x: Math.round(left / pitch), y: Math.round(top / ROW) }, def);
        current = { id, kind, left, top, width: box.width, height: box.height, items: settle(swapIn(items, target), target) };
      } else {
        const w = Math.max(minW.width, Math.min(width - box.left, last.x - r.left + offR - box.left));
        const h = Math.max(minW.height, last.y - r.top + offB - box.top);
        const rows = Math.round((h + GAP) / ROW);
        // Only dragging the height fixes it; a width-only change keeps it following the content.
        const fixed = orig.fixed || rows !== orig.h;
        const target = clampItem({ ...orig, w: Math.round((w + GAP) / pitch), h: rows, fixed }, def);
        const fitted = { ...target, w: Math.min(target.w, COLS - target.x) };
        current = { id, kind, left: box.left, top: box.top, width: w, height: h, items: settle(swapIn(items, fitted), fitted) };
      }
      setDrag(current);
    };

    const loop = () => {
      if (scroller) {
        const isDoc = scroller === document.scrollingElement;
        const top = isDoc ? 0 : scroller.getBoundingClientRect().top;
        const bot = isDoc ? window.innerHeight : scroller.getBoundingClientRect().bottom;
        let dy = 0;
        if (last.y < top + EDGE) dy = -speed(last.y - top);
        else if (last.y > bot - EDGE) dy = speed(bot - last.y);
        if (dy) {
          const before = scroller.scrollTop;
          scroller.scrollTop += dy;
          if (scroller.scrollTop !== before) compute();
        }
      }
      raf = requestAnimationFrame(loop);
    };

    const begin = () => {
      active = true;
      document.documentElement.dataset[kind === 'move' ? 'dragging' : 'resizing'] = '';
      window.getSelection()?.removeAllRanges();
      compute();
      raf = requestAnimationFrame(loop);
    };

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      cancelAnimationFrame(raf);
      delete document.documentElement.dataset.dragging;
      delete document.documentElement.dataset.resizing;
      if (active && commit && current) {
        const placed = current.items.find((i) => i.id === id)!;
        setItems(current.items);
        announce(
          kind === 'move'
            ? `${def.name}: ${placed.x + 1}열, ${placed.y + 1}행으로 옮겼어요`
            : `${def.name}: 너비 ${placed.w}칸, 높이 ${placed.h}칸`,
        );
      }
      setDrag(null);
    };
    const onMove = (ev: PointerEvent) => {
      last.x = ev.clientX;
      last.y = ev.clientY;
      if (!active) {
        if (Math.hypot(last.x - start.x, last.y - start.y) < SLOP) return;
        begin();
      }
      compute();
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };

  /** Arrow keys move one cell (skipping no-op spots), Shift+arrows resize, Delete hides. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>, id: string) => {
    const it = items.find((i) => i.id === id);
    const def = byId.get(id);
    if (!it || !def) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      hide(id);
      return;
    }
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir) return;
    e.preventDefault();
    const [dx, dy] = dir as [number, number];
    const same = (a: Item[]) => JSON.stringify(sortById(a)) === JSON.stringify(sortById(items));
    let next: Item[] | null = null;
    for (let step = 1; step <= 40 && !next; step++) {
      const target = e.shiftKey
        ? clampItem({ ...it, w: it.w + dx * step, h: it.h + dy * step, fixed: it.fixed || dy !== 0 }, def)
        : clampItem({ ...it, x: it.x + dx * step, y: it.y + dy * step }, def);
      if (e.shiftKey) target.w = Math.min(target.w, COLS - target.x);
      const tried = settle(swapIn(items, target), target);
      if (!same(tried)) next = tried;
      if (dx !== 0 && !e.shiftKey && step >= COLS) break;
    }
    if (!next) return;
    setItems(next);
    const p = next.find((i) => i.id === id)!;
    announce(e.shiftKey ? `${def.name}: 너비 ${p.w}칸, 높이 ${p.h}칸` : `${def.name}: ${p.x + 1}열, ${p.y + 1}행`);
  };

  /** Double-click on the resize grip: let the height follow the content again. */
  const autoHeight = (id: string) => {
    const it = items.find((i) => i.id === id);
    const def = byId.get(id);
    if (!it || !def || !it.fixed) return;
    const target: Item = { id: it.id, x: it.x, y: it.y, w: it.w, h: it.h };
    setItems(settle(swapIn(items, target), target));
    announce(`${def.name}: 높이를 내용에 맞춰요`);
  };

  const height = Math.max(0, bottom(live) * ROW - GAP) + (editing ? ROW * 6 : 0);
  const placeholder = drag ? live.find((i) => i.id === drag.id) : undefined;

  return (
    <div
      ref={gridRef}
      className={s.grid}
      data-editing={editing || undefined}
      data-dragging={drag ? '' : undefined}
      style={{ height, ['--col' as string]: `${boxOf({ x: 0, y: 0, w: 1, h: 1 }, width).col}px` }}
    >
      {placeholder && <div className={s.placeholder} style={boxStyle(boxOf(placeholder, width))} aria-hidden="true" />}
      {defs.map((def, order) => {
        const it = live.find((i) => i.id === def.id);
        if (!it) {
          // Collapsed because it's empty: keep it mounted (hidden) so it can come back when it has content.
          if (!items.some((i) => i.id === def.id)) return null;
          return (
            <div key={def.id} data-widget={def.id} className={s.widget} hidden>
              <Frame def={def} scroll={false} reportEmpty={reportEmpty} onMeasure={onMeasure}>
                {render(def.id)}
              </Frame>
            </div>
          );
        }
        const lifted = drag?.id === def.id;
        const b = lifted ? drag! : boxOf(it, width);
        const isEmpty = empty.has(def.id);
        return (
          <div
            key={def.id}
            data-widget={def.id}
            className={s.widget}
            data-lifted={lifted ? drag!.kind : undefined}
            data-empty={(editing && isEmpty) || undefined}
            style={boxStyle(b)}
          >
            <div className={cx(s.reveal, editing && s.inert)} style={stagger(Math.min(order, 8))} inert={editing || undefined}>
              <Frame def={def} scroll reportEmpty={reportEmpty} onMeasure={onMeasure}>
                {render(def.id)}
              </Frame>
            </div>
            {editing && (
              <div
                data-overlay
                className={s.overlay}
                tabIndex={0}
                role="group"
                aria-roledescription="위젯"
                aria-label={`${def.name}, ${it.x + 1}열 ${it.y + 1}행, 너비 ${it.w}칸 높이 ${it.h}칸${it.fixed ? '(고정)' : '(내용에 맞춤)'}. 방향키로 옮기고 Shift+방향키로 크기를 바꿔요.`}
                onPointerDown={(e) => startDrag(e, def.id, 'move')}
                onKeyDown={(e) => onKeyDown(e, def.id)}
              >
                <span className={s.chip}>
                  <Icon name="grip" size={14} />
                  <Icon name={def.icon} size={14} />
                  {def.name}
                  {it.fixed && <span className={s.chipNote}>높이 고정</span>}
                </span>
                {isEmpty && <span className={s.emptyNote}>지금은 표시할 내용이 없어요</span>}
                <button
                  type="button"
                  className={s.hideBtn}
                  aria-label={`${def.name} 숨기기`}
                  {...tip('숨기기', { side: 'top' })}
                  onClick={() => hide(def.id)}
                >
                  <Icon name="eyeOff" size={15} />
                </button>
                <span
                  className={s.handle}
                  aria-hidden="true"
                  title={it.fixed ? '끌어서 크기 조절 · 두 번 누르면 높이를 다시 내용에 맞춰요' : '끌어서 크기 조절 (높이를 끌면 그 높이로 고정돼요)'}
                  onPointerDown={(e) => startDrag(e, def.id, 'resize')}
                  onDoubleClick={() => autoHeight(def.id)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function boxStyle(b: { left: number; top: number; width: number; height: number }) {
  return { transform: `translate3d(${b.left}px, ${b.top}px, 0)`, width: b.width, height: b.height };
}

const swapIn = (items: Item[], it: Item) => items.map((i) => (i.id === it.id ? it : i));
const sortById = (items: Item[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));

function speed(distToEdge: number): number {
  const t = Math.min(1, Math.max(0, (EDGE - distToEdge) / EDGE));
  return Math.round(MAX_SCROLL * t * t);
}

/* ───────────────────────── mobile: view */

function MobileStack({
  layout,
  render,
  byId,
  empty,
  reportEmpty,
}: Props & { byId: Map<string, WidgetDef>; empty: ReadonlySet<string>; reportEmpty: (id: string, empty: boolean) => void }) {
  const order = layout.mobile.order.filter((id) => byId.has(id));
  const visible = order.filter((id) => !empty.has(id));
  const spans = mobileSpans(visible, byId);
  return (
    <div className={s.stack}>
      {order.map((id, i) => {
        const def = byId.get(id)!;
        const gone = empty.has(id);
        return (
          <div
            key={id}
            className={cx(s.stackItem, s.reveal)}
            data-chrome={def.chrome}
            data-span={spans.get(id) ?? 2}
            hidden={gone || undefined}
            style={stagger(Math.min(i, 8))}
          >
            <Frame def={def} scroll={false} reportEmpty={reportEmpty}>
              {render(id)}
            </Frame>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── mobile: edit (a compact, reorderable list) */

function MobileEditor({ layout, onChange, byId, announce, focusId, onFocused }: Props & { byId: Map<string, WidgetDef>; announce: (m: string) => void }) {
  const listRef = useRef<HTMLOListElement>(null);
  const order = layout.mobile.order.filter((id) => byId.has(id));
  const [drag, setDrag] = useState<{ id: string; dy: number; order: string[] } | null>(null);
  const shown = drag?.order ?? order;

  const setOrder = (next: string[]) => onChange({ ...layout, mobile: { ...layout.mobile, order: next } });

  const move = (id: string, by: number) => {
    const i = order.indexOf(id);
    const j = Math.max(0, Math.min(order.length - 1, i + by));
    if (i === j) return;
    const next = [...order];
    next.splice(i, 1);
    next.splice(j, 0, id);
    setOrder(next);
    announce(`${byId.get(id)?.name}: ${j + 1}번째`);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row="${id}"] [data-grip]`)?.focus());
  };

  const hide = (id: string) => {
    onChange({ ...layout, mobile: { order: order.filter((x) => x !== id), hidden: [...layout.mobile.hidden, id] } });
    announce(`${byId.get(id)?.name ?? '위젯'}을 숨겼어요`);
  };

  useEffect(() => {
    if (!focusId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${focusId}"] [data-grip]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    onFocused();
  }, [focusId, onFocused, order]);

  const startDrag = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = order.indexOf(id);
    const startY = e.clientY;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.documentElement.dataset.dragging = '';
    let current = order;
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const to = Math.max(0, Math.min(order.length - 1, from + Math.round(dy / ROW_PITCH)));
      current = [...order];
      current.splice(from, 1);
      current.splice(to, 0, id);
      setDrag({ id, dy, order: current });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      delete document.documentElement.dataset.dragging;
      setDrag(null);
      if (current !== order) {
        setOrder(current);
        announce(`${byId.get(id)?.name}: ${current.indexOf(id) + 1}번째`);
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  return (
    <ol ref={listRef} className={s.editList} style={{ height: shown.length * ROW_PITCH - 8 }} aria-label="홈 위젯 순서">
      {order.map((id) => {
        const def = byId.get(id)!;
        const idx = shown.indexOf(id);
        const lifted = drag?.id === id;
        const y = lifted ? order.indexOf(id) * ROW_PITCH + drag!.dy : idx * ROW_PITCH;
        return (
          <li
            key={id}
            data-row={id}
            className={s.editRow}
            data-lifted={lifted || undefined}
            style={{ transform: `translate3d(0, ${y}px, 0)` }}
          >
            <button
              type="button"
              data-grip
              className={s.grip}
              aria-label={`${def.name} 옮기기. 위아래 방향키로 순서를 바꿔요.`}
              onPointerDown={(e) => startDrag(e, id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(id, e.key === 'ArrowUp' ? -1 : 1);
                }
              }}
            >
              <Icon name="grip" size={16} />
            </button>
            <span className={s.rowIcon}>
              <Icon name={def.icon} size={16} />
            </span>
            <span className={s.rowName}>{def.name}</span>
            {def.mobileHalf && <span className={s.rowHint}>반 칸</span>}
            <button type="button" className={ui.iconBtn} aria-label={`${def.name} 위로`} disabled={idx === 0} onClick={() => move(id, -1)}>
              <Icon name="chevronUp" size={16} />
            </button>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label={`${def.name} 아래로`}
              disabled={idx === order.length - 1}
              onClick={() => move(id, 1)}
            >
              <Icon name="chevronDown" size={16} />
            </button>
            <button type="button" className={ui.iconBtn} aria-label={`${def.name} 숨기기`} onClick={() => hide(id)}>
              <Icon name="eyeOff" size={16} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
