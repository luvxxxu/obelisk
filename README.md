# Obelisk

단순하지만 핵심에 강한 할 일·일정 관리 앱. **미루기 전에, 무엇이 함께 밀리는지 먼저 보여줍니다.**

- **단순한 모델** — 작업, 프로젝트, 날짜(시작·마감), 선행 작업, 고정 일정. 그게 전부입니다.
- **지연 파급 예측** — 작업을 미루면 뒤따르는 작업이 며칠씩 밀리는지, 어떤 고정 일정(회의·출시일)과 충돌하는지, 프로젝트 완료일이 어떻게 바뀌는지 즉시 계산합니다. 미루기 메뉴, 상세 패널, 타임라인 드래그 어디에서든 적용 전에 미리 보여줍니다.
- **파급 예측 대시보드** — 기한이 지난 작업은 빨라도 오늘 끝난다는 현실을 일정 전체에 반영해서 "지금 이미 밀리고 있는 일정", 하루만 늦어도 전체가 흔들리는 **핵심 작업**, **자꾸 미뤄지는 작업**을 보여줍니다.
- **자연어 빠른 입력** — `기획서 초안 다음 주 수요일까지 #업무 !높음`, `워크숍 11/20~11/22 @고정`
- **AI 완전 지원** — 모든 기능을 MCP 도구 20개 + 프롬프트 3개로 제공하고(OAuth 2.1 내장), 언제 어떻게 쓸지 알려주는 Agent Skill을 함께 배포합니다. Claude, ChatGPT, Claude Code, Codex에서 바로 연결할 수 있습니다.
- **Dokploy 한 번에 배포** — `docker-compose.yml` 하나로 web + backend + Postgres. 도메인은 web 하나만 연결하면 됩니다.

## 구조

```
obelisk/
├─ packages/core   공용 TypeScript: 타입, zod 스키마, 지연 예측 엔진, 자연어 파서, 뷰 필터
├─ backend         NestJS 12 on Bun — REST API, MCP 서버(/mcp), OAuth 2.1 인가 서버, Postgres(Drizzle)
├─ web             Next.js 16 on Bun — CSS Modules만 사용 (외부 CSS 라이브러리 없음)
├─ skills/obelisk  Agent Skill (SKILL.md + references + REST 헬퍼 스크립트)
└─ docker-compose.yml
```

지연 예측 엔진(`packages/core/src/impact.ts`)은 순수 함수라서 **브라우저에서는 드래그하는 순간 실시간으로**, 서버에서는 REST·MCP 응답용으로 똑같이 실행됩니다. 백엔드로 Bun + NestJS를 고른 가장 큰 이유입니다.

```
브라우저 ──► web:3000 ──┬─ /            Next.js UI
                        ├─ /api/*       ┐
                        ├─ /mcp         ├─► backend:4000 ──► db:5432
                        └─ /.well-known ┘
Claude / ChatGPT ──► https://도메인/mcp  (OAuth: /.well-known → /oauth/authorize → /api/oauth/token)
```

## 로컬 개발

필요: Bun 1.3+, Docker

```bash
bun install
```

```bash
bun run dev:db
```

```bash
printf 'DATABASE_URL=postgres://obelisk:obelisk@localhost:54329/obelisk\nPUBLIC_URL=http://localhost:3000\nSIGNUP_MODE=open\n' > backend/.env
```

```bash
bun run dev
```

http://localhost:3000 에서 가입하면 됩니다. 마이그레이션은 백엔드가 시작할 때 자동 적용됩니다.

데모 데이터(런칭 프로젝트, 의존 관계, 기한 지난 작업 포함):

```bash
bun backend/scripts/seed-demo.ts http://localhost:3000
```

로그인: `demo@obelisk.test` / `obelisk-demo-1234`

테스트:

```bash
bun test packages
```

```bash
bun backend/scripts/smoke.ts http://localhost:3000
```

`smoke.ts`는 가입 → 작업/의존성 → 시뮬레이션·연쇄 미루기 → MCP 도구 호출(API 토큰) → OAuth 동적 등록·PKCE·토큰 교환·갱신 → Skill zip까지 실제 서버를 상대로 확인합니다 (`SIGNUP_MODE=open` 필요).

## Dokploy 배포

1. 이 저장소를 GitHub 등에 push 합니다.
2. Dokploy → 프로젝트 → **Create Service → Compose**, Provider로 저장소를 연결하고 Compose Path는 `./docker-compose.yml`.
3. **Environment** 탭에 입력:
   ```
   PUBLIC_URL=https://obelisk.example.com
   POSTGRES_PASSWORD=영문과숫자로된긴비밀번호
   SIGNUP_MODE=first
   ```
