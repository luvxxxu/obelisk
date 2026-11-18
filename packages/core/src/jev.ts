/**
 * Jev advisor — the pure half.
 *
 * Jev (TypeSafe's System One model) answers small typed questions about each task:
 * how much is at stake, whether it could wait a few days, whether someone is waiting
 * on it. It never sees or changes dates on its own. Deadlines, ripples and fixed-date
 * conflicts stay with the delay-impact engine (impact.ts), and this file combines the
 * two in code with weights you can read and test.
 *
 * No I/O: the backend asks Jev and calls these, the web app only renders the result.
 */
import { z } from 'zod';
import { addDays, diffDays, type ISODate } from './dates';
import { simulate, type PlanDependency, type PlanItem, type TaskLeverage } from './impact';
import { isoDate, uuid } from './schemas';
import type { Priority, Task } from './types';
import { isToday } from './views';

// ───────────────────────────── settings

/**
 * Where judgments come from. Anything that speaks TypeSafe's System One API (state + typed questions →
 * probabilities) works: TypeSafe itself, OpenRouter, Cloudflare Workers AI (Clef, within its daily free
 * allocation) or another compatible server. A base URL like `https://openrouter.ai/api/v1` gets
 * `/systemone` appended; a full endpoint (ending in `/systemone`, or Workers AI's `/ai/run/<model>`) is used as is.
 */
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1';

/** The request URL for a base URL. */
export function jevEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const path = (() => {
    try {
      return new URL(base).pathname;
    } catch {
      return base;
    }
  })();
  return /\/systemone$/.test(path) || /\/ai\/run\//.test(path) ? base : `${base}/systemone`;
}

