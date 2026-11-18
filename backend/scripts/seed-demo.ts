/**
 * Seeds a demo account with a realistic plan (dates relative to today).
 *   bun scripts/seed-demo.ts [baseUrl]
 * Demo login: demo@obelisk.test / obelisk-demo-1234
 */
const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = 'demo@obelisk.test';
const PASSWORD = 'obelisk-demo-1234';
let cookie = '';

async function api(method: string, path: string, body?: unknown) {
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
}

const tz = 'Asia/Seoul';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const d = (n: number) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

try {
  await api('POST', '/api/auth/signup', { email: EMAIL, password: PASSWORD, name: '데모', timezone: tz });
} catch {
  await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  const boot = await api('GET', '/api/bootstrap');
  if (boot.tasks.length) {
    console.log('Demo account already has data — skipping.');
    process.exit(0);
  }
}

const launch = (await api('POST', '/api/projects', { name: '제품 런칭', color: 'indigo' })).project.id;
const life = (await api('POST', '/api/projects', { name: '개인', color: 'green' })).project.id;
const blog = (await api('POST', '/api/projects', { name: '블로그', color: 'orange' })).project.id;

await api('POST', '/api/tasks/bulk', {
  projectId: launch,
  tasks: [
    { key: 'req', title: '요구사항 정리', startDate: d(-9), dueDate: d(-6) },
    { key: 'wire', title: '와이어프레임', startDate: d(-5), dueDate: d(-2), priority: 3, blockedBy: ['req'], notes: '핵심 플로우 3개: 온보딩, 작업 추가, 지연 예측' },
    { key: 'design', title: '디자인 시안', startDate: d(-1), dueDate: d(2), priority: 2, blockedBy: ['wire'] },
    { key: 'api', title: 'API 개발', startDate: d(1), dueDate: d(7), blockedBy: ['wire'] },
    { key: 'fe', title: '프론트엔드 개발', startDate: d(2), dueDate: d(8), priority: 2, blockedBy: ['design'] },
    { key: 'qa', title: 'QA · 버그 수정', startDate: d(9), dueDate: d(10), blockedBy: ['fe', 'api'] },
    { key: 'pr', title: '보도자료 작성', dueDate: d(9), blockedBy: ['design'] },
    { key: 'ship', title: '출시 발표', dueDate: d(11), fixed: true, priority: 3, blockedBy: ['qa', 'pr'], notes: '고객사 초청 웨비나 — 날짜 변경 불가' },
  ],
});
await api('POST', '/api/tasks/bulk', {
  projectId: life,
  tasks: [
    { title: '치과 예약 전화', dueDate: d(0), dueTime: '17:00', priority: 2 },
    { title: '주간 회의', startDate: d(1), startTime: '10:00', dueDate: d(1), dueTime: '11:00', fixed: true },
    { title: '30분 달리기', dueDate: d(0), priority: 1 },
    { title: '종합소득세 서류 챙기기', dueDate: d(5), priority: 3 },
    { title: '부모님 선물 고르기', dueDate: d(13) },
  ],
});
await api('POST', '/api/tasks/bulk', {
  projectId: blog,
  tasks: [
    { key: 'draft', title: '“지연 예측” 글 초안', startDate: d(1), dueDate: d(3) },
    { key: 'edit', title: '퇴고 · 이미지', dueDate: d(4), blockedBy: ['draft'] },
    { key: 'post', title: '발행 · 뉴스레터', dueDate: d(5), fixed: true, blockedBy: ['edit'] },
  ],
});
await api('POST', '/api/tasks', { title: '장보기 목록 정리' });
await api('POST', '/api/tasks', { title: '읽을 책 고르기' });

// finish the first task so the logbook isn't empty
const boot = await api('GET', '/api/bootstrap');
const req = boot.tasks.find((t: any) => t.title === '요구사항 정리');
await api('PATCH', `/api/tasks/${req.id}`, { status: 'done' });
const wire = boot.tasks.find((t: any) => t.title === '와이어프레임');
await api('PATCH', `/api/tasks/${wire.id}`, { status: 'doing' });

console.log(`Seeded demo data. Log in at ${BASE}/login with ${EMAIL} / ${PASSWORD}`);