4. **Domains** 탭 → Add Domain → Service `web`, Port `3000`, Host `obelisk.example.com`, HTTPS 켜기(Let's Encrypt).
5. **Deploy**. 첫 접속에서 가입한 계정이 주인이 됩니다 (`SIGNUP_MODE=first`이면 이후 가입은 막힙니다).

> `PUBLIC_URL`은 반드시 실제로 접속하는 https 주소와 같아야 합니다. OAuth 메타데이터와 MCP 리소스 주소가 이 값으로 만들어집니다. 다르면 설정 → AI 연결 화면에 경고가 표시됩니다.

데이터는 `obelisk-db` 볼륨에 저장됩니다. 백업은 Dokploy의 Volume Backups 또는 `pg_dump`를 사용하세요.

### 환경 변수

| 변수 | 서비스 | 설명 |
|---|---|---|
| `PUBLIC_URL` | backend | 외부에서 접속하는 주소 (필수) |
| `POSTGRES_PASSWORD` | db, backend | DB 비밀번호 (필수, URL에 들어가므로 영문·숫자 권장) |
| `SIGNUP_MODE` | backend | `first`(기본) · `open` · `closed` |
| `BACKEND_URL` | web (빌드 인자) | web이 API를 찾는 내부 주소, 기본 `http://backend:4000` |

## AI 연결

MCP 주소: `https://도메인/mcp` (Streamable HTTP, stateless). 앱의 **설정 → AI 연결**에 클라이언트별 안내, 토큰 발급, 연결된 앱 관리가 모두 있습니다.

| 클라이언트 | 방법 |
|---|---|
| Claude (웹·데스크톱) | Customize → Connectors → Add → Add custom connector → URL 입력, 인증은 Detected 그대로 → Connect → Obelisk 승인 화면에서 허용 (Team·Enterprise는 Owner가 Organization settings → Connectors에서 추가) |
| ChatGPT | Plugins → + → Add custom MCP server → URL, 인증 OAuth → Create as a plugin → 설치 후 **Work** 탭 새 대화에서 `@Obelisk` (Codex에 추가한 MCP는 ChatGPT 대화와 공유되지 않음) |
| Claude Code | `claude mcp add --transport http obelisk https://도메인/mcp` 후 `/mcp`에서 로그인 |
| Codex | `~/.codex/config.toml`에 `url` + `bearer_token_env_var = "OBELISK_TOKEN"` |
| 기타 | OAuth 2.1(DCR+PKCE) 또는 `Authorization: Bearer obk_…` 헤더 |

**Agent Skill**: 앱에서 `obelisk-skill.zip`을 받으면 서버 주소가 미리 채워져 있습니다. Claude는 설정 → 기능 → Skills에 업로드, Claude Code는 `~/.claude/skills/obelisk`, Codex는 `~/.codex/skills/obelisk`에 풉니다.

### MCP 도구

| 분류 | 도구 |
|---|---|
| 읽기 | `get_overview`, `list_tasks`, `get_task`, `list_projects`, `search`, `fetch` |
| 쓰기 | `create_task`, `create_tasks`(키·의존성 포함 일괄 계획), `update_task`, `complete_task`, `delete_task`, `add_dependency`, `remove_dependency`, `create_project`, `update_project`, `delete_project` |
| 지연 예측 | `simulate_delay`, `postpone_task`(cascade), `get_forecast`, `get_bottlenecks` |
| 프롬프트 | `plan_my_day`, `break_down_goal`, `weekly_review` |

모든 도구에 `readOnlyHint` / `destructiveHint` 등 annotation이 붙어 있어 클라이언트가 확인 절차를 알맞게 적용합니다. `search`/`fetch`는 ChatGPT 커넥터·딥 리서치 규격을 따릅니다.

### 대화 안의 카드 (MCP Apps)

Claude와 ChatGPT에서는 읽기·계획 도구 12개의 결과가 대화 안에 **Linear 스타일 카드**로 표시됩니다. 작업 목록, 작업 상세, 지연 파급 타임라인, 병목, 프로젝트 카드가 있고, 카드에서 바로 완료 체크와 시뮬레이션한 미루기 적용을 할 수 있습니다(모델에게도 알려집니다). 카드는 외부 리소스 없는 단일 HTML(`backend/src/ai/widget/`)이고, URI에 내용 해시가 들어가서 배포하면 클라이언트 캐시가 자동으로 갱신됩니다.

카드를 못 띄우는 클라이언트(Claude Code, Codex)도 같은 스타일의 마크다운(`○ \`#12\` 제목 · 런칭 · 금요일`)을 받습니다. 서버는 `initialize` 때 클라이언트가 MCP Apps를 지원하는지 보고, 카드 내용을 반복하지 말지 또는 마크다운을 그대로 쓸지 모델 지침을 고릅니다.

카드 개발용 로컬 호스트(실제 데이터를 바꾸니 데모 계정에서 쓰세요):

```bash
bun backend/scripts/preview-cards.ts http://localhost:3000
```

### OAuth

- RFC 8414 / 9728 메타데이터: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]`
- RFC 7591 동적 클라이언트 등록 + Client ID Metadata Document(https URL client_id)
- Authorization Code + PKCE(S256만), 1시간 access token, 90일 회전식 refresh token
- 토큰·코드는 모두 SHA-256 해시로만 저장

## 지연 예측 모델

- 작업은 `[시작일, 마감일]`을 차지합니다. 마감일만 있으면 하루짜리 작업입니다.
- 선행 작업은 finish-to-start: B는 A의 마감일 당일부터 시작할 수 있습니다.
- A가 늦어지면 B는 **새로 생기는 겹침만큼만** 밀립니다. 사이의 여유는 먼저 흡수되고(흡수됨), 원래 어긋나 있던 일정은 더 나빠지지 않습니다.
- 밀리는 작업은 기간을 유지한 채 이동합니다. 여러 선행 작업이 있으면 가장 늦은 쪽이 기준입니다.
- **고정 일정은 절대 움직이지 않고** 충돌로 보고되며, 파급은 거기서 멈춥니다.
- 완료·취소된 작업은 제약이 되지 않고, 날짜 없는 작업은 지연을 그대로 다음 작업에 전달합니다.

자세한 설명과 예시: [skills/obelisk/references/delay-model.md](skills/obelisk/references/delay-model.md)

## 키보드 단축키

`N` 새 작업 · `⌘K` / `/` 검색·명령 · `J`/`K` 이동 · `Enter` 열기 · `X` 완료 · `Esc` 닫기 · `G` → `T`/`U`/`I`/`F` 오늘/예정/인박스/파급 예측 · `?` 도움말
