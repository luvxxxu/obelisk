/**
 * Linear-style markdown for MCP tool results.
 *
 * Every Obelisk tool returns two things: `structuredContent` (data for the
 * interactive card and for the model) and a text block built here. The text is
 * what clients without MCP Apps (Claude Code, Codex, …) show, and what models
 * tend to mirror, so it is written to be relayed as-is:
 *
 *   ◐ `#12` 기획서 초안 · 높음 · 런칭 · 11/18 (수) – 11/20 (금)
 *
 * Status glyphs ○ todo · ◐ doing · ✓ done · ✕ canceled, refs in code spans,
 * "·"-separated meta, overdue counts in bold. The SKILL's formatting reference
 * documents the same house style.
 */
import {
  describeActivity,
  diffDays,
  LEVEL_LABEL_KO,
  ROLE_LABEL_KO,
  viaLabelKo,
  type AccessLevel,
  type ActivityEntry,
  type WorkspaceKind,
  type WorkspaceRole,
  formatDaysKo,
  formatDurationKo,
  formatRelativeKo,
  formatShortKo,
  formatTimeKo,
  formatTimeRangeKo,
  type ImpactKind,
  type ISODate,
  type ISOTime,
  type ProjectColor,
  type TaskStatus,
  todayIn,
} from '@obelisk/core';

export type PriorityName = 'none' | 'low' | 'medium' | 'high';

export interface LinkOut {
  ref: string;
  id: string;
  title: string;
  status: TaskStatus;
}

export interface TaskOut {
  ref: string;
  id: string;
  title: string;
  status: TaskStatus;
  priority: PriorityName;
  project: string | null;
  projectColor?: ProjectColor;
  startDate: ISODate | null;
  /** "HH:MM" (24h, the user's time zone) on the start date; null = the whole day. */
  startTime: ISOTime | null;
  dueDate: ISODate | null;
  dueTime: ISOTime | null;
  fixed: boolean;
  /** Minutes it should take. */
  estimateMinutes?: number;
  /** Minutes tracked on it so far. */
  actualMinutes?: number;
  /** Assignees' names, in the order they were added. */
  assignees?: string[];
  /** The caller can see but not change this task. */
  readOnly?: true;
  overdue?: true;
  postponedCount?: number;
  completedAt?: string;
  notes?: string;
  blockedBy?: LinkOut[];
  blocks?: LinkOut[];
}

export interface ImpactRowOut {
  ref: string;
  title: string;
  effect: ImpactKind;
  shiftDays?: number;
  overrunDays?: number;
  slackLeftDays?: number;
  /** "YYYY-MM-DD" or "YYYY-MM-DD..YYYY-MM-DD" */
  from: string | null;
  to: string | null;
  because?: string;
}

export interface ProjectSlipOut {
  project: string;
  projectColor?: ProjectColor;
  finishFrom: ISODate;
  finishTo: ISODate;
  slip: string;
  shiftDays: number;
}

export interface ImpactOut {
  headline: string;
  root?: { ref: string; title: string; days: number };
  delayed: number;
  conflicts: number;
  absorbed: number;
  maxShiftDays: number;
  /** Largest push among shifted dependents (excludes the root's own move). */
  maxDelayDays: number;
  projectSlips: ProjectSlipOut[];
  overallFinish: ISODate | null | { from: ISODate | null; to: ISODate | null };
  impacts: ImpactRowOut[];
}

export interface BottleneckOut extends TaskOut {
  downstreamTasks: number;
  slackDays: number | null;
  ifOneDayLate: { delayed: number; fixedConflicts: number };
}

export interface ProjectOut {
  id: string;
  name: string;
  color: ProjectColor;
  archived: boolean;
  open: number;
  overdue: number;
  plannedFinish: ISODate | null;
  /** The caller's level (organizations only). */
  access?: AccessLevel;
}

export interface WorkspaceOut {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  members: number;
  default: boolean;
}

export interface TrashOut {
  ref: string;
  id: string;
  title: string;
  status: TaskStatus;
  /** Where a restore puts it: a project name, or 인박스. */
  project: string | null;
  deletedAt: string;
  /** Who deleted it (organizations only). */
  deletedBy?: string | null;
  purgeAt: string;
  /** The caller may not restore it (view-only project). */
  readOnly?: true;
}

export interface MemberOut {
  name: string;
  email: string;
  role: WorkspaceRole;
  teams: string[];
  me?: true;
}

export interface ActivityOut {
  at: string;
  who: string;
  via?: string;
  what: string;
  subject: string;
  action: string;
}

