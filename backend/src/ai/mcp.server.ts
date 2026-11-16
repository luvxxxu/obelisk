/**
 * Obelisk MCP server. One stateless McpServer per request, bound to the
 * authenticated user. Every feature of the app is reachable from here.
 *
 * Presentation: each tool returns structured data plus Linear-style markdown
 * (present.ts). Reading/planning tools also point at an MCP Apps view
 * (widget/), so Claude and ChatGPT render the result as an interactive card.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HttpException } from '@nestjs/common';
import {
  addDays,
  canEditTask,
  describeActivity,
  formatDaysKo,
  isoDate,
  isOverdue,
  PRIORITY_NAME,
  PROJECT_COLORS,
  selectView,
  todayIn,
  VIEW_NAMES,
  type Dependency,
  type ImpactReport,
  type ImpactSummary,
  type Member,
  type Priority,
  type Project,
  type Task,
} from '@obelisk/core';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.service';
import { config } from '../config';
import type { ImpactService } from '../planner/impact.service';
import type { ProjectsService } from '../planner/projects.service';
import type { TasksService } from '../planner/tasks.service';
import type { Access, AccessService } from '../workspace/access.service';
import type { ActivityService } from '../workspace/activity.service';
import type { WorkspacesService } from '../workspace/workspaces.service';
import {
  esc,
  eulReul,
  impactPhrase,
  mdBottlenecks,
  mdCompleted,
  mdActivity,
  mdCreatedMany,
  mdImpact,
  mdMembers,
  mdOverview,
  mdProjects,
  mdTaskDetail,
  mdTaskList,
  mdWorkspaces,
  type ActivityOut,
  type BottleneckOut,
  type ImpactOut,
  type LinkOut,
  type MemberOut,
  type ProjectOut,
  type TaskOut,
  type WorkspaceOut,
  activityOut,
} from './present';
import {
  isWidgetView,
  UI_MIME_TYPE,
  WIDGET_VIEWS,
  widgetHtml,
  widgetResourceMeta,
  widgetTitle,
  widgetToolMeta,
  widgetUri,
  type WidgetView,
} from './widget';

export interface McpDeps {
  tasks: TasksService;
  projects: ProjectsService;
  impact: ImpactService;
  access: AccessService;
  workspaces: WorkspacesService;
  activity: ActivityService;
}

const INSTRUCTIONS = `Obelisk is the user's to-do and schedule planner — for themselves and for the organizations they belong to.

Workspaces and permissions
- The user has a personal space and may belong to organizations (list_workspaces). Every tool takes an optional "workspace" (name or id); without it, the user's default workspace is used. Task refs like "#12" are numbered per workspace, so keep using the same workspace for a ref you got from it.
- This connection acts as the user and has exactly their permissions. In an organization they may see only some projects, and some of those read-only (view < edit < manage). Tasks marked readOnly can't be changed; a write that isn't allowed fails with a permission error — tell the user who could grant access (a project manager or an org admin) instead of retrying another way. Sharing and membership are managed in the web app, not here.
- Tasks can have an assignee (a workspace member; "me" for the user). list_members shows who can be assigned; list_tasks assignee="me" lists the user's own work. get_activity shows who changed what.

Concepts
- Tasks have a short ref like "#12" (preferred when talking to the user), a status (todo, doing, done, canceled), a priority (none/low/medium/high), an optional project, and optional startDate/dueDate (YYYY-MM-DD, in the user's timezone; "today" is returned by get_overview).
- Dependencies: a task can be "blocked by" other tasks (finish-to-start). This is what powers delay prediction.
- Fixed tasks (fixed=true) are immovable commitments such as meetings or hard deadlines. They never shift; a delay that reaches them is reported as a conflict.

Signature feature: delay impact prediction
- Before postponing anything that other tasks depend on, call simulate_delay and tell the user which tasks would slip, by how much, and which fixed dates would break. Then ask whether to cascade.
- postpone_task applies the move. cascade=true also shifts every pushed task; cascade=false moves only that task (dependents may then start before it finishes).
- get_forecast shows what is already slipping because overdue tasks can only finish today at the earliest. get_bottlenecks ranks the tasks the plan depends on most.

Good habits
- Start with get_overview when the user asks about their day/week.
- Use create_tasks (with keys + blockedBy) to turn a goal into an ordered plan in one call.
- Refer to tasks as "#12 Title". Accept task refs as "#12", "12", an id, or a unique title fragment.
- Confirm before delete_task/delete_project.
- In an organization, say which workspace you are working in when it isn't obvious.`;

const PRESENT_CARDS = `

Presentation (this app shows Obelisk cards)
- Reading and planning tools appear to the user as an interactive Obelisk card in the Linear style: task lists, a task card, a delay-impact timeline, bottlenecks, projects. The user already sees every task, date and number in it.
- So do not repeat a card as a list or table. Reply in 1–2 short sentences: what matters most (the one thing to do first, a risk) and, if useful, one question. Name a task as "#12 Title" only when you single it out.
- The user can tick tasks done and apply a simulated postponement right in the card; you are told when they do. When you postpone on your own, still ask about cascading first.`;

const PRESENT_TEXT = `

Presentation
- Chat apps (Claude and ChatGPT on web, desktop and mobile) show reading and planning results to the user as an interactive Obelisk card: summary numbers, then tasks by day and priority, or a delay timeline. There, do not repeat the card as a list or table. Reply in 1–2 short sentences with what matters most (the one thing to do first, a risk) and at most one question. Name a task as "#12 Title" only when you single it out.
- Coding agents and terminals (Claude Code, Codex) have no cards. There, show results in Obelisk's markdown style: a one-line summary, then tasks grouped by day, most important first — ○ todo · ◐ in progress · ✓ done, refs in code (\`#12\`), "·"-separated meta. Tool results already come in this style; reuse the lines, trimmed to what matters. Labels are Korean; translate them if the user writes in another language.`;

const priorityIn = z
  .enum(['none', 'low', 'medium', 'high'])
  .describe('Task priority');
const PRIORITY_VALUE: Record<z.infer<typeof priorityIn>, Priority> = { none: 0, low: 1, medium: 2, high: 3 };
const ref = z.string().min(1).describe('Task ref: "#12", "12", a task id, or a unique part of the title');
const projectRef = z.string().min(1).describe('Project name or id');
const assigneeRef = z.string().min(1).describe('Assignee: "me", or a workspace member\'s name or email');
const workspaceArg = z
  .string()
  .min(1)
  .optional()
  .describe('Workspace name or id (see list_workspaces). Omit for the default workspace.');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nullableDate = isoDate.nullable();

/** Per-workspace state for one MCP request: the caller's access plus small caches. */
class Ctx {
  readonly today: string;
  private projectMap?: Map<string, Project>;
  private deps?: Dependency[];
  private memberList?: Member[];
  private taskById = new Map<string, Task>();

