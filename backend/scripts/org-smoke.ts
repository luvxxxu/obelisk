/**
 * End-to-end check of organizations and permissions against a running Obelisk.
 *   bun scripts/org-smoke.ts [baseUrl]
 * Creates throwaway accounts (needs SIGNUP_MODE=open; invite sign-up is exercised too).
 *
 * Covers: invites, private-by-default projects, member/team/everyone grants (view < edit < manage),
 * the private inbox, assignees, cascades through read-only tasks, roles, activity visibility,
 * who sees and restores what in the trash, moving a project between workspaces, and that MCP
 * calls carry exactly the account's rights.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.argv[2] ?? 'http://localhost:4000').replace(/\/$/, '');
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

/** One browser: its own cookie jar and open workspace. */
class Browser {
  cookie = '';
  workspace?: string;
  constructor(readonly label: string) {}

  async api(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie, 'x-obelisk-client': 'web' } : {}),
        ...(this.workspace ? { 'x-obelisk-workspace': this.workspace } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!res.ok) throw new HttpError(res.status, json ?? text);
    return json;
  }

  /** The HTTP status a call fails with (or 200). */
  async status(method: string, path: string, body?: unknown) {
    try {
      await this.api(method, path, body);
      return 200;
    } catch (e) {
      if (e instanceof HttpError) return e.status;
      throw e;
    }
  }
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const stamp = Date.now();

console.log(`Obelisk org smoke test → ${BASE}`);

// ───────────────────────────── accounts & org

console.log('accounts & organization');
const ann = new Browser('ann');
const bob = new Browser('bob');
const cat = new Browser('cat');
const annUser = (await ann.api('POST', '/api/auth/signup', { email: `ann-${stamp}@example.com`, password: 'correct-horse', name: 'Ann' })).user;
let boot = await ann.api('GET', '/api/bootstrap');
check(boot.workspace.kind === 'personal' && boot.workspaces.length === 1, 'sign-up creates a personal space');

const { workspace: org } = await ann.api('POST', '/api/workspaces', { name: `Acme ${stamp}` });
check(org.kind === 'org' && org.role === 'owner', 'creating an organization makes you its owner');
ann.workspace = org.id;

const inv = await ann.api('POST', `/api/workspaces/${org.id}/invites`, { role: 'member', expiresInDays: 7, maxUses: 2 });
const token = inv.url.split('/invite/')[1];
check(inv.url.includes('/invite/obi_'), 'invite link minted');
const preview = (await new Browser('anon').api('GET', `/api/invites/${token}`)).invite;
check(preview.valid && preview.workspace.name === org.name && preview.invitedBy === 'Ann', 'invite preview works signed out');

const bobSignup = await bob.api('POST', '/api/auth/signup', {
  email: `bob-${stamp}@example.com`,
  password: 'correct-horse',
  name: 'Bob',
  inviteToken: token,
});
const bobUser = bobSignup.user;
check(bobSignup.joinedWorkspaceId === org.id && bobUser.defaultWorkspaceId === org.id, 'signing up through an invite joins the org');
const catUser = (await cat.api('POST', '/api/auth/signup', { email: `cat-${stamp}@example.com`, password: 'correct-horse', name: 'Cat' })).user;
await cat.api('POST', `/api/invites/${token}/accept`);
bob.workspace = org.id;
cat.workspace = org.id;
check((await cat.api('GET', '/api/bootstrap')).workspace.id === org.id, 'a signed-in user accepts an invite');
check((await new Browser('x').api('GET', `/api/invites/${token}`)).invite.reason === 'used_up', 'a 2-use link is used up after two joins');

// ───────────────────────────── private by default

