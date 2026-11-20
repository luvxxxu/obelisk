import Foundation
import Observation
import SwiftUI

/// The Korean message for a failed Jev call (web lib/jev.ts `jevMessage`): the server's own words, or a fallback.
func jevMessage(_ error: Error, _ fallback: String = "Jev에 묻지 못했어요") -> String {
    if error is CancellationError { return fallback }
    let message = (error as? LocalizedError)?.errorDescription ?? ""
    return message.isEmpty ? fallback : message
}

/// Jev in the app: a port of web/src/lib/jev.ts.
///
/// Settings, the shared priority result (the home strip, the priority dialog and auto-apply all read the
/// same one) and helpers that apply a suggestion through the ordinary task endpoints, so permissions and
/// the activity log work exactly as for a manual edit. Views read `JevCenter.shared` directly (it is
/// `@Observable`); the store comes from the view's environment.
@Observable
@MainActor
final class JevCenter {
    static let shared = JevCenter()

    enum Phase: Equatable { case idle, loading, ready, error }

    /// The plan the current result answers (workspace, day and every active task's Jev-relevant fields).
    private(set) var key: String?
    private(set) var phase: Phase = .idle
    private(set) var data: PrioritiesResult?
    private(set) var error: String?
    /// Bumped whenever a new result arrives.
    private(set) var revision = 0

    @ObservationIgnored private var inflight: Task<Void, Never>?
    /// Tasks auto-apply already filled this session (each at most once).
    @ObservationIgnored private var applied = Set<String>()

    private init() {}

    // MARK: - settings

    /// PUT /api/jev/settings. Updates the signed-in user and forgets the old result.
    /// The key never leaves this call: it is not logged, stored or echoed back.
    func saveSettings(_ store: AppStore, _ input: JevSettingsInput) async -> JevStatus? {
        do {
            let r: JevSettingsUpdateResponse = try await API.shared.send(.put, "/api/jev/settings", body: input)
            store.setUser(r.user)
            resetPriorities()
            return r.jev
        } catch {
            if let e = error as? APIError, e.isUnauthorized {
                store.report(error)
            } else if !(error is CancellationError) {
                store.toasts.error(jevMessage(error, "설정을 저장하지 못했어요"))
            }
            return nil
        }
    }

    // MARK: - A. priorities (one shared result)

    /// Changes whenever something Jev or the engine looks at changes (not priority itself).
    static func planKey(_ store: AppStore) -> String? {
        guard let ws = store.workspace, store.user?.jev.connected == true else { return nil }
        let parts = store.tasks.values
            .filter { $0.status == .todo || $0.status == .doing }
            .map { t in
                "\(t.id):\(t.title):\(t.notes.utf16.count):\(t.status.rawValue):\(t.startDate ?? "null"):\(t.dueDate ?? "null"):\(t.fixed):\(t.projectId ?? "null")"
            }
            .sorted()
        let links = store.deps.map { "\($0.taskId)>\($0.dependsOnId)" }.sorted()
        var h: Int32 = 5381
        for p in parts + links {
            for u in p.utf16 { h = (h &<< 5) &+ h &+ Int32(u) }
        }
        return "\(ws.id)|\(store.today)|\(h)"
    }

    /// Ask Jev again (or join the request already in flight for the same plan).
    func refreshPriorities(_ store: AppStore, force: Bool = false) async {
        guard let key = Self.planKey(store) else { return }
        if !force, self.key == key, phase == .ready || phase == .loading {
            await inflight?.value
            return
        }
        self.key = key
        phase = .loading
        error = nil
        // Unstructured on purpose: a view going away must not cancel the shared request.
        let job = Task { @MainActor [weak self] in
            do {
                let result: PrioritiesResult = try await API.shared.send(.post, "/api/jev/priorities", json: .object([:]))
                guard let self, self.key == key else { return }
                self.data = result
                self.phase = .ready
                self.revision &+= 1
            } catch {
                if let e = error as? APIError, e.isUnauthorized {
                    store.report(error)
                    return
                }
                guard let self, self.key == key else { return }
                self.phase = .error
                self.error = jevMessage(error)
            }
        }
        inflight = job
        await job.value
        if inflight == job { inflight = nil }
    }