  constructor(
    readonly a: Access,
    readonly s: McpDeps,
  ) {
    this.today = todayIn(a.user.timezone);
  }

  get userId() {
    return this.a.userId;
  }

  get workspaceName() {
    return this.a.kind === 'personal' ? '개인 공간' : this.a.workspace.name;
  }

  async projects() {
    if (!this.projectMap) {
      const list = await this.s.projects.list(this.a, { includeArchived: true });
      this.projectMap = new Map(list.map((p) => [p.id, p]));
    }
    return this.projectMap;
  }

  async dependencies() {
    if (!this.deps) this.deps = await this.s.tasks.dependencies(this.a);
    return this.deps;
  }

  async members() {
    if (!this.memberList) this.memberList = await this.s.workspaces.members(this.a.workspaceId);
    return this.memberList;
  }

  async memberName(id: string | null): Promise<string | null> {
    if (!id) return null;
    return (await this.members()).find((m) => m.id === id)?.name ?? null;
  }

  /** "me", an email, an exact name or a unique part of one → user id. null / "none" clears. */
  async resolveAssignee(ref: string | null | undefined): Promise<string | null | undefined> {
    if (ref === undefined) return undefined;
    const s = (ref ?? '').trim();
    if (!s || /^(none|null|unassigned|없음)$/i.test(s)) return null;
    if (/^(me|나|본인)$/i.test(s)) return this.userId;
    const list = await this.members();
    const lower = s.toLowerCase();
    const hit =
      list.find((m) => m.email.toLowerCase() === lower) ??
      list.find((m) => m.name.toLowerCase() === lower) ??
      (() => {
        const partial = list.filter((m) => m.name.toLowerCase().includes(lower));
        return partial.length === 1 ? partial[0] : undefined;
      })();
    if (!hit) {
      throw new ToolError(
        `No member "${s}" in ${this.workspaceName}. Members: ${list.map((m) => m.name).join(', ')}. Use list_members.`,
      );
    }
    return hit.id;
  }

  remember(tasks: Task[]) {
    for (const t of tasks) this.taskById.set(t.id, t);
  }

  private async lookup(id: string): Promise<Task | null> {
    if (!this.taskById.has(id)) {
      try {
        this.taskById.set(id, await this.s.tasks.get(this.a, id));
      } catch {
        return null;
      }
    }
    return this.taskById.get(id)!;
  }

  async refOf(id: string): Promise<string> {
    const t = await this.lookup(id);
    return t ? `#${t.number}` : id;
  }

  async link(id: string): Promise<LinkOut> {
    const t = await this.lookup(id);
    return t ? { ref: `#${t.number}`, id: t.id, title: t.title, status: t.status } : { ref: id, id, title: '(삭제됨)', status: 'canceled' };
  }

  async projectName(projectId: string | null | undefined): Promise<string | null> {
    if (projectId === undefined) return null;
    if (projectId === null) return '인박스';
    return (await this.projects()).get(projectId)?.name ?? null;
  }

  async resolveProject(refOrName: string | null | undefined): Promise<string | null | undefined> {
    if (refOrName === undefined) return undefined;
    if (refOrName === null || refOrName === '' || refOrName.toLowerCase() === 'inbox') return null;
    try {
      return (await this.s.projects.resolve(this.a, refOrName)).id;
    } catch {
      const names = [...(await this.projects()).values()].filter((p) => !p.archivedAt).map((p) => p.name);
      throw new ToolError(
        `Project "${refOrName}" not found. Existing projects: ${names.join(', ') || '(none)'}. Use create_project first if needed.`,
      );
    }
  }

  async task(t: Task, opts: { withDeps?: boolean; withNotes?: boolean } = {}): Promise<TaskOut> {
    this.taskById.set(t.id, t);
    const project = t.projectId ? (await this.projects()).get(t.projectId) : undefined;
    const out: TaskOut = {
      ref: `#${t.number}`,
      id: t.id,
      title: t.title,
      status: t.status,
      priority: PRIORITY_NAME[t.priority],
      project: project?.name ?? null,
      ...(project ? { projectColor: project.color } : {}),
      startDate: t.startDate,
      dueDate: t.dueDate,
      fixed: t.fixed,
    };
    if (t.assigneeId) out.assignee = (await this.memberName(t.assigneeId)) ?? '(전 멤버)';
    if (!canEditTask(t, this.a)) out.readOnly = true;
    if (isOverdue(t, this.today)) out.overdue = true;
    if (t.postponedCount > 0) out.postponedCount = t.postponedCount;
    if (t.completedAt) out.completedAt = t.completedAt;
    if (opts.withNotes !== false && t.notes) out.notes = opts.withNotes ? t.notes : truncate(t.notes, 280);
    if (opts.withDeps) {
      const deps = await this.dependencies();
      out.blockedBy = await Promise.all(deps.filter((d) => d.taskId === t.id).map((d) => this.link(d.dependsOnId)));
      out.blocks = await Promise.all(deps.filter((d) => d.dependsOnId === t.id).map((d) => this.link(d.taskId)));
    }
    return out;
  }

  async tasksOut(tasks: Task[]) {
    this.remember(tasks);
    return Promise.all(tasks.map((t) => this.task(t, { withNotes: false })));
  }

