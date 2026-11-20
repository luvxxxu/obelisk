import AppIntents
import SwiftUI
import WidgetKit

// Obelisk's look in a widget: pure base, neutral ink, colour only for meaning, hairlines.

/// What both widgets compute from the snapshot.
struct WidgetModel {
    var today: ISODate
    var overdue: [TaskItem]
    var todays: [TaskItem]
    var doneToday: Int
    var report: ImpactReport
    var workspace: String
    var projects: [String: Project]

    init(_ s: Snapshot) {
        today = s.currentToday
        overdue = s.overdueTasks
        todays = s.todayTasks
        doneToday = s.doneTodayCount
        report = s.forecastReport
        workspace = s.workspace.name
        projects = Dictionary(s.projects.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    var remaining: Int { overdue.count + todays.count }
    var planned: Int { remaining + doneToday }
    /// Overdue first (oldest first), then today.
    var list: [TaskItem] { overdue + todays }

    func dateText(_ t: TaskItem, now: Clock) -> (String, Tone) {
        if isOverdue(t, today, now), let due = t.dueDate {
            return (overdueLabel(due, today, t.dueTime, now), .danger)
        }
        if let soon = dueSoonLabel(t, now) { return (soon, .warn) }
        return (timeLabel(t) ?? "오늘", .neutral)
    }
}

// MARK: - 오늘

struct TodayWidgetView: View {
    var entry: ObeliskEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let s = entry.snapshot {
            let m = WidgetModel(s)
            switch family {
            case .accessoryCircular: circular(m)
            case .accessoryRectangular: rectangular(m)
            case .accessoryInline: Text(m.remaining == 0 ? "오늘 할 일 없음" : "오늘 \(m.remaining)개 남음")
            case .systemSmall: small(m)
            default: list(m, limit: family == .systemLarge ? 8 : 4)
            }
        } else {
            WidgetSignedOut()
        }
    }

    private func header(_ m: WidgetModel) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("오늘")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Ob.text)
            if m.planned > 0 {
                Text("\(m.doneToday)/\(m.planned) 완료")
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(Ob.text3)
            }
            Spacer(minLength: 0)
            Image("Logo")
                .resizable()
                .renderingMode(.template)
                .frame(width: 14, height: 14)
                .foregroundStyle(Ob.text3)
        }
    }

    private func small(_ m: WidgetModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            header(m)
            Spacer(minLength: 0)
            Text("\(m.remaining)")
                .font(.system(size: 34, weight: .semibold).monospacedDigit())
                .foregroundStyle(Ob.text)
            Text(m.remaining == 0 ? (m.doneToday > 0 ? "모두 끝냈어요" : "오늘은 비어 있어요") : "남은 작업")
                .font(.system(size: 12))
                .foregroundStyle(Ob.text3)
            if !m.overdue.isEmpty {
                Text("기한 지남 \(m.overdue.count)개")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Ob.dangerText)
            }
        }
        .widgetURL(URL(string: "obelisk://page/today"))
    }

    private func list(_ m: WidgetModel, limit: Int) -> some View {
        let now = clockNow(entry.snapshot?.timezone)
        let rows = Array(m.list.prefix(limit))
        return VStack(alignment: .leading, spacing: 0) {
            header(m)
                .padding(.bottom, 6)
            if rows.isEmpty {
                Spacer(minLength: 0)
                Text(m.doneToday > 0 ? "오늘 할 일을 모두 끝냈어요" : "오늘은 비어 있어요")
                    .font(.system(size: 13))
                    .foregroundStyle(Ob.text3)
                    .frame(maxWidth: .infinity, alignment: .center)
                Spacer(minLength: 0)
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, t in
                    if i > 0 { Rectangle().fill(Ob.border).frame(height: 1).padding(.leading, 26) }
                    WidgetTaskRow(task: t, date: m.dateText(t, now: now), project: t.projectId.flatMap { m.projects[$0] })
                }
                Spacer(minLength: 0)
                if m.list.count > rows.count {
                    Text("외 \(m.list.count - rows.count)개")
                        .font(.system(size: 11))
                        .foregroundStyle(Ob.text3)
                }
            }
            if family == .systemLarge, m.report.summary.delayedCount + m.report.summary.conflictCount > 0 {
                RiskLine(report: m.report)
                    .padding(.top, 6)
            }
        }
        .widgetURL(URL(string: "obelisk://page/today"))
    }

    private func rectangular(_ m: WidgetModel) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(m.remaining == 0 ? "오늘 할 일 없음" : "오늘 \(m.remaining)개\(m.overdue.isEmpty ? "" : " · 지남 \(m.overdue.count)")")
                .font(.system(size: 13, weight: .semibold))
            if let next = m.list.first {
                Text(next.title).font(.system(size: 13)).lineLimit(1)
            }
            if m.list.count > 1 {
                Text(m.list[1].title).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(URL(string: "obelisk://page/today"))
    }

    private func circular(_ m: WidgetModel) -> some View {
        Gauge(value: Double(m.doneToday), in: 0 ... Double(max(m.planned, 1))) {
            Text("오늘")
        } currentValueLabel: {
            Text("\(m.remaining)")
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .widgetURL(URL(string: "obelisk://page/today"))
    }
}

/// One task: a checkbox that completes it in place (CompleteTaskIntent), title, date and project.
struct WidgetTaskRow: View {
    var task: TaskItem
    var date: (String, Tone)
    var project: Project?

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Button(intent: CompleteTaskIntent(taskId: task.id, title: task.title)) {
                ZStack {
                    Circle().strokeBorder(ring, lineWidth: 1.5)
                    if task.status == .done {
                        Circle().fill(Ob.primary)
                        Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Ob.onPrimary)
                    } else if task.status == .doing {
                        Circle().trim(from: 0, to: 0.5).rotation(.degrees(90)).fill(ring).padding(3)
                    }
                }
                .frame(width: 18, height: 18)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("완료")

