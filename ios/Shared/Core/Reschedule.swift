import Foundation

// Port of the pure parts of web/src/lib/reschedule.ts. Every date edit in the UI goes through here: if
// moving a task would push other work or break a fixed date, the app stops and shows the impact first.
// The web keeps the pending change in a module store and calls the API; here those are the caller's job:
// `planDateChange` says what to do, `pendingChanges` / `undoChanges` / `rescheduleToast` fill in the rest.

/// New dates plus, optionally, new times. A time left nil stays as it is (and goes with a cleared date);
/// `.some(nil)` clears it; `.some("15:00")` sets it.
struct TimedSpan: Hashable, Sendable, DateSpanLike {
    var startDate: ISODate?
    var dueDate: ISODate?
    var startTime: ISOTime??
    var dueTime: ISOTime??

    init(startDate: ISODate?, dueDate: ISODate?, startTime: ISOTime?? = nil, dueTime: ISOTime?? = nil) {
        self.startDate = startDate
        self.dueDate = dueDate
        self.startTime = startTime
        self.dueTime = dueTime
    }
}

/// The times a task ends up with.
struct ResolvedTimes: Hashable, Sendable {
    var startTime: ISOTime?
    var dueTime: ISOTime?
}

/// The times a task ends up with after `next`.
func resolvedTimes(_ task: TaskItem, _ next: TimedSpan) -> ResolvedTimes {
    ResolvedTimes(
        startTime: next.startDate.jsTruthy ? (next.startTime ?? task.startTime) : nil,
        dueTime: next.dueDate.jsTruthy ? (next.dueTime ?? task.dueTime) : nil
    )
}

/// Keep a same-day start before its due, the way calendars do: moving the start carries the due time
/// along (keeping the length, an hour by default); moving the due pulls the start back.
func orderTimes(_ task: TaskItem, _ next: TimedSpan) -> TimedSpan {
    let r = resolvedTimes(task, next)
    guard next.startDate.jsTruthy, next.startDate == next.dueDate, let st = r.startTime, !st.isEmpty,
          let dt = r.dueTime, !dt.isEmpty, st > dt else { return next }
    var was = 0
    if task.startDate == task.dueDate, let ts = task.startTime, !ts.isEmpty, let td = task.dueTime, !td.isEmpty {
        was = toMinutes(td) - toMinutes(ts)
    }
    let len = was > 0 ? was : 60
    let dueMoved = next.dueTime != nil && next.startTime == nil
    var out = next
    if dueMoved {
        out.startTime = .some(fromMinutes(max(0, toMinutes(dt) - len)))
    } else {
        out.dueTime = .some(fromMinutes(min(DAY_MINUTES - 1, toMinutes(st) + len)))
    }
    return out
}

/// Put the edited task's new times on its own entry of a previewed change set.
func withTimes(_ changes: [DateChange], _ taskId: String, _ next: TimedSpan) -> [DateChange] {
    changes.map { c in
        guard c.taskId == taskId else { return c }
        var out = c
        if let t = next.startTime { out.startTime = .some(t) }
        if let t = next.dueTime { out.dueTime = .some(t) }
        return out
    }
}

/// A date edit waiting for the user to choose: move only this task, move everything it pushes, or cancel.
struct PendingChange: Hashable, Sendable {
    var taskId: String
    var title: String
    var next: TimedSpan
    var preview: DateChangePreview
}

/// What to do with a requested date edit (`requestDateChange` on the web).
enum DateChangeRequest: Hashable, Sendable {
    /// Same dates and times: nothing to do (also when the task is unknown).
    case unchanged
    /// Same dates, new times: PATCH the task with these times only (nothing else moves).
    case timesOnly(ResolvedTimes)
    /// Something else would move or break: show `preview` and let the user pick.
    case confirm(PendingChange)
    /// Harmless: POST /api/tasks/reschedule with these changes right away (count 1 in the toast).
    case apply([DateChange])
}

/// Decide how a date edit goes through (the pure part of the web's `requestDateChange`).
func planDateChange(_ task: TaskItem, _ span: TimedSpan, _ items: [PlanItem], _ deps: [PlanDependency]) -> DateChangeRequest {
    let next = orderTimes(task, span)
    let times = resolvedTimes(task, next)
    let sameDates = task.startDate == next.startDate && task.dueDate == next.dueDate
    if sameDates {
        // A new time on the same day moves nothing else: the delay model counts whole days.
        if times.startTime != task.startTime || times.dueTime != task.dueTime { return .timesOnly(times) }
        return .unchanged
    }
    let preview = previewDateChange(items, deps, task.id, next)
    if preview.hasImpact {
        return .confirm(PendingChange(taskId: task.id, title: task.title, next: next, preview: preview))
    }
    return .apply(withTimes(preview.only, task.id, next))
}

/// How the user resolved a pending change (cancel needs no call).
enum PendingResolution: String, Codable, CaseIterable, Hashable, Sendable {
    case cascade, only
}

/// The changes to send for a resolved pending change (the web's `resolvePending`).
func pendingChanges(_ p: PendingChange, _ mode: PendingResolution) -> [DateChange] {
    withTimes(mode == .cascade ? p.preview.cascade : p.preview.only, p.taskId, p.next)
}

/// The tasks' current dates and times for every change, to send back for "실행 취소".
func undoChanges(_ changes: [DateChange], _ tasks: [TaskItem]) -> [DateChange] {
    let byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    return changes.compactMap { byId[$0.taskId] }.map { t in
        DateChange(taskId: t.id, startDate: t.startDate, dueDate: t.dueDate, startTime: .some(t.startTime), dueTime: .some(t.dueTime))
    }
}

/// The toast after a reschedule: "3개 작업 일정을 함께 옮겼어요" or "“기획서” → 내일 오후 3:00".
/// `after` is the edited task as the server returned it; `count` is how many changes were sent.
func rescheduleToast(_ count: Int, _ title: String, _ after: TaskItem?, _ today: ISODate) -> String {
    if count > 1 { return "\(count)개 작업 일정을 함께 옮겼어요" }
    let when = after?.dueDate ?? after?.startDate
    let time = after?.dueDate.jsTruthy == true ? after?.dueTime : after?.startTime
    let label = when.jsTruthy ? withTime(formatRelativeKo(when!, today), time) : "날짜 없음"
    return "“\(title)” → \(label)"
}

/// The toast's undo button.
let UNDO_LABEL_KO = "실행 취소"
