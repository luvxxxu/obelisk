import Foundation

// Port of packages/core/src/impact.ts — the delay-impact engine: "if this slips, what else slips?"
//
// Model
//  - Every scheduled task occupies [start, due] (inclusive calendar days). A task with only a due date
//    is a one-day task; only a start date likewise.
//  - A dependency `B dependsOn A` is finish-to-start with zero lag: B may start on the day A is due.
//  - When A moves later, B is pushed by exactly the amount that would newly violate the constraint.
//    Slack between A.due and B.start absorbs the delay, and pre-existing violations are never amplified.
//  - Fixed tasks (meetings, hard deadlines) never move. A push into a fixed task is reported as a
//    conflict, and the ripple stops there.
//  - Done/canceled tasks neither move nor constrain.
//  - Unscheduled tasks pass the delay through to their own successors.

struct PlanItem: Codable, Hashable, Sendable, Identifiable, TimedSpanLike {
    var id: String
    var title: String
    var status: TaskStatus
    var startDate: ISODate?
    var dueDate: ISODate?
    /// Times ride along with their dates; the delay model itself works in whole days.
    var startTime: ISOTime?
    var dueTime: ISOTime?
    var fixed: Bool
    var projectId: String?
    var number: Int?

    init(
        id: String, title: String, status: TaskStatus, startDate: ISODate?, dueDate: ISODate?,
        startTime: ISOTime? = nil, dueTime: ISOTime? = nil, fixed: Bool, projectId: String?, number: Int? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.startDate = startDate
        self.dueDate = dueDate
        self.startTime = startTime
        self.dueTime = dueTime
        self.fixed = fixed
        self.projectId = projectId
        self.number = number
    }

    /// The plan item of a task (the server's `toPlanItem`, the web store's `planItems`).
    init(task t: TaskItem) {
        self.init(
            id: t.id, title: t.title, status: t.status, startDate: t.startDate, dueDate: t.dueDate,
            startTime: t.startTime, dueTime: t.dueTime, fixed: t.fixed, projectId: t.projectId, number: t.number
        )
    }
}

/// Every task as a plan item, in order (web store's `planItems`).
func planItems(_ tasks: [TaskItem]) -> [PlanItem] { tasks.map(PlanItem.init(task:)) }

/// `taskId` cannot start until `dependsOnId` is finished (same shape as `Dependency`).
typealias PlanDependency = Dependency

enum ImpactKind: String, Codable, CaseIterable, Hashable, Sendable {
    case root, shifted, conflict, absorbed, unscheduled
}

struct DateSpan: Codable, Hashable, Sendable, TimedSpanLike {
    var startDate: ISODate?
    var dueDate: ISODate?
    /// Always nil: a DateSpan has no times (lets `spanLabel` take a DateSpan).
    var startTime: ISOTime? { nil }
    var dueTime: ISOTime? { nil }

    init(startDate: ISODate?, dueDate: ISODate?) {
        self.startDate = startDate
        self.dueDate = dueDate
    }
}

struct TaskImpact: Codable, Hashable, Sendable {
    var taskId: String
    var title: String
    var number: Int?
    var projectId: String?
    var kind: ImpactKind
    /// How far the task moves (root/shifted). 0 for conflict/absorbed.
    var shiftDays: Int
    /// For conflicts: how many days the upstream work now overruns this fixed task.
    var overrunDays: Int
    /// For absorbed: slack days still left after absorbing the delay.
    var slackDays: Int?
    var from: DateSpan
    var to: DateSpan
    /// Hops from the nearest root. Root = 0.
    var depth: Int
    /// The upstream task whose delay caused this impact.
    var viaId: String?
}

struct ProjectSlip: Codable, Hashable, Sendable {
    var projectId: String
    var from: ISODate
    var to: ISODate
    var shiftDays: Int
}

struct ImpactSummary: Codable, Hashable, Sendable {
    var delayedCount: Int
    var conflictCount: Int
    var absorbedCount: Int
    var unscheduledCount: Int
    var maxShiftDays: Int
    var projectSlips: [ProjectSlip]
    /// Latest due date across all active scheduled work, before and after.
    var finishFrom: ISODate?
    var finishTo: ISODate?
}

struct ImpactReport: Codable, Hashable, Sendable {
    var rootIds: [String]
    var impacts: [TaskImpact]
    var summary: ImpactSummary
}

