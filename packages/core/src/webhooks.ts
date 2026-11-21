/**
 * Webhooks, shared by the server and the web app.
 *
 * Outgoing: every activity-log entry maps to at most one webhook event, and a periodic scan adds
 * schedule alerts (due today / tomorrow, overdue, fixed-date conflicts). Tasks with a time also get
 * reminders a set number of minutes before they start or are due. A webhook subscribes to
 * event *keys*; the payload's `event` is the precise name ("project.archived" under key "project").
 *
 * Incoming: a POST body (JSON, form or plain text) becomes one create or update command, run
 * with the permissions of whoever made the webhook.
 */
import { z } from 'zod';
import { viaLabelKo } from './activity';
import {
  addDays,
  clockIndex,
  diffDays,
  formatDurationKo,
  formatRelativeKo,
  formatTimeKo,
  fromMinutes,
  isISODate,
  isISOTime,
  isPastDue,
  nowIn,
  spanInOrder,
  toMinutes,
  type Clock,
  type ISODate,
  type ISOTime,
} from './dates';
import { forecast, type PlanDependency, type PlanItem } from './impact';
import { parseDateTimePhrase, parseQuickAdd, parseTimePhrase } from './quickadd';
import { uuid } from './schemas';
import type { ActivityVia, Priority, TaskStatus, WorkspaceKind } from './types';

// ───────────────────────────── catalog

export const WEBHOOK_FORMATS = ['json', 'slack', 'discord'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export const WEBHOOK_FORMAT_LABEL: Record<WebhookFormat, string> = { json: 'JSON', slack: 'Slack', discord: 'Discord' };

export const WEBHOOK_EVENT_KEYS = [
  'task.created',
  'task.completed',
  'task.updated',
  'task.postponed',
  'task.deleted',
  'task.dependency',
  'project',
  'organization',
  'task.due_today',
  'task.due_soon',
  'task.overdue',
  'fixed.conflict',
  'task.start_reminder',
  'task.due_reminder',
] as const;
export type WebhookEventKey = (typeof WEBHOOK_EVENT_KEYS)[number];

export const SCHEDULE_EVENT_KEYS = ['task.due_today', 'task.due_soon', 'task.overdue', 'fixed.conflict'] as const;
export type ScheduleEventKey = (typeof SCHEDULE_EVENT_KEYS)[number];

export function isScheduleEvent(key: string): key is ScheduleEventKey {
  return (SCHEDULE_EVENT_KEYS as readonly string[]).includes(key);
}

/** Minute-precise reminders for tasks that have a time, sent `remindMinutes` before it. */
export const REMINDER_EVENT_KEYS = ['task.start_reminder', 'task.due_reminder'] as const;
export type ReminderEventKey = (typeof REMINDER_EVENT_KEYS)[number];

export function isReminderEvent(key: string): key is ReminderEventKey {
  return (REMINDER_EVENT_KEYS as readonly string[]).includes(key);
}

/** How long before a task's time its reminder goes out. 0 = at that minute. */
export const REMINDER_LEAD_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440] as const;
export const DEFAULT_REMIND_MINUTES = 30;

export function remindLeadLabel(minutes: number): string {
  return minutes === 0 ? '정각에' : `${formatDurationKo(minutes)} 전`;
}

export interface WebhookEventOption {
  key: WebhookEventKey;
  label: string;
  hint: string;
}

export interface WebhookEventGroup {
  id: 'task' | 'project' | 'organization' | 'schedule';
  label: string;
  /** Only organizations have members, teams and invites. */
  orgOnly?: boolean;
  events: WebhookEventOption[];
}

