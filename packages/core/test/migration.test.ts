import { describe, expect, test } from 'bun:test';
import { describeActivity } from '../src/activity';
import {
  migrationBundle,
  migrationHeaderIssue,
  parseMigrationLink,
  remapActivityData,
  renumberRef,
  type ActivityIdMap,
  type MigrationBundleInput,
} from '../src/migration';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-01T09:00:00.000Z';

function bundle(over: Partial<MigrationBundleInput> = {}): MigrationBundleInput {
  return {
    format: 'obelisk-export',
    version: 1,
    exportId: ID(900),
    exportedAt: AT,
    source: { url: 'https://a.example' },
    kind: 'org',
    exporterId: ID(1),
    workspace: { id: ID(100), name: '에이크미', taskSeq: 3, membersCanCreateProjects: true, createdAt: AT, photo: null },
    people: [
      { id: ID(1), email: 'Ann@Example.com', name: 'Ann', role: 'owner' },
      { id: ID(2), email: 'bob@example.com', name: 'Bob', role: 'member' },
    ],
    teams: [{ id: ID(50), name: '디자인', createdAt: AT, members: [ID(2)] }],
    projects: [
      {
        id: ID(200),
        name: '로드맵',
        color: 'blue',
        position: 1,
        memberAccess: 'view',
        archivedAt: null,
        createdBy: ID(1),
        createdAt: AT,
        updatedAt: AT,
        members: [{ person: ID(2), level: 'edit' }],
        teams: [{ team: ID(50), level: 'view' }],
      },
    ],
    tasks: [
      {
        id: ID(300),
        number: 1,
        project: ID(200),
        title: '스펙',
        notes: '',
        status: 'todo',
        priority: 2,
        startDate: '2026-11-02',
        dueDate: '2026-11-03',
        startTime: '09:00',
        dueTime: null,
        fixed: false,
        position: 1,
        postponedCount: 2,
        completedAt: null,
        createdAt: AT,
        updatedAt: AT,
        createdBy: ID(1),
        assignee: ID(2),
      },
    ],
    dependencies: [],
    activity: [
      {
        actor: ID(1),
        actorName: 'Ann',
        via: 'session',
        client: null,
        action: 'task.created',
        project: ID(200),
        task: ID(300),
        subject: '#1 스펙',
        data: {},
        createdAt: AT,
      },
    ],
    webhooks: [],
    incomingWebhooks: [],
    account: null,
    ...over,
  };
}