/// One task's new dates. `startTime`/`dueTime` are tri-state, like the TypeScript's optional nullable:
/// `nil` = omitted (the task keeps its time; a cleared date clears it), `.some(nil)` = JSON null (clear),
/// `.some("15:00")` = set. `startDate`/`dueDate` are always sent (null clears).
struct DateChange: Codable, Hashable, Sendable {
    var taskId: String
    var startDate: ISODate?
    var dueDate: ISODate?
    var startTime: ISOTime??
    var dueTime: ISOTime??

    init(taskId: String, startDate: ISODate?, dueDate: ISODate?, startTime: ISOTime?? = nil, dueTime: ISOTime?? = nil) {
        self.taskId = taskId
        self.startDate = startDate
        self.dueDate = dueDate
        self.startTime = startTime
        self.dueTime = dueTime
    }

    private enum CodingKeys: String, CodingKey { case taskId, startDate, dueDate, startTime, dueTime }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId)
        startDate = try c.decodeIfPresent(String.self, forKey: .startDate)
        dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate)
        startTime = try DateChange.decodeTriState(c, .startTime)
        dueTime = try DateChange.decodeTriState(c, .dueTime)
    }

    private static func decodeTriState(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) throws -> String?? {
        guard c.contains(key) else { return nil }
        if try c.decodeNil(forKey: key) { return .some(nil) }
        return .some(try c.decode(String.self, forKey: key))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(taskId, forKey: .taskId)
        if let startDate { try c.encode(startDate, forKey: .startDate) } else { try c.encodeNil(forKey: .startDate) }
        if let dueDate { try c.encode(dueDate, forKey: .dueDate) } else { try c.encodeNil(forKey: .dueDate) }
        if let startTime {
            if let t = startTime { try c.encode(t, forKey: .startTime) } else { try c.encodeNil(forKey: .startTime) }
        }
        if let dueTime {
            if let t = dueTime { try c.encode(t, forKey: .dueTime) } else { try c.encodeNil(forKey: .dueTime) }
        }
    }
}

private func isActiveStatus(_ s: TaskStatus) -> Bool { s == .todo || s == .doing }

private struct Span {
    var s: Int?
    var e: Int?
}

private func spanOf(_ item: PlanItem) -> Span {
    let start = item.startDate.jsTruthy ? item.startDate : (item.dueDate.jsTruthy ? item.dueDate : nil)
    let end = item.dueDate.jsTruthy ? item.dueDate : (item.startDate.jsTruthy ? item.startDate : nil)
    return Span(s: start.map(toDay), e: end.map(toDay))
}

/// Ordered string set (JS `Set` keeps insertion order).
private struct OrderedSet {
    private(set) var list: [String] = []
    private var seen: Set<String> = []

    var count: Int { list.count }

    func contains(_ s: String) -> Bool { seen.contains(s) }

    @discardableResult
    mutating func insert(_ s: String) -> Bool {
        if seen.contains(s) { return false }
        seen.insert(s)
        list.append(s)
        return true
    }

    mutating func remove(_ s: String) {
        if seen.remove(s) != nil { list.removeAll { $0 == s } }
    }
}

private func push(_ map: inout [String: [String]], _ key: String, _ value: String) {
    map[key, default: []].append(value)
}

private final class PlanGraph {
    /// Item ids in insertion order (a JS Map's iteration order).
    var order: [String] = []
    var items: [String: PlanItem] = [:]
    var preds: [String: [String]] = [:]
    var succs: [String: [String]] = [:]
    var spans: [String: Span] = [:]
    private var oldEffMemo: [String: Int?] = [:]

    init(_ items: [PlanItem], _ deps: [PlanDependency]) {
        for it in items {
            if self.items[it.id] == nil { order.append(it.id) }
            self.items[it.id] = it
            spans[it.id] = spanOf(it)
        }
        for d in deps {
            if d.taskId == d.dependsOnId { continue }
            if self.items[d.taskId] == nil || self.items[d.dependsOnId] == nil { continue }
            push(&preds, d.taskId, d.dependsOnId)
            push(&succs, d.dependsOnId, d.taskId)
        }
    }

    func active(_ id: String) -> Bool {
        guard let it = items[id] else { return false }
        return isActiveStatus(it.status)
    }

