---
name: obelisk
description: Manage the user's Obelisk to-do list and schedule — capture, update, complete and postpone tasks, plan projects as ordered task chains with dependencies, and predict which other tasks and fixed deadlines slip when something is delayed. Use whenever the user talks about their tasks, to-dos, deadlines, schedule, plans or Obelisk, or asks things like "what should I do today?", "what happens if I push X to next week?", "plan this project for me", "할 일", "일정", "미루면".
---

# Obelisk

Obelisk is the user's task and schedule planner — for themselves and for the organizations they belong to. It is deliberately simple — tasks, projects, dates, dependencies — and has one signature feature: **delay impact prediction** (if this slips, what else slips?).

Server: `{{OBELISK_URL}}`

## How to reach Obelisk

1. **MCP tools (preferred).** If tools such as `get_overview`, `create_task`, `simulate_delay` are available, use them. They are the Obelisk MCP server at `{{OBELISK_URL}}/mcp`.
2. **REST fallback.** If no Obelisk tools are available but you can run shell commands, use the REST API with a personal token (the user creates one in Obelisk → 설정 → AI 연결):
   ```bash
   export OBELISK_URL="{{OBELISK_URL}}" OBELISK_TOKEN="obk_..."
   scripts/obelisk.sh GET /api/tasks?view=today
   ```
   See [references/rest-api.md](references/rest-api.md) for every endpoint.
3. Neither available → tell the user how to connect (Claude: Customize → Connectors → Add → Add custom connector → `{{OBELISK_URL}}/mcp`, keep the Detected sign-in settings, then Connect — on Team/Enterprise an Owner adds it under Organization settings → Connectors; ChatGPT: Plugins → + → Add custom MCP server → same URL, OAuth → Create as a plugin, then use it with @Obelisk in a Work chat; an MCP server added in Codex is not shared with ChatGPT chat).

## Core concepts

