import Foundation
import Observation
import SwiftUI

/// 모아보기 data (web lib/overview.ts): the user's own work in every space, merged.
///
/// The open space comes live from the store (quick adds, completions and the 20 s sync show at once);
/// every other space comes from GET /api/overview. A space seen live more recently than the last fetch
/// started (you just switched away from it) keeps its live rows until a newer fetch. Shared by the
/// 모아보기 page and the home widget 다른 공간, and kept across workspace switches (the screens are
/// rebuilt then), like the web's module-level store.
@Observable
@MainActor
final class OverviewFeed {
    static let shared = OverviewFeed()

    enum Status { case idle, loading, ready, error }

    private(set) var status: Status = .idle
    private(set) var data: Overview?
    /// When the request behind `data` started.
    private(set) var fetchedAt: Date = .distantPast
    private(set) var error: String?
    /// Whose overview `data` is (a different sign-in never sees it).
    @ObservationIgnored private var ownerId: String?
    @ObservationIgnored private var liveCache: [String: OverviewLiveCacheEntry] = [:]
    @ObservationIgnored private var inflight: Task<Void, Never>?

    /// Spaces switched off on the 모아보기 page, remembered on this device.
    var hidden: Set<String> {
        didSet { Self.saveHidden(hidden) }
    }

    private static let hiddenKey = "obelisk:overview-hidden"

    private init() {
        let raw = UserDefaults.standard.data(forKey: Self.hiddenKey)
        hidden = Set(raw.flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? [])
    }

    private static func saveHidden(_ ids: Set<String>) {
        if let d = try? JSONEncoder().encode(Array(ids).sorted()) { UserDefaults.standard.set(d, forKey: hiddenKey) }
    }

    func toggleSpace(_ id: String) {
        if hidden.contains(id) { hidden.remove(id) } else { hidden.insert(id) }
    }

    /// Other spaces have arrived at least once (the open one is always there).
    func loaded(for store: AppStore) -> Bool { currentData(store) != nil }

    func errorText(for store: AppStore) -> String? {
        status == .error && currentData(store) == nil ? error : nil
    }

    private func currentData(_ store: AppStore) -> Overview? {
        guard let data, ownerId == store.user?.id else { return nil }
        return data
    }

    // MARK: loading

    func load(_ store: AppStore) async {
        if let inflight { return await inflight.value }
        let owner = store.user?.id
        if owner != ownerId {
            data = nil
            liveCache = [:]
            ownerId = owner
        }
        let startedAt = Date()
        if data == nil { status = .loading }
        let job = Task { @MainActor in
            defer { self.inflight = nil }
            do {
                let d: Overview = try await API.shared.get("/api/overview")
                guard self.ownerId == owner else { return }
                self.data = d
                self.fetchedAt = startedAt
                self.status = .ready
                self.error = nil
            } catch {
                if error is CancellationError { return }
                // Keep showing what we had; only an empty page reports the failure.
                if self.data == nil {
                    self.status = .error
                    self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했습니다"
                }
            }
        }
        inflight = job
        await job.value
    }

    /// Fetch now, then every minute while the caller is on screen (call from `.task`).
    func keepFresh(_ store: AppStore) async {
        await load(store)
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(60))
            if Task.isCancelled { break }
            await load(store)
        }
    }

    /// The open space (live) merged with the fetched overview.
    func merged(_ store: AppStore) -> OverviewMergeResult {
        var open: OverviewOpenSpace?
        if store.status == .ready, let w = store.workspace, let u = store.user {
            open = OverviewOpenSpace(workspace: w.summary, userId: u.id, today: store.today, tasks: store.taskList, projects: store.projects)
        }
        return mergeOverview(currentData(store), fetchedAt: fetchedAt, open: open, workspaces: store.workspaces, liveCache: &liveCache)
    }

    // MARK: changes from the page

    private func patchRemote(_ id: String, _ apply: (inout TaskItem) -> Void) {
        guard var d = data else { return }
        d.tasks = d.tasks.map { t in
            guard t.id == id else { return t }
            var t = t
            apply(&t.task)
            return t
        }
        data = d
    }

    private struct TaskResponse: Decodable { var task: TaskItem }

    /// PATCH the task's status in its own space (routes by id use the task's workspace; the header names
    /// it too, so the open space never matters).
    private func setRemoteStatus(_ item: OverviewItem, _ status: TaskStatus, _ store: AppStore) async -> Bool {
        let prev = item.task
        patchRemote(prev.id) {
            $0.status = status
            $0.completedAt = status == .done ? ISO8601DateFormatter.obelisk.string(from: Date()) : nil
        }
        do {
            let body = try JSONEncoder().encode(JSONValue.object(["status": .string(status.rawValue)]))
            let raw = try await API.shared.raw(.patch, "/api/tasks/\(prev.id)", body: body, workspace: .some(item.space.id))
            let r = try JSONDecoder().decode(TaskResponse.self, from: raw)
            patchRemote(r.task.id) { $0 = r.task }
            return true
        } catch {
            patchRemote(prev.id) {
                $0.status = prev.status
                $0.completedAt = prev.completedAt
            }
            store.report(error, "변경 사항을 저장하지 못했습니다")
            return false
        }
    }

    /// Tick a row: through the store for the open space, straight to the server for the others.
    func complete(_ item: OverviewItem, store: AppStore) async {
        if item.live {
            await store.toggleDone(item.task.id)
            return
        }
        guard item.editable else {
            store.toasts.error(AppStore.readOnlyMessage)
            return
        }
        let prevStatus = item.task.status
        guard await setRemoteStatus(item, .done, store) else { return }
        Haptics.success()
        Task { await load(store) }
        store.toasts.show("“\(item.task.title)” 완료", action: .init(label: "실행 취소") { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                var undone = item
                undone.task.status = .done
                if await self.setRemoteStatus(undone, prevStatus, store) { await self.load(store) }
            }
        })
    }
}

/// "개인 공간" or the organization's name.
func overviewSpaceLabel(_ w: WorkspaceSummary) -> String { homeSpaceLabel(w) }

extension SpaceHue {
    /// The space's tag colour, from the project palette.
    var palette: ProjectPalette { (ProjectColor(rawValue: rawValue) ?? .slate).palette }
}
