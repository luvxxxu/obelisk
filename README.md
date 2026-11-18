# Obelisk

단순하지만 핵심에 강한 할 일·일정 관리 앱. **미루기 전에, 무엇이 함께 밀리는지 먼저 보여줍니다.**

- **단순한 모델** — 작업, 프로젝트, 날짜(시작·마감, 필요하면 몇 시 몇 분까지), 선행 작업, 고정 일정. 그게 전부입니다.
- **지연 파급 예측** — 작업을 미루면 뒤따르는 작업이 며칠씩 밀리는지, 어떤 고정 일정(회의·출시일)과 충돌하는지, 프로젝트 완료일이 어떻게 바뀌는지 즉시 계산합니다. 미루기 메뉴, 상세 패널, 타임라인 드래그 어디에서든 적용 전에 미리 보여줍니다.
- **파급 예측 대시보드** — 기한이 지난 작업은 빨라도 오늘 끝난다는 현실을 일정 전체에 반영해서 "지금 이미 밀리고 있는 일정", 하루만 늦어도 전체가 흔들리는 **핵심 작업**, **자꾸 미뤄지는 작업**을 보여줍니다.
- **Jev 판단 보조** — TypeSafe의 판단 모델 Jev(또는 같은 System One API를 쓰는 OpenRouter·Cloudflare Clef 등)를 내 API 키로 연결하면 **우선순위를 자동으로 정하고**, 일이 몰리면 **무엇을 미룰지** 골라 줍니다. 새 작업의 프로젝트·우선순위·고정 여부와 선후 관계도 추천합니다. Jev는 의미만 판단하고 날짜·파급 계산은 지연 예측 엔진이 그대로 맡습니다.
- **자연어 빠른 입력** — `기획서 초안 다음 주 수요일까지 #업무 !높음`, `워크숍 11/20~11/22 @고정`
- **조직** — 개인 공간은 그대로 두고 여러 조직에 참여합니다. 프로젝트마다 멤버·팀별로 **보기 · 쓰기 · 관리** 권한을 나누고, 담당자와 활동 기록, 초대 링크를 지원합니다. 연결한 AI(MCP)도 계정 권한을 그대로 따릅니다.
- **웹훅** — 작업 생성·완료·미룸 같은 변경과 오늘·내일 마감, 기한 지남, 고정 일정 충돌, 시작·마감 N분 전 알림을 Slack·Discord(한국어 메시지)나 서명된 JSON으로 보냅니다. 반대로 비밀 URL 하나로 GitHub Actions·단축어·Zapier·Slack 슬래시 명령에서 작업을 만들거나 완료할 수 있습니다.
- **AI 완전 지원** — 모든 기능을 MCP 도구 26개 + 프롬프트 3개로 제공하고(OAuth 2.1 내장), 언제 어떻게 쓸지 알려주는 Agent Skill을 함께 배포합니다. Claude, ChatGPT, Claude Code, Codex에서 바로 연결할 수 있습니다.
- **Dokploy 한 번에 배포** — `docker-compose.yml` 하나로 web + backend + Postgres + 매일 백업. 도메인은 web 하나만 연결하면 됩니다.

## 구조

