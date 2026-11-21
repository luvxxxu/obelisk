import Foundation

// Port of packages/core/src/webhooks.ts.
//
// Outgoing: every activity-log entry maps to at most one webhook event, and a periodic scan adds
// schedule alerts (due today / tomorrow, overdue, fixed-date conflicts). Tasks with a time also get
// reminders a set number of minutes before they start or are due. A webhook subscribes to event *keys*;
// the payload's `event` is the precise name ("project.archived" under key "project").
//
// Incoming: a POST body (JSON, form or plain text) becomes one create or update command, run with the
// permissions of whoever made the webhook. (`parseIncoming` runs on the server; it is ported for parity.)

// MARK: - catalog

enum WebhookFormat: String, Codable, CaseIterable, Hashable, Sendable {
    case json, slack, discord

    /// "JSON", "Slack", "Discord"
    var label: String { WEBHOOK_FORMAT_LABEL[self]! }
}

let WEBHOOK_FORMATS: [WebhookFormat] = WebhookFormat.allCases

let WEBHOOK_FORMAT_LABEL: [WebhookFormat: String] = [.json: "JSON", .slack: "Slack", .discord: "Discord"]

/// What a webhook subscribes to. Raw values are the API strings.
enum WebhookEventKey: String, Codable, CaseIterable, Hashable, Sendable {
    case taskCreated = "task.created"
    case taskCompleted = "task.completed"
    case taskUpdated = "task.updated"
    case taskPostponed = "task.postponed"
    case taskDeleted = "task.deleted"
    case taskDependency = "task.dependency"
    case project
    case organization
    case taskDueToday = "task.due_today"
    case taskDueSoon = "task.due_soon"
    case taskOverdue = "task.overdue"
    case fixedConflict = "fixed.conflict"
    case taskStartReminder = "task.start_reminder"
    case taskDueReminder = "task.due_reminder"

    /// Korean label ("새 작업", "오늘 마감" …).
    var label: String { WEBHOOK_EVENT_LABEL[self]! }
}

/// The TS narrows these to subsets; Swift uses WebhookEventKey throughout.
typealias ScheduleEventKey = WebhookEventKey
typealias ReminderEventKey = WebhookEventKey

let WEBHOOK_EVENT_KEYS: [WebhookEventKey] = WebhookEventKey.allCases

let SCHEDULE_EVENT_KEYS: [WebhookEventKey] = [.taskDueToday, .taskDueSoon, .taskOverdue, .fixedConflict]

func isScheduleEvent(_ key: String) -> Bool {
    SCHEDULE_EVENT_KEYS.contains { $0.rawValue == key }
}

/// Minute-precise reminders for tasks that have a time, sent `remindMinutes` before it.
let REMINDER_EVENT_KEYS: [WebhookEventKey] = [.taskStartReminder, .taskDueReminder]

func isReminderEvent(_ key: String) -> Bool {
    REMINDER_EVENT_KEYS.contains { $0.rawValue == key }
}

/// How long before a task's time its reminder goes out. 0 = at that minute.
let REMINDER_LEAD_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440]
let DEFAULT_REMIND_MINUTES = 30

/// "정각에", "30분 전", "1일 전"
func remindLeadLabel(_ minutes: Int) -> String {
    minutes == 0 ? "정각에" : "\(formatDurationKo(minutes)) 전"
}

struct WebhookEventOption: Codable, Hashable, Sendable, Identifiable {
    var key: WebhookEventKey
    var label: String
    var hint: String
    var id: WebhookEventKey { key }
}

enum WebhookEventGroupId: String, Codable, CaseIterable, Hashable, Sendable {
    case task, project, organization, schedule
}

struct WebhookEventGroup: Codable, Hashable, Sendable, Identifiable {
    var id: WebhookEventGroupId
    var label: String
    /// Only organizations have members, teams and invites.
    var orgOnly: Bool
    var events: [WebhookEventOption]
}

let WEBHOOK_EVENT_GROUPS: [WebhookEventGroup] = [
    WebhookEventGroup(id: .task, label: "작업", orgOnly: false, events: [
        WebhookEventOption(key: .taskCreated, label: "새 작업", hint: "작업이 만들어지거나 휴지통에서 되살아날 때"),
        WebhookEventOption(key: .taskCompleted, label: "완료", hint: "작업을 완료할 때"),
        WebhookEventOption(key: .taskUpdated, label: "수정", hint: "제목·상태·날짜·담당자·우선순위가 바뀔 때"),
        WebhookEventOption(key: .taskPostponed, label: "미룸", hint: "미루기를 적용할 때 (연쇄 이동 포함)"),
        WebhookEventOption(key: .taskDeleted, label: "삭제", hint: "작업을 휴지통으로 옮길 때"),
        WebhookEventOption(key: .taskDependency, label: "선행 작업", hint: "선행 작업을 연결하거나 해제할 때"),
    ]),
    WebhookEventGroup(id: .project, label: "프로젝트", orgOnly: false, events: [
        WebhookEventOption(key: .project, label: "프로젝트 변경", hint: "생성·이름·보관·삭제·공유 설정·공간 이동"),
    ]),
    WebhookEventGroup(id: .organization, label: "조직", orgOnly: true, events: [
        WebhookEventOption(key: .organization, label: "멤버·팀·초대", hint: "참여·역할 변경·내보내기, 팀, 초대 링크, 조직 설정"),
    ]),
    WebhookEventGroup(id: .schedule, label: "일정 알림", orgOnly: false, events: [
        WebhookEventOption(key: .taskDueToday, label: "오늘 마감", hint: "마감일 당일"),
        WebhookEventOption(key: .taskDueSoon, label: "내일 마감", hint: "마감 하루 전"),
        WebhookEventOption(key: .taskOverdue, label: "기한 지남", hint: "마감이 지난 동안 하루 한 번"),
        WebhookEventOption(key: .fixedConflict, label: "고정 일정 충돌", hint: "선행 작업이 늦어 고정 일정을 넘길 때"),
        WebhookEventOption(key: .taskStartReminder, label: "시작 시각 알림", hint: "시작 시각이 있는 작업, 정한 시간 전에"),
        WebhookEventOption(key: .taskDueReminder, label: "마감 시각 알림", hint: "마감 시각이 있는 작업, 정한 시간 전에"),
    ]),
]

let WEBHOOK_EVENT_LABEL: [WebhookEventKey: String] = Dictionary(
    WEBHOOK_EVENT_GROUPS.flatMap { g in g.events.map { ($0.key, $0.label) } },
    uniquingKeysWith: { _, b in b }
)

let DEFAULT_WEBHOOK_EVENTS: [WebhookEventKey] = [.taskCreated, .taskCompleted, .taskPostponed, .taskOverdue, .fixedConflict]

/// Which subscription an activity entry belongs to, and the event name it is sent as.
struct WebhookEventRoute: Codable, Hashable, Sendable {
    var key: WebhookEventKey
    var event: String
}