  async impact(report: ImpactReport, root?: { task: Task; days: number; applied?: { cascade: boolean } }): Promise<ImpactOut> {
    const projects = await this.projects();
    const span = (s: { startDate: string | null; dueDate: string | null }) =>
      s.startDate && s.dueDate && s.startDate !== s.dueDate ? `${s.startDate}..${s.dueDate}` : (s.dueDate ?? s.startDate);
    const impacts = await Promise.all(
      report.impacts.map(async (im) => ({
        ref: im.number ? `#${im.number}` : await this.refOf(im.taskId),
        title: im.title,
        effect: im.kind,
        ...(im.shiftDays ? { shiftDays: im.shiftDays } : {}),
        ...(im.overrunDays ? { overrunDays: im.overrunDays } : {}),
        ...(im.slackDays !== null ? { slackLeftDays: im.slackDays } : {}),
        from: span(im.from),
        to: span(im.to),
        ...(im.viaId ? { because: await this.refOf(im.viaId) } : {}),
      })),
    );
    const s = report.summary;
    // summary.maxShiftDays also counts the root's own move and conflict overruns; sentences about
    // "dependents pushed by up to N days" need the largest push among shifted dependents only.
    const maxDelayDays = Math.max(0, ...report.impacts.filter((i) => i.kind === 'shifted').map((i) => i.shiftDays));
    return {
      headline: headlineKo(s, maxDelayDays, report.rootIds.length, root),
      ...(root ? { root: { ref: `#${root.task.number}`, title: root.task.title, days: root.days } } : {}),
      delayed: s.delayedCount,
      conflicts: s.conflictCount,
      absorbed: s.absorbedCount,
      maxShiftDays: s.maxShiftDays,
      maxDelayDays,
      projectSlips: s.projectSlips.map((p) => {
        const project = projects.get(p.projectId);
        return {
          project: project?.name ?? p.projectId,
          ...(project ? { projectColor: project.color } : {}),
          finishFrom: p.from,
          finishTo: p.to,
          slip: `+${formatDaysKo(p.shiftDays)}`,
          shiftDays: p.shiftDays,
        };
      }),
      overallFinish: s.finishFrom === s.finishTo ? s.finishTo : { from: s.finishFrom, to: s.finishTo },
      impacts,
    };
  }
}

/** "#12 기획서 초안을 3일 미루면 작업 3개가 최대 3일 밀리고, 고정 일정 1개와 충돌합니다." */
function headlineKo(
  s: ImpactSummary,
  maxDelayDays: number,
  rootCount: number,
  root?: { task: Task; days: number; applied?: { cascade: boolean } },
): string {
  if (!root && rootCount === 0) return '지금 밀리고 있는 일정은 없습니다.';
  if (root?.applied) {
    const name = `#${root.task.number} ${root.task.title}`;
    const verb = root.days >= 0 ? '미뤘습니다' : '앞당겼습니다';
    const conflict = s.conflictCount ? ` 고정 일정 ${s.conflictCount}개와 충돌합니다.` : '';
    if (!root.applied.cascade) {
      const left = s.delayedCount ? ` 후속 작업 ${s.delayedCount}개는 그대로 두어서, 이 작업이 끝나기 전에 시작하게 됩니다.` : '';
      return `${name}만 ${formatDaysKo(root.days)} ${verb}.${left}${conflict}`;
    }
    const moved = s.delayedCount
      ? ` 작업 ${s.delayedCount}개가 함께 ${s.delayedCount > 1 ? '최대 ' : ''}${formatDaysKo(maxDelayDays)} 밀렸습니다.`
      : ' 다른 작업은 밀리지 않았습니다.';
    return `${name}${eulReul(root.task.title)} ${formatDaysKo(root.days)} ${verb}.${moved}${conflict}`;
  }
  let lead: string;
  if (root) {
    const name = `#${root.task.number} ${root.task.title}`;
    lead =
      root.days === 0
        ? `${name}의 날짜를 그대로 두면`
        : `${name}${eulReul(root.task.title)} ${formatDaysKo(root.days)} ${root.days > 0 ? '미루면' : '앞당기면'}`;
  } else {
    lead = `기한 지난 작업 ${rootCount}개는 빨라도 오늘 끝나므로`;
  }
  const delayed = `작업 ${s.delayedCount}개가 ${s.delayedCount > 1 ? '최대 ' : ''}${formatDaysKo(maxDelayDays)}`;
  const conflict = `고정 일정 ${s.conflictCount}개와 충돌합니다.`;
  let body: string;
  if (s.delayedCount && s.conflictCount) body = `${delayed} 밀리고, ${conflict}`;
  else if (s.delayedCount) body = `${delayed} 밀립니다.`;
  else if (s.conflictCount) body = conflict;
  else if (!root) return `기한 지난 작업 ${rootCount}개가 있지만 다른 작업은 밀리지 않습니다.${s.absorbedCount ? ` 작업 ${s.absorbedCount}개는 여유 시간으로 흡수됩니다.` : ''}`;
  else body = '다른 작업은 밀리지 않습니다.';
  const absorbed = s.absorbedCount ? ` 작업 ${s.absorbedCount}개는 여유 시간으로 흡수됩니다.` : '';
  return `${lead} ${body}${absorbed}`;
}

/** Priority first, then in-progress before to-do, then the earlier deadline. */
function byImportance(a: Task, b: Task): number {
  const day = (t: Task) => t.dueDate ?? t.startDate ?? '9999-12-31';
  return (
    b.priority - a.priority ||
    Number(b.status === 'doing') - Number(a.status === 'doing') ||
    day(a).localeCompare(day(b)) ||
    a.number - b.number
  );
}

class ToolError extends Error {}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function ok(data: Record<string, unknown>, text?: string): CallToolResult {
  return { content: [{ type: 'text', text: text ?? JSON.stringify(data) }], structuredContent: data };
}

