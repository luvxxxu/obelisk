import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { chatMessage, orderPayload, type WebhookPayload } from '@obelisk/core';
import { and, asc, eq, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import { config } from '../config';
import { seal, unseal } from '../common/secret';
import { InjectDb, type Db } from '../db/db.module';
import { webhookDeliveries, webhooks, type WebhookDeliveryRow, type WebhookRow } from '../db/schema';
import { assertDeliverable, signBody, UndeliverableError } from './net';

/** Wait after attempt n fails (n = 1…5): 1 min, 5 min, 30 min, 2 h, 6 h. The 6th failure is final. */
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
/** Consecutive deliveries that fail for good before the server turns the webhook off. */
export const DISABLE_AFTER = 10;
const TIMEOUT_MS = 10_000;
/** Lease while a send is in flight; a crash mid-send makes it due again after this. */
const LEASE = sql`now() + interval '2 minutes'`;
const KEEP_DAYS = 30;
const RESPONSE_LIMIT = 2000;

export const secretContext = (webhookId: string) => `webhook-secret:${webhookId}`;

interface SendResult {
  ok: boolean;
  retryable: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  durationMs: number;
  /** Seconds the receiver asked us to wait (429 Retry-After). */
  retryAfter?: number;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < RESPONSE_LIMIT * 4) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, RESPONSE_LIMIT);
}

/** The exact bytes a webhook receives for a payload. */
export function renderBody(format: WebhookRow['format'], payload: WebhookPayload): string {
  return JSON.stringify(format === 'json' ? orderPayload(payload) : chatMessage(payload, format));
}

/**
 * Sends queued deliveries. Rows are claimed with FOR UPDATE SKIP LOCKED and a short lease, so a
 * second instance or a crash never sends one twice in a row; each webhook's deliveries go out in
 * order, different webhooks in parallel.
 */