func webhookEventFor(_ action: String, _ data: [String: JSONValue]?) -> WebhookEventRoute? {
    switch action {
    case "task.created", "task.postponed", "task.deleted":
        return WebhookEventRoute(key: WebhookEventKey(rawValue: action)!, event: action)
    case "task.restored":
        // Back from the trash: subscribers to 새 작업 hear about it (no subscription key of its own).
        return WebhookEventRoute(key: .taskCreated, event: action)
    case "task.updated":
        let status = data?["changes"]?["status"]
        return status?["to"] == .string("done")
            ? WebhookEventRoute(key: .taskCompleted, event: "task.completed")
            : WebhookEventRoute(key: .taskUpdated, event: action)
    case "dependency.added", "dependency.removed":
        return WebhookEventRoute(key: .taskDependency, event: action)
    default:
        break
    }
    let head = action.components(separatedBy: ".")[0]
    if head == "project" { return WebhookEventRoute(key: .project, event: action) }
    if ["member", "invite", "team", "workspace"].contains(head) { return WebhookEventRoute(key: .organization, event: action) }
    return nil
}

private let RE_DISCORD_HOST = JSRegex("^(?:(?:ptb|canary)\\.)?discord(?:app)?\\.com$")

/// Slack and Discord incoming-webhook URLs get a chat message instead of raw JSON.
func detectWebhookFormat(_ url: String) -> WebhookFormat {
    if let u = JSURL(url) {
        let host = u.hostname.lowercased()
        if host == "hooks.slack.com" { return .slack }
        if RE_DISCORD_HOST.test(host) && JS.startsWith(u.pathname, "/api/webhooks/") { return .discord }
    }
    return .json
}

private let RE_TRAILING_SLASH = JSRegex("/+$")

/// The part of a URL that is safe to show in a list (Slack/Discord paths are the secret).
func maskWebhookUrl(_ url: String) -> String {
    guard let u = JSURL(url) else { return JS.slice(url, 0, 32) }
    let path = RE_TRAILING_SLASH.replaceFirst(u.pathname, "")
    if path.isEmpty || path == "/" { return u.host }
    let segments = path.components(separatedBy: "/").filter { !$0.isEmpty }
    let first = segments.first ?? ""
    let tail = JS.slice(path, -4)
    return segments.count > 1 || JS.length(path) > 24 ? "\(u.host)/\(first)/…\(tail)" : "\(u.host)\(path)"
}

// MARK: - payload

/// `{ id, name }` (a task's project or assignee, a webhook's creator).
struct WebhookNamedRef: Codable, Hashable, Sendable {
    var id: String
    var name: String
}

struct WebhookTaskRef: Codable, Hashable, Sendable {
    var id: String
    /// "#12"
    var ref: String
    var number: Int
    var title: String
    var status: TaskStatus
    var priority: Priority
    var startDate: ISODate?
    /// "HH:MM" in the user's time zone, or nil for the whole day.
    var startTime: ISOTime?
    var dueDate: ISODate?
    var dueTime: ISOTime?
    var fixed: Bool
    var project: WebhookNamedRef?
    var assignee: WebhookNamedRef?
    var url: String
}

struct WebhookWorkspaceRef: Codable, Hashable, Sendable {
    var id: String
    var name: String
    var kind: WorkspaceKind
}

struct WebhookActor: Codable, Hashable, Sendable {
    var id: String?
    var name: String
    var via: ActivityVia
    var client: String?
}

struct WebhookProjectRef: Codable, Hashable, Sendable {
    var id: String
    var name: String
    var url: String?
}

struct WebhookAlertCause: Codable, Hashable, Sendable {
    var id: String
    var ref: String
    var title: String
}

struct WebhookAlert: Codable, Hashable, Sendable {
    var date: ISODate
    var daysOverdue: Int?
    var overrunDays: Int?
    var cause: WebhookAlertCause?
    /// Reminders: the start or due moment, "YYYY-MM-DDTHH:MM" in the webhook's time zone.
    var at: String?
    /// Reminders: minutes from the send until then (0 or less = now).
    var minutesLeft: Int?
}

struct WebhookPayload: Codable, Hashable, Sendable {
    /// One per event: a redelivery keeps it, so a receiver can skip duplicates.
    var id: String
    var event: String
    var createdAt: String
    var workspace: WebhookWorkspaceRef
    /// Who did it; nil for schedule alerts and tests.
    var actor: WebhookActor?
    /// What it is about, as Obelisk shows it: "#12 기획서", a project or a member name.
    var subject: String
    /// What happened, without actor or subject: "마감일 11/20 → 11/22".
    var summary: String
    /// One readable line: "민겸 · #12 기획서 — 마감일 11/20 → 11/22".
    var text: String
    /// Link to the task or project in Obelisk, when there is one.
    var url: String?
    /// Task events; nil when the task no longer exists (deleted).
    var task: WebhookTaskRef?
    /// Project events.
    var project: WebhookProjectRef?
    /// before → after per changed field (task.updated, task.completed, project.updated …).
    var changes: [String: JSONValue]?
    /// The activity entry's details as recorded.
    var data: [String: JSONValue]?
    /// Schedule alerts and reminders.
    var alert: WebhookAlert?

    init(
        id: String, event: String, createdAt: String, workspace: WebhookWorkspaceRef, actor: WebhookActor?,
        subject: String, summary: String, text: String, url: String?, task: WebhookTaskRef? = nil,
        project: WebhookProjectRef? = nil, changes: [String: JSONValue]? = nil, data: [String: JSONValue]? = nil,
        alert: WebhookAlert? = nil
    ) {
        self.id = id
        self.event = event
        self.createdAt = createdAt
        self.workspace = workspace
        self.actor = actor
        self.subject = subject
        self.summary = summary
        self.text = text
        self.url = url
        self.task = task
        self.project = project
        self.changes = changes
        self.data = data
        self.alert = alert
    }
}

/// "민겸 (웹훅 “CI” 통해) · #12 기획서 — 마감일 11/20 → 11/22"
func webhookText(_ p: WebhookPayload) -> String {
    webhookText(actor: p.actor, subject: p.subject, summary: p.summary)
}

/// `webhookText` from its parts.
func webhookText(actor: WebhookActor?, subject: String, summary: String) -> String {
    let via = actor.flatMap { viaLabelKo($0.via, $0.client) }
    let who = actor.map { "\($0.name)\(via.map { " (\($0))" } ?? "")" }
    let head = [who, subject].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    return head.isEmpty ? summary : "\(head) — \(summary)"
}

private let EMOJI: [String: String] = [
    "task.completed": "✅",
    "task.overdue": "⏰",
    "task.due_today": "📅",
    "task.due_soon": "📅",
    "task.start_reminder": "🔔",
    "task.due_reminder": "🔔",
    "fixed.conflict": "⚠️",
    "ping": "👋",
]

private let RE_AMP = JSRegex("&")
private let RE_LT = JSRegex("<")
private let RE_GT = JSRegex(">")
private let RE_DISCORD_MD = JSRegex("([\\\\*_~`|>\\[\\]()#\\-])")
private let RE_AT_SIGN = JSRegex("@")
private let RE_PIPE = JSRegex("\\|")

