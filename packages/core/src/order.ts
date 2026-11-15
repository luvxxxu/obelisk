/**
 * Manual ordering with fractional positions (board cards, lists). A drop writes one number — the
 * midpoint of its new neighbours — and only renumbers the list when two neighbours are too close.
 */

/** Gap between items when a list is (re)numbered. */
export const POSITION_STEP = 1024;
/** Below this gap a midpoint is no longer reliably distinct, so the list gets renumbered. */
const MIN_GAP = 1e-6;

/**
 * Position for an item placed between `before` and `after` (either may be missing).
 * Returns null when there is no room between them and the list must be renumbered with `spread`.
 */
export function positionBetween(before?: number, after?: number): number | null {
  if (before === undefined && after === undefined) return POSITION_STEP;
  if (before === undefined) return after! - POSITION_STEP;
  if (after === undefined) return before + POSITION_STEP;
  if (after - before <= MIN_GAP) return null;
  return before + (after - before) / 2;
}

/** Evenly spaced positions for `ids`, in order. */
export function spread(ids: readonly string[], step = POSITION_STEP): { id: string; position: number }[] {
  return ids.map((id, i) => ({ id, position: (i + 1) * step }));
}
