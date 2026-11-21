/**
 * End-to-end check of 데이터 이전 between two running Obelisk servers.
 *   bun scripts/migration-smoke.ts <source A> <target B>
 * e.g. bun scripts/migration-smoke.ts http://localhost:4210 http://localhost:4220
 * Both need SIGNUP_MODE=open, their own databases and different SECRET_KEYs. Run A as a development
 * server (it "sends" mail to its log) and B with NODE_ENV=production and no SMTP_URL (so it can't send
 * mail), plus MIGRATION_ALLOW_PRIVATE / WEBHOOK_ALLOW_PRIVATE / JEV_ALLOW_PRIVATE=true on B, because
 * everything here talks over http://127.0.0.1. The script also runs a fake webhook receiver and a fake
 * Jev service on 127.0.0.1:4297/4298.
 *
 * Covers: org export to a file with a passphrase and import (numbers, grants, teams, history,
 * photos); nobody but the importer joins by email — an existing same-email account waits in 가입 대기
 * and joins only by its claim link (claims applied, also for someone already a member); no approve
 * route; mail-all (400 without mail, sent on a server with mail); former members kept for the record;
 * webhooks imported off with their signing secret; incoming webhooks working only at their new URL;
 * API tokens not moved; a chained move B → A that keeps pending places; personal space by 이전 링크
 * (secrets, settings, renumbering); single-use links, duplicate and concurrent imports.
 */
import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const A = (process.argv[2] ?? 'http://localhost:4210').replace(/\/$/, '');
const B = (process.argv[3] ?? 'http://localhost:4220').replace(/\/$/, '');
let failures = 0;

function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(`${status} ${JSON.stringify(body)}`);
  }
}

/** One browser on one server: its own cookie jar and open workspace. */
class Browser {
  cookie = '';
  workspace?: string;
  constructor(
    readonly base: string,
    readonly label: string,
  ) {}

  async fetch(method: string, path: string, init: { body?: BodyInit; type?: string; headers?: Record<string, string> } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(init.type ? { 'content-type': init.type } : {}),
        ...(this.cookie ? { cookie: this.cookie, 'x-obelisk-client': 'web' } : {}),
        ...(this.workspace ? { 'x-obelisk-workspace': this.workspace } : {}),
        ...init.headers,
      },
      body: init.body,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    return res;
  }

  async api(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const res = await this.fetch(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      type: body === undefined ? undefined : 'application/json',
      headers,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!res.ok) throw new HttpError(res.status, json ?? text);
    return json;
  }

  /** The HTTP error a call fails with (status 200 when it works). */
  async fails(method: string, path: string, body?: unknown): Promise<{ status: number; message: string }> {
    try {
      await this.api(method, path, body);
      return { status: 200, message: '' };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, message: String(e.body?.message ?? e.body ?? '') };
      throw e;
    }
  }

  async upload(path: string, body: BodyInit, type = 'application/x-obelisk-export') {
    const res = await this.fetch('POST', path, { body, type });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) throw new HttpError(res.status, json);
    return json;
  }
}

const stamp = Date.now();
const mail = (who: string) => `${who}-${stamp}@example.com`;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** Active tasks plus recently finished ones, as the web app loads them. */
const allTasks = async (b: Browser): Promise<any[]> => (await b.api('GET', '/api/bootstrap')).tasks;
const signup = async (b: Browser, who: string, name: string, extra: Record<string, unknown> = {}) =>
  b.api('POST', '/api/auth/signup', { email: mail(who), password: 'correct-horse', name, ...extra });
// A 2×2 PNG (the server checks real image bytes).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNk+M/AwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

// ───────────────────────────── fake receivers

const received: { headers: Headers; body: string }[] = [];
const hookServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 4297,
  async fetch(req) {
    received.push({ headers: req.headers, body: await req.text() });
    return new Response('ok');
  },
});
const jevCalls: string[] = [];
const jevServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 4298,
  async fetch(req) {
    jevCalls.push(req.headers.get('authorization') ?? '');
    return Response.json({ answers: {}, model: 'jev-test' });
  },
});

console.log(`Obelisk migration smoke test: ${A} → ${B}`);