private func slackEscape(_ s: String) -> String {
    RE_GT.replaceAll(RE_LT.replaceAll(RE_AMP.replaceAll(s, "&amp;"), "&lt;"), "&gt;")
}

private func discordEscape(_ s: String) -> String {
    RE_AT_SIGN.replaceAll(RE_DISCORD_MD.replaceAll(s) { "\\" + ($0[1] ?? "") }, "@\u{200B}")
}

/// Body for a Slack or Discord incoming webhook (`.json` is treated as Discord, like any non-Slack value
/// in the TS). Mentions are never triggered.
func chatMessage(_ p: WebhookPayload, _ format: WebhookFormat) -> [String: JSONValue] {
    let slack = format == .slack
    func esc(_ s: String) -> String { slack ? slackEscape(s) : discordEscape(s) }
    let via = p.actor.flatMap { viaLabelKo($0.via, $0.client) }
    let who = p.actor.map { a -> String in
        let name = slack ? "*\(esc(a.name))*" : "**\(esc(a.name))**"
        return "\(name)\(via.map { " (\(esc($0)))" } ?? "")"
    }
    var subject: String? = nil
    if !p.subject.isEmpty {
        if !p.url.jsTruthy { subject = esc(p.subject) }
        else if slack { subject = "<\(p.url!)|\(RE_PIPE.replaceAll(esc(p.subject), "¦"))>" }
        else { subject = "[\(esc(p.subject))](<\(p.url!)>)" }
    }
    let head = [who, subject].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    let emoji = EMOJI[p.event]
    let line = "\(emoji.map { "\($0) " } ?? "")\(head.isEmpty ? esc(p.summary) : "\(head) — \(esc(p.summary))")"
    if slack { return ["text": .string(JS.slice(line, 0, 3000)), "unfurl_links": false, "unfurl_media": false] }
    return ["content": .string(JS.slice(line, 0, 2000)), "username": "Obelisk", "allowed_mentions": ["parse": []]]
}

// MARK: - schedule alerts

struct ScheduleAlert: Codable, Hashable, Sendable {
    /// One of SCHEDULE_EVENT_KEYS.
    var key: WebhookEventKey
    var taskId: String
    var daysOverdue: Int?
    var overrunDays: Int?
    /// For conflicts: the late task at the start of the chain.
    var causeId: String?
    /// The task's due time, for the summary.
    var time: ISOTime?

    init(key: WebhookEventKey, taskId: String = "", daysOverdue: Int? = nil, overrunDays: Int? = nil, causeId: String? = nil, time: ISOTime? = nil) {
        self.key = key
        self.taskId = taskId
        self.daysOverdue = daysOverdue
        self.overrunDays = overrunDays
        self.causeId = causeId
        self.time = time
    }
}

/// What a periodic scan reports today: active tasks due today or tomorrow, overdue tasks, and fixed tasks
/// the live forecast pushes past their date (with the late task that started it). With `now`, a task due
/// today whose time has passed is already overdue.
func scheduleAlerts(_ items: [PlanItem], _ deps: [PlanDependency], _ today: ISODate, _ now: Clock? = nil) -> [ScheduleAlert] {
    var out: [ScheduleAlert] = []
    let tomorrow = addDays(today, 1)
    let clock = now.flatMap { $0.date == today ? $0 : nil }
    for it in items {
        guard it.status == .todo || it.status == .doing, let due = it.dueDate, !due.isEmpty else { continue }
        let time = it.dueTime.jsTruthy ? it.dueTime : nil
        if due < today || (clock != nil && isPastDue(due, time, clock!)) {
            out.append(ScheduleAlert(key: .taskOverdue, taskId: it.id, daysOverdue: diffDays(today, due), time: time))
        } else if due == today {
            out.append(ScheduleAlert(key: .taskDueToday, taskId: it.id, time: time))
        } else if due == tomorrow {
            out.append(ScheduleAlert(key: .taskDueSoon, taskId: it.id, time: time))
        }
    }
    let report = forecast(items, deps, today)
    var byId: [String: TaskImpact] = [:]
    for i in report.impacts { byId[i.taskId] = i }
    for im in report.impacts where im.kind == .conflict {
        var cause = im.viaId
        var hops = 0
        while let c = cause, !c.isEmpty, hops < 1000 {
            guard let up = byId[c], up.kind != .root, let next = up.viaId, !next.isEmpty else { break }
            cause = next
            hops += 1
        }
        out.append(ScheduleAlert(key: .fixedConflict, taskId: im.taskId, overrunDays: im.overrunDays, causeId: cause))
    }
    return out
}

/// "오늘 오후 3:00 마감", "마감 2일 지남", "고정 일정 충돌 · #3 시안 지연으로 2일 넘침"
func scheduleSummary(_ a: ScheduleAlert, _ cause: String? = nil) -> String {
    let at = a.time.jsTruthy ? " \(formatTimeKo(a.time!))" : ""
    switch a.key {
    case .taskDueToday:
        return "오늘\(at) 마감"
    case .taskDueSoon:
        return "내일\(at) 마감"
    case .taskOverdue:
        if let d = a.daysOverdue, d != 0 { return "마감 \(d)일 지남" }
        return "마감 시각\(at) 지남"
    case .fixedConflict:
        return "고정 일정 충돌 · \(cause.jsTruthy ? "\(cause!) " : "선행 작업 ")지연으로 \(a.overrunDays ?? 1)일 넘침"
    default:
        return ""
    }
}

struct Reminder: Codable, Hashable, Sendable {
    /// .taskStartReminder or .taskDueReminder
    var key: WebhookEventKey
    var taskId: String
    var date: ISODate
    var time: ISOTime
    /// From `now` until the moment (0 or less = it is that minute or just past).
    var minutesLeft: Int

    init(key: WebhookEventKey, taskId: String = "", date: ISODate, time: ISOTime, minutesLeft: Int) {
        self.key = key
        self.taskId = taskId
        self.date = date
        self.time = time
        self.minutesLeft = minutesLeft
    }
}

/// Reminders due now for tasks with a time: from `lead` minutes before the moment until the moment itself
/// (a short grace after it when `lead` is 0, so a late scan still catches it).
func reminderAlerts(_ items: [PlanItem], _ now: Clock, _ lead: Int, _ keys: [WebhookEventKey] = REMINDER_EVENT_KEYS) -> [Reminder] {
    var out: [Reminder] = []
    let at = clockIndex(now.date, now.minutes)
    let want = Set(keys)
    func check(_ key: WebhookEventKey, _ it: PlanItem, _ date: ISODate?, _ time: ISOTime?) {
        guard want.contains(key), let date, !date.isEmpty, let time, !time.isEmpty else { return }
        let target = clockIndex(date, toMinutes(time))
        let until = lead > 0 ? target : target + 10
        if at >= target - lead && at < until {
            out.append(Reminder(key: key, taskId: it.id, date: date, time: time, minutesLeft: target - at))
        }
    }
    for it in items {
        if it.status == .todo { check(.taskStartReminder, it, it.startDate, it.startTime) }
        if it.status == .todo || it.status == .doing { check(.taskDueReminder, it, it.dueDate, it.dueTime) }
    }
    return out
}

