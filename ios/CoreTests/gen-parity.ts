// Generates CoreTests/ParityFixtures.swift: a seeded corpus of inputs plus what the TypeScript returns for them.
// Run from anywhere:  bun ios/CoreTests/gen-parity.ts <repo root> <out ParityFixtures.swift>
// (needs the repo's node_modules for web/src/lib/reschedule.ts → react). Same seed → same corpus.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.TZ = 'Asia/Seoul'; // relativeTime's date fallback reads the local zone; ParityTests pins the same zone
const ROOT = resolve(process.argv[2] ?? '.');
const core = await import(`${ROOT}/packages/core/src/index.ts`);
const fmt = await import(`${ROOT}/web/src/lib/format.ts`);
const { orderTimes } = await import(`${ROOT}/web/src/lib/reschedule.ts`);
type Task = any;
type PlanItem = any;
type PlanDependency = { taskId: string; dependsOnId: string };
let seed = 20261119;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const chance = (p: number) => rnd() < p;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const TODAYS = ['2026-11-13', '2026-11-16', '2026-11-30', '2026-12-31', '2027-02-27', '2028-02-28', '2026-11-15'];
const dateNear = (today: string, span = 20) => core.addDays(today, int(-span, span));
const timeAny = () => `${String(int(0, 23)).padStart(2, '0')}:${pick(['00', '15', '30', '45', '05', '59'])}`;