export const WEBHOOK_EVENT_GROUPS: WebhookEventGroup[] = [
  {
    id: 'task',
    label: '작업',
    events: [
      { key: 'task.created', label: '새 작업', hint: '작업이 만들어지거나 휴지통에서 되살아날 때' },
      { key: 'task.completed', label: '완료', hint: '작업을 완료할 때' },
      { key: 'task.updated', label: '수정', hint: '제목·상태·날짜·담당자·우선순위가 바뀔 때' },
      { key: 'task.postponed', label: '미룸', hint: '미루기를 적용할 때 (연쇄 이동 포함)' },
      { key: 'task.deleted', label: '삭제', hint: '작업을 휴지통으로 옮길 때' },
      { key: 'task.dependency', label: '선행 작업', hint: '선행 작업을 연결하거나 해제할 때' },
    ],
  },
  {
    id: 'project',
    label: '프로젝트',
    events: [{ key: 'project', label: '프로젝트 변경', hint: '생성·이름·보관·삭제·공유 설정·공간 이동' }],
  },
  {
    id: 'organization',
    label: '조직',
    orgOnly: true,
    events: [{ key: 'organization', label: '멤버·팀·초대', hint: '참여·역할 변경·내보내기, 팀, 초대 링크, 조직 설정' }],
  },
  {
    id: 'schedule',
    label: '일정 알림',
    events: [
      { key: 'task.due_today', label: '오늘 마감', hint: '마감일 당일' },
      { key: 'task.due_soon', label: '내일 마감', hint: '마감 하루 전' },
      { key: 'task.overdue', label: '기한 지남', hint: '마감이 지난 동안 하루 한 번' },
      { key: 'fixed.conflict', label: '고정 일정 충돌', hint: '선행 작업이 늦어 고정 일정을 넘길 때' },
      { key: 'task.start_reminder', label: '시작 시각 알림', hint: '시작 시각이 있는 작업, 정한 시간 전에' },
      { key: 'task.due_reminder', label: '마감 시각 알림', hint: '마감 시각이 있는 작업, 정한 시간 전에' },
    ],
  },
];

export const WEBHOOK_EVENT_LABEL: Record<WebhookEventKey, string> = Object.fromEntries(
  WEBHOOK_EVENT_GROUPS.flatMap((g) => g.events.map((e) => [e.key, e.label])),
) as Record<WebhookEventKey, string>;

export const DEFAULT_WEBHOOK_EVENTS: WebhookEventKey[] = [
  'task.created',
  'task.completed',
  'task.postponed',
  'task.overdue',
  'fixed.conflict',
];

/** Which subscription an activity entry belongs to, and the event name it is sent as. */
export function webhookEventFor(
  action: string,
  data: Record<string, unknown> | undefined,
): { key: WebhookEventKey; event: string } | null {
  switch (action) {
    case 'task.created':
    case 'task.postponed':
    case 'task.deleted':
      return { key: action, event: action };
    // Back from the trash: it reappears, so 새 작업 subscribers hear about it under its own name.
    case 'task.restored':
      return { key: 'task.created', event: action };
    case 'task.updated': {
      const status = (data?.changes as Record<string, { to?: unknown }> | undefined)?.status;
      return status?.to === 'done' ? { key: 'task.completed', event: 'task.completed' } : { key: 'task.updated', event: action };
    }
    case 'dependency.added':
    case 'dependency.removed':
      return { key: 'task.dependency', event: action };
  }
  const head = action.split('.')[0]!;
  if (head === 'project') return { key: 'project', event: action };
  if (head === 'member' || head === 'invite' || head === 'team' || head === 'workspace') return { key: 'organization', event: action };
  return null;
}

/** Slack and Discord incoming-webhook URLs get a chat message instead of raw JSON. */
export function detectWebhookFormat(url: string): WebhookFormat {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'hooks.slack.com') return 'slack';
    if (/^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/.test(host) && u.pathname.startsWith('/api/webhooks/')) return 'discord';
  } catch {}
  return 'json';
}

/** The part of a URL that is safe to show in a list (Slack/Discord paths are the secret). */
export function maskWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    if (!path || path === '/') return u.host;
    const segments = path.split('/').filter(Boolean);
    const first = segments[0]!;
    const tail = path.slice(-4);
    return segments.length > 1 || path.length > 24 ? `${u.host}/${first}/…${tail}` : `${u.host}${path}`;
  } catch {
    return url.slice(0, 32);
  }
}

// ───────────────────────────── payload

export interface WebhookTaskRef {
  id: string;
  /** "#12" */
  ref: string;
  number: number;
  title: string;
  status: TaskStatus;
  priority: Priority;
  startDate: ISODate | null;
  /** "HH:MM" in the user's time zone, or null for the whole day. */
  startTime: ISOTime | null;
  dueDate: ISODate | null;
  dueTime: ISOTime | null;
  fixed: boolean;
  project: { id: string; name: string } | null;
  /** Everyone working on it, in the order they were added (empty = unassigned). */
  assignees: { id: string; name: string }[];
  url: string;
}