console.log('projects are private by default');
const { project: p1 } = await ann.api('POST', '/api/projects', { name: '로드맵' });
const { task: t1 } = await ann.api('POST', '/api/tasks', { title: '스펙', projectId: p1.id, startDate: day(1), dueDate: day(2) });
const { task: t2 } = await ann.api('POST', '/api/tasks', { title: '구현', projectId: p1.id, startDate: day(3), dueDate: day(4), blockedBy: [t1.id] });
check(p1.access === 'manage' && p1.memberAccess === 'none', 'creator manages a new private project');
boot = await bob.api('GET', '/api/bootstrap');
check(!boot.projects.some((p: any) => p.id === p1.id) && !boot.tasks.some((t: any) => t.id === t1.id), 'members do not see it');
check((await bob.status('GET', `/api/tasks/${t1.id}`)) === 404, 'a hidden task answers 404, not 403');
check((await bob.status('PATCH', `/api/tasks/${t1.id}`, { title: 'x' })) === 404, 'and cannot be written');
check([400, 404].includes(await bob.status('POST', '/api/tasks', { title: 'x', projectId: p1.id })), 'nor added to (no hint it exists)');

// ───────────────────────────── view

console.log('view access');
await ann.api('PUT', `/api/projects/${p1.id}/access`, { members: [{ userId: bobUser.id, level: 'view' }] });
boot = await bob.api('GET', '/api/bootstrap');
const seen = boot.projects.find((p: any) => p.id === p1.id);
check(seen?.access === 'view' && boot.tasks.some((t: any) => t.id === t1.id), 'a view grant shows the project and its tasks');
check(boot.dependencies.some((d: any) => d.taskId === t2.id), 'and its dependencies');
check((await bob.status('PATCH', `/api/tasks/${t1.id}`, { title: 'x' })) === 403, 'view cannot edit (403)');
check((await bob.status('POST', '/api/tasks', { title: 'x', projectId: p1.id })) === 403, 'view cannot add tasks');
check((await bob.status('DELETE', `/api/tasks/${t1.id}`)) === 403, 'view cannot delete');
check((await bob.status('POST', '/api/impact/postpone', { taskId: t1.id, days: 1 })) === 403, 'view cannot postpone');
check((await bob.status('POST', '/api/impact/simulate', { taskId: t1.id, days: 1 })) === 200, 'view can simulate');
check((await bob.status('PUT', `/api/projects/${p1.id}/access`, { memberAccess: 'edit' })) === 403, 'view cannot share');
check((await bob.status('GET', `/api/projects/${p1.id}/access`)) === 200, 'view can see who has access');

// ───────────────────────────── edit

console.log('edit access');
await ann.api('PUT', `/api/projects/${p1.id}/access`, { members: [{ userId: bobUser.id, level: 'edit' }] });
check((await bob.status('PATCH', `/api/tasks/${t1.id}`, { notes: 'Bob was here' })) === 200, 'edit can change tasks');
const { task: bobTask } = await bob.api('POST', '/api/tasks', { title: 'Bob 작업', projectId: p1.id });
check(bobTask.createdBy === bobUser.id, 'edit can add tasks');
check((await bob.status('PATCH', `/api/projects/${p1.id}`, { name: 'x' })) === 403, 'edit cannot rename the project (manage)');
check((await bob.status('DELETE', `/api/projects/${p1.id}`)) === 403, 'edit cannot delete the project');

// ───────────────────────────── teams & everyone

console.log('teams and org-wide access');
check((await bob.status('POST', `/api/workspaces/${org.id}/teams`, { name: 'x' })) === 403, 'members cannot create teams');
const { team } = await ann.api('POST', `/api/workspaces/${org.id}/teams`, { name: '디자인', memberIds: [catUser.id] });
check((await cat.api('GET', '/api/bootstrap')).projects.every((p: any) => p.id !== p1.id), 'cat starts without access');
await ann.api('PUT', `/api/projects/${p1.id}/access`, { teams: [{ teamId: team.id, level: 'view' }] });
const catSees = (await cat.api('GET', '/api/bootstrap')).projects.find((p: any) => p.id === p1.id);
check(catSees?.access === 'view', 'a team grant reaches team members');
const acc = (await ann.api('GET', `/api/projects/${p1.id}/access`)).access;
check(acc.effective.find((e: any) => e.userId === catUser.id)?.source === 'team', 'share info explains the source');
const { project: p2 } = await ann.api('POST', '/api/projects', { name: '공지', memberAccess: 'view' });
check((await cat.api('GET', '/api/bootstrap')).projects.some((p: any) => p.id === p2.id), 'memberAccess=view shows a project to everyone');
await ann.api('PUT', `/api/projects/${p1.id}/access`, { teams: [{ teamId: team.id, level: null }] });
check(!(await cat.api('GET', '/api/bootstrap')).projects.some((p: any) => p.id === p1.id), 'removing the team grant hides it again');

