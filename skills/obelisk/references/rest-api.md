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
| POST | `/api/tasks` | `{title, notes?, status?, priority?: 0-3, projectId?, startDate?, dueDate?, fixed?, assigneeId?, blockedBy?: uuid[]}` |
| POST | `/api/tasks/bulk` | `{projectId?, tasks: [{key?, title, …, blockedBy?: (key \| "#12" \| uuid)[]}]}` |
| PATCH | `/api/tasks/:id` | any task field; `null` clears dates/project/assignee |
| GET | `/api/tasks/:id/activity` | who changed what on this task |
| DELETE | `/api/tasks/:id` | |
| POST | `/api/tasks/reorder` | `{changes: [{taskId, position, status?}]}` — manual board order (lower first), atomic |
| POST | `/api/tasks/:id/dependencies` | `{dependsOnId}` — `:id` is blocked by `dependsOnId` |
| DELETE | `/api/tasks/:id/dependencies/:dependsOnId` | |
| POST | `/api/impact/simulate` | `{taskId, days}` or `{taskId, toDate}` → `{task, days, report}` (read-only) |
| POST | `/api/impact/postpone` | `{taskId, days \| toDate, cascade: true}` → `{updated, report}` |
| GET | `/api/impact/forecast` | `{today, report}` |
| GET | `/api/impact/leverage` | bottlenecks |
| GET | `/api/projects` | `?archived=true` to include archived |
| POST | `/api/projects` | `{name, color?}` colors: slate red orange amber green teal blue indigo violet pink |
| PATCH | `/api/projects/:id` | `{name?, color?, archived?}` |
| DELETE | `/api/projects/:id?deleteTasks=false` | tasks move to inbox unless `deleteTasks=true` (needs manage) |
| GET | `/api/projects/:id/access` | member access, grants to people and teams, everyone's effective level |
| GET | `/api/workspaces` | your workspaces with your role |
| GET | `/api/workspaces/:id` | workspace, members, teams |
| GET | `/api/workspaces/:id/activity?before=&limit=&projectId=&actorId=` | activity you may see (admins: everything but others' private tasks) |

### Jev hints (needs the user's own TypeSafe key, set in the web app)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/jev/settings` | `{jev: {connected, hint, autoApply}}` |
| POST | `/api/jev/priorities` | `{taskIds?}` → `{today, model, suggestions: [{taskId, current, suggested, score, confidence, reasons}], focus: {taskId, reasons} \| null}` (read-only) |
| POST | `/api/jev/postpone` | `{scope: "today" \| "week", capacity?}` → `{plan: {capacity, overloaded, days, candidates: [{taskId, verdict: postpone \| could \| keep \| fixed, toDate, shiftDays, delayed, reasons}]}}` (read-only; apply with `/api/impact/postpone`) |
| POST | `/api/jev/triage` | `{title, notes?, startDate?, dueDate?, projectId?}` → `{suggestion: {project?, priority, fixed}}` for a task about to be created |
| POST | `/api/jev/dependencies` | `{taskId}` → `{blockedBy: [{taskId, probability}], blocks: […]}` (read-only) |

Setting or removing the key (`PUT /api/jev/settings`) is web-session only. Without a key these return 400 with `code: "jev_not_connected"`.

Sharing a project (`PUT /api/projects/:id/access`), moving it between workspaces, invites, roles and teams are web-session only — tokens get 403.

Access levels: `view` (read), `edit` (create/change/delete tasks and links), `manage` (also rename, archive, delete, share). Roles: `owner`, `admin` (manage every project, members, teams), `member`.

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
