import Foundation

// Port of packages/core/src/jev.ts — the pure half of the Jev advisor.
//
// Jev (TypeSafe's System One model) answers small typed questions about each task: how much is at
// stake, whether it could wait a few days, whether someone is waiting on it. It never sees or changes
// dates on its own. Deadlines, ripples and fixed-date conflicts stay with the delay-impact engine, and
// this file combines the two in code with weights you can read and test. Network calls live elsewhere.
// (`JevStatus` itself is in Shared/Models.)

// MARK: - settings

/// TypeSafe's own System One API.
let DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai/v1"

private let RE_TRAILING_SLASHES = JSRegex("/+$")
private let RE_SYSTEMONE_END = JSRegex("/systemone$")
private let RE_AI_RUN = JSRegex("/ai/run/")

/// The request URL for a base URL: `/systemone` is appended unless it is already a full endpoint
/// (ending in `/systemone`, or Workers AI's `/ai/run/<model>`).
func jevEndpoint(_ baseUrl: String) -> String {
    let base = RE_TRAILING_SLASHES.replaceFirst(JS.trim(baseUrl), "")
    let path = JSURL(base)?.pathname ?? base
    return RE_SYSTEMONE_END.test(path) || RE_AI_RUN.test(path) ? base : "\(base)/systemone"
}

enum JevPresetId: String, Codable, CaseIterable, Hashable, Sendable {
    case typesafe, openrouter, cloudflare
}

/// A ready-made setting for a service known to serve the System One API.
struct JevPreset: Codable, Hashable, Sendable, Identifiable {
    var id: JevPresetId
    var label: String
    /// Cloudflare needs the account ID and the model in the path: see `cloudflareJevUrl`.
    var baseUrl: String
    var models: [String]
}

let JEV_PRESETS: [JevPreset] = [
    JevPreset(id: .typesafe, label: "TypeSafe", baseUrl: DEFAULT_JEV_BASE_URL, models: ["jev-latest"]),
    JevPreset(
        id: .openrouter, label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
        models: ["~typesafe/jev-latest", "typesafe/jev-1.14", "typesafe/jev-1.13"]
    ),
    JevPreset(id: .cloudflare, label: "Cloudflare", baseUrl: "https://api.cloudflare.com/client/v4/accounts", models: ["clef", "clef-flash"]),
]

/// Workers AI's endpoint for one of Cloudflare's own decision models.
func cloudflareJevUrl(_ accountId: String, _ model: String) -> String {
    "https://api.cloudflare.com/client/v4/accounts/\(JS.trim(accountId))/ai/run/@cf/cloudflare/\(JS.trim(model))"
}

/// Which preset a stored base URL belongs to (nil: a custom server). nil base URL = TypeSafe.
func jevPresetOf(_ baseUrl: String?) -> JevPresetId? {
    guard let host = JSURL(baseUrl ?? DEFAULT_JEV_BASE_URL)?.hostname else { return nil }
    switch host {
    case "api.typesafe.ai": return .typesafe
    case "openrouter.ai": return .openrouter
    case "api.cloudflare.com": return .cloudflare
    default: return nil
    }
}

/// Judgments at or above this confidence count as "확신" (auto-apply, preselected).
let JEV_CONFIDENT = 0.8

/// PUT /api/jev/settings body. Tri-state fields: nil = leave as is, `.some(nil)` = null (disconnect /
/// back to the default), `.some(value)` = set.
struct JevSettingsInput: Codable, Hashable, Sendable {
    /// A new key (checked with one tiny call before it is saved), or null to disconnect.
    var apiKey: String??
    /// The service's base URL or full endpoint; null = TypeSafe. Moving to another host needs the key again.
    var baseUrl: String??
    /// Model id as the service names it (`jev-latest`, `~typesafe/jev-latest`, `clef` …); null = default.
    var model: String??
    var autoApply: Bool?

    init(apiKey: String?? = nil, baseUrl: String?? = nil, model: String?? = nil, autoApply: Bool? = nil) {
        self.apiKey = apiKey
        self.baseUrl = baseUrl
        self.model = model
        self.autoApply = autoApply
    }