// ───────────────────────────── private inbox & assignees

console.log('private inbox and assignees');
const { task: inbox } = await bob.api('POST', '/api/tasks', { title: 'Bob 개인 메모' });
check(!(await ann.api('GET', '/api/bootstrap')).tasks.some((t: any) => t.id === inbox.id), "an org inbox task is hidden even from the owner");
check((await bob.status('PATCH', `/api/tasks/${inbox.id}`, { assigneeId: catUser.id })) === 200, 'assign it to a teammate');
check((await cat.api('GET', '/api/bootstrap')).tasks.some((t: any) => t.id === inbox.id), 'the assignee now sees it');
check((await cat.status('PATCH', `/api/tasks/${inbox.id}`, { status: 'done' })) === 200, 'and can complete it');
check(
  (await ann.status('PATCH', `/api/tasks/${t1.id}`, { assigneeId: catUser.id })) === 400,
  'cannot assign someone who cannot see the project',
);
check((await ann.status('PATCH', `/api/tasks/${t1.id}`, { assigneeId: bobUser.id })) === 200, 'can assign someone who can');
const mine = (await bob.api('GET', '/api/tasks?assignee=me')).tasks;
check(mine.length === 1 && mine[0].id === t1.id, 'assignee=me lists my tasks');

// ───────────────────────────── cascades stop at read-only tasks

console.log('cascade through read-only tasks');
const { project: p3 } = await ann.api('POST', '/api/projects', { name: '출시' });
const { task: t3 } = await ann.api('POST', '/api/tasks', { title: '출시 준비', projectId: p3.id, startDate: day(5), dueDate: day(5), blockedBy: [t2.id] });
await ann.api('PUT', `/api/projects/${p3.id}/access`, { members: [{ userId: bobUser.id, level: 'view' }] });
check((await bob.status('POST', '/api/impact/postpone', { taskId: t2.id, days: 3, cascade: true })) === 403, 'cascade into a view-only task is refused');
check((await bob.status('POST', '/api/impact/postpone', { taskId: t2.id, days: 3, cascade: false })) === 200, 'postponing only the task is allowed');
const t3After = (await ann.api('GET', `/api/tasks/${t3.id}`)).task;
check(t3After.dueDate === day(5), 'the read-only task did not move');

// ───────────────────────────── 모아보기 (every space at once)

console.log('overview across spaces');
const { task: t4 } = await ann.api('POST', '/api/tasks', { title: '출시 체크', projectId: p3.id, dueDate: day(1), assigneeId: bobUser.id });
const bobHome = new Browser('bob-personal');
bobHome.cookie = bob.cookie; // same session, personal space open (his default is the org he was invited to)
bobHome.workspace = 'personal';
const { task: own } = await bobHome.api('POST', '/api/tasks', { title: 'Bob 개인 할 일', dueDate: day(0) });
const ovBob = await bob.api('GET', '/api/overview');
const ovIds = new Set(ovBob.tasks.map((t: any) => t.id));
check(ovBob.spaces.length === 2 && ovBob.spaces[0].kind === 'personal', 'lists every space, personal first');
check(ovIds.has(own.id) && ovIds.has(t1.id), 'personal tasks and org tasks assigned to me are in');
check(!ovIds.has(t2.id) && !ovIds.has(t3.id), "unassigned org tasks are not");
check(ovBob.tasks.find((t: any) => t.id === t4.id)?.editable === false, 'an assigned task in a view-only project is read-only');
check(ovBob.tasks.find((t: any) => t.id === t1.id)?.editable === true, 'an assigned task in an editable project is editable');
const ovAnn = await ann.api('GET', '/api/overview');
check(!ovAnn.tasks.some((t: any) => t.id === t1.id || t.id === own.id), "others' assignments and personal tasks never show");

