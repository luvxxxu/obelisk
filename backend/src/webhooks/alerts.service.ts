import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  isReminderEvent,
  isScheduleEvent,
  nowIn,
  reminderAlerts,
  reminderSummary,
  scheduleAlerts,
  scheduleSummary,
  webhookText,
  type PlanDependency,
  type ReminderEventKey,
  type WebhookEventKey,
  type WebhookPayload,
} from '@obelisk/core';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { InjectDb, type Db } from '../db/db.module';
import { taskDependencies, tasks, webhookDeliveries, webhooks, workspaces, type TaskRow, type WebhookRow } from '../db/schema';
import { toPlanItem } from '../planner/mappers';
import { DeliveryService } from './delivery.service';
import { inScope, nameLookup, taskRef } from './webhooks.service';

const SCAN_MS = 5 * 60_000;
/** Reminders are minute-precise, so they get their own, lighter scan. */
const REMIND_MS = 60_000;

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
 *
 * Reminders: every minute, tasks with a start or due time whose reminder window (the webhook's
 * `remindMinutes` before that moment) is open. Deduped on task + moment, so a new time re-arms it.
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private remindTimer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private running = false;
  private reminding = false;

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
    this.remindTimer = setInterval(() => void this.runReminders(), REMIND_MS);
    this.remindTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.remindTimer) clearInterval(this.remindTimer);
    if (this.first) clearTimeout(this.first);
  }

  private async runReminders() {
    if (this.reminding) return;
    this.reminding = true;
    try {
      await this.reminders();
    } catch (e) {
      console.error('[webhooks] reminder scan failed', e instanceof Error ? e.message : e);
    } finally {
      this.reminding = false;
    }
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
    const perClock = new Map<string, ReturnType<typeof scheduleAlerts>>();
    for (const hook of hooks) {
      const clock = nowIn(hook.timezone, now);
      const today = clock.date;
      const key = `${clock.date} ${clock.minutes}`;
      if (!perClock.has(key)) perClock.set(key, scheduleAlerts(items, deps, today, clock));
      const wanted = new Set(hook.events as string[]);
      const values = perClock
        .get(key)!
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

  /** Reminder pass. Returns how many deliveries were queued. */
  async reminders(now: Date = new Date(), onlyWorkspaceId?: string): Promise<number> {
    const all = await this.db
      .select()
      .from(webhooks)
      .where(onlyWorkspaceId ? and(eq(webhooks.enabled, true), eq(webhooks.workspaceId, onlyWorkspaceId)) : eq(webhooks.enabled, true));
    const hooks = all.filter((h) => (h.events as string[]).some(isReminderEvent));
    const byWorkspace = new Map<string, WebhookRow[]>();
    for (const h of hooks) byWorkspace.set(h.workspaceId, [...(byWorkspace.get(h.workspaceId) ?? []), h]);
    let queued = 0;
    for (const [workspaceId, list] of byWorkspace) queued += await this.remindWorkspace(workspaceId, list, now);
    if (queued) this.delivery.nudge();
    return queued;
  }

  private async remindWorkspace(workspaceId: string, hooks: WebhookRow[], now: Date): Promise<number> {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) return 0;
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          inArray(tasks.status, ['todo', 'doing']),
          or(isNotNull(tasks.startTime), isNotNull(tasks.dueTime)),
        ),
      );
    const visible = ws.kind === 'org' ? rows.filter((t) => t.projectId) : rows;
    if (!visible.length) return 0;
    const byId = new Map<string, TaskRow>(visible.map((t) => [t.id, t]));
    const items = visible.map(toPlanItem);
    let names: Awaited<ReturnType<typeof nameLookup>> | null = null;

    let queued = 0;
    for (const hook of hooks) {
      const clock = nowIn(hook.timezone, now);
      const keys = (hook.events as string[]).filter(isReminderEvent) as ReminderEventKey[];
      const due = reminderAlerts(items, clock, hook.remindMinutes, keys).filter((r) =>
        inScope(hook, r.key as WebhookEventKey, byId.get(r.taskId)?.projectId ?? null),
      );
      if (!due.length) continue;
      names ??= await nameLookup(this.db, {
        projects: visible.map((t) => t.projectId),
        users: visible.map((t) => t.assigneeId),
      });
      const values = due.map((r) => {
        const t = byId.get(r.taskId)!;
        const ref = taskRef(t, names!);
        const base = { actor: null, subject: `${ref.ref} ${t.title}`, summary: reminderSummary(r, clock.date) };
        const payload: WebhookPayload = {
          id: randomUUID(),
          event: r.key,
          createdAt: now.toISOString(),
          workspace: { id: ws.id, name: ws.name, kind: ws.kind },
          ...base,
          text: webhookText(base),
          url: ref.url,
          task: ref,
          alert: { date: clock.date, at: `${r.date}T${r.time}`, minutesLeft: r.minutesLeft },
        };
        return { webhookId: hook.id, event: r.key, dedupeKey: `${r.key}:${r.taskId}:${r.date}T${r.time}`, payload };
      });
      const inserted = await this.db
        .insert(webhookDeliveries)
        .values(values)
        .onConflictDoNothing({ target: [webhookDeliveries.webhookId, webhookDeliveries.dedupeKey] })
        .returning({ id: webhookDeliveries.id });
      queued += inserted.length;
    }
    return queued;
  }
}
