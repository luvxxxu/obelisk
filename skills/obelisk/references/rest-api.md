# Obelisk REST API

Base URL: `$OBELISK_URL` (e.g. `{{OBELISK_URL}}`). Auth: `Authorization: Bearer $OBELISK_TOKEN` (a personal `obk_…` token from 설정 → AI 연결). JSON in, JSON out. Errors: `{ "statusCode", "message" }`.

Helper: `scripts/obelisk.sh METHOD PATH [JSON]`.

**Workspaces.** Every account has a personal space and may belong to organizations. Pick one with the `X-Obelisk-Workspace: <workspace id>` header (the helper sends `$OBELISK_WORKSPACE`) or `?workspace=<id or URL-encoded org name>`; without it the account's default workspace is used. Calls on one task or project by uuid always use that task's/project's own workspace. Task numbers (`#12`) are per workspace. The token acts with exactly the account's permissions: 404 for things it can't see, 403 for things it can see but not change.

## Overview

| Method | Path | Notes |
|---|---|---|
| GET | `/api/bootstrap` | user, `today`, workspace (+ your role), workspaces, members, teams, projects (with your `access`), open + recent tasks, dependencies |
| GET | `/api/tasks?view=&projectId=&status=&q=&from=&to=&limit=&assignee=` | `view`: today, upcoming, overdue, inbox, unscheduled, all, done. `projectId=inbox` for no project. `assignee`: `me`, a user id, or `none` |
| GET | `/api/tasks/:ref` | ref = `12`, uuid, or unique title fragment (URL-encode `#` as `%23` or omit it) |
| POST | `/api/tasks` | `{title, notes?, status?, priority?: 0-3, projectId?, startDate?, startTime?, dueDate?, dueTime?, fixed?, estimateMinutes?, assigneeId?, blockedBy?: uuid[]}` — times are `HH:MM` (24h, the user's timezone) and need their date; `estimateMinutes` 1–1440. Tasks carry `actualMinutes` (recorded time) |
| POST | `/api/tasks/bulk` | `{projectId?, tasks: [{key?, title, …, blockedBy?: (key \| "#12" \| uuid)[]}]}` |
| PATCH | `/api/tasks/:id` | any task field; `null` clears dates/times/project/assignee (clearing a date clears its time; a new date keeps the time). `completedAt` (ISO datetime) is used instead of now when the task ends up `done` (an undo restoring the old time); ignored otherwise, a future time counts as now |
| GET | `/api/tasks/:id/activity` | who changed what on this task |
| DELETE | `/api/tasks/:id` | moves it to the trash (휴지통), restorable for 30 days |
| POST | `/api/tasks/delete` | `{ids: uuid[]}` (1–5000) → `{deleted}` — moves them to the trash in one go; one missing or read-only task cancels the whole call |
| POST | `/api/tasks/reorder` | `{changes: [{taskId, position, status?, completedAt?}]}` (1–500) — manual board order (lower first), atomic; `completedAt` as in PATCH |
| POST | `/api/tasks/:id/dependencies` | `{dependsOnId}` — `:id` is blocked by `dependsOnId` |
| DELETE | `/api/tasks/:id/dependencies/:dependsOnId` | |
| POST | `/api/impact/simulate` | `{taskId, days}` or `{taskId, toDate}` → `{task, days, report}` (read-only) |
| POST | `/api/impact/postpone` | `{taskId, days \| toDate, cascade: true}` → `{updated, report}` |
| GET | `/api/impact/forecast` | `{today, report}` |
| GET | `/api/impact/leverage` | bottlenecks |
| GET | `/api/projects` | `?archived=true` to include archived |
| POST | `/api/projects` | `{name, color?}` colors: slate red orange amber green teal blue indigo violet pink |
| PATCH | `/api/projects/:id` | `{name?, color?, archived?}` |
| DELETE | `/api/projects/:id?deleteTasks=false` | tasks move to inbox unless `deleteTasks=true`, which moves them to the trash (needs manage) |
| GET | `/api/trash` | `{items: [{task, dependencies, deletedAt, deletedBy, deletedByName, purgeAt, canRestore}]}`, newest first, only what you can see. `task.projectId` is where a restore lands (`null` = inbox, e.g. the project was deleted); `purgeAt` = deleted + 30 days |
| POST | `/api/trash/restore` | `{ids}` (1–5000) → `{tasks, dependencies, missing}` — same id, number and dates; links come back where the other task still exists, or once it is restored too. An organization inbox task restored by someone who could not see it there (its deleter) is assigned to them. Needs edit where the task lands (403 for the whole call otherwise); 404 when none of the ids is in the trash |
| POST | `/api/trash/purge` | `{ids}` (1–5000) → `{purged}` — deletes those for good (same right as restoring) |
| POST | `/api/trash/empty` | → `{purged}` — deletes for good everything in the trash you may restore |
| GET | `/api/projects/:id/access` | member access, grants to people and teams, everyone's effective level |
| GET | `/api/workspaces` | your workspaces with your role |
| GET | `/api/workspaces/:id` | workspace, members, teams |
| GET | `/api/workspaces/:id/activity?before=&limit=&projectId=&actorId=` | activity you may see (admins: everything but others' private tasks) |

### Time: estimates, tracking, day plans, odds

| Method | Path | Notes |
|---|---|---|
| PUT | `/api/auth/me/work-hours` | `{days: [0-6], start, end, breaks: [{start,end}], focus: 0.1-1 \| null, defaultEstimate: minutes \| null}` (null = learn it) |
| GET | `/api/time/running` | `{running: {entry, task} \| null}` — one clock per person, across spaces |
| POST | `/api/time/timer` | `{taskId, action: "start" \| "stop"}` → `{running, task}`; starting puts a to-do task in progress and stops any other clock |
| GET | `/api/tasks/:id/time` | `{entries: [{id, userId, userName, source: auto \| timer \| manual, startedAt, endedAt, minutes, mine}]}` |
| POST | `/api/time/entries` | `{taskId, minutes, date?}` → `{task}` (time done earlier) |
| DELETE | `/api/time/entries/:id` | your own entries only → `{task}` |
| PUT | `/api/tasks/:id/actual` | `{minutes}` → your time on the task becomes exactly this |
| GET | `/api/plan/day/:date` | `date` = `YYYY-MM-DD` or `today` → `{blocks, events, pending: [{taskId, minutes, reason}], late, capacity, planned, needed, tasks, projects, running, hours}` across all your spaces |
| POST | `/api/plan/day/:date/auto` | `{fillAhead?, apply?}` → `{plan: {blocks: [{taskId, start, end, locked, kept}], unplaced, late, …}, tasks, view}` (`apply: true` saves; locked and past blocks stay) |
| DELETE | `/api/plan/day/:date?unlocked=true` | clear the day (or only planner-placed blocks) |
| GET / POST | `/api/plan/blocks?from=&to=` / `/api/plan/blocks` | list a range / place one `{taskId, date, start, end}` (locked) |
| PATCH / DELETE | `/api/plan/blocks/:id` | `{date?, start?, end?, locked?}` (moving locks it) |
| GET | `/api/odds` | `{today, report: {tasks: [{taskId, onTime, conflict, p50, p85, p95}], projects: [{projectId, tasks, p50, p85, p95}], overall}, calibration, external}` for the open space |
| POST | `/api/odds/commit` | `{taskId? \| title?, estimateMinutes?, projectId?, assigneeId?, blockedBy?, startDate?, date?, confidence?}` → `{report: {safe, earliest, proposed: {date, probability, harmed: [{taskId, kind, before, after}]}, natural, days}, minutes, estimated}` |
| GET | `/api/odds/calibration` | what the odds learned from your history |

### Jev hints (needs the user's own Jev key — TypeSafe or any System One service — set in the web app)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/jev/settings` | `{jev: {connected, hint, autoApply}}` |
| POST | `/api/jev/priorities` | `{taskIds?}` → `{today, model, suggestions: [{taskId, current, suggested, score, confidence, reasons}], focus: {taskId, reasons} \| null}` (read-only) |
| POST | `/api/jev/postpone` | `{scope: "today" \| "week", capacity?}` → `{plan: {capacity, overloaded, days, candidates: [{taskId, verdict: postpone \| could \| keep \| fixed, toDate, shiftDays, delayed, reasons}]}}` (read-only; apply with `/api/impact/postpone`) |
| POST | `/api/jev/triage` | `{title, notes?, startDate?, dueDate?, projectId?}` → `{suggestion: {project?, priority, fixed}}` for a task about to be created |
| POST | `/api/jev/dependencies` | `{taskId}` → `{blockedBy: [{taskId, probability}], blocks: […]}` (read-only) |

Setting or removing the key (`PUT /api/jev/settings`) is web-session only. Without a key these return 400 with `code: "jev_not_connected"`.

Sharing a project (`PUT /api/projects/:id/access`), moving it between workspaces, invites, roles, teams and moving a space to another server (`/api/migration/*`) are web-session only — tokens get 403.

Moving to another server: API tokens are not moved (make new ones on the new server), incoming webhooks get new URLs there, and organization members other than the importer wait in 가입 대기 (`/api/workspaces/:id/reservations`) until they open their claim link (`/invite/obr_…`); an account with the same email is not let in without it.

Access levels: `view` (read), `edit` (create/change/delete tasks and links, restore them from the trash), `manage` (also rename, archive, delete, share). Roles: `owner`, `admin` (manage every project, members, teams), `member`.

Priority numbers: 0 none, 1 low, 2 medium, 3 high.

## Report shape (simulate / postpone / forecast)

```json
{
  "rootIds": ["…"],
  "impacts": [
    { "taskId": "…", "number": 2, "title": "개발", "kind": "shifted", "shiftDays": 2,
      "overrunDays": 0, "slackDays": null,
      "from": {"startDate": "2026-11-18", "dueDate": "2026-11-20"},
      "to":   {"startDate": "2026-11-20", "dueDate": "2026-11-22"},
      "depth": 1, "viaId": "…" }
  ],
  "summary": { "delayedCount": 1, "conflictCount": 0, "absorbedCount": 1, "unscheduledCount": 0,
               "maxShiftDays": 2, "projectSlips": [], "finishFrom": "…", "finishTo": "…" }
}
```

## Examples

```bash
# Today
scripts/obelisk.sh GET '/api/tasks?view=today'

# Capture
scripts/obelisk.sh POST /api/tasks '{"title":"견적서 보내기","dueDate":"2026-11-20","priority":3}'

# What if #4 slips 3 days?
ID=$(scripts/obelisk.sh GET /api/tasks/4 | jq -r .task.id)
scripts/obelisk.sh POST /api/impact/simulate "{\"taskId\":\"$ID\",\"days\":3}" | jq .report.summary
```