export interface WebhookPayload {
  /** One per event: a redelivery keeps it, so a receiver can skip duplicates. */
  id: string;
  event: string;
  createdAt: string;
  workspace: { id: string; name: string; kind: WorkspaceKind };
  /** Who did it; null for schedule alerts and tests. */
  actor: { id: string | null; name: string; via: ActivityVia; client: string | null } | null;
  /** What it is about, as Obelisk shows it: "#12 기획서", a project or a member name. */
  subject: string;
  /** What happened, without actor or subject: "마감일 11/20 → 11/22". */
  summary: string;
  /** One readable line: "민겸 · #12 기획서 — 마감일 11/20 → 11/22". */
  text: string;
  /** Link to the task or project in Obelisk, when there is one. */
  url: string | null;
  /** Task events; null when the task no longer exists (deleted). */
  task?: WebhookTaskRef | null;
  /** Project events. */
  project?: { id: string; name: string; url: string | null } | null;
  /** before → after per changed field (task.updated, task.completed, project.updated …). */
  changes?: Record<string, unknown>;
  /** The activity entry's details as recorded. */
  data?: Record<string, unknown>;
  /** Schedule alerts and reminders. */
  alert?: {
    date: ISODate;
    daysOverdue?: number;
    overrunDays?: number;
    cause?: { id: string; ref: string; title: string } | null;
    /** Reminders: the start or due moment, "YYYY-MM-DDTHH:MM" in the webhook's time zone. */
    at?: string;
    /** Reminders: minutes from the send until then (0 or less = now). */
    minutesLeft?: number;
  };
}

const PAYLOAD_ORDER = ['id', 'event', 'createdAt', 'workspace', 'actor', 'subject', 'summary', 'text', 'url', 'task', 'project', 'changes', 'alert', 'data'];

/** Stored payloads come back from jsonb with keys reordered; put them back in reading order before sending. */
export function orderPayload(p: WebhookPayload): WebhookPayload {
  const src = p as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PAYLOAD_ORDER) if (k in src) out[k] = src[k];
  for (const k of Object.keys(src)) if (!(k in out)) out[k] = src[k];
  return out as unknown as WebhookPayload;
}

export function webhookText(p: Pick<WebhookPayload, 'actor' | 'subject' | 'summary'>): string {
  const via = p.actor ? viaLabelKo(p.actor.via, p.actor.client) : null;
  const who = p.actor ? `${p.actor.name}${via ? ` (${via})` : ''}` : null;
  const head = [who, p.subject].filter(Boolean).join(' · ');
  return head ? `${head} — ${p.summary}` : p.summary;
}

const EMOJI: Record<string, string> = {
  'task.completed': '✅',
  'task.overdue': '⏰',
  'task.due_today': '📅',
  'task.due_soon': '📅',
  'task.start_reminder': '🔔',
  'task.due_reminder': '🔔',
  'fixed.conflict': '⚠️',
  ping: '👋',
};

