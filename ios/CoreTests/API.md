# Shared/Core API

Swift port of `packages/core/src/*.ts` and the pure parts of `web/src/lib/{format,reschedule,clock,overview,hooks}.ts`.
Foundation only; compiles in Swift 5 and 6 mode, for macOS and the iOS SDK. Run the tests: `CoreTests/run.sh`.
Tests: the ported TS tests plus `ParityTests.swift`, which replays ~11,700 TypeScript results stored in `ParityFixtures.swift`.
After changing the TS, regenerate the fixture: `bun ios/CoreTests/gen-parity.ts <repo root> ios/CoreTests/ParityFixtures.swift`.

## Conventions

- **Access:** everything is `internal` (module-wide), like `Shared/Models`. No `public` keyword.
- **Names = TS names.** Positional TS params are unlabeled (`addDays(d, 3)`); TS option objects are labeled params with defaults (`parseQuickAdd(s, today, nowMinutes: 900)`). TS `SCREAMING_CASE` constants keep their names.
- **Unions → String enums** with the TS raw values (`DateTone.default.rawValue == "default"`, `WebhookEventKey.taskCreated.rawValue == "task.created"`).
- **`x?: T | null` (omitted ≠ null) → `T??`** in request bodies and patches: `nil` = omit the key, `.some(nil)` = send `null` (clear), `.some(v)` = set. Their `Codable` writes exactly that.
- **API response types** are `Codable, Hashable, Sendable`. `T | null` → `T?`.
- **Comparators** return `Int` like JS (`< 0` = a first): `tasks.sorted { compareTasks($0, $1) < 0 }`, or the stable helpers `sortTasks`/`selectView`.
- **Invalid dates/times never trap.** Where TS throws (`toDay`, `toMinutes`), Swift reads what it can (missing parts = 0). Server data is always valid.
- **Protocols instead of `Pick<Task, …>`** (all in Views.swift / Access.swift / Jev.swift / QuickAdd.swift):

| protocol | requirements | conformers |
|---|---|---|
| `DateSpanLike` | `startDate`, `dueDate` | TaskItem, PlanItem, DateSpan, TimedSpan, OverviewTask |
| `TimedSpanLike: DateSpanLike` | + `startTime`, `dueTime` | TaskItem, PlanItem, DateSpan (times nil), OverviewTask |
| `ViewTask: TimedSpanLike` | + `id, status, projectId, priority, number, completedAt, position` | TaskItem, OverviewTask |
| `OverviewSubject: ViewTask` | + `fixed`, `assigneeIds` | TaskItem, OverviewTask |
| `TaskAccessSubject` | `projectId, createdBy, assigneeIds` | TaskItem, OverviewTask |
| `UrgencySubject: DateSpanLike` | + `fixed`, `status` | TaskItem, PlanItem, OverviewTask |
| `HasName` | `name` | Project, Team, Member, OverviewProject |
| `AnyAccessLevel` | `levelRank`, `asAccessLevel` | AccessLevel, MemberAccess |

## Dates.swift (dates.ts)