function randTask(i: number, today: string, ws = 'w'): Task {
  const hasStart = chance(0.4);
  const hasDue = chance(0.7);
  let startDate = hasStart ? dateNear(today) : null;
  let dueDate = hasDue ? dateNear(today) : null;
  if (startDate && dueDate && startDate > dueDate) [startDate, dueDate] = [dueDate, startDate];
  return {
    id: `t${i}`,
    workspaceId: ws,
    number: int(1, 400),
    title: `task ${i}`,
    notes: '',
    status: pick(['todo', 'todo', 'todo', 'doing', 'done', 'canceled'] as const),
    priority: pick([0, 1, 2, 3] as const),
    projectId: chance(0.6) ? pick(['p1', 'p2', 'p3']) : null,
    startDate,
    startTime: startDate && chance(0.4) ? timeAny() : null,
    dueDate,
    dueTime: dueDate && chance(0.4) ? timeAny() : null,
    fixed: chance(0.2),
    position: pick([1024, 2048, 1536, 3072, 512.5, 4096]),
    postponedCount: pick([0, 0, 0, 1, 2, 3, 5]),
    assigneeId: pick([null, 'me', 'kim']),
    createdBy: pick(['me', 'kim', null]),
    completedAt: chance(0.3) ? `2026-11-${String(int(1, 28)).padStart(2, '0')}T${String(int(0, 23)).padStart(2, '0')}:00:00.000Z` : null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const toPlan = (t: Task, withNumber = true): PlanItem => ({
  id: t.id,
  title: t.title,
  ...(withNumber ? { number: t.number } : {}),
  status: t.status,
  startDate: t.startDate,
  dueDate: t.dueDate,
  startTime: t.startTime,
  dueTime: t.dueTime,
  fixed: t.fixed,
  projectId: t.projectId,
});

function randGraph(n: number, today: string) {
  const tasks = Array.from({ length: n }, (_, i) => randTask(i, today));
  for (const t of tasks) if (chance(0.15)) { t.startDate = null; t.dueDate = null; t.startTime = null; t.dueTime = null; }
  const deps: PlanDependency[] = [];
  for (let i = 1; i < n; i++) {
    const k = int(0, 2);
    for (let j = 0; j < k; j++) {
      const from = int(0, i - 1);
      if (!deps.some((d) => d.taskId === `t${i}` && d.dependsOnId === `t${from}`)) deps.push({ taskId: `t${i}`, dependsOnId: `t${from}` });
    }
  }
  if (chance(0.2) && n > 3) deps.push({ taskId: 't0', dependsOnId: `t${n - 1}` }); // a cycle now and then
  if (chance(0.2)) deps.push({ taskId: 't1', dependsOnId: 't1' });
  if (chance(0.2)) deps.push({ taskId: 't2', dependsOnId: 'ghost' });
  return { tasks, items: tasks.map((t) => toPlan(t, chance(0.8))), deps };
}

const out: Record<string, unknown[]> = {};
const add = (k: string, v: unknown) => (out[k] ??= []).push(v);

// ── quick add
const WORDS = [
  '보고서', '디자인 리뷰', '회의', 'Ship beta', '치과', '워크숍', '1:1 미팅', '정산', '이사 준비', '세금',
  '내일', '오늘', '모레', '글피', '주말', '이번 주말', '다음주', '다음 주', '담주', '차주', '이번주', '이번 주', '월말', '다음달', '다음 달',
  '금요일', '월요일까지', '다음주 수요일', '다음 주 수요일까지', '담주 화', '이번 주 목요일', '이번주금', '토욜', 'friday', 'next friday', 'next fri',
  'this sat', 'this weekend', 'next week', 'next month', 'eom', 'end of month', 'today', 'tomorrow', 'tmr', 'mon', 'thurs', 'next sun',
  '3일 후', '2주 뒤', '1개월 후', '3달 뒤', 'in 3 days', 'in 2 weeks', 'in 1 month', '+3', '+2w', '+10d',
  '2026-12-01', '2026-2-3', '2027-02-30', '11/20', '1/10', '2/30', '12.25', '11월 25일', '3월1일', '25일', '31일', '1일', '32일',
  '11/20~11/22', '내일~금요일', '오늘~', '~내일',
  '오후 3시', '3시', '9시', '오후3시 30분', '3시 반', '저녁 7시', '밤 12시', '새벽 2시', '아침 8시', '낮 2시', '밤 9시', '15:30', '09:00', '3:30', '0:30', '3pm', '9:30am', '11 pm', '12am', '12pm',
  '정오', '자정', 'noon', 'midnight', 'at 5pm', '오전 15시', '25시', '3시 70분', '10시~11시 반', '오후 2시-4시', '10:00~11:30', '오전 11시-오후 1시', '9-10시', '14시까지', '3시부터',
  '#런칭', '#제품_런칭', '#', '!높음', '!!', '!!!', 'p1', 'p2', 'p3', 'p4', '!2', '!low', '!긴급', '!none', '!zz', '@고정', '@FIXED', '@fix', '@고정됨',
  '그냥', '메모', 'at', 'in', 'next', 'this', '다음', '이번',
  '~2h', '~30m', '~1.5h', '~1h30m', '~90분', '~1시간', '~1시간 30분', '~ 45분', '~반나절', '~', '~3시', '30분', '~30', '~하루정도',
];
for (let i = 0; i < 700; i++) {
  const n = int(1, 6);
  const input = Array.from({ length: n }, () => pick(WORDS)).join(pick([' ', ' ', '  ']));
  const today = pick(TODAYS);
  const nowMinutes = chance(0.4) ? int(0, 1439) : null;
  const disabled = chance(0.15) ? [pick(['date', 'time', 'project', 'priority', 'fixed', 'estimate'] as const)] : [];
  add('quickadd', { input, today, nowMinutes, disabled, out: core.parseQuickAdd(input, today, { disabled, nowMinutes }) });
}
for (const w of WORDS) {
  for (const today of TODAYS.slice(0, 4)) add('datePhrase', { raw: w, today, out: core.parseDatePhrase(w, today) });
  add('timePhrase', { raw: w, out: core.parseTimePhrase(w) });
  add('duration', { raw: w.replace(/^~\s*/, ''), out: core.parseDuration(w.replace(/^~\s*/, '')) });
  const today = pick(TODAYS);
  const nowMinutes = chance(0.5) ? int(0, 1439) : null;
  add('dateTimePhrase', { raw: w, today, nowMinutes, out: core.parseDateTimePhrase(w, today, nowMinutes) });
}
for (const w of ['내일 오후 3시', '11/20 15:30', '금요일', '다음 주 금요일 9시', '오후 3시', '보고서', '내일~모레', '3시~4시']) {
  for (const today of TODAYS) add('dateTimePhrase', { raw: w, today, nowMinutes: 900, out: core.parseDateTimePhrase(w, today, 900) });
}
{
  const ps = [{ name: '제품 런칭' }, { name: '개인' }, { name: '블로그 운영' }, { name: '블로그 디자인' }, { name: 'Launch Plan' }, { name: 'launch' }];
  for (const q of ['런칭', '제품런칭', '개', '블로그', '디자인', '없음', 'LAUNCH', 'launch plan', 'launchplan', ' ', 'plan', '블로그 운영']) {
    add('matchProject', { projects: ps.map((p) => p.name), q, out: core.matchProject(ps, q)?.name ?? null });
  }
}

// ── dates
for (let i = 0; i < 300; i++) {
  const today = pick(TODAYS);
  const date = core.addDays(today, int(-400, 400));
  add('relative', { date, today, out: core.formatRelativeKo(date, today) });
}
for (let d = -10; d <= 10; d++) {
  const today = '2026-11-13';
  const date = core.addDays(today, d);
  add('relative', { date, today, out: core.formatRelativeKo(date, today) });
}
for (const date of ['2024-02-29', '2026-01-01', '2026-12-31', '2025-03-01', '2100-02-28', '2000-02-29', '1999-12-31', '2026-11-16']) {
  add('dateMisc', {
    date,
    short: core.formatShortKo(date),
    long: fmt.longDateKo(date),
    weekday: core.weekday(date),
    endOfMonth: core.endOfMonth(date),
    startOfWeek: core.startOfWeek(date),
    plus: core.addDays(date, 400),
    minus: core.addDays(date, -400),
    toDay: core.toDay(date),
  });
}
for (const s of ['2026-02-29', '2024-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '0026-01-01', '2026-11-31', '2026-11-30', ' 2026-11-30', '2026-11-30\n', '２０２６-11-30', 'abc'])
  add('isISODate', { s, out: core.isISODate(s) });
for (const s of ['09:05', '24:00', '9:05', '23:59', '00:00', '12:60', '1230', '٠٩:٠٥', '09:05\n']) add('isISOTime', { s, out: core.isISOTime(s) });
for (const n of [0, 1, -1, 6, 7, 13, 14, -14, 21, 100]) add('daysKo', { n, out: core.formatDaysKo(n) });
for (const n of [0, 1, 30, 59, 60, 61, 135, 1439, 1440, 2900, -40, -135]) add('durationKo', { n, out: core.formatDurationKo(n) });
for (let i = 0; i < 40; i++) {
  const a = timeAny();
  const b = timeAny();
  add('timeRange', { a, b, out: core.formatTimeRangeKo(a, b) });
}
for (const [tz, iso] of [
  ['Asia/Seoul', '2026-11-13T06:30:00Z'], ['America/New_York', '2026-11-13T03:00:00Z'], ['Europe/London', '2026-03-29T01:30:00Z'],
  ['America/Los_Angeles', '2026-03-08T10:30:00Z'], ['Asia/Kolkata', '2026-12-31T18:29:00Z'], ['Bad/Zone', '2026-11-13T06:30:00Z'], ['UTC', '2026-11-13T23:59:59Z'],
  ['Pacific/Kiritimati', '2026-11-13T10:00:00Z'], ['Asia/Seoul', '2026-11-13T06:30:00.123+02:00'],
] as const) {
  add('nowIn', { tz, iso, out: core.nowIn(tz, new Date(iso)), today: core.todayIn(tz, new Date(iso)) });
}

// ── format + views
const VIEWS = ['today', 'upcoming', 'overdue', 'inbox', 'unscheduled', 'all', 'done'] as const;
for (let i = 0; i < 400; i++) {
  const today = pick(TODAYS);
  const t = randTask(i, today);
  const now = chance(0.6) ? { date: chance(0.8) ? today : core.addDays(today, 1), minutes: int(0, 1439) } : null;
  add('format', {
    task: t,
    today,
    now,
    tone: fmt.dateTone(t, today, now),
    span: fmt.spanLabel(t, today),
    time: fmt.timeLabel(t),
    overdue: t.dueDate ? fmt.overdueLabel(t.dueDate, today, t.dueTime, now) : null,
    dueSoon: now ? fmt.dueSoonLabel(t, now) : null,
    views: Object.fromEntries(VIEWS.map((v) => [v, core.matchesView(t, v, today, now)])),
    urgency: core.urgencyOf(t, today),
  });
}
for (let i = 0; i < 60; i++) {
  const today = pick(TODAYS);
  const tasks = Array.from({ length: int(3, 25) }, (_, k) => randTask(k, today));
  const now = chance(0.5) ? { date: today, minutes: int(0, 1439) } : null;
  const view = pick(VIEWS);
  add('views', { tasks, today, now, view, out: core.selectView(tasks, view, today, now).map((t) => t.id) });
  const kind = pick(['personal', 'org'] as const);
  const sec = core.overviewSections(tasks, today);
  add('overview', {
    tasks,
    today,
    kind,
    inOverview: tasks.map((t) => core.inOverview(t, kind, 'me', today)),
    out: {
      overdue: sec.overdue.map((t) => t.id),
      today: sec.today.map((t) => t.id),
      week: sec.week.map((d) => ({ date: d.date, ids: d.tasks.map((t) => t.id) })),
      fixed: sec.fixed.map((f) => [f.task.id, f.date]),
    },
  });
}
for (const iso of ['2026-11-19T09:59:30.000Z', '2026-11-19T09:00:00.000Z', '2026-11-18T11:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', null, 'garbage']) {
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-19T10:00:00.000Z');
  add('relativeTime', { iso, out: fmt.relativeTime(iso) });
  Date.now = realNow;
}

// ── impact
for (let i = 0; i < 120; i++) {
  const today = pick(TODAYS);
  const { items, deps } = randGraph(int(2, 14), today);
  const roots = items.filter(() => chance(0.25)).map((it) => [it.id, int(-4, 6)] as [string, number]);
  if (!roots.length) roots.push([items[0]!.id, int(1, 5)]);
  add('simulate', { items, deps, shifts: roots, out: core.simulate(items, deps, new Map(roots)) });
  add('forecast', { items, deps, today, out: core.forecast(items, deps, today) });
  add('leverage', { items, deps, out: core.leverage(items, deps) });
  const target = pick(items);
  const s = chance(0.7) ? dateNear(today) : null;
  const d = chance(0.8) ? (s ? core.addDays(s, int(0, 4)) : dateNear(today)) : null;
  add('preview', { items, deps, taskId: target.id, next: { startDate: s, dueDate: d }, out: core.previewDateChange(items, deps, target.id, { startDate: s, dueDate: d }) });
  add('cycles', {
    deps,
    pairs: items.slice(0, 5).map((a) => items.slice(0, 5).map((b) => core.wouldCreateCycle(deps, a.id, b.id))),
    downstream: items.slice(0, 4).map((a) => core.downstreamOf(deps, a.id)),
  });
}

// ── jev
for (let i = 0; i < 60; i++) {
  const today = pick(TODAYS);
  const tasks = Array.from({ length: int(2, 12) }, (_, k) => {
    const t = randTask(k, today);
    if (chance(0.6)) { t.dueDate = core.addDays(today, int(-2, 3)); t.dueTime = null; if (t.startDate && t.startDate > t.dueDate) t.startDate = null; }
    return t;
  });
  const deps = randGraph(tasks.length, today).deps.filter((d) => tasks.some((t) => t.id === d.taskId) && tasks.some((t) => t.id === d.dependsOnId));
  const judgments = new Map(tasks.filter(() => chance(0.85)).map((t) => [t.id, { importance: Math.round(rnd() * 300) / 100, importanceConfidence: Math.round(rnd() * 100) / 100, others: Math.round(rnd() * 100) / 100, deferrable: Math.round(rnd() * 100) / 100 }]));
  const scope = pick(['today', 'week'] as const);
  const capacity = int(1, 6);
  const notMine = new Set(tasks.filter(() => chance(0.15)).map((t) => t.id));
  const readOnly = new Set(tasks.filter(() => chance(0.15)).map((t) => t.id));
  const plan = core.planPostpone({ tasks, deps, mine: (t) => !notMine.has(t.id), editable: (t) => !readOnly.has(t.id), judgments, today, scope, capacity, capacitySource: 'input' });
  const lev = core.leverage(tasks.map((t) => toPlan(t)), deps);
  const levMap = new Map(lev.map((l) => [l.taskId, l]));
  const suggestions = tasks.filter((t) => judgments.has(t.id)).map((t) => core.suggestPriority(t, judgments.get(t.id)!, levMap.get(t.id), today));
  const scores = new Map(suggestions.map((s) => [s.taskId, s.score]));
  add('jev', {
    tasks, deps, judgments: Object.fromEntries(judgments), today, scope, capacity,
    notMine: [...notMine], readOnly: [...readOnly],
    plan, suggestions, focus: core.pickFocus(tasks, deps, scores, today),
    capacityFromHistory: core.capacityFromHistory(tasks.map((t) => (t.completedAt ? t.completedAt.slice(0, 10) : null)), today),
  });
}

// ── activity (data as it comes back from jsonb: keys shortest first, then bytewise)
const jsonb = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(jsonb);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const o: Record<string, unknown> = {};
    for (const k of keys) o[k] = jsonb((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
};
const ACTIVITY: { action: string; data: Record<string, unknown> }[] = [
  { action: 'task.created', data: {} },
  { action: 'task.created', data: { assignee: '김민지' } },
  { action: 'task.updated', data: { changes: { dueDate: { from: '2026-11-20', to: '2026-11-23' }, status: { from: 'todo', to: 'done' }, title: { from: 'a', to: 'b' }, notes: true, priority: { from: 0, to: 3 }, fixed: { from: false, to: true }, dueTime: { from: null, to: '15:30' }, startTime: { from: '09:00', to: 'bad' }, project: { from: null, to: '런칭' }, assignee: { from: 'a', to: null }, archived: { from: false, to: true }, weird: { from: 1.5, to: [1, null, 'x'] } } } },
  { action: 'task.updated', data: { changes: { status: { from: 'done', to: 'doing' } }, cause: '#3 시안' } },
  { action: 'task.updated', data: { changes: { status: { from: 'canceled', to: 'todo' } } } },
  { action: 'task.updated', data: { changes: { status: { from: 'todo', to: 'doing' }, startDate: { from: '2026-11-01', to: null } } } },
  { action: 'task.updated', data: {} },
  { action: 'task.updated', data: { changes: { priority: { from: '2', to: 9 }, startDate: { from: '', to: '2026-01-05' } } } },
  { action: 'task.postponed', data: { days: 3, cascade: true, moved: 2 } },
  { action: 'task.postponed', data: { days: -2, cascade: true, moved: 0 } },
  { action: 'task.postponed', data: { days: null } },
  { action: 'task.postponed', data: { days: 'x' } },
  { action: 'task.deleted', data: {} },
  { action: 'task.restored', data: {} },
  { action: 'dependency.added', data: { blockedBy: '#2 기획' } },
  { action: 'dependency.removed', data: {} },
  { action: 'project.created', data: { memberAccess: 'view' } },
  { action: 'project.created', data: { memberAccess: 'none' } },
  { action: 'project.updated', data: { changes: { name: { from: 'a', to: 'b' }, color: { from: 'red', to: 'blue' }, archived: { from: false, to: true } } } },
  { action: 'project.updated', data: { changes: {} } },
  { action: 'project.archived', data: {} },
  { action: 'project.unarchived', data: {} },
  { action: 'project.deleted', data: { tasks: 'deleted' } },
  { action: 'project.deleted', data: { tasks: 'inbox' } },
  { action: 'project.access', data: { changes: [{ everyone: { from: 'none', to: 'view' } }, { member: '김민지', userId: 'u', from: null, to: 'edit' }, { team: '디자인', teamId: 't', from: 'edit', to: null }] } },
  { action: 'project.moved_out', data: { to: '개인', tasks: 3 } },
  { action: 'project.moved_in', data: { from: '팀' } },
  { action: 'workspace.created', data: {} },
  { action: 'workspace.updated', data: { changes: { name: { from: 'a', to: 'b' }, membersCanCreateProjects: { from: true, to: false } } } },
  { action: 'member.joined', data: { role: 'member' } },
  { action: 'member.joined', data: {} },
  { action: 'member.role', data: { from: 'member', to: 'admin' } },
  { action: 'member.removed', data: {} },
  { action: 'member.left', data: {} },
  { action: 'invite.created', data: { role: 'admin' } },
  { action: 'invite.revoked', data: {} },
  { action: 'team.created', data: {} },
  { action: 'team.updated', data: { renamed: { from: '디자인', to: '브랜드' }, added: ['a', 'b'], removed: ['c'] } },
  { action: 'team.updated', data: {} },
  { action: 'team.deleted', data: {} },
  { action: 'something.new', data: {} },
];
for (const e of ACTIVITY) {
  const data = jsonb(e.data) as Record<string, unknown>;
  add('activity', { action: e.action, data, out: core.describeActivity({ action: e.action, data, subject: 's' }), kind: core.activityKind(e.action), event: core.webhookEventFor(e.action, data) });
}
for (const via of ['session', 'api_token', 'oauth', 'webhook', 'system'] as const)
  for (const client of [null, 'Claude', '']) add('via', { via, client, out: core.viaLabelKo(via, client) });

// ── webhooks
for (const url of [
  'https://hooks.slack.com/services/T0AAA/B0BBB/abcdef123456', 'https://example.com/hook', 'https://example.com', 'https://example.com/',
  'https://discord.com/api/webhooks/1/abc', 'https://ptb.discord.com/api/webhooks/1/abc', 'https://canary.discordapp.com/api/webhooks/9/x',
  'https://discord.com/channels/1', 'not a url', 'https://Example.COM:8443/a/b/c', 'http://example.com:80/x', 'https://example.com/averyveryverylongsinglesegmentpath',
  'https://example.com/a///', 'HTTPS://HOOKS.SLACK.COM/services/x', 'https://x.com/a?b=c',
]) add('urls', { url, mask: core.maskWebhookUrl(url), format: core.detectWebhookFormat(url) });
for (const base of ['https://api.typesafe.ai/v1', 'https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1/systemone', ' https://x.example/v1// ', 'not a url', 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/cloudflare/clef', 'http://localhost:8080', 'https://decide.example.com/systemone/'])
  add('jevUrls', { base, endpoint: core.jevEndpoint(base), preset: core.jevPresetOf(base) });
for (let i = 0; i < 60; i++) {
  const today = pick(TODAYS);
  const { items, deps } = randGraph(int(2, 10), today);
  const now = chance(0.6) ? { date: today, minutes: int(0, 1439) } : null;
  add('alerts', { items, deps, today, now, out: core.scheduleAlerts(items, deps, today, now) });
  const lead = pick([0, 5, 30, 60, 1440]);
  const clock = { date: today, minutes: int(0, 1439) };
  const reminders = core.reminderAlerts(items, clock, lead);
  add('reminders', { items, now: clock, lead, out: reminders, summaries: reminders.map((r) => core.reminderSummary(r, today)) });
}
for (const a of [
  { key: 'task.due_today' }, { key: 'task.due_today', time: '15:00' }, { key: 'task.due_soon', time: '09:30' }, { key: 'task.overdue', daysOverdue: 2 },
  { key: 'task.overdue', daysOverdue: 0, time: '15:00' }, { key: 'task.overdue', daysOverdue: 0 }, { key: 'fixed.conflict', overrunDays: 2 }, { key: 'fixed.conflict' },
] as const) {
  add('scheduleSummary', { alert: a, cause: null, out: core.scheduleSummary(a) });
  add('scheduleSummary', { alert: a, cause: '#3 시안', out: core.scheduleSummary(a, '#3 시안') });
}
for (const m of [0, 5, 30, 60, 90, 1440]) add('remindLead', { m, out: core.remindLeadLabel(m) });

const BODIES: unknown[] = [
  '보고서 초안 내일 !높음 #런칭', '배포 확인\n로그 먼저 보기\n롤백 준비', '배포 확인\r\n노트', '#12 완료', '#12 done.', '#7 다시 열기', '#12 시작', '#12 금요일까지', '#12 !높음',
  '#12 이상한 말', '#12', '#12 내일 15:30까지', '#12 @고정', '#12 내일~금요일', '#12 완료\n노트', '   ', '', '#1234567890 완료', '치과 내일 오후 3시', 'x'.repeat(501), '#12 IN PROGRESS', '#3 to-do', '#3 할 일!!',
  { text: '회의록 정리' }, { content: '#5 완료' }, { action: 'create', text: '#5 완료' }, { action: 'create', message: '새 일' },
  { title: ' 배포 확인 ', dueDate: '내일', priority: 'high', project: '런칭', assignee: 'me', fixed: 'true', notes: 'n' },
  { title: 'x', dueDate: '2026-11-20T09:00:00Z', priority: '보통' }, { title: 'x', dueDate: '언젠가' }, { title: 'x', priority: 9 },
  { title: 'x', startDate: '2026-11-20', dueDate: '2026-11-18' }, {}, { title: '' }, { title: null }, { title: 5 }, { title: 'x', description: 'desc' },
  { title: 'x', start: '2026-11-20', start_time: '9:30' }, { title: 'x', dueDate: null, dueTime: '15:00' }, { title: 'x', dueTime: '25:00' },
  { title: 'x', dueDate: '2026-11-20 15:30' }, { title: 'x', dueDate: '2026-11-20T15:30:45.123+09:00' }, { title: 'x', dueDate: '2026-11-20T' },
  { title: 'x', dueDate: '2026-11-20Tabc' }, { title: 'x', dueDate: 20261120 }, { title: 'x', dueDate: false }, { title: 'x', dueDate: 'none' },
  { title: 'x', fixed: 1 }, { title: 'x', fixed: 'yes' }, { title: 'x', status: 'DONE' }, { title: 'x', status: 'whatever' }, { title: 'x', priority: '!2' }, { title: 'x', priority: 'P1' },
  { title: 'x', projectId: 'p1', assigneeId: 'u1' }, { title: 'x', project: null, projectId: '런칭' }, { title: { a: 1 } },
  { action: 'complete', task: '#12' }, { action: 'complete', task: 12 }, { action: 'update', task: '#3', dueDate: null, priority: 'low' },
  { task: '#3', status: '진행 중' }, { action: 'update', task: '#3' }, { action: 'complete', task: '기획서' }, { action: 'explode', task: '#1' },
  { action: 'complete', task: '#1', status: 'todo' }, { action: 'Complete ', task: '#1' }, { action: 5, task: '#1' }, { action: null }, { ref: 7, title: 'new' },
  { number: 7, status: 'done' }, { task: null, ref: null, number: null, title: 'x' }, { task: '0f8fad5b-d9cb-469f-a165-70867728950e', status: 'done' },
  { task: '#3', dueDate: '2026-11-20T15:30', dueTime: null }, { task: '#3', startDate: '2026-11-20', startTime: '18:00', dueDate: '2026-11-20', dueTime: '10:00' },
  { task: '#3', notes: 5 }, { task: '#3', notes: null }, [1, 2], 5, null, true,
];
for (const body of BODIES) {
  for (const opts of [{}, { timeZone: 'Asia/Seoul', nowMinutes: 600 }, { timeZone: 'America/New_York', nowMinutes: 1300 }]) {
    add('incoming', { body, opts, out: core.parseIncoming(body, '2026-11-13', opts) });
  }
}
{
  const payload = (over: Record<string, unknown>) => ({
    id: 'e1', event: 'task.updated', createdAt: '2026-11-13T00:00:00.000Z', workspace: { id: 'w', name: '디자인팀', kind: 'org' },
    actor: { id: 'u', name: '민겸', via: 'session', client: null }, subject: '#12 기획서', summary: '마감일 11/20 → 11/22', text: '', url: 'https://obelisk.test/t/1', ...over,
  });
  const cases = [
    {}, { actor: null }, { subject: '' }, { url: null }, { subject: '#12 A<B>&C | x', event: 'task.completed' }, { actor: { id: null, name: '*bold* _x_ [y](z) #1 -2 @here', via: 'oauth', client: 'Claude' } },
    { summary: '`code` ~strike~ > quote \\ back', event: 'ping' }, { event: 'fixed.conflict', actor: { id: 'u', name: 'A&B', via: 'api_token', client: 'CI|bot' } },
  ];
  for (const c of cases) {
    const p = payload(c) as never;
    add('chat', { payload: p, text: core.webhookText(p), slack: core.chatMessage(p, 'slack'), discord: core.chatMessage(p, 'discord') });
  }
}

// ── reschedule (orderTimes and the pure parts of requestDateChange)
for (let i = 0; i < 150; i++) {
  const today = '2026-11-13';
  const t = randTask(i, today);
  if (chance(0.5)) { t.startDate = today; t.dueDate = today; t.startTime = chance(0.8) ? timeAny() : null; t.dueTime = chance(0.8) ? timeAny() : null; }
  const date = chance(0.7) ? today : dateNear(today, 2);
  const next: Record<string, unknown> = { startDate: chance(0.85) ? date : null, dueDate: chance(0.85) ? date : null };
  if (chance(0.5)) next.startTime = chance(0.85) ? timeAny() : null;
  if (chance(0.5)) next.dueTime = chance(0.85) ? timeAny() : null;
  add('orderTimes', { task: t, next, out: orderTimes(t, next as never) });
}

const json = JSON.stringify(out);
if (json.includes("\"\"\"##") || json.includes("\\##")) throw new Error('fixture would break the raw string');
const swift = `// Generated by a bun script from the TypeScript sources: inputs and what the TypeScript returns for them.
// Regenerate instead of editing. ${Object.entries(out).map(([k, v]) => `${k}: ${v.length}`).join(', ')}

let PARITY_FIXTURES = ##"""
${json}
"""##
`;
writeFileSync(process.argv[3]!, swift);
console.log(Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '), `${(json.length / 1024).toFixed(0)} KB`);
