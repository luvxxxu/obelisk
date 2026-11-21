import Foundation

/// POST /api/tasks body (createTaskInput in packages/core/src/schemas.ts).
struct NewTask: Hashable, Sendable {
    var title: String
    var notes: String = ""
    var status: TaskStatus? = nil
    var priority: Priority? = nil
    var projectId: String? = nil
    var startDate: ISODate? = nil
    var startTime: ISOTime? = nil
    var dueDate: ISODate? = nil
    var dueTime: ISOTime? = nil
    var fixed: Bool = false
    /// Who works on it (empty = nobody).
    var assigneeIds: [String] = []
    /// Tasks that must finish first (ids).
    var blockedBy: [String] = []
    /// Minutes it should take.
    var estimateMinutes: Int? = nil

    var json: JSONValue {
        var o: [String: JSONValue] = ["title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines))]
        if !notes.isEmpty { o["notes"] = .string(notes) }
        if let status { o["status"] = .string(status.rawValue) }
        if let priority { o["priority"] = .number(Double(priority)) }
        if let projectId { o["projectId"] = .string(projectId) }
        if let startDate { o["startDate"] = .string(startDate) }
        if let startTime, startDate != nil { o["startTime"] = .string(startTime) }
        if let dueDate { o["dueDate"] = .string(dueDate) }
        if let dueTime, dueDate != nil { o["dueTime"] = .string(dueTime) }
        if fixed { o["fixed"] = .bool(true) }
        if !assigneeIds.isEmpty { o["assigneeIds"] = .array(assigneeIds.map(JSONValue.string)) }
        if !blockedBy.isEmpty { o["blockedBy"] = .array(blockedBy.map(JSONValue.string)) }
        if let estimateMinutes { o["estimateMinutes"] = .number(Double(estimateMinutes)) }
        return .object(o)
    }
}

/// PATCH /api/tasks/:id body. A field left `nil` is not sent; `.some(nil)` sends JSON null (clears it).
///
///     var p = TaskPatch(); p.dueDate = .some(nil)   // clear the due date (and its time)
///     var p = TaskPatch(); p.dueDate = "2026-11-20"; p.dueTime = "15:30"
struct TaskPatch: Hashable, Sendable {
    var title: String?
    var notes: String?
    var status: TaskStatus?
    var priority: Priority?
    var projectId: String??
    var startDate: ISODate??
    var startTime: ISOTime??
    var dueDate: ISODate??
    var dueTime: ISOTime??
    var fixed: Bool?
    /// The whole set of assignees: replaces who was assigned (`[]` = nobody).
    var assigneeIds: [String]?
    var position: Double?
    /// Minutes it should take (`.some(nil)` clears it).
    var estimateMinutes: Int??
    /// With status done: the completion time to keep (undo and redo putting a completion back). Sent
    /// only with that status; nil = the server stamps now.
    var completedAt: String?

    init() {}

    var isEmpty: Bool { json.object?.isEmpty ?? true }

    var json: JSONValue {
        var o: [String: JSONValue] = [:]
        if let title { o["title"] = .string(title) }
        if let notes { o["notes"] = .string(notes) }
        if let status { o["status"] = .string(status.rawValue) }
        if let priority { o["priority"] = .number(Double(priority)) }
        if let projectId { o["projectId"] = .orNull(projectId) }
        if let startDate { o["startDate"] = .orNull(startDate) }
        if let startTime { o["startTime"] = .orNull(startTime) }
        if let dueDate { o["dueDate"] = .orNull(dueDate) }
        if let dueTime { o["dueTime"] = .orNull(dueTime) }
        if let fixed { o["fixed"] = .bool(fixed) }
        if let assigneeIds { o["assigneeIds"] = .array(assigneeIds.map(JSONValue.string)) }
        if let position { o["position"] = .number(position) }
        if let estimateMinutes { o["estimateMinutes"] = estimateMinutes.map { .number(Double($0)) } ?? .null }
        if status == .done, let completedAt { o["completedAt"] = .string(completedAt) }
        return .object(o)
    }

