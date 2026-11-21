/**
 * End-to-end smoke test against a running Obelisk (backend direct or through the web proxy).
 *   bun scripts/smoke.ts [baseUrl]
 * Creates a throwaway account (needs SIGNUP_MODE=open or an empty DB).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomBytes } from 'node:crypto';

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
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie, 'x-obelisk-client': 'web' } : {}),
      ...headers,
    },
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
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return json;
}

/** The HTTP status a call fails with (or 200). */
async function status(method: string, path: string, body?: unknown) {
  try {
    await api(method, path, body);
    return 200;
  } catch (e) {
    return Number(/→ (\d{3})/.exec(String(e))?.[1] ?? 0);
  }
}

const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

console.log(`Obelisk smoke test → ${BASE}`);

console.log('auth');
const email = `smoke-${Date.now()}@example.com`;
const { user } = await api('POST', '/api/auth/signup', { email, password: 'correct-horse', name: 'Smoke', timezone: 'Asia/Seoul' });
check(user?.email === email && cookie, 'signup sets a session');
check((await api('GET', '/api/auth/me')).user.id === user.id, 'me');

console.log('planner');
const { project } = await api('POST', '/api/projects', { name: '런칭' });
const { task: a } = await api('POST', '/api/tasks', { title: '디자인', projectId: project.id, startDate: day(1), dueDate: day(2) });
const { task: b } = await api('POST', '/api/tasks', { title: '개발', projectId: project.id, startDate: day(3), dueDate: day(5), blockedBy: [a.id] });
const { task: c } = await api('POST', '/api/tasks', { title: '출시 발표', projectId: project.id, dueDate: day(6), fixed: true, blockedBy: [b.id] });
check(a.number === 1 && c.number === 3, 'task numbers are sequential');
const boot = await api('GET', '/api/bootstrap');
check(boot.tasks.length === 3 && boot.dependencies.length === 2, 'bootstrap returns tasks + dependencies');

const sim = await api('POST', '/api/impact/simulate', { taskId: a.id, days: 3 });
const kinds = Object.fromEntries(sim.report.impacts.map((i: any) => [i.title, i.kind]));
check(kinds['개발'] === 'shifted' && kinds['출시 발표'] === 'conflict', 'simulate: dev shifts, fixed launch conflicts');

// A has one day of slack before B: +1 is absorbed, +2 pushes B by one day.
const post = await api('POST', '/api/impact/postpone', { taskId: a.id, days: 2, cascade: true });
check(post.updated.length === 2 && post.updated.find((t: any) => t.id === b.id)?.startDate === day(4), 'postpone with cascade moves A and pushes B by 1');
check(post.task.postponedCount === 1, 'postponedCount increments');
const fc = await api('GET', '/api/impact/forecast');
check(fc.today && Array.isArray(fc.report.impacts), 'forecast');

let cycleRejected = false;
try {
  await api('POST', `/api/tasks/${a.id}/dependencies`, { dependsOnId: c.id });
} catch (e) {
  cycleRejected = String(e).includes('400');
}
check(cycleRejected, 'dependency cycles are rejected');

let csrfBlocked = false;
try {
  await api('POST', '/api/tasks', { title: 'x' }, { 'x-obelisk-client': '' });
} catch (e) {
  csrfBlocked = String(e).includes('403');
}
check(csrfBlocked, 'cookie writes without client header are refused');

console.log('mcp (api token)');
const { token } = await api('POST', '/api/tokens', { name: 'smoke' });
check(token?.startsWith('obk_'), 'api token minted');

async function mcp(bearer: string) {
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
  return client;
}
const client = await mcp(token);
const { tools } = await client.listTools();
check(tools.length >= 20, `tools/list → ${tools.length} tools`);
const prompts = await client.listPrompts();
check(prompts.prompts.length === 3, 'prompts/list → 3 prompts');
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
};
const ov = await call('get_overview');
check(ov.today && ov.counts.active === 3, 'get_overview');
const plan = await call('create_tasks', {
  project: '런칭',
  tasks: [
    { key: 'qa', title: 'QA', dueDate: day(8) },
    { key: 'docs', title: '문서', dueDate: day(9), blockedBy: ['qa', '#2'] },
  ],
});
check(plan.created.length === 2 && plan.dependencies.length === 2, 'create_tasks wires keys + refs');
const simM = await call('simulate_delay', { ref: '#1', days: 2 });
check(typeof simM.prediction.headline === 'string', `simulate_delay → "${simM.prediction.headline}"`);
const done = await call('complete_task', { ref: '디자인' });
check(
  done.task.status === 'done' && done.nowUnblocked?.some((t: { ref: string }) => t.ref === '#2'),
  'complete_task by title, reports unblocked',
);
const s = await call('search', { query: '문서' });
check(s.results.length === 1, 'search');
const f = await call('fetch', { id: s.results[0].id });
check(f.text.includes('Blocked by'), 'fetch');
const bn = await call('get_bottlenecks');
check(Array.isArray(bn.bottlenecks), 'get_bottlenecks');
const gone = await call('delete_task', { ref: '문서' });
const binM = await call('list_trash');
check(binM.items.some((i: { ref: string; title: string }) => `${i.ref} ${i.title}` === gone.deleted), 'delete_task moves to the trash, list_trash shows it');
const backM = await call('restore_task', { ref: '문서' });
check(backM.restored === gone.deleted && backM.relinked === 2, 'restore_task brings it back with its links');

