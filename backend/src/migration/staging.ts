import type { MigrationBundle, MigrationResult } from '@obelisk/core';
import { randomUUID } from 'node:crypto';

export interface Staged {
  id: string;
  userId: string;
  /** null once imported (the answer is kept a while, the bundle isn't). */
  bundle: MigrationBundle | null;
  /** Rough size of the bundle (its bytes on the wire), for the store's overall cap. */
  bytes: number;
  state: 'waiting' | 'importing' | 'done';
  result: MigrationResult | null;
  expiresAt: Date;
}

const TTL_MS = 30 * 60_000;
/** All staged bundles together (the parsed objects are a few times their file size). */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 200;

/**
 * Bundles waiting for the person to look at the preview and confirm. In memory only (one server
 * process): one per person, a new upload replaces the previous one, gone after 30 minutes. An entry
 * is claimed while it imports (a second import of it waits its turn with a 409) and afterwards keeps
 * the import's answer, so a page whose answer got lost on the way can still learn what happened.
 */
export class StagingStore {
  private readonly byId = new Map<string, Staged>();
  private readonly byUser = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly ttlMs = TTL_MS,
    private readonly maxBytes = MAX_TOTAL_BYTES,
    private readonly maxEntries = MAX_ENTRIES,
  ) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  /** True while this person's staged bundle is being imported (a new upload would hide its outcome). */
  importing(userId: string): boolean {
    const cur = this.byUser.get(userId);
    return !!cur && this.byId.get(cur)?.state === 'importing';
  }

  put(userId: string, bundle: MigrationBundle, bytes = 0): Staged {
    this.drop(userId);
    this.makeRoom(bytes);
    const staged: Staged = {
      id: randomUUID(),
      userId,
      bundle,
      bytes,
      state: 'waiting',
      result: null,
      expiresAt: new Date(Date.now() + this.ttlMs),
    };
    this.byId.set(staged.id, staged);
    this.byUser.set(userId, staged.id);
    return staged;
  }

  /** Only the person who staged it gets it back. */
  get(userId: string, id: string): Staged | null {
    const s = this.byId.get(id);
    if (!s || s.userId !== userId) return null;
    if (s.expiresAt.getTime() < Date.now()) {
      this.remove(s);
      return null;
    }
    return s;
  }

  /**
   * Claim a waiting bundle for importing. 'busy' while another request imports it, 'done' once
   * imported, null when there is nothing (expired, someone else's).
   */
  begin(userId: string, id: string): Staged | 'busy' | 'done' | null {
    const s = this.get(userId, id);
    if (!s) return null;
    if (s.state === 'importing') return 'busy';
    if (s.state === 'done') return 'done';
    s.state = 'importing';
    return s;
  }

  /** The import went through: keep its answer, let the bundle go. */
  finish(s: Staged, result: MigrationResult) {
    s.state = 'done';
    s.result = result;
    s.bundle = null;
    s.bytes = 0;
  }

  /** The import failed (nothing was written): it can be tried again. */
  release(s: Staged) {
    if (s.state === 'importing') s.state = 'waiting';
  }

  /** Drop this person's staged bundle (all of them, or only `id`). An import in progress keeps its entry. */
  drop(userId: string, id?: string) {
    const cur = this.byUser.get(userId);
    if (!cur || (id && cur !== id)) return;
    const s = this.byId.get(cur);
    if (s?.state === 'importing') return;
    if (s) this.remove(s);
    else this.byUser.delete(userId);
  }

  get size() {
    return this.byId.size;
  }

  private total() {
    let n = 0;
    for (const s of this.byId.values()) n += s.bytes;
    return n;
  }

  /** Oldest first, never one that is importing. */
  private makeRoom(bytes: number) {
    this.sweep();
    const order = [...this.byId.values()].filter((s) => s.state !== 'importing').sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    let total = this.total();
    for (const s of order) {
      if (this.byId.size < this.maxEntries && total + bytes <= this.maxBytes) break;
      total -= s.bytes;
      this.remove(s);
    }
  }

  private remove(s: Staged) {
    this.byId.delete(s.id);
    if (this.byUser.get(s.userId) === s.id) this.byUser.delete(s.userId);
  }

  sweep() {
    const now = Date.now();
    for (const s of this.byId.values()) if (s.expiresAt.getTime() < now && s.state !== 'importing') this.remove(s);
  }

  close() {
    clearInterval(this.timer);
  }
}