```swift
let DAY_MS = 86_400_000; let DAY_MINUTES = 1440; let WEEKDAYS_KO = ["일","월","화","수","목","금","토"]
func isISODate(_ value: String) -> Bool            // also (String?) ; real calendar date "YYYY-MM-DD"
func toDay(_ date: ISODate) -> Int                 // days since 1970-01-01 UTC
func fromDay(_ day: Int) -> ISODate
func addDays(_ date: ISODate, _ days: Int) -> ISODate
func diffDays(_ a: ISODate, _ b: ISODate) -> Int   // a - b
func weekday(_ date: ISODate) -> Int               // 0 = Sunday
func todayIn(_ timeZone: String = "UTC", now: Date = Date()) -> ISODate   // IANA zone, unknown → UTC
func isValidTimeZone(_ tz: String) -> Bool
func startOfWeek(_ date: ISODate) -> ISODate       // Monday
func endOfMonth(_ date: ISODate) -> ISODate
func minDate(_ a: ISODate?, _ b: ISODate?) -> ISODate? ; func maxDate(…) -> ISODate?
func formatRelativeKo(_ date: ISODate, _ today: ISODate) -> String  // 오늘/내일/모레/어제/금요일/11월 20일 (목)/2027년 1월 3일 (일)
func formatShortKo(_ date: ISODate) -> String      // "11/20 (목)"
func formatDaysKo(_ days: Int) -> String           // "3일", "2주"
func isISOTime(_ value: String) -> Bool            // also (String?) ; "HH:MM" 00:00–23:59
func toMinutes(_ time: ISOTime) -> Int             // "15:30" → 930
func fromMinutes(_ minutes: Int) -> ISOTime        // clamped to 00:00–23:59
struct Clock: Codable, Hashable, Sendable { var date: ISODate; var minutes: Int }   // wall clock in the user's zone
func nowIn(_ timeZone: String = "UTC", now: Date = Date()) -> Clock   // current Clock for an IANA id (unknown → UTC)
func nowIn(_ zone: TimeZone, now: Date = Date()) -> Clock
func clockIndex(_ date: ISODate, _ minutes: Int) -> Int
func minutesUntil(_ date: ISODate, _ time: ISOTime, _ now: Clock) -> Int
func isPastDue(_ dueDate: ISODate, _ dueTime: ISOTime?, _ now: Clock) -> Bool
enum DateTimeKeyMissing: String { case start, end }
func dateTimeKey(_ date: ISODate, _ time: ISOTime?, _ missing: DateTimeKeyMissing = .end) -> String
func spanInOrder(_ startDate: ISODate?, _ startTime: ISOTime?, _ dueDate: ISODate?, _ dueTime: ISOTime?) -> Bool
func formatTimeKo(_ time: ISOTime) -> String       // "오전 9:05", "오후 12:30"
func formatTimeRangeKo(_ from: ISOTime, _ to: ISOTime) -> String  // "오전 10:00 – 11:30"
func formatDurationKo(_ minutes: Int) -> String    // "40분", "2시간 15분", "3일"
func jsUTCDay(_ year: Int, _ monthIndex: Int, _ day: Int) -> Int  // Date.UTC(...)/DAY_MS (internal helper)
```

## Clock.swift (web/src/lib/clock.ts)

```swift
func clockNow(_ timeZone: String? = nil, now: Date = Date()) -> Clock   // user's zone (User.timezone), nil → device zone
func nextMinuteDelay(_ now: Date = Date()) -> TimeInterval              // seconds to next minute + 50 ms (for a ticking timer)
```

## Views.swift (views.ts)

```swift
enum ViewName: String { case today, upcoming, overdue, inbox, unscheduled, all, done } ; let VIEW_NAMES: [ViewName]
func isOverdue<T: ViewTask>(_ t: T, _ today: ISODate, _ now: Clock? = nil) -> Bool   // with now: timed due past that minute
func isToday<T: ViewTask>(_ t: T, _ today: ISODate) -> Bool
func matchesView<T: ViewTask>(_ t: T, _ view: ViewName, _ today: ISODate, _ now: Clock? = nil) -> Bool
func compareTasks<A: ViewTask, B: ViewTask>(_ a: A, _ b: B) -> Int   // doing first, due (time), priority, position, number
func compareDone<A: ViewTask, B: ViewTask>(_ a: A, _ b: B) -> Int    // latest completedAt first
func selectView<T: ViewTask>(_ tasks: [T], _ view: ViewName, _ today: ISODate, _ now: Clock? = nil) -> [T]  // filtered + stable-sorted
func sortTasks<T: ViewTask>(_ tasks: [T]) -> [T]                     // stable sort by compareTasks (web's list.sort(compareTasks))
```

## Order.swift (order.ts)

```swift
let POSITION_STEP: Double = 1024
func positionBetween(_ before: Double? = nil, _ after: Double? = nil) -> Double?  // nil → renumber with spread
struct SpreadItem: Codable, Hashable, Sendable { var id: String; var position: Double }
func spread(_ ids: [String], _ step: Double = POSITION_STEP) -> [SpreadItem]
```

## Access.swift (access.ts)