/** Ready-made settings for services known to serve the System One API. */
export const JEV_PRESETS = [
  {
    id: 'typesafe',
    label: 'TypeSafe',
    baseUrl: DEFAULT_JEV_BASE_URL,
    models: ['jev-latest'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['~typesafe/jev-latest', 'typesafe/jev-1.14', 'typesafe/jev-1.13'],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    /** Needs the account ID and the model in the path: see `cloudflareJevUrl`. */
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts',
    models: ['clef', 'clef-flash'],
  },
] as const;
export type JevPresetId = (typeof JEV_PRESETS)[number]['id'];

/** Workers AI's endpoint for one of Cloudflare's own decision models. */
export const cloudflareJevUrl = (accountId: string, model: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/ai/run/@cf/cloudflare/${model.trim()}`;

/** Which preset a stored base URL belongs to (null: a custom server). */
export function jevPresetOf(baseUrl: string | null): JevPresetId | null {
  let host: string;
  try {
    host = new URL(baseUrl ?? DEFAULT_JEV_BASE_URL).hostname;
  } catch {
    return null;
  }
  if (host === 'api.typesafe.ai') return 'typesafe';
  if (host === 'openrouter.ai') return 'openrouter';
  if (host === 'api.cloudflare.com') return 'cloudflare';
  return null;
}

/** The signed-in user's Jev connection (their own key for a System One service). */
export interface JevStatus {
  /** A key is stored and this server can open it. */
  connected: boolean;
  /** A key is stored but can't be opened any more (the server's secret changed): enter it again. */
  keyUnreadable: boolean;
  /** Last characters of the key, to tell keys apart. */
  hint: string | null;
  /** Apply high-confidence judgments without asking (new tasks, unset priorities). */
  autoApply: boolean;
  /** The service's base URL; null = TypeSafe (DEFAULT_JEV_BASE_URL). */
  baseUrl: string | null;
  /** The model asked; null = the server's default (JEV_MODEL, else jev-latest). */
  model: string | null;
}

/** Judgments at or above this confidence count as "확신" (auto-apply, preselected). */
export const JEV_CONFIDENT = 0.8;

export const jevSettingsInput = z.object({
  /** A new key (checked with one tiny call before it is saved), or null to disconnect. */
  apiKey: z
    .string()
    .trim()
    .min(16, 'API 키가 너무 짧아요')
    .max(512)
    .regex(/^\S+$/, 'API 키에는 공백이 들어갈 수 없어요')
    .nullable()
    .optional(),
  /** The service's base URL or full endpoint; null = TypeSafe. Moving to another host needs the key again. */
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^https?:\/\/\S+$/i, 'Base URL은 https://로 시작해야 해요')
    .nullable()
    .optional(),
  /** Model id as the service names it (`jev-latest`, `~typesafe/jev-latest`, `clef` …); null = default. */
  model: z.string().trim().min(1, '모델을 입력하세요').max(200).regex(/^\S+$/, '모델 이름에는 공백이 들어갈 수 없어요').nullable().optional(),
  autoApply: z.boolean().optional(),
});
export type JevSettingsInput = z.infer<typeof jevSettingsInput>;

export const jevPrioritiesInput = z.object({
  /** Only these tasks (default: every active task you can edit). */
  taskIds: z.array(uuid).max(500).optional(),
});

export const jevPostponeInput = z.object({
  scope: z.enum(['today', 'week']).default('today'),
  /** Tasks per day you can handle. Default: your recent pace (completions per day). */
  capacity: z.number().int().min(1).max(50).optional(),
});
export type JevPostponeInput = z.infer<typeof jevPostponeInput>;

export const jevTriageInput = z.object({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(4000).optional(),
  startDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  /** Already chosen by the user: Jev does not pick a project. */
  projectId: uuid.nullable().optional(),
});
export type JevTriageInput = z.infer<typeof jevTriageInput>;

export const jevDependenciesInput = z.object({ taskId: uuid });

// ───────────────────────────── judgments

/** What Jev said about one task. */
export interface TaskJudgment {
  /** 0 someday · 1 minor · 2 real obligation · 3 high stakes (continuous). */
  importance: number;
  /** How sure Jev is about the importance level, 0..1. */
  importanceConfidence: number;
  /** Probability that someone else is waiting on it or affected when it is late. */
  others: number;
  /** Probability that it can move a few days later without real harm. */
  deferrable: number;
}

/** Used when Jev has no answer for a task: it neither pushes nor holds anything. */
export const NEUTRAL_JUDGMENT: TaskJudgment = { importance: 1.5, importanceConfidence: 0, others: 0.5, deferrable: 0.5 };

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export const IMPORTANCE_LABEL_KO = ['언젠가 해도 되는 일', '가벼운 일', '꼭 해야 하는 일', '놓치면 손해가 큰 일'] as const;

export function importanceLevel(j: Pick<TaskJudgment, 'importance'>): 0 | 1 | 2 | 3 {
  return Math.max(0, Math.min(3, Math.round(j.importance))) as 0 | 1 | 2 | 3;
}

// ───────────────────────────── urgency & leverage (deterministic)

export interface Urgency {
  /** 0 (no date, far away) … 1 (overdue). */
  value: number;
  /** Days until the due date (negative = overdue), null without one. */
  days: number | null;
  label: string | null;
}

type Dated = Pick<Task, 'dueDate' | 'startDate' | 'fixed' | 'status'>;

export function urgencyOf(t: Dated, today: ISODate): Urgency {
  let u: Urgency;
  if (t.dueDate) {
    const d = diffDays(t.dueDate, today);
    const value = d < 0 ? 1 : d === 0 ? 0.95 : d === 1 ? 0.85 : d <= 3 ? 0.7 : d <= 7 ? 0.5 : d <= 14 ? 0.3 : 0.15;
    const label = d < 0 ? `${-d}일 지남` : d === 0 ? '오늘 마감' : d === 1 ? '내일 마감' : `마감 ${d}일 남음`;
    u = { value, days: d, label };
  } else if (t.startDate) {
    const s = diffDays(t.startDate, today);
    u = { value: s <= 0 ? 0.5 : s <= 3 ? 0.35 : 0.15, days: null, label: s <= 0 ? '시작일 지남' : s === 1 ? '내일 시작' : `${s}일 뒤 시작` };
  } else {
    u = { value: t.status === 'doing' ? 0.3 : 0.1, days: null, label: null };
  }
  // A fixed commitment this week is urgent however Jev reads the title.
  const first = t.startDate ?? t.dueDate;
  if (t.fixed && first && diffDays(first, today) <= 7) u = { ...u, value: Math.max(u.value, 0.6) };
  return u;
}

/** 0..1: how much of the plan waits on this task (from the engine's one-day-slip test). */
export function leverageScore(l: TaskLeverage | undefined): number {
  if (!l) return 0;
  if (l.conflictsIfLate > 0) return 1;
  return clamp01(l.delayedIfLate * 0.25 + l.downstreamCount * 0.08 + (l.slackDays === 0 ? 0.2 : 0));
}

// ───────────────────────────── A. priority

/** Score cut points for high / medium / low. Below `low` the task gets no priority. */
export const PRIORITY_CUTS = { high: 0.64, medium: 0.4, low: 0.17 } as const;

/**
 * Importance sets the ceiling, urgency decides how much of it applies now: a high-stakes task
 * due in three weeks lands on 보통 and climbs to 높음 as the date nears, while tidying a desk
 * due today stays 낮음. Tasks that hold the plan together get a bump.
 */
export function priorityScore(j: TaskJudgment, urgency: number, leverage: number): number {
  const i = clamp01(j.importance / 3);
  return clamp01(i * (0.55 + 0.45 * clamp01(urgency)) + 0.15 * clamp01(leverage) + 0.06 * clamp01(j.others));
}

export function priorityFromScore(score: number): Priority {
  if (score >= PRIORITY_CUTS.high) return 3;
  if (score >= PRIORITY_CUTS.medium) return 2;
  if (score >= PRIORITY_CUTS.low) return 1;
  return 0;
}

/** Jev's own certainty, discounted when the score sits right on a cut point. */
export function priorityConfidence(j: TaskJudgment, score: number): number {
  const margin = Math.min(...Object.values(PRIORITY_CUTS).map((c) => Math.abs(score - c)));
  return clamp01(j.importanceConfidence * (0.55 + 0.45 * Math.min(1, margin / 0.08)));
}

export interface PrioritySuggestion {
  taskId: string;
  current: Priority;
  suggested: Priority;
  /** 0..1 composite score. */
  score: number;
  confidence: number;
  /** Short Korean reasons, most important first. */
  reasons: string[];
  judgment: TaskJudgment;
}

type PriorityTask = Pick<Task, 'id' | 'priority' | 'dueDate' | 'startDate' | 'fixed' | 'status'>;

export function suggestPriority(
  t: PriorityTask,
  j: TaskJudgment,
  lev: TaskLeverage | undefined,
  today: ISODate,
): PrioritySuggestion {
  const u = urgencyOf(t, today);
  const l = leverageScore(lev);
  const score = priorityScore(j, u.value, l);
  const reasons: string[] = [`${IMPORTANCE_LABEL_KO[importanceLevel(j)]}`];
  if (u.label) reasons.push(u.label);
  if (lev && lev.conflictsIfLate > 0) reasons.push('하루 늦으면 고정 일정과 충돌');
  else if (lev && lev.delayedIfLate > 0) reasons.push(`하루 늦으면 ${lev.delayedIfLate}개 밀림`);
  else if (lev && lev.downstreamCount > 0) reasons.push(`${lev.downstreamCount}개 작업이 기다림`);
  if (j.others >= 0.7) reasons.push('다른 사람이 기다리는 일');
  if (t.fixed) reasons.push('고정 일정');
  return {
    taskId: t.id,
    current: t.priority,
    suggested: priorityFromScore(score),
    score,
    confidence: priorityConfidence(j, score),
    reasons,
    judgment: j,
  };
}

/** Auto-apply only fills in a missing priority: a level the user picked is never overridden silently. */
export function autoApplicable(s: PrioritySuggestion): boolean {
  return s.current === 0 && s.suggested !== 0 && s.confidence >= JEV_CONFIDENT;
}

/** Active tasks still waiting on an unfinished blocker can't be started yet. */
export function isBlocked(id: string, deps: readonly PlanDependency[], status: (id: string) => Task['status'] | undefined): boolean {
  return deps.some((d) => {
    if (d.taskId !== id) return false;
    const s = status(d.dependsOnId);
    return s === 'todo' || s === 'doing';
  });
}

/**
 * "지금 할 일 하나": the best-scoring task you can start right now — something for today
 * (overdue, due, started or in progress) whose blockers are all done. Finishing what is already
 * in progress wins ties. Falls back to the next three days when today is clear.
 */
export function pickFocus(
  tasks: readonly Pick<Task, 'id' | 'status' | 'dueDate' | 'startDate' | 'priority' | 'projectId' | 'number' | 'completedAt' | 'position'>[],
  deps: readonly PlanDependency[],
  scores: ReadonlyMap<string, number>,
  today: ISODate,
): string | null {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  const startable = tasks.filter(
    (t) => (t.status === 'todo' || t.status === 'doing') && scores.has(t.id) && !isBlocked(t.id, deps, (id) => status.get(id)),
  );
  const soon = addDays(today, 3);
  const pools = [
    startable.filter((t) => isToday(t, today)),
    startable.filter((t) => {
      const d = t.startDate ?? t.dueDate;
      return !!d && d <= soon;
    }),
  ];
  for (const pool of pools) {
    if (!pool.length) continue;
    const rank = (t: (typeof pool)[number]) => scores.get(t.id)! + (t.status === 'doing' ? 0.05 : 0);
    return [...pool].sort((a, b) => rank(b) - rank(a) || a.number - b.number)[0]!.id;
  }
  return null;
}

// ───────────────────────────── B. what to postpone

export type PostponeVerdict = 'postpone' | 'could' | 'keep' | 'fixed';

export interface PostponeCandidate {
  taskId: string;
  verdict: PostponeVerdict;
  /** The day the task currently counts on. */
  day: ISODate;
  /** Proposed new due (or start) date, when the task can move. */
  toDate: ISODate | null;
  /** Days its due date moves (what the engine propagates). */
  shiftDays: number;
  /** Other tasks that move with it (cascade), and fixed dates it would break (always 0 when proposed). */
  delayed: number;
  /** 0..1: how safely it can wait. */
  score: number;
  reasons: string[];
}

export interface PostponeDayLoad {
  date: ISODate;
  /** Tasks counting on this day now / after the recommended moves. */
  load: number;
  after: number;
}

export interface PostponePlan {
  scope: 'today' | 'week';
  today: ISODate;
  capacity: number;
  capacitySource: 'input' | 'history' | 'default';
  overloaded: boolean;
  days: PostponeDayLoad[];
  /** Recommended moves first (best to postpone first), then the rest. */
  candidates: PostponeCandidate[];
}

type PlanTask = Task;

/** Tasks per day you usually finish: last 14 days' completions, clamped to 3..15. Few data points → 5. */
export function capacityFromHistory(completedOn: readonly (ISODate | null)[], today: ISODate): { capacity: number; source: 'history' | 'default' } {
  const from = addDays(today, -14);
  const n = completedOn.filter((d) => !!d && d >= from && d < today).length;
  if (n < 7) return { capacity: 5, source: 'default' };
  return { capacity: Math.min(15, Math.max(3, Math.ceil(n / 14 + 0.5))), source: 'history' };
}

/** The day a task counts on: today for anything in Today, else its due (or start) date. */
function dayOf(t: PlanTask, today: ISODate): ISODate | null {
  if (isToday(t, today)) return today;
  return t.dueDate ?? t.startDate;
}

/** Below this, Jev's "it can wait" is not enough to recommend a move. */
const MIN_POSTPONE_SCORE = 0.38;
/** How far ahead to look for a lighter day. */
const SEARCH_DAYS = 7;

export function planPostpone(opts: {
  /** Every active task in the plan (the engine needs all of them for ripples). */
  tasks: readonly PlanTask[];
  deps: readonly PlanDependency[];
  /** Which of `tasks` are yours to rearrange (in an organization: assigned to you, or yours and unassigned). */
  mine: (t: PlanTask) => boolean;
  editable: (t: PlanTask) => boolean;
  judgments: ReadonlyMap<string, TaskJudgment>;
  today: ISODate;
  scope: 'today' | 'week';
  capacity: number;
  capacitySource: PostponePlan['capacitySource'];
}): PostponePlan {
  const { tasks, deps, judgments, today, scope, capacity } = opts;
  const items: PlanItem[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    number: t.number,
    status: t.status,
    startDate: t.startDate,
    dueDate: t.dueDate,
    fixed: t.fixed,
    projectId: t.projectId,
  }));
  const active = tasks.filter((t) => (t.status === 'todo' || t.status === 'doing') && opts.mine(t));

  // Load per day across the scope plus the search window.
  const load = new Map<ISODate, number>();
  for (const t of active) {
    const d = dayOf(t, today);
    if (d) load.set(d, (load.get(d) ?? 0) + 1);
  }
  const span = scope === 'today' ? 1 : 7;
  const scopeDays = Array.from({ length: span }, (_, i) => addDays(today, i));
  const initial = new Map(scopeDays.map((d) => [d, load.get(d) ?? 0]));

  const considered = active.filter((t) => {
    const d = dayOf(t, today);
    return !!d && d >= today && d <= scopeDays.at(-1)!;
  });

  interface Work {
    t: PlanTask;
    day: ISODate;
    base: number;
    reasons: string[];
    verdict: PostponeVerdict | null;
    toDate: ISODate | null;
    shiftDays: number;
    delayed: number;
  }

  const work: Work[] = considered.map((t) => {
    const day = dayOf(t, today)!;
    const j = judgments.get(t.id) ?? NEUTRAL_JUDGMENT;
    const reasons: string[] = [];
    let base = 0.6 * clamp01(j.deferrable) + 0.4 * (1 - clamp01(j.importance / 3));
    if (j.deferrable >= 0.7) reasons.push('며칠 미뤄도 괜찮은 일');
    else if (j.deferrable <= 0.35) reasons.push('미루면 곤란한 일');
    reasons.push(IMPORTANCE_LABEL_KO[importanceLevel(j)]);
    if (t.status === 'doing') {
      base -= 0.15;
      reasons.push('이미 진행 중');
    }
    if (t.postponedCount >= 2) {
      base -= Math.min(0.2, 0.05 * t.postponedCount);
      reasons.push(`이미 ${t.postponedCount}번 미룸`);
    }
    if (j.others >= 0.7) {
      base -= 0.1;
      reasons.push('다른 사람이 기다리는 일');
    }
    const w: Work = { t, day, base: clamp01(base), reasons, verdict: null, toDate: null, shiftDays: 0, delayed: 0 };
    if (t.fixed) {
      w.verdict = 'fixed';
      w.reasons = ['고정 일정이라 옮기지 않아요'];
    } else if (!opts.editable(t)) {
      w.verdict = 'keep';
      w.reasons = ['보기 전용이라 옮길 수 없어요', ...reasons];
    } else if (!t.dueDate && !t.startDate) {
      w.verdict = 'keep';
      w.reasons = ['날짜가 없어 미룰 대상이 아니에요', ...reasons];
    } else if (t.dueDate && t.dueDate > day) {
      // Started already, due later: it isn't due on this day, so there is nothing to move.
      w.verdict = 'keep';
      w.reasons = ['마감이 남아 있어 옮길 필요가 없어요', ...reasons];
    }
    return w;
  });

  /**
   * Nearest day within the window that breaks no fixed date — preferring one that still keeps a
   * task's worth of headroom, so moved work spreads out instead of piling onto tomorrow.
   */
  const findSlot = (w: Work) => {
    const anchor = (w.t.dueDate ?? w.t.startDate)!;
    const limits = capacity >= 3 ? [capacity - 1, capacity] : [capacity];
    for (const limit of limits) {
      for (let k = 1; k <= SEARCH_DAYS; k++) {
        const target = addDays(w.day, k);
        if ((load.get(target) ?? 0) + 1 > limit) continue;
        const shift = diffDays(target, anchor);
        if (shift <= 0) continue;
        const r = simulate(items, deps, { [w.t.id]: shift });
        if (r.summary.conflictCount > 0) continue;
        return { toDate: target, shiftDays: shift, delayed: r.summary.delayedCount };
      }
    }
    return null;
  };

  const ranked = (list: Work[]) => [...list].sort((a, b) => b.base - a.base || b.t.number - a.t.number);

  // Clear each overloaded day, best candidates first.
  let overloaded = false;
  for (const day of scopeDays) {
    let over = (load.get(day) ?? 0) - capacity;
    if (over <= 0) continue;
    overloaded = true;
    for (const w of ranked(work.filter((x) => x.day === day && x.verdict === null))) {
      if (over <= 0) break;
      if (w.base < MIN_POSTPONE_SCORE) continue;
      const slot = findSlot(w);
      if (!slot) continue;
      const score = clamp01(w.base - Math.min(0.3, slot.delayed * 0.1));
      if (score < MIN_POSTPONE_SCORE) continue;
      Object.assign(w, slot, { verdict: 'postpone' as const, base: score });
      load.set(day, (load.get(day) ?? 0) - 1);
      load.set(slot.toDate, (load.get(slot.toDate) ?? 0) + 1);
      over--;
    }
  }

  // Everything else: could it wait anyway (shown unchecked), or should it stay?
  for (const w of work) {
    if (w.verdict) continue;
    if (w.base >= MIN_POSTPONE_SCORE + 0.12) {
      const slot = findSlot(w);
      if (slot) {
        Object.assign(w, slot, { verdict: 'could' as const, base: clamp01(w.base - Math.min(0.3, slot.delayed * 0.1)) });
        continue;
      }
      w.reasons.unshift('옮길 만한 날이 없어요');
    }
    w.verdict = 'keep';
  }

  for (const w of work) {
    if (w.verdict !== 'postpone' && w.verdict !== 'could') continue;
    w.reasons.push(w.delayed > 0 ? `뒤따르는 작업 ${w.delayed}개가 함께 밀려요` : '다른 일정엔 영향 없음');
  }

  const order: Record<PostponeVerdict, number> = { postpone: 0, could: 1, keep: 2, fixed: 3 };
  const candidates = work
    .sort((a, b) => order[a.verdict!] - order[b.verdict!] || b.base - a.base || a.t.number - b.t.number)
    .map((w) => ({
      taskId: w.t.id,
      verdict: w.verdict!,
      day: w.day,
      toDate: w.toDate,
      shiftDays: w.shiftDays,
      delayed: w.delayed,
      score: w.base,
      reasons: w.reasons,
    }));

  return {
    scope,
    today,
    capacity,
    capacitySource: opts.capacitySource,
    overloaded,
    days: scopeDays.map((date) => ({ date, load: initial.get(date) ?? 0, after: load.get(date) ?? 0 })),
    candidates,
  };
}

// ───────────────────────────── C. triage, D. dependencies

export interface TriageSuggestion {
  /** null id = inbox. Omitted when the user already picked a project. */
  project?: { id: string | null; confidence: number };
  priority: { value: Priority; confidence: number; reasons: string[] };
  fixed: { value: boolean; probability: number };
}

/** A fixed-date commitment needs Jev to be fairly sure; a wrong pin blocks the ripple. */
export const FIXED_THRESHOLD = 0.75;

export interface DependencySuggestion {
  taskId: string;
  /** blockedBy: the other task should finish first. blocks: it should wait for this one. */
  direction: 'blockedBy' | 'blocks';
  probability: number;
}

export const DEPENDENCY_THRESHOLD = 0.65;