describe('migrationBundle', () => {
  test('accepts a valid bundle and normalizes it', () => {
    const b = migrationBundle.parse(bundle());
    expect(b.people[0]!.email).toBe('ann@example.com');
    expect(b.tasks[0]!.startTime).toBe('09:00');
    expect(b.secrets).toBeUndefined();
    // A version 1 file names one assignee.
    expect(b.tasks[0]!.assignees).toEqual([ID(2)]);
  });

  test('version 2 tasks carry several assignees', () => {
    const v1 = bundle().tasks[0]!;
    const { assignee: _, ...task } = v1;
    const b = migrationBundle.parse(bundle({ version: 2, tasks: [{ ...task, assignees: [ID(2), ID(1), ID(2)] }] }));
    expect(b.tasks[0]!.assignees).toEqual([ID(2), ID(1)]);
    expect(migrationBundle.parse(bundle({ version: 2, tasks: [{ ...task }] })).tasks[0]!.assignees).toEqual([]);
  });

  test('accepts locked and plain secrets', () => {
    const plain = migrationBundle.safeParse(bundle({ secrets: { mode: 'plain', data: { jevKey: null, webhooks: { [ID(7)]: 'whsec_abcdefgh' } } } }));
    expect(plain.success).toBe(true);
    const locked = migrationBundle.safeParse(
      bundle({ secrets: { mode: 'locked', kdf: 'scrypt', N: 2 ** 15, r: 8, p: 1, salt: 'c2FsdA', iv: 'aXY', tag: 'dGFn', body: 'Ym9keQ' } }),
    );
    expect(locked.success).toBe(true);
  });

  test('drops a time without its date, unknown colors and unknown webhook events', () => {
    const b = migrationBundle.parse(
      bundle({
        tasks: [{ ...bundle().tasks[0]!, startDate: null, startTime: '09:00' }],
        projects: [{ ...bundle().projects[0]!, color: 'ultraviolet' }],
        webhooks: [
          {
            id: ID(7),
            name: '알림',
            url: 'https://hooks.example/x',
            format: 'json',
            events: ['task.created', 'task.teleported'],
            projects: null,
            alertHour: 9,
            remindMinutes: 30,
            timezone: 'Mars/Olympus',
            enabled: true,
            createdBy: ID(1),
            createdAt: AT,
          },
        ],
      }),
    );
    expect(b.tasks[0]!.startTime).toBeNull();
    expect(b.projects[0]!.color).toBe('blue');
    expect(b.webhooks[0]!.events).toEqual(['task.created']);
    expect(b.webhooks[0]!.timezone).toBe('Asia/Seoul');
  });

  test('rejects broken bundles', () => {
    const bad: unknown[] = [
      { ...bundle(), kind: 'team' },
      { ...bundle(), exporterId: ID(77) },
      { ...bundle(), tasks: [{ ...bundle().tasks[0]!, status: 'later' }] },
      { ...bundle(), tasks: [{ ...bundle().tasks[0]!, dueTime: '25:00', dueDate: '2026-11-03' }] },
      { ...bundle(), tasks: [{ ...bundle().tasks[0]!, priority: 7 }] },
      { ...bundle(), tasks: [{ ...bundle().tasks[0]!, title: '' }] },
      { ...bundle(), people: [] },
      { ...bundle(), projects: [{ ...bundle().projects[0]!, memberAccess: 'manage' }] },
      { ...bundle(), incomingWebhooks: [{ name: '', project: null, allowUpdates: true, createdBy: ID(1), useCount: 0, lastUsedAt: null, createdAt: AT }] },
      { ...bundle(), formerPeople: [{ id: ID(9), email: 'not-an-email', name: 'Zed' }] },
      { ...bundle(), secrets: { mode: 'locked', kdf: 'scrypt', N: 2 ** 22, r: 8, p: 1, salt: 'a', iv: 'b', tag: 'c', body: 'd' } },
      { ...bundle(), secrets: { mode: 'plain' } },
      { ...bundle(), workspace: { ...bundle().workspace, photo: { contentType: 'image/gif', data: '' } } },
    ];
    for (const b of bad) expect(migrationBundle.safeParse(b).success).toBe(false);
  });

  test('refuses repeated ids, task numbers, team names and emails (hand-edited files)', () => {
    const b = bundle();
    const t = b.tasks[0]!;
    const cases: [Partial<MigrationBundleInput>, string][] = [
      [{ tasks: [t, { ...t, number: 2 }] }, '같은 작업이'],
      [{ tasks: [t, { ...t, id: ID(301) }] }, '같은 번호의 작업'],
      [{ projects: [b.projects[0]!, b.projects[0]!] }, '같은 프로젝트'],
      [{ teams: [b.teams[0]!, { ...b.teams[0]!, id: ID(51) }] }, '같은 이름의 팀'],
      [{ teams: [b.teams[0]!, { ...b.teams[0]!, name: '다른 팀' }] }, '같은 팀이'],
      [{ people: [...b.people, { id: ID(3), email: 'BOB@example.com', name: 'Bob 2', role: 'member' }] }, '같은 이메일'],
      [{ formerPeople: [{ id: ID(2), email: 'old@example.com', name: 'Old' }] }, '같은 사람'],
    ];
    for (const [over, message] of cases) {
      const r = migrationBundle.safeParse(bundle(over));
      expect(r.success).toBe(false);
      expect(r.error?.issues.some((i) => i.message.includes(message))).toBe(true);
    }
  });

  test('credential hashes of older files are accepted and not needed', () => {
    const account = {
      timezone: 'Asia/Seoul',
      homeLayout: null,
      photo: null,
      wasDefault: true,
      jev: { baseUrl: null, model: null, autoApply: false, keyHint: null, hasKey: false },
      apiTokens: [{ name: '옛 토큰', prefix: 'obk_ab', tokenHash: 'a'.repeat(64), createdAt: AT, lastUsedAt: null }, { name: '새 토큰', createdAt: AT, lastUsedAt: null }],
    };
    const hook = { name: '폼', project: null, allowUpdates: true, createdBy: ID(1), useCount: 3, lastUsedAt: null, createdAt: AT };
    const b = migrationBundle.parse(
      bundle({ kind: 'personal', account, incomingWebhooks: [{ ...hook, tokenHash: 'b'.repeat(64), hint: 'abcd' }, hook] }),
    );
    expect(b.account!.apiTokens.map((t) => t.name)).toEqual(['옛 토큰', '새 토큰']);
    expect(b.incomingWebhooks).toHaveLength(2);
    expect(b.formerPeople).toEqual([]);
  });

  test('a bad home layout resets instead of failing the import', () => {
    const account = {
      timezone: 'Asia/Seoul',
      homeLayout: { v: 9 } as never,
      photo: null,
      wasDefault: true,
      jev: { baseUrl: null, model: null, autoApply: false, keyHint: null, hasKey: false },
      apiTokens: [],
    };
    expect(migrationBundle.parse(bundle({ kind: 'personal', account })).account!.homeLayout).toBeNull();
  });

  test('header issues are worded for people', () => {
    expect(migrationHeaderIssue(bundle())).toBeNull();
    expect(migrationHeaderIssue({ hello: 1 })).toBe('Obelisk 내보내기 파일이 아니에요');
    expect(migrationHeaderIssue(null)).toBe('Obelisk 내보내기 파일이 아니에요');
    expect(migrationHeaderIssue({ format: 'obelisk-export', version: 3 })).toContain('더 새 버전');
  });
});

