import Foundation
import Observation
import SwiftUI

/// The app's single source of truth: a port of web/src/lib/store.ts.
///
/// Holds one workspace snapshot (GET /api/bootstrap), applies writes optimistically and rolls them back
/// when the server says no, and refreshes in the background (AI tools and the web edit the same data).
/// Views read it through `@Environment(AppStore.self)`.
@Observable
@MainActor
final class AppStore {
    /// gated: signed in, but the account isn't let in yet (see `gate`).
    enum Status: Equatable { case idle, loading, ready, unauthenticated, gated, error }

    var status: Status = .idle
    var error: String?
    /// Why a signed-in account can't use the app yet (confirm the address / wait for approval).
    var gate: AccountGate?
    /// Server-wide: the operators' announcement and whether you may create organizations.
    var server: ServerInfo = .legacy
    /// An invite link opened while signed out (server invite osi_… or organization invite): the sign-up
    /// form uses it. Cleared once the form has taken it.
    var pendingSignupInvite: InviteLink?
    var user: User?
    var today: ISODate = AppStore.localToday()
    /// The open workspace (personal space or an organization) and what the user may do there.
    var workspace: Workspace?
    var workspaces: [WorkspaceSummary] = []
    var members: [Member] = []
    var teams: [Team] = []
    var projects: [Project] = []
    var tasks: [String: TaskItem] = [:]
    var deps: [Dependency] = []
    /// Bumped by every applied change (local or from the server): cheap "something changed" signal.
    private(set) var revision = 0
    /// A date edit waiting on the impact sheet (see AppStore+Reschedule.swift).
    var pendingChange: PendingChange?
    /// The user's wall clock (date + minutes in their zone), ticked once a minute by RootView.
    /// Read this instead of running a TimelineView per row: one tick re-renders only what reads it.
    private(set) var now: Clock = clockNow()

    /// Advance the clock (called on the minute and when the app comes to the front).
    func tickClock() {
        let next = clockNow(user?.timezone)
        if next != now { now = next }
        if next.date != today, status == .ready { today = next.date }
    }

    let toasts: Toasts

    init(toasts: Toasts) {
        self.toasts = toasts
    }

    // MARK: - derived

    var taskList: [TaskItem] { Array(tasks.values) }
    var activeTasks: [TaskItem] { tasks.values.filter(\.isActive) }
    var isOrg: Bool { workspace?.kind == .org }
    var timezone: String { user?.timezone ?? TimeZone.current.identifier }

    /// Projects in sidebar order, archived ones left out.
    var openProjects: [Project] {
        projects.filter { $0.archivedAt == nil }.sorted { $0.position < $1.position }
    }

    func project(_ id: String?) -> Project? {
        guard let id else { return nil }
        return projects.first { $0.id == id }
    }

    func task(_ id: String?) -> TaskItem? {
        guard let id else { return nil }
        return tasks[id]
    }

    func memberName(_ id: String?) -> String? {
        guard let id else { return nil }
        return members.first { $0.id == id }?.name
    }

    /// Tasks this one waits for / tasks waiting for this one.
    func blockers(of id: String) -> [TaskItem] {
        deps.filter { $0.taskId == id }.compactMap { tasks[$0.dependsOnId] }
    }

    func dependents(of id: String) -> [TaskItem] {
        deps.filter { $0.dependsOnId == id }.compactMap { tasks[$0.taskId] }
    }

    /// Still waiting on an unfinished task.
    func isBlocked(_ id: String) -> Bool {
        blockers(of: id).contains { $0.isActive }
    }

    // MARK: - permissions (the server enforces; this only hides what you can't do)

    static let readOnlyMessage = "보기 전용 작업이에요. 프로젝트 관리자에게 쓰기 권한을 요청하세요."

    /// The caller's level on a task (packages/core/src/access.ts `taskAccess`).
    func taskAccess(_ t: TaskItem) -> AccessLevel? {
        if let pid = t.projectId { return project(pid)?.access }
        if workspace?.kind ?? .personal == .personal { return .manage }
        if let uid = user?.id, t.createdBy == uid || t.assigneeId == uid { return .edit }
        return nil
    }

    func canEdit(_ t: TaskItem) -> Bool {
        guard let level = taskAccess(t) else { return false }
        return level >= .edit
    }

    /// Can the user add tasks to this project (nil = their inbox)?
    func canWriteProject(_ projectId: String?) -> Bool {
        guard let projectId else { return true }
        guard let level = project(projectId)?.access else { return false }
        return level >= .edit
    }