```
obelisk/
├─ packages/core   공용 TypeScript: 타입, zod 스키마, 지연 예측 엔진, 자연어 파서, 뷰 필터
├─ backend         NestJS 12 on Bun — REST API, MCP 서버(/mcp), OAuth 2.1 인가 서버, Jev 연동, Postgres(Drizzle)
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

## Jev 판단 보조

[Jev](https://docs.typesafe.ai/introduction)는 TypeSafe의 판단 모델입니다. 글을 생성하지 않고, 상태(작업 설명)와 타입이 정해진 질문을 받아 **확률과 신뢰도가 붙은 답**을 0.2~0.5초 안에 돌려줍니다. Obelisk는 Jev에게 작업마다 작은 질문 세 개만 묻고, 날짜·파급·충돌 계산은 기존 지연 예측 엔진이 그대로 합니다. 둘을 합치는 가중치는 `packages/core/src/jev.ts`에 있고 테스트로 고정돼 있습니다.

| Jev에게 묻는 것 | 형식 |
|---|---|
| 놓치면 무엇을 잃나 (언젠가 · 가벼운 일 · 꼭 해야 하는 일 · 손해가 큰 일) | Score 0–3 |
| 며칠 미뤄도 괜찮은가 | Noul (예/아니오 확률) |
| 다른 사람이 기다리는가 (내 후속 작업은 제외) | Noul |
| 새 작업: 어느 프로젝트인가 · 고정 일정인가 | Choice + Noul |
| 두 작업의 순서: 먼저 · 나중 · 무관 | Choice |

### 기능

| 기능 | 어디서 | 어떻게 정하나 |
|---|---|---|
| **우선순위 자동 판단** | 홈 Jev 추천 → 우선순위 정리, ⌘K | 중요도가 상한을 정하고, 마감 임박도가 그중 얼마를 지금 적용할지 정합니다. 하루 늦으면 다른 작업이 밀리거나 고정 일정과 부딪히는 작업은 가산점. 세 단계로 나눈 뒤 이유와 확신도를 함께 보여줍니다. |
| **지금 할 일 하나** | 홈 Jev 추천 | 오늘 할 일 중 선행 작업이 다 끝나 바로 시작할 수 있는 것 가운데 점수가 가장 높은 작업. 진행 중인 일을 조금 더 우선합니다. |
| **미룰 작업 고르기** | 홈, 오늘 화면, ⌘K | 하루 처리량(최근 14일 완료 페이스, 직접 조정 가능)을 넘는 날에서 ‘미뤄도 괜찮음 × 덜 중요함’ 순으로 고르고, 이미 여러 번 미룬 일·진행 중인 일·남이 기다리는 일은 뒤로 뺍니다. 옮길 날은 엔진으로 시뮬레이션해서 **고정 일정과 충돌하지 않고** 여유가 남는 가장 가까운 날을 고릅니다. 고정 일정과 다른 사람의 작업은 옮기지 않습니다. 적용은 연쇄 미루기로 하고 한 번에 되돌릴 수 있습니다. |
| **새 작업 자동 분류** | 빠른 입력 | 적은 내용에서 빠진 프로젝트·우선순위·고정 여부를 칩으로 추천. `Tab`으로 모두 적용. |
| **선후 관계 찾기** | 작업 상세 → Jev 연결 제안 | 같은 프로젝트에서 ‘먼저 끝나야 할 일’과 ‘이 작업을 기다릴 일’을 찾습니다. 이미 직·간접으로 이어진 작업은 빼고, 다른 프로젝트 작업은 확신 80% 이상일 때만 제안합니다. |
| **MCP 도구** | Claude · ChatGPT · Claude Code | `suggest_priorities`, `suggest_postpone`, `suggest_dependencies` (읽기 전용, 적용은 기존 도구로) |

### 연결과 자동 적용

- **설정 → Jev**에서 각자 서비스와 키를 넣습니다. TypeSafe·OpenRouter·Cloudflare(Workers AI의 Clef, 하루 10,000 뉴런 무료)는 프리셋으로 고르고, 그 밖의 System One 호환 서버는 **Base URL과 모델**을 직접 적습니다(Base URL 끝에 `/systemone`이 없으면 붙입니다). 사용자가 정한 주소는 매 요청마다 https·공개 주소인지 확인하고, 저장된 키는 다른 호스트로 옮겨 가지 않습니다(호스트를 바꾸면 키를 다시 입력). 한 요청의 질문은 Clef 제한에 맞춰 64개 이하로 나눕니다. 저장 전에 키가 동작하는지 한 번 확인하고, 키는 AES-256-GCM으로 봉인해 DB에 둡니다. 봉인 키는 `SECRET_KEY`이고(없으면 DB 비밀번호에서 파생), 값마다 어느 키로 봉인했는지와 주인(사용자)이 함께 묶여 있어서 다른 계정 행에 복사해도 열리지 않습니다. **운영에서는 `SECRET_KEY`를 꼭 설정하세요** — 그래야 DB 덤프와 DB 비밀번호가 함께 새도 키는 안전합니다. 키 설정은 웹 세션에서만 바꿀 수 있습니다.
- **키 교체**: `SECRET_KEY`를 새 값으로 바꾸고 예전 값을 `SECRET_KEY_PREVIOUS`에 넣은 채 재시작하면, 시작할 때 저장된 키를 모두 새 키로 다시 봉인합니다(로그 `[jev] re-sealed …`). 그 뒤에는 `SECRET_KEY_PREVIOUS`를 지워도 됩니다. `SECRET_KEY`를 처음 설정할 때는 예전 값이 필요 없습니다(DB 비밀번호 키에서 자동으로 옮깁니다). 어떤 키로도 열 수 없는 키는 앱에 **다시 입력 필요**로 표시됩니다.
- 기본은 **제안 후 확인**입니다. **확신이 높으면 바로 적용**을 켜면 확신도 80% 이상인 판단만 반영합니다: 새 작업의 프로젝트·우선순위·고정 여부, 그리고 우선순위가 **비어 있는** 작업. 직접 정한 우선순위는 덮어쓰지 않고, 실행 취소한 작업은 다시 건드리지 않습니다. 미루기와 선후 관계 연결은 언제나 확인을 받습니다.
- 전송되는 것: 작업 제목, 메모 앞부분(360자), 날짜, 프로젝트 이름, 연결된 작업 제목. 이메일·멤버 이름은 보내지 않고, 조직에서는 그 사람이 볼 수 있는 작업만 보냅니다.
- 비용: Jev는 입력 토큰만 과금합니다($0.042 / 100만 토큰). 작업 80개를 한 번 판단하는 데 약 2만 토큰(약 $0.001). 같은 날 내용이 바뀌지 않은 작업은 서버에 6시간 캐시해서 다시 묻지 않습니다.

실제 Jev로 판단 품질 테스트(준비한 한국어 예문만 전송):

```bash
TYPESAFE_API_KEY=… OBELISK_LIVE_JEV=1 bun test backend/test/jev.test.ts
```

## 조직과 권한

계정마다 **개인 공간**이 하나 있고(가입 전 데이터도 모두 여기에 있습니다), 원하는 만큼 **조직**을 만들거나 초대받아 참여할 수 있습니다. 사이드바 왼쪽 위에서 공간을 바꿉니다. 작업 번호(`#12`)는 공간마다 따로 매깁니다.