export function activityOut(e: ActivityEntry): ActivityOut {
  const via = viaLabelKo(e.via, e.client);
  return {
    at: e.createdAt,
    who: e.actor.name,
    ...(via ? { via } : {}),
    what: describeActivity(e),
    subject: e.subject,
    action: e.action,
  };
}

// ───────────────────────────── primitives

const STATUS_GLYPH: Record<TaskStatus, string> = { todo: '○', doing: '◐', done: '✓', canceled: '✕' };
const STATUS_KO: Record<TaskStatus, string> = { todo: '할 일', doing: '진행 중', done: '완료', canceled: '취소' };
const PRIORITY_KO: Record<PriorityName, string> = { none: '', low: '낮음', medium: '보통', high: '높음' };

/** Escape what would break inline markdown or a table cell. */
export function esc(s: string): string {
  return s.replace(/([\\`*_[\]|<>~])/g, '\\$1').replace(/\s*\n\s*/g, ' ');
}

const code = (ref: string) => `\`${ref}\``;

/** Korean object particle 을/를 for the word's last syllable. */
export function eulReul(word: string): string {
  const c = word.trim().at(-1);
  if (!c) return '을';
  const code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? '를' : '을';
  if (/[0-9]/.test(c)) return '을(를)';
  return /[aeiouyAEIOUY]/.test(c) ? '를' : '을';
}

function spanParts(span: string | null): [ISODate | null, ISODate | null] {
  if (!span) return [null, null];
  const [a, b] = span.split('..');
  return [a ?? null, b ?? a ?? null];
}

/** "11/20 (금)" or "11/18 (수) – 11/20 (금)" */
export function spanLabel(span: string | null): string {
  const [a, b] = spanParts(span);
  if (!a) return '날짜 없음';
  return a === b || !b ? formatShortKo(a) : `${formatShortKo(a)} – ${formatShortKo(b)}`;
}

const at = (time: ISOTime | null | undefined) => (time ? ` ${formatTimeKo(time)}` : '');

/** Date (and time) phrase for a task line: "내일 오후 3:00", "금요일 오전 10:00 – 11:30", "11/20 (금) – 11/22 (일) 오후 6:00". */
export function whenLabel(t: Pick<TaskOut, 'startDate' | 'dueDate' | 'startTime' | 'dueTime'>, today: ISODate): string {
  const { startDate: s, dueDate: d, startTime: st, dueTime: dt } = t;
  if (s && d && s !== d) return `${formatShortKo(s)}${at(st)} – ${formatShortKo(d)}${at(dt)}`;
  if (s && d && st && dt) return `${formatRelativeKo(d, today)} ${formatTimeRangeKo(st, dt)}`;
  if (s && d && st) return `${formatRelativeKo(s, today)}${at(st)} 시작`;
  if (d) return `${formatRelativeKo(d, today)}${at(dt)}`;
  if (s) return `${formatRelativeKo(s, today)}${at(st)} 시작`;
  return '';
}

/** "3일 지남", or "마감 오후 3:00 지남" for a time that passed today. */
function lateLabel(t: Pick<TaskOut, 'dueDate' | 'dueTime'>, today: ISODate): string {
  const days = diffDays(today, t.dueDate!);
  return days > 0 ? `${days}일 지남` : `마감${at(t.dueTime)} 지남`;
}

export function taskLine(t: TaskOut, today: ISODate, opts: { project?: boolean } = {}): string {
  const meta: string[] = [];
  if (t.priority !== 'none') meta.push(PRIORITY_KO[t.priority]);
  if (t.project && opts.project !== false) meta.push(esc(t.project));
  const when = whenLabel(t, today);
  if (when) meta.push(when);
  if (t.overdue && t.dueDate) meta.push(`**${lateLabel(t, today)}**`);
  if (t.assignees?.length) meta.push(t.assignees.map((n) => `@${esc(n)}`).join(' '));
  if (t.fixed) meta.push('🔒 고정');
  if (t.estimateMinutes) meta.push(`⏱ ${formatDurationKo(t.estimateMinutes)}`);
  if ((t.postponedCount ?? 0) >= 2) meta.push(`↻ ${t.postponedCount}회 미룸`);
  if (t.readOnly) meta.push('👁 보기 전용');
  return `${STATUS_GLYPH[t.status]} ${code(t.ref)} ${esc(t.title)}${meta.length ? ` · ${meta.join(' · ')}` : ''}`;
}

function linkLine(l: LinkOut): string {
  return `${STATUS_GLYPH[l.status]} ${code(l.ref)} ${esc(l.title)}`;
}

function section(label: string, tasks: TaskOut[], today: ISODate, opts: { project?: boolean; max?: number } = {}): string {
  if (!tasks.length) return '';
  const max = opts.max ?? 15;
  const lines = tasks.slice(0, max).map((t) => `- ${taskLine(t, today, opts)}`);
  if (tasks.length > max) lines.push(`- … 외 ${tasks.length - max}개`);
  return `**${label}** · ${tasks.length}\n${lines.join('\n')}`;
}

const join = (...blocks: (string | false | null | undefined)[]) => blocks.filter(Boolean).join('\n\n');

export function longDateKo(date: ISODate): string {
  const [, m, d] = date.split('-').map(Number);
  const wd = ['일', '월', '화', '수', '목', '금', '토'][new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${m}월 ${d}일 ${wd}요일`;
}

// ───────────────────────────── tools

export const VIEW_TITLE_KO: Record<string, string> = {
  today: '오늘',
  upcoming: '예정',
  overdue: '기한 지남',
  inbox: '인박스',
  unscheduled: '날짜 없음',
  all: '모든 작업',
  done: '완료한 작업',
};

const PRIO_RANK: Record<PriorityName, number> = { high: 3, medium: 2, low: 1, none: 0 };

/** Priority first, then in progress, then the earlier deadline (the card uses the same rule). */
export function byImportance(a: TaskOut, b: TaskOut): number {
  const day = (t: TaskOut) =>
    t.dueDate ? `${t.dueDate}T${t.dueTime ?? '24:00'}` : t.startDate ? `${t.startDate}T${t.startTime ?? '00:00'}` : '9999-12-31';
  return (
    PRIO_RANK[b.priority] - PRIO_RANK[a.priority] ||
    Number(b.status === 'doing') - Number(a.status === 'doing') ||
    day(a).localeCompare(day(b)) ||
    Number(a.ref.slice(1)) - Number(b.ref.slice(1))
  );
}

const ACTIVE = (t: TaskOut) => t.status === 'todo' || t.status === 'doing';

/**
 * 기한 지남 → 오늘 → 내일 / 요일 (next 6 days) → 나중에 → 날짜 없음 → 완료, most important first.
 * A task sits where it needs attention: overdue by deadline, "today" once started or in progress,
 * otherwise on the day it starts. Mirrors dayGroups() in widget/widget.js.
 */
export function dayGroups(tasks: TaskOut[], today: ISODate): { key: string; label: string; tasks: TaskOut[] }[] {
  const groups = new Map<string, { key: string; label: string; order: number; tasks: TaskOut[] }>();
  const put = (key: string, label: string, order: number, t: TaskOut) => {
    if (!groups.has(key)) groups.set(key, { key, label, order, tasks: [] });
    groups.get(key)!.tasks.push(t);
  };
  for (const t of tasks) {
    const first = t.startDate ?? t.dueDate;
    if (!ACTIVE(t)) put('done', '완료', 1e6, t);
    else if (t.dueDate && (t.dueDate < today || t.overdue)) put('overdue', '기한 지남', -2, t);
    else if (!first) put('none', '날짜 없음', 1e5 + 1, t);
    else if (t.status === 'doing' || first <= today) put('today', '오늘', -1, t);
    else {
      const n = diffDays(first, today);
      if (n <= 6) put(first, `${n === 1 ? '내일' : formatRelativeKo(first, today)} · ${formatShortKo(first)}`, n, t);
      else put('later', '나중에', 1e5, t);
    }
  }
  const out = [...groups.values()].sort((a, b) => a.order - b.order);
  for (const g of out) if (g.key !== 'done') g.tasks.sort(byImportance);
  return out;
}

const mixesProjects = (tasks: TaskOut[]) => new Set(tasks.map((t) => t.project ?? '')).size > 1;
const num = (n: number) => (n ? `**${n}**` : '0');

export function mdOverview(o: {
  today: ISODate;
  overdue: TaskOut[];
  todayTasks: TaskOut[];
  upcoming: TaskOut[];
  upcomingDays: number;
  delayRisk: string | (Pick<ImpactOut, 'headline' | 'conflicts' | 'delayed'> & { impacts: ImpactRowOut[] });
}): string {
  const seen = new Set<string>();
  const all = [...o.overdue, ...o.todayTasks, ...o.upcoming].filter((t) => !seen.has(t.ref) && seen.add(t.ref));
  const groups = dayGroups(all, o.today);
  const size = (key: string) => groups.find((g) => g.key === key)?.tasks.length ?? 0;
  const upcoming = groups.filter((g) => !['overdue', 'today', 'none', 'done'].includes(g.key)).reduce((n, g) => n + g.tasks.length, 0);
  const risk = typeof o.delayRisk !== 'string' && (o.delayRisk.delayed || o.delayRisk.conflicts) ? o.delayRisk : null;
  const slipping = risk ? risk.delayed + risk.conflicts : 0;
  const project = mixesProjects(all);
  return join(
    `### 오늘 · ${longDateKo(o.today)}`,
    `오늘 할 일 ${num(size('today'))} · 기한 지남 ${num(size('overdue'))} · 다가오는 ${o.upcomingDays}일 ${num(upcoming)} · 밀리는 일정 ${num(slipping)}`,
    risk && `> ⚠️ ${risk.headline}`,
    ...groups.map((g) => section(g.label, g.tasks, o.today, { project, max: 8 })),
    !all.length && '예정된 작업이 없습니다.',
  );
}

export function mdTaskList(o: { today: ISODate; view: string; project?: string | null; count: number; tasks: TaskOut[] }): string {
  const title = `${VIEW_TITLE_KO[o.view] ?? '작업'}${o.project ? ` · ${esc(o.project)}` : ''}`;
  if (!o.tasks.length) return join(`### ${title}`, '해당하는 작업이 없습니다.');
  const project = !o.project && mixesProjects(o.tasks);
  if (o.view === 'done') {
    const lines = o.tasks.slice(0, 50).map((t) => `- ${taskLine(t, o.today, { project })}`);
    if (o.tasks.length > 50) lines.push(`- … 외 ${o.tasks.length - 50}개`);
    return join(`### ${title} · ${o.count}`, lines.join('\n'));
  }
  return join(`### ${title} · ${o.count}`, ...dayGroups(o.tasks, o.today).map((g) => section(g.label, g.tasks, o.today, { project, max: 15 })));
}

export function mdTaskDetail(t: TaskOut, today: ISODate, heading?: string): string {
  const meta = [`${STATUS_GLYPH[t.status]} ${STATUS_KO[t.status]}`];
  if (t.priority !== 'none') meta.push(`우선순위 ${PRIORITY_KO[t.priority]}`);
  meta.push(t.project ? esc(t.project) : '인박스');
  const when = whenLabel(t, today);
  const span = !!t.startDate && !!t.dueDate && (t.startDate !== t.dueDate || !!t.startTime);
  if (when) meta.push(span || !t.dueDate ? when : `${when} 마감`);
  if (t.overdue && t.dueDate) meta.push(`**${lateLabel(t, today)}**`);
  if (t.assignees?.length) meta.push(`담당 ${t.assignees.map(esc).join(', ')}`);
  if (t.fixed) meta.push('🔒 고정 일정');
  if (t.estimateMinutes || t.actualMinutes) {
    const parts = [t.estimateMinutes ? `예상 ${formatDurationKo(t.estimateMinutes)}` : '', t.actualMinutes ? `실제 ${formatDurationKo(t.actualMinutes)}` : ''];
    meta.push(`⏱ ${parts.filter(Boolean).join(' / ')}`);
  }
  if (t.postponedCount) meta.push(`↻ ${t.postponedCount}회 미룸`);
  if (t.readOnly) meta.push('👁 보기 전용');
  const notes = t.notes
    ? t.notes
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    : '';
  const rel = [
    t.blockedBy?.length ? `**선행 작업** — ${t.blockedBy.map(linkLine).join(', ')}` : '',
    t.blocks?.length ? `**후속 작업** — ${t.blocks.map(linkLine).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return join(`### ${heading ? `${heading} · ` : ''}${code(t.ref)} ${esc(t.title)}`, meta.join(' · '), notes, rel);
}

export function mdCompleted(o: { task: TaskOut; action: 'completed' | 'reopened'; nowUnblocked?: LinkOut[] }): string {
  const t = o.task;
  if (o.action === 'reopened') return `○ ${code(t.ref)} ${esc(t.title)} — 다시 열었습니다.`;
  return join(
    `✓ ${code(t.ref)} ${esc(t.title)} — 완료했습니다.`,
    o.nowUnblocked?.length ? `**이제 시작할 수 있는 작업** — ${o.nowUnblocked.map(linkLine).join(', ')}` : '',
  );
}

export function mdCreatedMany(o: { today: ISODate; created: TaskOut[]; dependencies: { task: string; blockedBy: string }[] }): string {
  const after = new Map<string, string[]>();
  for (const d of o.dependencies) after.set(d.task, [...(after.get(d.task) ?? []), d.blockedBy]);
  const lines = o.created.map((t) => {
    const deps = after.get(t.ref);
    return `- ${taskLine(t, o.today)}${deps ? ` · ← ${deps.map(code).join(', ')} 다음` : ''}`;
  });
  return join(`### 작업 ${o.created.length}개를 만들었습니다`, lines.join('\n'));
}

/** One impacted task as a phrase: "`#13` 개발 11/18 – 11/20 → 11/21 – 11/23 (+3일)" */
export function impactPhrase(i: ImpactRowOut): string {
  const name = `${code(i.ref)} ${esc(i.title)}`;
  switch (i.effect) {
    case 'root':
      return `${name} ${spanLabel(i.from)} → ${spanLabel(i.to)} (${(i.shiftDays ?? 0) >= 0 ? '+' : '−'}${formatDaysKo(i.shiftDays ?? 0)})`;
    case 'shifted':
      return `${name} ${spanLabel(i.from)} → ${spanLabel(i.to)} (+${formatDaysKo(i.shiftDays ?? 0)})`;
    case 'conflict':
      return `🔒 ${name} ${spanLabel(i.from)} 고정 — **충돌, ${formatDaysKo(i.overrunDays ?? 0)} 초과**`;
    case 'absorbed':
      return `${name} — 여유로 흡수 (여유 ${i.slackLeftDays ?? 0}일 남음)`;
    case 'unscheduled':
      return `${name} — 날짜 없음, 지연이 다음 작업으로 전달됨`;
  }
}

const EFFECT_CELL: Record<ImpactKind, (i: ImpactRowOut) => string> = {
  root: (i) => `미룸 ${(i.shiftDays ?? 0) >= 0 ? '+' : '−'}${formatDaysKo(i.shiftDays ?? 0)}`,
  shifted: (i) => `**+${formatDaysKo(i.shiftDays ?? 0)}** 밀림`,
  conflict: (i) => `⚠️ **충돌 · ${formatDaysKo(i.overrunDays ?? 0)} 초과**`,
  absorbed: (i) => `흡수 · 여유 ${i.slackLeftDays ?? 0}일 남음`,
  unscheduled: () => '날짜 없음 · 그대로 전달',
};
const EFFECT_GLYPH: Record<ImpactKind, string> = { root: '●', shifted: '↘', conflict: '⚠', absorbed: '✓', unscheduled: '·' };

export function mdImpact(imp: ImpactOut, mode: 'simulate' | 'applied' | 'forecast', extra?: { cascade?: boolean; moved?: number }): string {
  const title =
    mode === 'simulate'
      ? `지연 시뮬레이션${imp.root ? ` · ${code(imp.root.ref)} ${esc(imp.root.title)} ${imp.root.days >= 0 ? '+' : '−'}${formatDaysKo(imp.root.days)}` : ''}`
      : mode === 'applied'
        ? `일정을 옮겼습니다${extra?.moved !== undefined ? ` · 작업 ${extra.moved}개 이동` : ''}${extra?.cascade === false ? ' (이 작업만)' : ''}`
        : '지연 예측';
  const rows = imp.impacts.map((i) => {
    const change = i.effect === 'shifted' || i.effect === 'root' ? `${spanLabel(i.from)} → ${spanLabel(i.to)}` : spanLabel(i.from);
    const because = i.because && i.effect !== 'root' ? ` (${code(i.because)} 때문)` : '';
    // In a forecast the roots are overdue tasks assumed to finish today, not postponements.
    const cell =
      mode === 'forecast' && i.effect === 'root'
        ? `**기한 지남** · 오늘 끝내도 +${formatDaysKo(i.shiftDays ?? 0)}`
        : EFFECT_CELL[i.effect](i);
    const glyph = mode === 'forecast' && i.effect === 'root' ? '!' : EFFECT_GLYPH[i.effect];
    return `| ${glyph} | ${code(i.ref)} ${esc(i.title)} | ${change} | ${cell}${because} |`;
  });
  const table = rows.length ? ['| | 작업 | 일정 | 영향 |', '|---|---|---|---|', ...rows].join('\n') : '';
  const slips = imp.projectSlips.length
    ? `**프로젝트 완료일** — ${imp.projectSlips
        .map((p) => `${esc(p.project)} ${formatShortKo(p.finishFrom)} → ${formatShortKo(p.finishTo)} (${p.slip})`)
        .join(' · ')}`
    : '';
  const next =
    mode === 'simulate' && (imp.delayed || imp.conflicts)
      ? '_아직 아무것도 바뀌지 않았습니다. 모두 함께 미룰지(cascade), 이 작업만 미룰지 사용자에게 물어보세요._'
      : '';
  return join(`### ${title}`, imp.headline, table, slips, next);
}

export function mdBottlenecks(o: { today: ISODate; bottlenecks: BottleneckOut[] }): string {
  if (!o.bottlenecks.length) return join('### 병목 작업', '다른 작업이 기다리는 작업이 없습니다. 의존 관계를 연결하면 병목을 찾아드립니다.');
  const rows = o.bottlenecks.map((b, i) => {
    const slack = b.slackDays === null ? '—' : b.slackDays === 0 ? '**없음**' : `${b.slackDays}일`;
    const { delayed, fixedConflicts } = b.ifOneDayLate;
    const late =
      [delayed ? `${delayed}개 밀림` : '', fixedConflicts ? `**충돌 ${fixedConflicts}**` : ''].filter(Boolean).join(' · ') ||
      '영향 없음';
    return `| ${i + 1} | ${STATUS_GLYPH[b.status]} ${code(b.ref)} ${esc(b.title)} | ${whenLabel(b, o.today) || '—'} | ${b.downstreamTasks}개 | ${slack} | ${late} |`;
  });
  return join(
    '### 병목 작업',
    ['| # | 작업 | 일정 | 후속 작업 | 여유 | 하루 늦으면 |', '|---|---|---|---|---|---|', ...rows].join('\n'),
  );
}

export function mdProjects(o: { today: ISODate; projects: ProjectOut[] }): string {
  if (!o.projects.length) return join('### 프로젝트', '프로젝트가 없습니다.');
  const lines = o.projects.map((p) => {
    const meta = [
      `열린 작업 ${p.open}`,
      p.overdue ? `기한 지남 **${p.overdue}**` : null,
      p.plannedFinish ? `예상 완료 ${formatRelativeKo(p.plannedFinish, o.today)}` : null,
      p.archived ? '보관됨' : null,
      p.access === 'view' ? '👁 보기 전용' : null,
    ].filter(Boolean);
    return `- **${esc(p.name)}** · ${meta.join(' · ')}`;
  });
  return join(`### 프로젝트 · ${o.projects.length}`, lines.join('\n'));
}

export function mdWorkspaces(o: { workspaces: WorkspaceOut[] }): string {
  const lines = o.workspaces.map((w) => {
    const meta = [w.kind === 'personal' ? '개인 공간' : `조직 · ${ROLE_LABEL_KO[w.role]} · 멤버 ${w.members}명`, w.default ? '**기본**' : null];
    return `- **${esc(w.name)}** · ${meta.filter(Boolean).join(' · ')}`;
  });
  return join(`### 공간 · ${o.workspaces.length}`, lines.join('\n'));
}

export function mdMembers(o: { workspace: string; members: MemberOut[] }): string {
  const lines = o.members.map(
    (m) => `- **${esc(m.name)}**${m.me ? ' (나)' : ''} · ${ROLE_LABEL_KO[m.role]} · ${esc(m.email)}${m.teams.length ? ` · ${m.teams.map(esc).join(', ')}` : ''}`,
  );
  return join(`### ${esc(o.workspace)} 멤버 · ${o.members.length}`, lines.join('\n'));
}

export function mdTrash(o: { workspace: string; timezone: string; items: TrashOut[] }): string {
  if (!o.items.length) return join(`### ${esc(o.workspace)} 휴지통`, '휴지통이 비어 있습니다.');
  const today = todayIn(o.timezone);
  const lines = o.items.map((i) => {
    // Calendar days in the user's time zone, as the web and iOS count them: the purge day itself is 오늘.
    const left = diffDays(todayIn(o.timezone, new Date(i.purgeAt)), today);
    const meta = [
      esc(i.project ?? '인박스'),
      left > 0 ? `${left}일 후 영구 삭제` : '오늘 영구 삭제',
      i.deletedBy ? `${esc(i.deletedBy)} 삭제` : null,
      i.readOnly ? '👁 보기 전용' : null,
    ].filter(Boolean);
    return `- ${STATUS_GLYPH[i.status]} ${code(i.ref)} ${esc(i.title)} · ${meta.join(' · ')}`;
  });
  return join(`### ${esc(o.workspace)} 휴지통 · ${o.items.length}`, lines.join('\n'), '_30일이 지나면 영구 삭제됩니다. restore_task로 되살릴 수 있습니다._');
}

function timeKo(iso: string, timezone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

export function mdActivity(o: { title: string; timezone: string; activity: ActivityOut[] }): string {
  if (!o.activity.length) return join(`### ${esc(o.title)}`, '기록된 활동이 없습니다.');
  const lines = o.activity.map((e) => {
    const subject = e.subject && !e.action.startsWith('member.') ? `${esc(e.subject)} — ` : e.subject ? `${esc(e.subject)} · ` : '';
    return `- ${timeKo(e.at, o.timezone)} · **${esc(e.who)}** · ${subject}${esc(e.what)}${e.via ? ` · _${esc(e.via)}_` : ''}`;
  });
  return join(`### ${esc(o.title)}`, lines.join('\n'));
}

export const levelKo = (l: AccessLevel) => LEVEL_LABEL_KO[l];

// ───────────────────────────── time planning

export interface DayBlockOut {
  ref: string;
  title: string;
  start: ISOTime;
  end: ISOTime;
  /** Placed by hand: re-planning leaves it. */
  locked?: true;
  /** Proposed now (not saved yet). */
  new?: true;
  space?: string;
}

export type DayPlanOut = {
  date: ISODate;
  today: ISODate;
  saved: boolean;
  window: { start: ISOTime; end: ISOTime };
  workday: boolean;
  blocks: DayBlockOut[];
  events: { ref: string; title: string; start: ISOTime; end: ISOTime; fixed: boolean }[];
  pending: { ref: string; title: string; minutes: number; reason: 'no_time' | 'blocked' | null }[];
  late: { ref: string; title: string; dueTime: ISOTime; end: ISOTime }[];
  capacityMinutes: number;
  plannedMinutes: number;
  neededMinutes: number;
  running: { ref: string; title: string; since: string } | null;
};

export function mdDayPlan(o: DayPlanOut, heading: string): string {
  const head = `### ${heading} · ${formatRelativeKo(o.date, o.today)} (${formatShortKo(o.date)})`;
  const over = o.neededMinutes - o.capacityMinutes;
  const load = `일할 수 있는 시간 ${formatDurationKo(o.capacityMinutes)} · 계획 ${formatDurationKo(o.plannedMinutes)} · 필요한 시간 ${formatDurationKo(o.neededMinutes)}${over > 0 ? ` · **${formatDurationKo(over)} 넘침**` : ''}${o.workday ? '' : ' · 쉬는 날'}`;
  type Row = { start: ISOTime; line: string };
  const rows: Row[] = [
    ...o.events.map((e) => ({ start: e.start, line: `- ${formatTimeRangeKo(e.start, e.end)} · ${e.fixed ? '🔒 ' : ''}${code(e.ref)} ${esc(e.title)}` })),
    ...o.blocks.map((b) => ({
      start: b.start,
      line: `- ${formatTimeRangeKo(b.start, b.end)} · ${code(b.ref)} ${esc(b.title)}${b.space ? ` · ${esc(b.space)}` : ''}${b.locked ? ' · 📌' : ''}${b.new ? ' · 새로' : ''}`,
    })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  const plan = rows.length ? rows.map((r) => r.line).join('\n') : '_아직 계획된 블록이 없어요._';
  const pending = o.pending.length
    ? `**계획에 없는 일**\n${o.pending
        .map((p) => `- ${code(p.ref)} ${esc(p.title)} · ${formatDurationKo(p.minutes)}${p.reason === 'blocked' ? ' · 선행 작업 대기' : p.reason === 'no_time' ? ' · 시간 부족' : ''}`)
        .join('\n')}`
    : '';
  const late = o.late.length ? `> ⚠️ 마감 시각을 넘기는 블록: ${o.late.map((l) => `${code(l.ref)} (마감 ${formatTimeKo(l.dueTime)}, 끝 ${formatTimeKo(l.end)})`).join(', ')}` : '';
  const running = o.running ? `⏱ 지금 ${code(o.running.ref)} ${esc(o.running.title)} 기록 중` : '';
  return join(head, load, running, plan, pending, late);
}

export interface OddsTaskOut {
  ref: string;
  title: string;
  dueDate: ISODate | null;
  onTime: number | null;
  conflict: number | null;
  p50: ISODate | null;
  p85: ISODate | null;
}

export type OddsOut = {
  today: ISODate;
  overall: { p50: ISODate | null; p85: ISODate | null } | null;
  projects: { project: string; tasks: number; p50: ISODate | null; p85: ISODate | null }[];
  atRisk: OddsTaskOut[];
  fixedAtRisk: OddsTaskOut[];
  calibration: { medianRatio: number | null; ratioSamples: number; onTimeRate: number | null; slipSamples: number; focusPercent: number; focusSource: string; defaultEstimateMinutes: number };
  externalTasks: number;
};

const pct = (p: number | null) => (p === null ? '–' : `${Math.round(p * 100)}%`);
const day = (d: ISODate | null, today: ISODate) => (d ? formatRelativeKo(d, today) : '6개월 뒤 이후');

export function mdOdds(o: OddsOut): string {
  const head = `### 완료 확률${o.overall ? ` · 전체 85% ${day(o.overall.p85, o.today)} (50% ${day(o.overall.p50, o.today)})` : ''}`;
  const projects = o.projects.length
    ? `**프로젝트**\n${o.projects.map((p) => `- ${esc(p.project)} · ${p.tasks}개 · 50% ${day(p.p50, o.today)} · 85% ${day(p.p85, o.today)}`).join('\n')}`
    : '';
  const risk = o.atRisk.length
    ? `**제때 끝내기 어려운 작업**\n${o.atRisk.map((t) => `- ${code(t.ref)} ${esc(t.title)} · 마감 ${t.dueDate ? formatRelativeKo(t.dueDate, o.today) : '–'} · 제때 ${pct(t.onTime)} · 85% ${day(t.p85, o.today)}`).join('\n')}`
    : '_기한 안에 끝날 가능성이 낮은 작업은 없어요._';
  const fixed = o.fixedAtRisk.length
    ? `**위험한 고정 일정**\n${o.fixedAtRisk.map((t) => `- 🔒 ${code(t.ref)} ${esc(t.title)} · 충돌 ${pct(t.conflict)}`).join('\n')}`
    : '';
  const c = o.calibration;
  const basis = `_근거: ${c.ratioSamples ? `예상보다 ${c.medianRatio!.toFixed(1)}배 걸림(${c.ratioSamples}개)` : '예상 대비 실제 기록 없음(기본 1.25배)'} · ${c.slipSamples ? `첫 마감 지킨 비율 ${pct(c.onTimeRate)}(${c.slipSamples}개)` : '마감 기록 없음'} · 하루 집중 ${c.focusPercent}% · 예상 없는 작업 ${formatDurationKo(c.defaultEstimateMinutes)}${o.externalTasks ? ` · 다른 공간 작업 ${o.externalTasks}개 포함` : ''}_`;
  return join(head, projects, risk, fixed, basis);
}

export interface CommitOptionOut {
  date: ISODate;
  probability: number;
  hurts: { ref: string; title: string; kind: 'late' | 'conflict'; before: number; after: number }[];
}

export type CommitOut = {
  today: ISODate;
  subject: string;
  minutes: number;
  estimated: boolean;
  confidence: number;
  natural: { p50: ISODate | null; p85: ISODate | null };
  safe: CommitOptionOut | null;
  earliest: CommitOptionOut | null;
  proposed: CommitOptionOut | null;
};

function hurtLines(o: CommitOptionOut): string {
  return o.hurts
    .slice(0, 8)
    .map((h) => `  - ${code(h.ref)} ${esc(h.title)} · ${h.kind === 'conflict' ? '충돌 위험' : '제때 끝낼 확률'} ${pct(h.before)} → ${pct(h.after)}`)
    .join('\n');
}

export function mdCommit(o: CommitOut): string {
  const head = `### 약속하기 전에 · ${esc(o.subject)} (${o.estimated ? '' : '예상 없음, '}${formatDurationKo(o.minutes)})`;
  const opt = (label: string, x: CommitOptionOut | null) =>
    x
      ? `- **${label}** ${formatRelativeKo(x.date, o.today)} (${formatShortKo(x.date)}) · ${pct(x.probability)}${x.hurts.length ? ` · 밀리는 일 ${x.hurts.length}개\n${hurtLines(x)}` : ' · 다른 일정에 영향 없음'}`
      : `- **${label}** 6개월 안에서는 찾지 못했어요`;
  const lines = [opt('안전한 날', o.safe)];
  if (o.earliest && o.safe && o.earliest.date !== o.safe.date) lines.push(opt('가장 빠른 날', o.earliest));
  if (o.proposed) lines.push(opt('물어본 날', o.proposed));
  const natural = `_끼워 넣지 않고 순서대로 하면: 50% ${day(o.natural.p50, o.today)}, 85% ${day(o.natural.p85, o.today)}. 기준 확률 ${pct(o.confidence)}._`;
  return join(head, lines.join('\n'), natural);
}