    var isWorkspaceAdmin: Bool {
        workspace?.role == .owner || workspace?.role == .admin
    }

    private func guardEdit(_ t: TaskItem?) -> TaskItem? {
        guard let t else { return nil }
        if canEdit(t) { return t }
        toasts.error(Self.readOnlyMessage)
        return nil
    }

    private func fail(_ error: Error, _ fallback: String = "변경 사항을 저장하지 못했습니다") {
        if let e = error as? APIError, e.isUnauthorized {
            signedOut()
            return
        }
        if let gate = (error as? APIError)?.gate {
            gated(gate, message: (error as? APIError)?.message)
            return
        }
        if error is CancellationError { return }
        toasts.error((error as? LocalizedError)?.errorDescription ?? fallback)
    }

    // MARK: - loading

    /// Bumped by every local task write. A background refresh that was already in flight when one
    /// happened carries a snapshot from before it; applying it would undo the optimistic change.
    private var localWrites = 0
    /// Bumped on every workspace switch: a response for the previous workspace is thrown away.
    private var generation = 0
    private var inflight: Task<Void, Never>?

    func load(silent: Bool = false) async {
        if let inflight { return await inflight.value }
        guard Session.isSignedIn else {
            status = .unauthenticated
            return
        }
        if !silent { status = status == .ready ? .ready : .loading }
        let gen = generation
        let writes = localWrites
        let job = Task { @MainActor in
            defer { self.inflight = nil }
            do {
                var b: Bootstrap
                do {
                    b = try await API.shared.get("/api/bootstrap")
                } catch let e as APIError where e.isNotFound {
                    // The remembered workspace is gone (left, removed, deleted): fall back to the default one.
                    Session.workspaceId = nil
                    b = try await API.shared.get("/api/bootstrap")
                    if self.workspace != nil { self.toasts.show("그 공간에 더 이상 접근할 수 없어 기본 공간을 열었어요") }
                }
                guard gen == self.generation else { return }
                if self.status == .ready, self.localWrites != writes, self.workspace?.id == b.workspace.id { return }
                self.apply(b)
            } catch {
                guard gen == self.generation else { return }
                if let e = error as? APIError, e.isUnauthorized {
                    self.signedOut()
                } else if let e = error as? APIError, let gate = e.gate {
                    // Signed in, not let in yet: the gate screen instead of an error (even on a background refresh).
                    self.gated(gate, message: e.message)
                } else if !silent || self.status != .ready {
                    self.status = .error
                    self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했습니다"
                }
            }
        }
        inflight = job
        await job.value
    }

    // MARK: - launch cache

    private static var cacheURL: URL { AppGroup.containerURL.appendingPathComponent("bootstrap.json") }

    /// Show the last workspace right away on launch (then `load` refreshes it), so the app opens
    /// instantly and stays readable offline. Returns whether anything was restored.
    @discardableResult
    func restoreFromCache() -> Bool {
        guard status != .ready, Session.isSignedIn,
              let data = try? Data(contentsOf: Self.cacheURL),
              let b = try? JSONDecoder().decode(Bootstrap.self, from: data) else { return false }
        if let ws = Session.workspaceId, ws != b.workspace.id { return false }
        apply(b, fromCache: true)
        today = Self.localToday(b.user.timezone)
        return true
    }

