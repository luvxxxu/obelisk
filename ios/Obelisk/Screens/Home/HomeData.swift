import Foundation
import Observation

// Read-only derivations for the home dashboard (port of web/src/app/(app)/_home/useHomeData.ts plus the
// small selections page.tsx makes). Every number matches the page you land on after tapping through:
//   today / overdue / done today → 오늘 · next 7 days → 예정 · overdue roots + ripple, key tasks → 예측
//   project progress / finish → the project page · completions → 완료 기록 (completedAt in the user's zone)

enum HomeLevel { case danger, warn, ok }

struct HomeRootRisk: Identifiable {
    var task: TaskItem
    var days: Int
    var report: ImpactReport
    var id: String { task.id }
}

struct HomeFixedItem: Identifiable {
    var task: TaskItem
    /// The date that matters next: a future start, otherwise the due date.
    var date: ISODate
    var conflict: TaskImpact?
    var id: String { task.id }
}

struct HomeProjectRow: Identifiable {
    var project: Project
    var done: Int
    var total: Int
    var finish: ISODate?
    var slip: ProjectSlip?
    var id: String { project.id }
}

struct HomeKeyTask: Identifiable {
    var task: TaskItem
    var lev: TaskLeverage
    var id: String { task.id }
}

struct HomeWeekDay: Identifiable {
    var date: ISODate
    var tasks: [TaskItem]
    var id: ISODate { date }
}

struct HomeUpcomingEntry: Identifiable {
    var task: TaskItem
    var date: ISODate
    var id: String { task.id }
}

struct HomeData {
    /// Fixed commitments shown on Home: today … today + 30.
    static let fixedHorizonDays = 30

    var today: ISODate
    var userName: String?
    var fc: ImpactReport
    var overdue: [TaskItem]
    var todays: [TaskItem]
    var doneToday: [TaskItem]
    var remaining: Int
    var doing: Int
    var oldestOverdue: Int
    var delayed: Int
    var conflicts: Int
    var level: HomeLevel
    var week: [HomeWeekDay]
    var roots: [HomeRootRisk]
    var fixed: [HomeFixedItem]
    var projectRows: [HomeProjectRow]
    var keyItems: [HomeKeyTask]
    var keyTotal: Int
    /// How many tasks hold others up at all (0 = no dependencies linked yet).
    var keyLinked: Int
    /// Postponed twice or more, most postponed first (자주 미룬 작업).
    var chronic: [TaskItem]
    /// Projects grouped for the 진행 상황 board.
    var started: [HomeProjectRow]
    var notStarted: [HomeProjectRow]
    var finished: [HomeProjectRow]

    var upcoming: [HomeUpcomingEntry] {
        week.flatMap { d in d.tasks.map { HomeUpcomingEntry(task: $0, date: d.date) } }
    }

    /// Largest shift among tasks pushed by overdue work (the overdue tasks themselves don't count).
    var maxDownstreamShift: Int {
        fc.impacts.reduce(0) { $1.kind == .shifted ? max($0, $1.shiftDays) : $0 }
    }

    /// How many days the whole plan's finish moves (0 = on plan).
    var finishShift: Int {
        guard let from = fc.summary.finishFrom, let to = fc.summary.finishTo, from != to else { return 0 }
        return diffDays(to, from)
    }
}

private func homeIsActive(_ t: TaskItem) -> Bool { t.status == .todo || t.status == .doing }

