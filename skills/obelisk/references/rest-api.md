# Obelisk REST API

Base URL: `$OBELISK_URL` (e.g. `{{OBELISK_URL}}`). Auth: `Authorization: Bearer $OBELISK_TOKEN` (a personal `obk_…` token from 설정 → AI 연결). JSON in, JSON out. Errors: `{ "statusCode", "message" }`.

Helper: `scripts/obelisk.sh METHOD PATH [JSON]`.

## Overview

| Method | Path | Notes |
|---|---|---|
| GET | `/api/bootstrap` | user, `today`, projects, open + recent tasks, dependencies |
| GET | `/api/tasks?view=&projectId=&status=&q=&from=&to=&limit=` | `view`: today, upcoming, overdue, inbox, unscheduled, all, done. `projectId=inbox` for no project |
| GET | `/api/tasks/:ref` | ref = `12`, uuid, or unique title fragment (URL-encode `#` as `%23` or omit it) |
| POST | `/api/tasks` | `{title, notes?, status?, priority?: 0-3, projectId?, startDate?, dueDate?, fixed?, blockedBy?: uuid[]}` |
| POST | `/api/tasks/bulk` | `{projectId?, tasks: [{key?, title, …, blockedBy?: (key \| "#12" \| uuid)[]}]}` |
| PATCH | `/api/tasks/:id` | any task field; `null` clears dates/project |
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
| DELETE | `/api/projects/:id?deleteTasks=false` | tasks move to inbox unless `deleteTasks=true` |

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