/// "23시간 뒤 마감 · 내일 오전 8:00", "지금 시작 · 오전 10:00"
func reminderSummary(_ r: Reminder, _ today: ISODate) -> String {
    let what = r.key == .taskStartReminder ? "시작" : "마감"
    let day = r.date == today ? "" : "\(formatRelativeKo(r.date, today)) "
    let when = "\(day)\(formatTimeKo(r.time))"
    return r.minutesLeft <= 0 ? "지금 \(what) · \(when)" : "\(formatDurationKo(r.minutesLeft)) 뒤 \(what) · \(when)"
}

// MARK: - incoming

/// Changes an incoming webhook asks for. Date/time fields are tri-state: nil = not sent,
/// `.some(nil)` = clear, `.some(v)` = set.
struct IncomingPatch: Hashable, Sendable {
    var title: String?
    var notes: String?
    var status: TaskStatus?
    var priority: Priority?
    var startDate: ISODate??
    var startTime: ISOTime??
    var dueDate: ISODate??
    var dueTime: ISOTime??
    var fixed: Bool?

    init(
        title: String? = nil, notes: String? = nil, status: TaskStatus? = nil, priority: Priority? = nil,
        startDate: ISODate?? = nil, startTime: ISOTime?? = nil, dueDate: ISODate?? = nil, dueTime: ISOTime?? = nil,
        fixed: Bool? = nil
    ) {
        self.title = title
        self.notes = notes
        self.status = status
        self.priority = priority
        self.startDate = startDate
        self.startTime = startTime
        self.dueDate = dueDate
        self.dueTime = dueTime
        self.fixed = fixed
    }

    /// No field set (`Object.keys(patch).length === 0`).
    var isEmpty: Bool { json.object?.isEmpty ?? true }

    /// The patch as the TS object (set fields only; cleared ones as null).
    var json: JSONValue {
        var o: [String: JSONValue] = [:]
        if let title { o["title"] = .string(title) }
        if let notes { o["notes"] = .string(notes) }
        if let status { o["status"] = .string(status.rawValue) }
        if let priority { o["priority"] = .number(Double(priority)) }
        if let startDate { o["startDate"] = .orNull(startDate) }
        if let startTime { o["startTime"] = .orNull(startTime) }
        if let dueDate { o["dueDate"] = .orNull(dueDate) }
        if let dueTime { o["dueTime"] = .orNull(dueTime) }
        if let fixed { o["fixed"] = .bool(fixed) }
        return .object(o)
    }
}

/// A new task from an incoming webhook.
struct IncomingCreate: Hashable, Sendable {
    var title: String
    var patch: IncomingPatch
    /// A project name or id.
    var project: String?
    /// An email, a member name, a user id or "me".
    var assignee: String?

    init(title: String, patch: IncomingPatch = IncomingPatch(), project: String? = nil, assignee: String? = nil) {
        self.title = title
        self.patch = patch
        self.project = project
        self.assignee = assignee
    }
}

enum IncomingCommand: Hashable, Sendable {
    case create(IncomingCreate)
    case update(task: String, patch: IncomingPatch)

    /// The command as the TS object (`{ kind: 'create', title, … }` / `{ kind: 'update', task, patch }`).
    var json: JSONValue {
        switch self {
        case let .create(c):
            var o = c.patch.json.object ?? [:]
            o["title"] = .string(c.title)
            o["kind"] = "create"
            if let p = c.project { o["project"] = .string(p) }
            if let a = c.assignee { o["assignee"] = .string(a) }
            return .object(o)
        case let .update(task, patch):
            return ["kind": "update", "task": .string(task), "patch": patch.json]
        }
    }
}

enum IncomingParse: Hashable, Sendable {
    case ok(IncomingCommand)
    case error(String)

    var command: IncomingCommand? { if case let .ok(c) = self { return c }; return nil }
    var errorMessage: String? { if case let .error(e) = self { return e }; return nil }
    var isOk: Bool { command != nil }
}

private struct InputError: Error {
    let message: String
}

private func fail(_ msg: String) -> InputError { InputError(message: msg) }

private let STATUS_WORDS: [(JSRegex, TaskStatus)] = [
    (JSRegex("^(완료|끝|done|complete|completed|close|closed|finish|finished|✅)$", ignoreCase: true), .done),
    (JSRegex("^(시작|진행|진행\\s*중|doing|start|started|in[\\s_-]*progress)$", ignoreCase: true), .doing),
    (JSRegex("^(취소|cancel|canceled|cancelled)$", ignoreCase: true), .canceled),
    (JSRegex("^(다시\\s*열기|다시|재개|reopen|reopened|todo|to[\\s_-]*do|할\\s*일)$", ignoreCase: true), .todo),
]

private let RE_STATUS_PUNCT = JSRegex("[.!。]+$")

private func statusWord(_ raw: String) -> TaskStatus? {
    let s = RE_STATUS_PUNCT.replaceFirst(JS.trim(raw), "")
    for (re, status) in STATUS_WORDS where re.test(s) { return status }
    return nil
}

private enum IncomingAction {
    case create, update
    case status(TaskStatus)
}

private let ACTIONS: [String: IncomingAction] = [
    "create": .create, "add": .create, "new": .create,
    "update": .update, "edit": .update,
    "complete": .status(.done), "done": .status(.done), "close": .status(.done),
    "start": .status(.doing), "doing": .status(.doing),
    "cancel": .status(.canceled),
    "reopen": .status(.todo),
]

private let PRIORITY_WORDS: [String: Priority] = [
    "none": 0, "없음": 0,
    "low": 1, "낮음": 1, "p3": 1,
    "medium": 2, "normal": 2, "보통": 2, "중간": 2, "p2": 2,
    "high": 3, "urgent": 3, "높음": 3, "긴급": 3, "p1": 3,
]

private let REF_RE = JSRegex("^#?\\d{1,9}$")
private let UUID_RE = JSRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", ignoreCase: true)

private func str(_ v: JSONValue?, _ field: String, _ max: Int) throws -> String? {
    guard let v, v != .null else { return nil }
    switch v {
    case .string, .number: break
    default: throw fail("\(field): 문자열이어야 합니다")
    }
    let s = JS.trim(JS.string(v))
    if JS.length(s) > max { throw fail("\(field): \(max)자를 넘을 수 없습니다") }
    return s
}

private struct ParseCtx {
    var today: ISODate
    /// The sender's time zone: instants with an offset ("…T06:00:00Z") are read on its clock.
    var timeZone: String?
    /// Minutes past midnight now, in that zone.
    var nowMinutes: Int?
}

private struct DateFieldValue {
    var date: ISODate?
    /// nil = no time given; `.some(nil)` never happens here (kept tri-state for the patch).
    var time: ISOTime??
}