extension HomeData {
    @MainActor
    init(store: AppStore, now: Clock) {
        let today = store.today
        let tz = store.timezone
        // Stable order (the web keeps the server's order); the forecast and leverage break ties by it.
        let tasks = store.taskList.sorted { $0.number < $1.number }
        let byId = store.tasks
        let deps = store.deps
        let items = planItems(tasks)
        let fc = forecast(items, deps, today)
        let lev = leverage(items, deps)

        // Same selection as the Today page.
        let overdue = selectView(tasks, .overdue, today, now)
        let todays = selectView(tasks, .today, today).filter { !isOverdue($0, today, now) }
        let doneToday = JS.sorted(tasks.filter { $0.status == .done && completedOn($0, tz) == today }, compareDone)

        // Same bucketing as the Upcoming page (due date, else start), first 7 days only.
        var byDay: [ISODate: [TaskItem]] = [:]
        let horizon = addDays(today, 7)
        for t in selectView(tasks, .upcoming, today) {
            guard let d = t.dueDate ?? t.startDate, d <= horizon else { continue }
            byDay[d, default: []].append(t)
        }
        let week = (0 ..< 7).map { i -> HomeWeekDay in
            let date = addDays(today, i + 1)
            return HomeWeekDay(date: date, tasks: JS.sorted(byDay[date] ?? [], compareTasks))
        }

        // One entry per overdue root with only the ripple that root causes (Forecast page logic).
        let roots = JS.sorted(
            fc.rootIds.compactMap { id -> HomeRootRisk? in
                guard let t = byId[id], let anchor = t.dueDate ?? t.startDate else { return nil }
                let days = diffDays(today, anchor)
                return HomeRootRisk(task: t, days: days, report: simulate(items, deps, [id: days]))
            }
        ) { a, b in
            if b.report.summary.conflictCount != a.report.summary.conflictCount {
                return b.report.summary.conflictCount - a.report.summary.conflictCount
            }
            if b.report.summary.delayedCount != a.report.summary.delayedCount {
                return b.report.summary.delayedCount - a.report.summary.delayedCount
            }
            return b.days - a.days
        }

        var conflictsById: [String: TaskImpact] = [:]
        for im in fc.impacts where im.kind == .conflict { conflictsById[im.taskId] = im }
        let end = addDays(today, Self.fixedHorizonDays)
        var fixed: [HomeFixedItem] = []
        for t in tasks where t.fixed && homeIsActive(t) {
            guard let last = t.dueDate ?? t.startDate, last >= today else { continue }
            let date = (t.startDate.map { $0 >= today } ?? false) ? t.startDate! : last
            if date > end { continue }
            fixed.append(HomeFixedItem(task: t, date: date, conflict: conflictsById[t.id]))
        }
        fixed = JS.sorted(fixed) { a, b in
            if a.date != b.date { return a.date < b.date ? -1 : 1 }
            return compareTasks(a.task, b.task)
        }

        // Same per-project numbers as the project page header.
        let projectRows = store.openProjects.map { p -> HomeProjectRow in
            let mine = tasks.filter { $0.projectId == p.id }
            let active = mine.filter(homeIsActive)
            let done = mine.filter { $0.status == .done }.count
            let finish = active.compactMap { $0.dueDate ?? $0.startDate }.max()
            let slip = fc.summary.projectSlips.first { $0.projectId == p.id }
            return HomeProjectRow(project: p, done: done, total: active.count + done, finish: finish, slip: slip)
        }

        // Same filter as the Forecast page's 핵심 작업.
        let bottlenecks = lev.filter { $0.delayedIfLate + $0.conflictsIfLate > 0 || $0.slackDays == 0 }
        let keyItems = bottlenecks.prefix(3).compactMap { l in byId[l.taskId].map { HomeKeyTask(task: $0, lev: l) } }

        let chronic = Array(
            JS.sorted(tasks.filter { homeIsActive($0) && $0.postponedCount >= 2 }) { $1.postponedCount - $0.postponedCount }
                .prefix(3)
        )

        var doingProjects = Set<String>()
        for t in tasks where t.status == .doing { if let p = t.projectId { doingProjects.insert(p) } }
        var started: [HomeProjectRow] = []
        var notStarted: [HomeProjectRow] = []
        var finished: [HomeProjectRow] = []
        for r in projectRows {
            if r.total > 0, r.done == r.total { finished.append(r) }
            else if r.done > 0 || doingProjects.contains(r.project.id) { started.append(r) }
            else { notStarted.append(r) }
        }

        let delayed = fc.summary.delayedCount
        let conflicts = fc.summary.conflictCount

        self.init(
            today: today,
            userName: store.user?.name,
            fc: fc,
            overdue: overdue,
            todays: todays,
            doneToday: doneToday,
            remaining: overdue.count + todays.count,
            doing: overdue.filter { $0.status == .doing }.count + todays.filter { $0.status == .doing }.count,
            oldestOverdue: overdue.reduce(0) { m, t in t.dueDate.map { max(m, diffDays(today, $0)) } ?? m },
            delayed: delayed,
            conflicts: conflicts,
            level: conflicts > 0 ? .danger : (!overdue.isEmpty || delayed > 0 ? .warn : .ok),
            week: week,
            roots: roots,
            fixed: fixed,
            projectRows: projectRows,
            keyItems: keyItems,
            keyTotal: bottlenecks.count,
            keyLinked: lev.count,
            chronic: chronic,
            started: started,
            notStarted: notStarted,
            finished: finished
        )
    }
}

/// Recomputes the dashboard only when the store or the minute changed (the forecast and leverage
/// simulations are the expensive part), like the web's useMemo.
@Observable
@MainActor
final class HomeDataCache {
    @ObservationIgnored private var key: String?
    @ObservationIgnored private var value: HomeData?

    func data(_ store: AppStore, _ now: Clock) -> HomeData {
        let k = "\(store.revision)|\(store.today)|\(now.date)|\(now.minutes)|\(store.workspace?.id ?? "")"
        if k == key, let value { return value }
        let v = HomeData(store: store, now: now)
        key = k
        value = v
        return v
    }
}
