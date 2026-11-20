import Foundation

// Port of the pure parts of web/src/lib/overview.ts: the 모아보기 rows (open space live from the app's
// own state, every other space from GET /api/overview) and the per-space tag colours. Fetching, timers
// and toasts stay with the screen.

/// One row of 모아보기.
struct OverviewItem: Hashable, Sendable, Identifiable {
    var task: TaskItem
    var editable: Bool
    var space: WorkspaceSummary
    var project: OverviewProject?
    /// Lives in the open space: changes go through the app's own state, opening needs no switch.
    var live: Bool

    var id: String { task.id }
}

/// The open space as the app currently holds it.
struct OverviewOpenSpace: Sendable {
    var workspace: WorkspaceSummary
    var userId: String
    var today: ISODate
    var tasks: [TaskItem]
    var projects: [Project]

    init(workspace: WorkspaceSummary, userId: String, today: ISODate, tasks: [TaskItem], projects: [Project]) {
        self.workspace = workspace
        self.userId = userId
        self.today = today
        self.tasks = tasks
        self.projects = projects
    }
}

/// Rows of a space as last seen live, and when.
struct OverviewLiveCacheEntry: Hashable, Sendable {
    var at: Date
    var items: [OverviewItem]
}

struct OverviewMergeResult: Hashable, Sendable {
    var spaces: [WorkspaceSummary]
    var items: [OverviewItem]
}

/// Merge the open space (live) with the fetched overview. When a space was seen live more recently than
/// the fetch behind `data` started (`fetchedAt`), its cached live rows are kept until a newer fetch.
/// Updates `liveCache` for the open space, like the web's module-level cache.
func mergeOverview(
    _ data: Overview?,
    fetchedAt: Date,
    open: OverviewOpenSpace?,
    workspaces: [WorkspaceSummary],
    liveCache: inout [String: OverviewLiveCacheEntry],
    now: Date = Date()
) -> OverviewMergeResult {
    let spaces = data?.spaces ?? workspaces
    let byId = Dictionary(spaces.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    let projects = Dictionary((data?.projects ?? []).map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })

    var items: [OverviewItem] = []
    if let open {
        let space = byId[open.workspace.id] ?? open.workspace
        let access = AccessView(userId: open.userId, kind: open.workspace.kind, projects: open.projects)
        let live = open.tasks
            .filter { inOverview($0, open.workspace.kind, open.userId, open.today) }
            .map { t -> OverviewItem in
                let p = t.projectId.flatMap { id in open.projects.first { $0.id == id } }
                return OverviewItem(
                    task: t, editable: canEditTask(t, access), space: space,
                    project: p.map(OverviewProject.init(project:)), live: true
                )
            }
        liveCache[open.workspace.id] = OverviewLiveCacheEntry(at: now, items: live)
        items += live
    }

    for space in spaces where space.id != open?.workspace.id {
        if let cached = liveCache[space.id], cached.at > fetchedAt {
            items += cached.items.map { var i = $0; i.space = space; i.live = false; return i }
            continue
        }
        for t in data?.tasks ?? [] where t.workspaceId == space.id {
            items.append(OverviewItem(
                task: t.task, editable: t.editable, space: space,
                project: t.projectId.flatMap { projects[$0] }, live: false
            ))
        }
    }
    return OverviewMergeResult(spaces: spaces, items: items)
}

/// A space's tag colour.
enum SpaceHue: String, Codable, CaseIterable, Hashable, Sendable {
    case slate, blue, violet, teal, orange, pink, green, indigo, amber
}

let ORG_HUES: [SpaceHue] = [.blue, .violet, .teal, .orange, .pink, .green, .indigo, .amber]

/// A tag colour per space, stable for a given membership order: personal is neutral, orgs take turns.
func spaceHues(_ spaces: [WorkspaceSummary]) -> [String: SpaceHue] {
    var out: [String: SpaceHue] = [:]
    var i = 0
    for w in spaces {
        if w.kind == .personal {
            out[w.id] = .slate
        } else {
            out[w.id] = ORG_HUES[i % ORG_HUES.count]
            i += 1
        }
    }
    return out
}