function fail(e: unknown): CallToolResult {
  let message = 'Unexpected error';
  if (e instanceof ToolError) message = e.message;
  else if (e instanceof HttpException) {
    const r = e.getResponse();
    message = typeof r === 'string' ? r : ((r as { message?: string }).message ?? e.message);
  } else if (e instanceof Error) message = e.message;
  return { content: [{ type: 'text', text: message }], isError: true };
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const code = (s: string) => `\`${s}\``;

export interface McpOptions {
  /** The client declared MCP Apps support at initialize: tailor the presentation instructions. */
  ui?: boolean;
}

export function buildMcpServer(auth: AuthContext, deps: McpDeps, opts: McpOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'obelisk', title: 'Obelisk', version: '0.2.0', websiteUrl: config.publicUrl },
    {
      instructions: INSTRUCTIONS + (opts.ui ? PRESENT_CARDS : PRESENT_TEXT),
      capabilities: { tools: {}, prompts: {}, resources: {} },
    },
  );
  // One access context per workspace named in this request (most requests use one).
  const ctxs = new Map<string, Promise<Ctx>>();
  const ctxFor = (ref?: string) => {
    const key = ref?.trim() ?? '';
    if (!ctxs.has(key)) ctxs.set(key, deps.access.resolve(auth, key || undefined).then((a) => new Ctx(a, deps)));
    return ctxs.get(key)!;
  };
  /** A task id names its own workspace: use it when the caller didn't pick one. */
  const ctxForRef = async (ref: string, workspace?: string) => {
    if (!workspace && UUID_RE.test(ref.trim())) {
      try {
        return new Ctx(await deps.access.forTask(auth, ref.trim()), deps);
      } catch {
        /* fall through to the default workspace (which answers "not found") */
      }
    }
    return ctxFor(workspace);
  };

  const tool = <S extends z.ZodRawShape, R extends Record<string, unknown>>(
    name: string,
    meta: {
      title: string;
      description: string;
      annotations: Record<string, boolean>;
      /** MCP Apps view + the status line ChatGPT shows while the tool runs. */
      ui?: { view: WidgetView; invoking: string; invoked: string };
      /** Not about one workspace (no "workspace" argument). */
      global?: boolean;
    },
    inputSchema: S,
    fn: (args: z.infer<z.ZodObject<S>> & { workspace?: string }, c: Ctx) => Promise<R>,
    /** Markdown for the text content block (JSON when omitted). */
    render?: (result: R) => string,
  ) => {
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.ui
          ? `${meta.description} In Claude/ChatGPT chat the user sees the result as an Obelisk card: don't relist it, answer in 1–2 sentences.`
          : meta.description,
        inputSchema: meta.global ? inputSchema : { ...inputSchema, workspace: workspaceArg },
        annotations: { title: meta.title, ...meta.annotations },
        ...(meta.ui ? { _meta: widgetToolMeta(meta.ui.view, meta.ui) } : {}),
      },
      (async (args: z.infer<z.ZodObject<S>> & { workspace?: string }) => {
        let data: R;
        try {
          const c = meta.global ? (undefined as unknown as Ctx) : await ctxFor(args.workspace);
          data = await fn(args, c);
        } catch (e) {
          return fail(e);
        }
        let text: string | undefined;
        try {
          text = render?.(data);
        } catch (e) {
          console.error(`[mcp] render ${name} failed`, e);
        }
        return ok(data, text);
      }) as never,
    );
  };

  // ───────────────────────────── UI resources (MCP Apps)

  for (const view of WIDGET_VIEWS) {
    const uri = widgetUri(view);
    server.registerResource(
      `view-${view}`,
      uri,
      { title: widgetTitle(view), description: `Interactive card: ${widgetTitle(view)}`, mimeType: UI_MIME_TYPE, _meta: widgetResourceMeta(view) },
      async () => ({ contents: [{ uri, mimeType: UI_MIME_TYPE, text: widgetHtml(view), _meta: widgetResourceMeta(view) }] }),
    );
  }

  // Older view URIs (cached by a client before a deploy) still resolve, to the current page.
  server.registerResource(
    'view-any-version',
    new ResourceTemplate('ui://obelisk/{version}/{view}.html', { list: undefined }),
    { title: 'Obelisk card', mimeType: UI_MIME_TYPE },
    async (uri, vars) => {
      const view = String(vars.view);
      if (!isWidgetView(view)) throw new Error(`Unknown view: ${view}`);
      return { contents: [{ uri: uri.href, mimeType: UI_MIME_TYPE, text: widgetHtml(view), _meta: widgetResourceMeta(view) }] };
    },
  );

  // ───────────────────────────── overview & reading

  tool(
    'get_overview',
    {
      title: 'Get overview',
      description:
        "The user's current situation: today's date, overdue tasks, today's tasks, in-progress work, upcoming dated tasks, active delay risks, and projects. Start here for 'what should I do today/this week?'.",
      annotations: READ,
      ui: { view: 'tasks', invoking: '오늘 일정을 살펴보는 중…', invoked: '오늘 일정을 불러왔어요' },
    },
    { days: z.number().int().min(1).max(60).default(7).describe('How many days ahead to include in "upcoming"') },
    async ({ days }, c) => {
      const [active, fc, projects] = await Promise.all([
        deps.tasks.listActive(c.a),
        deps.impact.forecast(c.a),
        c.projects(),
      ]);
      const done = await deps.tasks.list(c.a, { view: 'done', limit: 50 }, c.today);
      const horizon = addDays(c.today, days);
      // Each task appears once (an in-progress task that starts later is "today", not also "upcoming"),
      // most important first: the card and the markdown group these by day, in this order.
      const overdue = selectView(active, 'overdue', c.today).sort(byImportance);
      const today = selectView(active, 'today', c.today)
        .filter((t) => !isOverdue(t, c.today))
        .sort(byImportance);
      const shown = new Set([...overdue, ...today].map((t) => t.id));
      const upcoming = selectView(active, 'upcoming', c.today)
        .filter((t) => !shown.has(t.id) && (t.startDate ?? t.dueDate)! <= horizon)
        .sort(byImportance);
      const risk = await c.impact(fc.report);
      return {
        today: c.today,
        workspace: c.workspaceName,
        timezone: c.a.user.timezone,
        user: auth.user.name,
        counts: {
          active: active.length,
          overdue: overdue.length,
          today: today.length,
          inbox: active.filter((t) => !t.projectId).length,
          ...(c.a.kind === 'org' ? { assignedToMe: active.filter((t) => t.assigneeId === c.userId).length } : {}),
          completedToday: done.filter((t) => t.completedAt && todayIn(c.a.user.timezone, new Date(t.completedAt)) === c.today).length,
        },
        overdue: await c.tasksOut(overdue),
        todayTasks: await c.tasksOut(today),
        upcoming: await c.tasksOut(upcoming),
        upcomingDays: days,
        delayRisk:
          fc.report.rootIds.length === 0
            ? 'Nothing is slipping right now.'
            : { headline: risk.headline, conflicts: risk.conflicts, delayed: risk.delayed, impacts: risk.impacts.filter((i) => i.effect !== 'absorbed') },
        projects: [...projects.values()]
          .filter((p) => !p.archivedAt)
          .map((p) => ({ name: p.name, id: p.id, color: p.color, open: active.filter((t) => t.projectId === p.id).length })),
      };
    },
    mdOverview,
  );

  tool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List tasks with filters. view: today (overdue + due/started today + in progress), upcoming, overdue, inbox (no project), unscheduled, all (all open), done (recently completed).',
      annotations: READ,
      ui: { view: 'tasks', invoking: '작업을 찾는 중…', invoked: '작업 목록' },
    },
    {
      view: z.enum(VIEW_NAMES).default('all'),
      project: projectRef.optional().describe('Project name or id; "inbox" for tasks without a project'),
      status: z.enum(['todo', 'doing', 'done', 'canceled']).optional(),
      query: z.string().max(200).optional().describe('Text search in title and notes'),
      from: isoDate.optional().describe('Only tasks scheduled on/after this date'),
      to: isoDate.optional().describe('Only tasks scheduled on/before this date'),
      assignee: assigneeRef.optional().describe('"me" for my tasks, a member name/email, or "none" for unassigned'),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async (a, c) => {
      const projectId = await c.resolveProject(a.project);
      const assigneeId = await c.resolveAssignee(a.assignee);
      const list = await deps.tasks.list(
        c.a,
        { view: a.view, projectId, status: a.status, query: a.query, from: a.from, to: a.to, limit: a.limit, assigneeId },
        c.today,
      );
      return {
        today: c.today,
        workspace: c.workspaceName,
        view: a.view,
        ...(assigneeId !== undefined ? { assignee: assigneeId ? await c.memberName(assigneeId) : 'none' } : {}),
        ...(projectId !== undefined ? { project: await c.projectName(projectId) } : {}),
        count: list.length,
        tasks: await c.tasksOut(list),
      };
    },
    mdTaskList,
  );

  tool(
    'get_task',
    {
      title: 'Get task',
      description: 'Full details of one task including notes, what it is blocked by and what it blocks.',
      annotations: READ,
      ui: { view: 'task', invoking: '작업을 여는 중…', invoked: '작업 상세' },
    },
    { ref },
    async ({ ref, workspace }, c0) => {
      const c = await ctxForRef(ref, workspace);
      const t = await deps.tasks.resolve(c.a, ref);
      return { today: c.today, workspace: c.workspaceName, task: await c.task(t, { withDeps: true, withNotes: true }) };
    },
    (r) => mdTaskDetail(r.task, r.today),
  );

  // ───────────────────────────── writing

  tool(
    'create_task',
    {
      title: 'Create task',
      description:
        'Create one task. Dates are YYYY-MM-DD. Use fixed=true for immovable commitments (meetings, hard deadlines). blockedBy lists tasks that must finish first.',
      annotations: WRITE,
      ui: { view: 'task', invoking: '작업을 만드는 중…', invoked: '작업을 만들었어요' },
    },
    {
      title: z.string().min(1).max(500),
      notes: z.string().max(20000).optional(),
      project: projectRef.optional(),
      priority: priorityIn.optional(),
      startDate: isoDate.optional(),
      dueDate: isoDate.optional(),
      fixed: z.boolean().optional(),
      assignee: assigneeRef.optional(),
      blockedBy: z.array(ref).max(50).optional(),
    },
    async (a, c) => {
      const projectId = await c.resolveProject(a.project);
      const blockedBy = await Promise.all((a.blockedBy ?? []).map(async (r) => (await deps.tasks.resolve(c.a, r)).id));
      const t = await deps.tasks.create(c.a, {
        title: a.title,
        notes: a.notes,
        projectId,
        assigneeId: await c.resolveAssignee(a.assignee),
        priority: a.priority ? PRIORITY_VALUE[a.priority] : undefined,
        startDate: a.startDate,
        dueDate: a.dueDate,
        fixed: a.fixed,
        blockedBy,
      });
      return { today: c.today, created: await c.task(t, { withDeps: true }) };
    },
    (r) => mdTaskDetail(r.created, r.today, '만들었습니다'),
  );

  tool(
    'create_tasks',
    {
      title: 'Create several tasks (plan)',
      description:
        'Create up to 100 tasks at once — ideal for breaking a goal into an ordered plan. Give tasks a "key" and reference earlier/later keys (or existing "#12" refs) in blockedBy to wire dependencies.',
      annotations: WRITE,
      ui: { view: 'tasks', invoking: '계획을 만드는 중…', invoked: '계획을 만들었어요' },
    },
    {
      project: projectRef.optional().describe('Default project for all tasks'),
      tasks: z
        .array(
          z.object({
            key: z.string().min(1).max(64).optional().describe('Local key so other items can depend on this one'),
            title: z.string().min(1).max(500),
            notes: z.string().max(20000).optional(),
            priority: priorityIn.optional(),
            startDate: isoDate.optional(),
            dueDate: isoDate.optional(),
            fixed: z.boolean().optional(),
            assignee: assigneeRef.optional(),
            blockedBy: z.array(z.string().min(1)).optional().describe('Keys from this batch or existing task refs'),
          }),
        )
        .min(1)
        .max(100),
    },
    async (a, c) => {
      const projectId = await c.resolveProject(a.project);
      const tasks = await Promise.all(
        a.tasks.map(async ({ assignee, ...t }) => ({
          ...t,
          priority: t.priority ? PRIORITY_VALUE[t.priority] : undefined,
          assigneeId: await c.resolveAssignee(assignee),
        })),
      );
      const res = await deps.tasks.createMany(c.a, { projectId, tasks });
      c.remember(res.tasks);
      return {
        today: c.today,
        created: await c.tasksOut(res.tasks),
        dependencies: await Promise.all(
          res.dependencies.map(async (d) => ({ task: await c.refOf(d.taskId), blockedBy: await c.refOf(d.dependsOnId) })),
        ),
      };
    },
    mdCreatedMany,
  );

  tool(
    'update_task',
    {
      title: 'Update task',
      description:
        'Change any field of a task. Pass null to clear project/startDate/dueDate/assignee. Moving a due date later does NOT move dependents — the response lists who is affected; prefer postpone_task for postponements.',
      annotations: { ...WRITE, idempotentHint: true },
      ui: { view: 'task', invoking: '작업을 고치는 중…', invoked: '작업을 수정했어요' },
    },
    {
      ref,
      title: z.string().min(1).max(500).optional(),
      notes: z.string().max(20000).optional(),
      status: z.enum(['todo', 'doing', 'done', 'canceled']).optional(),
      priority: priorityIn.optional(),
      project: projectRef.nullable().optional(),
      startDate: nullableDate.optional(),
      dueDate: nullableDate.optional(),
      fixed: z.boolean().optional(),
      assignee: assigneeRef.nullable().optional(),
    },
    async (a, c) => {
      const cur = await deps.tasks.resolve(c.a, a.ref);
      let preview: ImpactOut | undefined;
      const anchor = cur.dueDate ?? cur.startDate;
      const nextAnchor = a.dueDate !== undefined ? a.dueDate : a.startDate !== undefined && !cur.dueDate ? a.startDate : anchor;
      if (anchor && nextAnchor && nextAnchor > anchor && (cur.status === 'todo' || cur.status === 'doing')) {
        const sim = await deps.impact.simulate(c.a, { taskId: cur.id, toDate: nextAnchor });
        if (sim.report.summary.delayedCount || sim.report.summary.conflictCount) {
          preview = await c.impact(sim.report, { task: cur, days: sim.days });
        }
      }
      const t = await deps.tasks.update(c.a, cur.id, {
        title: a.title,
        notes: a.notes,
        status: a.status,
        priority: a.priority ? PRIORITY_VALUE[a.priority] : undefined,
        projectId: await c.resolveProject(a.project),
        startDate: a.startDate,
        dueDate: a.dueDate,
        fixed: a.fixed,
        assigneeId: await c.resolveAssignee(a.assignee),
      });
      return {
        today: c.today,
        updated: await c.task(t, { withDeps: true }),
        ...(preview
          ? {
              warning:
                'Dependents were not moved and now start before this task finishes. Call postpone_task with cascade=true to shift them.',
              dependentsAffected: preview,
            }
          : {}),
      };
    },
    (r) => {
      const base = mdTaskDetail(r.updated, r.today, '수정했습니다');
      if (!r.dependentsAffected) return base;
      const rows = r.dependentsAffected.impacts
        .filter((i) => i.effect === 'shifted' || i.effect === 'conflict')
        .map((i) => `- ${impactPhrase(i)}`)
        .join('\n');
      return `${base}\n\n> ⚠️ **후속 작업은 옮기지 않았습니다.** ${r.dependentsAffected.headline}\n\n${rows}\n\n_${r.warning}_`;
    },
  );

  tool(
    'complete_task',
    {
      title: 'Complete task',
      description: 'Mark a task done (or undo=true to reopen it).',
      annotations: { ...WRITE, idempotentHint: true },
      ui: { view: 'task', invoking: '완료 처리하는 중…', invoked: '완료했어요' },
    },
    { ref, undo: z.boolean().default(false) },
    async ({ ref, undo }, c) => {
      const cur = await deps.tasks.resolve(c.a, ref);
      const t = await deps.tasks.update(c.a, cur.id, { status: undo ? 'todo' : 'done' });
      const unblocked = undo
        ? []
        : (await c.dependencies()).filter((d) => d.dependsOnId === t.id).map((d) => d.taskId);
      return {
        today: c.today,
        task: await c.task(t),
        action: (undo ? 'reopened' : 'completed') as 'reopened' | 'completed',
        ...(unblocked.length ? { nowUnblocked: await Promise.all(unblocked.map((id) => c.link(id))) } : {}),
      };
    },
    mdCompleted,
  );

  tool(
    'delete_task',
    {
      title: 'Delete task',
      description: 'Permanently delete a task and its dependency links. Confirm with the user first.',
      annotations: DESTRUCTIVE,
    },
    { ref },
    async ({ ref }, c) => {
      const t = await deps.tasks.resolve(c.a, ref);
      await deps.tasks.remove(c.a, t.id);
      return { deleted: `#${t.number} ${t.title}` };
    },
    (r) => `🗑 ${r.deleted} — 삭제했습니다.`,
  );

  // ───────────────────────────── delay impact

  tool(
    'simulate_delay',
    {
      title: 'Simulate delay',
      description:
        'Predict what happens if a task slips: which dependent tasks get pushed and by how much, which fixed dates break, how project finish dates move. Read-only. Give either days (+later / -earlier) or toDate.',
      annotations: READ,
      ui: { view: 'impact', invoking: '지연 파급을 계산하는 중…', invoked: '지연 시뮬레이션' },
    },
    {
      ref,
      days: z.number().int().min(-365).max(365).optional(),
      toDate: isoDate.optional().describe('New due date for the task'),
    },
    async (a, c) => {
      if ((a.days === undefined) === (a.toDate === undefined)) throw new ToolError('Provide exactly one of days or toDate.');
      const t = await deps.tasks.resolve(c.a, a.ref);
      const sim = await deps.impact.simulate(c.a, { taskId: t.id, days: a.days, toDate: a.toDate });
      return { today: c.today, prediction: await c.impact(sim.report, { task: t, days: sim.days }) };
    },
    (r) => mdImpact(r.prediction, 'simulate'),
  );

  tool(
    'postpone_task',
    {
      title: 'Postpone task',
      description:
        'Move a task later (or earlier) by days or to a date. cascade=true (default) also shifts every task the delay pushes, keeping the plan consistent; fixed tasks never move and are reported as conflicts. Run simulate_delay first when dependents exist.',
      annotations: WRITE,
      ui: { view: 'impact', invoking: '일정을 옮기는 중…', invoked: '일정을 옮겼어요' },
    },
    {
      ref,
      days: z.number().int().min(-365).max(365).optional(),
      toDate: isoDate.optional(),
      cascade: z.boolean().default(true),
    },
    async (a, c) => {
      if ((a.days === undefined) === (a.toDate === undefined)) throw new ToolError('Provide exactly one of days or toDate.');
      const t = await deps.tasks.resolve(c.a, a.ref);
      const res = await deps.impact.postpone(c.a, { taskId: t.id, days: a.days, toDate: a.toDate, cascade: a.cascade });
      return {
        today: c.today,
        moved: await c.tasksOut(res.updated),
        cascade: res.cascade,
        impact: await c.impact(res.report, { task: t, days: res.days, applied: { cascade: res.cascade } }),
      };
    },
    (r) => mdImpact(r.impact, 'applied', { cascade: r.cascade, moved: r.moved.length }),
  );

  tool(
    'get_forecast',
    {
      title: 'Get delay forecast',
      description:
        'Live risk forecast: overdue unfinished tasks can finish today at the earliest — which downstream tasks are therefore already slipping, and which fixed dates are at risk.',
      annotations: READ,
      ui: { view: 'impact', invoking: '밀리는 일정을 찾는 중…', invoked: '지연 예측' },
    },
    {},
    async (_a, c) => {
      const fc = await deps.impact.forecast(c.a);
      return { today: fc.today, overdueRoots: fc.report.rootIds.length, forecast: await c.impact(fc.report) };
    },
    (r) => mdImpact(r.forecast, 'forecast'),
  );

  tool(
    'get_bottlenecks',
    {
      title: 'Get bottlenecks',
      description:
        'Rank open tasks by how much of the plan depends on them: downstream task count, slack days before anything else moves, and what a one-day slip would cost.',
      annotations: READ,
      ui: { view: 'bottlenecks', invoking: '병목을 찾는 중…', invoked: '병목 작업' },
    },
    { limit: z.number().int().min(1).max(50).default(10) },
    async ({ limit }, c) => {
      const lv = (await deps.impact.leverage(c.a)).slice(0, limit);
      const out: BottleneckOut[] = await Promise.all(
        lv.map(async (l) => {
          const t = await deps.tasks.get(c.a, l.taskId);
          return {
            ...(await c.task(t, { withNotes: false })),
            downstreamTasks: l.downstreamCount,
            slackDays: l.slackDays,
            ifOneDayLate: { delayed: l.delayedIfLate, fixedConflicts: l.conflictsIfLate },
          };
        }),
      );
      return { today: c.today, bottlenecks: out };
    },
    mdBottlenecks,
  );

  // ───────────────────────────── dependencies

  tool(
    'add_dependency',
    {
      title: 'Add dependency',
      description: '"task" cannot start until "blockedBy" is finished. Cycles are rejected.',
      annotations: { ...WRITE, idempotentHint: true },
    },
    { task: ref, blockedBy: ref },
    async (a, c) => {
      const t = await deps.tasks.resolve(c.a, a.task);
      const b = await deps.tasks.resolve(c.a, a.blockedBy);
      await deps.tasks.addDependency(c.a, t.id, b.id);
      return {
        ok: true,
        dependency: `${code(`#${t.number}`)} ${esc(t.title)} ← ${code(`#${b.number}`)} ${esc(b.title)} — 선행 작업이 끝나야 시작할 수 있도록 연결했습니다.`,
      };
    },
    (r) => `🔗 ${r.dependency}`,
  );

  tool(
    'remove_dependency',
    {
      title: 'Remove dependency',
      description: 'Remove a "blocked by" link between two tasks.',
      annotations: { ...WRITE, idempotentHint: true },
    },
    { task: ref, blockedBy: ref },
    async (a, c) => {
      const t = await deps.tasks.resolve(c.a, a.task);
      const b = await deps.tasks.resolve(c.a, a.blockedBy);
      await deps.tasks.removeDependency(c.a, t.id, b.id);
      return { ok: true, removed: `${code(`#${t.number}`)} ${esc(t.title)} ↚ ${code(`#${b.number}`)} ${esc(b.title)}` };
    },
    (r) => `연결을 끊었습니다 — ${r.removed}`,
  );

  // ───────────────────────────── projects

  tool(
    'list_projects',
    {
      title: 'List projects',
      description: 'All projects with open/overdue counts.',
      annotations: READ,
      ui: { view: 'projects', invoking: '프로젝트를 불러오는 중…', invoked: '프로젝트' },
    },
    { includeArchived: z.boolean().default(false) },
    async ({ includeArchived }, c) => {
      const [list, active] = await Promise.all([
        deps.projects.list(c.a, { includeArchived }),
        deps.tasks.listActive(c.a),
      ]);
      const projects: ProjectOut[] = list.map((p) => {
        const mine = active.filter((t) => t.projectId === p.id);
        const dated = mine.map((t) => t.dueDate ?? t.startDate).filter(Boolean) as string[];
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          archived: !!p.archivedAt,
          open: mine.length,
          overdue: mine.filter((t) => isOverdue(t, c.today)).length,
          plannedFinish: dated.sort().at(-1) ?? null,
          ...(c.a.kind === 'org' ? { access: p.access } : {}),
        };
      });
      return { today: c.today, workspace: c.workspaceName, projects };
    },
    mdProjects,
  );

  tool(
    'create_project',
    {
      title: 'Create project',
      description:
        'Create a project (a list that groups tasks). In an organization it starts private (only you and admins) unless memberAccess gives every member view or edit; share it further in the web app.',
      annotations: WRITE,
    },
    {
      name: z.string().min(1).max(120),
      color: z.enum(PROJECT_COLORS).optional(),
      memberAccess: z.enum(['none', 'view', 'edit']).optional().describe('Organizations only: what every member gets (default none = private)'),
    },
    async ({ workspace: _w, ...a }, c) => ({ project: (await deps.projects.create(c.a, a)).project, workspace: c.workspaceName }),
    (r) => `● **${esc(r.project.name)}** 프로젝트를 ${esc(r.workspace)}에 만들었습니다.`,
  );

  tool(
    'update_project',
    {
      title: 'Update project',
      description: 'Rename, recolor, archive or unarchive a project.',
      annotations: { ...WRITE, idempotentHint: true },
    },
    {
      project: projectRef,
      name: z.string().min(1).max(120).optional(),
      color: z.enum(PROJECT_COLORS).optional(),
      archived: z.boolean().optional(),
    },
    async (a, c) => {
      const p = await deps.projects.resolve(c.a, a.project);
      return { project: await deps.projects.update(c.a, p.id, { name: a.name, color: a.color, archived: a.archived }) };
    },
    (r) => `● **${esc(r.project.name)}** 프로젝트를 ${r.project.archivedAt ? '보관했습니다' : '수정했습니다'}.`,
  );

  tool(
    'delete_project',
    {
      title: 'Delete project',
      description: 'Delete a project. Its tasks move to the inbox unless deleteTasks=true. Confirm with the user first.',
      annotations: DESTRUCTIVE,
    },
    { project: projectRef, deleteTasks: z.boolean().default(false) },
    async (a, c) => {
      const p = await deps.projects.resolve(c.a, a.project);
      await deps.projects.remove(c.a, p.id, { deleteTasks: a.deleteTasks });
      return { deleted: p.name, tasks: a.deleteTasks ? 'deleted' : 'moved to inbox' };
    },
    (r) =>
      `🗑 **${esc(r.deleted)}** 프로젝트를 삭제했습니다. 작업은 ${r.tasks === 'deleted' ? '함께 삭제했습니다' : '인박스로 옮겼습니다'}.`,
  );

  // ───────────────────────────── workspaces, members, activity

  tool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description:
        "The user's personal space and the organizations they belong to, with their role in each and which one is the default (used when a tool gets no workspace).",
      annotations: READ,
      global: true,
    },
    {},
    async () => {
      const def = await ctxFor();
      const list = await deps.workspaces.listFor(auth.user.id);
      const workspaces: WorkspaceOut[] = list.map((w) => ({
        id: w.id,
        name: w.kind === 'personal' ? '개인 공간' : w.name,
        kind: w.kind,
        role: w.role,
        members: w.memberCount,
        default: w.id === def.a.workspaceId,
      }));
      return { workspaces };
    },
    mdWorkspaces,
  );

  tool(
    'list_members',
    {
      title: 'List members',
      description: 'Members of a workspace (name, email, role, teams) — who can be made an assignee.',
      annotations: READ,
    },
    {},
    async (_a, c) => {
      const [members, teams] = await Promise.all([c.members(), deps.workspaces.teams(c.a.workspaceId)]);
      const teamName = new Map(teams.map((t) => [t.id, t.name]));
      const out: MemberOut[] = members.map((m) => ({
        name: m.name,
        email: m.email,
        role: m.role,
        teams: m.teamIds.map((id) => teamName.get(id) ?? '').filter(Boolean),
        ...(m.id === c.userId ? { me: true as const } : {}),
      }));
      return { workspace: c.workspaceName, members: out };
    },
    mdMembers,
  );

  tool(
    'get_activity',
    {
      title: 'Get activity',
      description:
        'Who changed what and when: the history of one task, of one project, or (without either) recent activity in the workspace — limited to what the user can see. Shows when a change came through an AI app or API token.',
      annotations: READ,
    },
    {
      task: ref.optional().describe('A task ref to get its history'),
      project: projectRef.optional().describe('A project to get its history'),
      limit: z.number().int().min(1).max(100).default(30),
    },
    async (a, c0) => {
      const c = a.task ? await ctxForRef(a.task, a.workspace) : c0;
      let title = `${c.workspaceName} 최근 활동`;
      let entries;
      if (a.task) {
        const t = await deps.tasks.resolve(c.a, a.task);
        title = `#${t.number} ${t.title} 기록`;
        entries = (await deps.activity.forTask(c.a, t.id)).slice(0, a.limit);
      } else {
        const projectId = a.project ? await c.resolveProject(a.project) : undefined;
        if (projectId) title = `${await c.projectName(projectId)} 기록`;
        entries = await deps.activity.list(c.a, { projectId: projectId ?? undefined, limit: a.limit });
      }
      return { title, timezone: c.a.user.timezone, activity: entries.map(activityOut) };
    },
    mdActivity,
  );

  // ───────────────────────────── ChatGPT connector compatibility (search / fetch)
  // These two keep JSON text content: that is what the connector / deep research spec expects.

  tool(
    'search',
    {
      title: 'Search tasks',
      description: 'Search tasks by text. Returns ids usable with fetch.',
      annotations: READ,
    },
    { query: z.string().min(1).max(200) },
    async ({ query }, c) => {
      const open = await deps.tasks.list(c.a, { query, limit: 20 }, c.today);
      const done = await deps.tasks.list(c.a, { query, view: 'done', limit: 10 }, c.today);
      return {
        results: [...open, ...done].map((t) => ({
          id: t.id,
          title: `#${t.number} ${t.title}`,
          url: `${config.publicUrl}/t/${t.id}`,
        })),
      };
    },
  );

  tool(
    'fetch',
    { title: 'Fetch task', description: 'Fetch the full content of a task by id.', annotations: READ },
    { id: z.string().min(1) },
    async ({ id, workspace }, c0) => {
      const c = await ctxForRef(id, workspace);
      const t = await deps.tasks.resolve(c.a, id);
      const full = await c.task(t, { withDeps: true, withNotes: true });
      const refs = (l?: LinkOut[]) => (l ?? []).map((x) => `${x.ref} ${x.title}`).join(', ');
      const lines = [
        `#${t.number} ${t.title}`,
        `Status: ${t.status} · Priority: ${PRIORITY_NAME[t.priority]}${full.project ? ` · Project: ${full.project}` : ''}`,
        `Dates: ${t.startDate ?? '—'} → ${t.dueDate ?? '—'}${t.fixed ? ' (fixed)' : ''}`,
        full.blockedBy?.length ? `Blocked by: ${refs(full.blockedBy)}` : '',
        full.blocks?.length ? `Blocks: ${refs(full.blocks)}` : '',
        t.notes ? `\n${t.notes}` : '',
      ].filter(Boolean);
      return { id: t.id, title: `#${t.number} ${t.title}`, text: lines.join('\n'), url: `${config.publicUrl}/t/${t.id}`, metadata: full };
    },
  );

  // ───────────────────────────── prompts

  server.registerPrompt(
    'plan_my_day',
    { title: 'Plan my day', description: 'Look at today, overdue work and risks, then propose a realistic plan.' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Use Obelisk to plan my day. Call get_overview first. Then give me: (1) the 3 most important things to do today and why, (2) overdue items with a suggestion each (do today / postpone / drop) — run simulate_delay before suggesting any postponement that has dependents, (3) any fixed dates at risk. Keep it short. Ask before changing anything.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'break_down_goal',
    {
      title: 'Break down a goal',
      description: 'Turn a goal into an ordered plan of dependent tasks.',
      argsSchema: {
        goal: z.string().describe('What you want to achieve'),
        deadline: z.string().optional().describe('Deadline (YYYY-MM-DD), optional'),
        project: z.string().optional().describe('Project to put the tasks in, optional'),
      },
    },
    ({ goal, deadline, project }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Break this goal into a concrete plan in Obelisk: "${goal}".${deadline ? ` Deadline: ${deadline}.` : ''}${project ? ` Project: ${project}.` : ''}
Call get_overview to learn today's date and existing load. Propose 3–12 tasks with realistic start/due dates, mark immovable commitments as fixed, and wire blockedBy dependencies. Show me the plan as a short list first; after I confirm, create everything with one create_tasks call.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'weekly_review',
    { title: 'Weekly review', description: 'Review the past week and set up the next one.' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Run my weekly review in Obelisk: list_tasks view=done for what I finished, get_overview with days=7 for what is next, get_forecast and get_bottlenecks for risk. Summarize wins, what slipped (note tasks with postponedCount ≥ 2), and recommend at most 3 changes. Ask before applying any.',
          },
        },
      ],
    }),
  );

  return server;
}
