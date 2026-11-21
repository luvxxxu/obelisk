import SwiftUI

// The home widgets that read HomeData (web page.tsx): 지금 상황 · summary tiles · 지연 파급 ·
// 주의할 작업 · 다가오는 일정 · 진행 상황. The board (급한 업무) and 다른 공간 live in their own files.

/// Rows in the 다가오는 일정 list.
private let HOME_LIST_CAP = 8
/// Overdue roots and impacts per root shown in 지연 파급.
private let HOME_ROOT_CAP = 3
private let HOME_IMPACT_CAP = 4

private extension HomeLevel {
    var tone: Tone {
        switch self {
        case .danger: .danger
        case .warn: .warn
        case .ok: .ok
        }
    }
}

// MARK: - 지금 상황

/// The forecast in one sentence: what is slipping and why, with the fix one tap away.
struct HomeStatusCallout: View {
    var data: HomeData
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var busy = false

    var body: some View {
        let tone = data.level.tone
        let (headline, details) = copy

        VStack(alignment: .leading, spacing: ObSpace.md) {
            HStack(alignment: .top, spacing: ObSpace.md) {
                Image(systemName: symbol)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(tone.ink)
                    .frame(width: 22)
                    .padding(.top, 1)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: ObSpace.xs) {
                    Text(headline)
                        .font(ObFont.title3)
                        .foregroundStyle(Ob.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if !details.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(details, id: \.self) { d in
                                Text(d)
                                    .font(ObFont.sub)
                                    .foregroundStyle(Ob.text2)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)

            FlowRow(spacing: ObSpace.xs, lineSpacing: ObSpace.xs) {
                if canApply {
                    Button {
                        Task { await applyAll() }
                    } label: {
                        HStack(spacing: 6) {
                            if busy {
                                ProgressView().controlSize(.small).tint(Ob.onPrimary)
                            } else {
                                Image(systemName: "bolt").font(.system(size: 13, weight: .semibold))
                            }
                            Text("오늘 기준으로 재조정")
                        }
                    }
                    .buttonStyle(.ob(.primary, size: .small))
                    .disabled(busy)
                }
                Button {
                    router.open(data.level == .ok ? .today : .forecast)
                } label: {
                    HStack(spacing: 4) {
                        Text(data.level == .ok ? "오늘 보기" : "파급 예측")
                        Image(systemName: "arrow.right").font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(Ob.text2)
                }
                .buttonStyle(.ob(.ghost, size: .small))
            }
            // Line the first button up with the headline (a ghost button's label sits 12pt inside it).
            .padding(.leading, canApply ? 34 : 34 - 12)
        }
        .padding(ObSpace.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.soft, in: RoundedRectangle(cornerRadius: ObRadius.lg))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("지금 상황")
    }

    private var symbol: String {
        switch data.level {
        case .ok: "checkmark.circle"
        case .danger: "exclamationmark.circle"
        case .warn: "exclamationmark.triangle"
        }
    }

    private var canApply: Bool { data.level != .ok && data.delayed > 0 }

    private var copy: (String, [String]) {
        let rel = { (d: ISODate) in formatRelativeKo(d, data.today) }
        let finishFrom = data.fc.summary.finishFrom
        let finishTo = data.fc.summary.finishTo
        var headline: String
        var details: [String] = []
        switch data.level {
        case .danger:
            headline = "고정 일정 \(data.conflicts)개가 지켜지지 않을 수 있어요"
            details.append("기한 지난 작업 \(data.roots.count)개가 일정 \(data.delayed + data.conflicts)개를 밀고 있어요")
        case .warn where data.delayed > 0:
            headline = "일정 \(data.delayed)개가 최대 \(data.maxDownstreamShift)일 밀리고 있어요"
            details.append("기한 지난 작업 \(data.roots.count)개 때문이에요")
        case .warn:
            headline = "기한 지난 작업이 \(data.overdue.count)개 있어요"
            details.append("다행히 다른 일정엔 영향이 없어요")
        case .ok:
            headline = data.remaining == 0 && !data.doneToday.isEmpty ? "오늘 할 일을 모두 끝냈어요" : "모든 일정이 순조로워요"
            if let finishTo { details.append("지금 계획대로면 \(rel(finishTo))에 모두 끝나요") }
            if let f = data.fixed.first { details.append("다음 고정 일정은 \(rel(f.date)) ‘\(f.task.title)’") }
        }
        if data.finishShift > 0, let finishFrom, let finishTo {
            details.append("전체 완료 \(rel(finishFrom)) → \(rel(finishTo))")
        }
        return (headline, details)
    }

    private func applyAll() async {
        busy = true
        let changes = changesFromReport(data.fc, true)
        if await store.reschedule(changes) {
            Haptics.success()
            store.history.notify("\(changes.count)개 작업을 오늘 기준으로 다시 맞췄어요", store.history.latest)
        }
        busy = false
    }
}

// MARK: - summary tiles

struct HomeSummaryTile: View {
    var data: HomeData
    var kind: String

    var body: some View {
        let s = data.fc.summary
        switch kind {
        case "tile-today":
            let total = data.remaining + data.doneToday.count
            HomeTile(page: .today, symbol: "sun.max", label: "오늘 남은 작업", value: data.remaining, unit: "개") {
                HomeTileMeta(text: "완료 \(data.doneToday.count)개" + (data.doing > 0 ? " · 진행 중 \(data.doing)개" : ""))
                HomeBar(fraction: total > 0 ? Double(data.doneToday.count) / Double(total) : 0)
                    .padding(.top, 6)
                    .accessibilityHidden(true)
            }
        case "tile-overdue":
            HomeTile(page: .today, symbol: "exclamationmark.circle", label: "기한 지남", value: data.overdue.count, unit: "개",
                     tone: data.overdue.isEmpty ? .neutral : .danger) {
                HomeTileMeta(text: data.overdue.isEmpty ? "밀린 작업이 없어요" : "가장 오래된 작업 \(data.oldestOverdue)일 지남")
            }
        case "tile-delayed":
            HomeTile(page: .forecast, symbol: "waveform.path.ecg", label: "밀리는 작업", value: data.delayed, unit: "개",
                     tone: data.delayed > 0 ? .warn : .neutral) {
                HomeTileMeta(text: data.delayed > 0 ? "최대 \(data.maxDownstreamShift)일 늦어져요" : "영향받는 일정 없음")
            }
        case "tile-conflicts":
            let next = data.fixed.first { $0.conflict != nil } ?? data.fixed.first
            HomeTile(page: .forecast, symbol: "pin", label: "고정 일정 충돌", value: data.conflicts, unit: "개",
                     tone: data.conflicts > 0 ? .danger : .neutral) {
                HomeTileMeta(text: next.map { "\($0.conflict != nil ? "위험 " : "다음 ")\(formatRelativeKo($0.date, data.today)) · \($0.task.title)" }
                    ?? "30일 안에 고정 일정 없음")
            }
        default: // tile-finish
            let shift = data.finishShift
            HomeTile(page: .forecast, symbol: "flag", label: "전체 완료 예상", text: s.finishTo.map(formatShortKo) ?? "—",
                     tone: shift > 0 ? .warn : .neutral) {
                HomeTileMeta(text: shift > 0
                    ? "원래보다 \(shift)일 늦어져요"
                    : s.finishTo.map { "\(max(0, diffDays($0, data.today)))일 남음 · 계획대로" } ?? "날짜 있는 작업이 없어요")
            }
        }
    }
}

private struct HomeTileMeta: View {
    var text: String
    var body: some View {
        Text(text)
            .font(ObFont.caption)
            .foregroundStyle(Ob.text3)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One figure with its label and one muted line; opens the page behind the number.
struct HomeTile<Extra: View>: View {
    var page: Page
    var symbol: String
    var label: String
    var value: Int?
    var text: String?
    var unit: String?
    var tone: Tone = .neutral
    @ViewBuilder var extra: () -> Extra

    @Environment(Router.self) private var router

    init(page: Page, symbol: String, label: String, value: Int? = nil, text: String? = nil, unit: String? = nil,
         tone: Tone = .neutral, @ViewBuilder extra: @escaping () -> Extra) {
        self.page = page
        self.symbol = symbol
        self.label = label
        self.value = value
        self.text = text
        self.unit = unit
        self.tone = tone
        self.extra = extra
    }

    var body: some View {
        Button {
            router.open(page)
        } label: {
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                HStack(spacing: 6) {
                    Image(systemName: symbol)
                        .font(.system(size: 13))
                        .foregroundStyle(Ob.text3)
                    Text(label)
                        .lineLimit(1)
                }
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text2)

                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text(text ?? "\(value ?? 0)")
                        .font(.title.weight(.semibold).monospacedDigit())
                        .foregroundStyle(tone == .neutral ? Ob.text : tone.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    if text == nil, let unit {
                        Text(unit)
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text3)
                    }
                }
                .padding(.top, 2)

                extra()
                Spacer(minLength: 0)
            }
            .padding(ObSpace.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .contentShape(RoundedRectangle(cornerRadius: ObRadius.lg))
        }
        .buttonStyle(HomeCardButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("\(page.label) 열기")
    }
}

/// A resting card that takes a faint fill while pressed (the web's hover).
struct HomeCardButtonStyle: ButtonStyle {
    var radius: CGFloat = ObRadius.lg
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Ob.tint : Ob.bg, in: RoundedRectangle(cornerRadius: radius))
            .overlay(
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(configuration.isPressed ? Ob.borderStrong : Ob.border, lineWidth: 1)
            )
            .animation(ObMotion.fast, value: configuration.isPressed)
    }
}

// MARK: - 지연 파급

struct HomeRippleBoard: View {
    var data: HomeData
    @Environment(Router.self) private var router

    var body: some View {
        if data.roots.isEmpty {
            let finish = data.fc.summary.finishTo ?? data.fc.summary.finishFrom
            HStack(alignment: .top, spacing: ObSpace.md) {
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Ob.ok)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("밀리는 일정이 없어요")
                        .font(ObFont.bodyStrong)
                        .foregroundStyle(Ob.text)
                    Text(finish.map { "지금 계획대로면 \(formatRelativeKo($0, data.today))에 모두 끝나요." }
                        ?? "날짜와 선행 작업을 넣으면 지연을 미리 계산해 드려요.")
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .obCard(padding: ObSpace.xl)
            .accessibilityElement(children: .combine)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(data.roots.prefix(HOME_ROOT_CAP)) { r in
                    HomeRippleCard(root: r, today: data.today)
                }
                if data.roots.count > HOME_ROOT_CAP {
                    HomeMoreLink(label: "기한 지난 작업 \(data.roots.count - HOME_ROOT_CAP)개 더 · 파급 예측에서 보기") {
                        router.open(.forecast)
                    }
                }
            }
        }
    }
}

/// One overdue task and the chain of work it pushes (and the fixed dates it breaks).
struct HomeRippleCard: View {
    var root: HomeRootRisk
    var today: ISODate
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let impacts = JS.sorted(root.report.impacts.filter { $0.kind == .shifted || $0.kind == .conflict }) { a, b in
            if a.depth != b.depth { return a.depth - b.depth }
            let ca = a.kind == .conflict ? 1 : 0
            let cb = b.kind == .conflict ? 1 : 0
            if ca != cb { return cb - ca }
            return b.shiftDays - a.shiftDays
        }
        let shown = Array(impacts.prefix(HOME_IMPACT_CAP))
        let summary = root.report.summary
        let task = root.task

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Button {
                    Task { await store.toggleDone(task.id) }
                } label: {
                    Circle()
                        .strokeBorder(Ob.danger, lineWidth: 1.5)
                        .frame(width: 20, height: 20)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.leading, -12)
                .padding(.vertical, -8)
                .accessibilityLabel("\(task.title) 완료로 표시")
                .accessibilityHint("완료하면 파급이 사라져요")