const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const discordEscape = (s: string) => s.replace(/([\\*_~`|>[\]()#-])/g, '\\$1').replace(/@/g, '@\u200b');

/** Body for a Slack or Discord incoming webhook. Mentions are never triggered. */
export function chatMessage(p: WebhookPayload, format: 'slack' | 'discord'): Record<string, unknown> {
  const esc = format === 'slack' ? slackEscape : discordEscape;
  const via = p.actor ? viaLabelKo(p.actor.via, p.actor.client) : null;
  const who = p.actor ? `${format === 'slack' ? `*${esc(p.actor.name)}*` : `**${esc(p.actor.name)}**`}${via ? ` (${esc(via)})` : ''}` : null;
  let subject: string | null = null;
  if (p.subject) {
    if (!p.url) subject = esc(p.subject);
    else if (format === 'slack') subject = `<${p.url}|${esc(p.subject).replace(/\|/g, '¦')}>`;
    else subject = `[${esc(p.subject)}](<${p.url}>)`;
  }
  const head = [who, subject].filter(Boolean).join(' · ');
  const emoji = EMOJI[p.event];
  const line = `${emoji ? `${emoji} ` : ''}${head ? `${head} — ${esc(p.summary)}` : esc(p.summary)}`;
  if (format === 'slack') return { text: line.slice(0, 3000), unfurl_links: false, unfurl_media: false };
  return { content: line.slice(0, 2000), username: 'Obelisk', allowed_mentions: { parse: [] } };
}

// ───────────────────────────── schedule alerts

export interface ScheduleAlert {
  key: ScheduleEventKey;
  taskId: string;
  daysOverdue?: number;
  overrunDays?: number;
  /** For conflicts: the late task at the start of the chain. */
  causeId?: string | null;
  /** The task's due time, for the summary. */
  time?: ISOTime | null;
}

/**
 * What a periodic scan reports today: active tasks due today or tomorrow, overdue tasks, and
 * fixed tasks the live forecast pushes past their date (with the late task that started it).
 * With `now`, a task due today whose time has passed is already overdue.
 */
export function scheduleAlerts(
  items: readonly PlanItem[],
  deps: readonly PlanDependency[],
  today: ISODate,
  now?: Clock | null,
): ScheduleAlert[] {
  const out: ScheduleAlert[] = [];
  const tomorrow = addDays(today, 1);
  const clock = now && now.date === today ? now : null;
  for (const it of items) {
    if ((it.status !== 'todo' && it.status !== 'doing') || !it.dueDate) continue;
    const time = it.dueTime ?? null;
    const at = time ? { time } : {};
    if (it.dueDate < today || (clock && isPastDue(it.dueDate, time, clock)))
      out.push({ key: 'task.overdue', taskId: it.id, daysOverdue: diffDays(today, it.dueDate), ...at });
    else if (it.dueDate === today) out.push({ key: 'task.due_today', taskId: it.id, ...at });
    else if (it.dueDate === tomorrow) out.push({ key: 'task.due_soon', taskId: it.id, ...at });
  }
  const report = forecast(items, deps, today);
  const byId = new Map(report.impacts.map((i) => [i.taskId, i]));
  for (const im of report.impacts) {
    if (im.kind !== 'conflict') continue;
    let cause = im.viaId;
    for (let hops = 0; cause && hops < 1000; hops++) {
      const up = byId.get(cause);
      if (!up || up.kind === 'root' || !up.viaId) break;
      cause = up.viaId;
    }
    out.push({ key: 'fixed.conflict', taskId: im.taskId, overrunDays: im.overrunDays, causeId: cause ?? null });
  }
  return out;
}

export function scheduleSummary(a: Pick<ScheduleAlert, 'key' | 'daysOverdue' | 'overrunDays' | 'time'>, cause?: string | null): string {
  const at = a.time ? ` ${formatTimeKo(a.time)}` : '';
  switch (a.key) {
    case 'task.due_today':
      return `오늘${at} 마감`;
    case 'task.due_soon':
      return `내일${at} 마감`;
    case 'task.overdue':
      return a.daysOverdue ? `마감 ${a.daysOverdue}일 지남` : `마감 시각${at} 지남`;
    case 'fixed.conflict':
      return `고정 일정 충돌 · ${cause ? `${cause} ` : '선행 작업 '}지연으로 ${a.overrunDays ?? 1}일 넘침`;
  }
}

export interface Reminder {
  key: ReminderEventKey;
  taskId: string;
  date: ISODate;
  time: ISOTime;
  /** From `now` until the moment (0 or less = it is that minute or just past). */
  minutesLeft: number;
}

/**
 * Reminders due now for tasks with a time: from `lead` minutes before the moment until the moment
 * itself (a short grace after it when `lead` is 0, so a late scan still catches it). The caller
 * dedupes on task + moment, so moving a task's time arms a fresh reminder.
 */
export function reminderAlerts(
  items: readonly PlanItem[],
  now: Clock,
  lead: number,
  keys: readonly ReminderEventKey[] = REMINDER_EVENT_KEYS,
): Reminder[] {
  const out: Reminder[] = [];
  const at = clockIndex(now.date, now.minutes);
  const want = new Set(keys);
  const check = (key: ReminderEventKey, it: PlanItem, date: ISODate | null, time: ISOTime | null | undefined) => {
    if (!want.has(key) || !date || !time) return;
    const target = clockIndex(date, toMinutes(time));
    const until = lead > 0 ? target : target + 10;
    if (at >= target - lead && at < until) out.push({ key, taskId: it.id, date, time, minutesLeft: target - at });
  };
  for (const it of items) {
    if (it.status === 'todo') check('task.start_reminder', it, it.startDate, it.startTime);
    if (it.status === 'todo' || it.status === 'doing') check('task.due_reminder', it, it.dueDate, it.dueTime);
  }
  return out;
}

export function reminderSummary(r: Pick<Reminder, 'key' | 'date' | 'time' | 'minutesLeft'>, today: ISODate): string {
  const what = r.key === 'task.start_reminder' ? '시작' : '마감';
  const day = r.date === today ? '' : `${formatRelativeKo(r.date, today)} `;
  const when = `${day}${formatTimeKo(r.time)}`;
  return r.minutesLeft <= 0 ? `지금 ${what} · ${when}` : `${formatDurationKo(r.minutesLeft)} 뒤 ${what} · ${when}`;
}

// ───────────────────────────── incoming

export interface IncomingPatch {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  priority?: Priority;
  startDate?: ISODate | null;
  startTime?: ISOTime | null;
  dueDate?: ISODate | null;
  dueTime?: ISOTime | null;
  fixed?: boolean;
}

export type IncomingCommand =
  | {
      kind: 'create';
      title: string;
      notes?: string;
      status?: TaskStatus;
      priority?: Priority;
      startDate?: ISODate | null;
      startTime?: ISOTime | null;
      dueDate?: ISODate | null;
      dueTime?: ISOTime | null;
      fixed?: boolean;
      /** A project name or id. */
      project?: string;
      /** Each an email, a member name, a user id or "me". */
      assignees?: string[];
    }
  | { kind: 'update'; task: string; patch: IncomingPatch };

export type IncomingParse = { ok: true; command: IncomingCommand } | { ok: false; error: string };

const STATUS_WORDS: [RegExp, TaskStatus][] = [
  [/^(완료|끝|done|complete|completed|close|closed|finish|finished|✅)$/i, 'done'],
  [/^(시작|진행|진행\s*중|doing|start|started|in[\s_-]*progress)$/i, 'doing'],
  [/^(취소|cancel|canceled|cancelled)$/i, 'canceled'],
  [/^(다시\s*열기|다시|재개|reopen|reopened|todo|to[\s_-]*do|할\s*일)$/i, 'todo'],
];

function statusWord(raw: string): TaskStatus | null {
  const s = raw.trim().replace(/[.!。]+$/, '');
  for (const [re, status] of STATUS_WORDS) if (re.test(s)) return status;
  return null;
}

const ACTIONS: Record<string, TaskStatus | 'create' | 'update'> = {
  create: 'create',
  add: 'create',
  new: 'create',
  update: 'update',
  edit: 'update',
  complete: 'done',
  done: 'done',
  close: 'done',
  start: 'doing',
  doing: 'doing',
  cancel: 'canceled',
  reopen: 'todo',
};

const PRIORITY_WORDS: Record<string, Priority> = {
  none: 0,
  없음: 0,
  low: 1,
  낮음: 1,
  p3: 1,
  medium: 2,
  normal: 2,
  보통: 2,
  중간: 2,
  p2: 2,
  high: 3,
  urgent: 3,
  높음: 3,
  긴급: 3,
  p1: 3,
};

const REF_RE = /^#?\d{1,9}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InputError extends Error {}
const fail = (msg: string): never => {
  throw new InputError(msg);
};

function str(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' && typeof v !== 'number') fail(`${field}: 문자열이어야 합니다`);
  const s = String(v).trim();
  if (s.length > max) fail(`${field}: ${max}자를 넘을 수 없습니다`);
  return s;
}

/** `assignees`: an array, one string, or names split by commas — at most 20, duplicates dropped. */
function people(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v];
  const out: string[] = [];
  for (const item of list) {
    const s = str(item, 'assignees', 320);
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > 20) fail('assignees: 담당자는 20명까지 지정할 수 있습니다');
  return out;
}

interface ParseCtx {
  today: ISODate;
  /** The sender's time zone: instants with an offset ("…T06:00:00Z") are read on its clock. */
  timeZone?: string;
  /** Minutes past midnight now, in that zone. */
  nowMinutes?: number | null;
}

/**
 * A date, maybe with a time: "2026-11-20", "2026-11-20T15:30", "2026-11-20 15:30",
 * an ISO instant with an offset, or words like "내일 오후 3시". undefined = not sent.
 */
function dateField(v: unknown, field: string, ctx: ParseCtx): { date: ISODate | null; time?: ISOTime | null } | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === false) return { date: null };
  if (typeof v !== 'string') return fail(`${field}: YYYY-MM-DD 날짜여야 합니다`);
  const s = v.trim();
  if (/^(none|없음|null)$/i.test(s)) return { date: null };
  const head = s.slice(0, 10);
  if (isISODate(head)) {
    if (s.length === 10) return { date: head };
    const rest = /^[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s.slice(10));
    if (rest) {
      const time = `${rest[1]}:${rest[2]}`;
      if (!isISOTime(time)) return fail(`${field}: 시각 "${time}"이(가) 올바르지 않습니다`);
      // Exactly midnight is how many tools write a plain date ("2026-11-20T00:00:00Z"): keep it a date.
      if (time === '00:00' && !Number(rest[3] ?? 0)) return { date: head };
      if (rest[4] && ctx.timeZone) {
        const instant = new Date(s.replace(' ', 'T'));
        if (!Number.isNaN(instant.getTime())) {
          const local = nowIn(ctx.timeZone, instant);
          return { date: local.date, time: fromMinutes(local.minutes) };
        }
      }
      return { date: head, time };
    }
    if (s[10] === 'T' || s[10] === ' ') return { date: head };
  }
  const phrase = parseDateTimePhrase(s, ctx.today, ctx.nowMinutes);
  if (phrase) return phrase.time ? phrase : { date: phrase.date };
  return fail(`${field}: "${s.slice(0, 40)}"을(를) 날짜로 읽지 못했습니다 (예: 2026-11-20, 2026-11-20T15:30, 내일 오후 3시)`);
}

function timeField(v: unknown, field: string): ISOTime | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === false) return null;
  if (typeof v !== 'string') return fail(`${field}: HH:MM 시각이어야 합니다`);
  const s = v.trim();
  if (/^(none|없음|null)$/i.test(s)) return null;
  const hm = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (hm && isISOTime(`${hm[1]!.padStart(2, '0')}:${hm[2]}`)) return `${hm[1]!.padStart(2, '0')}:${hm[2]}`;
  return parseTimePhrase(s) ?? fail(`${field}: "${s.slice(0, 40)}"을(를) 시각으로 읽지 못했습니다 (예: 15:30, 오후 3시)`);
}

function priorityField(v: unknown): Priority | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number' && [0, 1, 2, 3].includes(v)) return v as Priority;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase().replace(/^!/, '');
    if (/^[0-3]$/.test(s)) return Number(s) as Priority;
    if (s in PRIORITY_WORDS) return PRIORITY_WORDS[s];
  }
  return fail('priority: 0–3 또는 none·low·medium·high(없음·낮음·보통·높음)여야 합니다');
}

function statusField(v: unknown): TaskStatus | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'todo' || s === 'doing' || s === 'done' || s === 'canceled') return s;
    const w = statusWord(s);
    if (w) return w;
  }
  return fail('status: todo·doing·done·canceled(할 일·진행 중·완료·취소) 중 하나여야 합니다');
}

function boolField(v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return fail(`${field}: true 또는 false여야 합니다`);
}

function taskRef(v: unknown): string {
  const s = str(v, 'task', 64);
  if (!s) return fail('task: 바꿀 작업을 "#12"처럼 지정하세요');
  if (REF_RE.test(s)) return `#${s.replace('#', '')}`;
  if (UUID_RE.test(s)) return s;
  return fail(`task: "${s}"은(는) 작업 번호(#12)나 id가 아닙니다`);
}

function patchFrom(o: Record<string, unknown>, ctx: ParseCtx): IncomingPatch {
  const patch: IncomingPatch = {};
  const title = str(o.title, 'title', 500);
  if (title !== undefined) {
    if (!title) fail('title: 빈 제목으로 바꿀 수 없습니다');
    patch.title = title;
  }
  const pick = (...keys: string[]) => o[keys.find((k) => k in o) ?? keys[0]!];
  const notes = pick('notes', 'description');
  if (notes !== undefined && notes !== null) patch.notes = str(notes, 'notes', 20_000);
  const status = statusField(o.status);
  if (status) patch.status = status;
  const pr = priorityField(o.priority);
  if (pr !== undefined) patch.priority = pr;
  for (const side of ['start', 'due'] as const) {
    const dateKey = `${side}Date` as const;
    const timeKey = `${side}Time` as const;
    const d = dateField(pick(dateKey, side), dateKey, ctx);
    if (d !== undefined) {
      patch[dateKey] = d.date;
      if (d.time !== undefined) patch[timeKey] = d.time;
    }
    const t = timeField(pick(timeKey, `${side}_time`), timeKey);
    if (t !== undefined) {
      if (t && d?.date === null) fail(`${timeKey}: 날짜를 지우면서 시각을 정할 수 없습니다`);
      patch[timeKey] = t;
    }
  }
  const fixed = boolField(o.fixed, 'fixed');
  if (fixed !== undefined) patch.fixed = fixed;
  if (patch.startDate && patch.dueDate) {
    if (patch.startDate > patch.dueDate) fail('시작일은 마감일보다 늦을 수 없습니다');
    if (!spanInOrder(patch.startDate, patch.startTime, patch.dueDate, patch.dueTime)) fail('시작 시각은 마감 시각보다 늦을 수 없습니다');
  }
  return patch;
}

/** Plain text: "보고서 초안 내일 !높음" creates; "#12 완료" or "#12 금요일까지" changes #12. */
function fromText(text: string, ctx: ParseCtx): IncomingCommand {
  const { today } = ctx;
  const raw = text.replace(/\r\n?/g, '\n').trim();
  if (!raw) return fail('보낸 내용이 비어 있습니다');
  const [first, ...rest] = raw.split('\n');
  const line = first!.trim();
  const notes = rest.join('\n').trim();

  const ref = /^#(\d{1,9})(?:\s+(.+))?$/s.exec(line);
  if (ref && !notes) {
    const task = `#${ref[1]}`;
    const tail = (ref[2] ?? '').trim();
    if (!tail) return fail(`"${task}" 다음에 할 일을 적으세요. 예: "${task} 완료", "${task} 금요일까지"`);
    const status = statusWord(tail);
    if (status) return { kind: 'update', task, patch: { status } };
    const q = parseQuickAdd(tail, today, { disabled: ['project'], nowMinutes: ctx.nowMinutes });
    if (!q.title && q.tokens.length) {
      const patch: IncomingPatch = {};
      if (q.dueDate) {
        patch.dueDate = q.dueDate;
        if (q.dueTime) patch.dueTime = q.dueTime;
      }
      if (q.startDate) {
        patch.startDate = q.startDate;
        if (q.startTime) patch.startTime = q.startTime;
      }
      if (q.priority !== null) patch.priority = q.priority;
      if (q.fixed) patch.fixed = true;
      return { kind: 'update', task, patch };
    }
    return fail(`"${task} ${tail.slice(0, 40)}"을(를) 이해하지 못했습니다. 예: "${task} 완료", "${task} 시작", "${task} 금요일까지", "${task} !높음"`);
  }

  const q = parseQuickAdd(line, today, { nowMinutes: ctx.nowMinutes });
  if (!q.title) return fail('작업 제목이 없습니다');
  if (q.title.length > 500) return fail('제목은 500자를 넘을 수 없습니다');
  return {
    kind: 'create',
    title: q.title,
    ...(notes ? { notes: notes.slice(0, 20_000) } : {}),
    ...(q.startDate ? { startDate: q.startDate } : {}),
    ...(q.startTime ? { startTime: q.startTime } : {}),
    ...(q.dueDate ? { dueDate: q.dueDate } : {}),
    ...(q.dueTime ? { dueTime: q.dueTime } : {}),
    ...(q.priority !== null ? { priority: q.priority } : {}),
    ...(q.fixed ? { fixed: true } : {}),
    ...(q.projectName ? { project: q.projectName } : {}),
  };
}

function fromObject(o: Record<string, unknown>, ctx: ParseCtx): IncomingCommand {
  const actionRaw = typeof o.action === 'string' ? o.action.trim().toLowerCase() : undefined;
  if (o.action !== undefined && (actionRaw === undefined || !(actionRaw in ACTIONS))) {
    return fail(`action: create·update·complete·start·cancel·reopen 중 하나여야 합니다`);
  }
  const action = actionRaw ? ACTIONS[actionRaw]! : undefined;
  const ref = o.task ?? o.ref ?? o.number;
  const textValue = [o.text, o.content, o.message].find((v) => typeof v === 'string') as string | undefined;

  if (action === 'create' || (!action && ref === undefined)) {
    if (o.title === undefined || o.title === null) {
      if (textValue !== undefined && !action) return fromText(textValue, ctx);
      if (textValue !== undefined) {
        const cmd = fromText(textValue, ctx);
        if (cmd.kind !== 'create') return fail('action이 create이면 text로 기존 작업을 바꿀 수 없습니다');
        return cmd;
      }
      return fail('title(작업 제목)이나 text가 필요합니다');
    }
    const title = str(o.title, 'title', 500);
    if (!title) return fail('title: 제목을 입력하세요');
    const patch = patchFrom({ ...o, title: undefined }, ctx);
    const project = str(o.project ?? o.projectId, 'project', 200);
    const assignees = people(o.assignees ?? o.assigneeIds ?? o.assignee ?? o.assigneeId);
    return {
      kind: 'create',
      title,
      ...patch,
      ...(project ? { project } : {}),
      ...(assignees.length ? { assignees } : {}),
    };
  }

  const task = taskRef(ref);
  const patch = patchFrom(o, ctx);
  if (action && action !== 'update') {
    if (patch.status && patch.status !== action) return fail(`action "${actionRaw}"과(와) status "${patch.status}"가 서로 다릅니다`);
    patch.status = action;
  }
  if (!Object.keys(patch).length) {
    return fail('바꿀 내용이 없습니다. status, dueDate, priority, title 같은 필드를 함께 보내세요');
  }
  return { kind: 'update', task, patch };
}

/**
 * Turn a request body into one command. Accepts plain text, `{ text }`, a create body
 * (`{ title, dueDate, priority, project, assignees, … }`) or an update
 * (`{ action: "complete" | "start" | "cancel" | "reopen" | "update", task: "#12", … }`).
 * Dates may carry a time ("2026-11-20T15:30", "내일 오후 3시"), or send `dueTime`/`startTime` apart.
 */
export function parseIncoming(
  body: unknown,
  today: ISODate,
  opts: { timeZone?: string; nowMinutes?: number | null } = {},
): IncomingParse {
  const ctx: ParseCtx = { today, ...opts };
  try {
    if (typeof body === 'string') return { ok: true, command: fromText(body, ctx) };
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return { ok: true, command: fromObject(body as Record<string, unknown>, ctx) };
    }
    return { ok: false, error: '본문은 JSON 객체나 텍스트여야 합니다' };
  } catch (e) {
    if (e instanceof InputError) return { ok: false, error: e.message };
    throw e;
  }
}

// ───────────────────────────── API shapes

export type WebhookDeliveryStatus = 'pending' | 'success' | 'failed';

export interface Webhook {
  id: string;
  name: string;
  url: string;
  format: WebhookFormat;
  events: WebhookEventKey[];
  /** null = every project. */
  projectIds: string[] | null;
  /** Local hour (0–23) schedule alerts start going out each day. */
  alertHour: number;
  /** How many minutes before a task's start or due time its reminder goes out. */
  remindMinutes: number;
  timezone: string;
  enabled: boolean;
  /** Why the server turned it off (repeated failures). */
  disabledReason: string | null;
  failureCount: number;
  lastDelivery: { status: WebhookDeliveryStatus; at: string; responseStatus: number | null } | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  payload: WebhookPayload;
}

export interface IncomingWebhook {
  id: string;
  name: string;
  /** Last characters of the secret URL, to tell hooks apart. */
  hint: string;
  /** Where new tasks go (null = inbox); also the only project it may change, when set. */
  projectId: string | null;
  allowUpdates: boolean;
  useCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

export interface WebhooksOverview {
  /** Personal space owner, or an organization owner/admin. */
  canManage: boolean;
  webhooks: Webhook[];
  incoming: IncomingWebhook[];
}

// ───────────────────────────── inputs

const hookName = z.string().trim().min(1, '이름을 입력하세요').max(80, '이름은 80자까지예요');
const hookUrl = z
  .string()
  .trim()
  .min(1, 'URL을 입력하세요')
  .max(2000)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'https://로 시작하는 주소여야 합니다' },
  );