    private enum CodingKeys: String, CodingKey { case apiKey, baseUrl, model, autoApply }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func tri(_ k: CodingKeys) throws -> String?? {
            guard c.contains(k) else { return nil }
            return try c.decodeNil(forKey: k) ? .some(nil) : .some(try c.decode(String.self, forKey: k))
        }
        apiKey = try tri(.apiKey)
        baseUrl = try tri(.baseUrl)
        model = try tri(.model)
        autoApply = try c.decodeIfPresent(Bool.self, forKey: .autoApply)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        func tri(_ v: String??, _ k: CodingKeys) throws {
            guard let v else { return }
            if let s = v { try c.encode(s, forKey: k) } else { try c.encodeNil(forKey: k) }
        }
        try tri(apiKey, .apiKey)
        try tri(baseUrl, .baseUrl)
        try tri(model, .model)
        try c.encodeIfPresent(autoApply, forKey: .autoApply)
    }
}

private let RE_NO_SPACE = JSRegex("^\\S+$")
private let RE_HTTP_URL = JSRegex("^https?://\\S+$", ignoreCase: true)

/// What the server would reject in a Jev settings body, in its order and words (values are trimmed
/// first, as the server does; nil/null fields are not checked).
func jevSettingsIssues(_ input: JevSettingsInput) -> [ValidationIssue] {
    var out: [ValidationIssue] = []
    if case let .some(.some(raw)) = input.apiKey {
        let s = JS.trim(raw)
        if JS.length(s) < 16 { out.append(ValidationIssue(message: "API 키가 너무 짧아요", path: ["apiKey"])) }
        if JS.length(s) > 512 { out.append(ValidationIssue(message: "Too big: expected string to have <=512 characters", path: ["apiKey"])) }
        if !RE_NO_SPACE.test(s) { out.append(ValidationIssue(message: "API 키에는 공백이 들어갈 수 없어요", path: ["apiKey"])) }
    }
    if case let .some(.some(raw)) = input.baseUrl {
        let s = JS.trim(raw)
        if JS.length(s) > 500 { out.append(ValidationIssue(message: "Too big: expected string to have <=500 characters", path: ["baseUrl"])) }
        if !RE_HTTP_URL.test(s) { out.append(ValidationIssue(message: "Base URL은 https://로 시작해야 해요", path: ["baseUrl"])) }
    }
    if case let .some(.some(raw)) = input.model {
        let s = JS.trim(raw)
        if JS.length(s) < 1 { out.append(ValidationIssue(message: "모델을 입력하세요", path: ["model"])) }
        if JS.length(s) > 200 { out.append(ValidationIssue(message: "Too big: expected string to have <=200 characters", path: ["model"])) }
        if !RE_NO_SPACE.test(s) { out.append(ValidationIssue(message: "모델 이름에는 공백이 들어갈 수 없어요", path: ["model"])) }
    }
    return out
}

/// POST /api/jev/priorities body.
struct JevPrioritiesInput: Codable, Hashable, Sendable {
    /// Only these tasks (default: every active task you can edit).
    var taskIds: [String]?

    init(taskIds: [String]? = nil) { self.taskIds = taskIds }
}

enum PostponeScope: String, Codable, CaseIterable, Hashable, Sendable {
    case today, week
}

/// POST /api/jev/postpone body.
struct JevPostponeInput: Codable, Hashable, Sendable {
    var scope: PostponeScope
    /// Tasks per day you can handle (1–50). Default: your recent pace (completions per day).
    var capacity: Int?

    init(scope: PostponeScope = .today, capacity: Int? = nil) {
        self.scope = scope
        self.capacity = capacity
    }
}

/// POST /api/jev/triage body.
struct JevTriageInput: Codable, Hashable, Sendable {
    var title: String
    var notes: String?
    var startDate: ISODate?
    var dueDate: ISODate?
    /// Already chosen by the user: Jev does not pick a project.
    var projectId: String?

    init(title: String, notes: String? = nil, startDate: ISODate? = nil, dueDate: ISODate? = nil, projectId: String? = nil) {
        self.title = title
        self.notes = notes
        self.startDate = startDate
        self.dueDate = dueDate
        self.projectId = projectId
    }
}

/// POST /api/jev/dependencies body.
struct JevDependenciesInput: Codable, Hashable, Sendable {
    var taskId: String
}

// MARK: - judgments