```swift
let LEVEL_RANK: [String: Int]                       // none 0, view 1, edit 2, manage 3
func atLeast(_ level: (any AnyAccessLevel)?, _ min: AccessLevel) -> Bool   // atLeast(project.access, .edit); literal needs a type: AccessLevel.edit
func maxLevel(_ levels: (any AnyAccessLevel)?...) -> AccessLevel?          // also ([(any AnyAccessLevel)?])
func isWorkspaceAdmin(_ role: WorkspaceRole?) -> Bool
struct AccessView { var userId: String; var kind: WorkspaceKind; var projectLevel: (String) -> AccessLevel?
  init(userId:kind:projectLevel:); init(userId:kind:projects: [Project]) }  // second = web store's accessView
func taskAccess<T: TaskAccessSubject>(_ task: T, _ a: AccessView) -> AccessLevel?
func canViewTask<T: TaskAccessSubject>(_ task: T, _ a: AccessView) -> Bool
func canEditTask<T: TaskAccessSubject>(_ task: T, _ a: AccessView) -> Bool
func canWriteProject(_ projectId: String?, _ projects: [Project]) -> Bool   // web store's canWriteProject (nil = inbox → true)
```

## Impact.swift (impact.ts) — delay-impact engine

```swift
struct PlanItem: Codable, Hashable, Sendable, Identifiable { id, title, status, startDate?, dueDate?, startTime?, dueTime?, fixed, projectId?, number?
  init(id:title:status:startDate:dueDate:startTime:dueTime:fixed:projectId:number:); init(task: TaskItem) }
func planItems(_ tasks: [TaskItem]) -> [PlanItem]
typealias PlanDependency = Dependency               // { taskId, dependsOnId }
enum ImpactKind: String { case root, shifted, conflict, absorbed, unscheduled }
struct DateSpan { var startDate: ISODate?; var dueDate: ISODate? }
struct TaskImpact { taskId, title, number?, projectId?, kind, shiftDays, overrunDays, slackDays?, from: DateSpan, to: DateSpan, depth, viaId? }
struct ProjectSlip { projectId, from, to, shiftDays }
struct ImpactSummary { delayedCount, conflictCount, absorbedCount, unscheduledCount, maxShiftDays, projectSlips, finishFrom?, finishTo? }
struct ImpactReport { rootIds: [String], impacts: [TaskImpact], summary: ImpactSummary }
struct DateChange { taskId, startDate?, dueDate?, startTime: ISOTime??, dueTime: ISOTime?? }  // times tri-state; dates always sent
func simulate(_ items: [PlanItem], _ deps: [PlanDependency], _ shifts: [String: Int]) -> ImpactReport   // roots in items order
func simulate(_ items: [PlanItem], _ deps: [PlanDependency], orderedShifts: [(String, Int)]) -> ImpactReport
enum ImpactError: Error { case taskNotFound }
func simulateDelay(_ items: [PlanItem], _ deps: [PlanDependency], taskId: String, days: Int? = nil, toDate: ISODate? = nil) throws -> ImpactReport
func resolveDelayDays<T: DateSpanLike>(_ item: T, days: Int? = nil, toDate: ISODate? = nil) -> Int
func forecast(_ items: [PlanItem], _ deps: [PlanDependency], _ today: ISODate) -> ImpactReport
struct BlockerWarning { taskId, title, number?, dueDate, overlapDays }
struct DateChangePreview { report, shiftDays, startsBeforeBlockers, hasImpact, only: [DateChange], cascade: [DateChange] }
func previewDateChange<S: DateSpanLike>(_ items: [PlanItem], _ deps: [PlanDependency], _ taskId: String, _ next: S) -> DateChangePreview
func changesFromReport(_ report: ImpactReport, _ cascade: Bool = true) -> [DateChange]
struct TaskLeverage { taskId, downstreamCount, slackDays?, delayedIfLate, conflictsIfLate }
func leverage(_ items: [PlanItem], _ deps: [PlanDependency]) -> [TaskLeverage]
func wouldCreateCycle(_ deps: [PlanDependency], _ taskId: String, _ dependsOnId: String) -> Bool
func downstreamOf(_ deps: [PlanDependency], _ id: String) -> [String]
// responses
struct ImpactSimulateResponse { task: TaskItem, days: Int, report }             // POST /api/impact/simulate
struct ImpactPostponeResponse { task, days, cascade: Bool, report, updated: [TaskItem] }  // POST /api/impact/postpone
struct ImpactForecastResponse { today: ISODate, report }                       // GET /api/impact/forecast
struct ImpactLeverageResponse { leverage: [TaskLeverage] }                     // GET /api/impact/leverage
```

## Reschedule.swift (web/src/lib/reschedule.ts, pure parts)

