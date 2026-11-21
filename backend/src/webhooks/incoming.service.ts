import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import {
  atLeast,
  changePhrases,
  createTaskInput,
  formatShortKo,
  formatTimeKo,
  matchProject,
  nowIn,
  parseIncoming,
  updateTaskInput,
  type CreateIncomingWebhookInput,
  type IncomingWebhook,
  type Task,
  type UpdateIncomingWebhookInput,
} from '@obelisk/core';
import { and, eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth.service';
import { randomToken, sha256 } from '../common/crypto';
import { parse } from '../common/validation';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { incomingWebhooks, projects, users, type IncomingWebhookRow } from '../db/schema';
import { ProjectsService } from '../planner/projects.service';
import { TasksService } from '../planner/tasks.service';
import { AccessService, type Access } from '../workspace/access.service';
import { WorkspacesService } from '../workspace/workspaces.service';
import { taskUrl } from './webhooks.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const incomingUrl = (token: string) => `${config.publicUrl}/api/hooks/${token}`;

export interface IncomingResult {
  ok: true;
  action: 'created' | 'updated';
  task: {
    id: string;
    ref: string;
    title: string;
    status: Task['status'];
    priority: Task['priority'];
    startDate: string | null;
    startTime: string | null;
    dueDate: string | null;
    dueTime: string | null;
    projectId: string | null;
    url: string;
  };
  /** One readable line, so a Slack slash command shows something sensible. */
  text: string;
}

function present(t: Task) {
  return {
    id: t.id,
    ref: `#${t.number}`,
    title: t.title,
    status: t.status,
    priority: t.priority,
    startDate: t.startDate,
    startTime: t.startTime,
    dueDate: t.dueDate,
    dueTime: t.dueTime,
    projectId: t.projectId,
    url: taskUrl(t.id),
  };
}

function toIncoming(r: IncomingWebhookRow, creator: string | null): IncomingWebhook {
  return {
    id: r.id,
    name: r.name,
    hint: r.hint,
    projectId: r.projectId,
    allowUpdates: r.allowUpdates,
    useCount: r.useCount,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
    createdBy: creator ? { id: r.createdBy, name: creator } : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Incoming webhooks: a secret URL that runs one create or update per request as the person who
 * made it, with their permissions at that moment. Every change lands in the activity log as
 * "웹훅 “이름” 통해", so it can also fire outgoing webhooks.
 */
@Injectable()
export class IncomingService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  // ───────────────────────────── management

  private async row(a: Access, id: string): Promise<IncomingWebhookRow> {
    const row = await this.db.query.incomingWebhooks.findFirst({
      where: and(eq(incomingWebhooks.id, id), eq(incomingWebhooks.workspaceId, a.workspaceId)),
    });
    if (!row) throw new NotFoundException('받는 웹훅을 찾을 수 없습니다');
    return row;
  }

  private async checkProject(a: Access, projectId: string | null | undefined) {
    if (!projectId) return;
    const p = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.workspaceId, a.workspaceId)),
    });
    if (!p) throw new BadRequestException('이 공간에 없는 프로젝트입니다');
    a.assertProject(p.id, 'edit', p.name);
  }

  async list(a: Access): Promise<IncomingWebhook[]> {
    const rows = await this.db
      .select({ hook: incomingWebhooks, creator: users.name })
      .from(incomingWebhooks)
      .leftJoin(users, eq(users.id, incomingWebhooks.createdBy))
      .where(eq(incomingWebhooks.workspaceId, a.workspaceId))
      .orderBy(incomingWebhooks.createdAt);
    return rows.map((r) => toIncoming(r.hook, r.creator));
  }

  async create(a: Access, input: CreateIncomingWebhookInput): Promise<{ incoming: IncomingWebhook; url: string }> {
    await this.checkProject(a, input.projectId);
    const token = randomToken('obh', 24);
    const [row] = await this.db
      .insert(incomingWebhooks)
      .values({
        workspaceId: a.workspaceId,
        createdBy: a.userId,
        name: input.name,
        tokenHash: sha256(token),
        hint: token.slice(-4),
        projectId: input.projectId ?? null,
        allowUpdates: input.allowUpdates ?? true,
      })
      .returning();
    return { incoming: toIncoming(row!, a.user.name), url: incomingUrl(token) };
  }

  async update(a: Access, id: string, input: UpdateIncomingWebhookInput): Promise<IncomingWebhook> {
    const cur = await this.row(a, id);
    if (input.projectId !== undefined && input.projectId !== cur.projectId) await this.checkProject(a, input.projectId);
    const set: Partial<IncomingWebhookRow> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.projectId !== undefined) set.projectId = input.projectId;
    if (input.allowUpdates !== undefined) set.allowUpdates = input.allowUpdates;
    const [row] = Object.keys(set).length
      ? await this.db.update(incomingWebhooks).set(set).where(eq(incomingWebhooks.id, id)).returning()
      : [cur];
    const creator = await this.db.query.users.findFirst({ where: eq(users.id, row!.createdBy) });
    return toIncoming(row!, creator?.name ?? null);
  }

  async remove(a: Access, id: string) {
    await this.row(a, id);
    await this.db.delete(incomingWebhooks).where(eq(incomingWebhooks.id, id));
    return { ok: true };
  }

  /** New secret URL; the old one stops working at once. */
  async rotate(a: Access, id: string): Promise<{ url: string }> {
    await this.row(a, id);
    const token = randomToken('obh', 24);
    await this.db.update(incomingWebhooks).set({ tokenHash: sha256(token), hint: token.slice(-4) }).where(eq(incomingWebhooks.id, id));
    return { url: incomingUrl(token) };
  }

  // ───────────────────────────── receiving

  async handle(token: string, body: unknown): Promise<IncomingResult> {
    const hook = token.startsWith('obh_')
      ? await this.db.query.incomingWebhooks.findFirst({ where: eq(incomingWebhooks.tokenHash, sha256(token)) })
      : undefined;
    if (!hook) throw new NotFoundException('웹훅 주소가 올바르지 않거나 삭제되었습니다');
    try {
      const result = await this.run(hook, body);
      await this.db
        .update(incomingWebhooks)
        .set({ lastUsedAt: new Date(), useCount: sql`${incomingWebhooks.useCount} + 1`, lastError: null, lastErrorAt: null })
        .where(eq(incomingWebhooks.id, hook.id));
      return result;
    } catch (e) {
      const message = e instanceof HttpException ? (e.message as string) : '요청을 처리하지 못했습니다';
      await this.db
        .update(incomingWebhooks)
        .set({ lastUsedAt: new Date(), lastError: message.slice(0, 500), lastErrorAt: new Date() })
        .where(eq(incomingWebhooks.id, hook.id))
        .catch(() => {});
      throw e;
    }
  }

  private async actAs(hook: IncomingWebhookRow): Promise<Access> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, hook.createdBy) });
    if (!user) throw new ForbiddenException('웹훅을 만든 사람의 계정이 없어 실행할 수 없습니다');
    if (user.suspendedAt) throw new ForbiddenException('웹훅을 만든 사람의 계정이 정지되어 실행할 수 없습니다');
    const auth: AuthContext = { user, via: 'webhook', credentialId: hook.id, client: hook.name };
    try {
      return await this.access.forWorkspace(auth, hook.workspaceId);
    } catch {
      throw new ForbiddenException('웹훅을 만든 사람이 더 이상 이 공간의 멤버가 아니라서 실행할 수 없습니다');
    }
  }

  private async run(hook: IncomingWebhookRow, body: unknown): Promise<IncomingResult> {
    const a = await this.actAs(hook);
    const clock = nowIn(a.user.timezone);
    const parsed = parseIncoming(body, clock.date, { timeZone: a.user.timezone, nowMinutes: clock.minutes });
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    const cmd = parsed.command;

    if (cmd.kind === 'create') {
      const projectId = cmd.project ? await this.findProject(a, cmd.project) : hook.projectId;
      const assigneeIds = cmd.assignees ? await Promise.all(cmd.assignees.map((ref) => this.findMember(a, ref))) : undefined;
      const input = parse(createTaskInput, {
        title: cmd.title,
        notes: cmd.notes,
        status: cmd.status,
        priority: cmd.priority,
        startDate: cmd.startDate,
        startTime: cmd.startTime,
        dueDate: cmd.dueDate,
        dueTime: cmd.dueTime,
        fixed: cmd.fixed,
        projectId,
        assigneeIds,
      });
      const task = await this.tasks.create(a, input);
      const due = task.dueDate ? ` · 마감 ${formatShortKo(task.dueDate)}${task.dueTime ? ` ${formatTimeKo(task.dueTime)}` : ''}` : '';
      return { ok: true, action: 'created', task: present(task), text: `새 작업 #${task.number} ${task.title}${due}` };
    }

    if (!hook.allowUpdates) throw new ForbiddenException('이 웹훅은 새 작업 만들기만 할 수 있습니다 (기존 작업 수정이 꺼져 있음)');
    const target = await this.tasks.resolve(a, cmd.task);
    if (hook.projectId && target.projectId !== hook.projectId) {
      throw new ForbiddenException(`#${target.number}은(는) 이 웹훅에 지정된 프로젝트의 작업이 아니라서 바꿀 수 없습니다`);
    }
    const patch = parse(updateTaskInput, cmd.patch);
    const updated = await this.tasks.update(a, target.id, patch);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['title', 'status', 'priority', 'startDate', 'startTime', 'dueDate', 'dueTime', 'fixed'] as const) {
      if ((k in patch || (k === 'startTime' && 'startDate' in patch) || (k === 'dueTime' && 'dueDate' in patch)) && JSON.stringify(target[k]) !== JSON.stringify(updated[k])) changes[k] = { from: target[k], to: updated[k] };
    }
    if (patch.notes !== undefined && patch.notes !== target.notes) (changes as Record<string, unknown>).notes = true;
    const what = changePhrases(changes).join(' · ') || '바뀐 내용 없음';
    return { ok: true, action: 'updated', task: present(updated), text: `#${updated.number} ${updated.title} — ${what}` };
  }

  /** A project name (loose match) or id, among projects the caller can write to. */
  private async findProject(a: Access, ref: string): Promise<string> {
    const list = (await this.projects.list(a)).filter((p) => !p.archivedAt && atLeast(p.access, 'edit'));
    const hit = UUID_RE.test(ref) ? list.find((p) => p.id === ref) : matchProject(list, ref);
    if (!hit) throw new BadRequestException(`쓰기 권한이 있는 프로젝트 중 "${ref}"을(를) 찾을 수 없습니다`);
    return hit.id;
  }

  /** "me", a user id, an email or an exact name among the workspace's members. */
  private async findMember(a: Access, ref: string): Promise<string> {
    const s = ref.trim();
    if (/^(me|나|본인)$/i.test(s)) return a.userId;
    const members = await this.workspaces.members(a.workspaceId);
    const lower = s.toLowerCase();
    const byName = members.filter((m) => m.name.toLowerCase() === lower);
    const hit = members.find((m) => m.id === s) ?? members.find((m) => m.email.toLowerCase() === lower) ?? (byName.length === 1 ? byName[0] : undefined);
    if (!hit) throw new BadRequestException(`담당자 "${s}"을(를) 이 공간의 멤버에서 찾을 수 없습니다 (이메일로 지정하면 정확해요)`);
    return hit.id;
  }
}