                Button {
                    router.openTask(task.id)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("#\(task.number)")
                            .font(ObFont.caption.weight(.medium).monospacedDigit())
                            .foregroundStyle(Ob.text3)
                        Text(task.title)
                            .font(ObFont.bodyStrong)
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .contextMenu { HomeTaskMenu(task: task) }

                HomeTag(root.days == 1 ? "어제 마감" : "\(root.days)일 지남", hue: .red)
            }

            if shown.isEmpty {
                Text("뒤따르는 일정엔 영향이 없어요. 오늘 끝내면 그만이에요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .padding(.leading, 26)
                    .padding(.top, 6)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.element.taskId) { i, im in
                        HomeRippleLink(impact: im, today: today, first: i == 0, last: i == shown.count - 1)
                    }
                }
                .padding(.top, ObSpace.sm)
            }

            if impacts.count > shown.count || summary.delayedCount + summary.conflictCount > 0 {
                Text(footText(summary, more: impacts.count - shown.count))
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
                    .padding(.leading, 26)
                    .padding(.top, ObSpace.sm)
            }
        }
        .padding(ObSpace.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: ObRadius.lg).strokeBorder(Ob.border, lineWidth: 1))
    }

    private func footText(_ s: ImpactSummary, more: Int) -> String {
        var parts: [String] = []
        if s.delayedCount > 0 { parts.append("작업 \(s.delayedCount)개 밀림") }
        if s.conflictCount > 0 { parts.append("고정 일정 \(s.conflictCount)개 충돌") }
        var out = parts.joined(separator: " · ")
        if more > 0 { out += (out.isEmpty ? "" : " · ") + "외 \(more)개" }
        return out
    }
}