describe('parseMigrationLink', () => {
  const code = 'omg_' + 'a'.repeat(32);
  test('reads origin and code from the link', () => {
    expect(parseMigrationLink(`https://a.example/settings/migrate#${code}`)).toEqual({ origin: 'https://a.example', code });
    expect(parseMigrationLink(`  http://localhost:4210/settings/migrate#${code}  `)).toEqual({ origin: 'http://localhost:4210', code });
    expect(parseMigrationLink(`https://a.example:8443/anything?x=1#${code}`)).toEqual({ origin: 'https://a.example:8443', code });
  });
  test('refuses anything else', () => {
    expect(parseMigrationLink(code)).toBeNull();
    expect(parseMigrationLink('https://a.example/settings/migrate')).toBeNull();
    expect(parseMigrationLink('https://a.example/settings/migrate#obi_' + 'a'.repeat(32))).toBeNull();
    expect(parseMigrationLink('https://a.example/settings/migrate#omg_short')).toBeNull();
    expect(parseMigrationLink(`ftp://a.example/#${code}`)).toBeNull();
    expect(parseMigrationLink(`https://u:p@a.example/#${code}`)).toBeNull();
    expect(parseMigrationLink('not a link')).toBeNull();
  });
});

describe('remapActivityData', () => {
  const map: ActivityIdMap = {
    task: (id) => `task:${id}`,
    user: (id) => (id === 'gone' ? null : `user:${id}`),
    team: (id) => `team:${id}`,
    project: (id) => `project:${id}`,
  };

  test('task links and cascades', () => {
    expect(remapActivityData('dependency.added', { blockedBy: '#1 a', blockedById: 't1' }, map)).toEqual({ blockedBy: '#1 a', blockedById: 'task:t1' });
    expect(remapActivityData('dependency.removed', { blockedBy: null, blockedById: 't1' }, map).blockedById).toBe('task:t1');
    const cascade = remapActivityData('task.updated', { changes: { dueDate: { from: 'a', to: 'b' } }, cause: '#2', causeId: 't2' }, map);
    expect(cascade).toEqual({ changes: { dueDate: { from: 'a', to: 'b' } }, cause: '#2', causeId: 'task:t2' });
  });

  test('assignee changes', () => {
    const d = remapActivityData('task.updated', { changes: { assignee: { from: 'A', to: 'B', fromId: 'u1', toId: 'gone' } } }, map);
    expect(d).toEqual({ changes: { assignee: { from: 'A', to: 'B', fromId: 'user:u1', toId: null } } });
    const m = remapActivityData('task.updated', { changes: { assignees: { from: ['A'], to: ['A', 'B'], fromIds: ['u1'], toIds: ['u1', 'gone'] } } }, map);
    expect(m).toEqual({ changes: { assignees: { from: ['A'], to: ['A', 'B'], fromIds: ['user:u1'], toIds: ['user:u1', null] } } });
  });

  test('members and teams', () => {
    expect(remapActivityData('member.role', { userId: 'u1', from: 'member', to: 'admin' }, map)).toEqual({ userId: 'user:u1', from: 'member', to: 'admin' });
    expect(remapActivityData('member.joined', { userId: 'gone', role: 'member', invite: 'abcd' }, map).userId).toBeNull();
    expect(remapActivityData('member.left', { userId: 'u1', accountDeleted: true }, map).userId).toBe('user:u1');
    expect(remapActivityData('member.removed', { userId: 'u1' }, map).userId).toBe('user:u1');
    expect(remapActivityData('team.created', { teamId: 'k1', members: 2 }, map)).toEqual({ teamId: 'team:k1', members: 2 });
    expect(remapActivityData('team.updated', { teamId: 'k1', added: ['x'] }, map).teamId).toBe('team:k1');
    expect(remapActivityData('team.deleted', { teamId: 'k1' }, map).teamId).toBe('team:k1');
  });

  test('project sharing changes', () => {
    const d = remapActivityData(
      'project.access',
      {
        changes: [
          { everyone: { from: 'none', to: 'view' } },
          { member: 'Bob', userId: 'u2', from: null, to: 'edit' },
          { team: '디자인', teamId: 'k1', from: null, to: 'view' },
        ],
      },
      map,
    );
    expect(d.changes).toEqual([
      { everyone: { from: 'none', to: 'view' } },
      { member: 'Bob', userId: 'user:u2', from: null, to: 'edit' },
      { team: '디자인', teamId: 'team:k1', from: null, to: 'view' },
    ]);
  });

  test('unknown shapes pass through and the input is not changed', () => {
    const input = { changes: { title: { from: 'a', to: 'b' } }, tasks: 'inbox', weird: [1, 2] };
    const copy = structuredClone(input);
    expect(remapActivityData('project.deleted', input, map)).toEqual(copy);
    expect(input).toEqual(copy);
    expect(remapActivityData('task.created', {}, map)).toEqual({});
  });
});

