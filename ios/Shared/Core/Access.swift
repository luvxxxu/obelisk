import Foundation

// Port of packages/core/src/access.ts.
//
// Permission rules shared by the server (which enforces them) and the app (which hides what you can't
// do). The server is the only authority.
//
//  - Owners and admins manage every project of their workspace.
//  - Everyone else gets the best of: the project's member access (what every member gets), their own
//    grant, and the grants of teams they belong to.
//  - view: see the project and its tasks. edit: create, change, delete, link tasks. manage: also
//    rename/archive/delete/move the project and share it.
//  - In an organization, a task without a project is visible only to the person who made it and its
//    assignee. In a personal space you see everything.

let LEVEL_RANK: [String: Int] = ["none": 0, "view": 1, "edit": 2, "manage": 3]

/// AccessLevel or MemberAccess (`AnyLevel` in access.ts).
protocol AnyAccessLevel {
    /// none 0 · view 1 · edit 2 · manage 3
    var levelRank: Int { get }
    /// The same level as an AccessLevel; nil for MemberAccess.none.
    var asAccessLevel: AccessLevel? { get }
}

extension AccessLevel: AnyAccessLevel {
    var levelRank: Int { rank }
    var asAccessLevel: AccessLevel? { self }
}

extension MemberAccess: AnyAccessLevel {
    var levelRank: Int { LEVEL_RANK[rawValue] ?? 0 }
    var asAccessLevel: AccessLevel? { AccessLevel(rawValue: rawValue) }
}

/// Does `level` reach `min`? nil and `.none` grant nothing.
func atLeast(_ level: (any AnyAccessLevel)?, _ min: AccessLevel) -> Bool {
    (level?.levelRank ?? 0) >= min.rank
}

/// The higher of the given levels; nil when none of them grants anything.
func maxLevel(_ levels: (any AnyAccessLevel)?...) -> AccessLevel? {
    maxLevel(levels)
}

/// Array form of `maxLevel`.
func maxLevel(_ levels: [(any AnyAccessLevel)?]) -> AccessLevel? {
    var best: AccessLevel? = nil
    for l in levels {
        guard let l, let level = l.asAccessLevel else { continue }
        if best == nil || level.rank > best!.rank { best = level }
    }
    return best
}

func isWorkspaceAdmin(_ role: WorkspaceRole?) -> Bool {
    role == .owner || role == .admin
}

/// What the task rules read (TaskItem and OverviewTask conform).
protocol TaskAccessSubject {
    var projectId: String? { get }
    var createdBy: String? { get }
    var assigneeId: String? { get }
}

extension TaskItem: TaskAccessSubject {}

/// The caller's standing in one workspace.
struct AccessView {
    var userId: String
    var kind: WorkspaceKind
    /// The caller's level on a project of this workspace, or nil when they cannot see it.
    var projectLevel: (String) -> AccessLevel?

    init(userId: String, kind: WorkspaceKind, projectLevel: @escaping (String) -> AccessLevel?) {
        self.userId = userId
        self.kind = kind
        self.projectLevel = projectLevel
    }

    /// What the web store builds (`accessView`): levels come from the projects the server sent.
    init(userId: String, kind: WorkspaceKind, projects: [Project]) {
        let levels = Dictionary(projects.map { ($0.id, $0.access) }, uniquingKeysWith: { a, _ in a })
        self.init(userId: userId, kind: kind, projectLevel: { levels[$0] })
    }
}

/// The caller's level on a task, or nil when they cannot see it.
func taskAccess<T: TaskAccessSubject>(_ task: T, _ a: AccessView) -> AccessLevel? {
    if let p = task.projectId, !p.isEmpty { return a.projectLevel(p) }
    if a.kind == .personal { return .manage }
    if task.createdBy == a.userId || task.assigneeId == a.userId { return .edit }
    return nil
}

func canViewTask<T: TaskAccessSubject>(_ task: T, _ a: AccessView) -> Bool {
    taskAccess(task, a) != nil
}

func canEditTask<T: TaskAccessSubject>(_ task: T, _ a: AccessView) -> Bool {
    atLeast(taskAccess(task, a), .edit)
}

/// Can the user add tasks to this project (nil = their inbox)? (web store's `canWriteProject`)
func canWriteProject(_ projectId: String?, _ projects: [Project]) -> Bool {
    guard let projectId, !projectId.isEmpty else { return true }
    let level = projects.first { $0.id == projectId }?.access
    return level == .edit || level == .manage
}