    /// The optimistic version of the task (what the server will most likely return).
    func applied(to prev: TaskItem) -> TaskItem {
        var t = prev
        if let title { t.title = title }
        if let notes { t.notes = notes }
        if let status, status != prev.status {
            t.status = status
            t.completedAt = status == .done ? (completedAt ?? ISO8601DateFormatter.obelisk.string(from: Date())) : nil
        }
        if let priority { t.priority = priority }
        if let projectId { t.projectId = projectId }
        if let startDate { t.startDate = startDate }
        if let startTime { t.startTime = startTime }
        if let dueDate { t.dueDate = dueDate }
        if let dueTime { t.dueTime = dueTime }
        if let fixed { t.fixed = fixed }
        if let assigneeIds { t.assigneeIds = assigneeIds }
        if let position { t.position = position }
        if let estimateMinutes { t.estimateMinutes = estimateMinutes }
        // A time goes with its date.
        if t.startDate == nil { t.startTime = nil }
        if t.dueDate == nil { t.dueTime = nil }
        return t
    }

    /// The patch that puts back what this one changes on `prev` (실행 취소). A touched date brings its
    /// time back with it, since the server drops a time whose date goes away.
    func reverting(_ prev: TaskItem) -> TaskPatch {
        var p = TaskPatch()
        if title != nil { p.title = prev.title }
        if notes != nil { p.notes = prev.notes }
        if status != nil {
            p.status = prev.status
            if prev.status == .done { p.completedAt = prev.completedAt }
        }
        if priority != nil { p.priority = prev.priority }
        if projectId != nil { p.projectId = .some(prev.projectId) }
        if startDate != nil || startTime != nil {
            p.startDate = .some(prev.startDate)
            p.startTime = .some(prev.startTime)
        }
        if dueDate != nil || dueTime != nil {
            p.dueDate = .some(prev.dueDate)
            p.dueTime = .some(prev.dueTime)
        }
        if fixed != nil { p.fixed = prev.fixed }
        if assigneeIds != nil { p.assigneeIds = prev.assigneeIds }
        if position != nil { p.position = prev.position }
        if estimateMinutes != nil { p.estimateMinutes = .some(prev.estimateMinutes) }
        return p
    }

    /// This patch again (다시 실행): a completion keeps the time the server gave it (`after`), not the
    /// moment of the redo.
    func redoing(_ prev: TaskItem, _ after: TaskItem) -> TaskPatch {
        var p = self
        if status == .done, prev.status != .done, completedAt == nil { p.completedAt = after.completedAt }
        return p
    }

    /// What the undo history calls this edit ("제목 변경", "우선순위 변경").
    var undoLabel: String {
        if title != nil { return "제목 변경" }
        if notes != nil { return "메모 변경" }
        if let status { return status == .done ? "완료" : "상태 변경" }
        if priority != nil { return "우선순위 변경" }
        if projectId != nil { return "프로젝트 이동" }
        if startDate != nil || dueDate != nil || startTime != nil || dueTime != nil { return "날짜 변경" }
        if assigneeIds != nil { return "담당자 변경" }
        if fixed != nil { return "고정 변경" }
        if position != nil { return "순서 변경" }
        if estimateMinutes != nil { return "예상 시간 변경" }
        return "작업 수정"
    }
}

/// One task's part of a bulk edit (`AppStore.patchTasks`).
struct TaskEdit: Hashable, Sendable {
    var id: String
    var patch: TaskPatch
}

extension NewTask {
    /// A copy of an existing task (복제): same content, dates and links to what it waits for, not done.
    init(copying t: TaskItem, blockedBy: [String] = []) {
        self.init(title: t.title)
        notes = t.notes
        priority = t.priority
        projectId = t.projectId
        startDate = t.startDate
        startTime = t.startTime
        dueDate = t.dueDate
        dueTime = t.dueTime
        fixed = t.fixed
        assigneeIds = t.assigneeIds
        self.blockedBy = blockedBy
    }
}

/// One entry of POST /api/tasks/reschedule is Core's `DateChange` (times: nil = keep, `.some(nil)` = clear).
typealias DateChangeInput = DateChange

extension DateChange {
    var json: JSONValue {
        var o: [String: JSONValue] = [
            "taskId": .string(taskId),
            "startDate": .orNull(startDate),
            "dueDate": .orNull(dueDate),
        ]
        if let startTime { o["startTime"] = .orNull(startTime) }
        if let dueTime { o["dueTime"] = .orNull(dueTime) }
        return .object(o)
    }
}