```swift
struct TimedSpan: DateSpanLike { startDate?, dueDate?, startTime: ISOTime??, dueTime: ISOTime?? }  // time nil = keep
  init(startDate:dueDate:startTime: = nil, dueTime: = nil)
struct ResolvedTimes { startTime?, dueTime? }
func resolvedTimes(_ task: TaskItem, _ next: TimedSpan) -> ResolvedTimes
func orderTimes(_ task: TaskItem, _ next: TimedSpan) -> TimedSpan            // keep same-day start ≤ due (calendar-style)
func withTimes(_ changes: [DateChange], _ taskId: String, _ next: TimedSpan) -> [DateChange]
struct PendingChange { taskId, title, next: TimedSpan, preview: DateChangePreview }
enum DateChangeRequest { case unchanged, timesOnly(ResolvedTimes), confirm(PendingChange), apply([DateChange]) }
func planDateChange(_ task: TaskItem, _ span: TimedSpan, _ items: [PlanItem], _ deps: [PlanDependency]) -> DateChangeRequest
   // = requestDateChange: .timesOnly → PATCH times; .confirm → show impact sheet; .apply → POST /api/tasks/reschedule
enum PendingResolution: String { case cascade, only }
func pendingChanges(_ p: PendingChange, _ mode: PendingResolution) -> [DateChange]   // = resolvePending
func undoChanges(_ changes: [DateChange], _ tasks: [TaskItem]) -> [DateChange]      // "before" snapshot for 실행 취소
func rescheduleToast(_ count: Int, _ title: String, _ after: TaskItem?, _ today: ISODate) -> String
let UNDO_LABEL_KO = "실행 취소"
```

## Format.swift (web/src/lib/format.ts + hooks.ts)

```swift
enum DateTone: String { case overdue, today, soon, `default`, done }
func dateTone<T: ViewTask>(_ task: T, _ today: ISODate, _ now: Clock? = nil) -> DateTone
func withTime(_ label: String, _ time: ISOTime?) -> String                    // "오늘 오후 3:00"
func spanLabel<T: TimedSpanLike>(_ task: T, _ today: ISODate) -> String?      // "내일 오후 3:00", "11/18 (화) – 11/20 (목)", "금요일 오후 6:00까지"
func timeLabel<T: TimedSpanLike>(_ task: T) -> String?                        // "오전 10:00 – 11:30"
func overdueLabel(_ due: ISODate, _ today: ISODate, _ dueTime: ISOTime? = nil, _ now: Clock? = nil) -> String  // "3일 지남", "어제 마감", "40분 지남"
func dueSoonLabel<T: ViewTask>(_ task: T, _ now: Clock) -> String?            // "40분 남음" within the hour
func daysLabel(_ n: Int) -> String                                           // formatDaysKo
func longDateKo(_ date: ISODate) -> String                                   // "11월 20일 금요일"
func relativeTime(_ iso: String?, now: Date = Date(), timeZone: TimeZone = .current) -> String  // "방금 전", "5분 전", …, "2026. 10. 1.", nil → "사용 기록 없음"
func completedOn(_ t: TaskItem, _ tz: String) -> ISODate?                    // day completedAt falls on in zone tz
```

## QuickAdd.swift (quickadd.ts)

```swift
enum QuickAddKind: String { case date, time, project, priority, fixed }
struct QuickAddToken { kind: QuickAddKind, text: String /*as typed*/, value: String /*ISO date, "HH:MM"(~"HH:MM"), name, digit, "true"*/ }
struct QuickAddResult { title, startDate?, startTime?, dueDate?, dueTime?, projectName?, priority: Int?, fixed: Bool, tokens: [QuickAddToken] }
func parseQuickAdd(_ input: String, _ today: ISODate, disabled: [QuickAddKind] = [], nowMinutes: Int? = nil) -> QuickAddResult
func parseDatePhrase(_ raw: String, _ today: ISODate) -> ISODate?           // 내일, 다음 주 수요일까지, 11/20, in 3 days, +2w …
enum Meridiem: String { case am, pm, day, night }
func parseTimePhrase(_ raw: String, _ inherit: Meridiem? = nil) -> ISOTime?  // 오후 3시, 3시 반, 15:30, 3pm, 정오 …
struct DateTimePhrase: Codable, Hashable, Sendable { var date: ISODate; var time: ISOTime? }
func parseDateTimePhrase(_ raw: String, _ today: ISODate, _ nowMinutes: Int? = nil) -> DateTimePhrase?   // date field: "내일 오후 3시"
protocol HasName { var name: String { get } }
func matchProject<T: HasName>(_ projects: [T], _ name: String) -> T?          // exact → no spaces → prefix → unique substring
```

