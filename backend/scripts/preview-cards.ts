/**
 * Local MCP Apps host for developing the Obelisk cards (backend/src/ai/widget).
 *
 *   bun scripts/preview-cards.ts [baseUrl]        → http://localhost:4789
 *
 * Connects to the real MCP endpoint like Claude/ChatGPT do, renders each tool
 * result in a sandboxed iframe and speaks the MCP Apps bridge (ui/initialize,
 * tool-input/-result, tools/call, size-changed, open-link, update-model-context).
 * Uses OBELISK_TOKEN when set, otherwise signs in to the demo account
 * (bun scripts/seed-demo.ts) and mints a token.
 *
 * Calls run against real data: "complete" and "apply postponement" in a card change it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const PORT = Number(process.env.PORT ?? 4789);

async function mintToken(): Promise<string> {
  let cookie = '';
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-obelisk-client': 'web', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const json: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  await api('POST', '/api/auth/login', { email: 'demo@obelisk.test', password: 'obelisk-demo-1234' });
  return (await api('POST', '/api/tokens', { name: 'card preview' })).token;
}

const token = process.env.OBELISK_TOKEN ?? (await mintToken());

async function connect() {
  const client = new Client(
    { name: 'obelisk-card-preview', version: '1.0.0' },
    { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } as never },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

let client = await connect();

const PAGE = /* html */ `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Obelisk cards</title>
<style>
  :root { --bg:#faf9f5; --fg:#141413; --muted:#73726c; --line:rgba(0,0,0,.08); --card:#fff; color-scheme: light; }
  [data-theme=dark] { --bg:#262624; --fg:#faf9f5; --muted:#a6a39b; --line:rgba(255,255,255,.1); --card:#30302e; color-scheme: dark; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.5 -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif; }
  header { position:sticky; top:0; z-index:1; display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px 16px; background:var(--bg); border-bottom:1px solid var(--line); }
  header b { margin-right:8px; }
  select, button { font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:7px; padding:4px 8px; }
  main { padding:16px; display:flex; flex-direction:column; gap:22px; align-items:center; }
  .turn { width:100%; max-width:var(--w, 720px); }
  .label { font-size:12px; color:var(--muted); margin:0 0 6px 2px; font-family:ui-monospace, Menlo, monospace; }
  .frame { border:1px solid var(--line); border-radius:12px; background:var(--card); overflow:hidden; }
  iframe { display:block; width:100%; border:0; height:120px; background:transparent; }
  .log { font:11px/1.4 ui-monospace, Menlo, monospace; color:var(--muted); white-space:pre-wrap; margin:6px 2px 0; }
</style></head>
<body>
<header>
  <b>Obelisk cards</b>
  <label>테마 <select id="theme"><option value="light">light</option><option value="dark">dark</option></select></label>
  <label>폭 <select id="width"><option value="720">720</option><option value="560">560</option><option value="420">420</option><option value="360">360</option></select></label>
  <label>시나리오 <select id="only"><option value="">전부</option></select></label>
  <button id="reload">다시 불러오기</button>
</header>
<main id="main"></main>
<script>
const SCENARIOS = [
  ['get_overview', {}],
  ['list_tasks', { view: 'upcoming' }],
  ['get_task', { ref: '#3' }],
  ['simulate_delay', { ref: '#3', days: 3 }],
  ['get_forecast', {}],
  ['get_bottlenecks', {}],
  ['list_projects', {}],
  ['complete_task', { ref: '#10', undo: true }],
];
const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
$('theme').value = qs.get('theme') || 'light';
$('width').value = qs.get('w') || '720';
for (const [n, a] of SCENARIOS) $('only').append(new Option(n + ' ' + JSON.stringify(a), n));
$('only').value = qs.get('only') || '';
const apply = () => {
  const p = new URLSearchParams({ theme: $('theme').value, w: $('width').value, only: $('only').value });
  location.search = p.toString();
};
for (const id of ['theme', 'width', 'only']) $(id).onchange = apply;
$('reload').onclick = () => location.reload();
document.documentElement.dataset.theme = $('theme').value;
document.documentElement.style.setProperty('--w', $('width').value + 'px');

const rpc = (method, params) => fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) }).then((r) => r.json());

async function mount(name, args) {
  const turn = document.createElement('section');
  turn.className = 'turn';
  turn.innerHTML = '<p class="label"></p><div class="frame"><iframe sandbox="allow-scripts"></iframe></div><p class="log"></p>';
  turn.querySelector('.label').textContent = name + ' ' + JSON.stringify(args);
  $('main').append(turn);
  const frame = turn.querySelector('iframe');
  const log = (s) => (turn.querySelector('.log').textContent += s + '\\n');
  const tools = await rpc('tools/list');
  const tool = tools.tools.find((t) => t.name === name);
  const uri = tool?._meta?.ui?.resourceUri;
  if (!uri) return log('no UI for ' + name);
  const res = await rpc('resources/read', { uri });
  const result = await rpc('tools/call', { name, arguments: args });
  const send = (msg) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  window.addEventListener('message', async (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.method === 'ui/initialize') {
      send({ id: m.id, result: {
        protocolVersion: '2026-01-26',
        hostInfo: { name: 'card-preview', version: '1' },
        hostCapabilities: { openLinks: {}, serverTools: {}, updateModelContext: { text: {} }, message: { text: {} } },
        hostContext: { theme: $('theme').value, displayMode: 'inline', platform: 'web', locale: 'ko-KR', toolInfo: { tool } },
      } });
    } else if (m.method === 'ui/notifications/initialized') {
      send({ method: 'ui/notifications/tool-input', params: { arguments: args } });
      send({ method: 'ui/notifications/tool-result', params: result });
    } else if (m.method === 'ui/notifications/size-changed') {
      if (m.params?.height) frame.style.height = m.params.height + 'px';
    } else if (m.method === 'tools/call') {
      log('→ tools/call ' + m.params.name + ' ' + JSON.stringify(m.params.arguments));
      send({ id: m.id, result: await rpc('tools/call', m.params) });
    } else if (m.method === 'ui/open-link') {
      log('→ open-link ' + m.params.url);
      send({ id: m.id, result: {} });
    } else if (m.method === 'ui/update-model-context') {
      log('→ model context: ' + (m.params.content?.[0]?.text ?? ''));
      send({ id: m.id, result: {} });
    } else if (m.id !== undefined) {
      send({ id: m.id, error: { code: -32601, message: 'not supported here' } });
    }
  });
  frame.srcdoc = res.contents[0].text;
}

(async () => {
  for (const [n, a] of SCENARIOS) if (!$('only').value || $('only').value === n) await mount(n, a);
})();
</script>
</body></html>`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/rpc' && req.method === 'POST') {
      const { method, params } = (await req.json()) as { method: string; params?: any };
      const run = async () => {
        if (method === 'tools/list') return client.listTools();
        if (method === 'resources/read') return client.readResource(params);
        if (method === 'tools/call') return client.callTool(params);
        throw new Error(`unsupported ${method}`);
      };
      try {
        return Response.json(await run());
      } catch {
        client = await connect(); // backend restarted (bun --watch) — reconnect once
        return Response.json(await run().catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] })));
      }
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`Obelisk cards → http://localhost:${PORT}  (MCP: ${BASE}/mcp)`);