// ───────────────────────────── roles

console.log('roles');
check((await bob.status('PATCH', `/api/workspaces/${org.id}/members/${catUser.id}`, { role: 'admin' })) === 403, 'members cannot change roles');
await ann.api('PATCH', `/api/workspaces/${org.id}/members/${bobUser.id}`, { role: 'admin' });
const bobAdmin = await bob.api('GET', '/api/bootstrap');
check(bobAdmin.projects.every((p: any) => p.access === 'manage') && bobAdmin.projects.length >= 3, 'admins manage every project');
check((await bob.status('PATCH', `/api/workspaces/${org.id}/members/${annUser.id}`, { role: 'member' })) === 403, 'admins cannot demote the owner');
check((await ann.status('PATCH', `/api/workspaces/${org.id}/members/${annUser.id}`, { role: 'member' })) === 400, 'the last owner cannot step down');
check((await ann.status('DELETE', `/api/workspaces/${org.id}/members/${annUser.id}`)) === 400, 'the last owner cannot leave');
await ann.api('PATCH', `/api/workspaces/${org.id}/members/${bobUser.id}`, { role: 'member' });

// ───────────────────────────── activity

console.log('activity');
const log = (await ann.api('GET', `/api/workspaces/${org.id}/activity?limit=200`)).activity;
check(log.some((e: any) => e.action === 'member.joined') && log.some((e: any) => e.action === 'project.access'), 'admins see member and sharing events');
check(!log.some((e: any) => e.taskId === inbox.id), "even admins don't see others' private tasks in the log");
const catLog = (await cat.api('GET', `/api/workspaces/${org.id}/activity?limit=200`)).activity;
check(catLog.some((e: any) => e.taskId === inbox.id), 'the assignee sees the private task history');
const history = (await ann.api('GET', `/api/tasks/${t1.id}/activity`)).activity;
check(history.some((e: any) => e.action === 'task.updated' && e.actor.name === 'Bob'), "a task's history names who changed it");
const bobLog = (await bob.api('GET', `/api/workspaces/${org.id}/activity?limit=200`)).activity;
check(!bobLog.some((e: any) => e.action.startsWith('member.') || e.action.startsWith('team.')), 'members do not see admin events');
check(bobLog.every((e: any) => !e.projectId || [p1.id, p2.id, p3.id].includes(e.projectId)), 'members only see projects they can see');

// ───────────────────────────── MCP carries the account's rights

console.log('mcp');
const { token: bobToken } = await bob.api('POST', '/api/tokens', { name: 'org-smoke' });
const client = new Client({ name: 'org-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bobToken}` } } }));
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as any;
const ws = await call('list_workspaces');
check(ws.structuredContent.workspaces.length === 2 && ws.structuredContent.workspaces.some((w: any) => w.default && w.id === org.id), 'list_workspaces shows the org as default');
const listed = await call('list_tasks', { view: 'all' });
const refs = listed.structuredContent.tasks.map((t: any) => t.id);
check(refs.includes(t1.id) && refs.includes(t3.id), 'list_tasks sees granted projects');
check(listed.structuredContent.tasks.find((t: any) => t.id === t3.id)?.readOnly === true, 'view-only tasks are marked readOnly');
const denied = await call('update_task', { ref: `#${t3.number}`, title: '해킹' });
check(denied.isError && /권한/.test(denied.content[0].text), 'MCP writes to a view-only task are refused');
const allowed = await call('update_task', { ref: `#${t1.number}`, priority: 'high', assignee: 'me' });
check(!allowed.isError && allowed.structuredContent.updated.assignee === 'Bob', 'MCP writes where the account may');
const hiddenAnn = await ann.api('POST', '/api/tasks', { title: '비밀', projectId: (await ann.api('POST', '/api/projects', { name: '비밀 프로젝트' })).project.id });
const peek = await call('get_task', { ref: `#${hiddenAnn.task.number}` });
check(peek.isError, 'MCP cannot read tasks in projects the account cannot see');
const personal = await call('list_tasks', { view: 'all', workspace: '개인' });
check(!personal.isError && personal.structuredContent.workspace === '개인 공간', 'workspace argument switches spaces');
const { token: annToken } = await ann.api('POST', '/api/tokens', { name: 'org-smoke-owner' });
const viaToken = await fetch(`${BASE}/api/projects/${p1.id}/access`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${annToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ memberAccess: 'edit' }),
});
check(viaToken.status === 403, "even an owner's token cannot change sharing (web only)");
const members = await call('list_members');
check(members.structuredContent.members.length === 3, 'list_members');
const act = await call('get_activity', { task: `#${t1.number}` });
check(act.structuredContent.activity.some((e: any) => e.via?.includes('org-smoke')), 'get_activity shows changes made through the token');
await client.close();

