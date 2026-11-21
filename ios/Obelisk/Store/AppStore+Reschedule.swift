import Foundation

// TimedSpan, PendingChange, orderTimes, withTimes and planDateChange live in Shared/Core/Reschedule.swift.

extension PendingChange: Identifiable {
    var id: String { "\(taskId)|\(next.startDate ?? "")|\(next.dueDate ?? "")" }
}

/// Port of web/src/lib/reschedule.ts. Every date edit in the UI goes through `requestDateChange`:
/// if moving a task would push other work or break a fixed date, we stop and show the impact first.
extension AppStore {
    var planItemsNow: [PlanItem] { planItems(Array(tasks.values)) }

    /// The impact of moving `taskId` to `next` (no write).
    func previewFor(_ taskId: String, _ next: DateSpanLike) -> DateChangePreview {
        previewDateChange(planItemsNow, deps, taskId, DateSpan(startDate: next.startDate, dueDate: next.dueDate))
    }

    /// Every date edit goes through here (rows, task detail, timeline, home, quick postpone).
    func requestDateChange(_ taskId: String, _ span: TimedSpan) {
        guard let task = tasks[taskId] else { return }
        guard canEdit(task) else {
            toasts.error(Self.readOnlyMessage)
            return
        }
        switch planDateChange(task, span, planItemsNow, deps) {
        case .unchanged:
            return
        case let .timesOnly(times):
            var p = TaskPatch()
            p.startTime = .some(times.startTime)
            p.dueTime = .some(times.dueTime)
            Task { await updateTask(taskId, p) }
        case let .confirm(pending):
            pendingChange = pending
        case let .apply(changes):
            Task { await commitDates(taskId, changes) }
        }
    }

    enum PendingMode { case cascade, only, cancel }

    func resolvePending(_ mode: PendingMode) async {
        guard let p = pendingChange else { return }
        pendingChange = nil
        let label = p.count.map { "작업 \($0)개 날짜 변경" } ?? "날짜 변경"
        switch mode {
        case .cancel: return
        case .cascade: await commitDates(p.taskId, pendingChanges(p, .cascade), label: label)
        case .only: await commitDates(p.taskId, pendingChanges(p, .only), label: label)
        }
    }

    /// The reschedule records its own undo entry; the toast offers that entry's 실행 취소.
    private func commitDates(_ taskId: String, _ changes: [DateChange], label: String = "날짜 변경") async {
        guard let task = tasks[taskId], await reschedule(changes, rootId: taskId, label: label) else { return }
        history.notify(rescheduleToast(changes.count, task.title, tasks[taskId], today), history.latest)
    }

    /// The impact of moving several tasks together (no write): each moved task pushes what waits on it.
    func previewGroupNow(_ moves: [GroupMove]) -> DateChangePreview {
        previewGroup(moves, tasks, planItemsNow, deps)
    }

    // MARK: quick postpone (web TaskRow PostponeMenu)

    /// Shift a span by whole days (both ends).
    static func shiftSpan(_ t: DateSpanLike, _ days: Int) -> TimedSpan {
        TimedSpan(startDate: t.startDate.map { addDays($0, days) }, dueDate: t.dueDate.map { addDays($0, days) })
    }

    /// Move a task so it finishes on `target`, keeping its length.
    static func spanEndingOn(_ t: DateSpanLike, _ target: ISODate) -> TimedSpan {
        guard let anchor = t.dueDate ?? t.startDate else { return TimedSpan(startDate: nil, dueDate: target) }
        return shiftSpan(t, diffDays(target, anchor))
    }

    struct PostponeOption: Identifiable {
        var id: String { label }
        var label: String
        var next: TimedSpan
        var delayed: Int
        var conflicts: Int

        /// "충돌 2" · "3개 밀림" · "영향 없음"
        var effect: String { conflicts > 0 ? "충돌 \(conflicts)" : delayed > 0 ? "\(delayed)개 밀림" : "영향 없음" }
        var tone: Tone { conflicts > 0 ? .danger : delayed > 0 ? .warn : .ok }
    }

    /// 하루 미루기 · 이틀 미루기 · 일주일 미루기 · 다음 주 월요일 (오늘로, when overdue), with their impact.
    func postponeOptions(_ task: TaskItem) -> [PostponeOption] {
        guard let anchor = task.dueDate ?? task.startDate else { return [] }
        let nextMon = addDays(startOfWeek(today), 7)
        let base = anchor < today ? today : anchor
        let list: [(String, TimedSpan)] = [
            (anchor < today ? "오늘로" : "하루 미루기", anchor < today ? Self.spanEndingOn(task, today) : Self.shiftSpan(task, 1)),
            ("이틀 미루기", Self.spanEndingOn(task, addDays(base, 2))),
            ("일주일 미루기", Self.spanEndingOn(task, addDays(base, 7))),
            ("다음 주 월요일", Self.spanEndingOn(task, nextMon)),
        ]
        return list
            .filter { ($0.1.dueDate ?? $0.1.startDate) != anchor }
            .map { label, next in
                let p = previewFor(task.id, next)
                return PostponeOption(label: label, next: next, delayed: p.report.summary.delayedCount, conflicts: p.report.summary.conflictCount)
            }
    }
}
