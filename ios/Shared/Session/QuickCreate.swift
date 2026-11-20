import Foundation

/// Creating a task from a phrase outside the app (Siri/Shortcuts, the share sheet), parsed exactly like the
/// composer ("보고서 내일 오후 3시 #블로그 !높음"), into the workspace the app last had open.
enum QuickCreate {
    enum Failure: LocalizedError {
        case signedOut
        case empty
        case server(String)

        var errorDescription: String? {
            switch self {
            case .signedOut: "Obelisk 앱에서 먼저 로그인하세요"
            case .empty: "추가할 내용을 적어 주세요"
            case let .server(m): m
            }
        }
    }

    struct Result: Sendable {
        var task: TaskItem
        /// "내일 오후 3:00 · 블로그" (empty when nothing but a title was given).
        var summary: String
    }

    /// Parse `text`, then POST /api/tasks. `projectId` (when given) wins over a #project in the text.
    static func create(_ text: String, notes: String = "", projectId: String?? = nil) async throws -> Result {
        guard Session.isSignedIn else { throw Failure.signedOut }
        let snapshot = Snapshot.load()
        let tz = snapshot?.timezone ?? TimeZone.current.identifier
        let now = clockNow(tz)
        let parsed = parseQuickAdd(text, now.date, nowMinutes: now.minutes)
        let title = parsed.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw Failure.empty }

        let projects = snapshot?.writableProjects ?? []
        let project: Project? = {
            if let chosen = projectId { return chosen.flatMap { id in projects.first { $0.id == id } } }
            return parsed.projectName.flatMap { matchProject(projects, $0) }
        }()

        var body: [String: JSONValue] = ["title": .string(title)]
        if !notes.isEmpty { body["notes"] = .string(notes) }
        if let p = project { body["projectId"] = .string(p.id) }
        if let v = parsed.startDate { body["startDate"] = .string(v) }
        if let v = parsed.startTime, parsed.startDate != nil { body["startTime"] = .string(v) }
        if let v = parsed.dueDate { body["dueDate"] = .string(v) }
        if let v = parsed.dueTime, parsed.dueDate != nil { body["dueTime"] = .string(v) }
        if let v = parsed.priority { body["priority"] = .number(Double(v)) }
        if parsed.fixed { body["fixed"] = .bool(true) }

        struct R: Decodable { var task: TaskItem }
        let r: R
        do {
            r = try await API.shared.send(.post, "/api/tasks", json: .object(body))
        } catch let e as APIError {
            if e.isUnauthorized { throw Failure.signedOut }
            throw Failure.server(e.message)
        }

        if var s = Snapshot.load(), s.workspace.id == r.task.workspaceId {
            s.tasks.append(r.task)
            s.savedAt = Date()
            s.save()
        }

        var parts: [String] = []
        if let d = r.task.dueDate ?? r.task.startDate {
            let t = r.task.dueDate != nil ? r.task.dueTime : r.task.startTime
            parts.append(withTime(formatRelativeKo(d, now.date), t))
        }
        if let p = project { parts.append(p.name) }
        return Result(task: r.task, summary: parts.joined(separator: " · "))
    }

    /// Mark a task done (or open again) from outside the app.
    static func setDone(_ taskId: String, _ done: Bool) async throws {
        guard Session.isSignedIn else { throw Failure.signedOut }
        do {
            try await API.shared.send(.patch, "/api/tasks/\(taskId)", json: ["status": .string(done ? "done" : "todo")])
        } catch let e as APIError {
            throw e.isUnauthorized ? Failure.signedOut : Failure.server(e.message)
        }
        Snapshot.update(task: taskId) { t in
            t.status = done ? .done : .todo
            t.completedAt = done ? ISO8601DateFormatter().string(from: Date()) : nil
        }
    }
}
