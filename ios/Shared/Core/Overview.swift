import Foundation

// Port of packages/core/src/overview.ts — 모아보기: the user's own work across every space, in one list.
//
//  - Whose work: everything in the personal space; in an organization only tasks assigned to the user.
//  - Which dates: overdue, today (in progress and already started included, same as the Today page),
//    the next OVERVIEW_DAYS days by due date (same bucketing as the Upcoming page), and fixed
//    commitments within OVERVIEW_FIXED_DAYS.
//  - Dependencies never cross spaces, so delay forecasts stay per space and are not merged here.

let OVERVIEW_DAYS = 7
let OVERVIEW_FIXED_DAYS = 30

/// A task from GET /api/overview: the task itself plus whether the user may change it.
/// The JSON is flat (every Task field plus `editable`); task fields read through (`item.title`).
@dynamicMemberLookup
struct OverviewTask: Codable, Hashable, Sendable, Identifiable {
    var task: TaskItem
    /// Whether the user may change it (view-only project tasks can be assigned to them too).
    var editable: Bool

    init(task: TaskItem, editable: Bool) {
        self.task = task
        self.editable = editable
    }

    subscript<V>(dynamicMember keyPath: KeyPath<TaskItem, V>) -> V { task[keyPath: keyPath] }

    private enum CodingKeys: String, CodingKey { case editable }

    init(from decoder: Decoder) throws {
        task = try TaskItem(from: decoder)
        editable = try decoder.container(keyedBy: CodingKeys.self).decode(Bool.self, forKey: .editable)
    }

    func encode(to encoder: Encoder) throws {
        try task.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(editable, forKey: .editable)
    }

    // Protocol witnesses (dynamic member lookup does not satisfy protocol requirements).
    var id: String { task.id }
    var status: TaskStatus { task.status }
    var startDate: ISODate? { task.startDate }
    var startTime: ISOTime? { task.startTime }
    var dueDate: ISODate? { task.dueDate }
    var dueTime: ISOTime? { task.dueTime }
    var projectId: String? { task.projectId }
    var priority: Priority { task.priority }
    var number: Int { task.number }
    var completedAt: String? { task.completedAt }
    var position: Double { task.position }
    var fixed: Bool { task.fixed }
    var assigneeId: String? { task.assigneeId }
    var createdBy: String? { task.createdBy }
}

extension OverviewTask: ViewTask, OverviewSubject, TaskAccessSubject, DateSpanLike {}

/// A project of an overview task (name and colour only).
struct OverviewProject: Codable, Hashable, Sendable, Identifiable, HasName {
    var id: String
    var workspaceId: String
    var name: String
    var color: ProjectColor

    init(id: String, workspaceId: String, name: String, color: ProjectColor) {
        self.id = id
        self.workspaceId = workspaceId
        self.name = name
        self.color = color
    }

    init(project p: Project) {
        self.init(id: p.id, workspaceId: p.workspaceId, name: p.name, color: p.color)
    }
}

/// GET /api/overview
struct Overview: Codable, Hashable, Sendable {
    var today: ISODate
    /// Every space the user belongs to, personal first.
    var spaces: [WorkspaceSummary]
    var tasks: [OverviewTask]
    /// Projects of the listed tasks (name and colour only).
    var projects: [OverviewProject]
}

private func active(_ s: TaskStatus) -> Bool { s == .todo || s == .doing }

/// Personal space: all of it. Organization: what is assigned to the user.
func isMine<T: OverviewSubject>(_ t: T, _ kind: WorkspaceKind, _ userId: String) -> Bool {
    kind == .personal || (!userId.isEmpty && t.assigneeId == userId)
}

/// The day a task sits on in the week list: its due date, else its start (as on the Upcoming page).
func overviewDay<T: DateSpanLike>(_ t: T) -> ISODate? {
    t.dueDate ?? t.startDate
}

/// When a fixed commitment matters next — a start still ahead, otherwise its last day — or nil when it
/// is already over or further away than `horizonDays`.
func fixedDate<T: OverviewSubject>(_ t: T, _ today: ISODate, _ horizonDays: Int = OVERVIEW_FIXED_DAYS) -> ISODate? {
    if !t.fixed { return nil }
    guard let last = t.dueDate ?? t.startDate, !last.isEmpty, last >= today else { return nil }
    let date: ISODate
    if let s = t.startDate, !s.isEmpty, s >= today { date = s } else { date = last }
    return date <= addDays(today, horizonDays) ? date : nil
}

func inOverview<T: OverviewSubject>(_ t: T, _ kind: WorkspaceKind, _ userId: String, _ today: ISODate) -> Bool {
    if !active(t.status) || !isMine(t, kind, userId) { return false }
    if isToday(t, today) { return true }
    if let day = overviewDay(t), !day.isEmpty, day <= addDays(today, OVERVIEW_DAYS) { return true }
    return fixedDate(t, today) != nil
}

/// One day of the overview's week list.
struct OverviewDay<T>: Identifiable {
    var date: ISODate
    var tasks: [T]
    var id: ISODate { date }
}

/// A fixed commitment and the day it matters.
struct OverviewFixed<T: ViewTask>: Identifiable {
    var task: T
    var date: ISODate
    var id: String { task.id }
}

struct OverviewSections<T: ViewTask> {
    var overdue: [T]
    /// Due or started today, or in progress.
    var today: [T]
    /// One entry per day after today, OVERVIEW_DAYS of them (empty days included).
    var week: [OverviewDay<T>]
    /// Fixed commitments within OVERVIEW_FIXED_DAYS, soonest first (they may also sit in the lists above).
    var fixed: [OverviewFixed<T>]
}

extension OverviewDay: Equatable where T: Equatable {}
extension OverviewDay: Hashable where T: Hashable {}
extension OverviewFixed: Equatable where T: Equatable {}
extension OverviewFixed: Hashable where T: Hashable {}
extension OverviewSections: Equatable where T: Equatable {}
extension OverviewSections: Hashable where T: Hashable {}

/// Place overview tasks into the page's sections. Tasks outside the overview are ignored.
func overviewSections<T: OverviewSubject>(_ tasks: [T], _ today: ISODate) -> OverviewSections<T> {
    var overdue: [T] = []
    var todays: [T] = []
    var byDay: [ISODate: [T]] = [:]
    var fixed: [OverviewFixed<T>] = []
    let horizon = addDays(today, OVERVIEW_DAYS)
    for t in tasks {
        if !active(t.status) { continue }
        if let f = fixedDate(t, today) { fixed.append(OverviewFixed(task: t, date: f)) }
        if isOverdue(t, today) { overdue.append(t) }
        else if isToday(t, today) { todays.append(t) }
        else if let day = overviewDay(t), !day.isEmpty, day > today, day <= horizon {
            byDay[day, default: []].append(t)
        }
    }
    let week = (0 ..< OVERVIEW_DAYS).map { i -> OverviewDay<T> in
        let date = addDays(today, i + 1)
        return OverviewDay(date: date, tasks: JS.sorted(byDay[date] ?? [], compareTasks))
    }
    return OverviewSections(
        overdue: JS.sorted(overdue, compareTasks),
        today: JS.sorted(todays, compareTasks),
        week: week,
        fixed: JS.sorted(fixed) { a, b in
            if a.date != b.date { return a.date < b.date ? -1 : 1 }
            return compareTasks(a.task, b.task)
        }
    )
}