    func activePreds(_ id: String) -> [String] { (preds[id] ?? []).filter(active) }

    func activeSuccs(_ id: String) -> [String] { (succs[id] ?? []).filter(active) }

    /// Effective finish day in the current plan (unscheduled tasks inherit from preds).
    func oldEff(_ id: String) -> Int? {
        var visiting = Set<String>()
        return oldEff(id, &visiting)
    }

    private func oldEff(_ id: String, _ visiting: inout Set<String>) -> Int? {
        if let memo = oldEffMemo[id] { return memo }
        if !active(id) { return nil }
        if let e = spans[id]?.e {
            oldEffMemo[id] = .some(e)
            return e
        }
        if visiting.contains(id) { return nil }
        visiting.insert(id)
        var best: Int? = nil
        for p in activePreds(id) {
            if let v = oldEff(p, &visiting), best == nil || v > best! { best = v }
        }
        visiting.remove(id)
        oldEffMemo[id] = .some(best)
        return best
    }

    /// Active transitive successors of the given roots, roots included.
    func reach(_ roots: [String]) -> OrderedSet {
        var seen = OrderedSet()
        var queue: [String] = []
        for r in roots where active(r) && !seen.contains(r) {
            seen.insert(r)
            queue.append(r)
        }
        var head = 0
        while head < queue.count {
            let n = queue[head]
            head += 1
            for s in activeSuccs(n) where !seen.contains(s) {
                seen.insert(s)
                queue.append(s)
            }
        }
        return seen
    }

    /// Kahn topological order restricted to `nodes`. Cycle members (shouldn't exist) go last.
    func topo(_ nodes: OrderedSet) -> [String] {
        var indeg: [String: Int] = [:]
        for n in nodes.list { indeg[n] = activePreds(n).filter { nodes.contains($0) }.count }
        var queue = nodes.list.filter { indeg[$0] == 0 }
        var head = 0
        var out: [String] = []
        while head < queue.count {
            let n = queue[head]
            head += 1
            out.append(n)
            for s in activeSuccs(n) where nodes.contains(s) {
                let d = indeg[s]! - 1
                indeg[s] = d
                if d == 0 { queue.append(s) }
            }
        }
        if out.count < nodes.count {
            let placed = Set(out)
            for n in nodes.list where !placed.contains(n) { out.append(n) }
        }
        return out
    }
}

private func iso(_ d: Int?) -> ISODate? { d.map(fromDay) }

private func shiftIso(_ date: ISODate?, _ days: Int) -> ISODate? {
    guard date.jsTruthy, let date else { return nil }
    return fromDay(toDay(date) + days)
}

/// Core propagation. `shifts` maps root task ids to the number of days they move (negative = earlier).
/// Returns every task the change touches. Roots are taken in the order of `items`.
func simulate(_ items: [PlanItem], _ deps: [PlanDependency], _ shifts: [String: Int]) -> ImpactReport {
    var seen = Set<String>()
    var ordered: [(String, Int)] = []
    for it in items where !seen.contains(it.id) {
        seen.insert(it.id)
        if let days = shifts[it.id] { ordered.append((it.id, days)) }
    }
    return simulate(items, deps, orderedShifts: ordered)
}