## Overview.swift (overview.ts)

```swift
let OVERVIEW_DAYS = 7; let OVERVIEW_FIXED_DAYS = 30
@dynamicMemberLookup struct OverviewTask: Codable, Identifiable { var task: TaskItem; var editable: Bool }  // flat JSON; item.title works
struct OverviewProject: Codable, Identifiable, HasName { id, workspaceId, name, color: ProjectColor; init(project: Project) }
struct Overview: Codable { today: ISODate, spaces: [WorkspaceSummary], tasks: [OverviewTask], projects: [OverviewProject] }  // GET /api/overview
func isMine<T: OverviewSubject>(_ t: T, _ kind: WorkspaceKind, _ userId: String) -> Bool
func overviewDay<T: DateSpanLike>(_ t: T) -> ISODate?
func fixedDate<T: OverviewSubject>(_ t: T, _ today: ISODate, _ horizonDays: Int = OVERVIEW_FIXED_DAYS) -> ISODate?
func inOverview<T: OverviewSubject>(_ t: T, _ kind: WorkspaceKind, _ userId: String, _ today: ISODate) -> Bool
struct OverviewDay<T>: Identifiable { date: ISODate, tasks: [T] }             // id = date
struct OverviewFixed<T: ViewTask>: Identifiable { task: T, date: ISODate }    // id = task.id
struct OverviewSections<T: ViewTask> { overdue: [T], today: [T], week: [OverviewDay<T>], fixed: [OverviewFixed<T>] }
func overviewSections<T: OverviewSubject>(_ tasks: [T], _ today: ISODate) -> OverviewSections<T>
```

## OverviewMerge.swift (web/src/lib/overview.ts)

```swift
struct OverviewItem: Identifiable { task: TaskItem, editable: Bool, space: WorkspaceSummary, project: OverviewProject?, live: Bool }
struct OverviewOpenSpace { workspace: WorkspaceSummary, userId: String, today: ISODate, tasks: [TaskItem], projects: [Project] }
struct OverviewLiveCacheEntry { at: Date, items: [OverviewItem] }
struct OverviewMergeResult { spaces: [WorkspaceSummary], items: [OverviewItem] }
func mergeOverview(_ data: Overview?, fetchedAt: Date, open: OverviewOpenSpace?, workspaces: [WorkspaceSummary],
                   liveCache: inout [String: OverviewLiveCacheEntry], now: Date = Date()) -> OverviewMergeResult
enum SpaceHue: String { case slate, blue, violet, teal, orange, pink, green, indigo, amber } ; let ORG_HUES: [SpaceHue]
func spaceHues(_ spaces: [WorkspaceSummary]) -> [String: SpaceHue]          // personal = slate, orgs take turns
```

## Activity.swift (activity.ts)

```swift
let FIELD_KO: [String: String]
func describeActivity(_ e: ActivityEntry) -> String                           // "마감일 11/20 → 11/22", "프로젝트를 만들었습니다"
func describeActivity(action: String, data: [String: JSONValue]?, subject: String = "") -> String
func changePhrases(_ changes: JSONValue?) -> [String] ; func changePhrases(_ changes: [String: JSONValue]?) -> [String]
func jsonbKeyOrder(_ keys: [String]) -> [String]   // field order used (Postgres jsonb order = what the web shows)
enum ActivityKind: String { case task, project, member, team, invite, workspace }
func activityKind(_ action: String) -> ActivityKind
func viaLabelKo(_ via: ActivityVia, _ client: String?) -> String?            // "Claude 통해", "API 토큰 “CI”", "웹훅 “x” 통해"
```

## Jev.swift (jev.ts) — pure half; network calls live elsewhere