| 역할 | 할 수 있는 일 |
|---|---|
| 소유자 | 관리자 권한 전부 + 소유자 지정·해제, 조직 삭제 (소유자는 최소 한 명) |
| 관리자 | 모든 프로젝트 관리, 멤버 역할·내보내기, 초대 링크, 팀, 전체 활동 기록 |
| 멤버 | 공유받은 프로젝트만. 설정에 따라 새 프로젝트 만들기 |

프로젝트 권한은 **보기 < 쓰기 < 관리** 세 단계입니다. 쓰기는 작업 추가·수정·삭제·연결, 관리는 이름·보관·삭제·공유·다른 공간으로 옮기기까지입니다. 멤버 한 사람의 권한은 `조직 전체 기본값`, `개인에게 준 권한`, `속한 팀에 준 권한` 중 가장 높은 것입니다.

- **새 프로젝트는 비공개**로 시작합니다. 만든 사람이 관리 권한을 갖고 프로젝트 → 공유에서 사람·팀·조직 전체에 권한을 줍니다.
- 조직에서 **프로젝트 없는 작업**은 만든 사람과 담당자만 봅니다(관리자도 못 봅니다).
- **담당자**는 그 프로젝트를 볼 수 있는 멤버만 지정할 수 있습니다. 조직에서는 사이드바에 **내 작업**이 생깁니다.
- 공간이 둘 이상이면 **모아보기**(`G` `O`)가 생깁니다. 개인 공간 작업 전부와 각 조직에서 나에게 배정된 작업을 한 화면에 모아 기한 지남 · 오늘 · 앞으로 7일 · 30일 안의 고정 일정으로 보여주고, 날짜별로 어느 공간의 일이 몰리는지도 보여줍니다. 공간마다 그 공간의 권한 그대로 읽으며, 의존 관계는 공간을 넘지 않으므로 지연 예측은 공간별로 따로 합니다. 홈의 **다른 공간** 위젯은 지금 열지 않은 공간의 요약입니다.
- **볼 수 없는 작업은 존재 자체가 드러나지 않습니다**: 목록·의존 관계·지연 예측·활동 기록에서 빠지고, 직접 요청하면 404입니다. 연쇄 미루기가 보기 전용 작업까지 옮겨야 하면 통째로 거절됩니다(이 작업만 미루기는 가능).
- **초대 링크**는 역할·만료·사용 횟수를 정해 만들고, 링크 자체는 해시로만 저장합니다. 초대 링크로는 `SIGNUP_MODE`가 막혀 있어도 가입할 수 있습니다.
- **활동 기록**은 누가 무엇을 언제 바꿨는지와, AI 앱·API 토큰을 거쳤는지를 남깁니다. 작업 상세에는 그 작업의 기록이, 조직 설정 → 활동에는 볼 수 있는 범위의 전체 기록이 나옵니다.
- 개인 공간 프로젝트를 조직으로(또는 조직 사이로) **옮길 수 있습니다**. 작업 번호는 새로 매겨지고, 남는 작업과의 의존 관계는 끊기며, 공유 설정은 초기화됩니다.

