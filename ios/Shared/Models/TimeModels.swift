import Foundation

// Port of the time-planning types in packages/core/src/timeplan.ts and odds.ts: work hours, time
// entries and timers, day plans (blocks around timed tasks), finish-date odds and promise dates.

struct TimeSpanHM: Codable, Hashable, Sendable {
    var start: ISOTime
    var end: ISOTime
}

/// When someone works and how much of it goes to tasks. Day plans and finish-date odds read this.
struct WorkHours: Codable, Hashable, Sendable {
    /// Days worked, 0 = Sunday … 6 = Saturday.
    var days: [Int]
    var start: ISOTime
    var end: ISOTime
    /// Breaks inside the day (lunch); nothing is planned in them.
    var breaks: [TimeSpanHM]
    /// Share of working time that goes to tasks; nil = learned from tracked time.
    var focus: Double?
    /// Minutes assumed for a task without an estimate; nil = learned.
    var defaultEstimate: Int?

    var json: JSONValue {
        [
            "days": .array(days.map { .number(Double($0)) }),
            "start": .string(start),
            "end": .string(end),
            "breaks": .array(breaks.map { ["start": .string($0.start), "end": .string($0.end)] }),
            "focus": focus.map { .number($0) } ?? .null,
            "defaultEstimate": defaultEstimate.map { .number(Double($0)) } ?? .null,
        ]
    }
}

enum TimeEntrySource: String, Codable, Hashable, Sendable {
    case auto, timer, manual

    var labelKo: String {
        switch self {
        case .auto: "자동"
        case .timer: "타이머"
        case .manual: "직접"
        }
    }
}

/// Time spent on a task (GET /api/tasks/:id/time adds `userName` and `mine`).
struct TimeEntry: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var workspaceId: String
    var taskId: String
    /// nil: someone who left (or hasn't joined this server yet).
    var userId: String?
    var source: TimeEntrySource
    var startedAt: String
    /// nil while it runs.
    var endedAt: String?
    /// Counted minutes; nil while it runs.
    var minutes: Int?
    var createdAt: String
    var userName: String?
    var mine: Bool?

    var isRunning: Bool { endedAt == nil }
}

/// The one clock that runs for the user, with enough of its task to show anywhere.
struct RunningTimer: Codable, Hashable, Sendable {
    struct TaskInfo: Codable, Hashable, Sendable {
        var id: String
        var number: Int
        var title: String
        var workspaceId: String
        var projectId: String?
        var status: TaskStatus
        var estimateMinutes: Int?
        var actualMinutes: Int
    }

    var entry: TimeEntry
    var task: TaskInfo

    /// Seconds since it started.
    func elapsed(now: Date = Date()) -> Int {
        guard let start = ISO8601DateFormatter.parseServer(entry.startedAt) else { return 0 }
        return max(0, Int(now.timeIntervalSince(start)))
    }
}

/// Time held for a task in the user's own day plan.
struct TimeBlock: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var userId: String
    var workspaceId: String
    var taskId: String
    var date: ISODate
    var start: ISOTime
    var end: ISOTime
    /// Placed or moved by hand: re-planning works around it.
    var locked: Bool
    var createdAt: String
    var updatedAt: String
}

/// A task with a time that day (meeting, appointment): it holds that time.
struct DayEvent: Codable, Hashable, Sendable {
    var taskId: String
    var start: ISOTime
    var end: ISOTime
    var fixed: Bool
}

enum UnplacedReason: String, Codable, Hashable, Sendable {
    case noTime = "no_time"
    case blocked

    var labelKo: String { self == .noTime ? "시간 부족" : "선행 작업 대기" }
}

struct DayPending: Codable, Hashable, Sendable {
    var taskId: String
    var minutes: Int
    var reason: UnplacedReason?
}

struct DayLate: Codable, Hashable, Sendable {
    var taskId: String
    var dueTime: ISOTime
    var end: ISOTime
}

/// GET /api/plan/day/:date: one person's day across all their spaces.
struct DayView: Codable, Hashable, Sendable {
    var date: ISODate
    var today: ISODate
    var now: Clock
    var hours: WorkHours
    var workday: Bool
    var defaultEstimate: Int
    var blocks: [TimeBlock]
    var events: [DayEvent]
    var pending: [DayPending]
    var late: [DayLate]
    var capacity: Int
    var planned: Int
    var needed: Int
    var tasks: [OverviewTask]
    var projects: [OverviewProject]
    var running: RunningTimer?
}

