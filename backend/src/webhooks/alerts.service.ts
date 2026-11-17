import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  isScheduleEvent,
  scheduleAlerts,
  scheduleSummary,
  todayIn,
  webhookText,
  type PlanDependency,
  type WebhookEventKey,
  type WebhookPayload,
} from '@obelisk/core';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { InjectDb, type Db } from '../db/db.module';
import { taskDependencies, tasks, webhookDeliveries, webhooks, workspaces, type TaskRow, type WebhookRow } from '../db/schema';
import { toPlanItem } from '../planner/mappers';
import { DeliveryService } from './delivery.service';
import { inScope, nameLookup, taskRef } from './webhooks.service';

const SCAN_MS = 5 * 60_000;

/** The hour (0–23) it is now in a time zone. */
export function localHour(timeZone: string, now: Date = new Date()): number {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now)) % 24;
  } catch {
    return now.getUTCHours();
  }
}

/**
 * Schedule alerts: every few minutes, for each webhook that wants them and whose local alert hour
 * has come, queue one delivery per task and condition. The dedupe key (event, task, local date)
 * makes each go out once a day; a scan that runs late (restart, downtime) still catches up today.
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly delivery: DeliveryService,
  ) {}

  onModuleInit() {
    if (process.env.WEBHOOK_WORKER === 'off') return;
    this.timer = setInterval(() => void this.run(), SCAN_MS);
    this.timer.unref?.();
    this.first = setTimeout(() => void this.run(), 20_000);
    this.first.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.scan();
    } catch (e) {
      console.error('[webhooks] schedule scan failed', e instanceof Error ? e.message : e);
    } finally {
      this.running = false;
    }
  }

  /** Returns how many deliveries were queued. */
  async scan(now: Date = new Date(), onlyWorkspaceId?: string): Promise<number> {
    const all = await this.db
      .select()
      .from(webhooks)
      .where(onlyWorkspaceId ? and(eq(webhooks.enabled, true), eq(webhooks.workspaceId, onlyWorkspaceId)) : eq(webhooks.enabled, true));
    const due = all.filter((h) => (h.events as string[]).some(isScheduleEvent) && localHour(h.timezone, now) >= h.alertHour);
    const byWorkspace = new Map<string, WebhookRow[]>();
    for (const h of due) byWorkspace.set(h.workspaceId, [...(byWorkspace.get(h.workspaceId) ?? []), h]);
    let queued = 0;
    for (const [workspaceId, hooks] of byWorkspace) queued += await this.scanWorkspace(workspaceId, hooks, now);
    if (queued) this.delivery.nudge();
    return queued;
  }

  private async scanWorkspace(workspaceId: string, hooks: WebhookRow[], now: Date): Promise<number> {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) return 0;
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, ['todo', 'doing'])));
    // Same rule as activity events: an organization's inbox tasks are private and never leave the app.
    const visible = ws.kind === 'org' ? rows.filter((t) => t.projectId) : rows;
    if (!visible.length) return 0;
    const byId = new Map<string, TaskRow>(visible.map((t) => [t.id, t]));
    const deps: PlanDependency[] = (
      await this.db
        .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
        .from(taskDependencies)
        .where(eq(taskDependencies.workspaceId, workspaceId))
    ).filter((d) => byId.has(d.taskId) && byId.has(d.dependsOnId));
    const items = visible.map(toPlanItem);
    const names = await nameLookup(this.db, {
      projects: visible.map((t) => t.projectId),
      users: visible.map((t) => t.assigneeId),
    });

    let queued = 0;
    const perDay = new Map<string, ReturnType<typeof scheduleAlerts>>();
    for (const hook of hooks) {
      const today = todayIn(hook.timezone, now);
      if (!perDay.has(today)) perDay.set(today, scheduleAlerts(items, deps, today));
      const wanted = new Set(hook.events as string[]);
      const values = perDay
        .get(today)!
        .filter((al) => wanted.has(al.key) && inScope(hook, al.key as WebhookEventKey, byId.get(al.taskId)?.projectId ?? null))
        .map((al) => {
          const t = byId.get(al.taskId)!;
          const ref = taskRef(t, names);
          const cause = al.causeId ? byId.get(al.causeId) : undefined;
          const causeSubject = cause ? `#${cause.number} ${cause.title}` : null;
          const base = { actor: null, subject: `${ref.ref} ${t.title}`, summary: scheduleSummary(al, causeSubject) };
          const payload: WebhookPayload = {
            id: randomUUID(),
            event: al.key,
            createdAt: now.toISOString(),
            workspace: { id: ws.id, name: ws.name, kind: ws.kind },
            ...base,
            text: webhookText(base),
            url: ref.url,
            task: ref,
            alert: {
              date: today,
              ...(al.daysOverdue !== undefined ? { daysOverdue: al.daysOverdue } : {}),
              ...(al.overrunDays !== undefined ? { overrunDays: al.overrunDays } : {}),
              ...(al.key === 'fixed.conflict'
                ? { cause: cause ? { id: cause.id, ref: `#${cause.number}`, title: cause.title } : null }
                : {}),
            },
          };
          return { webhookId: hook.id, event: al.key, dedupeKey: `${al.key}:${al.taskId}:${today}`, payload };
        });
      for (let i = 0; i < values.length; i += 200) {
        const inserted = await this.db
          .insert(webhookDeliveries)
          .values(values.slice(i, i + 200))
          .onConflictDoNothing({ target: [webhookDeliveries.webhookId, webhookDeliveries.dedupeKey] })
          .returning({ id: webhookDeliveries.id });
        queued += inserted.length;
      }
    }
    return queued;
  }
}