**API·MCP**: 토큰과 OAuth 연결은 계정 권한을 그대로 씁니다. 공간은 `X-Obelisk-Workspace` 헤더(id)나 `?workspace=`로 고르고, 없으면 계정의 기본 공간(설정 → AI 연결 → AI 기본 공간)을 씁니다. 공유 설정, 멤버, 초대, 팀 관리는 웹 로그인 세션에서만 할 수 있어서 AI가 접근 범위를 넓힐 수 없습니다.

## 웹훅

**설정 → 웹훅**에서 지금 열린 공간의 웹훅을 관리합니다. 개인 공간은 본인이, 조직은 소유자·관리자만 다룰 수 있고, 웹 로그인 세션에서만 바꿀 수 있어서 API 토큰이나 AI 앱이 공간의 변경 내용을 다른 주소로 빼돌릴 수 없습니다.

**보내는 웹훅**
- 이벤트를 골라 받습니다: 새 작업 · 완료 · 수정 · 미룸 · 삭제 · 선행 작업, 프로젝트 변경, 멤버·팀·초대(조직), 그리고 일정 알림(오늘 마감 · 내일 마감 · 기한 지남 · 고정 일정 충돌 · 시작 시각 알림 · 마감 시각 알림). 프로젝트 범위를 좁힐 수 있습니다.
- 변경 이벤트는 그 변경과 **같은 트랜잭션**에서 대기열에 들어가므로 취소된 변경은 보내지 않고, 웹훅 쪽 문제로 변경이 실패하지도 않습니다. 일정 알림은 5분마다 확인해서 정한 시각(기본 오전 9시, 만든 사람의 시간대) 이후에 작업마다 하루 한 번 보냅니다. 고정 일정 충돌에는 시작점이 된 늦은 작업이 함께 담깁니다. 마감 시각이 있는 작업은 그 시각이 지나면 당일에도 ‘기한 지남’으로 잡힙니다.
- 시각 알림은 시작·마감 시각이 정해진 작업에만, 정한 시간(정각 · 5분 · 10분 · 15분 · 30분 · 1시간 · 2시간 · 하루 전, 기본 30분) 전에 1분 단위로 확인해서 보냅니다. 페이로드의 `alert.at`(`YYYY-MM-DDTHH:MM`)과 `alert.minutesLeft`로 남은 시간을 알 수 있고, 시각을 바꾸면 새 시각 기준으로 다시 한 번 보냅니다.
- URL이 Slack·Discord면 한국어 메시지로(멘션은 울리지 않음), 그 밖에는 JSON으로 보냅니다. 모든 요청에 `X-Obelisk-Event`, `X-Obelisk-Delivery`, `X-Obelisk-Timestamp`, `X-Obelisk-Signature: sha256=HMAC(서명 키, "<timestamp>.<본문>")`가 붙습니다. 서명 키는 `SECRET_KEY`로 봉인해 저장하고 만들 때 한 번만 보여 줍니다.
- 실패하면 1분 · 5분 · 30분 · 2시간 · 6시간 뒤에 다시 보냅니다(5xx, 408, 429, 연결 오류). 4xx는 바로 실패로 처리하고, 연속 10번 실패하면 웹훅을 자동으로 끕니다. 전달 기록(보낸 본문 · 응답)은 30일 동안 남고 다시 보내기·테스트 보내기를 할 수 있습니다.
- 조직의 인박스(프로젝트 없는) 작업은 비공개라 보내지 않습니다. 운영에서는 내부망·루프백 주소로 보낼 수 없고(SSRF 방지), 리디렉션도 따라가지 않습니다. 사내망 수신기가 필요하면 `WEBHOOK_ALLOW_PRIVATE=true`를 설정하세요.