private let RE_NONE_WORD = JSRegex("^(none|없음|null)$", ignoreCase: true)
private let RE_DATE_REST = JSRegex("^[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?$", ignoreCase: true)

/// A date, maybe with a time. nil = not sent.
private func dateField(_ v: JSONValue?, _ field: String, _ ctx: ParseCtx) throws -> DateFieldValue? {
    guard let v else { return nil }
    if v == .null || v == .string("") || v == .bool(false) { return DateFieldValue(date: nil, time: nil) }
    guard case let .string(raw) = v else { throw fail("\(field): YYYY-MM-DD 날짜여야 합니다") }
    let s = JS.trim(raw)
    if RE_NONE_WORD.test(s) { return DateFieldValue(date: nil, time: nil) }
    let head = JS.slice(s, 0, 10)
    if isISODate(head) {
        if JS.length(s) == 10 { return DateFieldValue(date: head, time: nil) }
        if let rest = RE_DATE_REST.exec(JS.slice(s, 10)) {
            let time = "\(rest[1]!):\(rest[2]!)"
            if !isISOTime(time) { throw fail("\(field): 시각 \"\(time)\"이(가) 올바르지 않습니다") }
            // Exactly midnight is how many tools write a plain date ("2026-11-20T00:00:00Z"): keep it a date.
            if time == "00:00" && JS.number(.string(rest[3] ?? "0")) == 0 { return DateFieldValue(date: head, time: nil) }
            if rest[4] != nil, let tz = ctx.timeZone, !tz.isEmpty {
                var isoText = s
                if let r = isoText.range(of: " ") { isoText.replaceSubrange(r, with: "T") }
                if let instant = JS.parseDate(isoText) {
                    let local = nowIn(tz, now: instant)
                    return DateFieldValue(date: local.date, time: .some(fromMinutes(local.minutes)))
                }
            }
            return DateFieldValue(date: head, time: .some(time))
        }
        let u = Array(s.utf16)
        if u.count > 10, u[10] == 0x54 || u[10] == 0x20 { return DateFieldValue(date: head, time: nil) }
    }
    if let phrase = parseDateTimePhrase(s, ctx.today, ctx.nowMinutes) {
        return DateFieldValue(date: phrase.date, time: phrase.time.jsTruthy ? .some(phrase.time) : nil)
    }
    throw fail("\(field): \"\(JS.slice(s, 0, 40))\"을(를) 날짜로 읽지 못했습니다 (예: 2026-11-20, 2026-11-20T15:30, 내일 오후 3시)")
}

private let RE_LOOSE_HM = JSRegex("^(\\d{1,2}):(\\d{2})(?::\\d{2})?$")

/// A time of day. nil = not sent, `.some(nil)` = clear.
private func timeField(_ v: JSONValue?, _ field: String) throws -> ISOTime?? {
    guard let v else { return nil }
    if v == .null || v == .string("") || v == .bool(false) { return .some(nil) }
    guard case let .string(raw) = v else { throw fail("\(field): HH:MM 시각이어야 합니다") }
    let s = JS.trim(raw)
    if RE_NONE_WORD.test(s) { return .some(nil) }
    if let hm = RE_LOOSE_HM.exec(s) {
        let t = "\(JS.padStart(hm[1]!, 2, "0")):\(hm[2]!)"
        if isISOTime(t) { return .some(t) }
    }
    if let t = parseTimePhrase(s) { return .some(t) }
    throw fail("\(field): \"\(JS.slice(s, 0, 40))\"을(를) 시각으로 읽지 못했습니다 (예: 15:30, 오후 3시)")
}

private let RE_LEADING_BANG = JSRegex("^!")
private let RE_PRIORITY_DIGIT = JSRegex("^[0-3]$")

private func priorityField(_ v: JSONValue?) throws -> Priority? {
    guard let v, v != .null, v != .string("") else { return nil }
    if case let .number(n) = v, [0.0, 1, 2, 3].contains(n) { return Int(n) }
    if case let .string(raw) = v {
        let s = RE_LEADING_BANG.replaceFirst(JS.trim(raw).lowercased(), "")
        if RE_PRIORITY_DIGIT.test(s) { return Int(s)! }
        if let p = PRIORITY_WORDS[s] { return p }
    }
    throw fail("priority: 0–3 또는 none·low·medium·high(없음·낮음·보통·높음)여야 합니다")
}

private func statusField(_ v: JSONValue?) throws -> TaskStatus? {
    guard let v, v != .null, v != .string("") else { return nil }
    if case let .string(raw) = v {
        let s = JS.trim(raw).lowercased()
        if let st = TaskStatus(rawValue: s) { return st }
        if let w = statusWord(s) { return w }
    }
    throw fail("status: todo·doing·done·canceled(할 일·진행 중·완료·취소) 중 하나여야 합니다")
}

private func boolField(_ v: JSONValue?, _ field: String) throws -> Bool? {
    guard let v, v != .null, v != .string("") else { return nil }
    if case let .bool(b) = v { return b }
    if v == .string("true") || v == .string("1") || v == .number(1) { return true }
    if v == .string("false") || v == .string("0") || v == .number(0) { return false }
    throw fail("\(field): true 또는 false여야 합니다")
}

private func taskRef(_ v: JSONValue?) throws -> String {
    guard let s = try str(v, "task", 64), !s.isEmpty else { throw fail("task: 바꿀 작업을 \"#12\"처럼 지정하세요") }
    if REF_RE.test(s) {
        var digits = s
        if let r = digits.range(of: "#") { digits.removeSubrange(r) }
        return "#\(digits)"
    }
    if UUID_RE.test(s) { return s }
    throw fail("task: \"\(s)\"은(는) 작업 번호(#12)나 id가 아닙니다")
}

private func patchFrom(_ o: [String: JSONValue], _ ctx: ParseCtx) throws -> IncomingPatch {
    var patch = IncomingPatch()
    if let title = try str(o["title"], "title", 500) {
        if title.isEmpty { throw fail("title: 빈 제목으로 바꿀 수 없습니다") }
        patch.title = title
    }
    func pick(_ keys: String...) -> JSONValue? { o[keys.first { o[$0] != nil } ?? keys[0]] }
    if let notes = pick("notes", "description"), notes != .null { patch.notes = try str(notes, "notes", 20_000) }
    if let status = try statusField(o["status"]) { patch.status = status }
    if let pr = try priorityField(o["priority"]) { patch.priority = pr }

    for side in ["start", "due"] {
        let dateKey = "\(side)Date"
        let timeKey = "\(side)Time"
        let d = try dateField(pick(dateKey, side), dateKey, ctx)
        var date: ISODate?? = nil
        var time: ISOTime?? = nil
        if let d {
            date = .some(d.date)
            if let t = d.time { time = .some(t) }
        }
        if let t = try timeField(pick(timeKey, "\(side)_time"), timeKey) {
            if t.jsTruthy, let d, d.date == nil { throw fail("\(timeKey): 날짜를 지우면서 시각을 정할 수 없습니다") }
            time = .some(t)
        }
        if side == "start" {
            if date != nil { patch.startDate = date }
            if time != nil { patch.startTime = time }
        } else {
            if date != nil { patch.dueDate = date }
            if time != nil { patch.dueTime = time }
        }
    }
    if let fixed = try boolField(o["fixed"], "fixed") { patch.fixed = fixed }
    if case let .some(.some(s)) = patch.startDate, case let .some(.some(d)) = patch.dueDate, !s.isEmpty, !d.isEmpty {
        if s > d { throw fail("시작일은 마감일보다 늦을 수 없습니다") }
        if !spanInOrder(s, patch.startTime ?? nil, d, patch.dueTime ?? nil) { throw fail("시작 시각은 마감 시각보다 늦을 수 없습니다") }
    }
    return patch
}

