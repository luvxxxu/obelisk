# Obelisk delay model

The same engine runs in the web app (live preview while dragging) and on the server (REST + MCP).

## Rules

1. **Span.** A scheduled task occupies `[startDate, dueDate]`, inclusive. Only a due date → a one-day task on that date; only a start date → likewise.
2. **Dependency = finish-to-start, zero lag.** If B is blocked by A, B may start on A's due date, not earlier.
3. **Push only what newly breaks.** When A moves later by *d* days, B moves by `max(0, newViolation − oldViolation)` where violation = `A.due − B.start` (clamped at 0). So:
   - Slack between A and B absorbs the delay first (B reported as **absorbed**, with slack left).
   - A plan that was already inconsistent is never made worse than the change itself.
   - Multiple blockers: the worst one wins (that is the `because` / `via` task).
4. **Durations are preserved.** A pushed task keeps its length; start and due both move.
5. **Fixed tasks never move.** If upstream work now overruns a fixed task's start, it is a **conflict** with `overrunDays`, and the ripple stops there.
6. **Done / canceled tasks** neither move nor constrain anything.
7. **Unscheduled tasks** (no dates) pass the delay straight through to their own dependents.
8. **Forecast.** Every unfinished task whose due date is in the past is treated as finishing *today* at the earliest; the resulting ripple is the live risk forecast.

## Effects in a prediction

| effect | meaning |
|---|---|
| `root` | the task you moved |
| `shifted` | pushed later by `shiftDays` |
| `conflict` | fixed task now overrun by `overrunDays` |
| `absorbed` | reached, but slack absorbed it (`slackLeftDays` remain) |
| `unscheduled` | undated task whose blockers now finish later |

`projectSlips` shows how each project's last due date moves. `overallFinish` does the same across all open work.

## Example

```
A  디자인     11/16–11/17
B  개발       11/18–11/20   blocked by A
C  출시 발표  11/23 (fixed) blocked by B
```

- A +3 days → A 11/19–11/20, B pushed 2 days to 11/20–11/22 (1 day of slack absorbed), C absorbs (1 day slack left).
- A +5 days → B pushed 4 days to 11/22–11/24, C **conflicts** by 1 day.