/// What Jev said about one task.
struct TaskJudgment: Codable, Hashable, Sendable {
    /// 0 someday · 1 minor · 2 real obligation · 3 high stakes (continuous).
    var importance: Double
    /// How sure Jev is about the importance level, 0..1.
    var importanceConfidence: Double
    /// Probability that someone else is waiting on it or affected when it is late.
    var others: Double
    /// Probability that it can move a few days later without real harm.
    var deferrable: Double

    init(importance: Double, importanceConfidence: Double, others: Double, deferrable: Double) {
        self.importance = importance
        self.importanceConfidence = importanceConfidence
        self.others = others
        self.deferrable = deferrable
    }
}

/// Used when Jev has no answer for a task: it neither pushes nor holds anything.
let NEUTRAL_JUDGMENT = TaskJudgment(importance: 1.5, importanceConfidence: 0, others: 0.5, deferrable: 0.5)

private func clamp01(_ n: Double) -> Double { n.isFinite ? min(1, max(0, n)) : 0 }

let IMPORTANCE_LABEL_KO = ["언젠가 해도 되는 일", "가벼운 일", "꼭 해야 하는 일", "놓치면 손해가 큰 일"]

/// 0–3: the importance rounded to a level (index into IMPORTANCE_LABEL_KO). NaN reads as 0.
func importanceLevel(_ j: TaskJudgment) -> Int {
    let r = JS.round(j.importance)
    if r.isNaN { return 0 }
    return Int(max(0, min(3, r)))
}

// MARK: - urgency & leverage (deterministic)

struct Urgency: Codable, Hashable, Sendable {
    /// 0 (no date, far away) … 1 (overdue).
    var value: Double
    /// Days until the due date (negative = overdue), nil without one.
    var days: Int?
    var label: String?
}

/// Dates, fixed flag and status: what urgency reads (TaskItem, PlanItem and OverviewTask conform).
protocol UrgencySubject: DateSpanLike {
    var fixed: Bool { get }
    var status: TaskStatus { get }
}

extension TaskItem: UrgencySubject {}
extension PlanItem: UrgencySubject {}
extension OverviewTask: UrgencySubject {}

func urgencyOf<T: UrgencySubject>(_ t: T, _ today: ISODate) -> Urgency {
    var u: Urgency
    if let due = t.dueDate, !due.isEmpty {
        let d = diffDays(due, today)
        let value = d < 0 ? 1 : d == 0 ? 0.95 : d == 1 ? 0.85 : d <= 3 ? 0.7 : d <= 7 ? 0.5 : d <= 14 ? 0.3 : 0.15
        let label = d < 0 ? "\(-d)일 지남" : d == 0 ? "오늘 마감" : d == 1 ? "내일 마감" : "마감 \(d)일 남음"
        u = Urgency(value: value, days: d, label: label)
    } else if let start = t.startDate, !start.isEmpty {
        let s = diffDays(start, today)
        u = Urgency(
            value: s <= 0 ? 0.5 : s <= 3 ? 0.35 : 0.15, days: nil,
            label: s <= 0 ? "시작일 지남" : s == 1 ? "내일 시작" : "\(s)일 뒤 시작"
        )
    } else {
        u = Urgency(value: t.status == .doing ? 0.3 : 0.1, days: nil, label: nil)
    }
    // A fixed commitment this week is urgent however Jev reads the title.
    if t.fixed, let first = t.startDate ?? t.dueDate, !first.isEmpty, diffDays(first, today) <= 7 {
        u.value = max(u.value, 0.6)
    }
    return u
}

/// 0..1: how much of the plan waits on this task (from the engine's one-day-slip test).
func leverageScore(_ l: TaskLeverage?) -> Double {
    guard let l else { return 0 }
    if l.conflictsIfLate > 0 { return 1 }
    return clamp01(Double(l.delayedIfLate) * 0.25 + Double(l.downstreamCount) * 0.08 + (l.slackDays == 0 ? 0.2 : 0))
}

// MARK: - A. priority

/// Score cut points for high / medium / low. Below `low` the task gets no priority.
let PRIORITY_CUTS = (high: 0.64, medium: 0.4, low: 0.17)