```swift
let DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai/v1"
func jevEndpoint(_ baseUrl: String) -> String                 // appends /systemone unless a full endpoint
enum JevPresetId: String { case typesafe, openrouter, cloudflare }
struct JevPreset: Identifiable { id: JevPresetId, label, baseUrl, models: [String] } ; let JEV_PRESETS: [JevPreset]
func cloudflareJevUrl(_ accountId: String, _ model: String) -> String
func jevPresetOf(_ baseUrl: String?) -> JevPresetId?          // nil base = typesafe; custom host = nil
let JEV_CONFIDENT = 0.8 ; let FIXED_THRESHOLD = 0.75 ; let DEPENDENCY_THRESHOLD = 0.65
struct JevSettingsInput: Codable { apiKey: String??, baseUrl: String??, model: String??, autoApply: Bool? }  // PUT /api/jev/settings
func jevSettingsIssues(_ input: JevSettingsInput) -> [ValidationIssue]   // server's zod messages, in order
struct JevPrioritiesInput { taskIds: [String]? } ; struct JevDependenciesInput { taskId }
enum PostponeScope: String { case today, week } ; struct JevPostponeInput { scope = .today, capacity: Int? }
struct JevTriageInput { title, notes?, startDate?, dueDate?, projectId? }
struct TaskJudgment { importance, importanceConfidence, others, deferrable: Double } ; let NEUTRAL_JUDGMENT
let IMPORTANCE_LABEL_KO: [String]                             // index with importanceLevel(j)
func importanceLevel(_ j: TaskJudgment) -> Int                // 0–3
struct Urgency { value: Double, days: Int?, label: String? }
func urgencyOf<T: UrgencySubject>(_ t: T, _ today: ISODate) -> Urgency      // "2일 지남", "오늘 마감", "3일 뒤 시작"
func leverageScore(_ l: TaskLeverage?) -> Double
let PRIORITY_CUTS = (high: 0.64, medium: 0.4, low: 0.17)
func priorityScore(_ j: TaskJudgment, _ urgency: Double, _ leverage: Double) -> Double
func priorityFromScore(_ score: Double) -> Priority
func priorityConfidence(_ j: TaskJudgment, _ score: Double) -> Double
struct PrioritySuggestion { taskId, current, suggested: Priority, score, confidence, reasons: [String], judgment }
func suggestPriority(_ t: TaskItem, _ j: TaskJudgment, _ lev: TaskLeverage?, _ today: ISODate) -> PrioritySuggestion
func autoApplicable(_ s: PrioritySuggestion) -> Bool
func isBlocked(_ id: String, _ deps: [PlanDependency], _ status: (String) -> TaskStatus?) -> Bool
func pickFocus(_ tasks: [TaskItem], _ deps: [PlanDependency], _ scores: [String: Double], _ today: ISODate) -> String?
enum PostponeVerdict: String { case postpone, could, keep, fixed }
struct PostponeCandidate { taskId, verdict, day, toDate?, shiftDays, delayed, score, reasons }
struct PostponeDayLoad { date, load, after }
enum CapacitySource: String { case input, history, `default` }
struct PostponePlan { scope, today, capacity, capacitySource, overloaded, days: [PostponeDayLoad], candidates }
struct CapacityEstimate { capacity: Int, source: CapacitySource }
func capacityFromHistory(_ completedOn: [ISODate?], _ today: ISODate) -> CapacityEstimate
func planPostpone(tasks: [TaskItem], deps: [PlanDependency], mine: (TaskItem) -> Bool, editable: (TaskItem) -> Bool,
                  judgments: [String: TaskJudgment], today: ISODate, scope: PostponeScope, capacity: Int, capacitySource: CapacitySource) -> PostponePlan
struct TriageSuggestion { project: ProjectPick? {id?, confidence}, priority: PriorityPick {value, confidence, reasons}, fixed: FixedPick {value, probability} }
enum DependencyDirection: String { case blockedBy, blocks } ; struct DependencySuggestion { taskId, direction, probability }
// responses
struct JevSettingsResponse { jev: JevStatus }                 // GET /api/jev/settings
struct JevSettingsUpdateResponse { jev: JevStatus, user: User } // PUT /api/jev/settings
struct PrioritiesResult { today, model?, suggestions, focus: Focus? {taskId, reasons} }  // POST /api/jev/priorities
struct JevPostponeResponse { plan: PostponePlan }             // POST /api/jev/postpone
struct JevTriageResponse { suggestion: TriageSuggestion }     // POST /api/jev/triage
struct DependencyResult { taskId, blockedBy: [DependencySuggestion], blocks: [DependencySuggestion] }  // POST /api/jev/dependencies
```

