import type { HomeLayout, HomeLayoutItem } from '@obelisk/core';
import type { IconName } from '@/components/Icon';

/**
 * Home dashboard grid: 12 columns × 24px rows with a 16px gutter.
 * A widget h rows tall is h·24 − 16 px, so stacked widgets keep the same 16px gap as columns.
 * The layout is "gravity" packed like most dashboards: widgets float up until they hit another one,
 * which keeps the page free of holes while still letting people arrange it freely.
 */
export const COLS = 12;
export const ROW = 24;
export const GAP = 16;
export const MAX_H = 60;
/** Below this container width the home switches to the one-column mobile layout. */
export const MOBILE_MAX = 760;

export type Item = HomeLayoutItem;

export interface WidgetDef {
  id: string;
  /** Shown on the widget while editing and in the "위젯 추가" menu. */
  name: string;
  icon: IconName;
  /** 'bare' fills the box with its own card; 'section' gets a page-section heading above a scrolling body. */
  chrome: 'bare' | 'section';
  lead?: string;
  min: { w: number; h: number };
  desktop: Omit<Item, 'id'>;
  /** Two of these sit side by side on mobile (the summary tiles). */
  mobileHalf?: boolean;
}

export const collides = (a: Item, b: Item) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function clampItem(it: Item, def: WidgetDef | undefined): Item {
  const minW = def?.min.w ?? 1;
  const minH = def?.min.h ?? 1;
  const w = Math.max(minW, Math.min(COLS, Math.round(it.w)));
  const h = Math.max(minH, Math.min(MAX_H, Math.round(it.h)));
  const x = Math.max(0, Math.min(COLS - w, Math.round(it.x)));
  const y = Math.max(0, Math.round(it.y));
  return it.fixed ? { id: it.id, x, y, w, h, fixed: true } : { id: it.id, x, y, w, h };
}

/** Tallest a list widget grows on its own before its body starts to scroll (24 rows = 560px). */
export const AUTO_MAX = 24;

/**
 * Heights as shown. A widget follows its content (`natural`, in rows) unless the user fixed its height:
 * - cards ('bare') never cut content: a fixed height only adds room;
 * - lists ('section') grow up to AUTO_MAX, or take the fixed height, and scroll beyond it.
 * Auto widgets that were placed side by side with the same height share the tallest one, so a row of
 * tiles keeps one baseline even when one tile's text wraps.
 */
export function effectiveItems(items: Item[], defs: Map<string, WidgetDef>, natural: ReadonlyMap<string, number>): Item[] {
  const want = (it: Item) => {
    const def = defs.get(it.id);
    const n = natural.get(it.id);
    if (!def || n === undefined) return it.h;
    const h = def.chrome === 'bare' ? (it.fixed ? Math.max(it.h, n) : n) : it.fixed ? it.h : Math.min(AUTO_MAX, n);
    return Math.max(def.min.h, Math.min(MAX_H, h));
  };
  const rowKey = (it: Item) => `${it.y}:${it.h}`;
  const shared = new Map<string, number>();
  for (const it of items) if (!it.fixed) shared.set(rowKey(it), Math.max(shared.get(rowKey(it)) ?? 0, want(it)));
  return items.map((it) => ({ ...it, h: it.fixed ? want(it) : shared.get(rowKey(it))! }));
}

const byYX = (a: Item, b: Item) => a.y - b.y || a.x - b.x;

/**
 * Resolve overlaps and pack upward. `active` (the widget being dragged, resized or moved by keyboard)
 * claims its spot first. A widget it lands on moves above it when it started higher and fits there
 * (so dragging past a neighbour swaps the two), otherwise it is pushed below. Then everything floats
 * up until it touches another widget — never through one, so widgets don't leapfrog.
 */
export function settle(items: Item[], active?: Item): Item[] {
  const placed: Item[] = active ? [{ ...active }] : [];
  const rest = items.filter((i) => i.id !== active?.id).sort(byYX);
  for (const r of rest) {
    const it = { ...r };
    if (active && it.y < active.y && collides(it, placed[0]!)) {
      const above = { ...it, y: active.y - it.h };
      if (above.y >= 0 && !placed.some((p) => collides(above, p))) {
        placed.push(above);
        continue;
      }
    }
    while (placed.some((p) => collides(it, p))) it.y++;
    placed.push(it);
  }
  compact(placed);
  return placed;
}