            Link(destination: URL(string: "obelisk://task/\(task.id)")!) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(task.title)
                        .font(.system(size: 13))
                        .foregroundStyle(task.status == .done ? Ob.text3 : Ob.text)
                        .strikethrough(task.status == .done, color: Ob.text4)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Text(date.0)
                            .foregroundStyle(date.1 == .neutral ? Ob.text3 : date.1.text)
                        if let project {
                            HStack(spacing: 3) {
                                Circle().fill(project.color.palette.ink).frame(width: 5, height: 5)
                                Text(project.name).lineLimit(1)
                            }
                            .foregroundStyle(Ob.text3)
                        }
                    }
                    .font(.system(size: 11))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 4)
    }

    private var ring: Color {
        switch task.priority {
        case 3: Ob.danger
        case 2: Ob.warn
        case 1: Ob.info
        default: task.status == .doing ? Ob.info : Ob.text4
        }
    }
}

// MARK: - 지연 위험

struct RiskWidgetView: View {
    var entry: ObeliskEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let s = entry.snapshot {
            let m = WidgetModel(s)
            let sum = m.report.summary
            let tone: Tone = sum.conflictCount > 0 ? .danger : (sum.delayedCount > 0 ? .warn : .ok)
            switch family {
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Text("지연 위험").font(.system(size: 13, weight: .semibold))
                    Text("밀림 \(sum.delayedCount) · 충돌 \(sum.conflictCount)").font(.system(size: 13))
                    if let from = sum.finishFrom, let to = sum.finishTo, from != to {
                        Text("완료 \(formatShortKo(from)) → \(formatShortKo(to))").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .widgetURL(URL(string: "obelisk://page/forecast"))
            default:
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: tone == .ok ? "checkmark.circle" : "exclamationmark.triangle")
                            .font(.system(size: 13))
                            .foregroundStyle(tone.ink)
                        Text("지연 위험")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Ob.text)
                        Spacer(minLength: 0)
                    }
                    if tone == .ok {
                        Spacer(minLength: 0)
                        Text("밀리는 일정이 없어요")
                            .font(.system(size: 13))
                            .foregroundStyle(Ob.text2)
                        Spacer(minLength: 0)
                    } else {
                        HStack(spacing: 14) {
                            figure("밀림", sum.delayedCount, .warn)
                            figure("충돌", sum.conflictCount, .danger)
                            if family == .systemMedium { figure("기한 지남", m.overdue.count, .danger) }
                        }
                        Spacer(minLength: 0)
                        if let from = sum.finishFrom, let to = sum.finishTo, from != to {
                            Text("전체 완료 \(formatShortKo(from)) → \(formatShortKo(to))")
                                .font(.system(size: 12))
                                .foregroundStyle(Ob.text2)
                                .lineLimit(1)
                        } else if sum.maxShiftDays > 0 {
                            Text("최대 \(daysLabel(sum.maxShiftDays)) 밀려요")
                                .font(.system(size: 12))
                                .foregroundStyle(Ob.text2)
                        }
                    }
                }
                .widgetURL(URL(string: "obelisk://page/forecast"))
            }
        } else {
            WidgetSignedOut()
        }
    }

    private func figure(_ label: String, _ n: Int, _ tone: Tone) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(n)")
                .font(.system(size: 26, weight: .semibold).monospacedDigit())
                .foregroundStyle(n > 0 ? tone.text : Ob.text3)
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Ob.text3)
        }
    }
}

/// One line under the large 오늘 widget: what the overdue work is pushing.
struct RiskLine: View {
    var report: ImpactReport
    var body: some View {
        let s = report.summary
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 10))
            Text(s.conflictCount > 0 ? "밀림 \(s.delayedCount) · 고정 일정 충돌 \(s.conflictCount)" : "작업 \(s.delayedCount)개가 최대 \(daysLabel(s.maxShiftDays)) 밀려요")
                .lineLimit(1)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(s.conflictCount > 0 ? Ob.dangerText : Ob.warnText)
    }
}

struct WidgetSignedOut: View {
    var body: some View {
        VStack(spacing: 6) {
            Image("Logo")
                .resizable()
                .renderingMode(.template)
                .frame(width: 20, height: 20)
                .foregroundStyle(Ob.text3)
            Text("Obelisk 앱에서 로그인하세요")
                .font(.system(size: 12))
                .foregroundStyle(Ob.text3)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - sample data for the widget gallery

enum WidgetSample {
    static var snapshot: Snapshot {
        let tz = TimeZone.current.identifier
        let today = todayIn(tz)
        func task(_ n: Int, _ title: String, due: ISODate?, time: ISOTime? = nil, priority: Int = 0) -> TaskItem {
            TaskItem(
                id: "sample-\(n)", workspaceId: "sample", number: n, title: title, notes: "", status: .todo,
                priority: priority, projectId: nil, startDate: nil, startTime: nil, dueDate: due, dueTime: time,
                fixed: false, position: Double(n), postponedCount: 0, assigneeId: nil, createdBy: nil,
                completedAt: nil, createdAt: "", updatedAt: ""
            )
        }
        return Snapshot(
            savedAt: Date(), today: today, timezone: tz, userId: "sample", userName: "",
            workspace: WorkspaceSummary(id: "sample", kind: .personal, name: "개인 공간", role: .owner, memberCount: 1),
            projects: [],
            tasks: [
                task(1, "견적서 보내기", due: addDays(today, -1), priority: 3),
                task(2, "디자인 시안 리뷰", due: today, time: "15:00"),
                task(3, "주간 회고 정리", due: today),
            ],
            dependencies: []
        )
    }
}