@Injectable()
export class DeliveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private nudgeTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(@InjectDb() private readonly db: Db) {}

  onModuleInit() {
    if (process.env.WEBHOOK_WORKER === 'off') return;
    this.timer = setInterval(() => void this.tick(), 3000);
    this.timer.unref?.();
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => {}), 60 * 60_000);
    this.sweepTimer.unref?.();
    void this.sweep().catch(() => {});
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
  }

  /** Something was queued: look soon rather than at the next tick (after the change commits). */
  nudge() {
    if (this.nudgeTimer || !this.timer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      void this.tick();
    }, 400);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (let round = 0; round < 10; round++) {
        const claimed = await this.claim(25);
        if (!claimed.length) break;
        await this.process(claimed);
      }
    } catch (e) {
      console.error('[webhooks] delivery loop failed', e instanceof Error ? e.message : e);
    } finally {
      this.running = false;
    }
  }

  private async claim(limit: number): Promise<WebhookDeliveryRow[]> {
    const due = this.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, sql`now()`)))
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    return this.db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: LEASE })
      .where(inArray(webhookDeliveries.id, due))
      .returning();
  }

  private async process(rows: WebhookDeliveryRow[]) {
    const ids = [...new Set(rows.map((r) => r.webhookId))];
    const hooks = new Map(
      (await this.db.select().from(webhooks).where(inArray(webhooks.id, ids))).map((h) => [h.id, h] as const),
    );
    const groups = new Map<string, WebhookDeliveryRow[]>();
    for (const r of rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      groups.set(r.webhookId, [...(groups.get(r.webhookId) ?? []), r]);
    }
    await Promise.all(
      [...groups].map(async ([id, list]) => {
        for (const d of list) {
          try {
            await this.attempt(hooks.get(id), d);
          } catch (e) {
            console.error('[webhooks] delivery failed unexpectedly', e instanceof Error ? e.message : e);
          }
        }
      }),
    );
  }

  /** One try at one delivery; records the outcome and schedules a retry or gives up. */
  async attempt(hook: WebhookRow | undefined, d: WebhookDeliveryRow, opts: { force?: boolean } = {}): Promise<WebhookDeliveryRow> {
    const result: SendResult =
      !hook || (!hook.enabled && !opts.force)
        ? { ok: false, retryable: false, status: null, body: null, error: '웹훅이 꺼져 있어 보내지 않았어요', durationMs: 0 }
        : await this.send(hook, d);
    const attempts = d.attempts + 1;
    const retry = !result.ok && result.retryable && attempts < d.maxAttempts;
    const wait = Math.max(BACKOFF_SECONDS[attempts - 1] ?? 0, Math.min(result.retryAfter ?? 0, 3600));
    const [row] = await this.db
      .update(webhookDeliveries)
      .set({
        status: result.ok ? 'success' : retry ? 'pending' : 'failed',
        attempts,
        lastAttemptAt: new Date(),
        nextAttemptAt: retry ? new Date(Date.now() + wait * 1000) : new Date(),
        responseStatus: result.status,
        responseBody: result.body,
        error: result.error,
        durationMs: result.durationMs,
      })
      .where(eq(webhookDeliveries.id, d.id))
      .returning();
    if (hook && d.maxAttempts > 1) await this.track(hook, result.ok, !result.ok && !retry);
    return row!;
  }

  /** Consecutive final failures; a success resets it, too many turn the webhook off. */
  private async track(hook: WebhookRow, ok: boolean, gaveUp: boolean) {
    if (ok) {
      if (hook.failureCount) await this.db.update(webhooks).set({ failureCount: 0 }).where(eq(webhooks.id, hook.id));
      return;
    }
    if (!gaveUp || !hook.enabled) return;
    const [row] = await this.db
      .update(webhooks)
      .set({ failureCount: sql`${webhooks.failureCount} + 1` })
      .where(eq(webhooks.id, hook.id))
      .returning({ failureCount: webhooks.failureCount });
    if (row && row.failureCount >= DISABLE_AFTER) {
      await this.db
        .update(webhooks)
        .set({ enabled: false, disabledReason: `연속 ${row.failureCount}번 전달에 실패해 자동으로 껐어요` })
        .where(and(eq(webhooks.id, hook.id), eq(webhooks.enabled, true)));
      console.warn(`[webhooks] turned off ${hook.id} after ${row.failureCount} failed deliveries`);
    }
  }

  private async send(hook: WebhookRow, d: WebhookDeliveryRow): Promise<SendResult> {
    const started = Date.now();
    const done = (r: Omit<SendResult, 'durationMs'>): SendResult => ({ ...r, durationMs: Date.now() - started });
    const opened = unseal(hook.secret, secretContext(hook.id));
    if (!opened) {
      return done({ ok: false, retryable: false, status: null, body: null, error: '서명 키를 열 수 없어요. 서명 키를 다시 만드세요 (SECRET_KEY가 바뀌었을 수 있어요)' });
    }
    if (opened.stale) {
      await this.db.update(webhooks).set({ secret: seal(opened.value, secretContext(hook.id)) }).where(eq(webhooks.id, hook.id));
    }
    let url: URL;
    try {
      url = await assertDeliverable(hook.url, config.webhookAllowPrivate);
    } catch (e) {
      const err = e instanceof UndeliverableError ? e : new UndeliverableError(String(e), true);
      return done({ ok: false, retryable: err.retryable, status: null, body: null, error: err.message });
    }
    const body = renderBody(hook.format, d.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': 'Obelisk-Webhooks/1.0',
          'x-obelisk-event': d.event,
          'x-obelisk-delivery': d.id,
          'x-obelisk-timestamp': String(timestamp),
          'x-obelisk-signature': signBody(opened.value, timestamp, body),
        },
        body,
      });
      const text = await readCapped(res).catch(() => '');
      if (res.status >= 200 && res.status < 300) return done({ ok: true, retryable: false, status: res.status, body: text, error: null });
      if (res.status >= 300 && res.status < 400) {
        return done({
          ok: false,
          retryable: false,
          status: res.status,
          body: text,
          error: `리디렉션(${res.status})은 따라가지 않아요. 최종 주소를 입력하세요${res.headers.get('location') ? ` → ${res.headers.get('location')}` : ''}`,
        });
      }
      const retryable = res.status >= 500 || [408, 409, 425, 429].includes(res.status);
      const after = Number(res.headers.get('retry-after'));
      return done({
        ok: false,
        retryable,
        status: res.status,
        body: text,
        error: `HTTP ${res.status}${retryable ? '' : ' — 받는 쪽이 요청을 거절했어요 (재시도하지 않음)'}`,
        ...(Number.isFinite(after) && after > 0 ? { retryAfter: after } : {}),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      const message = name === 'TimeoutError' || name === 'AbortError' ? `${TIMEOUT_MS / 1000}초 안에 응답이 없었어요` : `연결 실패: ${e instanceof Error ? e.message : String(e)}`;
      return done({ ok: false, retryable: true, status: null, body: null, error: message });
    }
  }

  /** Keep a month of history; pending rows stay until they finish. */
  async sweep() {
    await this.db
      .delete(webhookDeliveries)
      .where(and(ne(webhookDeliveries.status, 'pending'), lt(webhookDeliveries.createdAt, new Date(Date.now() - KEEP_DAYS * 86_400_000))));
  }
}