try {
  // ───────────────────────────── source server: an organization with everything in it

  console.log('source organization');
  const ann = new Browser(A, 'ann');
  const bob = new Browser(A, 'bob');
  const cat = new Browser(A, 'cat');
  const dan = new Browser(A, 'dan');
  const eve = new Browser(A, 'eve');
  const fay = new Browser(A, 'fay');
  const annA = (await signup(ann, 'ann', 'Ann')).user;
  const { workspace: org } = await ann.api('POST', '/api/workspaces', { name: `에이크미 ${stamp}` });
  ann.workspace = org.id;
  const inv = await ann.api('POST', `/api/workspaces/${org.id}/invites`, { role: 'member', expiresInDays: 7, maxUses: 5 });
  const invite = inv.url.split('/invite/')[1];
  const bobA = (await signup(bob, 'bob', 'Bob', { inviteToken: invite })).user;
  const catA = (await signup(cat, 'cat', 'Cat', { inviteToken: invite })).user;
  const danA = (await signup(dan, 'dan', 'Dan', { inviteToken: invite })).user;
  const eveA = (await signup(eve, 'eve', 'Eve', { inviteToken: invite })).user;
  const fayA = (await signup(fay, 'fay', 'Fay', { inviteToken: invite })).user;
  for (const b of [bob, cat, dan, eve, fay]) b.workspace = org.id;
  await ann.api('PATCH', `/api/workspaces/${org.id}/members/${danA.id}`, { role: 'admin' });
  const photoRes = await ann.fetch('PUT', `/api/workspaces/${org.id}/avatar`, { body: PNG, type: 'image/png' });
  check(photoRes.ok, 'org photo uploaded on A');

  const { team } = await ann.api('POST', `/api/workspaces/${org.id}/teams`, { name: '디자인', memberIds: [bobA.id, danA.id, catA.id] });
  const { project: p1 } = await ann.api('POST', '/api/projects', { name: '로드맵' });
  const { project: p2 } = await ann.api('POST', '/api/projects', { name: '공지', memberAccess: 'view' });
  const { project: p3 } = await ann.api('POST', '/api/projects', { name: '지난 일' });
  await ann.api('PATCH', `/api/projects/${p3.id}`, { archived: true });
  await ann.api('PUT', `/api/projects/${p1.id}/access`, {
    members: [
      { userId: danA.id, level: 'edit' },
      { userId: catA.id, level: 'manage' },
    ],
    teams: [{ teamId: team.id, level: 'view' }],
  });

  const { task: t1 } = await ann.api('POST', '/api/tasks', { title: '스펙', projectId: p1.id, startDate: day(1), dueDate: day(2), assigneeIds: [danA.id] });
  const { task: t2 } = await ann.api('POST', '/api/tasks', { title: '구현', projectId: p1.id, startDate: day(3), dueDate: day(4), dueTime: '18:00', blockedBy: [t1.id] });
  await dan.api('POST', '/api/tasks', { title: '댄의 비공개 메모', projectId: null });
  const { task: t4 } = await ann.api('POST', '/api/tasks', { title: '킥오프', projectId: p2.id, dueDate: day(-1), assigneeIds: [eveA.id, danA.id] });
  await ann.api('PATCH', `/api/tasks/${t4.id}`, { status: 'done' });
  await cat.api('POST', '/api/tasks', { title: '캣의 메모', projectId: null });
  await fay.api('POST', '/api/tasks', { title: '페이의 메모', projectId: null });
  await ann.api('POST', '/api/impact/postpone', { taskId: t1.id, days: 1, cascade: true });
  await ann.api('PATCH', `/api/tasks/${t2.id}`, { assigneeIds: [bobA.id] });
  // Fay leaves; her task and history still name her (a former member).
  await ann.api('DELETE', `/api/workspaces/${org.id}/members/${fayA.id}`);
  const numbersA = new Map<string, number>((await allTasks(ann)).map((t: any) => [t.title, t.number]));

  const { webhook: hookA, secret: hookSecret } = await ann.api('POST', '/api/webhooks', {
    name: '알림 수신기',
    url: `http://127.0.0.1:${hookServer.port}/hook`,
    events: ['task.created', 'project'],
  });
  const { webhook: danHook } = await dan.api('POST', '/api/webhooks', {
    name: '댄의 훅',
    url: `http://127.0.0.1:${hookServer.port}/dan`,
    events: ['task.created'],
    projectIds: [p1.id],
  });
  const incoming = await ann.api('POST', '/api/incoming-webhooks', { name: '폼 연동', projectId: p2.id });
  const incomingToken = incoming.url.split('/api/hooks/')[1];
  check(!!hookA && !!danHook && incomingToken?.startsWith('obh_'), 'webhooks set up on A');

  // ───────────────────────────── permissions on the source

  console.log('who may export');
  check((await bob.fails('POST', '/api/migration/export', { workspaceId: org.id })).status === 403, 'a member cannot export the org');
  check((await dan.fails('POST', '/api/migration/export', { workspaceId: org.id })).message.includes('소유자만'), 'an admin cannot either (owner only)');
  check((await dan.fails('POST', '/api/migration/codes', { workspaceId: org.id })).status === 403, 'nor make an 이전 링크');
  const tokenOnly = (await ann.api('POST', '/api/tokens', { name: '스크립트' })).token as string;
  const viaToken = await fetch(`${A}/api/migration/export`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenOnly}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: org.id }),
  });
  check(viaToken.status === 403, 'API tokens cannot export (web session only)');
  check((await new Browser(A, 'x').fails('POST', '/api/migration/pull')).status === 401, 'pull without a code is 401');
  check((await ann.fails('POST', '/api/migration/export', { workspaceId: org.id, passphrase: 'short' })).status === 400, 'a passphrase under 8 characters is refused');

  // ───────────────────────────── export to a file, with a passphrase

  console.log('org: file with passphrase');
  const exportRes = await ann.fetch('POST', '/api/migration/export', {
    body: JSON.stringify({ workspaceId: org.id, passphrase: '옮길 때 쓰는 암호' }),
    type: 'application/json',
  });
  const fileText = await exportRes.text();
  const file = JSON.parse(fileText);
  const disposition = exportRes.headers.get('content-disposition') ?? '';
  check(exportRes.ok && exportRes.headers.get('content-type')?.startsWith('application/json'), 'export answers JSON');
  check(/attachment; filename="obelisk-[a-z0-9-]+-\d{8}\.json"; filename\*=UTF-8''/.test(disposition), `file name header (${disposition.slice(0, 60)}…)`);
  check(file.format === 'obelisk-export' && file.version === 2 && file.kind === 'org', 'bundle header');
  check(file.tasks.find((t: any) => t.title === '킥오프')?.assignees?.length === 2, 'a task keeps all its assignees in the file');
  check(file.secrets?.mode === 'locked' && !fileText.includes(hookSecret), 'secrets are locked, the webhook secret is not in clear');
  check(file.tasks.length === 6 && file.projects.length === 3 && file.people.length === 5 && file.dependencies.length === 1, 'bundle has every task, project, person and link');
  check(file.formerPeople?.length === 1 && file.formerPeople[0].email === mail('fay'), 'a member who left but authored rows comes along as former');
  check(file.incomingWebhooks.every((h: any) => !('tokenHash' in h)) && !fileText.includes(incomingToken.slice(-8)), 'no incoming webhook secret or hash in the file');
  check(file.workspace.photo?.contentType === 'image/png', 'bundle carries the org photo');
  const logA = (await ann.api('GET', `/api/workspaces/${org.id}/activity`)).activity;
  check(logA.some((e: any) => e.action === 'workspace.exported' && e.data.to === 'file' && e.data.secrets === true), 'A logs the file export');

  // ───────────────────────────── target server

  console.log('target accounts');
  const annB = new Browser(B, 'annB');
  const catB = new Browser(B, 'catB');
  const annOnB = (await annB.api('POST', '/api/auth/signup', { email: `ann-new-${stamp}@example.com`, password: 'correct-horse', name: 'Ann B' })).user;
  const catOnB = (await signup(catB, 'cat', 'Cat (B)')).user;

  console.log('stage + preview');
  check((await annB.fails('POST', '/api/migration/stage-remote', { link: `${B}/settings/migrate#omg_${'x'.repeat(32)}` })).message.includes('같은 서버'), 'a link to the same server is refused');
  check((await annB.fails('POST', '/api/migration/stage-remote', { link: `omg_${'x'.repeat(32)}` })).status === 400, 'a bare code is refused');
  const bad = await annB.upload('/api/migration/stage', JSON.stringify({ hello: 'world' })).catch((e) => e);
  check(bad instanceof HttpError && bad.status === 400 && bad.body.message.includes('내보내기 파일이 아니에요'), 'a random JSON file is refused');
  const newer = await annB.upload('/api/migration/stage', JSON.stringify({ ...file, version: 3 })).catch((e) => e);
  check(newer instanceof HttpError && newer.body.message.includes('더 새 버전'), 'a newer format version is refused');
  const twice = await annB.upload('/api/migration/stage', JSON.stringify({ ...file, tasks: [...file.tasks, file.tasks[0]] })).catch((e) => e);
  check(twice instanceof HttpError && twice.status === 400 && twice.body.message.includes('두 번'), 'a file repeating a task is refused in words');
  // A crafted file can't make an incoming webhook answer to a token its author knows.
  const crafted = { ...file, exportId: crypto.randomUUID(), incomingWebhooks: [{ ...file.incomingWebhooks[0], tokenHash: 'a'.repeat(64), hint: 'aaaa' }] };
  const craftedPreview = await annB.upload('/api/migration/stage', JSON.stringify(crafted));
  check(craftedPreview.counts.incomingWebhooks === 1, 'an older file with a hash still stages');
  await annB.api('DELETE', `/api/migration/stage/${craftedPreview.stagingId}`);

  const preview = await annB.upload('/api/migration/stage', gzipSync(Buffer.from(fileText)), 'application/gzip');
  check(preview.kind === 'org' && preview.target.kind === 'new-org' && preview.secrets === 'locked', 'gzip upload stages and previews');
  check(preview.counts.tasks === 6 && preview.counts.members === 5 && preview.counts.webhooks === 2 && preview.counts.photos === 1, 'preview counts');
  const who = Object.fromEntries(preview.people.map((p: any) => [p.name, `${p.match}${p.former ? ':former' : ''}`]));
  check(
    who.Ann === 'you' && who.Cat === 'existing' && who.Bob === 'reserved' && who.Dan === 'reserved' && who.Eve === 'reserved' && who.Fay === 'reserved:former',
    `people: you / existing / reserved / former (${JSON.stringify(who)})`,
  );
  check(preview.people.every((p: any) => !('accountName' in p)), 'the preview names no account of this server');
  check(preview.alreadyImported === null, 'not imported before');
  check(preview.warnings.some((w: string) => w.includes('꺼진 채로')), 'preview warns webhooks arrive switched off');
  check(!preview.warnings.some((w: string) => w.includes('그대로 작동')), 'no "old URLs keep working" warning');

  const wrong = await annB.fails('POST', '/api/migration/import', { stagingId: preview.stagingId, passphrase: '틀린 암호입니다' });
  check(wrong.status === 400 && wrong.message === '암호가 맞지 않아요', 'wrong passphrase: 400 before anything is written');
  check((await annB.api('GET', '/api/workspaces')).workspaces.length === 1, 'nothing was created');
  check((await catB.fails('POST', '/api/migration/import', { stagingId: preview.stagingId, passphrase: '옮길 때 쓰는 암호' })).status === 404, "someone else can't import my staged file");
  check((await annB.api('GET', `/api/migration/stage/${preview.stagingId}`)).status === 'waiting', 'staged file waits');

  console.log('import');
  const result = await annB.api('POST', '/api/migration/import', { stagingId: preview.stagingId, passphrase: '옮길 때 쓰는 암호', linkExisting: true });
  check(result.kind === 'org' && result.reserved === 4 && !result.renumbered && !('linked' in result), `result: reserved ${result.reserved}, nobody linked`);
  check(result.counts.tasks === 6 && result.counts.dependencies === 1 && result.counts.projects === 3 && result.counts.teams === 1 && result.counts.members === 5, 'result counts');
  check(result.mailEnabled === false, 'this server has no mail (mailEnabled false)');
  check(result.incoming.length === 1 && result.incoming[0].name === '폼 연동' && result.incoming[0].url.startsWith(`${B}/api/hooks/obh_`), 'incoming webhook gets a new URL, shown once');
  check(Array.isArray(result.tokensNotMoved) && result.tokensNotMoved.length === 0, 'an org has no tokens to leave behind');
  const status = await annB.api('GET', `/api/migration/stage/${preview.stagingId}`);
  check(status.status === 'done' && status.result.workspaceId === result.workspaceId, 'the staged file knows it was imported (lost answers can be recovered)');
  const retry = await annB.api('POST', '/api/migration/import', { stagingId: preview.stagingId, passphrase: '옮길 때 쓰는 암호' });
  check(retry.workspaceId === result.workspaceId, 'retrying the same import answers the same, nothing twice');
  const orgB = result.workspaceId as string;
  annB.workspace = orgB;
  catB.workspace = orgB;

  const detail = await annB.api('GET', `/api/workspaces/${orgB}`);
  check(detail.workspace.role === 'owner' && detail.workspace.name === org.name && !!detail.workspace.avatarUrl, 'importer owns the new org, photo came along');
  check(detail.members.length === 1 && !detail.members.some((m: any) => m.id === catOnB.id), 'Cat (same email) is NOT a member after the import');
  check((await catB.api('GET', '/api/workspaces')).workspaces.every((w: any) => w.id !== orgB), "the org isn't in Cat's list");
  const bootB = await annB.api('GET', '/api/bootstrap');
  const tasksB = (await allTasks(annB)) as any[];
  // Private inbox tasks stay out of sight until their authors join (no admin bypass for private tasks).
  check(tasksB.length === 3 && tasksB.every((t) => t.number === numbersA.get(t.title)), 'task numbers are kept');
  const t1B = tasksB.find((t) => t.title === '스펙');
  const t2B = tasksB.find((t) => t.title === '구현');
  const t4B = tasksB.find((t) => t.title === '킥오프');
  check(t1B.postponedCount === 1 && t1B.assigneeIds.length === 0 && t4B.assigneeIds.length === 0, 'postponed count kept; reserved assignees left empty');
  check(t4B.status === 'done' && !!t4B.completedAt && t2B.dueTime === '18:00', 'status, completion and times kept');
  check(bootB.dependencies?.some((d: any) => d.taskId === t2B.id && d.dependsOnId === t1B.id), 'dependency kept');
  const projectsB = (await annB.api('GET', '/api/projects?archived=true')).projects as any[];
  const p1B = projectsB.find((p) => p.name === '로드맵');
  const p2B = projectsB.find((p) => p.name === '공지');
  check(!!projectsB.find((p) => p.name === '지난 일')?.archivedAt && p2B.memberAccess === 'view', 'archived and memberAccess kept');
  const accessB = (await annB.api('GET', `/api/projects/${p1B.id}/access`)).access;
  check(accessB.teams.length === 1 && accessB.members.every((m: any) => m.userId === annOnB.id), 'team grant kept (and mine); the reserved people\'s grants wait');

  const logB = (await annB.api('GET', `/api/workspaces/${orgB}/activity?limit=200`)).activity as any[];
  check(logB[0].action === 'workspace.imported' && logB[0].via === 'system', 'B logs the import');
  const oldCreate = logB.find((e) => e.action === 'task.created' && e.subject.includes('스펙'));
  check(!!oldCreate && oldCreate.taskId === t1B.id && oldCreate.actor.id === annOnB.id && oldCreate.createdAt < logB[0].createdAt, 'history kept with new ids and old times');
  const depLog = logB.find((e) => e.action === 'dependency.added' || (e.action === 'task.created' && e.data.blockedBy));
  check(!depLog || !JSON.stringify(depLog.data).includes(t1.id), 'history ids are remapped');

  console.log('webhooks on B');
  const hooksB = await annB.api('GET', '/api/webhooks');
  const hookB = hooksB.webhooks.find((h: any) => h.name === '알림 수신기');
  const danHookB = hooksB.webhooks.find((h: any) => h.name === '댄의 훅');
  check(hookB && !hookB.enabled && hookB.disabledReason?.includes('가져왔어요'), 'outgoing webhook arrives switched off');
  check(danHookB && danHookB.projectIds?.[0] === p1B.id && danHookB.createdBy === null, 'project filter remapped; reserved creator left empty');
  received.length = 0;
  await annB.api('POST', `/api/webhooks/${hookB.id}/test`);
  const ping = received[0];
  const ts = ping?.headers.get('x-obelisk-timestamp');
  const expected = ping ? `sha256=${createHmac('sha256', hookSecret).update(`${ts}.${ping.body}`).digest('hex')}` : '';
  check(!!ping && ping.headers.get('x-obelisk-signature') === expected, 'test delivery is signed with the original secret');
  check(hooksB.incoming.some((h: any) => h.name === '폼 연동' && h.projectId === p2B.id), 'incoming webhook imported with its project');
  const oldHook = await fetch(`${B}/api/hooks/${incomingToken}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '옛 주소' });
  check(oldHook.status === 404 || oldHook.status === 401, `the old incoming webhook URL does not work on B (${oldHook.status})`);
  const hookRes = await fetch(result.incoming[0].url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '새 서버에서 받은 작업' });
  const hookJson: any = await hookRes.json();
  check(hookRes.ok && hookJson.task?.title === '새 서버에서 받은 작업', 'the new incoming webhook URL works on B');
  const afterHook = (await allTasks(annB)) as any[];
  const topA = Math.max(...file.tasks.map((t: any) => t.number));
  check(afterHook.some((t) => t.title === '새 서버에서 받은 작업' && t.number === topA + 1), 'new tasks continue after the imported numbers');

  // ───────────────────────────── 가입 대기

  console.log('reservations');
  let res = await annB.api('GET', `/api/workspaces/${orgB}/reservations`);
  const byName = (n: string) => res.reservations.find((r: any) => r.name === n);
  check(res.reservations.length === 5 && res.reservations.every((r: any) => !r.hasLink && !('accountName' in r)), 'five places wait (four members, one former)');
  check(byName('Cat').status === 'signed_up' && byName('Bob').status === 'waiting', 'the same-email account is noted, nothing more');
  check(byName('Fay').former === true && byName('Fay').role === 'member' && byName('Dan').former === false, 'former member kept for the record');
  check(res.mailEnabled === false, 'mailEnabled flag');
  check([403, 404].includes((await catB.fails('GET', `/api/workspaces/${orgB}/reservations`)).status), 'non-members cannot see the reservations');
  const danR = byName('Dan');
  const eveR = byName('Eve');
  const bobR = byName('Bob');
  const catR = byName('Cat');
  check(danR.role === 'admin' && danR.email === mail('dan'), 'reservation keeps role and email');
  check((await annB.fails('POST', `/api/workspaces/${orgB}/reservations/${catR.id}/approve`)).status === 404, 'there is no approve route');
  const mailAll = await annB.fails('POST', `/api/workspaces/${orgB}/reservations/mail-all`);
  check(mailAll.status === 400 && mailAll.message.includes('메일'), `mail-all without mail is 400 (${mailAll.status})`);
  check((await annB.fails('POST', `/api/workspaces/${orgB}/reservations/${bobR.id}/mail`)).status === 400, 'so is mailing one');

  // ── a chained move B → A while the places are still open: they come along with what they claim
  console.log('chained move B → A');
  const { link: backLink } = await annB.api('POST', '/api/migration/codes', { workspaceId: orgB });
  ann.workspace = undefined;
  const chainPreview = await ann.api('POST', '/api/migration/stage-remote', { link: backLink });
  const chainWho = Object.fromEntries(chainPreview.people.map((p: any) => [p.name, `${p.match}${p.former ? ':former' : ''}`]));
  check(
    chainPreview.people.length === 6 && chainWho['Ann B'] === 'you' && chainWho.Dan === 'existing' && chainWho.Fay === 'existing:former',
    `pending places travel on (${JSON.stringify(chainWho)})`,
  );
  const chain = await ann.api('POST', '/api/migration/import', { stagingId: chainPreview.stagingId });
  check(chain.reserved === 4 && chain.mailEnabled === true, 'four places wait on A, which can mail');
  const sent = await ann.api('POST', `/api/workspaces/${chain.workspaceId}/reservations/mail-all`);
  check(sent.sent === 4, `mail-all sends a link to every member place, not the former one (${sent.sent})`);
  check((await ann.api('GET', `/api/workspaces/${chain.workspaceId}`)).members.length === 1, 'nobody on A joined by email either');
  const chainRes = (await ann.api('GET', `/api/workspaces/${chain.workspaceId}/reservations`)).reservations as any[];
  const danChain = chainRes.find((r) => r.name === 'Dan');
  check(chainRes.every((r) => r.hasLink !== (r.name === 'Fay')) && danChain.status === 'signed_up', 'mailed places have links; Dan is noted as having an account');
  const danChainLink = (await ann.api('POST', `/api/workspaces/${chain.workspaceId}/reservations/${danChain.id}/link`)).link as string;
  dan.workspace = undefined;
  const danJoin = await dan.api('POST', `/api/invites/${danChainLink.split('/invite/')[1]}/accept`);
  check(danJoin.workspaceId === chain.workspaceId, 'Dan (signed in on A) takes his place with the link');
  dan.workspace = chain.workspaceId;
  const danChainTasks = (await allTasks(dan)) as any[];
  check(
    danChainTasks.find((t) => t.title === '스펙')?.assigneeIds.includes(danA.id) && danChainTasks.find((t) => t.title === '댄의 비공개 메모')?.createdBy === danA.id,
    'what he would have claimed on B came along and is his',
  );
  await ann.api('DELETE', `/api/workspaces/${chain.workspaceId}`, { confirm: org.name });
  dan.workspace = org.id;

  // ── back on B: everyone joins only by the link
  console.log('claim links on B');
  const first = (await annB.api('POST', `/api/workspaces/${orgB}/reservations/${danR.id}/link`)).link as string;
  const link = (await annB.api('POST', `/api/workspaces/${orgB}/reservations/${danR.id}/link`)).link as string;
  const claimToken = link.split('/invite/')[1]!;
  check(claimToken.startsWith('obr_') && link.startsWith(`${B}/invite/`), 'claim link minted');
  const anon = new Browser(B, 'anon');
  check((await anon.fails('GET', `/api/invites/${first.split('/invite/')[1]}`)).status === 404, 'rotating the link retires the old one');
  const claimPreview = (await anon.api('GET', `/api/invites/${claimToken}`)).invite;
  check(claimPreview.valid && claimPreview.role === 'admin' && claimPreview.reservation?.name === 'Dan' && claimPreview.reservation?.email === mail('dan'), 'claim link preview shows the reserved place');
  check((await anon.api('GET', `/api/auth/signup-status?invite=${claimToken}`)).allowed === true, 'claim link opens sign-up');

  const danB = new Browser(B, 'danB');
  const danSignup = await danB.api('POST', '/api/auth/signup', { email: `dan-elsewhere-${stamp}@example.com`, password: 'correct-horse', name: 'Dan B', inviteToken: claimToken });
  check(danSignup.joinedWorkspaceId === orgB, 'signing up with the claim link joins the org (any email)');
  danB.workspace = orgB;
  const danDetail = await danB.api('GET', `/api/workspaces/${orgB}`);
  check(danDetail.workspace.role === 'admin', 'joined with the reserved role');
  const danTasks = (await allTasks(danB)) as any[];
  check(danTasks.find((t) => t.title === '스펙')?.assigneeIds.includes(danSignup.user.id), 'assignment handed over');
  check(danTasks.find((t) => t.title === '댄의 비공개 메모')?.createdBy === danSignup.user.id, 'private inbox task handed over');
  const danHooks = await danB.api('GET', '/api/webhooks');
  check(danHooks.webhooks.find((h: any) => h.name === '댄의 훅')?.createdBy?.id === danSignup.user.id, 'webhook authorship handed over');
  const danLog = (await danB.api('GET', `/api/workspaces/${orgB}/activity?limit=200`)).activity as any[];
  check(danLog.some((e) => e.subject.includes('댄의 비공개 메모') && e.actor.id === danSignup.user.id), 'history actor handed over');
  check(danLog[0].action === 'member.joined' && danLog[0].data.reservation === true, 'member.joined logged with reservation: true');
  check((await anon.fails('GET', `/api/invites/${claimToken}`)).status === 404, 'claim link is single-use');

  console.log('the same-email account joins by its link');
  const catLink = (await annB.api('POST', `/api/workspaces/${orgB}/reservations/${catR.id}/link`)).link as string;
  const catToken = catLink.split('/invite/')[1]!;
  catB.workspace = undefined;
  const catPreview = (await catB.api('GET', `/api/invites/${catToken}`)).invite;
  check(catPreview.alreadyMember === false && catPreview.reservation?.name === 'Cat', 'Cat (signed in) sees the place');
  await catB.api('POST', `/api/invites/${catToken}/accept`);
  catB.workspace = orgB;
  const catDetail = await catB.api('GET', `/api/workspaces/${orgB}`);
  check(catDetail.workspace.role === 'member', 'Cat is a member now, with the reserved role');
  const catBoot = await catB.api('GET', '/api/bootstrap');
  check(catBoot.projects.some((p: any) => p.id === p1B.id && p.access === 'manage'), 'her project grant is applied');
  check(catBoot.projects.some((p: any) => p.id === p2B.id && p.access === 'view'), 'memberAccess applies too');
  const catTeams = (await annB.api('GET', `/api/workspaces/${orgB}/teams`)).teams as any[];
  check(catTeams.find((t) => t.name === '디자인')?.memberIds?.includes(catOnB.id), 'her team membership is applied');
  check(((await allTasks(catB)) as any[]).find((t) => t.title === '캣의 메모')?.createdBy === catOnB.id, 'her private task is hers');
  check((await catB.fails('GET', `/api/workspaces/${orgB}/reservations`)).status === 403, 'members cannot manage reservations');

  console.log('someone already a member claims a place');
  const eveB = new Browser(B, 'eveB');
  const eveSignup = await signup(eveB, 'eve', 'Eve B');
  check(eveSignup.joinedWorkspaceId === null && (await eveB.api('GET', '/api/workspaces')).workspaces.length === 1, 'same-email sign-up does not join by itself');
  res = await annB.api('GET', `/api/workspaces/${orgB}/reservations`);
  check(res.reservations.find((r: any) => r.id === eveR.id)?.status === 'signed_up', 'admins see that the account exists');
  const plainInvite = (await annB.api('POST', `/api/workspaces/${orgB}/invites`, { role: 'member', expiresInDays: 7, maxUses: 1 })).url.split('/invite/')[1];
  await eveB.api('POST', `/api/invites/${plainInvite}/accept`);
  const eveLink = (await annB.api('POST', `/api/workspaces/${orgB}/reservations/${eveR.id}/link`)).link as string;
  const eveToken = eveLink.split('/invite/')[1]!;
  const evePreview = (await eveB.api('GET', `/api/invites/${eveToken}`)).invite;
  check(evePreview.alreadyMember === true && !!evePreview.reservation, 'the link still offers the place to a member');
  await eveB.api('POST', `/api/invites/${eveToken}/accept`);
  eveB.workspace = orgB;
  check(((await allTasks(eveB)) as any[]).find((t) => t.title === '킥오프')?.assigneeIds.includes(eveSignup.user.id), "a member's claim hands over her assignment");
  const eveLog = (await annB.api('GET', `/api/workspaces/${orgB}/activity?limit=5`)).activity as any[];
  check(eveLog.some((e) => e.action === 'member.joined' && e.data.reservation && e.data.alreadyMember && e.data.role === 'member'), 'logged as taking over the place, with her actual role');

  await annB.api('DELETE', `/api/workspaces/${orgB}/reservations/${bobR.id}`);
  res = await annB.api('GET', `/api/workspaces/${orgB}/reservations`);
  check(res.reservations.length === 1 && res.reservations[0].name === 'Fay', 'cancelled and claimed places are gone; the former one stays');

  // ───────────────────────────── duplicate and concurrent imports

  console.log('duplicates');
  const again = await annB.upload('/api/migration/stage', fileText);
  check(again.alreadyImported?.workspaceName === org.name, 'preview knows the file was imported');
  const dup = await annB.fails('POST', '/api/migration/import', { stagingId: again.stagingId, passphrase: '옮길 때 쓰는 암호' });
  check(dup.status === 409 && dup.message === '이미 가져온 파일이에요', 'importing it again is 409');
  const both = await Promise.all(
    [0, 1].map(() => annB.api('POST', '/api/migration/import', { stagingId: again.stagingId, allowDuplicate: true }).catch((e) => e)),
  );
  const oks = both.filter((r) => !(r instanceof HttpError));
  const busy = both.filter((r) => r instanceof HttpError);
  check(
    oks.length >= 1 && new Set(oks.map((r: any) => r.workspaceId)).size === 1 && busy.every((e: any) => e.status === 409 && String(e.body?.message).includes('가져오는 중')),
    `two imports of one file at once make one organization (${oks.length} ok, ${busy.length} busy)`,
  );
  const second = oks[0] as any;
  check(second.workspaceId !== orgB && second.warnings.some((w: string) => w.includes('암호를 넣지 않아')), 'allowDuplicate imports again (no passphrase → without secrets)');
  check(second.incoming[0]?.url !== result.incoming[0].url, 'each import makes its own incoming webhook URL');
  check((await annB.fails('DELETE', `/api/migration/stage/${again.stagingId}`)).status === 200, 'discarding a used staging id is harmless');
  await annB.api('DELETE', `/api/workspaces/${second.workspaceId}`, { confirm: org.name });

  // ───────────────────────────── personal space by 이전 링크

  console.log('personal: 이전 링크');
  ann.workspace = undefined;
  await ann.api('PATCH', '/api/auth/me', {
    timezone: 'America/New_York',
    homeLayout: { v: 1, desktop: { items: [{ id: 'today', x: 0, y: 0, w: 6, h: 4 }], hidden: [] }, mobile: { order: ['today'], hidden: [] } },
  });
  const me = await ann.fetch('PUT', '/api/auth/me/avatar', { body: PNG, type: 'image/png' });
  check(me.ok, 'profile photo on A');
  await ann.api('PUT', '/api/jev/settings', { apiKey: 'sk-test-jev-key-0123456789', baseUrl: `http://127.0.0.1:${jevServer.port}/v1`, model: 'jev-test' });
  ann.workspace = (await ann.api('GET', '/api/workspaces')).workspaces.find((w: any) => w.kind === 'personal').id;
  const { project: pp } = await ann.api('POST', '/api/projects', { name: '개인 프로젝트' });
  const { task: pa } = await ann.api('POST', '/api/tasks', { title: '여권 갱신', projectId: pp.id, dueDate: day(5) });
  await ann.api('POST', '/api/tasks', { title: '사진 찍기', projectId: pp.id, dueDate: day(3), blockedBy: [] });
  await ann.api('POST', `/api/tasks/${pa.id}/dependencies`, { dependsOnId: (await allTasks(ann)).find((t: any) => t.title === '사진 찍기').id });
  const { secret: personalSecret } = await ann.api('POST', '/api/webhooks', { name: '개인 알림', url: `http://127.0.0.1:${hookServer.port}/me`, events: ['task.created'] });
  const apiToken = (await ann.api('POST', '/api/tokens', { name: '내 스크립트' })).token as string;

  annB.workspace = undefined;
  await annB.api('POST', '/api/tasks', { title: '새 서버의 첫 작업' });
  await annB.api('POST', '/api/projects', { name: '새 서버의 프로젝트' });
  const { link: staleLink } = await ann.api('POST', '/api/migration/codes', { workspaceId: ann.workspace });
  const { link: migrateLink, expiresAt } = await ann.api('POST', '/api/migration/codes', { workspaceId: ann.workspace });
  check(migrateLink.startsWith(`${A}/settings/migrate#omg_`) && new Date(expiresAt).getTime() > Date.now() + 25 * 60_000, '이전 링크 for 30 minutes');
  check((await annB.fails('POST', '/api/migration/stage-remote', { link: staleLink })).message === '이전 링크가 만료됐거나 이미 쓰였어요', 'a newer link retires the unused older one');
  const pPreview = await annB.api('POST', '/api/migration/stage-remote', { link: migrateLink });
  check(pPreview.kind === 'personal' && pPreview.secrets === 'included', 'pulled from A with secrets');
  check(pPreview.target.kind === 'merge-personal' && pPreview.target.renumber === true && pPreview.target.existingTasks === 1, 'merges into my personal space, renumbering');
  check(
    pPreview.account?.jev && pPreview.account.jevKey && pPreview.account.jevHost === `127.0.0.1:${jevServer.port}` && pPreview.account.photo && pPreview.account.homeLayout,
    `account settings in the preview (Jev host ${pPreview.account?.jevHost})`,
  );
  check(pPreview.account?.tokensNotMoved?.length === 2 && pPreview.account.tokensNotMoved.includes('내 스크립트'), 'the preview lists the API tokens that stay behind');
  check((await annB.fails('POST', '/api/migration/stage-remote', { link: migrateLink })).message === '이전 링크가 만료됐거나 이미 쓰였어요', 'the link works once');
  const logA2 = (await ann.api('GET', `/api/workspaces/${ann.workspace}/activity`)).activity as any[];
  check(logA2.some((e: any) => e.action === 'workspace.exported' && e.data.to === B && e.via === 'system'), 'A logs the pull with the target');

  const pResult = await annB.api('POST', '/api/migration/import', { stagingId: pPreview.stagingId });
  check(pResult.kind === 'personal' && pResult.renumbered && pResult.tokensNotMoved.length === 2 && pResult.incoming.length === 0, 'personal import done, tokens left behind');
  const myTasks = (await allTasks(annB)) as any[];
  check(myTasks.find((t) => t.title === '새 서버의 첫 작업')?.number === 1 && myTasks.find((t) => t.title === '여권 갱신')?.number === 2, 'imported tasks numbered after existing ones, in source order');
  const myProjects = (await annB.api('GET', '/api/projects')).projects as any[];
  const posHere = myProjects.find((p) => p.name === '새 서버의 프로젝트')?.position;
  const posMoved = myProjects.find((p) => p.name === '개인 프로젝트')?.position;
  check(typeof posHere === 'number' && typeof posMoved === 'number' && posMoved > posHere, 'moved projects line up after the ones already here');
  const meB = (await annB.api('GET', '/api/auth/me')).user;
  check(meB.timezone === 'America/New_York' && meB.homeLayout?.desktop.items[0].id === 'today' && !!meB.avatarUrl, 'timezone, home layout and photo applied');
  check(meB.jev.connected && meB.jev.hint === '6789' && meB.jev.model === 'jev-test', 'Jev key re-sealed on B');
  const viaApi = await fetch(`${B}/api/auth/me`, { headers: { authorization: `Bearer ${apiToken}` } });
  const viaApi2 = await fetch(`${B}/api/auth/me`, { headers: { authorization: `Bearer ${tokenOnly}` } });
  check(viaApi.status === 401 && viaApi2.status === 401, `API tokens from A do not work on B (${viaApi.status}, ${viaApi2.status})`);
  jevCalls.length = 0;
  await annB.api('POST', '/api/jev/priorities', {}).catch(() => null);
  check(jevCalls.includes('Bearer sk-test-jev-key-0123456789'), 'B calls Jev with the moved key');
  const myHooks = await annB.api('GET', '/api/webhooks');
  const personalHook = myHooks.webhooks.find((h: any) => h.name === '개인 알림');
  received.length = 0;
  await annB.api('POST', `/api/webhooks/${personalHook.id}/test`);
  const ping2 = received[0];
  const ts2 = ping2?.headers.get('x-obelisk-timestamp');
  check(
    !!ping2 && ping2.headers.get('x-obelisk-signature') === `sha256=${createHmac('sha256', personalSecret).update(`${ts2}.${ping2.body}`).digest('hex')}`,
    'pulled webhook secret works on B',
  );
  const personalLog = (await annB.api('GET', `/api/workspaces/${pResult.workspaceId}/activity?limit=200`)).activity as any[];
  check(
    personalLog[0]?.action === 'workspace.imported' && personalLog.some((e) => e.action === 'task.created' && e.subject === '#2 여권 갱신'),
    'personal history imported, its #numbers follow the renumbering',
  );
  const again2 = await annB.api('POST', '/api/migration/stage-remote', { link: migrateLink }).catch((e) => e);
  check(again2 instanceof HttpError && again2.status === 400, 'a used link stays used');
} catch (e) {
  failures++;
  console.log(`  ✗ unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof Error && e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  hookServer.stop(true);
  jevServer.stop(true);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