/// Importance sets the ceiling, urgency decides how much of it applies now; tasks that hold the plan
/// together get a bump.
func priorityScore(_ j: TaskJudgment, _ urgency: Double, _ leverage: Double) -> Double {
    let i = clamp01(j.importance / 3)
    return clamp01(i * (0.55 + 0.45 * clamp01(urgency)) + 0.15 * clamp01(leverage) + 0.06 * clamp01(j.others))
}

func priorityFromScore(_ score: Double) -> Priority {
    if score >= PRIORITY_CUTS.high { return 3 }
    if score >= PRIORITY_CUTS.medium { return 2 }
    if score >= PRIORITY_CUTS.low { return 1 }
    return 0
}

/// Jev's own certainty, discounted when the score sits right on a cut point.
func priorityConfidence(_ j: TaskJudgment, _ score: Double) -> Double {
    let margin = [PRIORITY_CUTS.high, PRIORITY_CUTS.medium, PRIORITY_CUTS.low].map { abs(score - $0) }.min()!
    return clamp01(j.importanceConfidence * (0.55 + 0.45 * min(1, margin / 0.08)))
}

struct PrioritySuggestion: Codable, Hashable, Sendable {
    var taskId: String
    var current: Priority
    var suggested: Priority
    /// 0..1 composite score.
    var score: Double
    var confidence: Double
    /// Short Korean reasons, most important first.
    var reasons: [String]
    var judgment: TaskJudgment
}

func suggestPriority(_ t: TaskItem, _ j: TaskJudgment, _ lev: TaskLeverage?, _ today: ISODate) -> PrioritySuggestion {
    let u = urgencyOf(t, today)
    let l = leverageScore(lev)
    let score = priorityScore(j, u.value, l)
    var reasons = [IMPORTANCE_LABEL_KO[importanceLevel(j)]]
    if let label = u.label { reasons.append(label) }
    if let lev, lev.conflictsIfLate > 0 { reasons.append("하루 늦으면 고정 일정과 충돌") }
    else if let lev, lev.delayedIfLate > 0 { reasons.append("하루 늦으면 \(lev.delayedIfLate)개 밀림") }
    else if let lev, lev.downstreamCount > 0 { reasons.append("\(lev.downstreamCount)개 작업이 기다림") }
    if j.others >= 0.7 { reasons.append("다른 사람이 기다리는 일") }
    if t.fixed { reasons.append("고정 일정") }
    return PrioritySuggestion(
        taskId: t.id, current: t.priority, suggested: priorityFromScore(score), score: score,
        confidence: priorityConfidence(j, score), reasons: reasons, judgment: j
    )
}

/// Auto-apply only fills in a missing priority: a level the user picked is never overridden silently.
func autoApplicable(_ s: PrioritySuggestion) -> Bool {
    s.current == 0 && s.suggested != 0 && s.confidence >= JEV_CONFIDENT
}

/// Active tasks still waiting on an unfinished blocker can't be started yet.
func isBlocked(_ id: String, _ deps: [PlanDependency], _ status: (String) -> TaskStatus?) -> Bool {
    deps.contains { d in
        guard d.taskId == id else { return false }
        let s = status(d.dependsOnId)
        return s == .todo || s == .doing
    }
}

/// "지금 할 일 하나": the best-scoring task you can start right now — something for today whose
/// blockers are all done. Finishing what is already in progress wins ties. Falls back to the next three
/// days when today is clear.
func pickFocus(_ tasks: [TaskItem], _ deps: [PlanDependency], _ scores: [String: Double], _ today: ISODate) -> String? {
    var status: [String: TaskStatus] = [:]
    for t in tasks { status[t.id] = t.status }
    let startable = tasks.filter { t in
        (t.status == .todo || t.status == .doing) && scores[t.id] != nil && !isBlocked(t.id, deps, { status[$0] })
    }
    let soon = addDays(today, 3)
    let pools = [
        startable.filter { isToday($0, today) },
        startable.filter { t in
            guard let d = t.startDate ?? t.dueDate, !d.isEmpty else { return false }
            return d <= soon
        },
    ]
    for pool in pools where !pool.isEmpty {
        func rank(_ t: TaskItem) -> Double { scores[t.id]! + (t.status == .doing ? 0.05 : 0) }
        let sorted = JS.sorted(pool, by: { a, b in
            let c = rank(b) - rank(a)
            return c != 0 && !c.isNaN ? c : Double(a.number - b.number)
        })
        return sorted[0].id
    }
    return nil
}

