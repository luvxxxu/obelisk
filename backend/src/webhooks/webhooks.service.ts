import { BadRequestException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_REMIND_MINUTES,
  describeActivity,
  detectWebhookFormat,
  webhookEventFor,
  webhookText,
  type CreateWebhookInput,
  type Priority,
  type UpdateWebhookInput,
  type Webhook,
  type WebhookDelivery,
  type WebhookEventKey,
  type WebhookPayload,
  type WebhookTaskRef,
} from '@obelisk/core';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomToken } from '../common/crypto';
import { seal } from '../common/secret';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import {
  projects,
  tasks,
  users,
  webhookDeliveries,
  webhooks,
  workspaces,
  type ActivityRow,
  type TaskRow,
  type WebhookDeliveryRow,
  type WebhookRow,
  type WorkspaceRow,
} from '../db/schema';
import type { Access, Conn } from '../workspace/access.service';
import { ActivityService } from '../workspace/activity.service';
import { DeliveryService, secretContext } from './delivery.service';
import { assertDeliverable, UndeliverableError } from './net';

const CACHE_MS = 15_000;

export const taskUrl = (id: string) => `${config.publicUrl}/t/${id}`;
export const projectUrl = (id: string) => `${config.publicUrl}/projects/${id}`;

export function toDelivery(r: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: r.id,
    webhookId: r.webhookId,
    event: r.event,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    nextAttemptAt: r.status === 'pending' ? r.nextAttemptAt.toISOString() : null,
    lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
    responseStatus: r.responseStatus,
    responseBody: r.responseBody,
    error: r.error,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
    payload: r.payload,
  };
}

/** Task → payload shape, given names for its project and assignee. */
export function taskRef(t: TaskRow, names: (id: string | null) => string | null): WebhookTaskRef {
  const projectName = names(t.projectId);
  const assigneeName = names(t.assigneeId);
  return {
    id: t.id,
    ref: `#${t.number}`,
    number: t.number,
    title: t.title,
    status: t.status,
    priority: t.priority as Priority,
    startDate: t.startDate,
    startTime: t.startDate ? t.startTime : null,
    dueDate: t.dueDate,
    dueTime: t.dueDate ? t.dueTime : null,
    fixed: t.fixed,
    project: t.projectId && projectName ? { id: t.projectId, name: projectName } : null,
    assignee: t.assigneeId && assigneeName ? { id: t.assigneeId, name: assigneeName } : null,
    url: taskUrl(t.id),
  };
}

export async function nameLookup(conn: Conn, ids: { projects?: (string | null)[]; users?: (string | null)[] }) {
  const pIds = [...new Set((ids.projects ?? []).filter((x): x is string => !!x))];
  const uIds = [...new Set((ids.users ?? []).filter((x): x is string => !!x))];
  const [ps, us] = await Promise.all([
    pIds.length ? conn.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, pIds)) : [],
    uIds.length ? conn.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uIds)) : [],
  ]);
  const map = new Map<string, string>([...ps, ...us].map((r) => [r.id, r.name]));
  return (id: string | null) => (id ? (map.get(id) ?? null) : null);
}

/** Does an event about `projectId` pass a webhook's project filter? Organization events always do. */
export function inScope(h: Pick<WebhookRow, 'projectIds'>, key: WebhookEventKey, projectId: string | null): boolean {
  if (!h.projectIds) return true;
  if (key === 'organization') return true;
  return !!projectId && h.projectIds.includes(projectId);
}