**받는 웹훅**
- 비밀 URL(`/api/hooks/obh_…`, 해시로만 저장)로 POST하면 **만든 사람의 권한**으로 실행되고 활동 기록에 “웹훅 ‘이름’ 통해”로 남습니다.
- 텍스트: `보고서 초안 내일 오후 3시 !높음 #런칭`(빠른 추가 문법, 둘째 줄부터 메모), `#12 완료`, `#12 시작`, `#12 금요일까지`, `#12 내일 15:30까지`
- JSON: `{"title":"배포 확인","dueDate":"2026-11-20","dueTime":"15:30","priority":"high","project":"런칭","assignee":"me"}` 또는 `{"action":"complete","task":"#12"}`(complete · start · cancel · reopen · update). `dueDate`에 `2026-11-20T15:30`이나 `내일 오후 3시`처럼 시각을 함께 써도 되고, 오프셋이 붙은 시각(`…T06:30:00Z`)은 만든 사람의 시간대로 바꿔 읽습니다. 자정(`T00:00:00`)은 날짜만 있는 것으로 봅니다.
- 새 작업이 들어갈 프로젝트를 정할 수 있고, 그렇게 하면 기존 작업 수정도 그 프로젝트 안으로 제한됩니다. 기존 작업 수정은 웹훅마다 끌 수 있습니다. Obelisk가 보낸 요청은 받지 않아 웹훅끼리 무한히 돌지 않습니다.

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

```bash
bun backend/scripts/org-smoke.ts http://localhost:3000
```

`org-smoke.ts`는 계정 세 개로 조직 권한 전체(초대·비공개 기본값·보기/쓰기/관리·팀·비공개 인박스·담당자·연쇄 미루기 거절·역할·활동 기록·MCP 권한·프로젝트 옮기기·삭제)를 확인합니다.

`smoke.ts`는 가입 → 작업/의존성 → 시뮬레이션·연쇄 미루기 → MCP 도구 호출(API 토큰) → OAuth 동적 등록·PKCE·토큰 교환·갱신 → Skill zip까지 실제 서버를 상대로 확인합니다 (`SIGNUP_MODE=open` 필요).

## Dokploy 배포

**준비**: Dokploy 서버의 공인 IP를 가리키는 도메인 A 레코드(예: `obelisk.example.com → 서버 IP`), 그리고 서버의 80·443 포트가 외부에서 열려 있어야 Let's Encrypt 인증서가 발급됩니다. Claude·ChatGPT 커넥터는 https 주소만 받습니다.

1. Dokploy → 프로젝트 → **Create Service → Compose**
2. **General** 탭: Provider는 GitHub, 저장소 `obelisk`, 브랜치 `main`, Compose Path `./docker-compose.yml` → Save
3. **Environment** 탭:
   ```
   PUBLIC_URL=https://obelisk.example.com
   POSTGRES_PASSWORD=영문과숫자로된긴비밀번호
   SIGNUP_MODE=first
   ```
   비밀번호는 `openssl rand -hex 24`로 만들면 됩니다. 한 번 정한 뒤에는 바꾸지 마세요(DB 볼륨이 첫 비밀번호로 초기화됩니다).
4. **Domains** 탭 → Add Domain → Service `web`, Host `obelisk.example.com`, Path `/`, Container Port `3000`, HTTPS 켜기, Certificate `Let's Encrypt`
5. **Deploy**. 끝나면 바로 접속해서 가입하세요. 첫 계정이 주인이 되고 `SIGNUP_MODE=first`이면 그 뒤 가입은 막힙니다.
6. (선택) General 탭의 **Autodeploy**를 켜면 `main`에 push할 때마다 다시 배포됩니다.

> `PUBLIC_URL`은 반드시 실제로 접속하는 https 주소와 같아야 합니다. OAuth 메타데이터와 MCP 리소스 주소, 세션 쿠키의 Secure 속성이 이 값으로 정해집니다. 다르면 설정 → AI 연결 화면에 경고가 표시되고, 백엔드 로그에도 `WARNING`이 찍힙니다.

