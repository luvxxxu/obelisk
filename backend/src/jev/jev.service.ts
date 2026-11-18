import { BadRequestException, HttpException, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import {
  addDays,
  canEditTask,
  DEFAULT_JEV_BASE_URL,
  capacityFromHistory,
  compareTasks,
  DEPENDENCY_THRESHOLD,
  downstreamOf,
  FIXED_THRESHOLD,
  isToday,
  jevEndpoint,
  jevPresetOf,
  leverage,
  NEUTRAL_JUDGMENT,
  pickFocus,
  planPostpone,
  suggestPriority,
  todayIn,
  wouldCreateCycle,
  type Dependency,
  type DependencySuggestion,
  type JevPostponeInput,
  type JevSettingsInput,
  type JevStatus,
  type JevTriageInput,
  type PostponePlan,
  type PrioritySuggestion,
  type Project,
  type Task,
  type TaskJudgment,
  type TriageSuggestion,
} from '@obelisk/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import { sha256 } from '../common/crypto';
import { rateLimiter } from '../common/rate-limit';
import { seal, sealingKeySource, unseal } from '../common/secret';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { users, type UserRow } from '../db/schema';
import { toPlanItem } from '../planner/mappers';
import { ProjectsService } from '../planner/projects.service';
import { TasksService } from '../planner/tasks.service';
import { assertDeliverable, UndeliverableError } from '../webhooks/net';
import type { Access } from '../workspace/access.service';
import { jevKeyContext, jevStatus } from './status';
import {
  askJev,
  JevError,
  MAX_QUESTIONS,
  type JevAnswer,
  type JevConnection,
  type JevQuestion,
  type JevResult,
  type Transport,
} from './jev.client';
import {
  deferrableQ,
  dayLabel,
  excerpt,
  fitsQ,
  fixedQ,
  importanceQ,
  othersQ,
  projectQ,
  QUESTIONS_VERSION,
  relationQ,
  taskState,
  todayLabel,
  type TaskContext,
} from './jev.questions';

/** Tasks per request: 3 questions each, under the 64-question cap of Cloudflare's Clef (21 × 3 = 63). */
const CHUNK = Math.floor(MAX_QUESTIONS / 3);
const PARALLEL = 4;
/** At most this many tasks are judged in one call (soonest first). */
const MAX_TASKS = 300;
const CACHE_MS = 6 * 60 * 60_000;
const CACHE_MAX = 5000;
/** One relation question per candidate, so this also stays under MAX_QUESTIONS. */
const MAX_CANDIDATES = Math.min(40, MAX_QUESTIONS);
const CROSS_PROJECT_THRESHOLD = 0.8;

export interface PrioritiesResult {
  today: string;
  model: string | null;
  suggestions: PrioritySuggestion[];
  /** "지금 할 일 하나" among your own tasks. */
  focus: { taskId: string; reasons: string[] } | null;
}

export interface DependencyResult {
  taskId: string;
  blockedBy: DependencySuggestion[];
  blocks: DependencySuggestion[];
}

const noul = (a: JevAnswer | undefined) => (a?.type === 'noul' ? a.noul : null);

/** Every task `id` transitively waits for. */
function upstreamOf(deps: readonly Dependency[], id: string): string[] {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const n = stack.pop()!;
    for (const d of deps) {
      if (d.taskId === n && !seen.has(d.dependsOnId) && d.dependsOnId !== id) {
        seen.add(d.dependsOnId);
        stack.push(d.dependsOnId);
      }
    }
  }
  return [...seen];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Stored form of a base URL: trimmed, no trailing slash, null for TypeSafe's own. */
function normalizeBaseUrl(raw: string | null): string | null {
  const v = raw?.trim().replace(/\/+$/, '') || null;
  if (!v) return null;
  return v === DEFAULT_JEV_BASE_URL || jevEndpoint(v) === jevEndpoint(DEFAULT_JEV_BASE_URL) ? null : v;
}

function originOf(baseUrl: string | null): string {
  try {
    return new URL(baseUrl ?? DEFAULT_JEV_BASE_URL).origin;
  } catch {
    return baseUrl ?? '';
  }
}

/**
 * Jev — TypeSafe's decision model — as a second opinion on priorities, what to postpone,
 * where a new task belongs and which tasks depend on each other. Every user brings their
 * own key — for TypeSafe, or any System One service at a base URL they choose (OpenRouter,
 * Cloudflare's Clef …); calls only ever describe tasks that user can see.
 */
@Injectable()
export class JevService implements OnApplicationBootstrap {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly limiter = rateLimiter(90, 60_000);
  /** Tests replace the network. */
  transport: Transport | undefined;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
  ) {}

  // ───────────────────────────── settings

  async updateSettings(user: UserRow, input: JevSettingsInput): Promise<{ user: UserRow; jev: JevStatus }> {
    const patch: Partial<Pick<UserRow, 'jevKey' | 'jevKeyHint' | 'jevAutoApply' | 'jevBaseUrl' | 'jevModel'>> = {};
    if (input.apiKey === null) {
      // Disconnecting forgets the service too: the next key starts from TypeSafe again.
      Object.assign(patch, { jevKey: null, jevKeyHint: null, jevBaseUrl: null, jevModel: null });
    } else {
      const baseUrl = input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : user.jevBaseUrl;
      const model = input.model !== undefined ? input.model || null : user.jevModel;
      if (baseUrl && !model) throw new BadRequestException('이 서비스에서 쓸 모델 이름을 입력하세요');
      const service = baseUrl !== user.jevBaseUrl || model !== user.jevModel;
      // A stored key never follows the URL to another host: whoever changes the host brings that host's key.
      if (input.apiKey === undefined && user.jevKey && originOf(baseUrl) !== originOf(user.jevBaseUrl)) {
        throw new BadRequestException('다른 서비스로 바꾸려면 그 서비스의 API 키도 함께 입력하세요');
      }
      const apiKey = input.apiKey ?? (service && user.jevKey ? this.connectionOf(user).apiKey : undefined);
      if (apiKey !== undefined) await this.verify({ apiKey, baseUrl, model });
      if (input.apiKey !== undefined) {
        patch.jevKey = seal(input.apiKey, jevKeyContext(user.id));
        patch.jevKeyHint = input.apiKey.slice(-4);
      }
      if (service) Object.assign(patch, { jevBaseUrl: baseUrl, jevModel: model });
    }
    if (input.autoApply !== undefined) patch.jevAutoApply = input.autoApply;
    let row = user;
    if (Object.keys(patch).length) {
      [row] = (await this.db.update(users).set(patch).where(eq(users.id, user.id)).returning()) as [UserRow];
      if (patch.jevKey !== undefined || patch.jevBaseUrl !== undefined || patch.jevModel !== undefined) this.forget(user.id);
    }
    return { user: row, jev: jevStatus(row) };
  }

  /** One tiny call before a key or service is stored, so a typo is caught in settings rather than later. */
  private async verify(connection: JevConnection) {
    await this.checkEndpoint(connection.baseUrl ?? null);
    try {
      await askJev(
        connection,
        { state: 'Obelisk is checking that this API key works.', questions: { ok: { type: 'noul', instructions: 'Is this a connection check?' } } },
        { fetch: this.transport, retries: 1, timeoutMs: 10_000 },
      );
    } catch (e) {
      if (e instanceof JevError && e.code !== 'network' && e.code !== 'overloaded' && e.code !== 'rate') {
        // The user is already in settings: drop the "go to settings" half of the message.
        throw new BadRequestException(e.message.replace('설정 → Jev에서 ', ''));
      }
      throw this.http(e);
    }
  }

  /**
   * A user-chosen URL must be a public https address — never this server's own network — checked on
   * every call (not just when saved) so a host that later resolves to a private address is refused.
   */
  private async checkEndpoint(baseUrl: string | null) {
    if (!baseUrl) return;
    const url = jevEndpoint(baseUrl);
    if (jevPresetOf(baseUrl) !== null && url.startsWith('https://')) return;
    const fail = (message: string) => new HttpException({ statusCode: 400, code: 'jev_endpoint', message }, 400);
    if (!config.jevAllowPrivate && !url.startsWith('https://')) throw fail('Base URL은 https:// 주소여야 해요');
    try {
      await assertDeliverable(url, config.jevAllowPrivate);
    } catch (e) {
      if (!(e instanceof UndeliverableError)) throw e;
      throw fail(
        e.retryable
          ? `Base URL의 호스트(${new URL(url).hostname})를 찾지 못했어요`
          : '내부망·로컬 주소나 아이디·비밀번호가 들어간 주소는 Base URL로 쓸 수 없어요',
      );
    }
  }

  private connectionOf(user: UserRow): JevConnection {
    if (!user.jevKey) {
      throw new HttpException(
        { statusCode: 400, code: 'jev_not_connected', message: 'Jev가 연결되어 있지 않아요. 설정 → Jev에서 API 키를 입력하세요.' },
        400,
      );
    }
    const opened = unseal(user.jevKey, jevKeyContext(user.id));
    if (!opened) {
      throw new HttpException(
        { statusCode: 400, code: 'jev_key_unreadable', message: '저장된 Jev 키를 읽을 수 없어요. 설정 → Jev에서 키를 다시 입력하세요.' },
        400,
      );
    }
    if (opened.stale) void this.reseal(user.id, user.jevKey, opened.value);
    return { apiKey: opened.value, baseUrl: user.jevBaseUrl, model: user.jevModel };
  }

  // ───────────────────────────── key rotation

  /**
   * Seal again with the current key. Only replaces the exact value that was read, so a key the user
   * changed in the meantime is never overwritten.
   */
  private async reseal(userId: string, was: string, plain: string): Promise<boolean> {
    try {
      const rows = await this.db
        .update(users)
        .set({ jevKey: seal(plain, jevKeyContext(userId)) })
        .where(and(eq(users.id, userId), eq(users.jevKey, was)))
        .returning({ id: users.id });
      return rows.length > 0;
    } catch (e) {
      console.error('[jev] could not re-seal a stored key', e instanceof Error ? e.message : e);
      return false;
    }
  }

  /**
   * At boot, move every stored key onto the current sealing key: v1 values, values sealed with the
   * database password once SECRET_KEY is set, and values sealed with a SECRET_KEY_PREVIOUS. After a
   * rotation has booted once, the previous key can be dropped from the environment.
   */
  async onApplicationBootstrap() {
    try {
      const rows = await this.db
        .select({ id: users.id, jevKey: users.jevKey })
        .from(users)
        .where(isNotNull(users.jevKey));
      let moved = 0;
      let unreadable = 0;
      for (const r of rows) {
        const opened = unseal(r.jevKey!, jevKeyContext(r.id));
        if (!opened) unreadable++;
        else if (opened.stale && (await this.reseal(r.id, r.jevKey!, opened.value))) moved++;
      }
      const from = sealingKeySource === 'secret-key' ? 'SECRET_KEY' : 'the database password (set SECRET_KEY)';
      if (moved) console.log(`[jev] re-sealed ${moved} stored key(s) with ${from}`);
      if (unreadable) {
        console.warn(
          `[jev] ${unreadable} stored key(s) can't be opened with the configured keys — those users must enter them again. ` +
            'If SECRET_KEY was changed, put the old value in SECRET_KEY_PREVIOUS and restart.',
        );
      }
    } catch (e) {
      console.error('[jev] could not check stored keys', e instanceof Error ? e.message : e);
    }
  }

  private http(e: unknown): HttpException {
    if (e instanceof HttpException) return e;
    if (e instanceof JevError) {
      // Never 401: the web app reads that as "your session ended".
      const status = e.code === 'auth' ? 400 : e.code === 'rate' || e.code === 'quota' ? 429 : 502;
      return new HttpException({ statusCode: status, code: `jev_${e.code}`, message: e.message }, status);
    }
    console.error('[jev] unexpected failure', e);
    return new HttpException({ statusCode: 502, message: 'Jev 요청에 실패했어요. 잠시 후 다시 시도하세요.' }, 502);
  }

  private async ask(user: UserRow, call: { state: unknown; questions: Record<string, JevQuestion> }): Promise<JevResult> {
    const connection = this.connectionOf(user);
    try {
      this.limiter(user.id);
    } catch {
      throw new HttpException({ statusCode: 429, message: 'Jev 요청이 너무 잦아요. 잠시 후 다시 시도하세요.' }, 429);
    }
    await this.checkEndpoint(connection.baseUrl ?? null);
    try {
      return await askJev(connection, call, { fetch: this.transport });
    } catch (e) {
      throw this.http(e);
    }
  }

  // ───────────────────────────── cache (per user, per exact task description, per day)

  private cached<T>(key: string): T | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  private remember(key: string, value: unknown) {
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > CACHE_MAX) {
      const drop = this.cache.size - CACHE_MAX;
      let i = 0;
      for (const k of this.cache.keys()) {
        if (i++ >= drop) break;
        this.cache.delete(k);
      }
    }
  }

  private forget(userId: string) {
    for (const k of this.cache.keys()) if (k.startsWith(`${userId}:`)) this.cache.delete(k);
  }

  // ───────────────────────────── shared: per-task judgments

  private async plan(a: Access) {
    const [active, deps] = await Promise.all([this.tasks.listActive(a), this.tasks.dependencies(a)]);
    return { active, deps };
  }

  /** In an organization only your own work is yours to rearrange: assigned to you, or unassigned and created by you. */
  private mine(a: Access) {
    return (t: Task) => a.kind === 'personal' || t.assigneeId === a.userId || (!t.assigneeId && t.createdBy === a.userId);
  }

  private contexts(a: Access, active: Task[], deps: Dependency[], projects: Map<string, Project>) {
    const byId = new Map(active.map((t) => [t.id, t]));
    return (t: Task): TaskContext => ({
      project: t.projectId ? (projects.get(t.projectId)?.name ?? null) : null,
      waiting: deps.filter((d) => d.dependsOnId === t.id).flatMap((d) => (byId.has(d.taskId) ? [byId.get(d.taskId)!.title] : [])),
      waitsOn: deps.filter((d) => d.taskId === t.id).flatMap((d) => (byId.has(d.dependsOnId) ? [byId.get(d.dependsOnId)!.title] : [])),
      assignedToOther: a.kind === 'org' && !!t.assigneeId && t.assigneeId !== a.userId,
    });
  }

  private async projectMap(a: Access) {
    return new Map((await this.projects.list(a, { includeArchived: true })).map((p) => [p.id, p]));
  }

  /** importance · others · deferrable for each task, batched CHUNK per request and cached by content. */
  async judge(a: Access, list: Task[], ctx: (t: Task) => TaskContext): Promise<{ judgments: Map<string, TaskJudgment>; model: string | null }> {
    const today = todayIn(a.user.timezone);
    const judgments = new Map<string, TaskJudgment>();
    const pending: { t: Task; entry: ReturnType<typeof taskState>; key: string }[] = [];
    for (const t of list) {
      const entry = taskState(t, ctx(t), today);
      const key = `${a.userId}:judge:${sha256(`${QUESTIONS_VERSION}|${today}|${JSON.stringify(entry)}`)}`;
      const hit = this.cached<TaskJudgment>(key);
      if (hit) judgments.set(t.id, hit);
      else pending.push({ t, entry, key });
    }
    let model: string | null = null;
    const chunks: (typeof pending)[] = [];
    for (let i = 0; i < pending.length; i += CHUNK) chunks.push(pending.slice(i, i + CHUNK));
    await mapLimit(chunks, PARALLEL, async (group) => {
      const questions: Record<string, JevQuestion> = {};
      group.forEach((_, i) => {
        const ref = `\`tasks.t${i + 1}\``;
        questions[`imp_${i + 1}`] = importanceQ(ref);
        questions[`oth_${i + 1}`] = othersQ(ref);
        questions[`def_${i + 1}`] = deferrableQ(ref);
      });
      const r = await this.ask(a.user, {
        state: { today: todayLabel(today), tasks: Object.fromEntries(group.map((g, i) => [`t${i + 1}`, g.entry])) },
        questions,
      });
      model = r.model;
      group.forEach((g, i) => {
        const imp = r.answers[`imp_${i + 1}`];
        if (imp?.type !== 'score') return;
        const j: TaskJudgment = {
          importance: imp.score,
          importanceConfidence: imp.confidence,
          others: noul(r.answers[`oth_${i + 1}`]) ?? NEUTRAL_JUDGMENT.others,
          deferrable: noul(r.answers[`def_${i + 1}`]) ?? NEUTRAL_JUDGMENT.deferrable,
        };
        judgments.set(g.t.id, j);
        this.remember(g.key, j);
      });
    });
    return { judgments, model };
  }

  // ───────────────────────────── A. priorities

  async priorities(a: Access, input: { taskIds?: string[] } = {}): Promise<PrioritiesResult> {
    const today = todayIn(a.user.timezone);
    const [{ active, deps }, projects] = await Promise.all([this.plan(a), this.projectMap(a)]);
    const wanted = input.taskIds ? new Set(input.taskIds) : null;
    const targets = active
      .filter((t) => canEditTask(t, a) && (!wanted || wanted.has(t.id)))
      .sort(compareTasks)
      .slice(0, MAX_TASKS);
    const { judgments, model } = await this.judge(a, targets, this.contexts(a, active, deps, projects));
    const lev = new Map(leverage(active.map(toPlanItem), deps).map((l) => [l.taskId, l]));
    const suggestions = targets
      .filter((t) => judgments.has(t.id))
      .map((t) => suggestPriority(t, judgments.get(t.id)!, lev.get(t.id), today));

    const mine = this.mine(a);
    const byId = new Map(active.map((t) => [t.id, t]));
    const scores = new Map(suggestions.filter((s) => mine(byId.get(s.taskId)!)).map((s) => [s.taskId, s.score]));
    const focusId = pickFocus(active, deps, scores, today);
    const focus = focusId ? { taskId: focusId, reasons: suggestions.find((s) => s.taskId === focusId)!.reasons } : null;

    // Changes first (biggest jump first), then the rest by score.
    suggestions.sort(
      (x, y) =>
        Number(y.suggested !== y.current) - Number(x.suggested !== x.current) ||
        Math.abs(y.suggested - y.current) - Math.abs(x.suggested - x.current) ||
        y.score - x.score,
    );
    return { today, model, suggestions, focus };
  }

  // ───────────────────────────── B. what to postpone

  async postpone(a: Access, input: JevPostponeInput): Promise<PostponePlan> {
    const today = todayIn(a.user.timezone);
    const [{ active, deps }, projects] = await Promise.all([this.plan(a), this.projectMap(a)]);
    const mine = this.mine(a);
    const end = input.scope === 'today' ? today : addDays(today, 6);
    const considered = active.filter((t) => {
      if (!mine(t) || t.fixed || !canEditTask(t, a)) return false;
      const d = t.dueDate ?? t.startDate;
      return isToday(t, today) || (!!d && d <= end);
    });
    const { judgments } = await this.judge(a, considered, this.contexts(a, active, deps, projects));

    let capacity = input.capacity;
    let capacitySource: PostponePlan['capacitySource'] = 'input';
    if (capacity === undefined) {
      const done = await this.tasks.list(a, { view: 'done', limit: 500 }, today);
      const tz = a.user.timezone;
      const fromHistory = capacityFromHistory(
        done.filter(mine).map((t) => (t.completedAt ? todayIn(tz, new Date(t.completedAt)) : null)),
        today,
      );
      capacity = fromHistory.capacity;
      capacitySource = fromHistory.source;
    }

    return planPostpone({
      tasks: active,
      deps,
      mine,
      editable: (t) => canEditTask(t, a),
      judgments,
      today,
      scope: input.scope,
      capacity,
      capacitySource,
    });
  }

  // ───────────────────────────── C. triage for a new task

  async triage(a: Access, input: JevTriageInput): Promise<TriageSuggestion> {
    const today = todayIn(a.user.timezone);
    const askProject = input.projectId === undefined;
    let projects: Project[] = [];
    let recent = new Map<string, string[]>();
    if (askProject) {
      projects = (await this.projects.list(a))
        .filter((p) => p.access === 'edit' || p.access === 'manage')
        .sort((x, y) => x.position - y.position)
        .slice(0, 120);
      const known = await this.tasks.listForClient(a, 60);
      recent = new Map();
      for (const t of [...known].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
        if (!t.projectId) continue;
        const l = recent.get(t.projectId) ?? [];
        if (l.length < 6) l.push(excerpt(t.title, 80));
        recent.set(t.projectId, l);
      }
    }
    const withProjects = askProject && projects.length > 0;

    const state = {
      today: todayLabel(today),
      new_task: {
        title: excerpt(input.title, 300),
        ...(input.notes?.trim() ? { notes: excerpt(input.notes, 360) } : {}),
        ...(input.startDate && input.startDate !== input.dueDate ? { starts: dayLabel(input.startDate, today) } : {}),
        ...(input.dueDate ? { due: dayLabel(input.dueDate, today) } : {}),
      },
      ...(withProjects
        ? {
            projects: Object.fromEntries(
              projects.map((p, i) => [`p${i + 1}`, { name: p.name, ...(recent.get(p.id)?.length ? { recent_tasks: recent.get(p.id) } : {}) }]),
            ),
          }
        : {}),
    };
    const key = `${a.userId}:triage:${a.workspaceId}:${sha256(QUESTIONS_VERSION + JSON.stringify(state))}`;
    const hit = this.cached<TriageSuggestion>(key);
    if (hit) return hit;

    const ref = '`new_task`';
    const questions: Record<string, JevQuestion> = {
      importance: importanceQ(ref),
      others: othersQ(ref),
      fixed: fixedQ(ref),
      ...(withProjects ? { project: projectQ(projects.map((p) => p.name)), fits: fitsQ() } : {}),
    };
    const r = await this.ask(a.user, { state, questions });

    const imp = r.answers.importance;
    const j: TaskJudgment = {
      importance: imp?.type === 'score' ? imp.score : NEUTRAL_JUDGMENT.importance,
      importanceConfidence: imp?.type === 'score' ? imp.confidence : 0,
      others: noul(r.answers.others) ?? NEUTRAL_JUDGMENT.others,
      deferrable: NEUTRAL_JUDGMENT.deferrable,
    };
    const fixedP = noul(r.answers.fixed) ?? 0;
    const fixed = fixedP >= FIXED_THRESHOLD;
    const p = suggestPriority(
      { id: 'new', priority: 0, dueDate: input.dueDate ?? null, startDate: input.startDate ?? null, fixed, status: 'todo' },
      j,
      undefined,
      today,
    );
    const out: TriageSuggestion = {
      priority: { value: p.suggested, confidence: p.confidence, reasons: p.reasons },
      fixed: { value: fixed, probability: fixedP },
    };
    if (askProject) {
      const choice = r.answers.project;
      const fits = noul(r.answers.fits);
      if (!withProjects || choice?.type !== 'choice' || choice.choice === 'none' || (fits !== null && fits < 0.4)) {
        out.project = { id: null, confidence: choice?.type === 'choice' && choice.choice === 'none' ? choice.confidence : fits !== null ? 1 - fits : 0 };
      } else {
        const project = projects[Number(choice.choice.slice(1)) - 1];
        out.project = project
          ? { id: project.id, confidence: Math.min(choice.probabilities[choice.choice] ?? choice.confidence, fits ?? 1) }
          : { id: null, confidence: 0 };
      }
    }
    this.remember(key, out);
    return out;
  }

  // ───────────────────────────── D. dependencies

  async dependencies(a: Access, taskId: string): Promise<DependencyResult> {
    const today = todayIn(a.user.timezone);
    const task = await this.tasks.get(a, taskId);
    const [{ active, deps }, projects] = await Promise.all([this.plan(a), this.projectMap(a)]);
    // Anything already ordered with this task (directly or through others) needs no new link.
    const related = new Set([...downstreamOf(deps, task.id), ...upstreamOf(deps, task.id)]);
    const anchor = task.dueDate ?? task.startDate;
    const distance = (t: Task) => {
      const d = t.dueDate ?? t.startDate;
      return d && anchor ? Math.abs(Date.parse(d) - Date.parse(anchor)) : Number.MAX_SAFE_INTEGER;
    };
    const candidates = active
      .filter((t) => t.id !== task.id && !related.has(t.id))
      .filter((t) => !wouldCreateCycle(deps, task.id, t.id) || !wouldCreateCycle(deps, t.id, task.id))
      .sort(
        (x, y) =>
          Number(y.projectId === task.projectId) - Number(x.projectId === task.projectId) || distance(x) - distance(y) || y.number - x.number,
      )
      .slice(0, MAX_CANDIDATES);
    if (!candidates.length) return { taskId: task.id, blockedBy: [], blocks: [] };

    const ctx = this.contexts(a, active, deps, projects);
    const state = {
      today: todayLabel(today),
      ...(task.projectId && projects.get(task.projectId) ? { project: projects.get(task.projectId)!.name } : {}),
      task: taskState(task, ctx(task), today, { dates: false }),
      candidates: Object.fromEntries(
        candidates.map((c, i) => [`c${i + 1}`, taskState(c, { ...ctx(c), waiting: [], waitsOn: [] }, today, { dates: false })]),
      ),
    };
    const key = `${a.userId}:deps:${sha256(QUESTIONS_VERSION + JSON.stringify(state))}`;
    let answers = this.cached<Record<string, JevAnswer>>(key);
    if (!answers) {
      const questions: Record<string, JevQuestion> = {};
      candidates.forEach((_, i) => {
        questions[`c${i + 1}`] = relationQ(`\`candidates.c${i + 1}\``, '`task`');
      });
      answers = (await this.ask(a.user, { state, questions })).answers;
      this.remember(key, answers);
    }

    const blockedBy: DependencySuggestion[] = [];
    const blocks: DependencySuggestion[] = [];
    candidates.forEach((c, i) => {
      const ans = answers![`c${i + 1}`];
      if (ans?.type !== 'choice') return;
      const before = ans.probabilities.before ?? 0;
      const after = ans.probabilities.after ?? 0;
      // Links across projects are rarer: only when Jev is clearly sure.
      const bar = c.projectId === task.projectId ? DEPENDENCY_THRESHOLD : CROSS_PROJECT_THRESHOLD;
      if (before >= bar && canEditTask(task, a) && !wouldCreateCycle(deps, task.id, c.id)) {
        blockedBy.push({ taskId: c.id, direction: 'blockedBy', probability: before });
      } else if (after >= bar && canEditTask(c, a) && !wouldCreateCycle(deps, c.id, task.id)) {
        blocks.push({ taskId: c.id, direction: 'blocks', probability: after });
      }
    });
    const top = (l: DependencySuggestion[]) => l.sort((x, y) => y.probability - x.probability).slice(0, 5);
    return { taskId: task.id, blockedBy: top(blockedBy), blocks: top(blocks) };
  }
}