## Webhooks.swift (webhooks.ts)

```swift
enum WebhookFormat: String { case json, slack, discord; var label } ; let WEBHOOK_FORMATS ; let WEBHOOK_FORMAT_LABEL
enum WebhookEventKey: String { taskCreated "task.created", taskCompleted, taskUpdated, taskPostponed, taskDeleted, taskDependency,
  project, organization, taskDueToday "task.due_today", taskDueSoon, taskOverdue, fixedConflict "fixed.conflict",
  taskStartReminder "task.start_reminder", taskDueReminder; var label }   // typealias ScheduleEventKey/ReminderEventKey = WebhookEventKey
let WEBHOOK_EVENT_KEYS, SCHEDULE_EVENT_KEYS, REMINDER_EVENT_KEYS, DEFAULT_WEBHOOK_EVENTS: [WebhookEventKey]
func isScheduleEvent(_ key: String) -> Bool ; func isReminderEvent(_ key: String) -> Bool
let REMINDER_LEAD_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440] ; let DEFAULT_REMIND_MINUTES = 30
func remindLeadLabel(_ minutes: Int) -> String               // "정각에", "30분 전"
struct WebhookEventOption: Identifiable { key, label, hint }
enum WebhookEventGroupId: String { case task, project, organization, schedule }
struct WebhookEventGroup: Identifiable { id, label, orgOnly: Bool, events } ; let WEBHOOK_EVENT_GROUPS ; let WEBHOOK_EVENT_LABEL
struct WebhookEventRoute { key: WebhookEventKey, event: String }
func webhookEventFor(_ action: String, _ data: [String: JSONValue]?) -> WebhookEventRoute?
func detectWebhookFormat(_ url: String) -> WebhookFormat     // Slack/Discord by URL
func maskWebhookUrl(_ url: String) -> String                  // "hooks.slack.com/services/…3456"
// payload
struct WebhookNamedRef { id, name } ; struct WebhookWorkspaceRef { id, name, kind } ; struct WebhookActor { id?, name, via, client? }
struct WebhookTaskRef { id, ref, number, title, status, priority, startDate?, startTime?, dueDate?, dueTime?, fixed, project?, assignees: [WebhookNamedRef], url }
struct WebhookProjectRef { id, name, url? } ; struct WebhookAlertCause { id, ref, title }
struct WebhookAlert { date, daysOverdue?, overrunDays?, cause?, at?, minutesLeft? }
struct WebhookPayload { id, event, createdAt, workspace, actor?, subject, summary, text, url?, task?, project?, changes?, data?, alert? }
func webhookText(_ p: WebhookPayload) -> String ; func webhookText(actor:subject:summary:) -> String
func chatMessage(_ p: WebhookPayload, _ format: WebhookFormat) -> [String: JSONValue]   // Slack/Discord body
// schedule alerts & reminders (server-side scans, ported for parity)
struct ScheduleAlert { key, taskId = "", daysOverdue?, overrunDays?, causeId?, time? }
func scheduleAlerts(_ items: [PlanItem], _ deps: [PlanDependency], _ today: ISODate, _ now: Clock? = nil) -> [ScheduleAlert]
func scheduleSummary(_ a: ScheduleAlert, _ cause: String? = nil) -> String
struct Reminder { key, taskId = "", date, time, minutesLeft }
func reminderAlerts(_ items: [PlanItem], _ now: Clock, _ lead: Int, _ keys: [WebhookEventKey] = REMINDER_EVENT_KEYS) -> [Reminder]
func reminderSummary(_ r: Reminder, _ today: ISODate) -> String
// incoming (server-side parser, ported for parity)
struct IncomingPatch { title?, notes?, status?, priority?, startDate??, startTime??, dueDate??, dueTime??, fixed?; isEmpty; json }
struct IncomingCreate { title, patch: IncomingPatch, project?, assignees? }
enum IncomingCommand { case create(IncomingCreate), update(task: String, patch: IncomingPatch); var json: JSONValue }
enum IncomingParse { case ok(IncomingCommand), error(String); command, errorMessage, isOk }
func parseIncoming(_ body: JSONValue, _ today: ISODate, timeZone: String? = nil, nowMinutes: Int? = nil) -> IncomingParse
// API shapes
enum WebhookDeliveryStatus: String { case pending, success, failed }
struct Webhook: Identifiable { id, name, url, format, events, projectIds?, alertHour, remindMinutes, timezone, enabled, disabledReason?,
  failureCount, lastDelivery: LastDelivery? {status, at, responseStatus?}, createdBy: WebhookNamedRef?, createdAt, updatedAt }
struct WebhookDelivery: Identifiable { id, webhookId, event, status, attempts, maxAttempts, nextAttemptAt?, lastAttemptAt?,
  responseStatus?, responseBody?, error?, durationMs?, createdAt, payload: WebhookPayload }
struct IncomingWebhook: Identifiable { id, name, hint, projectId?, allowUpdates, useCount, lastUsedAt?, lastError?, lastErrorAt?, createdBy?, createdAt }
struct WebhooksOverview { canManage, webhooks, incoming }                       // GET /api/webhooks
struct WebhookCreatedResponse { webhook, secret }                              // POST /api/webhooks
struct WebhookResponse { webhook }                                             // PATCH /api/webhooks/:id
struct WebhookSecretResponse { secret }                                        // POST /api/webhooks/:id/secret
struct WebhookDeliveryResponse { delivery }                                    // POST …/test, …/deliveries/:d/redeliver
struct WebhookDeliveriesResponse { deliveries }                                // GET /api/webhooks/:id/deliveries
struct IncomingWebhookCreatedResponse { incoming, url }                        // POST /api/incoming-webhooks
struct IncomingWebhookResponse { incoming }                                    // PATCH /api/incoming-webhooks/:id
struct IncomingWebhookUrlResponse { url }                                      // POST /api/incoming-webhooks/:id/rotate
struct OkResponse { ok }                                                       // DELETE either
// inputs + validation (server messages)
struct CreateWebhookInput { name, url, format?, events, projectIds: [String]??, alertHour?, remindMinutes?, enabled?; func normalized() }
struct UpdateWebhookInput { all optional; projectIds: [String]?? }
struct CreateIncomingWebhookInput { name, projectId: String??, allowUpdates? } ; struct UpdateIncomingWebhookInput { name?, projectId??, allowUpdates? }
func webhookNameIssues(_ name: String) -> [String] ; func webhookUrlIssues(_ url: String) -> [String] ; func webhookEventsIssues(_ events: [WebhookEventKey]) -> [String]
func createWebhookIssues(_ input: CreateWebhookInput) -> [ValidationIssue] ; func updateWebhookIssues(_ input: UpdateWebhookInput) -> [ValidationIssue]
func incomingWebhookIssues(name: String) -> [ValidationIssue]
```