// MARK: - B. what to postpone

enum PostponeVerdict: String, Codable, CaseIterable, Hashable, Sendable {
    case postpone, could, keep, fixed
}

struct PostponeCandidate: Codable, Hashable, Sendable {
    var taskId: String
    var verdict: PostponeVerdict
    /// The day the task currently counts on.
    var day: ISODate
    /// Proposed new due (or start) date, when the task can move.
    var toDate: ISODate?
    /// Days its due date moves (what the engine propagates).
    var shiftDays: Int
    /// Other tasks that move with it (cascade), and fixed dates it would break (always 0 when proposed).
    var delayed: Int
    /// 0..1: how safely it can wait.
    var score: Double
    var reasons: [String]
}

struct PostponeDayLoad: Codable, Hashable, Sendable {
    var date: ISODate
    /// Tasks counting on this day now / after the recommended moves.
    var load: Int
    var after: Int
}

enum CapacitySource: String, Codable, CaseIterable, Hashable, Sendable {
    case input, history, `default`
}

struct PostponePlan: Codable, Hashable, Sendable {
    var scope: PostponeScope
    var today: ISODate
    var capacity: Int
    var capacitySource: CapacitySource
    var overloaded: Bool
    var days: [PostponeDayLoad]
    /// Recommended moves first (best to postpone first), then the rest.
    var candidates: [PostponeCandidate]
}

/// `capacityFromHistory`'s answer.
struct CapacityEstimate: Codable, Hashable, Sendable {
    var capacity: Int
    /// `.history` or `.default`
    var source: CapacitySource
}

/// Tasks per day you usually finish: last 14 days' completions, clamped to 3..15. Few data points → 5.
func capacityFromHistory(_ completedOn: [ISODate?], _ today: ISODate) -> CapacityEstimate {
    let from = addDays(today, -14)
    let n = completedOn.filter { d in
        guard let d, !d.isEmpty else { return false }
        return d >= from && d < today
    }.count
    if n < 7 { return CapacityEstimate(capacity: 5, source: .default) }
    let pace = Int((Double(n) / 14 + 0.5).rounded(.up))
    return CapacityEstimate(capacity: min(15, max(3, pace)), source: .history)
}

/// The day a task counts on: today for anything in Today, else its due (or start) date.
private func dayOf(_ t: TaskItem, _ today: ISODate) -> ISODate? {
    if isToday(t, today) { return today }
    return t.dueDate ?? t.startDate
}

/// Below this, Jev's "it can wait" is not enough to recommend a move.
private let MIN_POSTPONE_SCORE = 0.38
/// How far ahead to look for a lighter day.
private let SEARCH_DAYS = 7

private final class PostponeWork {
    let t: TaskItem
    let day: ISODate
    var base: Double
    var reasons: [String]
    var verdict: PostponeVerdict?
    var toDate: ISODate?
    var shiftDays = 0
    var delayed = 0

    init(t: TaskItem, day: ISODate, base: Double, reasons: [String]) {
        self.t = t
        self.day = day
        self.base = base
        self.reasons = reasons
    }
}