    func resetPriorities() {
        key = nil
        phase = .idle
        data = nil
        error = nil
    }

    /// `usePriorities(enabled)`: fetch when the plan changed, right away the first time, 1.2 s after the
    /// last edit afterwards. The server caches Jev's per-task answers, so a refetch only asks about what changed.
    func follow(_ store: AppStore, key: String?) async {
        guard let key, key != self.key else { return }
        if self.key != nil {
            try? await Task.sleep(for: .milliseconds(1200))
            if Task.isCancelled { return }
        }
        await refreshPriorities(store)
    }

    struct PriorityChange: Hashable, Sendable {
        var taskId: String
        var priority: Priority
    }

    /// Apply chosen priorities as ordinary edits, with one undo for all of them.
    @discardableResult
    func applyPriorities(_ store: AppStore, _ changes: [PriorityChange], label: String = "우선순위") async -> Int {
        let prev = changes.compactMap { c in store.task(c.taskId).map { PriorityChange(taskId: c.taskId, priority: $0.priority) } }
        let ok = await Self.setPriorities(store, changes).count
        guard ok > 0 else { return 0 }
        store.toasts.show("\(label) \(ok)개를 바꿨어요", action: .init(label: UNDO_LABEL_KO) {
            Task { @MainActor in await Self.setPriorities(store, prev) }
        })
        return ok
    }

    /// PATCH each task's priority side by side; the tasks the server accepted.
    @discardableResult
    private static func setPriorities(_ store: AppStore, _ changes: [PriorityChange]) async -> [TaskItem] {
        let jobs = changes.map { c in
            Task { @MainActor () -> TaskItem? in
                var p = TaskPatch()
                p.priority = c.priority
                return await store.updateTask(c.taskId, p)
            }
        }
        var done: [TaskItem] = []
        for job in jobs {
            if let t = await job.value { done.append(t) }
        }
        return done
    }

    // MARK: - auto-apply (opt-in, fills missing priorities only)

    nonisolated private static let declinedKey = "obelisk:jev-declined"

    nonisolated private static func declined() -> Set<String> {
        guard let data = UserDefaults.standard.data(forKey: declinedKey),
              let ids = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return Set(ids)
    }

    nonisolated private static func decline(_ ids: [String]) {
        var all = Array(declined())
        all.append(contentsOf: ids)
        let kept = Array(all.suffix(500))
        if let data = try? JSONEncoder().encode(kept) { UserDefaults.standard.set(data, forKey: declinedKey) }
    }

    /// Auto-apply is on: connected, the user opted in, and the workspace is loaded.
    func autoPilotOn(_ store: AppStore) -> Bool {
        guard let jev = store.user?.jev else { return false }
        return jev.connected && jev.autoApply && store.status == .ready
    }

    /// High-confidence suggestions for tasks without a priority are applied once, with an undo that also
    /// stops Jev from filling those tasks again (web `useJevAutoPilot`).
    func autoPilot(_ store: AppStore) async {
        guard autoPilotOn(store), phase == .ready, let data else { return }
        let no = Self.declined()
        let picks = data.suggestions.filter { sg in
            guard let t = store.task(sg.taskId) else { return false }
            return t.priority == 0 && autoApplicable(sg) && !applied.contains(t.id) && !no.contains(t.id) && store.canEdit(t)
        }
        guard !picks.isEmpty else { return }
        for sg in picks { applied.insert(sg.taskId) }
        let done = await Self.setPriorities(store, picks.map { PriorityChange(taskId: $0.taskId, priority: $0.suggested) })
        guard !done.isEmpty else { return }
        let ids = done.map(\.id)
        store.toasts.show("Jev가 작업 \(done.count)개의 우선순위를 정했어요", action: .init(label: UNDO_LABEL_KO) {
            Self.decline(ids)
            Task { @MainActor in await Self.setPriorities(store, ids.map { PriorityChange(taskId: $0, priority: 0) }) }
        })
    }

    // MARK: - B. postpone

