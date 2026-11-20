import Foundation

/// Sidebar numbers (web Sidebar.tsx `data`).
struct SidebarCounts {
    struct Event {
        var task: TaskItem
        var date: ISODate
        var label: String
    }

    /// Fixed commitments listed under "다가오는 일정".
    static let eventHorizonDays = 14
    static let eventCap = 3

    var mine = 0
    var today = 0
    var overdue = 0
    var inbox = 0
    var risk = 0
    var conflicts = 0
    var byProject: [String: Int] = [:]
    var events: [Event] = []
}

extension AppStore {
    var sidebarCounts: SidebarCounts {
        var c = SidebarCounts()
        let list = taskList
        let active = list.filter(\.isActive)
        let now = nowIn(timezone)
        for t in active {
            if let p = t.projectId { c.byProject[p, default: 0] += 1 } else { c.inbox += 1 }
            if let uid = user?.id, t.assigneeId == uid { c.mine += 1 }
        }
        c.today = list.filter { isToday($0, today) }.count
        c.overdue = list.filter { isOverdue($0, today, now) }.count

        let fc = forecast(planItemsNow, deps, today)
        c.risk = fc.summary.delayedCount + fc.summary.conflictCount
        c.conflicts = fc.summary.conflictCount

        let horizon = addDays(today, SidebarCounts.eventHorizonDays)
        c.events = active
            .filter(\.fixed)
            .compactMap { t -> (TaskItem, ISODate)? in
                guard let last = t.dueDate ?? t.startDate else { return nil }
                let date = (t.startDate.map { $0 >= today } ?? false) ? t.startDate! : last
                guard last >= today, date <= horizon else { return nil }
                return (t, date)
            }
            .sorted { a, b in a.1 != b.1 ? a.1 < b.1 : compareTasks(a.0, b.0) < 0 }
            .map { SidebarCounts.Event(task: $0.0, date: $0.1, label: formatRelativeKo($0.1, today)) }
        return c
    }
}