/// `simulate` with the roots in a given order (a JS Map's insertion order).
func simulate(_ items: [PlanItem], _ deps: [PlanDependency], orderedShifts: [(String, Int)]) -> ImpactReport {
    let g = PlanGraph(items, deps)
    var shiftMap: [String: Int] = [:]
    var keys: [String] = []
    for (id, days) in orderedShifts {
        if shiftMap[id] == nil { keys.append(id) }
        shiftMap[id] = days
    }
    let rootIds = keys.filter { g.active($0) }
    let nodes = g.reach(rootIds)
    let order = g.topo(nodes)

    var newEff: [String: Int?] = [:]
    func effNow(_ id: String) -> Int? {
        if let v = newEff[id] { return v }
        return g.oldEff(id)
    }
    var depthOf: [String: Int] = [:]
    var impacts: [TaskImpact] = []

    for id in order {
        let item = g.items[id]!
        let span = g.spans[id]!
        let rootShift = shiftMap[id]
        let isRoot = rootShift != nil && g.active(id)
        let preds = g.activePreds(id)

        let movedPreds = preds.filter { p in
            let o = g.oldEff(p)
            guard let n = effNow(p) else { return false }
            return o == nil || n > o!
        }

        func base(kind: ImpactKind, shiftDays: Int, overrunDays: Int, slackDays: Int?, to: DateSpan, depth: Int, viaId: String?) -> TaskImpact {
            TaskImpact(
                taskId: id, title: item.title, number: item.number, projectId: item.projectId, kind: kind,
                shiftDays: shiftDays, overrunDays: overrunDays, slackDays: slackDays,
                from: DateSpan(startDate: item.startDate, dueDate: item.dueDate), to: to, depth: depth, viaId: viaId
            )
        }

        if let s = span.s, let e = span.e {
            var v0 = 0
            var v1 = 0
            var via: String? = nil
            var viaEnd = Int.min
            for p in preds {
                let o = g.oldEff(p)
                let n = effNow(p)
                if let o { v0 = max(v0, o - s) }
                if let n { v1 = max(v1, n - s) }
                if let n, movedPreds.contains(p), n > viaEnd {
                    viaEnd = n
                    via = p
                }
            }
            let depShift = max(0, v1 - v0)

            if isRoot {
                let shift = max(rootShift!, depShift)
                newEff[id] = .some(e + shift)
                depthOf[id] = 0
                impacts.append(base(
                    kind: .root, shiftDays: shift, overrunDays: 0, slackDays: nil,
                    to: DateSpan(startDate: shiftIso(item.startDate, shift), dueDate: shiftIso(item.dueDate, shift)),
                    depth: 0, viaId: nil
                ))
                continue
            }

            let depth = via != nil ? (depthOf[via!] ?? 0) + 1 : 1
            if depShift > 0 && item.fixed {
                newEff[id] = .some(e)
                depthOf[id] = depth
                impacts.append(base(
                    kind: .conflict, shiftDays: 0, overrunDays: depShift, slackDays: nil,
                    to: DateSpan(startDate: item.startDate, dueDate: item.dueDate), depth: depth, viaId: via
                ))
            } else if depShift > 0 {
                newEff[id] = .some(e + depShift)
                depthOf[id] = depth
                impacts.append(base(
                    kind: .shifted, shiftDays: depShift, overrunDays: 0, slackDays: nil,
                    to: DateSpan(startDate: shiftIso(item.startDate, depShift), dueDate: shiftIso(item.dueDate, depShift)),
                    depth: depth, viaId: via
                ))
            } else if !movedPreds.isEmpty {
                newEff[id] = .some(e)
                depthOf[id] = depth
                var slack = Int.max
                for p in movedPreds { slack = min(slack, s - (effNow(p) ?? s)) }
                impacts.append(base(
                    kind: .absorbed, shiftDays: 0, overrunDays: 0, slackDays: max(0, slack == Int.max ? 0 : slack),
                    to: DateSpan(startDate: item.startDate, dueDate: item.dueDate), depth: depth, viaId: via
                ))
            } else {
                newEff[id] = .some(e)
            }
        } else {
            // Unscheduled: inherits the latest upstream finish.
            let o = g.oldEff(id)
            var n: Int? = nil
            var via: String? = nil
            for p in preds {
                if let v = effNow(p), n == nil || v > n! {
                    n = v
                    via = p
                }
            }
            if !isRoot, let nv = n, !movedPreds.isEmpty, o == nil || nv > o! {
                let depth = via != nil ? (depthOf[via!] ?? 0) + 1 : 1
                newEff[id] = .some(nv)
                depthOf[id] = depth
                impacts.append(base(
                    kind: .unscheduled, shiftDays: o == nil ? 0 : nv - o!, overrunDays: 0, slackDays: nil,
                    to: DateSpan(startDate: nil, dueDate: nil), depth: depth, viaId: via
                ))
            } else {
                newEff[id] = .some(o)
            }
        }
    }

    let kindRank: [ImpactKind: Int] = [.root: 0, .conflict: 1, .shifted: 2, .unscheduled: 3, .absorbed: 4]
    impacts = JS.sorted(impacts) { a, b in
        let ra = a.kind == .root ? 0 : 1
        let rb = b.kind == .root ? 0 : 1
        if ra != rb { return ra - rb }
        if a.depth != b.depth { return a.depth - b.depth }
        if kindRank[a.kind]! != kindRank[b.kind]! { return kindRank[a.kind]! - kindRank[b.kind]! }
        let da = a.to.dueDate ?? ""
        let db = b.to.dueDate ?? ""
        return da == db ? 0 : (da < db ? -1 : 1)
    }

    return ImpactReport(rootIds: rootIds, impacts: impacts, summary: summarize(g, impacts, newEff))
}