/// One link of a ripple chain: a quiet tree line from the root, the task, and how far it moves.
private struct HomeRippleLink: View {
    var impact: TaskImpact
    var today: ISODate
    var first: Bool
    var last: Bool
    @Environment(Router.self) private var router

    var body: some View {
        let conflict = impact.kind == .conflict
        let date = impact.to.dueDate ?? impact.to.startDate
        let indent = CGFloat(min(max(impact.depth - 1, 0), 2)) * 18

        HStack(spacing: 0) {
            HomeTreeLine(first: first, last: last)
                .stroke(Ob.borderStrong, lineWidth: 1)
                .frame(width: 26)
            Button {
                router.openTask(impact.taskId)
            } label: {
                HStack(spacing: ObSpace.sm) {
                    Image(systemName: conflict ? "pin" : "arrow.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(conflict ? Ob.danger : Ob.text3)
                        .frame(width: 14)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            if let n = impact.number {
                                Text("#\(n)")
                                    .font(ObFont.caption.weight(.medium).monospacedDigit())
                                    .foregroundStyle(Ob.text3)
                            }
                            Text(impact.title)
                                .font(ObFont.sub)
                                .foregroundStyle(Ob.text)
                                .lineLimit(1)
                        }
                        if !conflict, let date {
                            Text("→ \(formatRelativeKo(date, today))")
                                .font(ObFont.caption)
                                .foregroundStyle(Ob.text3)
                        }
                    }
                    Spacer(minLength: ObSpace.xs)
                    if conflict {
                        HomeTag("고정 일정 충돌 · \(impact.overrunDays)일 초과", hue: .red)
                    } else {
                        HomeTag("+\(impact.shiftDays)일", hue: .orange)
                    }
                }
                .padding(.horizontal, ObSpace.sm)
                .padding(.vertical, 6)
                .frame(minHeight: ObSize.row)
                .contentShape(Rectangle())
            }
            .buttonStyle(.obRow)
            .padding(.leading, indent)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The tree line beside a ripple link: down from the root, across to the link.
private struct HomeTreeLine: Shape {
    var first: Bool
    var last: Bool

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let x: CGFloat = 9
        let top = first ? rect.minY - 10 : rect.minY
        p.move(to: CGPoint(x: x, y: top))
        p.addLine(to: CGPoint(x: x, y: last ? rect.midY : rect.maxY))
        p.move(to: CGPoint(x: x, y: rect.midY))
        p.addLine(to: CGPoint(x: x + 13, y: rect.midY))
        return p
    }
}

// MARK: - 주의할 작업

struct HomeWatchList: View {
    var data: HomeData
    @Environment(Router.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            head("scope", "핵심 작업", count: data.keyTotal)
            if data.keyItems.isEmpty {
                Text(data.keyLinked > 0 ? "하루 늦어도 다른 일정에 영향이 없어요." : "선행 작업을 연결하면 일정 전체를 흔드는 작업을 찾아 드려요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .padding(.horizontal, ObSpace.sm)
                    .padding(.bottom, ObSpace.sm)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(data.keyItems) { k in
                    let lev = k.lev
                    row(k.task,
                        meta: "하루 늦으면 \(lev.delayedIfLate)개 밀림" + (lev.conflictsIfLate > 0 ? " · 충돌 \(lev.conflictsIfLate)" : ""),
                        chip: lev.slackDays.map { $0 == 0 ? "여유 없음" : "여유 \($0)일" } ?? "여유 —",
                        tight: lev.slackDays == 0)
                }
            }

            if !data.chronic.isEmpty {
                Hairline()
                    .padding(.horizontal, ObSpace.sm)
                    .padding(.top, ObSpace.sm)
                    .padding(.bottom, ObSpace.xs)
                head("calendar.badge.clock", "자주 미룬 작업", count: nil)
                ForEach(data.chronic) { t in
                    row(t, meta: nil, chip: "\(t.postponedCount)회 미룸", tight: true)
                }
            }
        }
        .padding(.horizontal, ObSpace.sm)
        .padding(.top, ObSpace.md)
        .padding(.bottom, ObSpace.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: ObRadius.lg).strokeBorder(Ob.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("주의할 작업")
    }

    private func head(_ symbol: String, _ title: String, count: Int?) -> some View {
        HStack(spacing: ObSpace.sm) {
            Image(systemName: symbol)
                .font(.system(size: 14))
                .foregroundStyle(Ob.text3)
            Text(title)
                .font(ObFont.footnote.weight(.semibold))
                .foregroundStyle(Ob.text)
            Spacer(minLength: 0)
            if let count {
                Text("\(count)")
                    .font(ObFont.caption.weight(.medium).monospacedDigit())
                    .foregroundStyle(Ob.text3)
            }
        }
        .padding(.horizontal, ObSpace.sm)
        .padding(.bottom, 6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private func row(_ t: TaskItem, meta: String?, chip: String, tight: Bool) -> some View {
        Button {
            router.openTask(t.id)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("#\(t.number)")
                            .font(ObFont.caption.weight(.medium).monospacedDigit())
                            .foregroundStyle(Ob.text3)
                        Text(t.title)
                            .font(ObFont.body.weight(.medium))
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                    }
                    if let meta {
                        Text(meta)
                            .font(ObFont.caption)
                            .foregroundStyle(Ob.text3)
                    }
                }
                Spacer(minLength: 0)
                HomeTag(chip, hue: tight ? .orange : .slate)
            }
            .padding(ObSpace.sm)
            .frame(minHeight: ObSize.row)
            .contentShape(Rectangle())
        }
        .buttonStyle(.obRow)
        .contextMenu { HomeTaskMenu(task: t) }
    }
}

// MARK: - 다가오는 일정

struct HomeUpcomingList: View {
    var data: HomeData
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let upcoming = data.upcoming
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            HomeListHeader(symbol: "calendar", title: "이번 주", page: .upcoming, pageLabel: "예정 보기",
                           newLabel: "새 일정", onNew: { homeNewTask(router) })
            if upcoming.isEmpty {
                HomeNewBox(label: "새 일정") { homeNewTask(router) }
            } else {
                VStack(spacing: 0) {
                    ForEach(upcoming.prefix(HOME_LIST_CAP)) { e in
                        row(e)
                    }
                    if upcoming.count > HOME_LIST_CAP {
                        Button {
                            router.open(.upcoming)
                        } label: {
                            HStack {
                                Text("외 \(upcoming.count - HOME_LIST_CAP)개 · 예정에서 모두 보기")
                                    .font(ObFont.body)
                                    .foregroundStyle(Ob.text3)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, ObSpace.sm)
                            .frame(minHeight: ObSize.row)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.obRow)
                    }
                }
                .padding(.horizontal, -ObSpace.sm)
            }
        }
    }

    private func row(_ e: HomeUpcomingEntry) -> some View {
        let project = store.project(e.task.projectId)
        return Button {
            router.openTask(e.task.id)
        } label: {
            HStack(spacing: ObSpace.sm) {
                Text(e.task.title)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
                Spacer(minLength: ObSpace.sm)
                if let project {
                    HomeTag(project.name, hue: project.color)
                        .frame(maxWidth: 104, alignment: .trailing)
                        .layoutPriority(1)
                }
                HStack(spacing: 4) {
                    if e.task.fixed {
                        Image(systemName: "pin")
                            .font(.system(size: 11))
                            .accessibilityLabel("고정 일정")
                    }
                    Text(formatRelativeKo(e.date, data.today))
                }
                .font(ObFont.caption)
                .foregroundStyle(Ob.text3)
                .lineLimit(1)
                .fixedSize()
            }
            .padding(.horizontal, ObSpace.sm)
            .frame(minHeight: ObSize.row)
            .contentShape(Rectangle())
        }
        .buttonStyle(.obRow)
        .contextMenu { HomeTaskMenu(task: e.task) }
    }
}