private let RE_CRLF = JSRegex("\\r\\n?")
private let RE_TEXT_REF = JSRegex("^#(\\d{1,9})(?:\\s+(.+))?$", dotAll: true)

/// Plain text: "보고서 초안 내일 !높음" creates; "#12 완료" or "#12 금요일까지" changes #12.
private func fromText(_ text: String, _ ctx: ParseCtx) throws -> IncomingCommand {
    let raw = JS.trim(RE_CRLF.replaceAll(text, "\n"))
    if raw.isEmpty { throw fail("보낸 내용이 비어 있습니다") }
    let lines = raw.components(separatedBy: "\n")
    let line = JS.trim(lines[0])
    let notes = JS.trim(lines.dropFirst().joined(separator: "\n"))

    if let ref = RE_TEXT_REF.exec(line), notes.isEmpty {
        let task = "#\(ref[1]!)"
        let tail = JS.trim(ref[2] ?? "")
        if tail.isEmpty { throw fail("\"\(task)\" 다음에 할 일을 적으세요. 예: \"\(task) 완료\", \"\(task) 금요일까지\"") }
        if let status = statusWord(tail) { return .update(task: task, patch: IncomingPatch(status: status)) }
        let q = parseQuickAdd(tail, ctx.today, disabled: [.project], nowMinutes: ctx.nowMinutes)
        if q.title.isEmpty && !q.tokens.isEmpty {
            var patch = IncomingPatch()
            if let due = q.dueDate, !due.isEmpty {
                patch.dueDate = .some(due)
                if let t = q.dueTime, !t.isEmpty { patch.dueTime = .some(t) }
            }
            if let start = q.startDate, !start.isEmpty {
                patch.startDate = .some(start)
                if let t = q.startTime, !t.isEmpty { patch.startTime = .some(t) }
            }
            if let p = q.priority { patch.priority = p }
            if q.fixed { patch.fixed = true }
            return .update(task: task, patch: patch)
        }
        throw fail("\"\(task) \(JS.slice(tail, 0, 40))\"을(를) 이해하지 못했습니다. 예: \"\(task) 완료\", \"\(task) 시작\", \"\(task) 금요일까지\", \"\(task) !높음\"")
    }

    let q = parseQuickAdd(line, ctx.today, nowMinutes: ctx.nowMinutes)
    if q.title.isEmpty { throw fail("작업 제목이 없습니다") }
    if JS.length(q.title) > 500 { throw fail("제목은 500자를 넘을 수 없습니다") }
    var patch = IncomingPatch()
    if !notes.isEmpty { patch.notes = JS.slice(notes, 0, 20_000) }
    if let v = q.startDate, !v.isEmpty { patch.startDate = .some(v) }
    if let v = q.startTime, !v.isEmpty { patch.startTime = .some(v) }
    if let v = q.dueDate, !v.isEmpty { patch.dueDate = .some(v) }
    if let v = q.dueTime, !v.isEmpty { patch.dueTime = .some(v) }
    if let p = q.priority { patch.priority = p }
    if q.fixed { patch.fixed = true }
    let project = q.projectName.jsTruthy ? q.projectName : nil
    return .create(IncomingCreate(title: q.title, patch: patch, project: project))
}

private func fromObject(_ o: [String: JSONValue], _ ctx: ParseCtx) throws -> IncomingCommand {
    var actionRaw: String? = nil
    if case let .string(a)? = o["action"] { actionRaw = JS.trim(a).lowercased() }
    if o["action"] != nil && (actionRaw == nil || ACTIONS[actionRaw!] == nil) {
        throw fail("action: create·update·complete·start·cancel·reopen 중 하나여야 합니다")
    }
    let action: IncomingAction? = actionRaw.jsTruthy ? ACTIONS[actionRaw!] : nil
    // `o.task ?? o.ref ?? o.number`: the last one is taken as is (null included); nil = undefined.
    let refValue: JSONValue? = {
        if let t = o["task"], t != .null { return t }
        if let r = o["ref"], r != .null { return r }
        return o["number"]
    }()
    let textValue: String? = [o["text"], o["content"], o["message"]].lazy.compactMap { $0?.string }.first

    var isCreate = false
    var statusAction: TaskStatus? = nil
    switch action {
    case .create?: isCreate = true
    case .update?: break
    case let .status(s)?: statusAction = s
    case nil: isCreate = refValue == nil
    }

    if isCreate {
        if o["title"] == nil || o["title"] == .null {
            if let textValue, action == nil { return try fromText(textValue, ctx) }
            if let textValue {
                let cmd = try fromText(textValue, ctx)
                guard case .create = cmd else { throw fail("action이 create이면 text로 기존 작업을 바꿀 수 없습니다") }
                return cmd
            }
            throw fail("title(작업 제목)이나 text가 필요합니다")
        }
        guard let title = try str(o["title"], "title", 500), !title.isEmpty else { throw fail("title: 제목을 입력하세요") }
        var rest = o
        rest.removeValue(forKey: "title")
        let patch = try patchFrom(rest, ctx)
        let project = try str(JS.coalesce(o["project"], o["projectId"]), "project", 200)
        let assignee = try str(JS.coalesce(o["assignee"], o["assigneeId"]), "assignee", 320)
        return .create(IncomingCreate(
            title: title, patch: patch,
            project: project.jsTruthy ? project : nil,
            assignee: assignee.jsTruthy ? assignee : nil
        ))
    }

    let task = try taskRef(refValue)
    var patch = try patchFrom(o, ctx)
    if let statusAction {
        if let s = patch.status, s != statusAction {
            throw fail("action \"\(actionRaw ?? "")\"과(와) status \"\(s.rawValue)\"가 서로 다릅니다")
        }
        patch.status = statusAction
    }
    if patch.isEmpty {
        throw fail("바꿀 내용이 없습니다. status, dueDate, priority, title 같은 필드를 함께 보내세요")
    }
    return .update(task: task, patch: patch)
}