    /// POST /api/jev/postpone
    func fetchPostponePlan(_ scope: PostponeScope, capacity: Int? = nil) async throws -> PostponePlan {
        let r: JevPostponeResponse = try await API.shared.send(
            .post, "/api/jev/postpone", body: JevPostponeInput(scope: scope, capacity: capacity.flatMap { $0 > 0 ? $0 : nil })
        )
        return r.plan
    }

    /// Postpone each chosen task to its proposed date, cascading what it pushes (the engine already
    /// checked no fixed date breaks). One undo restores every date that changed.
    @discardableResult
    func applyPostpone(_ store: AppStore, _ picks: [PostponeCandidate]) async -> Int {
        var before: [String: (start: ISODate?, due: ISODate?)] = [:]
        for t in store.tasks.values { before[t.id] = (t.startDate, t.dueDate) }
        var moved = 0
        var failed: [String] = []
        /// What the server wrote, latest version per task.
        var written: [String: TaskItem] = [:]
        var order: [String] = []
        for c in picks {
            guard let toDate = c.toDate else { continue }
            do {
                let r: ImpactPostponeResponse = try await API.shared.send(
                    .post, "/api/impact/postpone",
                    json: ["taskId": .string(c.taskId), "toDate": .string(toDate), "cascade": .bool(true)]
                )
                moved += 1
                for t in r.updated {
                    if written[t.id] == nil { order.append(t.id) }
                    written[t.id] = t
                }
            } catch {
                if let e = error as? APIError, e.isUnauthorized {
                    store.report(error)
                    return moved
                }
                failed.append(jevMessage(error, "미루지 못했어요"))
            }
        }

        await store.refresh()
        // A refresh that was already in flight may predate these writes: load once more if it shows old dates.
        if written.values.contains(where: { w in store.task(w.id).map { $0.startDate != w.startDate || $0.dueDate != w.dueDate } ?? false }) {
            await store.refresh()
        }

        let after = store.tasks
        var undoIds = order
        for (id, d) in before where written[id] == nil {
            if let a = after[id], a.startDate != d.start || a.dueDate != d.due { undoIds.append(id) }
        }
        let undo = undoIds.compactMap { id -> DateChange? in
            guard let d = before[id], after[id] != nil || written[id] != nil else { return nil }
            return DateChange(taskId: id, startDate: d.start, dueDate: d.due)
        }

        if let first = failed.first { store.toasts.error(first) }
        if moved > 0 {
            let others = undo.count - moved
            store.toasts.show(
                "작업 \(moved)개를 미뤘어요\(others > 0 ? " · 뒤따르는 \(others)개도 함께 옮겼어요" : "")",
                action: undo.isEmpty ? nil : .init(label: UNDO_LABEL_KO) {
                    Task { @MainActor in await store.reschedule(undo) }
                }
            )
        }
        return moved
    }
}

// MARK: - view hooks

/// `usePriorities(enabled)` as a modifier: keeps the shared result in step with the plan while the view is up.
struct JevPrioritiesFollower: ViewModifier {
    var enabled: Bool
    @Environment(AppStore.self) private var store

    func body(content: Content) -> some View {
        let key = enabled ? JevCenter.planKey(store) : nil
        content.task(id: key) { await JevCenter.shared.follow(store, key: key) }
    }
}

/// The web AppShell's `JevAutoPilot`: when the user turned on auto-apply, keeps priorities fresh and fills
/// in missing ones Jev is sure about. Attach once near the root (`.jevAutoPilot()`); attaching it in more
/// places is harmless (each task is filled at most once).
struct JevAutoPilot: ViewModifier {
    @Environment(AppStore.self) private var store

    func body(content: Content) -> some View {
        let center = JevCenter.shared
        let on = center.autoPilotOn(store)
        content
            .modifier(JevPrioritiesFollower(enabled: on))
            .task(id: on ? "\(center.revision)|\(store.revision)" : "off") {
                if on { await center.autoPilot(store) }
            }
    }
}

extension View {
    func jevAutoPilot() -> some View { modifier(JevAutoPilot()) }
}
