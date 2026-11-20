import Foundation

/// What the widget, Siri/Shortcuts, notifications and the share extension read from the snapshot.
extension Snapshot {
    init(bootstrap b: Bootstrap) {
        self.init(
            savedAt: Date(), today: b.today, timezone: b.user.timezone, userId: b.user.id, userName: b.user.name,
            workspace: b.workspace.summary, projects: b.projects, tasks: b.tasks, dependencies: b.dependencies
        )
    }

    /// Today in the user's zone, now (the saved `today` may be from yesterday).
    var currentToday: ISODate { todayIn(timezone) }
    var clock: Clock { clockNow(timezone) }

    var activeTasks: [TaskItem] { tasks.filter(\.isActive) }

    /// 기한 지남, oldest first (web today page).
    var overdueTasks: [TaskItem] {
        sortTasks(selectView(tasks, .overdue, currentToday, clock))
    }

    /// Today's tasks that aren't overdue yet.
    var todayTasks: [TaskItem] {
        let now = clock
        return sortTasks(selectView(tasks, .today, currentToday).filter { !isOverdue($0, currentToday, now) })
    }

    /// Finished today (for "n/m 완료").
    var doneTodayCount: Int {
        tasks.filter { $0.status == .done && completedOn($0, timezone) == currentToday }.count
    }

    /// The forecast for the saved workspace (what the web's 파급 예측 shows).
    var forecastReport: ImpactReport {
        forecast(planItems(tasks), dependencies, currentToday)
    }

    /// Projects the user can add tasks to (nil = inbox is always allowed).
    var writableProjects: [Project] {
        projects.filter { $0.archivedAt == nil && $0.access >= .edit }.sorted { $0.position < $1.position }
    }

    /// Mark a task done (or not) in the saved snapshot after a widget/Siri change, so the widget redraws
    /// right away; the app replaces the snapshot on its next load.
    static func update(task id: String, _ change: (inout TaskItem) -> Void) {
        guard var s = load(), let i = s.tasks.firstIndex(where: { $0.id == id }) else { return }
        change(&s.tasks[i])
        s.savedAt = Date()
        s.save()
    }

    /// Fetch the saved workspace again (used by background refresh and intents when the app isn't running).
    @discardableResult
    static func refresh() async throws -> Snapshot {
        let b: Bootstrap = try await API.shared.get("/api/bootstrap")
        Session.workspaceId = b.workspace.id
        let s = Snapshot(bootstrap: b)
        s.save()
        return s
    }
}

// MARK: - Every space the user works in (for reminders across spaces)

/// GET /api/overview cached in the App Group: the user's own work in every space they belong to.
enum OverviewCache {
    private static var url: URL { AppGroup.containerURL.appendingPathComponent("overview.json") }
    private static let maxAge: TimeInterval = 120

    static func load() -> (overview: Overview, savedAt: Date)? {
        guard let data = try? Data(contentsOf: url),
              let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let date = attrs[.modificationDate] as? Date,
              let o = try? JSONDecoder().decode(Overview.self, from: data) else { return nil }
        return (o, date)
    }

    /// The cached overview, refreshed when older than two minutes (or `force`).
    static func fresh(force: Bool = false) async -> Overview? {
        if !force, let c = load(), Date().timeIntervalSince(c.savedAt) < maxAge { return c.overview }
        guard Session.isSignedIn else { return nil }
        do {
            let o: Overview = try await API.shared.get("/api/overview")
            if let data = try? JSONEncoder().encode(o) { try? data.write(to: url, options: .atomic) }
            return o
        } catch {
            return load()?.overview
        }
    }

    static func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}