private func summarize(_ g: PlanGraph, _ impacts: [TaskImpact], _ newEff: [String: Int?]) -> ImpactSummary {
    var delayedCount = 0
    var conflictCount = 0
    var absorbedCount = 0
    var unscheduledCount = 0
    var maxShiftDays = 0
    var touchedProjects = Set<String>()
    for im in impacts {
        switch im.kind {
        case .shifted:
            delayedCount += 1
            maxShiftDays = max(maxShiftDays, im.shiftDays)
        case .conflict:
            conflictCount += 1
            maxShiftDays = max(maxShiftDays, im.overrunDays)
        case .absorbed:
            absorbedCount += 1
        case .unscheduled:
            unscheduledCount += 1
        case .root:
            maxShiftDays = max(maxShiftDays, im.shiftDays)
        }
        if let p = im.projectId, !p.isEmpty, im.kind != .absorbed { touchedProjects.insert(p) }
    }

    var projectOrder: [String] = []
    var projectFinish: [String: (from: Int, to: Int)] = [:]
    var finishFrom: Int? = nil
    var finishTo: Int? = nil
    for id in g.order {
        guard let item = g.items[id], g.active(id) else { continue }
        guard let e = g.spans[id]?.e else { continue }
        let ne: Int
        if let v = newEff[id] { ne = v ?? e } else { ne = e }
        finishFrom = finishFrom == nil ? e : max(finishFrom!, e)
        finishTo = finishTo == nil ? ne : max(finishTo!, ne)
        if let p = item.projectId, !p.isEmpty, touchedProjects.contains(p) {
            if let cur = projectFinish[p] {
                projectFinish[p] = (max(cur.from, e), max(cur.to, ne))
            } else {
                projectOrder.append(p)
                projectFinish[p] = (e, ne)
            }
        }
    }
    var projectSlips: [ProjectSlip] = []
    for p in projectOrder {
        let f = projectFinish[p]!
        if f.to != f.from {
            projectSlips.append(ProjectSlip(projectId: p, from: fromDay(f.from), to: fromDay(f.to), shiftDays: f.to - f.from))
        }
    }
    projectSlips = JS.sorted(projectSlips) { a, b in b.shiftDays - a.shiftDays }

    return ImpactSummary(
        delayedCount: delayedCount, conflictCount: conflictCount, absorbedCount: absorbedCount,
        unscheduledCount: unscheduledCount, maxShiftDays: maxShiftDays, projectSlips: projectSlips,
        finishFrom: iso(finishFrom), finishTo: iso(finishTo)
    )
}

enum ImpactError: Error, Equatable {
    /// `simulateDelay` was given an id that is not in `items` ("Task not found").
    case taskNotFound
}

/// "What if I push this task by N days / to this date?"
func simulateDelay(_ items: [PlanItem], _ deps: [PlanDependency], taskId: String, days: Int? = nil, toDate: ISODate? = nil) throws -> ImpactReport {
    guard let item = items.first(where: { $0.id == taskId }) else { throw ImpactError.taskNotFound }
    let d = resolveDelayDays(item, days: days, toDate: toDate)
    return simulate(items, deps, orderedShifts: [(item.id, d)])
}

/// Turns "to this date" into a day count, measured on the due date (or start date).
func resolveDelayDays<T: DateSpanLike>(_ item: T, days: Int? = nil, toDate: ISODate? = nil) -> Int {
    if let days { return days }
    guard toDate.jsTruthy, let toDate else { return 0 }
    guard let anchor = item.dueDate ?? item.startDate, !anchor.isEmpty else { return 0 }
    return toDay(toDate) - toDay(anchor)
}