/// Which of today's (or this week's) tasks to move, and where, so no day carries more than `capacity`.
func planPostpone(
    tasks: [TaskItem],
    deps: [PlanDependency],
    mine: (TaskItem) -> Bool,
    editable: (TaskItem) -> Bool,
    judgments: [String: TaskJudgment],
    today: ISODate,
    scope: PostponeScope,
    capacity: Int,
    capacitySource: CapacitySource
) -> PostponePlan {
    let items = tasks.map { t in
        PlanItem(
            id: t.id, title: t.title, status: t.status, startDate: t.startDate, dueDate: t.dueDate,
            fixed: t.fixed, projectId: t.projectId, number: t.number
        )
    }
    let active = tasks.filter { ($0.status == .todo || $0.status == .doing) && mine($0) }

    // Load per day across the scope plus the search window.
    var load: [ISODate: Int] = [:]
    for t in active {
        if let d = dayOf(t, today), !d.isEmpty { load[d, default: 0] += 1 }
    }
    let span = scope == .today ? 1 : 7
    let scopeDays = (0 ..< span).map { addDays(today, $0) }
    var initial: [ISODate: Int] = [:]
    for d in scopeDays { initial[d] = load[d] ?? 0 }
    let lastDay = scopeDays[scopeDays.count - 1]

    let considered = active.filter { t in
        guard let d = dayOf(t, today), !d.isEmpty else { return false }
        return d >= today && d <= lastDay
    }

    let work: [PostponeWork] = considered.map { t in
        let day = dayOf(t, today)!
        let j = judgments[t.id] ?? NEUTRAL_JUDGMENT
        var reasons: [String] = []
        var base = 0.6 * clamp01(j.deferrable) + 0.4 * (1 - clamp01(j.importance / 3))
        if j.deferrable >= 0.7 { reasons.append("며칠 미뤄도 괜찮은 일") }
        else if j.deferrable <= 0.35 { reasons.append("미루면 곤란한 일") }
        reasons.append(IMPORTANCE_LABEL_KO[importanceLevel(j)])
        if t.status == .doing {
            base -= 0.15
            reasons.append("이미 진행 중")
        }
        if t.postponedCount >= 2 {
            base -= min(0.2, 0.05 * Double(t.postponedCount))
            reasons.append("이미 \(t.postponedCount)번 미룸")
        }
        if j.others >= 0.7 {
            base -= 0.1
            reasons.append("다른 사람이 기다리는 일")
        }
        let w = PostponeWork(t: t, day: day, base: clamp01(base), reasons: reasons)
        if t.fixed {
            w.verdict = .fixed
            w.reasons = ["고정 일정이라 옮기지 않아요"]
        } else if !editable(t) {
            w.verdict = .keep
            w.reasons = ["보기 전용이라 옮길 수 없어요"] + reasons
        } else if !t.dueDate.jsTruthy && !t.startDate.jsTruthy {
            w.verdict = .keep
            w.reasons = ["날짜가 없어 미룰 대상이 아니에요"] + reasons
        } else if let due = t.dueDate, !due.isEmpty, due > day {
            // Started already, due later: it isn't due on this day, so there is nothing to move.
            w.verdict = .keep
            w.reasons = ["마감이 남아 있어 옮길 필요가 없어요"] + reasons
        }
        return w
    }

    // Nearest day within the window that breaks no fixed date — preferring one that still keeps a
    // task's worth of headroom, so moved work spreads out instead of piling onto tomorrow.
    func findSlot(_ w: PostponeWork) -> (toDate: ISODate, shiftDays: Int, delayed: Int)? {
        let anchor = (w.t.dueDate ?? w.t.startDate)!
        let limits = capacity >= 3 ? [capacity - 1, capacity] : [capacity]
        for limit in limits {
            for k in 1 ... SEARCH_DAYS {
                let target = addDays(w.day, k)
                if (load[target] ?? 0) + 1 > limit { continue }
                let shift = diffDays(target, anchor)
                if shift <= 0 { continue }
                let r = simulate(items, deps, orderedShifts: [(w.t.id, shift)])
                if r.summary.conflictCount > 0 { continue }
                return (target, shift, r.summary.delayedCount)
            }
        }
        return nil
    }

    func ranked(_ list: [PostponeWork]) -> [PostponeWork] {
        JS.sorted(list, by: { a, b in
            let c = b.base - a.base
            return c != 0 && !c.isNaN ? c : Double(b.t.number - a.t.number)
        })
    }

    // Clear each overloaded day, best candidates first.
    var overloaded = false
    for day in scopeDays {
        var over = (load[day] ?? 0) - capacity
        if over <= 0 { continue }
        overloaded = true
        for w in ranked(work.filter { $0.day == day && $0.verdict == nil }) {
            if over <= 0 { break }
            if w.base < MIN_POSTPONE_SCORE { continue }
            guard let slot = findSlot(w) else { continue }
            let score = clamp01(w.base - min(0.3, Double(slot.delayed) * 0.1))
            if score < MIN_POSTPONE_SCORE { continue }
            w.toDate = slot.toDate
            w.shiftDays = slot.shiftDays
            w.delayed = slot.delayed
            w.verdict = .postpone
            w.base = score
            load[day] = (load[day] ?? 0) - 1
            load[slot.toDate] = (load[slot.toDate] ?? 0) + 1
            over -= 1
        }
    }

    // Everything else: could it wait anyway (shown unchecked), or should it stay?
    for w in work where w.verdict == nil {
        if w.base >= MIN_POSTPONE_SCORE + 0.12 {
            if let slot = findSlot(w) {
                w.toDate = slot.toDate
                w.shiftDays = slot.shiftDays
                w.delayed = slot.delayed
                w.verdict = .could
                w.base = clamp01(w.base - min(0.3, Double(slot.delayed) * 0.1))
                continue
            }
            w.reasons.insert("옮길 만한 날이 없어요", at: 0)
        }
        w.verdict = .keep
    }

    for w in work where w.verdict == .postpone || w.verdict == .could {
        w.reasons.append(w.delayed > 0 ? "뒤따르는 작업 \(w.delayed)개가 함께 밀려요" : "다른 일정엔 영향 없음")
    }

    let order: [PostponeVerdict: Int] = [.postpone: 0, .could: 1, .keep: 2, .fixed: 3]
    let candidates = JS.sorted(work, by: { a, b in
        let o = Double(order[a.verdict!]! - order[b.verdict!]!)
        if o != 0 { return o }
        let c = b.base - a.base
        return c != 0 && !c.isNaN ? c : Double(a.t.number - b.t.number)
    }).map { w in
        PostponeCandidate(
            taskId: w.t.id, verdict: w.verdict!, day: w.day, toDate: w.toDate, shiftDays: w.shiftDays,
            delayed: w.delayed, score: w.base, reasons: w.reasons
        )
    }

    return PostponePlan(
        scope: scope, today: today, capacity: capacity, capacitySource: capacitySource, overloaded: overloaded,
        days: scopeDays.map { PostponeDayLoad(date: $0, load: initial[$0] ?? 0, after: load[$0] ?? 0) },
        candidates: candidates
    )
}