/// Turn a request body into one command. Accepts plain text (`.string`), `{ text }`, a create body
/// (`{ title, dueDate, priority, project, assignee, … }`) or an update
/// (`{ action: "complete" | "start" | "cancel" | "reopen" | "update", task: "#12", … }`).
func parseIncoming(_ body: JSONValue, _ today: ISODate, timeZone: String? = nil, nowMinutes: Int? = nil) -> IncomingParse {
    let ctx = ParseCtx(today: today, timeZone: timeZone, nowMinutes: nowMinutes)
    do {
        switch body {
        case let .string(s): return .ok(try fromText(s, ctx))
        case let .object(o): return .ok(try fromObject(o, ctx))
        default: return .error("본문은 JSON 객체나 텍스트여야 합니다")
        }
    } catch let e as InputError {
        return .error(e.message)
    } catch {
        return .error("\(error)")
    }
}

// MARK: - API shapes

enum WebhookDeliveryStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case pending, success, failed
}

struct Webhook: Codable, Hashable, Sendable, Identifiable {
    struct LastDelivery: Codable, Hashable, Sendable {
        var status: WebhookDeliveryStatus
        var at: String
        var responseStatus: Int?
    }

    var id: String
    var name: String
    var url: String
    var format: WebhookFormat
    var events: [WebhookEventKey]
    /// nil = every project.
    var projectIds: [String]?
    /// Local hour (0–23) schedule alerts start going out each day.
    var alertHour: Int
    /// How many minutes before a task's start or due time its reminder goes out.
    var remindMinutes: Int
    var timezone: String
    var enabled: Bool
    /// Why the server turned it off (repeated failures).
    var disabledReason: String?
    var failureCount: Int
    var lastDelivery: LastDelivery?
    var createdBy: WebhookNamedRef?
    var createdAt: String
    var updatedAt: String
}

struct WebhookDelivery: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var webhookId: String
    var event: String
    var status: WebhookDeliveryStatus
    var attempts: Int
    var maxAttempts: Int
    var nextAttemptAt: String?
    var lastAttemptAt: String?
    var responseStatus: Int?
    var responseBody: String?
    var error: String?
    var durationMs: Int?
    var createdAt: String
    var payload: WebhookPayload
}

struct IncomingWebhook: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    /// Last characters of the secret URL, to tell hooks apart.
    var hint: String
    /// Where new tasks go (nil = inbox); also the only project it may change, when set.
    var projectId: String?
    var allowUpdates: Bool
    var useCount: Int
    var lastUsedAt: String?
    var lastError: String?
    var lastErrorAt: String?
    var createdBy: WebhookNamedRef?
    var createdAt: String
}

/// GET /api/webhooks
struct WebhooksOverview: Codable, Hashable, Sendable {
    /// Personal space owner, or an organization owner/admin.
    var canManage: Bool
    var webhooks: [Webhook]
    var incoming: [IncomingWebhook]
}

/// POST /api/webhooks → the new webhook and its signing secret (shown once).
struct WebhookCreatedResponse: Codable, Hashable, Sendable {
    var webhook: Webhook
    var secret: String
}

/// PATCH /api/webhooks/:id
struct WebhookResponse: Codable, Hashable, Sendable {
    var webhook: Webhook
}

/// POST /api/webhooks/:id/secret
struct WebhookSecretResponse: Codable, Hashable, Sendable {
    var secret: String
}

/// POST /api/webhooks/:id/test, POST /api/webhooks/:id/deliveries/:deliveryId/redeliver
struct WebhookDeliveryResponse: Codable, Hashable, Sendable {
    var delivery: WebhookDelivery
}

/// GET /api/webhooks/:id/deliveries
struct WebhookDeliveriesResponse: Codable, Hashable, Sendable {
    var deliveries: [WebhookDelivery]
}

/// POST /api/incoming-webhooks → the hook and its secret URL (shown once).
struct IncomingWebhookCreatedResponse: Codable, Hashable, Sendable {
    var incoming: IncomingWebhook
    var url: String
}

/// PATCH /api/incoming-webhooks/:id
struct IncomingWebhookResponse: Codable, Hashable, Sendable {
    var incoming: IncomingWebhook
}

/// POST /api/incoming-webhooks/:id/rotate
struct IncomingWebhookUrlResponse: Codable, Hashable, Sendable {
    var url: String
}

/// DELETE /api/webhooks/:id, DELETE /api/incoming-webhooks/:id
struct OkResponse: Codable, Hashable, Sendable {
    var ok: Bool
}

// MARK: - inputs

/// POST /api/webhooks body.
struct CreateWebhookInput: Codable, Hashable, Sendable {
    var name: String
    var url: String
    /// Defaults to what the URL looks like (Slack, Discord, else JSON).
    var format: WebhookFormat?
    var events: [WebhookEventKey]
    /// nil = not sent, `.some(nil)` = every project, `.some(ids)` = only these.
    var projectIds: [String]??
    var alertHour: Int?
    var remindMinutes: Int?
    var enabled: Bool?

    init(
        name: String, url: String, format: WebhookFormat? = nil, events: [WebhookEventKey],
        projectIds: [String]?? = nil, alertHour: Int? = nil, remindMinutes: Int? = nil, enabled: Bool? = nil
    ) {
        self.name = name
        self.url = url
        self.format = format
        self.events = events
        self.projectIds = projectIds
        self.alertHour = alertHour
        self.remindMinutes = remindMinutes
        self.enabled = enabled
    }

    private enum CodingKeys: String, CodingKey { case name, url, format, events, projectIds, alertHour, remindMinutes, enabled }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        url = try c.decode(String.self, forKey: .url)
        format = try c.decodeIfPresent(WebhookFormat.self, forKey: .format)
        events = try c.decode([WebhookEventKey].self, forKey: .events)
        projectIds = try c.decodeTriState([String].self, forKey: .projectIds)
        alertHour = try c.decodeIfPresent(Int.self, forKey: .alertHour)
        remindMinutes = try c.decodeIfPresent(Int.self, forKey: .remindMinutes)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(url, forKey: .url)
        try c.encodeIfPresent(format, forKey: .format)
        try c.encode(events, forKey: .events)
        try c.encodeTriState(projectIds, forKey: .projectIds)
        try c.encodeIfPresent(alertHour, forKey: .alertHour)
        try c.encodeIfPresent(remindMinutes, forKey: .remindMinutes)
        try c.encodeIfPresent(enabled, forKey: .enabled)
    }

    /// What the server stores: name and URL trimmed, events de-duplicated (first occurrence kept).
    func normalized() -> CreateWebhookInput {
        var out = self
        out.name = JS.trim(name)
        out.url = JS.trim(url)
        var seen = Set<WebhookEventKey>()
        out.events = events.filter { seen.insert($0).inserted }
        return out
    }
}

/// PATCH /api/webhooks/:id body: every field optional.
struct UpdateWebhookInput: Codable, Hashable, Sendable {
    var name: String?
    var url: String?
    var format: WebhookFormat?
    var events: [WebhookEventKey]?
    /// nil = unchanged, `.some(nil)` = every project, `.some(ids)` = only these.
    var projectIds: [String]??
    var alertHour: Int?
    var remindMinutes: Int?
    var enabled: Bool?

