import Foundation
@preconcurrency import UserNotifications

/// What the user wants to be reminded of (설정 › 알림). Stored in the App Group so background refresh sees it.
struct ReminderPrefs: Equatable {
    /// A notification before a task's start time.
    var start = true
    /// A notification before a task's due time.
    var due = true
    /// Minutes before the moment (REMINDER_LEAD_OPTIONS; the web's webhook default is 30).
    var lead = 10
    /// A morning summary of what's due and overdue.
    var digest = true
    /// Hour of the morning summary, 0…23.
    var digestHour = 9

    private static let key = "obelisk.reminders"

    static var current: ReminderPrefs {
        get {
            let d = AppGroup.defaults
            guard let o = d.dictionary(forKey: key) else { return ReminderPrefs() }
            var p = ReminderPrefs()
            p.start = o["start"] as? Bool ?? p.start
            p.due = o["due"] as? Bool ?? p.due
            p.lead = o["lead"] as? Int ?? p.lead
            p.digest = o["digest"] as? Bool ?? p.digest
            p.digestHour = o["digestHour"] as? Int ?? p.digestHour
            return p
        }
        set {
            AppGroup.defaults.set(
                ["start": newValue.start, "due": newValue.due, "lead": newValue.lead,
                 "digest": newValue.digest, "digestHour": newValue.digestHour],
                forKey: key
            )
        }
    }

    var anything: Bool { start || due || digest }
}

/// Local notifications for task start and due times, plus a morning summary. Rebuilt from scratch on every
/// sync (the app's data changed, the app came to the front, background refresh), from the user's own work in
/// every space (GET /api/overview) with the open workspace's live edits on top.
@MainActor
enum Reminders {
    static let category = "obelisk.task"
    static let completeAction = "obelisk.complete"
    static let snoozeAction = "obelisk.snooze"
    private static let prefix = "obelisk."
    /// iOS keeps at most 64 pending notifications per app.
    private static let cap = 60
    private static let horizonDays = 14

    private static var syncTask: Task<Void, Never>?