@Injectable()
export class WebhooksService implements OnModuleInit {
  private cache = new Map<string, { at: number; hooks: WebhookRow[] }>();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly activity: ActivityService,
    private readonly delivery: DeliveryService,
  ) {}

  onModuleInit() {
    this.activity.onRecord((conn, row) => this.enqueueActivity(conn, row));
  }

  // ───────────────────────────── outbox

  private async hooksFor(workspaceId: string): Promise<WebhookRow[]> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.hooks;
    const hooks = await this.db.select().from(webhooks).where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.enabled, true)));
    this.cache.set(workspaceId, { at: Date.now(), hooks });
    if (this.cache.size > 5000) this.cache.clear();
    return hooks;
  }

  private forget(workspaceId: string) {
    this.cache.delete(workspaceId);
  }

  /**
   * Called inside the transaction that recorded the activity, so a change that rolls back sends
   * nothing. Queuing runs in a savepoint: if it fails, the user's change still goes through.
   */
  private async enqueueActivity(conn: Conn, row: ActivityRow) {
    const mapped = webhookEventFor(row.action, row.data);
    if (!mapped) return;
    const hooks = (await this.hooksFor(row.workspaceId)).filter(
      (h) => (h.events as string[]).includes(mapped.key) && inScope(h, mapped.key, row.projectId),
    );
    if (!hooks.length) return;
    try {
      await conn.transaction(async (sp) => {
        const ws = await sp.query.workspaces.findFirst({ where: eq(workspaces.id, row.workspaceId) });
        if (!ws) return;
        // Tasks outside any project are private in an organization (creator and assignee only).
        if (ws.kind === 'org' && row.taskId && !row.projectId) return;
        const payload = await this.activityPayload(sp, ws, row, mapped.event);
        await sp.insert(webhookDeliveries).values(hooks.map((h) => ({ webhookId: h.id, event: mapped.event, payload })));
      });
      this.delivery.nudge();
    } catch (e) {
      console.error('[webhooks] could not queue an event', e instanceof Error ? e.message : e);
    }
  }

  private async activityPayload(conn: Conn, ws: WorkspaceRow, row: ActivityRow, event: string): Promise<WebhookPayload> {
    let task: WebhookTaskRef | null | undefined;
    let project: WebhookPayload['project'];
    let url: string | null = null;
    if (row.taskId) {
      const t = await conn.query.tasks.findFirst({ where: eq(tasks.id, row.taskId) });
      if (t) {
        task = taskRef(t, await nameLookup(conn, { projects: [t.projectId], users: [t.assigneeId] }));
        url = task.url;
      } else task = null;
    } else if (row.projectId) {
      const p = await conn.query.projects.findFirst({ where: eq(projects.id, row.projectId) });
      // A project moved to another space or deleted has no page here any more.
      const here = p && p.workspaceId === ws.id;
      project = { id: row.projectId, name: p?.name ?? row.subject, url: here ? projectUrl(p.id) : null };
      url = project.url;
    }
    const data = row.data ?? {};
    const base = {
      actor: { id: row.actorId, name: row.actorName, via: row.via, client: row.client },
      subject: row.subject,
      summary: describeActivity({ action: row.action, data, subject: row.subject }),
    };
    return {
      id: row.id,
      event,
      createdAt: row.createdAt.toISOString(),
      workspace: { id: ws.id, name: ws.name, kind: ws.kind },
      ...base,
      text: webhookText(base),
      url,
      ...(task !== undefined ? { task } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(data.changes ? { changes: data.changes as Record<string, unknown> } : {}),
      data,
    };
  }

  // ───────────────────────────── management

  private async row(a: Access, id: string): Promise<WebhookRow> {
    const row = await this.db.query.webhooks.findFirst({ where: and(eq(webhooks.id, id), eq(webhooks.workspaceId, a.workspaceId)) });
    if (!row) throw new NotFoundException('웹훅을 찾을 수 없습니다');
    return row;
  }

  async list(a: Access): Promise<Webhook[]> {
    const rows = await this.db
      .select({ hook: webhooks, creator: users.name })
      .from(webhooks)
      .leftJoin(users, eq(users.id, webhooks.createdBy))
      .where(eq(webhooks.workspaceId, a.workspaceId))
      .orderBy(webhooks.createdAt);
    if (!rows.length) return [];
    const last = await this.db
      .selectDistinctOn([webhookDeliveries.webhookId], {
        webhookId: webhookDeliveries.webhookId,
        status: webhookDeliveries.status,
        createdAt: webhookDeliveries.createdAt,
        lastAttemptAt: webhookDeliveries.lastAttemptAt,
        responseStatus: webhookDeliveries.responseStatus,
      })
      .from(webhookDeliveries)
      .where(
        inArray(
          webhookDeliveries.webhookId,
          rows.map((r) => r.hook.id),
        ),
      )
      .orderBy(webhookDeliveries.webhookId, desc(webhookDeliveries.createdAt));
    const lastBy = new Map(last.map((l) => [l.webhookId, l]));
    return rows.map(({ hook, creator }) => this.toWebhook(hook, creator, lastBy.get(hook.id)));
  }

  private toWebhook(
    h: WebhookRow,
    creator: string | null,
    last?: { status: WebhookDeliveryRow['status']; createdAt: Date; lastAttemptAt: Date | null; responseStatus: number | null },
  ): Webhook {
    return {
      id: h.id,
      name: h.name,
      url: h.url,
      format: h.format,
      events: h.events as WebhookEventKey[],
      projectIds: h.projectIds ?? null,
      alertHour: h.alertHour,
      remindMinutes: h.remindMinutes,
      timezone: h.timezone,
      enabled: h.enabled,
      disabledReason: h.disabledReason,
      failureCount: h.failureCount,
      lastDelivery: last
        ? { status: last.status, at: (last.lastAttemptAt ?? last.createdAt).toISOString(), responseStatus: last.responseStatus }
        : null,
      createdBy: h.createdBy && creator ? { id: h.createdBy, name: creator } : null,
      createdAt: h.createdAt.toISOString(),
      updatedAt: h.updatedAt.toISOString(),
    };
  }

  /** Refuse private/loopback targets and hosts that don't resolve (usually a typo) up front. */
  private async checkUrl(url: string) {
    try {
      await assertDeliverable(url, config.webhookAllowPrivate);
    } catch (e) {
      if (e instanceof UndeliverableError) throw new BadRequestException(e.retryable ? `${e.message}. 주소를 확인하세요` : e.message);
      throw e;
    }
  }

  private async checkProjects(a: Access, ids: string[] | null | undefined) {
    if (!ids) return;
    const found = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.workspaceId, a.workspaceId), inArray(projects.id, ids)));
    if (found.length !== new Set(ids).size) throw new BadRequestException('이 공간에 없는 프로젝트가 포함되어 있습니다');
  }

  async create(a: Access, input: CreateWebhookInput): Promise<{ webhook: Webhook; secret: string }> {
    await this.checkUrl(input.url);
    await this.checkProjects(a, input.projectIds);
    const id = randomUUID();
    const secret = randomToken('whsec', 24);
    const [row] = await this.db
      .insert(webhooks)
      .values({
        id,
        workspaceId: a.workspaceId,
        createdBy: a.userId,
        name: input.name,
        url: input.url,
        format: input.format ?? detectWebhookFormat(input.url),
        events: input.events,
        projectIds: input.projectIds ? [...new Set(input.projectIds)] : null,
        alertHour: input.alertHour ?? 9,
        remindMinutes: input.remindMinutes ?? DEFAULT_REMIND_MINUTES,
        timezone: a.user.timezone,
        secret: seal(secret, secretContext(id)),
        enabled: input.enabled ?? true,
      })
      .returning();
    this.forget(a.workspaceId);
    return { webhook: this.toWebhook(row!, a.user.name), secret };
  }

  async update(a: Access, id: string, input: UpdateWebhookInput): Promise<Webhook> {
    const cur = await this.row(a, id);
    if (input.url !== undefined && input.url !== cur.url) await this.checkUrl(input.url);
    if (input.projectIds !== undefined) await this.checkProjects(a, input.projectIds);
    const set: Partial<WebhookRow> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name;
    if (input.url !== undefined) set.url = input.url;
    if (input.format !== undefined) set.format = input.format;
    else if (input.url !== undefined && input.url !== cur.url && cur.format === detectWebhookFormat(cur.url)) {
      set.format = detectWebhookFormat(input.url);
    }
    if (input.events !== undefined) set.events = input.events;
    if (input.projectIds !== undefined) set.projectIds = input.projectIds ? [...new Set(input.projectIds)] : null;
    // Alert hours and reminders are read on the clock of whoever set them last.
    if (input.alertHour !== undefined && input.alertHour !== cur.alertHour) {
      set.alertHour = input.alertHour;
      set.timezone = a.user.timezone;
    }
    if (input.remindMinutes !== undefined && input.remindMinutes !== cur.remindMinutes) {
      set.remindMinutes = input.remindMinutes;
      set.timezone = a.user.timezone;
    }
    if (input.enabled !== undefined && input.enabled !== cur.enabled) {
      set.enabled = input.enabled;
      if (input.enabled) {
        set.disabledReason = null;
        set.failureCount = 0;
      }
    }
    const [row] = await this.db.update(webhooks).set(set).where(eq(webhooks.id, id)).returning();
    this.forget(a.workspaceId);
    const creator = row!.createdBy ? await this.db.query.users.findFirst({ where: eq(users.id, row!.createdBy) }) : null;
    const [last] = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(1);
    return this.toWebhook(row!, creator?.name ?? null, last);
  }

  async remove(a: Access, id: string) {
    await this.row(a, id);
    await this.db.delete(webhooks).where(eq(webhooks.id, id));
    this.forget(a.workspaceId);
    return { ok: true };
  }

  async rotateSecret(a: Access, id: string): Promise<{ secret: string }> {
    await this.row(a, id);
    const secret = randomToken('whsec', 24);
    await this.db.update(webhooks).set({ secret: seal(secret, secretContext(id)), updatedAt: new Date() }).where(eq(webhooks.id, id));
    return { secret };
  }

  async deliveries(a: Access, id: string, limit = 50): Promise<WebhookDelivery[]> {
    await this.row(a, id);
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(toDelivery);
  }

  /** Send now and wait for the answer (test and manual redelivery: one try, not retried). */
  private async sendNow(hook: WebhookRow, event: string, payload: WebhookPayload): Promise<WebhookDelivery> {
    const [queued] = await this.db
      .insert(webhookDeliveries)
      .values({ webhookId: hook.id, event, payload, maxAttempts: 1, nextAttemptAt: new Date(Date.now() + 10 * 60_000) })
      .returning();
    return toDelivery(await this.delivery.attempt(hook, queued!, { force: true }));
  }

  async test(a: Access, id: string): Promise<WebhookDelivery> {
    const hook = await this.row(a, id);
    const base = {
      actor: { id: a.userId, name: a.user.name, via: 'session' as const, client: null },
      subject: '',
      summary: `웹훅 “${hook.name}” 연결을 확인했어요`,
    };
    const payload: WebhookPayload = {
      id: randomUUID(),
      event: 'ping',
      createdAt: new Date().toISOString(),
      workspace: { id: a.workspaceId, name: a.workspace.name, kind: a.kind },
      ...base,
      text: webhookText(base),
      url: null,
    };
    return this.sendNow(hook, 'ping', payload);
  }

  async redeliver(a: Access, id: string, deliveryId: string): Promise<WebhookDelivery> {
    const hook = await this.row(a, id);
    const d = await this.db.query.webhookDeliveries.findFirst({
      where: and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id)),
    });
    if (!d) throw new NotFoundException('전달 기록을 찾을 수 없습니다');
    return this.sendNow(hook, d.event, d.payload);
  }
}