/// Live forecast: every unfinished task whose due date has passed can finish today at the earliest.
/// Propagate that reality through the plan.
func forecast(_ items: [PlanItem], _ deps: [PlanDependency], _ today: ISODate) -> ImpactReport {
    let t = toDay(today)
    var shifts: [(String, Int)] = []
    var seen = Set<String>()
    for it in items {
        // Only a passed *due* date makes a task late; a start date in the past just means "started".
        guard isActiveStatus(it.status), let due = it.dueDate, !due.isEmpty else { continue }
        let e = toDay(due)
        if e < t {
            if seen.insert(it.id).inserted {
                shifts.append((it.id, t - e))
            } else if let k = shifts.firstIndex(where: { $0.0 == it.id }) {
                shifts[k].1 = t - e
            }
        }
    }
    return simulate(items, deps, orderedShifts: shifts)
}

struct BlockerWarning: Codable, Hashable, Sendable {
    var taskId: String
    var title: String
    var number: Int?
    /// The blocker's finish date.
    var dueDate: ISODate
    /// How many days the edited task would start before that blocker is due.
    var overlapDays: Int
}

struct DateChangePreview: Codable, Hashable, Sendable {
    var report: ImpactReport
    /// How far the task's finish moves (what propagates downstream).
    var shiftDays: Int
    /// Blockers the edited task would now start before (moving earlier than its dependencies allow).
    var startsBeforeBlockers: [BlockerWarning]
    /// True when something else would be pushed, a fixed date would break, or a blocker would be overrun.
    var hasImpact: Bool
    /// Apply only the edited task.
    var only: [DateChange]
    /// Apply the edited task plus every task it pushes.
    var cascade: [DateChange]
}

/// Preview an arbitrary edit of one task's dates (move, extend, shorten). Only the movement of its
/// finish propagates; the task itself takes exactly `next`.
func previewDateChange<S: DateSpanLike>(_ items: [PlanItem], _ deps: [PlanDependency], _ taskId: String, _ next: S) -> DateChangePreview {
    let nextSpan = DateSpan(startDate: next.startDate, dueDate: next.dueDate)
    let item = items.first { $0.id == taskId }
    let oldEnd = item.flatMap { $0.dueDate ?? $0.startDate }
    let newEnd = nextSpan.dueDate ?? nextSpan.startDate
    let shiftDays = (oldEnd.jsTruthy && newEnd.jsTruthy) ? toDay(newEnd!) - toDay(oldEnd!) : 0
    var report = simulate(items, deps, orderedShifts: [(taskId, shiftDays)])
    for k in report.impacts.indices where report.impacts[k].taskId == taskId && report.impacts[k].kind == .root {
        report.impacts[k].to = nextSpan
    }
    let only = [DateChange(taskId: taskId, startDate: nextSpan.startDate, dueDate: nextSpan.dueDate)]
    let cascade = only + report.impacts
        .filter { $0.kind == .shifted }
        .map { DateChange(taskId: $0.taskId, startDate: $0.to.startDate, dueDate: $0.to.dueDate) }

    // Moving a task earlier can make it start before its own blockers finish.
    var startsBeforeBlockers: [BlockerWarning] = []
    let newStart = nextSpan.startDate ?? nextSpan.dueDate
    let oldStart = item.flatMap { $0.startDate ?? $0.dueDate }
    if newStart.jsTruthy, let newStart {
        for d in deps where d.taskId == taskId {
            guard let b = items.first(where: { $0.id == d.dependsOnId }), isActiveStatus(b.status) else { continue }
            guard let bEnd = b.dueDate ?? b.startDate, !bEnd.isEmpty else { continue }
            let overlap = toDay(bEnd) - toDay(newStart)
            let before = oldStart.jsTruthy ? toDay(bEnd) - toDay(oldStart!) : 0
            if overlap > 0 && overlap > max(0, before) {
                startsBeforeBlockers.append(BlockerWarning(taskId: b.id, title: b.title, number: b.number, dueDate: bEnd, overlapDays: overlap))
            }
        }
    }

    return DateChangePreview(
        report: report,
        shiftDays: shiftDays,
        startsBeforeBlockers: startsBeforeBlockers,
        hasImpact: report.summary.delayedCount + report.summary.conflictCount > 0 || !startsBeforeBlockers.isEmpty,
        only: only,
        cascade: cascade
    )
}