describe('describeActivity for migration', () => {
  test('imported, exported and joining a reserved place', () => {
    expect(describeActivity({ action: 'workspace.imported', subject: '', data: { from: 'https://a.example' } })).toBe('다른 서버에서 가져왔어요 · a.example');
    expect(describeActivity({ action: 'workspace.exported', subject: '', data: { to: 'file', secrets: false } })).toBe('파일로 내보냈어요');
    expect(describeActivity({ action: 'workspace.exported', subject: '', data: { to: 'https://b.example', secrets: true } })).toBe('다른 서버로 보냈어요 · b.example');
    expect(describeActivity({ action: 'workspace.exported', subject: '', data: { to: null } })).toBe('다른 서버로 보냈어요');
    expect(describeActivity({ action: 'member.joined', subject: '', data: { role: 'admin', reservation: true } })).toBe('가져온 자리로 합류했어요 · 관리자');
    expect(describeActivity({ action: 'member.joined', subject: '', data: { role: 'member', reservation: true, alreadyMember: true } })).toBe(
      '가져온 자리를 이어받았어요 · 멤버',
    );
    expect(describeActivity({ action: 'member.joined', subject: '', data: { role: 'member', invite: 'abcd' } })).toContain('초대 링크');
  });
});

describe('renumberRef', () => {
  test('moves a leading #number, and nothing else', () => {
    expect(renumberRef('#1 Buy milk', 1, 7)).toBe('#7 Buy milk');
    expect(renumberRef('#1', 1, 7)).toBe('#7');
    expect(renumberRef('#12 Report', 1, 7)).toBe('#12 Report');
    expect(renumberRef('Buy #1 milk', 1, 7)).toBe('Buy #1 milk');
    expect(renumberRef('#3 x', 3, 3)).toBe('#3 x');
  });
});