/// A block in a proposal; `kept` = already saved and left as it is.
struct ProposedBlock: Codable, Hashable, Sendable {
    var id: String?
    var taskId: String
    var start: ISOTime
    var end: ISOTime
    var locked: Bool
    var kept: Bool
}

struct DayPlan: Codable, Hashable, Sendable {
    var date: ISODate
    var workday: Bool
    var window: TimeSpanHM
    var events: [DayEvent]
    var blocks: [ProposedBlock]
    var unplaced: [DayPending]
    var late: [DayLate]
    var capacity: Int
    var planned: Int
    var needed: Int
}

/// POST /api/plan/day/:date/auto
struct DayProposalResponse: Codable, Hashable, Sendable {
    var plan: DayPlan
    var tasks: [OverviewTask]
    var projects: [OverviewProject]
    /// The saved day (only with `apply`).
    var view: DayView?
}

// MARK: - odds

struct DateOdds: Codable, Hashable, Sendable {
    var p50: ISODate?
    var p85: ISODate?
    var p95: ISODate?
}

struct TaskOdds: Codable, Hashable, Sendable {
    var taskId: String
    var p50: ISODate?
    var p85: ISODate?
    var p95: ISODate?
    /// Chance it is done by its due date (nil without one).
    var onTime: Double?
    /// Fixed dates: chance a blocker is still open on the day.
    var conflict: Double?
}

struct ProjectOdds: Codable, Hashable, Sendable {
    /// nil = tasks without a project.
    var projectId: String?
    var tasks: Int
    var p50: ISODate?
    var p85: ISODate?
    var p95: ISODate?
}

struct OddsReport: Codable, Hashable, Sendable {
    var today: ISODate
    var runs: Int
    var horizon: ISODate
    var tasks: [TaskOdds]
    var projects: [ProjectOdds]
    var overall: DateOdds?
}

/// What the person's history says (core CalibrationSummary).
struct CalibrationSummary: Codable, Hashable, Sendable {
    var focus: Double
    /// setting | history | default
    var focusSource: String
    var defaultEstimate: Int
    /// setting | history | pace | default
    var defaultEstimateSource: String
    var medianRatio: Double?
    var onTimeRate: Double?
    var meanLateDays: Double?
    var trackedDays: Int
    var ratioSamples: Int
    var slipSamples: Int
}

/// GET /api/odds
struct OddsResponse: Codable, Hashable, Sendable {
    var today: ISODate
    var report: OddsReport
    var calibration: CalibrationSummary
    /// Tasks of the user's other spaces counted as load.
    var external: Int

    func odds(_ taskId: String) -> TaskOdds? { report.tasks.first { $0.taskId == taskId } }
}

struct CommitHarm: Codable, Hashable, Sendable {
    var taskId: String
    /// late | conflict
    var kind: String
    var before: Double
    var after: Double
}

struct CommitOption: Codable, Hashable, Sendable {
    var date: ISODate
    var probability: Double
    var harmed: [CommitHarm]
}

struct CommitDay: Codable, Hashable, Sendable {
    var date: ISODate
    var probability: Double
    var harmed: Int
}

struct CommitReport: Codable, Hashable, Sendable {
    var confidence: Double
    var natural: DateOdds
    var earliest: CommitOption?
    var safe: CommitOption?
    var proposed: CommitOption?
    var days: [CommitDay]
}

/// POST /api/odds/commit
struct CommitResponse: Codable, Hashable, Sendable {
    var today: ISODate
    var report: CommitReport
    /// Minutes assumed for the work (its estimate, else the default).
    var minutes: Int
    var estimated: Bool
}

extension ISO8601DateFormatter {
    /// Server timestamps with or without fractional seconds (Foundation only, for Shared code).
    static func parseServer(_ s: String) -> Date? {
        let a = ISO8601DateFormatter()
        a.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = a.date(from: s) { return d }
        let b = ISO8601DateFormatter()
        b.formatOptions = [.withInternetDateTime]
        return b.date(from: s)
    }
}