// ───────────────────────────── trash follows visibility

console.log('trash');
{
  const binOf = async (b: Browser) => (await b.api('GET', '/api/trash')).items as any[];
  const has = (items: any[], id: string) => items.some((i) => i.task.id === id);
  const { task: secret } = await ann.api('POST', '/api/tasks', { title: '비밀 메모', projectId: hiddenAnn.task.projectId });
  await ann.api('POST', '/api/tasks/delete', { ids: [secret.id] });
  check(!has(await binOf(bob), secret.id), "a member does not see the trash of a project they can't see");
  check((await bob.status('POST', '/api/trash/restore', { ids: [secret.id] })) === 404, 'nor restore it (404)');
  check((await bob.api('POST', '/api/trash/purge', { ids: [secret.id] })).purged === 0, 'nor purge it');
  check((await binOf(ann)).find((i) => i.task.id === secret.id)?.canRestore === true, 'the owner sees it and may restore it');

  await ann.api('DELETE', `/api/tasks/${t3.id}`);
  const seenByBob = (await binOf(bob)).find((i) => i.task.id === t3.id);
  check(seenByBob && seenByBob.canRestore === false, 'view access shows the trashed task, read-only');
  check((await bob.status('POST', '/api/trash/restore', { ids: [t3.id] })) === 403, 'view cannot restore (403)');
  check((await bob.status('POST', '/api/trash/purge', { ids: [t3.id] })) === 403, 'view cannot purge (403)');
  await bob.api('POST', '/api/trash/empty');
  check(has(await binOf(ann), t3.id), "emptying skips what you can't restore");

  await bob.api('DELETE', `/api/tasks/${inbox.id}`);
  check(!has(await binOf(ann), inbox.id), "someone else's private inbox task stays private in the trash");
  check(has(await binOf(cat), inbox.id), 'its assignee sees it there');
  check((await ann.status('POST', '/api/trash/restore', { ids: [inbox.id] })) === 404, 'and the owner cannot restore it');

  const { project: doomed } = await ann.api('POST', '/api/projects', { name: '정리할 프로젝트' });
  await ann.api('PUT', `/api/projects/${doomed.id}/access`, { members: [{ userId: bobUser.id, level: 'edit' }] });
  const { task: bobMade } = await bob.api('POST', '/api/tasks', { title: 'Bob이 만든 작업', projectId: doomed.id });
  const { task: bobMade2 } = await bob.api('POST', '/api/tasks', { title: 'Bob이 만든 두 번째 작업', projectId: doomed.id });
  await ann.api('DELETE', `/api/projects/${doomed.id}?deleteTasks=true`);
  const orphan = (await binOf(bob)).find((i) => i.task.id === bobMade.id);
  check(orphan?.task.projectId === null && orphan.canRestore, 'a deleted project leaves its tasks to their makers, bound for the inbox');
  const back = await bob.api('POST', '/api/trash/restore', { ids: [bobMade.id] });
  check(back.tasks[0]?.projectId === null && (await bob.api('GET', `/api/tasks/${bobMade.id}`)).task.id === bobMade.id, 'restored into their private inbox');
  const byDeleter = await ann.api('POST', '/api/trash/restore', { ids: [bobMade2.id] });
  check(
    byDeleter.tasks.length === 0 && byDeleter.missing.length === 0,
    "the deleter's restore puts it back in its maker's private inbox (not missing, just not theirs to see)",
  );
  const bobsAgain = (await bob.api('GET', `/api/tasks/${bobMade2.id}`)).task;
  check(bobsAgain.projectId === null && bobsAgain.assigneeId === null, 'its maker sees it, unassigned, in their inbox');

  const restored = await ann.api('POST', '/api/trash/restore', { ids: [t3.id, secret.id] });
  check(restored.tasks.length === 2 && restored.dependencies.some((d: any) => d.taskId === t3.id && d.dependsOnId === t2.id), 'the owner restores with links');
  check((await bob.api('POST', '/api/trash/restore', { ids: [inbox.id] })).tasks.length === 1, 'the maker restores their inbox task');
}