## Schemas.swift (schemas.ts, the parts the UI needs)

```swift
struct ValidationIssue: Codable, Hashable, Sendable { var message: String; var path: [String] }
func spanIssues(startDate: ISODate? = nil, startTime: ISOTime? = nil, dueDate: ISODate? = nil, dueTime: ISOTime? = nil) -> [ValidationIssue]
func spanIssues<T: TimedSpanLike>(_ v: T) -> [ValidationIssue]
func taskTitleIssues(_ title: String) -> [String]               // "제목을 입력하세요", max 500
struct RescheduleInput { rootId?, changes: [DateChange] }      // POST /api/tasks/reschedule
struct ReorderChange { taskId, position: Double, status? } ; struct ReorderTasksInput { changes }   // POST /api/tasks/reorder
struct DelayInput { taskId, days?, toDate? }                   // POST /api/impact/simulate
struct PostponeInput { taskId, days?, toDate?, cascade = true } // POST /api/impact/postpone
func delayInputIssues(days: Int?, toDate: ISODate?) -> [String] // exactly one of days / toDate
```

## JSCompat.swift (internal plumbing; screens should not need it)

`enum JS` (UTF-16 `trim/slice/length/includes/startsWith/pad`, JS `String()/Number()/truthiness` of `JSONValue`, stable `sorted`,
`round`, `parseDate(_:) -> Date?` = `new Date(iso)`), `final class JSRegex` (JS-semantics regex over NSRegularExpression),
`struct JSURL` (WHATWG-ish `new URL`: protocol/hostname/host/pathname), `Optional<String>.jsTruthy`,
`KeyedEncodingContainer.encodeTriState` / `KeyedDecodingContainer.decodeTriState` for `T??` fields.