    private func cache(_ b: Bootstrap) {
        guard let data = try? JSONEncoder().encode(b) else { return }
        try? data.write(to: Self.cacheURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func apply(_ b: Bootstrap, fromCache: Bool = false) {
        if !fromCache { cache(b) }
        Session.workspaceId = b.workspace.id
        user = b.user
        today = b.today
        workspace = b.workspace
        workspaces = b.workspaces
        members = b.members
        teams = b.teams
        projects = b.projects
        var map: [String: TaskItem] = [:]
        for t in b.tasks { map[t.id] = t }
        tasks = map
        deps = b.dependencies
        server = b.server ?? .legacy
        gate = nil
        status = .ready
        error = nil
        changed()
    }

    /// The server says this account isn't let in yet. Nothing of the workspace is kept or shown.
    func gated(_ gate: AccountGate, message: String? = nil) {
        if status == .gated, self.gate == gate { return }
        self.gate = gate
        error = message
        workspace = nil
        workspaces = []
        members = []
        teams = []
        projects = []
        tasks = [:]
        deps = []
        Snapshot.clear()
        try? FileManager.default.removeItem(at: Self.cacheURL)
        status = .gated
    }

    /// After changing sharing, membership or settings: reload what this workspace looks like.
    func refresh() async { await load(silent: true) }

    /// Signed out here or the session expired: drop everything.
    func signedOut() {
        generation += 1
        inflight = nil
        Session.signOutLocally()
        Snapshot.clear()
        try? FileManager.default.removeItem(at: Self.cacheURL)
        user = nil
        workspace = nil
        workspaces = []
        members = []
        teams = []
        projects = []
        tasks = [:]
        deps = []
        gate = nil
        server = .legacy
        status = .unauthenticated
        SideEffects.signedOut()
    }

    func logout() async {
        await API.shared.logout()
        signedOut()
    }

    /// Signed in (login or sign-up): load the default (or joined) workspace.
    func signedIn(user: User, workspaceId: String? = nil) async {
        generation += 1
        inflight = nil
        Session.workspaceId = workspaceId
        self.user = user
        today = Self.localToday(user.timezone)
        status = .loading
        await load()
    }

    func setUser(_ u: User) {
        user = u
        today = Self.localToday(u.timezone)
        changed()
    }

    // MARK: - workspaces

    /// Open another workspace. Its data replaces the current one's.
    func switchWorkspace(_ id: String) async {
        if workspace?.id == id, status == .ready { return }
        generation += 1
        inflight = nil
        Session.workspaceId = id
        status = .loading
        projects = []
        tasks = [:]
        deps = []
        members = []
        teams = []
        await load()
    }

    func createWorkspace(name: String) async -> WorkspaceSummary? {
        struct R: Codable { var workspace: WorkspaceSummary }
        do {
            let r: R = try await API.shared.send(.post, "/api/workspaces", json: ["name": .string(name)])
            await switchWorkspace(r.workspace.id)
            return r.workspace
        } catch {
            fail(error, "조직을 만들지 못했습니다")
            return nil
        }
    }

    /// Follow a task link: the task may live in another workspace. Returns the task id to open.
    func resolveTaskLink(_ ref: String) async -> String? {
        struct R: Codable { var task: TaskItem }
        if tasks[ref] != nil { return ref }
        do {
            let r: R = try await API.shared.get("/api/tasks/\(ref)")
            if r.task.workspaceId != workspace?.id { await switchWorkspace(r.task.workspaceId) }
            return r.task.id
        } catch {
            return nil
        }
    }

    // MARK: - tasks

    struct TaskResponse: Codable { var task: TaskItem }
    struct TasksResponse: Codable { var tasks: [TaskItem] }

    private func upsert(_ list: [TaskItem]) {
        localWrites += 1
        for t in list { tasks[t.id] = t }
        changed()
    }

    @discardableResult
    func createTask(_ input: NewTask) async -> TaskItem? {
        do {
            let r: TaskResponse = try await API.shared.send(.post, "/api/tasks", json: input.json)
            upsert([r.task])
            if !input.blockedBy.isEmpty {
                deps.append(contentsOf: input.blockedBy.map { Dependency(taskId: r.task.id, dependsOnId: $0) })
                changed()
            }
            return r.task
        } catch {
            fail(error, "작업을 만들지 못했습니다")
            return nil
        }
    }

    /// Several tasks at once (Jev triage, pasted lists): POST /api/tasks/bulk, then reload deps.
    func createTasks(_ inputs: [NewTask], projectId: String? = nil) async -> [TaskItem] {
        struct R: Codable { var tasks: [TaskItem] }
        var body: [String: JSONValue] = ["tasks": .array(inputs.map(\.json))]
        if let projectId { body["projectId"] = .string(projectId) }
        do {
            let r: R = try await API.shared.send(.post, "/api/tasks/bulk", json: .object(body))
            upsert(r.tasks)
            await refresh()
            return r.tasks
        } catch {
            fail(error, "작업을 만들지 못했습니다")
            return []
        }
    }

    @discardableResult
    func updateTask(_ id: String, _ patch: TaskPatch) async -> TaskItem? {
        guard let prev = guardEdit(tasks[id]) else { return nil }
        upsert([patch.applied(to: prev)])
        do {
            let r: TaskResponse = try await API.shared.send(.patch, "/api/tasks/\(id)", json: patch.json)
            upsert([r.task])
            return r.task
        } catch {
            upsert([prev])
            fail(error)
            return nil
        }
    }

    func toggleDone(_ id: String) async {
        guard let t = guardEdit(tasks[id]) else { return }
        let done = t.status != .done
        var patch = TaskPatch()
        patch.status = done ? .done : .todo
        guard await updateTask(id, patch) != nil, done else { return }
        Haptics.success()
        let unblocked = dependents(of: id).filter(\.isActive).filter { x in
            blockers(of: x.id).allSatisfy { !$0.isActive }
        }
        let message = unblocked.isEmpty ? "“\(t.title)” 완료" : "완료 · 이제 \(unblocked.count)개 작업을 시작할 수 있어요"
        toasts.show(message, action: .init(label: "실행 취소") { [weak self] in
            var undo = TaskPatch()
            undo.status = t.status
            Task { await self?.updateTask(id, undo) }
        })
    }

    /// Atomically apply a set of date changes (a single task or a previewed cascade).
    /// `changes` items: taskId, startDate, dueDate, and optionally startTime/dueTime (omitted = keep).
    @discardableResult
    func reschedule(_ changes: [DateChangeInput], rootId: String? = nil) async -> Bool {
        let prev = changes.compactMap { tasks[$0.taskId] }
        let blocked = prev.filter { !canEdit($0) }
        if !blocked.isEmpty {
            toasts.error(
                blocked.count == prev.count
                    ? Self.readOnlyMessage
                    : "함께 밀리는 작업 중 \(blocked.map { "#\($0.number)" }.joined(separator: ", "))은(는) 보기 전용이라 옮길 수 없어요. ‘이 작업만’ 옮겨 보세요."
            )
            return false
        }
        upsert(changes.compactMap { c in
            guard var t = tasks[c.taskId] else { return nil }
            t.startDate = c.startDate
            t.dueDate = c.dueDate
            t.startTime = c.startDate == nil ? nil : (c.startTime.map { $0 } ?? t.startTime)
            t.dueTime = c.dueDate == nil ? nil : (c.dueTime.map { $0 } ?? t.dueTime)
            return t
        })
        var body: [String: JSONValue] = ["changes": .array(changes.map(\.json))]
        if let rootId { body["rootId"] = .string(rootId) }
        do {
            let r: TasksResponse = try await API.shared.send(.post, "/api/tasks/reschedule", json: .object(body))
            upsert(r.tasks)
            return true
        } catch {
            upsert(prev)
            fail(error)
            return false
        }
    }

    struct TaskMove: Sendable {
        var taskId: String
        var position: Double
        var status: TaskStatus?
    }

    /// Board moves (manual order, and a new status when a card changes column), applied optimistically.
    @discardableResult
    func moveTasks(_ changes: [TaskMove]) async -> Bool {
        guard !changes.isEmpty else { return true }
        let prev = changes.compactMap { tasks[$0.taskId] }
        guard prev.allSatisfy(canEdit) else {
            toasts.error(Self.readOnlyMessage)
            return false
        }
        let now = ISO8601DateFormatter.obelisk.string(from: Date())
        upsert(changes.compactMap { c in
            guard var t = tasks[c.taskId] else { return nil }
            t.position = c.position
            if let s = c.status, s != t.status {
                t.status = s
                t.completedAt = s == .done ? now : nil
            }
            return t
        })
        let json: JSONValue = ["changes": .array(changes.map { c in
            var o: [String: JSONValue] = ["taskId": .string(c.taskId), "position": .number(c.position)]
            if let s = c.status { o["status"] = .string(s.rawValue) }
            return .object(o)
        })]
        do {
            let r: TasksResponse = try await API.shared.send(.post, "/api/tasks/reorder", json: json)
            upsert(r.tasks)
            return true
        } catch {
            upsert(prev)
            fail(error)
            return false
        }
    }

    func deleteTask(_ id: String) async {
        guard let t = guardEdit(tasks[id]) else { return }
        let prevDeps = deps
        localWrites += 1
        tasks[id] = nil
        deps.removeAll { $0.taskId == id || $0.dependsOnId == id }
        changed()
        do {
            try await API.shared.send(.delete, "/api/tasks/\(id)")
            toasts.show("“\(t.title)” 삭제됨")
        } catch {
            tasks[id] = t
            deps = prevDeps
            changed()
            fail(error)
        }
    }

    @discardableResult
    func addDependency(_ taskId: String, dependsOn: String) async -> Bool {
        guard guardEdit(tasks[taskId]) != nil else { return false }
        do {
            try await API.shared.send(.post, "/api/tasks/\(taskId)/dependencies", json: ["dependsOnId": .string(dependsOn)])
            if !deps.contains(where: { $0.taskId == taskId && $0.dependsOnId == dependsOn }) {
                deps.append(Dependency(taskId: taskId, dependsOnId: dependsOn))
                changed()
            }
            return true
        } catch {
            fail(error)
            return false
        }
    }

    func removeDependency(_ taskId: String, dependsOn: String) async {
        guard guardEdit(tasks[taskId]) != nil else { return }
        let prev = deps
        deps.removeAll { $0.taskId == taskId && $0.dependsOnId == dependsOn }
        changed()
        do {
            try await API.shared.send(.delete, "/api/tasks/\(taskId)/dependencies/\(dependsOn)")
        } catch {
            deps = prev
            changed()
            fail(error)
        }
    }

    // MARK: - projects

    struct ProjectResponse: Codable { var project: Project }

    /// `color` nil lets the server pick the next colour, like the web.
    func createProject(name: String, color: ProjectColor? = nil, memberAccess: MemberAccess? = nil) async -> Project? {
        if let w = workspace, !w.canCreateProjects {
            toasts.error("이 조직에서는 소유자와 관리자만 프로젝트를 만들 수 있어요")
            return nil
        }
        var body: [String: JSONValue] = ["name": .string(name)]
        if let color { body["color"] = .string(color.rawValue) }
        if let memberAccess { body["memberAccess"] = .string(memberAccess.rawValue) }
        do {
            let r: ProjectResponse = try await API.shared.send(.post, "/api/projects", json: .object(body))
            projects.append(r.project)
            changed()
            return r.project
        } catch {
            fail(error, "프로젝트를 만들지 못했습니다")
            return nil
        }
    }

    /// PATCH /api/projects/:id with any of name, color, position, archived.
    @discardableResult
    func updateProject(_ id: String, _ patch: JSONValue) async -> Project? {
        do {
            let r: ProjectResponse = try await API.shared.send(.patch, "/api/projects/\(id)", json: patch)
            projects = projects.map { $0.id == id ? r.project : $0 }
            changed()
            return r.project
        } catch {
            fail(error)
            return nil
        }
    }

    struct MoveProjectResult: Codable {
        struct W: Codable { var id: String; var name: String }
        var workspace: W
        var tasks: Int
        var linksCut: Int
    }

    func moveProject(_ id: String, to workspaceId: String) async -> MoveProjectResult? {
        do {
            return try await API.shared.send(.post, "/api/projects/\(id)/move", json: ["workspaceId": .string(workspaceId)])
        } catch {
            fail(error, "프로젝트를 옮기지 못했습니다")
            return nil
        }
    }

    @discardableResult
    func deleteProject(_ id: String, deleteTasks: Bool = false) async -> Bool {
        do {
            try await API.shared.send(.delete, "/api/projects/\(id)?deleteTasks=\(deleteTasks)")
            await load(silent: true)
            return true
        } catch {
            fail(error)
            return false
        }
    }

    // MARK: - helpers

    /// Report an error from a screen's own API call the same way the store does.
    func report(_ error: Error, _ fallback: String = "요청을 처리하지 못했습니다") {
        fail(error, fallback)
    }

    private func changed() {
        revision &+= 1
        scheduleSideEffects()
    }

    private var sideEffectsTask: Task<Void, Never>?

    /// Snapshot for the widget/intents, notifications, widget reloads: coalesced, 0.8s after the last change.
    private func scheduleSideEffects() {
        sideEffectsTask?.cancel()
        sideEffectsTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard let self, !Task.isCancelled, self.status == .ready else { return }
            self.writeSnapshot()
            SideEffects.storeChanged(self)
        }
    }

    func writeSnapshot() {
        guard let user, let workspace else { return }
        Snapshot(
            savedAt: Date(), today: today, timezone: user.timezone, userId: user.id, userName: user.name,
            workspace: workspace.summary, projects: projects, tasks: Array(tasks.values), dependencies: deps
        ).save()
    }

    static func localToday(_ timezone: String? = nil) -> ISODate {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timezone.flatMap(TimeZone.init(identifier:)) ?? .current
        let c = cal.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }
}

extension ISO8601DateFormatter {
    /// "2026-11-19T06:33:00.567Z", like JS Date.toISOString().
    static let obelisk: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static let obeliskNoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Parse server timestamps with or without fractional seconds.
    static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        return obelisk.date(from: s) ?? obeliskNoFraction.date(from: s)
    }
}
