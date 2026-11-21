import Foundation

// Port of packages/core/src/views.ts (plus the small protocols the Core functions take instead of
// TypeScript's `Pick<Task, …>`; TaskItem and OverviewTask conform to all of them).

// MARK: - task shapes

/// A start/due pair: TaskItem, PlanItem, DateSpan and OverviewTask.
protocol DateSpanLike {
    var startDate: ISODate? { get }
    var dueDate: ISODate? { get }
}

/// Dates plus their optional times: what `spanLabel` / `timeLabel` read (TaskItem, PlanItem, DateSpan,
/// OverviewTask).
protocol TimedSpanLike: DateSpanLike {
    var startTime: ISOTime? { get }
    var dueTime: ISOTime? { get }
}

/// What the list views, sorting and date labels read from a task (`ViewTask` in views.ts).
protocol ViewTask: TimedSpanLike {
    var id: String { get }
    var status: TaskStatus { get }
    var projectId: String? { get }
    var priority: Priority { get }
    var number: Int { get }
    var completedAt: String? { get }
    var position: Double { get }
}

/// A ViewTask that also knows whether it is fixed and who it is assigned to (`OverviewSubject`).
protocol OverviewSubject: ViewTask {
    var fixed: Bool { get }
    var assigneeIds: [String] { get }
}

extension TaskItem: ViewTask, OverviewSubject, TimedSpanLike, DateSpanLike {}

// MARK: - views

enum ViewName: String, Codable, CaseIterable, Hashable, Sendable {
    case today, upcoming, overdue, inbox, unscheduled, all, done
}

let VIEW_NAMES: [ViewName] = ViewName.allCases

private func active(_ status: TaskStatus) -> Bool { status == .todo || status == .doing }

/// Past its due date, or, with `now` and a due time, past that minute today.
func isOverdue<T: ViewTask>(_ t: T, _ today: ISODate, _ now: Clock? = nil) -> Bool {
    guard active(t.status), t.dueDate.jsTruthy, let due = t.dueDate else { return false }
    if let now, now.date == today { return isPastDue(due, t.dueTime, now) }
    return due < today
}

/// Shows up in Today: overdue, due today, started already, or in progress.
func isToday<T: ViewTask>(_ t: T, _ today: ISODate) -> Bool {
    if !active(t.status) { return false }
    if t.status == .doing { return true }
    if t.dueDate.jsTruthy, let d = t.dueDate, d <= today { return true }
    if t.startDate.jsTruthy, let s = t.startDate, s <= today { return true }
    return false
}

func matchesView<T: ViewTask>(_ t: T, _ view: ViewName, _ today: ISODate, _ now: Clock? = nil) -> Bool {
    switch view {
    case .today:
        return isToday(t, today)
    case .overdue:
        return isOverdue(t, today, now)
    case .upcoming:
        if !active(t.status) { return false }
        guard let first = t.startDate ?? t.dueDate, !first.isEmpty else { return false }
        return first > today
    case .inbox:
        return active(t.status) && t.projectId == nil
    case .unscheduled:
        return active(t.status) && !t.startDate.jsTruthy && !t.dueDate.jsTruthy
    case .all:
        return active(t.status)
    case .done:
        return t.status == .done
    }
}

/// The moment a task is ordered by: its due date and time, else its start.
private func whenKey<T: ViewTask>(_ t: T) -> String? {
    if let d = t.dueDate, !d.isEmpty { return dateTimeKey(d, t.dueTime, .end) }
    if let s = t.startDate, !s.isEmpty { return dateTimeKey(s, t.startTime, .start) }
    return nil
}

/// In progress first, then earliest due (by time within a day; a day without a time last), then
/// priority, then manual order. Negative = a first. Use `tasks.sorted { compareTasks($0, $1) < 0 }`.
func compareTasks<A: ViewTask, B: ViewTask>(_ a: A, _ b: B) -> Int {
    let sa = a.status == .doing ? 0 : 1
    let sb = b.status == .doing ? 0 : 1
    if sa != sb { return sa - sb }
    let da = whenKey(a)
    let db = whenKey(b)
    if da != db {
        guard let da else { return 1 }
        guard let db else { return -1 }
        return da < db ? -1 : 1
    }
    if a.priority != b.priority { return b.priority - a.priority }
    if a.position != b.position { return a.position < b.position ? -1 : 1 }
    return a.number - b.number
}

/// Most recently completed first.
func compareDone<A: ViewTask, B: ViewTask>(_ a: A, _ b: B) -> Int {
    let x = b.completedAt ?? ""
    let y = a.completedAt ?? ""
    return x == y ? 0 : (x < y ? -1 : 1)
}

/// The tasks of one view, sorted the way the web shows them (stable).
func selectView<T: ViewTask>(_ tasks: [T], _ view: ViewName, _ today: ISODate, _ now: Clock? = nil) -> [T] {
    let out = tasks.filter { matchesView($0, view, today, now) }
    return view == .done ? JS.sorted(out, compareDone) : JS.sorted(out, compareTasks)
}

/// Stable sort with `compareTasks` (what `list.sort(compareTasks)` does on the web).
func sortTasks<T: ViewTask>(_ tasks: [T]) -> [T] {
    JS.sorted(tasks, compareTasks)
}