// MARK: - C. triage, D. dependencies

struct TriageSuggestion: Codable, Hashable, Sendable {
    struct ProjectPick: Codable, Hashable, Sendable {
        /// nil = inbox.
        var id: String?
        var confidence: Double
    }

    struct PriorityPick: Codable, Hashable, Sendable {
        var value: Priority
        var confidence: Double
        var reasons: [String]
    }

    struct FixedPick: Codable, Hashable, Sendable {
        var value: Bool
        var probability: Double
    }

    /// Omitted when the user already picked a project.
    var project: ProjectPick?
    var priority: PriorityPick
    var fixed: FixedPick
}

/// A fixed-date commitment needs Jev to be fairly sure; a wrong pin blocks the ripple.
let FIXED_THRESHOLD = 0.75

enum DependencyDirection: String, Codable, CaseIterable, Hashable, Sendable {
    /// The other task should finish first.
    case blockedBy
    /// The other task should wait for this one.
    case blocks
}

struct DependencySuggestion: Codable, Hashable, Sendable {
    var taskId: String
    var direction: DependencyDirection
    var probability: Double
}

let DEPENDENCY_THRESHOLD = 0.65

// MARK: - API responses

/// GET /api/jev/settings
struct JevSettingsResponse: Codable, Hashable, Sendable {
    var jev: JevStatus
}

/// PUT /api/jev/settings
struct JevSettingsUpdateResponse: Codable, Hashable, Sendable {
    var jev: JevStatus
    var user: User
}

/// POST /api/jev/priorities
struct PrioritiesResult: Codable, Hashable, Sendable {
    struct Focus: Codable, Hashable, Sendable {
        var taskId: String
        var reasons: [String]
    }

    var today: ISODate
    var model: String?
    /// Changes first (biggest jump first), then the rest by score.
    var suggestions: [PrioritySuggestion]
    /// "지금 할 일 하나" among your own tasks.
    var focus: Focus?
}

/// POST /api/jev/postpone
struct JevPostponeResponse: Codable, Hashable, Sendable {
    var plan: PostponePlan
}

/// POST /api/jev/triage
struct JevTriageResponse: Codable, Hashable, Sendable {
    var suggestion: TriageSuggestion
}

/// POST /api/jev/dependencies
struct DependencyResult: Codable, Hashable, Sendable {
    var taskId: String
    var blockedBy: [DependencySuggestion]
    var blocks: [DependencySuggestion]
}