    /// Called by AppStore 0.8 s after its data changes.
    static func sync(_ store: AppStore) {
        guard store.status == .ready, let user = store.user else { return }
        let live = Array(store.tasks.values)
        let projects = Dictionary(store.projects.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        let tz = user.timezone
        syncTask?.cancel()
        syncTask = Task {
            let overview = await OverviewCache.fresh()
            guard !Task.isCancelled else { return }
            await schedule(live: live, overview: overview, projectNames: projects, timezone: tz)
        }
    }

    /// Background refresh: no store, just the saved snapshot and a fresh overview.
    static func sync(snapshot: Snapshot) async {
        let overview = await OverviewCache.fresh(force: true)
        let projects = Dictionary(snapshot.projects.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        await schedule(live: snapshot.tasks, overview: overview, projectNames: projects, timezone: snapshot.timezone)
    }

    static func clearAll() {
        syncTask?.cancel()
        OverviewCache.clear()
        Task {
            let center = UNUserNotificationCenter.current()
            let ids = await center.pendingIdentifiers().filter { $0.hasPrefix(prefix) }
            center.removePendingNotificationRequests(withIdentifiers: ids)
        }
    }

    static func registerCategories() {
        let complete = UNNotificationAction(identifier: completeAction, title: "완료", options: [])
        let snooze = UNNotificationAction(identifier: snoozeAction, title: "10분 뒤 다시 알림", options: [])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: category, actions: [complete, snooze], intentIdentifiers: [], options: []),
        ])
    }

    /// Ask once, the first time there is something worth notifying about.
    static func authorize() async -> Bool {
        let center = UNUserNotificationCenter.current()
        switch await center.authorizationStatus() {
        case .authorized, .provisional, .ephemeral: return true
        case .denied: return false
        default: return await center.requestAuthorizationOnce()
        }
    }

    static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().authorizationStatus()
    }

    // MARK: - building the schedule

    private struct Pending {
        var id: String
        var fire: Date
        var title: String
        var body: String
        var taskId: String?
    }

    private static func schedule(live: [TaskItem], overview: Overview?, projectNames: [String: String], timezone tz: String) async {
        let prefs = ReminderPrefs.current
        let center = UNUserNotificationCenter.current()
        let existing = await center.pendingIdentifiers().filter { $0.hasPrefix(prefix) }

        // Own work in every space, with this workspace's live (possibly unsynced) edits on top.
        var byId: [String: TaskItem] = [:]
        var names = projectNames
        if let overview {
            for t in overview.tasks { byId[t.task.id] = t.task }
            for p in overview.projects where names[p.id] == nil { names[p.id] = p.name }
        }
        let liveIds = Set(live.map(\.id))
        for t in live { byId[t.id] = t }
        // Tasks of the open workspace that were deleted locally are gone from `live`; drop their overview copy.
        if let ws = live.first?.workspaceId {
            byId = byId.filter { $0.value.workspaceId != ws || liveIds.contains($0.key) }
        }
        let tasks = byId.values.filter(\.isActive)

        var out: [Pending] = []
        let now = Date()
        let horizon = now.addingTimeInterval(TimeInterval(horizonDays) * 86_400)
        let today = todayIn(tz)

        func add(_ key: WebhookEventKey, _ t: TaskItem, _ date: ISODate, _ time: ISOTime) {
            guard let moment = absoluteDate(date, time, tz) else { return }
            let fire = moment.addingTimeInterval(TimeInterval(-prefs.lead * 60))
            guard fire > now, fire < horizon else { return }
            let fireDay = todayIn(tz, now: fire)
            var body = reminderSummary(Reminder(key: key, taskId: t.id, date: date, time: time, minutesLeft: prefs.lead), fireDay)
            if let p = t.projectId.flatMap({ names[$0] }) { body += " · \(p)" }
            out.append(Pending(
                id: "\(prefix)\(key == .taskStartReminder ? "start" : "due").\(t.id)",
                fire: fire, title: t.title, body: body, taskId: t.id
            ))
        }

        for t in tasks {
            if prefs.start, let d = t.startDate, let tm = t.startTime { add(.taskStartReminder, t, d, tm) }
            if prefs.due, let d = t.dueDate, let tm = t.dueTime { add(.taskDueReminder, t, d, tm) }
        }

        if prefs.digest {
            for offset in 0 ..< 7 {
                let day = addDays(today, offset)
                guard let fire = absoluteDate(day, fromMinutes(prefs.digestHour * 60), tz), fire > now else { continue }
                let due = tasks.filter { $0.dueDate == day }.sorted { compareTasks($0, $1) < 0 }
                let overdue = tasks.filter { ($0.dueDate.map { $0 < day } ?? false) }
                guard !due.isEmpty || !overdue.isEmpty else { continue }
                var parts: [String] = []
                if !due.isEmpty { parts.append("오늘 마감 \(due.count)개") }
                if !overdue.isEmpty { parts.append("기한 지남 \(overdue.count)개") }
                let names = (due + overdue.sorted { compareTasks($0, $1) < 0 }).prefix(3).map(\.title)
                out.append(Pending(
                    id: "\(prefix)digest.\(day)",
                    fire: fire,
                    title: offset == 0 ? "오늘 할 일" : "\(formatRelativeKo(day, today)) 할 일",
                    body: "\(parts.joined(separator: " · ")) · \(names.joined(separator: ", "))",
                    taskId: nil
                ))
            }
        }

        out.sort { $0.fire < $1.fire }
        out = Array(out.prefix(cap))

        center.removePendingNotificationRequests(withIdentifiers: existing)
        guard !out.isEmpty, prefs.anything, await authorize() else { return }
        for p in out {
            let content = UNMutableNotificationContent()
            content.title = p.title
            content.body = p.body
            content.sound = .default
            if let id = p.taskId {
                content.userInfo = ["taskId": id]
                content.categoryIdentifier = category
                content.threadIdentifier = id
            } else {
                content.threadIdentifier = "digest"
            }
            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: p.fire)
            let req = UNNotificationRequest(identifier: p.id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: comps, repeats: false))
            await center.addRequest(req)
        }
    }

    /// "2026-11-20" + "15:00" in the user's zone → an absolute moment.
    static func absoluteDate(_ date: ISODate, _ time: ISOTime, _ tz: String) -> Date? {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: tz) ?? .current
        let d = date.split(separator: "-").compactMap { Int($0) }
        let t = time.split(separator: ":").compactMap { Int($0) }
        guard d.count == 3, t.count == 2 else { return nil }
        return cal.date(from: DateComponents(year: d[0], month: d[1], day: d[2], hour: t[0], minute: t[1]))
    }

    /// "10분 뒤 다시 알림": the same notification again in ten minutes.
    static func snooze(_ content: UNNotificationContent, taskId: String) async {
        let c = (content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        let req = UNNotificationRequest(
            identifier: "\(prefix)snooze.\(taskId).\(Int(Date().timeIntervalSince1970))",
            content: c,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 600, repeats: false)
        )
        await UNUserNotificationCenter.current().addRequest(req)
    }
}

/// Callback-based UNUserNotificationCenter calls wrapped by hand: the SDK's own async versions
/// (`pendingNotificationRequests()` at least) never resumed when awaited from the main actor here.
extension UNUserNotificationCenter {
    func pendingIdentifiers() async -> [String] {
        await withCheckedContinuation { cont in
            getPendingNotificationRequests { reqs in cont.resume(returning: reqs.map(\.identifier)) }
        }
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await withCheckedContinuation { cont in
            getNotificationSettings { s in cont.resume(returning: s.authorizationStatus) }
        }
    }

    func requestAuthorizationOnce() async -> Bool {
        await withCheckedContinuation { cont in
            requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in cont.resume(returning: ok) }
        }
    }

    func addRequest(_ req: UNNotificationRequest) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            add(req) { _ in cont.resume() }
        }
    }
}