export const createWebhookInput = z.object({
  name: hookName,
  url: hookUrl,
  /** Defaults to what the URL looks like (Slack, Discord, else JSON). */
  format: z.enum(WEBHOOK_FORMATS).optional(),
  events: z
    .array(z.enum(WEBHOOK_EVENT_KEYS))
    .min(1, '보낼 이벤트를 하나 이상 고르세요')
    .max(WEBHOOK_EVENT_KEYS.length)
    .transform((list) => [...new Set(list)]),
  projectIds: z.array(uuid).min(1, '프로젝트를 하나 이상 고르세요').max(500).nullable().optional(),
  alertHour: z.number().int().min(0).max(23).optional(),
  remindMinutes: z.number().int().min(0).max(1440).optional(),
  enabled: z.boolean().optional(),
});
export type CreateWebhookInput = z.infer<typeof createWebhookInput>;

export const updateWebhookInput = createWebhookInput.partial();
export type UpdateWebhookInput = z.infer<typeof updateWebhookInput>;

export const createIncomingWebhookInput = z.object({
  name: hookName,
  projectId: uuid.nullable().optional(),
  allowUpdates: z.boolean().optional(),
});
export type CreateIncomingWebhookInput = z.infer<typeof createIncomingWebhookInput>;

export const updateIncomingWebhookInput = createIncomingWebhookInput.partial();
export type UpdateIncomingWebhookInput = z.infer<typeof updateIncomingWebhookInput>;
