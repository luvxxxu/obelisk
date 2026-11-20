import { describe, expect, test } from 'bun:test';
import type { MigrationBundle, MigrationResult } from '@obelisk/core';
import { decodeBundle } from '../src/migration/transfer.service';
import { StagingStore } from '../src/migration/staging';

const bundle = { exportId: 'x' } as unknown as MigrationBundle;
const result = { workspaceId: 'w' } as unknown as MigrationResult;

describe('StagingStore', () => {
  test('one import at a time, then the same answer again', () => {
    const store = new StagingStore();
    const s = store.put('u1', bundle, 10);
    const claimed = store.begin('u1', s.id);
    expect(claimed).toBe(s);
    expect(store.begin('u1', s.id)).toBe('busy');
    expect(store.importing('u1')).toBe(true);
    // A cancel or a new upload can't pull the entry out from under the running import.
    store.drop('u1', s.id);
    expect(store.get('u1', s.id)).toBe(s);
    store.finish(s, result);
    expect(store.begin('u1', s.id)).toBe('done');
    expect(store.get('u1', s.id)?.result).toBe(result);
    expect(store.get('u1', s.id)?.bundle).toBeNull();
    store.close();
  });

  test('a failed import can be tried again; others never see it', () => {
    const store = new StagingStore();
    const s = store.put('u1', bundle);
    store.begin('u1', s.id);
    store.release(s);
    expect(store.begin('u2', s.id)).toBeNull();
    expect(store.begin('u1', s.id)).toBe(s);
    store.close();
  });

  test('keeps within its overall size and count, oldest out first', () => {
    const store = new StagingStore(60_000, 100, 3);
    const a = store.put('a', bundle, 60);
    const b = store.put('b', bundle, 30);
    store.put('c', bundle, 50); // 60 + 30 + 50 > 100 → a goes
    expect(store.get('a', a.id)).toBeNull();
    expect(store.get('b', b.id)).not.toBeNull();
    store.put('d', bundle, 1);
    store.put('e', bundle, 1); // more than 3 entries → b goes
    expect(store.get('b', b.id)).toBeNull();
    expect(store.size).toBeLessThanOrEqual(3);
    store.close();
  });
});

describe('decodeBundle', () => {
  test('a byte order mark is ignored', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"format":"obelisk-export"}')]);
    expect(decodeBundle(bytes)).toEqual({ format: 'obelisk-export' });
  });
});
