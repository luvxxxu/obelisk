/**
 * Smoke test for time planning: estimates, timers, day plans, finish-date odds and promise dates.
 *   bun scripts/time-smoke.ts [baseUrl]
 * Signs up a throwaway account (needs SIGNUP_MODE=open), works only in its personal space.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.argv[2] ?? 'http://localhost:4000').replace(/\/$/, '');
let cookie = '';
let failures = 0;

function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`);
  }
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, 'x-obelisk-client': 'web' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${text}`), { status: res.status });
  return json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`time planning smoke against ${BASE}`);
const email = `time-${Date.now()}@example.test`;
await api('POST', '/api/auth/signup', { email, password: 'time-smoke-1234', name: '시간 테스트', timezone: 'Asia/Seoul' });
const boot = await api('GET', '/api/bootstrap');
const today: string = boot.today;
check(boot.user.workHours?.start === '09:00' && boot.user.workHours.days.length === 5, 'default work hours on the user');

// ── work hours: the whole day, so the plan has room whenever this runs
const hours = await api('PUT', '/api/auth/me/work-hours', { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:55', breaks: [], focus: 0.8, defaultEstimate: 30 });
check(hours.user.workHours.end === '23:55' && hours.user.workHours.focus === 0.8, 'work hours saved');
let bad = 0;
await api('PUT', '/api/auth/me/work-hours', { days: [1], start: '18:00', end: '09:00', breaks: [], focus: null, defaultEstimate: null }).catch((e) => (bad = e.status));
check(bad === 400, 'end before start is refused');

// ── estimates
const proj = (await api('POST', '/api/projects', { name: '시간 테스트' })).project;
const a = (await api('POST', '/api/tasks', { title: '보고서 초안', projectId: proj.id, dueDate: today, estimateMinutes: 90, priority: 3 })).task;
const b = (await api('POST', '/api/tasks', { title: '검토', projectId: proj.id, dueDate: today, estimateMinutes: 30, blockedBy: [a.id] })).task;
const c = (await api('POST', '/api/tasks', { title: '메일 정리', dueDate: today })).task;
check(a.estimateMinutes === 90 && a.actualMinutes === 0, 'estimate stored, nothing tracked yet');
const upd = (await api('PATCH', `/api/tasks/${c.id}`, { estimateMinutes: 20 })).task;
check(upd.estimateMinutes === 20, 'estimate updated');
let estBad = 0;
await api('PATCH', `/api/tasks/${c.id}`, { estimateMinutes: 0 }).catch((e) => (estBad = e.status));
check(estBad === 400, 'zero estimate refused');

// ── time: in progress starts the clock, done stops it
await api('PATCH', `/api/tasks/${a.id}`, { status: 'doing' });
let running = (await api('GET', '/api/time/running')).running;
check(running?.task.id === a.id && running.entry.source === 'auto', 'in progress starts an auto clock');
await api('POST', '/api/time/timer', { taskId: c.id, action: 'start' });
running = (await api('GET', '/api/time/running')).running;
const cNow = (await api('GET', `/api/tasks/${c.id}`)).task;
check(running?.task.id === c.id && running.entry.source === 'timer', 'a timer on another task takes over (one clock)');
check(cNow.status === 'doing', 'starting a timer puts a to-do task in progress');
await sleep(1200);
const stop = await api('POST', '/api/time/timer', { taskId: c.id, action: 'stop' });
check(stop.running === null, 'timer stopped');
const entriesA = (await api('GET', `/api/tasks/${a.id}/time`)).entries;
check(entriesA.length === 1 && entriesA[0].endedAt && entriesA[0].mine, 'the auto entry was closed when the timer took over');
const logged = (await api('POST', '/api/time/entries', { taskId: b.id, minutes: 25 })).task;
check(logged.actualMinutes === 25, 'manual minutes count');
const set = (await api('PUT', `/api/tasks/${b.id}/actual`, { minutes: 40 })).task;
check(set.actualMinutes === 40, 'setting the total replaces my entries');
const doneA = (await api('PATCH', `/api/tasks/${a.id}`, { status: 'done' })).task;
check(doneA.actualMinutes >= 0 && doneA.status === 'done', 'done task carries its total');
const entryB = (await api('GET', `/api/tasks/${b.id}/time`)).entries[0];
const del = (await api('DELETE', `/api/time/entries/${entryB.id}`)).task;
check(del.actualMinutes === 0, 'deleting my entry recounts');

// ── day plan (tomorrow, so the check doesn't depend on what time it is now)
const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const view0 = await api('GET', `/api/plan/day/${tomorrow}`);
check(view0.date === tomorrow && view0.blocks.length === 0, 'empty day');
check(view0.pending.some((p: any) => p.taskId === b.id) && view0.pending.some((p: any) => p.taskId === c.id), 'pending work listed');
const preview = await api('POST', `/api/plan/day/${tomorrow}/auto`, {});
check(preview.view === null && preview.plan.blocks.length >= 2, 'auto plan previews');
check(preview.tasks.some((t: any) => t.id === b.id), 'preview carries task summaries');
const applied = await api('POST', `/api/plan/day/${tomorrow}/auto`, { apply: true });
check(applied.view.blocks.length === preview.plan.blocks.length, 'applying saves the blocks');
const first = applied.view.blocks[0];
const moved = (await api('PATCH', `/api/plan/blocks/${first.id}`, { start: '23:00', end: '23:30' })).block;
check(moved.locked === true && moved.start === '23:00', 'moving a block locks it');
const again = await api('POST', `/api/plan/day/${tomorrow}/auto`, { apply: true });
check(again.view.blocks.some((x: any) => x.id === first.id && x.start === '23:00'), 're-planning keeps a locked block');
let swapBad = 0;
await api('PATCH', `/api/plan/blocks/${first.id}`, { start: '10:00', end: '09:00' }).catch((e) => (swapBad = e.status));
check(swapBad === 400, 'a block ending before it starts is refused');
const manual = (await api('POST', '/api/plan/blocks', { taskId: c.id, date: tomorrow, start: '23:30', end: '23:50' })).block;
check(manual.locked, 'hand-placed block is locked');
const range = (await api('GET', `/api/plan/blocks?from=${today}&to=${tomorrow}`)).blocks;
check(range.length >= 2, 'range lists blocks');
await api('DELETE', `/api/plan/blocks/${manual.id}`);
await api('DELETE', `/api/plan/day/${tomorrow}?unlocked=true`);
const after = await api('GET', `/api/plan/day/${tomorrow}`);
check(after.blocks.length === 1 && after.blocks[0].id === first.id, 'clearing planner blocks keeps the locked one');

// ── odds
const odds = await api('GET', '/api/odds');
check(Array.isArray(odds.report.tasks) && odds.report.tasks.some((t: any) => t.taskId === b.id), 'odds per task');
check(odds.calibration.focusSource === 'setting' && odds.calibration.defaultEstimate === 30, 'calibration reads the settings');
const later = (await api('POST', '/api/tasks', { title: '나중 일', dueDate: new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10), estimateMinutes: 60 })).task;
const commit = await api('POST', '/api/odds/commit', { title: '견적서', estimateMinutes: 120, projectId: proj.id });
check(commit.report.safe && commit.report.earliest && commit.report.safe.date >= commit.report.earliest.date, 'commit: safe on or after earliest');
check(commit.minutes === 120 && commit.estimated === true, 'commit echoes the minutes');
const commitTask = await api('POST', '/api/odds/commit', { taskId: later.id, date: today });
check(typeof commitTask.report.proposed?.probability === 'number', 'commit for an existing task with a proposed date');
let commitBad = 0;
await api('POST', '/api/odds/commit', {}).catch((e) => (commitBad = e.status));
check(commitBad === 400, 'commit needs something to promise');

// ── MCP tools
const token = (await api('POST', '/api/tokens', { name: 'time smoke' })).token as string;
const mcp = new Client({ name: 'time-smoke', version: '1' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const tools = (await mcp.listTools()).tools.map((t) => t.name);
check(['get_day_plan', 'plan_day', 'track_time', 'get_odds', 'check_commitment'].every((n) => tools.includes(n)), 'MCP lists the time tools');
const text = (r: any) => r.content?.[0]?.text ?? '';
const made = await mcp.callTool({ name: 'create_task', arguments: { title: 'MCP 작업', dueDate: today, estimate: '1h30m' } });
check(!made.isError && (made.structuredContent as any)?.created?.estimateMinutes === 90, 'create_task takes "1h30m"');
const dp = await mcp.callTool({ name: 'plan_day', arguments: {} });
check(!dp.isError && text(dp).includes('하루 계획 미리보기'), 'plan_day previews in markdown');
const gd = await mcp.callTool({ name: 'get_day_plan', arguments: { date: 'today' } });
check(!gd.isError && text(gd).includes('하루 계획'), 'get_day_plan');
const tt = await mcp.callTool({ name: 'track_time', arguments: { ref: 'MCP 작업', action: 'log', minutes: 15 } });
check(!tt.isError && (tt.structuredContent as any)?.task?.actualMinutes === 15, 'track_time logs minutes');
const go = await mcp.callTool({ name: 'get_odds', arguments: {} });
check(!go.isError && text(go).includes('완료 확률'), 'get_odds');
const cc = await mcp.callTool({ name: 'check_commitment', arguments: { title: '고객 견적', estimate: 120 } });
check(!cc.isError && text(cc).includes('약속하기 전에'), 'check_commitment');
const badEst = await mcp.callTool({ name: 'create_task', arguments: { title: 'x', estimate: '언젠가' } });
check(badEst.isError, 'nonsense estimate is an error');
await mcp.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nall time-planning checks passed');
process.exit(failures ? 1 : 0);
