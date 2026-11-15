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

const zipRes = await fetch(`${BASE}/api/skill.zip`);
check(zipRes.ok && (await zipRes.arrayBuffer()).byteLength > 200, 'skill.zip downloads');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
