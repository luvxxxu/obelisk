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
    /// The user's running clock (one across all spaces; see AppStore+Time.swift).
    var running: RunningTimer?
    /// Finish-date odds for the open workspace (GET /api/odds), loaded on demand.
    var odds: OddsResponse?
    /// Bumped when time entries change, so open task screens reload their list.
    var timeRevision = 0
    /// Opens the "실제 시간 고치기" sheet for a task (set by the shell, used by the completion toast).
    var editActual: ((String) -> Void)?
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
    /// The session's undo/redo list (toasts' 실행 취소, shake, ⌘Z). Cleared when the workspace changes.
    let history: UndoCenter

    init(toasts: Toasts) {
        self.toasts = toasts
        self.history = UndoCenter(toasts: toasts)
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

    /// A task's people by name, in the order they were added ("전 멤버" for someone who left).
    func assigneeNames(_ t: TaskItem) -> [String] {
        t.assigneeIds.map { memberName($0) ?? "전 멤버" }
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
        if let uid = user?.id, t.createdBy == uid || t.assigneeIds.contains(uid) { return .edit }
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
                let first = self.status != .ready
                self.apply(b)
                if first { Task { await self.refreshRunning() } }
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
        // Another workspace than the one the history was about (the remembered one went away).
        if let w = workspace, w.id != b.workspace.id { history.clear() }
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
        history.clear()
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
        history.clear()
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
        running = nil
        odds = nil
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
        history.clear()
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
        history.clear()
        status = .loading
        odds = nil
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
    //
    // Every task and dependency change below records an undo entry in `history` once the server has
    // accepted it (`record: true`, the default). Undo/redo closures always pass `record: false`, and so
    // does a caller that builds one entry out of several calls (it pushes that entry itself).

    struct TaskResponse: Codable { var task: TaskItem }
    struct TasksResponse: Codable { var tasks: [TaskItem] }

    private func upsert(_ list: [TaskItem]) {
        localWrites += 1
        for t in list { tasks[t.id] = t }
        changed()
    }

    /// Add links the server made or gave back, skipping ones already known.
    private func mergeDeps(_ list: [Dependency]) {
        var known = Set(deps)
        let fresh = list.filter { known.insert($0).inserted }
        guard !fresh.isEmpty else { return }
        localWrites += 1
        deps.append(contentsOf: fresh)
        changed()
    }

    @discardableResult
    func createTask(_ input: NewTask, record: Bool = true) async -> TaskItem? {
        do {
            let r: TaskResponse = try await API.shared.send(.post, "/api/tasks", json: input.json)
            upsert([r.task])
            mergeDeps(input.blockedBy.map { Dependency(taskId: r.task.id, dependsOnId: $0) })
            if record { recordCreated([r.task.id], label: "작업 추가") }
            return r.task
        } catch {
            fail(error, "작업을 만들지 못했습니다")
            return nil
        }
    }

    /// Several tasks at once (duplicates, pasted lines, Jev triage): POST /api/tasks/bulk.
    /// `label` names the undo entry ("작업 3개 붙여넣기"); by default "작업 N개 추가".
    @discardableResult
    func createTasks(_ inputs: [NewTask], projectId: String? = nil, record: Bool = true, label: String? = nil) async -> [TaskItem] {
        struct R: Codable {
            var tasks: [TaskItem]
            /// The links the batch made (servers before 휴지통 didn't send them).
            var dependencies: [Dependency]?
        }
        guard !inputs.isEmpty else { return [] }
        var body: [String: JSONValue] = ["tasks": .array(inputs.map(\.json))]
        if let projectId { body["projectId"] = .string(projectId) }
        do {
            let r: R = try await API.shared.send(.post, "/api/tasks/bulk", json: .object(body))
            upsert(r.tasks)
            if let made = r.dependencies { mergeDeps(made) } else { await refresh() }
            if record, !r.tasks.isEmpty { recordCreated(r.tasks.map(\.id), label: label ?? "작업 \(r.tasks.count)개 추가") }
            return r.tasks
        } catch {
            fail(error, "작업을 만들지 못했습니다")
            return []
        }
    }

    /// Undoing a create moves the new tasks to the trash without a toast of its own; redo brings the
    /// same tasks back.
    @discardableResult
    private func recordCreated(_ ids: [String], label: String) -> UndoCenter.Entry {
        history.push(label, undo: { [weak self] in
            await self?.trashTasks(ids, record: false, quiet: true) ?? false
        }, redo: { [weak self] in
            await self?.restoreTasks(ids, record: false, quiet: true) != nil
        })
    }

    /// 복제: a copy of each task (not done, same dates, waiting on the same tasks), one undo entry.
    @discardableResult
    func duplicateTasks(_ ids: [String]) async -> [TaskItem] {
        var list = ids.compactMap { tasks[$0] }
        guard !list.isEmpty else { return [] }
        guard list.allSatisfy({ canWriteProject($0.projectId) }) else {
            toasts.error(Self.readOnlyMessage)
            return []
        }
        // One bulk request holds at most 100 tasks (the server's limit), as on the web.
        if list.count > Self.maxBatch {
            toasts.show("한 번에 \(Self.maxBatch)개까지 복제할 수 있어요")
            list = Array(list.prefix(Self.maxBatch))
        }
        let inputs = list.map { NewTask(copying: $0, blockedBy: blockers(of: $0.id).map(\.id)) }
        let made = await createTasks(inputs, label: list.count == 1 ? "작업 복제" : "작업 \(list.count)개 복제")
        guard !made.isEmpty else { return [] }
        history.notify(made.count == 1 ? "“\(made[0].title)”을(를) 복제했어요" : "작업 \(made.count)개를 복제했어요", history.latest)
        return made
    }

    /// `label` names the undo entry when the default (what the patch touches) doesn't fit.
    @discardableResult
    func updateTask(_ id: String, _ patch: TaskPatch, record: Bool = true, label: String? = nil) async -> TaskItem? {
        guard let prev = guardEdit(tasks[id]) else { return nil }
        upsert([patch.applied(to: prev)])
        do {
            let r: TaskResponse = try await API.shared.send(.patch, "/api/tasks/\(id)", json: patch.json)
            upsert([r.task])
            // In progress starts the clock on the server; leaving it stops (and records) it.
            if let s = patch.status, s != prev.status, s == .doing || prev.status == .doing {
                timeRevision &+= 1
                Task { await self.refreshRunning() }
            }
            if record {
                let back = patch.reverting(prev)
                let again = patch.redoing(prev, r.task)
                let name = label ?? patch.undoLabel
                // Titles and notes save as you type, and assignees toggle one by one in an open list:
                // one entry per field while you keep at it.
                let key = patch.title != nil || patch.notes != nil || patch.assigneeIds != nil ? "\(name)|\(id)" : nil
                history.push(name, key: key, undo: { [weak self] in
                    await self?.updateTask(id, back, record: false) != nil
                }, redo: { [weak self] in
                    await self?.updateTask(id, again, record: false) != nil
                })
            }
            return r.task
        } catch {
            upsert([prev])
            fail(error)
            return nil
        }
    }

    /// Several edits at once (bulk bar, Jev): each task's PATCH side by side, applied optimistically.
    /// The ones the server refuses roll back; one undo entry covers the ones it accepted.
    @discardableResult
    func patchTasks(_ edits: [TaskEdit], label: String, record: Bool = true) async -> [TaskItem] {
        let list = edits.compactMap { e in tasks[e.id].map { (edit: e, prev: $0) } }
        guard !list.isEmpty else { return [] }
        guard list.allSatisfy({ canEdit($0.prev) }) else {
            toasts.error(Self.readOnlyMessage)
            return []
        }
        upsert(list.map { $0.edit.patch.applied(to: $0.prev) })
        let jobs = list.map { item in
            Task { @MainActor () -> Result<TaskItem, Error> in
                do {
                    let r: TaskResponse = try await API.shared.send(.patch, "/api/tasks/\(item.edit.id)", json: item.edit.patch.json)
                    return .success(r.task)
                } catch {
                    return .failure(error)
                }
            }
        }
        var saved: [TaskItem] = []
        var refused: [TaskItem] = []
        var firstError: Error?
        for (i, job) in jobs.enumerated() {
            switch await job.value {
            case let .success(t): saved.append(t)
            case let .failure(e):
                refused.append(list[i].prev)
                if firstError == nil { firstError = e }
            }
        }
        upsert(saved + refused)
        if let firstError { fail(firstError) }
        if record, !saved.isEmpty {
            let after = Dictionary(saved.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let kept = list.filter { after[$0.edit.id] != nil }
            let forward = kept.map { TaskEdit(id: $0.edit.id, patch: $0.edit.patch.redoing($0.prev, after[$0.edit.id]!)) }
            let back = kept.map { TaskEdit(id: $0.edit.id, patch: $0.edit.patch.reverting($0.prev)) }
            history.push(label, undo: { [weak self] in
                await !(self?.patchTasks(back, label: label, record: false).isEmpty ?? true)
            }, redo: { [weak self] in
                await !(self?.patchTasks(forward, label: label, record: false).isEmpty ?? true)
            })
        }
        return saved
    }

    func toggleDone(_ id: String) async {
        guard let t = guardEdit(tasks[id]) else { return }
        let done = t.status != .done
        var patch = TaskPatch()
        patch.status = done ? .done : .todo
        let wasRunning = running?.task.id == id
        guard let saved = await updateTask(id, patch, record: false) else { return }
        if wasRunning { running = nil }
        if t.status == .doing || saved.actual != t.actual { timeRevision &+= 1 }
        // Taking it back (or doing it again) keeps the completion time it had, not the moment of the undo.
        let back = patch.reverting(t)
        let again = patch.redoing(t, saved)
        let entry = history.push(done ? "완료" : "완료 취소", undo: { [weak self] in
            await self?.updateTask(id, back, record: false) != nil
        }, redo: { [weak self] in
            await self?.updateTask(id, again, record: false) != nil
        })
        guard done else { return }
        Haptics.success()
        // Time was recorded: say how long it really took, with a way to correct it.
        if saved.actual > 0 {
            let estimate = saved.estimateMinutes.map { " (예상 \(formatDurationKo($0)))" } ?? ""
            toasts.show("완료 · 실제 \(formatDurationKo(saved.actual))\(estimate)", action: .init(label: "고치기") { [weak self] in
                self?.editActual?(id)
            })
            return
        }
        let unblocked = dependents(of: id).filter(\.isActive).filter { x in
            blockers(of: x.id).allSatisfy { !$0.isActive }
        }
        let message = unblocked.isEmpty ? "“\(t.title)” 완료" : "완료 · 이제 \(unblocked.count)개 작업을 시작할 수 있어요"
        history.notify(message, entry)
    }

    /// The server takes at most this many changes per reorder or reschedule request; a bigger set goes
    /// in turns (`inTurns`).
    static let maxChanges = 500

    /// Send `items` in turns of `maxChanges`, one request after another, stopping at the first refusal.
    /// Each turn is all or nothing on the server. Returns what went through and the error that stopped it.
    private func inTurns<T>(_ items: [T], _ send: ([T]) async throws -> Void) async -> (sent: [T], error: Error?) {
        var sent: [T] = []
        var start = 0
        while start < items.count {
            let part = Array(items[start ..< min(start + Self.maxChanges, items.count)])
            do {
                try await send(part)
            } catch {
                return (sent, error)
            }
            sent += part
            start += part.count
        }
        return (sent, nil)
    }

    /// Atomically apply a set of date changes (a single task or a previewed cascade).
    /// `changes` items: taskId, startDate, dueDate, and optionally startTime/dueTime (omitted = keep).
    /// The undo entry puts every changed task's dates and times back. More than `maxChanges` go in
    /// turns: if one is refused, the rest roll back, false is returned, and the entry covers what moved.
    @discardableResult
    func reschedule(_ changes: [DateChangeInput], rootId: String? = nil, record: Bool = true, label: String = "날짜 변경") async -> Bool {
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
        let (sent, error) = await inTurns(changes) { part in
            var body: [String: JSONValue] = ["changes": .array(part.map(\.json))]
            // Every turn names the root; the server counts its postpone in the turn that holds it.
            if let rootId { body["rootId"] = .string(rootId) }
            let r: TasksResponse = try await API.shared.send(.post, "/api/tasks/reschedule", json: .object(body))
            upsert(r.tasks)
        }
        if let error {
            let moved = Set(sent.map(\.taskId))
            upsert(prev.filter { !moved.contains($0.id) })
            fail(error)
        }
        if record, !sent.isEmpty {
            let before = undoChanges(sent, prev)
            // The postpone counted once: undo and redo send no root, so taking it back is not another one.
            history.push(label, undo: { [weak self] in
                await self?.reschedule(before, record: false) ?? false
            }, redo: { [weak self] in
                await self?.reschedule(sent, record: false) ?? false
            })
        }
        return error == nil
    }

    struct TaskMove: Sendable {
        var taskId: String
        var position: Double
        var status: TaskStatus?
        /// With status done: the completion time to keep (undo and redo putting a completion back);
        /// nil = the server stamps now.
        var completedAt: String? = nil
    }

    /// What `sendMoves` got through: the moves to redo (with the server's completion times) and to undo.
    struct SentMoves {
        var forward: [TaskMove]
        var back: [TaskMove]
        var ok: Bool
    }

    /// Board moves (manual order, and a new status when a card changes column), applied optimistically.
    @discardableResult
    func moveTasks(_ changes: [TaskMove], record: Bool = true) async -> Bool {
        guard let r = await sendMoves(changes) else { return false }
        if record, !r.forward.isEmpty {
            history.push(r.forward.contains { $0.status != nil } ? "상태 변경" : "순서 변경", undo: { [weak self] in
                await self?.moveTasks(r.back, record: false) ?? false
            }, redo: { [weak self] in
                await self?.moveTasks(r.forward, record: false) ?? false
            })
        }
        return r.ok
    }

    /// POST /api/tasks/reorder, in turns of `maxChanges`: a refused turn and the ones after it roll back
    /// (and say why); what went through stays and is returned for the undo entry. nil = nothing was
    /// sent (view-only tasks).
    func sendMoves(_ changes: [TaskMove]) async -> SentMoves? {
        guard !changes.isEmpty else { return SentMoves(forward: [], back: [], ok: true) }
        let prev = changes.compactMap { tasks[$0.taskId] }
        guard prev.allSatisfy(canEdit) else {
            toasts.error(Self.readOnlyMessage)
            return nil
        }
        let now = ISO8601DateFormatter.obelisk.string(from: Date())
        upsert(changes.compactMap { c in
            guard var t = tasks[c.taskId] else { return nil }
            t.position = c.position
            if let s = c.status, s != t.status {
                t.status = s
                t.completedAt = s == .done ? (c.completedAt ?? now) : nil
            }
            return t
        })
        var after: [String: TaskItem] = [:]
        let (sent, error) = await inTurns(changes) { part in
            let json: JSONValue = ["changes": .array(part.map { c in
                var o: [String: JSONValue] = ["taskId": .string(c.taskId), "position": .number(c.position)]
                if let s = c.status { o["status"] = .string(s.rawValue) }
                if c.status == .done, let at = c.completedAt { o["completedAt"] = .string(at) }
                return .object(o)
            })]
            let r: TasksResponse = try await API.shared.send(.post, "/api/tasks/reorder", json: json)
            upsert(r.tasks)
            for t in r.tasks { after[t.id] = t }
        }
        // A status change starts or stops the clock on the server.
        if sent.contains(where: { $0.status != nil }) { Task { await self.refreshRunning() } }
        if let error {
            let moved = Set(sent.map(\.taskId))
            upsert(prev.filter { !moved.contains($0.id) })
            fail(error)
        }
        let was = Dictionary(prev.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let forward = sent.map { c in
            var c = c
            if c.status == .done, c.completedAt == nil, was[c.taskId]?.status != .done { c.completedAt = after[c.taskId]?.completedAt }
            return c
        }
        let back = sent.compactMap { c in
            was[c.taskId].map { t in
                TaskMove(
                    taskId: c.taskId, position: t.position, status: c.status != nil ? t.status : nil,
                    completedAt: c.status != nil && t.status == .done ? t.completedAt : nil
                )
            }
        }
        return SentMoves(forward: forward, back: back, ok: error == nil)
    }

    /// Move tasks to the trash (POST /api/tasks/delete, all or nothing). They leave the lists at once,
    /// with every link touching them, and come back if the server says no. Unless `quiet`, a toast says
    /// where they went, with 실행 취소. Returns false when nothing was moved.
    @discardableResult
    func trashTasks(_ ids: [String], record: Bool = true, quiet: Bool = false) async -> Bool {
        var seen = Set<String>()
        let list = ids.compactMap { seen.insert($0).inserted ? tasks[$0] : nil }
        guard !list.isEmpty else { return false }
        guard list.allSatisfy(canEdit) else {
            toasts.error(Self.readOnlyMessage)
            return false
        }
        let gone = Set(list.map(\.id))
        let cut = deps.filter { gone.contains($0.taskId) || gone.contains($0.dependsOnId) }
        localWrites += 1
        for id in gone { tasks[id] = nil }
        deps.removeAll { gone.contains($0.taskId) || gone.contains($0.dependsOnId) }
        changed()
        do {
            try await API.shared.send(.post, "/api/tasks/delete", json: ["ids": .array(list.map { .string($0.id) })])
            // A background refresh that started before the call may still list them: drop it.
            localWrites += 1
            trashRevision += 1
        } catch {
            for t in list where tasks[t.id] == nil { tasks[t.id] = t }
            mergeDeps(cut)
            changed()
            fail(error)
            return false
        }
        let moved = list.map(\.id)
        let entry = record ? history.push(list.count == 1 ? "작업 삭제" : "작업 \(list.count)개 삭제", undo: { [weak self] in
            await self?.restoreTasks(moved, record: false, quiet: true) != nil
        }, redo: { [weak self] in
            await self?.trashTasks(moved, record: false, quiet: true) ?? false
        }) : nil
        if !quiet {
            history.notify(list.count == 1 ? "“\(list[0].title)”을(를) 휴지통으로 옮겼어요" : "작업 \(list.count)개를 휴지통으로 옮겼어요", entry)
        }
        return true
    }

    /// Bring tasks back from the trash (POST /api/trash/restore): the same tasks with their ids and
    /// #numbers, re-linked to whatever is still there. nil when the server refused (already said why).
    @discardableResult
    func restoreTasks(_ ids: [String], record: Bool = true, quiet: Bool = false) async -> RestoreResult? {
        guard !ids.isEmpty else { return nil }
        do {
            let r: RestoreResult = try await API.shared.send(.post, "/api/trash/restore", json: ["ids": .array(ids.map { .string($0) })])
            upsert(r.tasks)
            mergeDeps(r.dependencies)
            trashRevision += 1
            // In an organization a task from a deleted project goes back to its maker's (or an assignee's)
            // private inbox: restored, just not into this list.
            // One toast at a time on iOS, so this note rides on the restore toast when there is one.
            let elsewhere = Set(ids).count - r.tasks.count - r.missing.count
            let note = elsewhere > 0 ? "작업 \(elsewhere)개는 만든 사람이나 담당자의 인박스로 되살렸어요" : nil
            guard !r.tasks.isEmpty else {
                if !quiet, let note { toasts.show(note) }
                return r
            }
            let back = r.tasks.map(\.id)
            let entry = record ? history.push("복원", undo: { [weak self] in
                await self?.trashTasks(back, record: false, quiet: true) ?? false
            }, redo: { [weak self] in
                await self?.restoreTasks(back, record: false, quiet: true) != nil
            }) : nil
            if !quiet {
                let done = r.tasks.count == 1 ? "“\(r.tasks[0].title)”을(를) 되살렸어요" : "작업 \(r.tasks.count)개를 되살렸어요"
                history.notify(note.map { "\(done) · \($0)" } ?? done, entry)
            }
            return r
        } catch {
            fail(error, "작업을 되살리지 못했습니다")
            return nil
        }
    }

    @discardableResult
    func addDependency(_ taskId: String, dependsOn: String, record: Bool = true) async -> Bool {
        guard guardEdit(tasks[taskId]) != nil else { return false }
        do {
            try await API.shared.send(.post, "/api/tasks/\(taskId)/dependencies", json: ["dependsOnId": .string(dependsOn)])
            mergeDeps([Dependency(taskId: taskId, dependsOnId: dependsOn)])
            if record {
                history.push("의존 관계 추가", undo: { [weak self] in
                    await self?.removeDependency(taskId, dependsOn: dependsOn, record: false) ?? false
                }, redo: { [weak self] in
                    await self?.addDependency(taskId, dependsOn: dependsOn, record: false) ?? false
                })
            }
            return true
        } catch {
            fail(error)
            return false
        }
    }

    @discardableResult
    func removeDependency(_ taskId: String, dependsOn: String, record: Bool = true) async -> Bool {
        guard guardEdit(tasks[taskId]) != nil else { return false }
        let link = Dependency(taskId: taskId, dependsOnId: dependsOn)
        localWrites += 1
        deps.removeAll { $0 == link }
        changed()
        do {
            try await API.shared.send(.delete, "/api/tasks/\(taskId)/dependencies/\(dependsOn)")
            if record {
                history.push("의존 관계 해제", undo: { [weak self] in
                    await self?.addDependency(taskId, dependsOn: dependsOn, record: false) ?? false
                }, redo: { [weak self] in
                    await self?.removeDependency(taskId, dependsOn: dependsOn, record: false) ?? false
                })
            }
            return true
        } catch {
            mergeDeps([link])
            fail(error)
            return false
        }
    }

    // MARK: - trash (휴지통)

    /// Bumped whenever the trash may have changed here (moved in, restored, purged): the 휴지통 screen reloads.
    private(set) var trashRevision = 0

    struct TrashResponse: Codable { var items: [TrashItem] }
    struct PurgeResponse: Codable { var purged: Int }

    /// GET /api/trash: what this workspace's trash holds that you can see, newest first. nil on failure.
    func fetchTrash() async -> [TrashItem]? {
        do {
            let r: TrashResponse = try await API.shared.get("/api/trash")
            return r.items
        } catch {
            fail(error, "휴지통을 불러오지 못했습니다")
            return nil
        }
    }

    /// Delete these trashed tasks for good (no undo: the screen asks first). Returns how many went.
    @discardableResult
    func purgeTrash(_ ids: [String]) async -> Int? {
        guard !ids.isEmpty else { return 0 }
        do {
            let r: PurgeResponse = try await API.shared.send(.post, "/api/trash/purge", json: ["ids": .array(ids.map { .string($0) })])
            trashRevision += 1
            return r.purged
        } catch {
            fail(error, "영구 삭제하지 못했습니다")
            return nil
        }
    }

    /// 휴지통 비우기: everything in the trash you can see and restore, for good.
    @discardableResult
    func emptyTrash() async -> Int? {
        do {
            let r: PurgeResponse = try await API.shared.send(.post, "/api/trash/empty")
            trashRevision += 1
            return r.purged
        } catch {
            fail(error, "휴지통을 비우지 못했습니다")
            return nil
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
            // Its tasks went to the trash (a restore later lands them in the inbox).
            if deleteTasks { trashRevision += 1 }
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