/// The long-press menu of a task shown on home (the shared task menu, with the postpone sheet).
struct HomeTaskMenu: View {
    var task: TaskItem
    @Environment(Router.self) private var router

    var body: some View {
        TaskContextMenu(task: task) {
            router.present(.init(id: "postpone-\(task.id)", detents: [.medium]) { PostponeMenuSheet(taskId: task.id) })
        }
    }
}

// MARK: - 진행 상황

enum HomeProjectColumn: String, Hashable {
    case started, notStarted, finished
}

struct HomeProjectsBoard: View {
    var data: HomeData
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var adding: HomeProjectColumn?
    @State private var name = ""
    @State private var column: HomeProjectColumn? = .started
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            HomeListHeader(symbol: "folder", title: "프로젝트", page: .all, pageLabel: "전체 작업 보기",
                           newLabel: "새 프로젝트", onNew: { startAdding(.notStarted) })
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 10) {
                    HomeColumn(title: "진행 중", count: data.started.count) {
                        cards(data.started)
                    } footer: {
                        footer(.started)
                    }
                    .homeBoardColumnWidth()
                    .id(HomeProjectColumn.started)
                    HomeColumn(title: "시작 전", count: data.notStarted.count) {
                        cards(data.notStarted)
                    } footer: {
                        footer(.notStarted)
                    }
                    .homeBoardColumnWidth()
                    .id(HomeProjectColumn.notStarted)
                    HomeColumn(title: "완료", count: data.finished.count) {
                        cards(data.finished)
                    }
                    .homeBoardColumnWidth()
                    .id(HomeProjectColumn.finished)
                }
                .scrollTargetLayout()
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $column, anchor: .leading)
            .contentMargins(.horizontal, ObSpace.page, for: .scrollContent)
            .padding(.horizontal, -ObSpace.page)
            .accessibilityLabel("프로젝트 보드")
        }
    }

    @ViewBuilder
    private func cards(_ rows: [HomeProjectRow]) -> some View {
        if !rows.isEmpty {
            VStack(spacing: ObSpace.sm) {
                ForEach(rows) { card($0) }
            }
        }
    }

    private func card(_ r: HomeProjectRow) -> some View {
        let pct = r.total > 0 ? Int((Double(r.done) / Double(r.total) * 100).rounded()) : 0
        let left = r.total - r.done
        return Button {
            router.open(.project(r.project.id))
        } label: {
            VStack(alignment: .leading, spacing: ObSpace.sm) {
                HStack(alignment: .top, spacing: ObSpace.sm) {
                    Image(systemName: "folder")
                        .font(.system(size: 14))
                        .foregroundStyle(r.project.color.palette.ink)
                        .padding(.top, 2)
                    Text(r.project.name)
                        .font(ObFont.body.weight(.medium))
                        .foregroundStyle(Ob.text)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                }
                if r.slip != nil || (r.finish != nil && left > 0) {
                    FlowRow(spacing: 4, lineSpacing: 4) {
                        if let slip = r.slip {
                            HomeTag("지연 +\(slip.shiftDays)일", hue: .orange)
                        } else {
                            HomeTag("순조", hue: .green)
                        }
                        if left > 0 { HomeTag("남은 작업 \(left)", hue: .slate) }
                    }
                }
                if let finish = r.finish, left > 0 {
                    HomeCardMeta(symbol: "flag", text: "\(formatRelativeKo(r.slip?.to ?? finish, data.today)) 완료 예상")
                }
                if r.total > 0 {
                    HomeProgress(pct: pct, label: "\(r.project.name) 완료 비율")
                } else {
                    HomeCardMeta(text: "아직 작업이 없어요")
                }
            }
            .padding(.horizontal, ObSpace.md)
            .padding(.top, 10)
            .padding(.bottom, ObSpace.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: ObRadius.md))
        }
        .buttonStyle(HomeCardButtonStyle(radius: ObRadius.md))
    }

    @ViewBuilder
    private func footer(_ key: HomeProjectColumn) -> some View {
        if adding == key {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.system(size: 14))
                    .foregroundStyle(Ob.text3)
                TextField("프로젝트 이름", text: $name)
                    .font(ObFont.footnote)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit { submit() }
                    .accessibilityLabel("새 프로젝트 이름")
            }
            .padding(.horizontal, ObSpace.sm)
            .frame(minHeight: 36)
            .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
            .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.text3, lineWidth: 1))
            .onChange(of: focused) { _, now in
                if !now, adding != nil { submit() }
            }
        } else {
            HomeColumnButton(symbol: "plus", label: "새 프로젝트") { startAdding(key) }
        }
    }

    private func startAdding(_ key: HomeProjectColumn) {
        name = ""
        withAnimation(ObMotion.mid) { column = key }
        adding = key
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            focused = true
        }
    }

    private func submit() {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        adding = nil
        name = ""
        focused = false
        guard !n.isEmpty else { return }
        let active = store.projects.filter { $0.archivedAt == nil }.count
        let colors = ProjectColor.allCases
        let color = colors[(active + 6) % colors.count]
        Task {
            if let p = await store.createProject(name: n, color: color) {
                router.open(.project(p.id))
            }
        }
    }
}

extension View {
    /// Board columns take most of the screen so the next one peeks in.
    func homeBoardColumnWidth() -> some View {
        containerRelativeFrame(.horizontal) { w, _ in min(320, w * 0.8) }
    }
}
