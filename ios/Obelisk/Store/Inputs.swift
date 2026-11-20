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
    var assigneeId: String? = nil
    /// Tasks that must finish first (ids).
    var blockedBy: [String] = []

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
        if let assigneeId { o["assigneeId"] = .string(assigneeId) }
        if !blockedBy.isEmpty { o["blockedBy"] = .array(blockedBy.map(JSONValue.string)) }
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
    var assigneeId: String??
    var position: Double?

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
        if let assigneeId { o["assigneeId"] = .orNull(assigneeId) }
        if let position { o["position"] = .number(position) }
        return .object(o)
    }

    /// The optimistic version of the task (what the server will most likely return).
    func applied(to prev: TaskItem) -> TaskItem {
        var t = prev
        if let title { t.title = title }
        if let notes { t.notes = notes }
        if let status, status != prev.status {
            t.status = status
            t.completedAt = status == .done ? ISO8601DateFormatter.obelisk.string(from: Date()) : nil
        }
        if let priority { t.priority = priority }
        if let projectId { t.projectId = projectId }
        if let startDate { t.startDate = startDate }
        if let startTime { t.startTime = startTime }
        if let dueDate { t.dueDate = dueDate }
        if let dueTime { t.dueTime = dueTime }
        if let fixed { t.fixed = fixed }
        if let assigneeId { t.assigneeId = assigneeId }
        if let position { t.position = position }
        // A time goes with its date.
        if t.startDate == nil { t.startTime = nil }
        if t.dueDate == nil { t.dueTime = nil }
        return t
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
