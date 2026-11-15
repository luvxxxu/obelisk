import { describe, expect, test } from 'bun:test';
import { POSITION_STEP, positionBetween, spread } from '../src/order';

describe('positionBetween', () => {
  test('empty list', () => {
    expect(positionBetween()).toBe(POSITION_STEP);
  });

  test('top and bottom step away from the neighbour', () => {
    expect(positionBetween(undefined, 2048)).toBe(1024);
    expect(positionBetween(2048, undefined)).toBe(3072);
    // works below zero too (dropped above a card that was already moved to the top)
    expect(positionBetween(undefined, 0)).toBe(-POSITION_STEP);
  });

  test('midpoint between neighbours', () => {
    expect(positionBetween(1024, 2048)).toBe(1536);
    const p = positionBetween(1, 1.5)!;
    expect(p).toBeGreaterThan(1);
    expect(p).toBeLessThan(1.5);
  });

  test('no room → null so the caller renumbers', () => {
    expect(positionBetween(5, 5)).toBeNull();
    expect(positionBetween(5, 4)).toBeNull();
    expect(positionBetween(5, 5 + 1e-9)).toBeNull();
  });

  test('repeated inserts at the same spot stay ordered for a long time', () => {
    let lo = 1024;
    const hi = 2048;
    for (let i = 0; i < 30; i++) {
      const p = positionBetween(lo, hi);
      expect(p).not.toBeNull();
      expect(p!).toBeGreaterThan(lo);
      expect(p!).toBeLessThan(hi);
      lo = p!;
    }
  });
});

describe('spread', () => {
  test('evenly spaced, in order', () => {
    expect(spread(['a', 'b', 'c'])).toEqual([
      { id: 'a', position: 1024 },
      { id: 'b', position: 2048 },
      { id: 'c', position: 3072 },
    ]);
  });
});
