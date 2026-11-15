# Presenting Obelisk data

Obelisk's house style is Linear-like: dense, calm, one line per task, colour (or bold) only where it means something. Use it everywhere you show tasks, whatever the client.

## 1. When the app shows Obelisk cards

Claude (web, desktop) and ChatGPT render most Obelisk tool results as an interactive card — a task list, a task card, a delay-impact timeline, bottlenecks or projects. You can tell because the server's instructions say so ("this app shows Obelisk cards"), or because the user refers to the card.

- **Don't repeat the card.** No list or table of what it already shows.
- Reply in 1–2 short sentences: the insight (the one thing to do first, the risk, the trade-off) plus at most one question.
- Name a task only when you single it out: "#12 기획서 초안".
- The user can tick tasks done and apply a simulated postponement in the card. You'll be told when they do; don't redo it.

> 오늘은 #12 기획서 초안부터 끝내는 게 좋겠어요. 이게 하루 더 밀리면 금요일 출시 발표(#14)와 충돌합니다. 나머지 두 개는 오후에 해도 괜찮아요.

## 2. Plain markdown (Claude Code, Codex, REST, no cards)

Tool results already come back in this format. Reuse those lines as they are; trim to what matters, keep the order, translate labels if the user isn't writing in Korean.

### Glyphs

| Glyph | Meaning |
|---|---|
| `○` | 할 일 (todo) |
| `◐` | 진행 중 (doing) |
| `✓` | 완료 (done) |
| `✕` | 취소 (canceled) |
| `🔒 고정` | fixed date, never moves |
| `↻ 2회 미룸` | postponed twice or more |
| **bold** | overdue counts, conflicts, zero slack — nothing else |

### Task line

```
◐ `#12` 기획서 초안 · 높음 · 런칭 · 11/18 (수) – 11/20 (금)
○ `#13` 개발 · 런칭 · 금요일
○ `#9` 견적서 회신 · 11월 12일 · **2일 지남** · ↻ 3회 미룸
```

Order of meta: priority (only if not none) · project · date · overdue · fixed · postponed. Dates: "오늘", "내일", "금요일" within a week, otherwise "11월 20일 (목)"; ranges as "11/18 (수) – 11/20 (금)".

### Today / overview

```
### 오늘 · 11월 14일 토요일
오늘 할 일 **3** · 기한 지남 **1** · 다가오는 7일 **2** · 밀리는 일정 0

**기한 지남** · 1
- ○ `#9` 견적서 회신 · 11월 12일 · **2일 지남**

**오늘** · 3
- ◐ `#7` 요구사항 정리 · 높음 · 11/7 (토) – 11/16 (월)
- ○ `#8` 설계 문서 작성 · 보통 · 내일

**월요일 · 11/16 (월)** · 1
- ○ `#13` 레거시 스크립트 정리 · 높음 · 11/16 (월) – 11/19 (목)
```

One summary line of counts first, then day groups — 기한 지남, 오늘, 내일, 요일 for the coming week, 나중에, 날짜 없음 — and inside each day the most important first (priority, then in progress, then the earlier deadline). Each task appears once. Groups are bold labels with a count, not headings; skip empty ones. Show the project only when the list mixes projects.

### Delay impact (simulate / postpone / forecast)

```
### 지연 시뮬레이션 · `#12` 기획서 초안 +3일
#12 기획서 초안을 3일 미루면 작업 2개가 최대 3일 밀리고, 고정 일정 1개와 충돌합니다.

| | 작업 | 일정 | 영향 |
|---|---|---|---|
| ● | `#12` 기획서 초안 | 11/20 (금) → 11/23 (월) | 미룸 +3일 |
| ↘ | `#13` 개발 | 11/21 – 11/25 → 11/24 – 11/28 | **+3일** 밀림 (`#12` 때문) |
| ⚠ | `#14` 출시 발표 | 11/27 (금) | ⚠️ **충돌 · 1일 초과** |
| ✓ | `#15` 문서 | 11/30 (월) | 흡수 · 여유 1일 남음 |

**프로젝트 완료일** — 런칭 11/27 (금) → 11/30 (월) (+3일)
```

Then ask one question: move everything (cascade) or only this task? If a fixed date conflicts, offer the alternatives (smaller delay, descoping, moving the fixed date).

### Task detail

```
### `#12` 기획서 초안
◐ 진행 중 · 우선순위 높음 · 런칭 · 11/18 (수) – 11/20 (금) · ↻ 2회 미룸

> 메모 첫 줄
> 메모 둘째 줄

**선행 작업** — ✓ `#10` 리서치
**후속 작업** — ○ `#13` 개발, ○ `#14` 출시 발표
```

### Confirmations

One line, no heading: `✓ \`#12\` 기획서 초안 — 완료했습니다.` Add "이제 시작할 수 있는 작업 — …" when completing unblocked something.

## Don'ts

- No emoji per task, no colour words ("🔴 urgent"), no nested bullet trees.
- Don't invent fields Obelisk doesn't have (assignee, labels, estimates).
- Don't print raw ids, JSON, or ISO dates (`2026-11-20`) to the user.
- Don't paste the whole list when the user asked one question — answer it, then show the few lines that support it.
