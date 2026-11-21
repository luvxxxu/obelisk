import Foundation

/// Time planning on the store: the running clock, time entries, estimates, finish-date odds and
/// promise dates (web/src/lib/time.ts). Day plans live in their own model (TodaySchedule.swift)
/// because a day spans every space, not just the open one.
extension AppStore {
    struct TaskRunningResponse: Codable {
        var running: RunningTimer?
        var task: TaskItem
    }

    struct RunningResponse: Codable { var running: RunningTimer? }
    struct EntriesResponse: Codable { var entries: [TimeEntry] }
    struct CalibrationResponse: Codable { var calibration: CalibrationSummary }

    /// A task changed by a time call: keep the open workspace's copy current.
    private func took(_ t: TaskItem) {
        if tasks[t.id] != nil || t.workspaceId == workspace?.id {
            tasks[t.id] = t
        }
        timeRevision &+= 1
    }

    // MARK: clock

    func refreshRunning() async {
        guard Session.isSignedIn else { return }
        if let r: RunningResponse = try? await API.shared.get("/api/time/running") {
            if r.running != running { running = r.running }
        }
    }

    /// Start or stop the user's timer on a task. Starting one puts a to-do task in progress and stops
    /// any other clock (one runs at a time, across all spaces).
    @discardableResult
    func timer(_ taskId: String, start: Bool) async -> Bool {
        if let t = tasks[taskId], !canEdit(t) {
            toasts.error(Self.readOnlyMessage)
            return false
        }
        do {
            let r: TaskRunningResponse = try await API.shared.send(
                .post, "/api/time/timer", json: ["taskId": .string(taskId), "action": .string(start ? "start" : "stop")]
            )
            running = r.running
            took(r.task)
            Haptics.tap()
            return true
        } catch {
            report(error, start ? "타이머를 켜지 못했습니다" : "타이머를 멈추지 못했습니다")
            return false
        }
    }

    func timeEntries(_ taskId: String) async -> [TimeEntry]? {
        do {
            let r: EntriesResponse = try await API.shared.get("/api/tasks/\(taskId)/time")
            return r.entries
        } catch {
            report(error, "시간 기록을 불러오지 못했습니다")
            return nil
        }
    }

    /// "30분 했어요": minutes done earlier (today, or `date`).
    @discardableResult
    func logTime(_ taskId: String, minutes: Int, date: ISODate? = nil) async -> Bool {
        var body: [String: JSONValue] = ["taskId": .string(taskId), "minutes": .number(Double(minutes))]
        if let date { body["date"] = .string(date) }
        do {
            let r: TaskResponse = try await API.shared.send(.post, "/api/time/entries", json: .object(body))
            took(r.task)
            return true
        } catch {
            report(error, "시간을 기록하지 못했습니다")
            return false
        }
    }

    func deleteTimeEntry(_ entryId: String) async {
        do {
            let r: TaskResponse = try await API.shared.send(.delete, "/api/time/entries/\(entryId)")
            took(r.task)
            await refreshRunning()
        } catch {
            report(error, "기록을 지우지 못했습니다")
        }
    }

    /// "실제로는 1시간 30분 걸렸어요": the user's own time on the task becomes exactly this.
    @discardableResult
    func setActual(_ taskId: String, minutes: Int) async -> Bool {
        struct R: Codable {
            var task: TaskItem
            var running: RunningTimer?
        }
        do {
            let r: R = try await API.shared.send(.put, "/api/tasks/\(taskId)/actual", json: ["minutes": .number(Double(minutes))])
            took(r.task)
            running = r.running
            return true
        } catch {
            report(error, "실제 시간을 고치지 못했습니다")
            return false
        }
    }

    func setEstimate(_ taskId: String, _ minutes: Int?) async {
        var p = TaskPatch()
        p.estimateMinutes = .some(minutes)
        await updateTask(taskId, p)
        odds = nil
    }

    // MARK: work hours

    @discardableResult
    func saveWorkHours(_ hours: WorkHours) async -> Bool {
        do {
            let r: UserResponse = try await API.shared.send(.put, "/api/auth/me/work-hours", json: hours.json)
            setUser(r.user)
            odds = nil
            return true
        } catch {
            report(error, "일정 계획 설정을 저장하지 못했습니다")
            return false
        }
    }

    func calibration() async -> CalibrationSummary? {
        (try? await API.shared.get("/api/odds/calibration", as: CalibrationResponse.self))?.calibration
    }

    // MARK: odds

    /// Finish-date odds for the open workspace. Cached until something changes (`force` reloads).
    @discardableResult
    func loadOdds(force: Bool = false) async -> OddsResponse? {
        if !force, let odds, odds.today == today { return odds }
        do {
            let r: OddsResponse = try await API.shared.get("/api/odds")
            odds = r
            return r
        } catch {
            if (error as? APIError)?.status == 404 { return nil }
            report(error, "완료 확률을 계산하지 못했습니다")
            return nil
        }
    }

    struct CommitRequest: Hashable {
        var taskId: String?
        var title: String?
        var estimateMinutes: Int?
        var projectId: String?
        var assigneeIds: [String] = []
        var blockedBy: [String] = []
        var date: ISODate?
        var confidence: Double?

        var json: JSONValue {
            var o: [String: JSONValue] = [:]
            if let taskId { o["taskId"] = .string(taskId) }
            if let title, !title.isEmpty { o["title"] = .string(title) }
            if let estimateMinutes { o["estimateMinutes"] = .number(Double(estimateMinutes)) }
            if let projectId { o["projectId"] = .string(projectId) }
            if !assigneeIds.isEmpty { o["assigneeIds"] = .array(assigneeIds.map(JSONValue.string)) }
            if !blockedBy.isEmpty { o["blockedBy"] = .array(blockedBy.map(JSONValue.string)) }
            if let date { o["date"] = .string(date) }
            if let confidence { o["confidence"] = .number(confidence) }
            return .object(o)
        }
    }

    /// When could this be promised, and what would an earlier date cost?
    func commitOdds(_ req: CommitRequest) async throws -> CommitResponse {
        try await API.shared.send(.post, "/api/odds/commit", json: req.json)
    }
}