배포 구성:

| 서비스 | 역할 | 외부 노출 |
|---|---|---|
| `web` | Next.js UI + `/api`·`/mcp`·`/.well-known` 프록시 | 도메인(Traefik)만 |
| `backend` | NestJS API, 시작할 때 마이그레이션 자동 적용, `/api/health`가 DB까지 확인 | 없음 |
| `db` | Postgres 17, 데이터는 `obelisk-db` 볼륨 | 없음 |
| `backup` | 매일(그리고 배포할 때마다) `pg_dump`를 `obelisk-backups` 볼륨에 저장, 14일 보관 | 없음 |

모든 컨테이너는 로그를 10MB × 3개까지만 남겨서 디스크가 차지 않습니다.

### 백업과 복구

백업 파일은 `obelisk-backups` 볼륨에 `obelisk-YYYYMMDD-HHMMSS.dump`(pg_dump custom 형식)로 쌓입니다. 서버 밖에도 보관하려면 Dokploy의 **Volume Backups**에서 이 볼륨을 S3 대상으로 예약하세요.

목록 보기와 복구(Dokploy → 서비스 → Logs 옆 터미널, 또는 서버에서 `docker exec -it <backup 컨테이너> sh`):

```bash
ls -lh /backups
```

```bash
pg_restore --clean --if-exists -d obelisk /backups/obelisk-20261115-030000.dump
```

복구 중에는 Dokploy에서 `web`·`backend`를 잠시 멈추는 것이 안전합니다.

### 업데이트

`main`에 push하고 Dokploy에서 **Deploy**(Autodeploy를 켰다면 자동). 새 마이그레이션은 백엔드가 시작할 때 적용되고, 배포 직전 상태는 `backup` 서비스가 다시 시작하면서 자동으로 덤프합니다.

### 환경 변수

| 변수 | 서비스 | 설명 |
|---|---|---|
| `PUBLIC_URL` | backend | 외부에서 접속하는 https 주소 (필수) |
| `POSTGRES_PASSWORD` | db, backend, backup | DB 비밀번호 (필수, URL에 들어가므로 영문·숫자만) |
| `SIGNUP_MODE` | backend | `first`(기본) · `open` · `closed` |
| `BACKUP_KEEP_DAYS` | backup | 백업 보관 일수, 기본 `14` |
| `BACKEND_URL` | web (빌드 인자) | web이 API를 찾는 내부 주소, 기본 `http://backend:4000` |
| `SECRET_KEY` | backend | (권장) 사용자 Jev 키를 봉인하는 비밀값, `openssl rand -base64 32`. 없으면 DB 비밀번호에서 파생하고 시작할 때 경고합니다 |
| `SECRET_KEY_PREVIOUS` | backend | (선택) `SECRET_KEY`를 바꿀 때 예전 값(쉼표로 여러 개). 한 번 시작해 다시 봉인되면 지워도 됩니다 |
| `JEV_MODEL` | backend | (선택) TypeSafe 기본 모델, 기본 `jev-latest` (사용자가 모델을 정하면 그쪽이 우선) |
| `JEV_ALLOW_PRIVATE` | backend | (선택) `true`면 사용자 Jev Base URL로 내부망·http 주소도 허용(자체 서버 테스트용). 운영 기본은 꺼짐 |

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
| 읽기 | `get_overview`, `list_tasks`(`assignee` 필터), `get_task`, `list_projects`, `search`, `fetch` |
| 조직 | `list_workspaces`, `list_members`, `get_activity` — 모든 도구에 선택 인자 `workspace` |
| 쓰기 | `create_task`, `create_tasks`(키·의존성 포함 일괄 계획), `update_task`(담당자 포함), `complete_task`, `delete_task`, `add_dependency`, `remove_dependency`, `create_project`, `update_project`, `delete_project` |
| 지연 예측 | `simulate_delay`, `postpone_task`(cascade), `get_forecast`, `get_bottlenecks` |
| Jev 판단 | `suggest_priorities`, `suggest_postpone`, `suggest_dependencies` — 사용자가 Jev 키를 연결했을 때 |
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