    init(
        name: String? = nil, url: String? = nil, format: WebhookFormat? = nil, events: [WebhookEventKey]? = nil,
        projectIds: [String]?? = nil, alertHour: Int? = nil, remindMinutes: Int? = nil, enabled: Bool? = nil
    ) {
        self.name = name
        self.url = url
        self.format = format
        self.events = events
        self.projectIds = projectIds
        self.alertHour = alertHour
        self.remindMinutes = remindMinutes
        self.enabled = enabled
    }

    private enum CodingKeys: String, CodingKey { case name, url, format, events, projectIds, alertHour, remindMinutes, enabled }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        format = try c.decodeIfPresent(WebhookFormat.self, forKey: .format)
        events = try c.decodeIfPresent([WebhookEventKey].self, forKey: .events)
        projectIds = try c.decodeTriState([String].self, forKey: .projectIds)
        alertHour = try c.decodeIfPresent(Int.self, forKey: .alertHour)
        remindMinutes = try c.decodeIfPresent(Int.self, forKey: .remindMinutes)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(url, forKey: .url)
        try c.encodeIfPresent(format, forKey: .format)
        try c.encodeIfPresent(events, forKey: .events)
        try c.encodeTriState(projectIds, forKey: .projectIds)
        try c.encodeIfPresent(alertHour, forKey: .alertHour)
        try c.encodeIfPresent(remindMinutes, forKey: .remindMinutes)
        try c.encodeIfPresent(enabled, forKey: .enabled)
    }
}

/// POST /api/incoming-webhooks body (also PATCH, where every field is optional).
struct CreateIncomingWebhookInput: Codable, Hashable, Sendable {
    var name: String
    /// nil = not sent, `.some(nil)` = inbox, `.some(id)` = that project.
    var projectId: String??
    var allowUpdates: Bool?

    init(name: String, projectId: String?? = nil, allowUpdates: Bool? = nil) {
        self.name = name
        self.projectId = projectId
        self.allowUpdates = allowUpdates
    }

    private enum CodingKeys: String, CodingKey { case name, projectId, allowUpdates }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        projectId = try c.decodeTriState(String.self, forKey: .projectId)
        allowUpdates = try c.decodeIfPresent(Bool.self, forKey: .allowUpdates)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encodeTriState(projectId, forKey: .projectId)
        try c.encodeIfPresent(allowUpdates, forKey: .allowUpdates)
    }
}

/// PATCH /api/incoming-webhooks/:id body.
struct UpdateIncomingWebhookInput: Codable, Hashable, Sendable {
    var name: String?
    var projectId: String??
    var allowUpdates: Bool?

    init(name: String? = nil, projectId: String?? = nil, allowUpdates: Bool? = nil) {
        self.name = name
        self.projectId = projectId
        self.allowUpdates = allowUpdates
    }

    private enum CodingKeys: String, CodingKey { case name, projectId, allowUpdates }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        projectId = try c.decodeTriState(String.self, forKey: .projectId)
        allowUpdates = try c.decodeIfPresent(Bool.self, forKey: .allowUpdates)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeTriState(projectId, forKey: .projectId)
        try c.encodeIfPresent(allowUpdates, forKey: .allowUpdates)
    }
}

// MARK: - input validation (the server's zod rules and messages)

/// Webhook name: trimmed, 1–80 characters.
func webhookNameIssues(_ name: String) -> [String] {
    let s = JS.trim(name)
    var out: [String] = []
    if JS.length(s) < 1 { out.append("이름을 입력하세요") }
    if JS.length(s) > 80 { out.append("이름은 80자까지예요") }
    return out
}

/// Webhook URL: trimmed, http(s), at most 2000 characters.
func webhookUrlIssues(_ url: String) -> [String] {
    let s = JS.trim(url)
    var out: [String] = []
    if JS.length(s) < 1 { out.append("URL을 입력하세요") }
    if JS.length(s) > 2000 { out.append("Too big: expected string to have <=2000 characters") }
    let proto = JSURL(s)?.protocol
    if proto != "https:" && proto != "http:" { out.append("https://로 시작하는 주소여야 합니다") }
    return out
}

/// Every problem the server would report for a create body, in its order.
func createWebhookIssues(_ input: CreateWebhookInput) -> [ValidationIssue] {
    var out: [ValidationIssue] = []
    out += webhookNameIssues(input.name).map { ValidationIssue(message: $0, path: ["name"]) }
    out += webhookUrlIssues(input.url).map { ValidationIssue(message: $0, path: ["url"]) }
    out += webhookEventsIssues(input.events).map { ValidationIssue(message: $0, path: ["events"]) }
    out += webhookSettingsIssues(projectIds: input.projectIds, alertHour: input.alertHour, remindMinutes: input.remindMinutes)
    return out
}

/// Every problem the server would report for an update body.
func updateWebhookIssues(_ input: UpdateWebhookInput) -> [ValidationIssue] {
    var out: [ValidationIssue] = []
    if let name = input.name { out += webhookNameIssues(name).map { ValidationIssue(message: $0, path: ["name"]) } }
    if let url = input.url { out += webhookUrlIssues(url).map { ValidationIssue(message: $0, path: ["url"]) } }
    if let events = input.events { out += webhookEventsIssues(events).map { ValidationIssue(message: $0, path: ["events"]) } }
    out += webhookSettingsIssues(projectIds: input.projectIds, alertHour: input.alertHour, remindMinutes: input.remindMinutes)
    return out
}

/// At least one event (and no more than the catalog holds).
func webhookEventsIssues(_ events: [WebhookEventKey]) -> [String] {
    var out: [String] = []
    if events.isEmpty { out.append("보낼 이벤트를 하나 이상 고르세요") }
    if events.count > WEBHOOK_EVENT_KEYS.count { out.append("Too big: expected array to have <=\(WEBHOOK_EVENT_KEYS.count) items") }
    return out
}

private func webhookSettingsIssues(projectIds: [String]??, alertHour: Int?, remindMinutes: Int?) -> [ValidationIssue] {
    var out: [ValidationIssue] = []
    if case let .some(.some(ids)) = projectIds {
        if ids.isEmpty { out.append(ValidationIssue(message: "프로젝트를 하나 이상 고르세요", path: ["projectIds"])) }
        if ids.count > 500 { out.append(ValidationIssue(message: "Too big: expected array to have <=500 items", path: ["projectIds"])) }
    }
    if let h = alertHour {
        if h < 0 { out.append(ValidationIssue(message: "Too small: expected number to be >=0", path: ["alertHour"])) }
        if h > 23 { out.append(ValidationIssue(message: "Too big: expected number to be <=23", path: ["alertHour"])) }
    }
    if let m = remindMinutes {
        if m < 0 { out.append(ValidationIssue(message: "Too small: expected number to be >=0", path: ["remindMinutes"])) }
        if m > 1440 { out.append(ValidationIssue(message: "Too big: expected number to be <=1440", path: ["remindMinutes"])) }
    }
    return out
}

/// Incoming webhook name: same rule as outgoing names.
func incomingWebhookIssues(name: String) -> [ValidationIssue] {
    webhookNameIssues(name).map { ValidationIssue(message: $0, path: ["name"]) }
}