/** Float every widget up until it touches another; repeat until nothing moves. */
function compact(list: Item[]) {
  for (let moved = true; moved; ) {
    moved = false;
    for (const it of [...list].sort(byYX)) {
      while (it.y > 0 && !list.some((p) => p !== it && collides({ ...it, y: it.y - 1 }, p))) {
        it.y--;
        moved = true;
      }
    }
  }
}

export const bottom = (items: Item[]) => items.reduce((m, i) => Math.max(m, i.y + i.h), 0);

/**
 * Where a widget coming back should go: its default spot if that's free, otherwise the first hole
 * (top to bottom, left to right) big enough for it, otherwise the bottom.
 */
export function firstFit(items: Item[], it: Item): Item {
  const free = (c: Item) => !items.some((p) => collides(c, p));
  if (free(it)) return it;
  const end = bottom(items);
  for (let y = 0; y < end; y++) {
    for (let x = 0; x + it.w <= COLS; x++) {
      const c = { ...it, x, y };
      if (free(c)) return c;
    }
  }
  return { ...it, y: end };
}

export function defaultLayout(defs: WidgetDef[]): HomeLayout {
  return {
    v: 1,
    desktop: { items: settle(defs.map((d) => ({ id: d.id, ...d.desktop }))), hidden: [] },
    mobile: { order: defs.map((d) => d.id), hidden: [] },
  };
}

/** Make a saved layout safe to render: drop unknown widgets, clamp sizes, add widgets that are new since it was saved. */
export function normalize(saved: HomeLayout | null | undefined, defs: WidgetDef[]): HomeLayout {
  if (!saved || saved.v !== 1) return defaultLayout(defs);
  const byId = new Map(defs.map((d) => [d.id, d]));
  const known = (id: string) => byId.has(id);
  const uniq = (ids: string[]) => [...new Set(ids.filter(known))];

  const seen = new Set<string>();
  const items: Item[] = [];
  for (const it of saved.desktop?.items ?? []) {
    if (!known(it.id) || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(clampItem(it, byId.get(it.id)));
  }
  const dHidden = uniq(saved.desktop?.hidden ?? []).filter((id) => !seen.has(id));
  const packed = settle(items);
  for (const d of defs) {
    if (seen.has(d.id) || dHidden.includes(d.id)) continue;
    packed.push(firstFit(packed, clampItem({ id: d.id, ...d.desktop }, d)));
  }
  items.splice(0, items.length, ...packed);

  const order = uniq(saved.mobile?.order ?? []);
  const mHidden = uniq(saved.mobile?.hidden ?? []).filter((id) => !order.includes(id));
  for (const d of defs) if (!order.includes(d.id) && !mHidden.includes(d.id)) order.push(d.id);

  return { v: 1, desktop: { items: settle(items), hidden: dHidden }, mobile: { order, hidden: mHidden } };
}

export function sameLayout(a: HomeLayout, b: HomeLayout): boolean {
  const key = (l: HomeLayout) =>
    JSON.stringify({
      d: [...l.desktop.items].sort((p, q) => p.id.localeCompare(q.id)),
      dh: [...l.desktop.hidden].sort(),
      m: l.mobile.order,
      mh: [...l.mobile.hidden].sort(),
    });
  return key(a) === key(b);
}

/** Pixel box of a grid item inside a container `width` px wide. */
export function boxOf(it: Pick<Item, 'x' | 'y' | 'w' | 'h'>, width: number) {
  const col = (width - GAP * (COLS - 1)) / COLS;
  return {
    left: it.x * (col + GAP),
    top: it.y * ROW,
    width: it.w * col + (it.w - 1) * GAP,
    height: it.h * ROW - GAP,
    col,
  };
}

/** Mobile rows: half-width widgets pair up when two of them are next to each other. */
export function mobileSpans(order: string[], defs: Map<string, WidgetDef>): Map<string, 1 | 2> {
  const spans = new Map<string, 1 | 2>();
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!;
    const next = order[i + 1];
    if (defs.get(id)?.mobileHalf && next && defs.get(next)?.mobileHalf) {
      spans.set(id, 1);
      spans.set(next, 1);
      i++;
    } else spans.set(id, 2);
  }
  return spans;
}