console.log('mcp apps (cards)');
const uiTools = tools.filter((t) => (t._meta as any)?.ui?.resourceUri);
check(uiTools.length >= 10, `${uiTools.length} tools render an MCP Apps card`);
const uri = (uiTools.find((t) => t.name === 'simulate_delay')!._meta as any).ui.resourceUri as string;
const page: any = (await client.readResource({ uri })).contents[0];
check(page.mimeType === 'text/html;profile=mcp-app' && page.text.includes('ui/initialize'), `resources/read ${uri}`);
const simText: any = await client.callTool({ name: 'simulate_delay', arguments: { ref: '#2', days: 2 } });
check(simText.content[0].text.startsWith('### 지연 시뮬레이션'), 'tool text is Linear-style markdown');
await client.close();

const uiClient = new Client(
  { name: 'smoke-ui', version: '1.0.0' },
  { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } as never },
);
await uiClient.connect(
  new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
);
check(uiClient.getInstructions()?.includes('Obelisk cards') === true, 'UI-capable clients get card presentation instructions');
await uiClient.close();

console.log('oauth');
const meta = await api('GET', '/.well-known/oauth-authorization-server');
check(meta.code_challenge_methods_supported.includes('S256'), 'AS metadata');
const reg = await api('POST', '/api/oauth/register', {
  client_name: 'Smoke Client',
  redirect_uris: ['http://localhost:33418/callback'],
  token_endpoint_auth_method: 'none',
});
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const params = {
  response_type: 'code',
  client_id: reg.client_id,
  redirect_uri: 'http://localhost:33418/callback',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'xyz',
  resource: `${BASE}/mcp`,
};
const desc = await api('GET', `/api/oauth/request?${new URLSearchParams(params)}`);
check(desc.clientName === 'Smoke Client', 'consent screen sees client name');
const { redirectTo } = await api('POST', '/api/oauth/authorize', { ...params, approve: true });
const code = new URL(redirectTo).searchParams.get('code')!;
check(code && new URL(redirectTo).searchParams.get('state') === 'xyz', 'authorize returns code + state');
const tokenRes = await fetch(`${BASE}/api/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: reg.client_id,
    redirect_uri: params.redirect_uri,
  }),
}).then((r) => r.json());
check(tokenRes.access_token?.startsWith('oat_'), 'code → access token (form-encoded)');
const oc = await mcp(tokenRes.access_token);
check((await oc.listTools()).tools.length >= 20, 'MCP works with OAuth access token');
await oc.close();
const refreshed = await fetch(`${BASE}/api/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenRes.refresh_token, client_id: reg.client_id }),
}).then((r) => r.json());
check(refreshed.access_token && refreshed.access_token !== tokenRes.access_token, 'refresh rotates tokens');
const reuse = await fetch(`${BASE}/api/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenRes.refresh_token, client_id: reg.client_id }),
});
check(reuse.status === 400, 'old refresh token is dead');

console.log('trash');
{
  const { project: tp } = await api('POST', '/api/projects', { name: '휴지통 시험' });
  const { task: t1 } = await api('POST', '/api/tasks', { title: '자료 조사', projectId: tp.id, dueDate: day(1) });
  const { task: t2 } = await api('POST', '/api/tasks', { title: '초안', projectId: tp.id, startDate: day(2), startTime: '10:00', dueDate: day(3), blockedBy: [t1.id] });
  const { task: t3 } = await api('POST', '/api/tasks', { title: '검토', projectId: tp.id, dueDate: day(4), blockedBy: [t2.id] });
  const { task: t4 } = await api('POST', '/api/tasks', { title: '발송', projectId: tp.id, dueDate: day(5), blockedBy: [t3.id] });
  await api('PATCH', `/api/tasks/${t2.id}`, { status: 'done' });
  const ids = [t2.id, t3.id];
  const touches = (d: { taskId: string; dependsOnId: string }) => ids.includes(d.taskId) || ids.includes(d.dependsOnId);

  check((await status('POST', '/api/tasks/delete', { ids: [t2.id, crypto.randomUUID()] })) === 404, 'bulk delete is all or nothing (an unknown id cancels it)');
  check((await api('GET', `/api/tasks/${t2.id}`)).task.id === t2.id, 'so nothing was deleted');
  const del = await api('POST', '/api/tasks/delete', { ids });
  check(del.deleted.length === 2, 'POST /api/tasks/delete moves both');
  let b = await api('GET', '/api/bootstrap');
  check(!b.tasks.some((t: any) => ids.includes(t.id)) && !b.dependencies.some(touches), 'trashed tasks and their links leave bootstrap');
  check((await status('GET', `/api/tasks/${t3.id}`)) === 404, 'a trashed task answers 404');

  let items = (await api('GET', '/api/trash')).items;
  const i2 = items.find((i: any) => i.task.id === t2.id);
  const i3 = items.find((i: any) => i.task.id === t3.id);
  check(items.length === 2 && items[0].task.number === t3.number, 'GET /api/trash lists them, newest first');
  check(
    i2.dependencies.length === 2 && i3.dependencies.length === 2 && i3.dependencies.some((d: any) => d.taskId === t4.id && d.dependsOnId === t3.id),
    'each keeps the links it had',
  );
  check(Date.parse(i2.purgeAt) - Date.parse(i2.deletedAt) === 30 * 86_400_000, 'purgeAt is 30 days after deletion');
  check(i2.canRestore && i2.deletedByName === 'Smoke' && i2.task.status === 'done' && i2.task.startTime === '10:00', 'with who deleted it and the task as it was');

  const res = await api('POST', '/api/trash/restore', { ids });
  const r2 = res.tasks.find((t: any) => t.id === t2.id);
  check(res.tasks.length === 2 && res.missing.length === 0, 'POST /api/trash/restore brings both back');
  check(
    r2.number === t2.number && r2.createdAt === t2.createdAt && r2.status === 'done' && r2.completedAt && r2.startTime === '10:00' && r2.projectId === tp.id,
    'same id, number, dates and status',
  );
  check(res.dependencies.length === 3, 'and re-links all three dependencies');
  b = await api('GET', '/api/bootstrap');
  check(ids.every((id) => b.tasks.some((t: any) => t.id === id)) && b.dependencies.filter(touches).length === 3, 'bootstrap has them again (done one included)');
  check((await api('GET', '/api/trash')).items.length === 0, 'the trash is empty again');
  const hist = (await api('GET', `/api/tasks/${t2.id}/activity`)).activity;
  check(hist.some((e: any) => e.action === 'task.deleted') && hist[0].action === 'task.restored', 'history shows the delete and the restore');
  check((await status('POST', '/api/trash/restore', { ids: [crypto.randomUUID()] })) === 404, 'restoring something not in the trash is 404');
  const again = await api('POST', '/api/trash/restore', { ids: [t2.id] });
  check(again.tasks.length === 0 && again.missing[0] === t2.id, 'restoring a live task again just lists it as missing');

  check((await api('DELETE', `/api/tasks/${t3.id}`)).ok === true, 'DELETE /api/tasks/:id still works');
  items = (await api('GET', '/api/trash')).items;
  check(items.length === 1 && items[0].task.id === t3.id, 'and lands in the trash');
  check((await api('POST', '/api/trash/purge', { ids: [t3.id] })).purged === 1, 'purge deletes it for good');
  check((await api('GET', '/api/trash')).items.length === 0 && (await status('POST', '/api/trash/restore', { ids: [t3.id] })) === 404, 'gone from the trash, cannot be restored');
  b = await api('GET', '/api/bootstrap');
  check(!b.dependencies.some((d: any) => d.taskId === t4.id), 'its links stay gone');

  await api('POST', '/api/tasks/delete', { ids: [t1.id, t2.id] });
  check((await api('POST', '/api/trash/empty')).purged === 2, 'empty deletes everything for good');
  check((await api('GET', '/api/trash')).items.length === 0, 'and leaves the trash empty');

  const { project: gp } = await api('POST', '/api/projects', { name: '지울 프로젝트' });
  const { task: g1 } = await api('POST', '/api/tasks', { title: '프로젝트 작업 1', projectId: gp.id });
  const { task: g2 } = await api('POST', '/api/tasks', { title: '프로젝트 작업 2', projectId: gp.id, blockedBy: [g1.id] });
  await api('DELETE', `/api/projects/${gp.id}?deleteTasks=true`);
  items = (await api('GET', '/api/trash')).items;
  check(items.length === 2 && items.every((i: any) => i.task.projectId === null && i.canRestore), 'deleting a project with its tasks puts them in the trash (bound for the inbox)');
  const back = await api('POST', '/api/trash/restore', { ids: [g1.id, g2.id] });
  check(back.tasks.length === 2 && back.tasks.every((t: any) => t.projectId === null) && back.dependencies.length === 1, 'restoring them puts them in the inbox, linked');
  check(back.tasks.find((t: any) => t.id === g2.id)?.number === g2.number, 'with their numbers');

  // B waits for A. Deleted one by one, only A's snapshot holds the link; restoring A first must keep it.
  const { task: la } = await api('POST', '/api/tasks', { title: '먼저 지운 작업' });
  const { task: lb } = await api('POST', '/api/tasks', { title: '나중에 지운 작업', blockedBy: [la.id] });
  await api('DELETE', `/api/tasks/${la.id}`);
  await api('DELETE', `/api/tasks/${lb.id}`);
  const firstBack = await api('POST', '/api/trash/restore', { ids: [la.id] });
  check(firstBack.tasks.length === 1 && firstBack.dependencies.length === 0, 'restoring the first-deleted task alone: its partner is still in the trash');
  const waiting = (await api('GET', '/api/trash')).items.find((i: any) => i.task.id === lb.id);
  check(waiting?.dependencies.some((d: any) => d.taskId === lb.id && d.dependsOnId === la.id), 'the link moves to the partner still in the trash');
  const secondBack = await api('POST', '/api/trash/restore', { ids: [lb.id] });
  check(secondBack.dependencies.some((d: any) => d.taskId === lb.id && d.dependsOnId === la.id), 'restoring the partner later re-makes the link');
  b = await api('GET', '/api/bootstrap');
  check(b.dependencies.some((d: any) => d.taskId === lb.id && d.dependsOnId === la.id), 'and bootstrap has it');
}

console.log('undo keeps when a task was finished');
{
  const { task: u } = await api('POST', '/api/tasks', { title: '완료 시각 시험' });
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const first = (await api('PATCH', `/api/tasks/${u.id}`, { status: 'done' })).task.completedAt;
  check(Math.abs(Date.parse(first) - Date.now()) < 60_000, 'completing stamps now');
  await api('PATCH', `/api/tasks/${u.id}`, { status: 'todo' });
  const undone = (await api('PATCH', `/api/tasks/${u.id}`, { status: 'done', completedAt: past })).task;
  check(undone.status === 'done' && undone.completedAt === past, 'an undo-style PATCH puts the old completedAt back');
  const reopened = (await api('PATCH', `/api/tasks/${u.id}`, { status: 'todo', completedAt: past })).task;
  check(reopened.status === 'todo' && reopened.completedAt === null, 'completedAt is ignored when the task is not done');
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const clamped = (await api('PATCH', `/api/tasks/${u.id}`, { status: 'done', completedAt: future })).task;
  check(Date.parse(clamped.completedAt) <= Date.now() + 1000, 'a future completedAt counts as now');
  await api('PATCH', `/api/tasks/${u.id}`, { status: 'todo' });
  const moved = (await api('POST', '/api/tasks/reorder', { changes: [{ taskId: u.id, position: 7, status: 'done', completedAt: past }] })).tasks[0];
  check(moved.status === 'done' && moved.completedAt === past, 'a board move back to done takes completedAt too');
}

console.log('trash takes more than 500 tasks at once');
{
  const many: string[] = [];
  for (let i = 0; i < 6; i++) {
    const { tasks } = await api('POST', '/api/tasks/bulk', {
      tasks: Array.from({ length: 100 }, (_, j) => ({ title: `대량 ${i * 100 + j + 1}` })),
    });
    many.push(...tasks.map((t: any) => t.id));
  }
  const del = await api('POST', '/api/tasks/delete', { ids: many });
  check(del.deleted.length === 600, 'one delete call moves 600 tasks to the trash');
  const listed = (await api('GET', '/api/trash')).items.filter((i: any) => many.includes(i.task.id));
  check(listed.length === 600, 'all 600 are in the trash');
  const res = await api('POST', '/api/trash/restore', { ids: many });
  check(res.tasks.length === 600 && res.missing.length === 0, 'one restore call brings all 600 back');
  await api('POST', '/api/tasks/delete', { ids: many });
  check((await api('POST', '/api/trash/purge', { ids: many })).purged === 600, 'one purge call deletes all 600 for good');
  check((await status('POST', '/api/tasks/delete', { ids: Array.from({ length: 5001 }, () => crypto.randomUUID()) })) === 400, 'more than 5000 ids is refused');
}

const zipRes = await fetch(`${BASE}/api/skill.zip`);
check(zipRes.ok && (await zipRes.arrayBuffer()).byteLength > 200, 'skill.zip downloads');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