/// Date updates needed to commit a report. `cascade: false` moves only the roots.
func changesFromReport(_ report: ImpactReport, _ cascade: Bool = true) -> [DateChange] {
    report.impacts
        .filter { $0.kind == .root || (cascade && $0.kind == .shifted) }
        .filter { $0.shiftDays != 0 }
        .map { DateChange(taskId: $0.taskId, startDate: $0.to.startDate, dueDate: $0.to.dueDate) }
}

struct TaskLeverage: Codable, Hashable, Sendable {
    var taskId: String
    /// Active tasks transitively waiting on this one.
    var downstreamCount: Int
    /// Days this task can slip before anything else moves (nil = nothing scheduled downstream).
    var slackDays: Int?
    /// If this slips by one day: how many tasks move / how many fixed dates break.
    var delayedIfLate: Int
    var conflictsIfLate: Int
}

/// Which tasks hold the plan together? Ranks by what a one-day slip would cost.
func leverage(_ items: [PlanItem], _ deps: [PlanDependency]) -> [TaskLeverage] {
    let g = PlanGraph(items, deps)
    var out: [TaskLeverage] = []
    for id in g.order {
        if !g.active(id) { continue }
        let succs = g.activeSuccs(id)
        if succs.isEmpty { continue }
        var downstream = g.reach([id])
        downstream.remove(id)
        let e = g.spans[id]!.e
        var slack: Int? = nil
        if let e {
            for sId in succs {
                guard let ss = g.spans[sId]!.s else { continue }
                let v = max(0, ss - e)
                slack = slack == nil ? v : min(slack!, v)
            }
        }
        var delayedIfLate = 0
        var conflictsIfLate = 0
        if e != nil {
            let r = simulate(items, deps, orderedShifts: [(id, 1)])
            delayedIfLate = r.summary.delayedCount
            conflictsIfLate = r.summary.conflictCount
        }
        out.append(TaskLeverage(
            taskId: id, downstreamCount: downstream.count, slackDays: slack,
            delayedIfLate: delayedIfLate, conflictsIfLate: conflictsIfLate
        ))
    }
    return JS.sorted(out) { a, b in
        if b.conflictsIfLate != a.conflictsIfLate { return b.conflictsIfLate - a.conflictsIfLate }
        if b.delayedIfLate != a.delayedIfLate { return b.delayedIfLate - a.delayedIfLate }
        return b.downstreamCount - a.downstreamCount
    }
}

/// Would `taskId dependsOn dependsOnId` close a loop?
func wouldCreateCycle(_ deps: [PlanDependency], _ taskId: String, _ dependsOnId: String) -> Bool {
    if taskId == dependsOnId { return true }
    // Cycle iff dependsOnId is already (transitively) downstream of taskId.
    var succs: [String: [String]] = [:]
    for d in deps { push(&succs, d.dependsOnId, d.taskId) }
    var seen: Set<String> = [taskId]
    var stack = [taskId]
    while let n = stack.popLast() {
        for s in succs[n] ?? [] {
            if s == dependsOnId { return true }
            if !seen.contains(s) {
                seen.insert(s)
                stack.append(s)
            }
        }
    }
    return false
}

/// All task ids transitively depending on `id` (any status).
func downstreamOf(_ deps: [PlanDependency], _ id: String) -> [String] {
    var succs: [String: [String]] = [:]
    for d in deps { push(&succs, d.dependsOnId, d.taskId) }
    var seen = OrderedSet()
    var stack = [id]
    while let n = stack.popLast() {
        for s in succs[n] ?? [] where !seen.contains(s) && s != id {
            seen.insert(s)
            stack.append(s)
        }
    }
    return seen.list
}

// MARK: - API responses

/// POST /api/impact/simulate
struct ImpactSimulateResponse: Codable, Hashable, Sendable {
    var task: TaskItem
    var days: Int
    var report: ImpactReport
}

/// POST /api/impact/postpone
struct ImpactPostponeResponse: Codable, Hashable, Sendable {
    var task: TaskItem
    var days: Int
    var cascade: Bool
    var report: ImpactReport
    /// Every task the postpone wrote, root included.
    var updated: [TaskItem]
}

/// GET /api/impact/forecast
struct ImpactForecastResponse: Codable, Hashable, Sendable {
    var today: ISODate
    var report: ImpactReport
}

/// GET /api/impact/leverage
struct ImpactLeverageResponse: Codable, Hashable, Sendable {
    var leverage: [TaskLeverage]
}