// ───────────────────────────── move a project in

console.log('move project between workspaces');
ann.workspace = undefined;
const { project: mine1 } = await ann.api('POST', '/api/projects', { name: '개인 프로젝트' });
check(mine1.workspaceId !== org.id, 'project created in the personal space (default)');
const { task: m1 } = await ann.api('POST', '/api/tasks', { title: '옮길 작업', projectId: mine1.id });
const { task: stay } = await ann.api('POST', '/api/tasks', { title: '남을 작업' });
await ann.api('POST', `/api/tasks/${m1.id}/dependencies`, { dependsOnId: stay.id });
const moved = await ann.api('POST', `/api/projects/${mine1.id}/move`, { workspaceId: org.id });
check(moved.tasks === 1 && moved.linksCut === 1, 'moving cuts links to tasks left behind');
ann.workspace = org.id;
const movedTask = (await ann.api('GET', `/api/tasks/${m1.id}`)).task;
const orgBoot = await ann.api('GET', '/api/bootstrap');
check(orgBoot.projects.some((p: any) => p.id === mine1.id && p.memberAccess === 'none'), 'the project arrives private');
check(movedTask.number > t3.number, 'its tasks get new numbers in the org');
check(!(await bob.api('GET', '/api/bootstrap')).projects.some((p: any) => p.id === mine1.id), 'other members cannot see it yet');

// ───────────────────────────── leaving & deleting

console.log('leaving and deleting');
const { project: catsProject } = await ann.api('POST', '/api/projects', { name: 'Cat의 프로젝트' });
await ann.api('PUT', `/api/projects/${catsProject.id}/access`, { members: [{ userId: catUser.id, level: 'edit' }] });
const { task: catMade } = await cat.api('POST', '/api/tasks', { title: 'Cat이 남긴 작업', projectId: catsProject.id });
await ann.api('DELETE', `/api/projects/${catsProject.id}?deleteTasks=true`);
await ann.api('DELETE', `/api/workspaces/${org.id}/members/${catUser.id}`);
check((await cat.status('GET', '/api/bootstrap')) === 404, 'a removed member loses the org');
const orphaned = await ann.api('POST', '/api/trash/restore', { ids: [catMade.id] });
check(
  orphaned.tasks[0]?.id === catMade.id && orphaned.tasks[0].assigneeId === annUser.id && orphaned.tasks[0].projectId === null,
  'a task whose maker has left comes back assigned to whoever restores it, so it does not vanish',
);
check((await new Browser('x').api('GET', `/api/invites/${token}`)).invite.valid === false, 'old link stays used up');
check((await ann.status('DELETE', `/api/workspaces/${org.id}`, { confirm: 'wrong' })) === 400, 'deleting needs the exact name');
check((await bob.status('DELETE', `/api/workspaces/${org.id}`, { confirm: org.name })) === 403, 'only owners delete');
await ann.api('DELETE', `/api/workspaces/${org.id}`, { confirm: org.name });
bob.workspace = undefined;
const bobAfter = await bob.api('GET', '/api/bootstrap');
check(bobAfter.workspace.kind === 'personal', 'members fall back to their personal space');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
