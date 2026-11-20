/**
 * End-to-end check of 서버 관리 (the operator's panel) against a running Obelisk.
 *   bun scripts/admin-smoke.ts [baseUrl]
 * Needs an operator: on an empty database the script signs up first (the first account becomes the
 * operator); otherwise give one with OBELISK_ADMIN_EMAIL / OBELISK_ADMIN_PASSWORD. Creates throwaway
 * accounts and puts the server's settings back the way it found them.
 *
 * Covers: who may reach /api/admin, the four sign-up modes, approval and the gate codes, server
 * invites (single use), the domain list and required address confirmation, suspension (sign-in, API
 * tokens), the last operator, ownerless organizations, the organization-creation limit, the
 * announcement in the bootstrap, deleting an account, and the operator log.
 */

const BASE = (process.argv[2] ?? 'http://localhost:4000').replace(/\/$/, '');
const stamp = Date.now().toString(36);
let failures = 0;

function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`);
  }
}

/** One browser: its own cookie jar. */
class Browser {
  cookie = '';
  async call(method: string, path: string, body?: unknown, bearer?: string) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie && !bearer ? { cookie: this.cookie, 'x-obelisk-client': 'web' } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data };
  }
  async ok(method: string, path: string, body?: unknown) {
    const r = await this.call(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
}

const email = (who: string) => `${who}-${stamp}@example.com`;

async function signup(who: string, extra: Record<string, unknown> = {}) {
  const b = new Browser();
  const r = await b.call('POST', '/api/auth/signup', { email: email(who), password: 'smoke-password-1', name: who, ...extra });
  return { b, r };
}

async function main() {
  console.log(`서버 관리 smoke test against ${BASE}`);
  const op = new Browser();
  const status = await new Browser().ok('GET', '/api/auth/signup-status');
  if (status.first) {
    const r = await op.call('POST', '/api/auth/signup', { email: email('operator'), password: 'smoke-password-1', name: '운영자' });
    check(r.status === 201 && r.data.user.admin, 'the first account becomes the operator');
  } else {
    const e = process.env.OBELISK_ADMIN_EMAIL;
    const p = process.env.OBELISK_ADMIN_PASSWORD;
    if (!e || !p) throw new Error('This server already has accounts: set OBELISK_ADMIN_EMAIL and OBELISK_ADMIN_PASSWORD (an operator).');
    await op.ok('POST', '/api/auth/login', { email: e, password: p });
  }
  const me = (await op.ok('GET', '/api/auth/me')).user;
  if (!me.admin) throw new Error(`${me.email} is not an operator`);
  const before = await op.ok('GET', '/api/admin/settings');
  const restore = {
    signupMode: before.signupMode,
    requireEmailVerification: before.requireEmailVerification,
    allowedEmailDomains: before.allowedEmailDomains,
    orgCreation: before.orgCreation,
    updateCheck: before.updateCheck,
  };

  try {
    console.log('\nwho may reach 서버 관리');
    await op.ok('PATCH', '/api/admin/settings', { signupMode: 'open', requireEmailVerification: false, allowedEmailDomains: [] });
    const { b: plain } = await signup('plain');
    check((await plain.call('GET', '/api/admin/status')).status === 403, 'a regular account gets 403');
    const token = (await plain.ok('POST', '/api/tokens', { name: 'smoke' })).token as string;
    check((await plain.call('GET', '/api/admin/status', undefined, token)).status === 403, 'an API token never reaches it');
    check((await new Browser().call('GET', '/api/admin/status')).status === 401, 'signed out: 401');
    const st = await op.ok('GET', '/api/admin/status');
    check(typeof st.usage.users === 'number' && Array.isArray(st.checks), 'the operator sees the overview');
    check(!JSON.stringify(st).includes('smoke-password'), 'no secret in the overview');

    console.log('\napproval');
    await op.ok('PATCH', '/api/admin/settings', { signupMode: 'approval' });
    const s1 = await new Browser().ok('GET', '/api/auth/signup-status');
    check(s1.allowed && s1.approval, 'sign-up status says an operator approves');
    const { b: applicant, r: applied } = await signup('applicant');
    check(applied.status === 201 && applied.data.gate === 'pending_approval', 'the new account waits for approval');
    const gated = await applicant.call('GET', '/api/bootstrap');
    check(gated.status === 403 && gated.data.code === 'pending_approval', 'the app answers 403 pending_approval');
    check((await applicant.call('GET', '/api/auth/me')).status === 200, '/api/auth/me still answers');
    const pending = await op.ok('GET', `/api/admin/users?filter=pending&q=${encodeURIComponent(email('applicant'))}`);
    check(pending.users.length === 1 && pending.users[0].state === 'pending', 'it is listed as pending');
    await op.ok('POST', `/api/admin/users/${applied.data.user.id}/approve`);
    check((await applicant.call('GET', '/api/bootstrap')).status === 200, 'approved: the app opens');
    const { r: rejected } = await signup('rejected');
    await op.ok('POST', `/api/admin/users/${rejected.data.user.id}/reject`);
    check((await op.call('GET', `/api/admin/users/${rejected.data.user.id}`)).status === 404, 'rejecting deletes the application');

    console.log('\ninvite-only and server invites');
    await op.ok('PATCH', '/api/admin/settings', { signupMode: 'invite' });
    check((await signup('uninvited')).r.status === 403, 'no invite, no account');
    const inv = await op.ok('POST', '/api/admin/invites', { note: 'smoke', maxUses: 1, expiresInDays: 1 });
    const osi = new URL(inv.url).searchParams.get('invite')!;
    check(osi.startsWith('osi_'), 'the link carries an osi_ token');
    const withInvite = await new Browser().ok('GET', `/api/auth/signup-status?invite=${osi}`);
    check(withInvite.allowed && withInvite.invited, 'the invite opens sign-up');
    const used = await signup('invited', { inviteToken: osi });
    check(used.r.status === 201 && used.r.data.gate === null, 'signing up with it works, no approval');
    check((await signup('invited2', { inviteToken: osi })).r.status === 400, 'a single-use link works once');

    console.log('\nclosed');
    await op.ok('PATCH', '/api/admin/settings', { signupMode: 'closed' });
    check(!(await new Browser().ok('GET', '/api/auth/signup-status')).allowed, 'nobody can sign up');
    const inv2 = await op.ok('POST', '/api/admin/invites', {});
    check((await signup('closed', { inviteToken: new URL(inv2.url).searchParams.get('invite') })).r.status === 403, 'not even with an invite');

    console.log('\nconfirmed addresses and the domain list');
    const mailOk = (await op.ok('GET', '/api/admin/settings')).mailAvailable;
    if (mailOk) {
      await op.ok('PATCH', '/api/admin/settings', { signupMode: 'open', allowedEmailDomains: ['@Example.com'] });
      check((await new Browser().ok('GET', '/api/auth/signup-status')).domains.join() === 'example.com', 'the domain is cleaned and shown');
      const outside = await new Browser().call('POST', '/api/auth/signup', { email: `out-${stamp}@elsewhere.dev`, password: 'smoke-password-1', name: 'x' });
      check(outside.status === 403, 'another domain is refused');
      const { b: unverified, r: uv } = await signup('unverified');
      check(uv.data.gate === 'email_unverified', 'a domain sign-up must confirm its address');
      check((await unverified.call('GET', '/api/bootstrap')).data.code === 'email_unverified', 'the app answers 403 email_unverified');
      await op.ok('POST', `/api/admin/users/${uv.data.user.id}/skip-verification`);
      check((await unverified.call('GET', '/api/bootstrap')).status === 200, 'an operator can let it in without the mail');
      const me2 = (await unverified.ok('GET', '/api/auth/me')).user;
      check(me2.emailVerified === false, '…and it stays unconfirmed');
    } else {
      console.log('  · skipped: this server cannot send mail');
      const r = await op.call('PATCH', '/api/admin/settings', { requireEmailVerification: true });
      check(r.status === 400, 'turning confirmation on without mail is refused');
    }
    await op.ok('PATCH', '/api/admin/settings', { signupMode: 'open', allowedEmailDomains: [], requireEmailVerification: false });

    console.log('\nsuspension');
    const { b: victim, r: vr } = await signup('suspended');
    const vtoken = (await victim.ok('POST', '/api/tokens', { name: 'smoke' })).token as string;
    check((await victim.call('GET', '/api/bootstrap', undefined, vtoken)).status === 200, 'its API token works before');
    await op.ok('POST', `/api/admin/users/${vr.data.user.id}/suspend`, { note: 'smoke' });
    check((await victim.call('GET', '/api/bootstrap')).status === 401, 'its session ends');
    check((await victim.call('GET', '/api/bootstrap', undefined, vtoken)).status === 401, 'its API token stops');
    const relog = await new Browser().call('POST', '/api/auth/login', { email: email('suspended'), password: 'smoke-password-1' });
    check(relog.status === 403, 'signing in is refused with the right password');
    const wrong = await new Browser().call('POST', '/api/auth/login', { email: email('suspended'), password: 'nope-nope-1' });
    check(wrong.status === 401, '…and a wrong password says nothing about the suspension');
    await op.ok('POST', `/api/admin/users/${vr.data.user.id}/unsuspend`);
    check((await new Browser().call('POST', '/api/auth/login', { email: email('suspended'), password: 'smoke-password-1' })).status === 200, 'lifted: it signs in again');
    check((await op.call('POST', `/api/admin/users/${me.id}/suspend`, {})).status === 400, 'an operator cannot suspend themself');

    console.log('\noperators');
    const admins = await op.ok('GET', '/api/admin/users?filter=admins&limit=200');
    if (admins.total === 1) check((await op.call('POST', `/api/admin/users/${me.id}/admin`, { admin: false })).status === 400, 'the last operator stays');
    await op.ok('POST', `/api/admin/users/${used.r.data.user.id}/admin`, { admin: true });
    check((await op.call('POST', `/api/admin/users/${used.r.data.user.id}/suspend`, {})).status === 400, 'an operator must be demoted before a suspension');
    await op.ok('POST', `/api/admin/users/${used.r.data.user.id}/admin`, { admin: false });

    console.log('\nownerless organizations');
    const { b: owner, r: or } = await signup('owner');
    const org = (await owner.ok('POST', '/api/workspaces', { name: `스모크 ${stamp}` })).workspace;
    const invite = await owner.ok('POST', `/api/workspaces/${org.id}/invites`, { role: 'member' });
    const inviteToken = new URL(invite.url).pathname.split('/').pop();
    const { r: mr } = await signup('member', { inviteToken });
    check((await op.call('POST', `/api/admin/orgs/${org.id}/owner`, { userId: mr.data.user.id })).status === 400, 'an organization with an owner is left alone');
    await op.ok('POST', `/api/admin/users/${or.data.user.id}/suspend`, {});
    const stuck = await op.ok('GET', `/api/admin/orgs?ownerless=true&q=${encodeURIComponent(org.name)}`);
    check(stuck.orgs.length === 1 && stuck.orgs[0].ownerless, 'its only owner suspended: it shows as ownerless');
    await op.ok('POST', `/api/admin/orgs/${org.id}/owner`, { userId: mr.data.user.id });
    const after = await op.ok('GET', `/api/admin/orgs/${org.id}/members`);
    check(after.members.find((m: any) => m.id === mr.data.user.id)?.role === 'owner', 'a member becomes its owner');

    console.log('\norganization creation and the announcement');
    await op.ok('PATCH', '/api/admin/settings', { orgCreation: 'admins' });
    check((await plain.call('POST', '/api/workspaces', { name: 'x' })).status === 403, '‘operators only’: a regular account cannot create one');
    check((await plain.ok('GET', '/api/bootstrap')).server.canCreateOrg === false, 'the bootstrap says so');
    await op.ok('PATCH', '/api/admin/settings', { orgCreation: 'everyone' });
    await op.ok('PUT', '/api/admin/announcement', { text: `smoke ${stamp}` });
    check((await plain.ok('GET', '/api/bootstrap')).server.announcement?.text === `smoke ${stamp}`, 'everyone sees the announcement');
    await op.ok('PUT', '/api/admin/announcement', { text: before.announcement?.text ?? '' });

    console.log('\ndeleting an account');
    check((await op.call('DELETE', `/api/admin/users/${vr.data.user.id}`, { confirm: 'wrong@example.com' })).status === 400, 'the address must be typed');
    await op.ok('DELETE', `/api/admin/users/${vr.data.user.id}`, { confirm: email('suspended') });
    check((await new Browser().call('POST', '/api/auth/login', { email: email('suspended'), password: 'smoke-password-1' })).status === 401, 'it is gone');

    console.log('\nthe log');
    const log = await op.ok('GET', '/api/admin/log?limit=200');
    const actions = new Set(log.entries.map((e: any) => e.action));
    for (const a of ['user.approved', 'user.rejected', 'user.suspended', 'user.unsuspended', 'invite.created', 'org.owner_set', 'user.deleted', 'settings.updated']) {
      check(actions.has(a), `logged: ${a}`);
    }
  } finally {
    await op.call('PATCH', '/api/admin/settings', restore);
    if (!before.announcement) await op.call('PUT', '/api/admin/announcement', { text: '' });
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
