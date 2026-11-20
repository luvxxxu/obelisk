import Foundation

// The parts of packages/core/src/schemas.ts the app needs: the date/time span rules (with the server's
// messages) and the request bodies that carry Core types. Other bodies are plain JSON (see JSONValue).

/// One problem with an input field, as the server's validation reports it.
struct ValidationIssue: Codable, Hashable, Sendable {
    var message: String
    var path: [String]
}

/// Times need their date, and start may not come after due. Same messages as the server.
func spanIssues(startDate: ISODate? = nil, startTime: ISOTime? = nil, dueDate: ISODate? = nil, dueTime: ISOTime? = nil) -> [ValidationIssue] {
    var out: [ValidationIssue] = []
    if startTime.jsTruthy && !startDate.jsTruthy { out.append(ValidationIssue(message: "시작 시각은 시작일과 함께 정하세요", path: ["startTime"])) }
    if dueTime.jsTruthy && !dueDate.jsTruthy { out.append(ValidationIssue(message: "마감 시각은 마감일과 함께 정하세요", path: ["dueTime"])) }
    if out.isEmpty, startDate.jsTruthy, dueDate.jsTruthy, startDate! > dueDate! {
        out.append(ValidationIssue(message: "시작일은 마감일보다 늦을 수 없습니다", path: ["startDate"]))
    } else if out.isEmpty, !spanInOrder(startDate, startTime, dueDate, dueTime) {
        out.append(ValidationIssue(message: "시작 시각은 마감 시각보다 늦을 수 없습니다", path: ["startTime"]))
    }
    return out
}

/// `spanIssues` for a task's own fields.
func spanIssues<T: TimedSpanLike>(_ v: T) -> [ValidationIssue] {
    spanIssues(startDate: v.startDate, startTime: v.startTime, dueDate: v.dueDate, dueTime: v.dueTime)
}

/// A task title: trimmed, 1–500 characters.
func taskTitleIssues(_ title: String) -> [String] {
    let s = JS.trim(title)
    var out: [String] = []
    if JS.length(s) < 1 { out.append("제목을 입력하세요") }
    if JS.length(s) > 500 { out.append("Too big: expected string to have <=500 characters") }
    return out
}

/// POST /api/tasks/reschedule body: apply a precomputed set of date changes atomically.
struct RescheduleInput: Codable, Hashable, Sendable {
    var rootId: String?
    /// 1–500 changes.
    var changes: [DateChange]

    init(rootId: String? = nil, changes: [DateChange]) {
        self.rootId = rootId
        self.changes = changes
    }
}

/// One card's new manual position (and optionally status) on a board.
struct ReorderChange: Codable, Hashable, Sendable {
    var taskId: String
    var position: Double
    var status: TaskStatus?

    init(taskId: String, position: Double, status: TaskStatus? = nil) {
        self.taskId = taskId
        self.position = position
        self.status = status
    }
}

/// POST /api/tasks/reorder body.
struct ReorderTasksInput: Codable, Hashable, Sendable {
    var changes: [ReorderChange]
}

/// POST /api/impact/simulate body: exactly one of `days` (-365…365) or `toDate`.
struct DelayInput: Codable, Hashable, Sendable {
    var taskId: String
    var days: Int?
    var toDate: ISODate?

    init(taskId: String, days: Int? = nil, toDate: ISODate? = nil) {
        self.taskId = taskId
        self.days = days
        self.toDate = toDate
    }
}

/// POST /api/impact/postpone body: exactly one of `days` or `toDate`; `cascade` moves what it pushes too.
struct PostponeInput: Codable, Hashable, Sendable {
    var taskId: String
    var days: Int?
    var toDate: ISODate?
    var cascade: Bool

    init(taskId: String, days: Int? = nil, toDate: ISODate? = nil, cascade: Bool = true) {
        self.taskId = taskId
        self.days = days
        self.toDate = toDate
        self.cascade = cascade
    }
}

/// The server's rule for DelayInput / PostponeInput: one of days or toDate, not both, not neither.
func delayInputIssues(days: Int?, toDate: ISODate?) -> [String] {
    (days == nil) != (toDate == nil) ? [] : ["days 또는 toDate 중 하나만 지정하세요"]
}