| Concept | Meaning |
|---|---|
| Workspace | The user's **personal space** plus any **organizations** they belong to (`list_workspaces`). Every tool takes an optional `workspace` (name or id); without it the user's default workspace is used. |
| Ref `#12` | Short task number, **per workspace**. Always show tasks to the user as `#12 Title`. Tools accept `#12`, `12`, an id, or a unique title fragment — within the workspace you are working in. |
| Access | In an organization the user sees only projects shared with them, at **view < edit < manage**. Tasks marked `readOnly` can't be changed. Owners/admins manage every project. A project-less task in an org is private to its creator and assignee. |
| Assignee | Who does a task (`assignee`: `"me"`, a member's name or email). `list_members` lists who can be assigned; they must be able to see the task's project. |
| Status | `todo`, `doing`, `done`, `canceled` |
| Priority | `none`, `low`, `medium`, `high` |
| Dates | `startDate` / `dueDate` as `YYYY-MM-DD` in the user's timezone. Only a due date = one-day task. Get "today" from `get_overview` — never assume it. |
| Times | Optional `startTime` / `dueTime` as `HH:MM` (24h, same timezone) on those dates: "3pm meeting" → `dueDate` + `dueTime: "15:00"`, a slot → `startTime`–`dueTime` on one day. Leave them out for all-day work. A time needs its date; clearing a date clears its time; postponing keeps it. Delay prediction still counts whole days, but a due time that has passed today already counts as overdue. |
| Blocked by | Finish-to-start dependency: a task can't start before its blockers are due. |
| Fixed | Immovable commitment (meeting, launch, hard deadline). Never shifts; a delay reaching it is a **conflict**. |

How delays propagate (needed to explain predictions): [references/delay-model.md](references/delay-model.md).

## Workflows

### Organizations and permissions
- Not sure where to work? `list_workspaces`. Say which workspace you used when the user has more than one ("에이컴퍼니에서 …").
- "My tasks" in an org → `list_tasks` with `assignee: "me"`. Delegating → `update_task` with `assignee`.
- A permission error means the user's account may not do that (e.g. a view-only project). Tell them who can grant access — a project manager or an org owner/admin — and stop; don't route around it (e.g. by recreating the task elsewhere).
- Sharing projects, inviting people, roles and teams are managed in the web app (조직 설정 / 프로젝트 → 공유), not through tools.
- Moving a personal space or an organization to another Obelisk server (export file or 이전 링크, then import) is done in the web app (설정 → 데이터 이전), not through tools.
- "Who changed this?" → `get_activity` with a task or project. Changes you make are logged as coming through this AI app.

### "What should I do today?"
1. `get_overview`.
2. Answer with: overdue items first (with a suggestion each), then today's tasks ordered by priority, then anything in `delayRisk`. Keep it to a short list.

### Capturing tasks
- One task → `create_task`. Several or a plan → `create_tasks` in a single call.
- Translate natural dates yourself ("next Friday" → `YYYY-MM-DD`, relative to `today`).
- Use an existing project when one obviously fits (`list_projects`); don't invent projects unprompted.
- Mark meetings, events and external deadlines as `fixed: true`.

### Postponing (the important one)
1. If the task blocks anything (`get_task` → `blocks` non-empty) **always** run `simulate_delay` first. In an org, a cascade that would move a task the user can only view is refused — offer `cascade: false` or asking that task's project manager.
2. Tell the user plainly: which tasks move and by how much, which fixed dates break (conflicts), how project finish dates move, and which tasks absorb the delay with slack.
3. Ask: move everything (`postpone_task` with `cascade: true`, default) or only this task (`cascade: false`)?
4. If a fixed date conflicts, offer alternatives: a smaller delay, dropping/descoping a downstream task, or moving the fixed date itself.

Never move a due date later with `update_task` when the task has dependents — it leaves dependents starting before their blocker finishes. Use `postpone_task`.

### Too much to do — priorities and what to postpone (Jev)
If the user connected their own Jev key (Obelisk → 설정 → Jev — TypeSafe, OpenRouter, Cloudflare's Clef or another System One server), three read-only tools add a second opinion from **Jev**, TypeSafe's decision model (or the compatible model they chose). Jev judges what each task means (what is at stake, whether it can wait, whether someone is waiting); Obelisk's delay engine still does every date and ripple calculation.
- "What first?" / "re-prioritize" → `suggest_priorities`: suggested priority per task with reasons and confidence, plus the one task to start now. Apply the ones the user accepts with `update_task`.
- "Too much today/this week" / "what can I push?" → `suggest_postpone` (`scope: today | week`): the tasks that can safely wait and the lighter day for each — already checked to break no fixed date. Apply each accepted move with `postpone_task` (`toDate`, `cascade: true`).
- After `create_tasks` or for a task with no links → `suggest_dependencies`: likely "must finish first" / "waits for this" links; add accepted ones with `add_dependency`. More links make delay prediction better.
- A "Jev가 연결되어 있지 않아요" error means no key: tell the user where to add it, then continue with your own judgment.

### Planning a goal / project
1. `get_overview` for today's date and current load.
2. Propose 3–12 concrete tasks with dates and `blockedBy` links (give each a `key`). Show the plan briefly and get confirmation.
3. Create everything with one `create_tasks` call. Then run `get_bottlenecks` and point out the critical tasks (zero slack).

### Risk check / weekly review
- `get_forecast`: what is already slipping because overdue tasks can only finish today.
- `get_bottlenecks`: tasks with the most downstream work and least slack.
- `list_tasks view=done` for wins. Tasks with `postponedCount ≥ 2` deserve a conversation (split, delegate, drop?).

## Presentation

Obelisk looks like Linear: one dense line per task, refs as `#12`, colour or bold only for meaning. Full templates: [references/formatting.md](references/formatting.md).

- **Claude / ChatGPT with the MCP connector** show most results as an interactive Obelisk card (task list, task card, delay timeline, bottlenecks, projects). Don't repeat the card — reply in 1–2 sentences with the insight and at most one question. The user can tick tasks done or apply a postponement in the card; you are told when they do.
- **Anywhere else** (Claude Code, Codex, the REST fallback) tool results already arrive as house-style markdown — reuse those lines rather than inventing a layout:
  ```
  ◐ `#12` 기획서 초안 · 높음 · 런칭 · 11/18 (수) – 11/20 (금)
  ○ `#9` 견적서 회신 · 11월 12일 · **2일 지남** · ↻ 3회 미룸
  ```
  `○` todo · `◐` doing · `✓` done · `✕` canceled · `🔒 고정` fixed · `↻` postponed. Delay impact goes in a table (작업 · 일정 · 영향). With REST JSON, build the same lines yourself.

## Style
- Reply in the user's language. The Obelisk UI is Korean; dates read naturally as "11월 20일 (목)". Never show raw ids, JSON or ISO dates.
- Be brief. Lists over paragraphs. Always include refs (`#12`).
- Confirm before `delete_task`, `delete_project`, or bulk changes. Completing or creating tasks the user explicitly asked for needs no confirmation.
