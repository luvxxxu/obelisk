import SwiftUI

/// 파급 예측 (web app/(app)/forecast/page.tsx): a calm reading page. One status line and a quiet facts row,
/// then every overdue task with only the ripple it causes (complete it, or move it to today with its
/// chain), the tasks that hold the plan together, and the ones that keep getting postponed.
struct ForecastScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    /// "all" while the whole plan is being re-based, a task id while one root moves.
    @State private var busy: String?
    @State private var howOpen = false

    var body: some View {
        let items = store.planItemsNow
        let fc = forecast(items, store.deps, store.today)
        let lev = leverage(items, store.deps)
        let roots = ForecastRoot.list(fc, items: items, store: store)
        let bottlenecks = Array(lev.filter { $0.delayedIfLate + $0.conflictsIfLate > 0 || $0.slackDays == 0 }.prefix(8))
        let chronic = Array(
            store.activeTasks
                .filter { $0.postponedCount >= 2 }
                .sorted { $0.postponedCount != $1.postponedCount ? $0.postponedCount > $1.postponedCount : $0.number < $1.number }
                .prefix(8)
        )

        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader("파급 예측", subtitle: "기한 지난 작업 하나가 뒤에 이어진 일정을 얼마나 밀어내는지 미리 계산해 보여줘요.")
                VStack(alignment: .leading, spacing: 0) {
                    howItWorks
                        .padding(.bottom, ObSpace.xxl)
                    status(fc)
                        .padding(.bottom, 40)
                    if !roots.isEmpty {
                        rootsSection(roots)
                            .padding(.bottom, 40)
                    }
                    ForecastOddsSection()
                        .padding(.bottom, 40)
                    keySection(bottlenecks, hasLinks: !lev.isEmpty)
                        .padding(.bottom, 40)
                    if !chronic.isEmpty {
                        chronicSection(chronic)
                            .padding(.bottom, 40)
                    }
                }
                .padding(.horizontal, ObSpace.page)
            }
            .padding(.bottom, ObSpace.xxl)
        }
        .scrollIndicators(.hidden)
        .refreshable { await store.refresh() }
    }

    // MARK: - 어떻게 계산하나요?

    private var howItWorks: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            Button {
                withAnimation(ObMotion.standard) { howOpen.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "info.circle").foregroundStyle(Ob.text3)
                    Text("어떻게 계산하나요?").foregroundStyle(Ob.text2)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Ob.text3)
                        .rotationEffect(.degrees(howOpen ? 180 : 0))
                }
                .font(ObFont.footnote.weight(.medium))
                .padding(.horizontal, 10)
                .frame(minHeight: ObSize.controlSm)
                .contentShape(Capsule())
            }
            .buttonStyle(ForecastPillStyle())
            .padding(.leading, -10)
            .frame(minHeight: ObSize.row)
            .accessibilityValue(howOpen ? "펼침" : "접힘")

            if howOpen {
                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    step(1, Text("기한이 지난 작업은 \(strong("빨라도 오늘 끝난다"))고 보고, 늦어진 날짜만큼을 지연으로 계산해요."))
                    step(2, Text("그 작업을 기다리는 \(strong("후속 작업"))(‘먼저 끝나야 하는 작업’으로 연결된 작업)을 같은 만큼 뒤로 밀어요."))
                    step(3, Text("후속 작업에 \(strong("여유"))가 있으면 지연을 흡수해요. 움직일 수 없는 \(strong("고정 일정"))에 닿으면 \(strong("충돌"))로 표시해요."))
                    step(4, Text("여기서는 미리 보기만 해요. 버튼을 눌러야 실제 일정이 바뀌어요."))
                }
                .padding(ObSpace.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.lg))
                .transition(.opacity)
            }
        }
    }

    private func strong(_ s: String) -> Text {
        Text(s).fontWeight(.semibold).foregroundStyle(Ob.text)
    }

    private func step(_ n: Int, _ text: Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
            Text("\(n).")
                .font(ObFont.footnote.monospacedDigit())
                .foregroundStyle(Ob.text3)
            text
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text2)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - status

    private func status(_ fc: ImpactReport) -> some View {
        let ok = fc.rootIds.isEmpty
        let s = fc.summary
        let tone: Tone = s.conflictCount > 0 ? .danger : ok ? .ok : .warn
        let line = ok
            ? "모든 일정이 순조로워요"
            : s.delayedCount + s.conflictCount == 0
                ? "기한 지난 작업 \(fc.rootIds.count)개, 다른 일정엔 영향이 없어요"
                : "기한 지난 작업 \(fc.rootIds.count)개가 일정 \(s.delayedCount + s.conflictCount)개를 밀고 있어요"
        let sub: String = {
            if ok { return "기한이 지난 작업이 없어요. 아래에서 일정이 가장 민감한 작업을 확인해 보세요." }
            if let from = s.finishFrom, let to = s.finishTo, from != to {
                return "오늘 기준으로 전체 완료 예상일이 \(formatRelativeKo(from, store.today)) → \(formatRelativeKo(to, store.today))로 늦어져요."
            }
            return "오늘 기준 예측이에요. 각 작업을 오늘 끝내거나, 일정을 오늘 기준으로 다시 맞출 수 있어요."
        }()
        let canApplyAll = !ok && s.delayedCount > 0

        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: ok ? "checkmark.circle" : "exclamationmark.triangle")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(tone.ink)
                Text(line)
                    .font(ObFont.title3)
                    .foregroundStyle(Ob.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Text(sub)
                .font(ObFont.sub)
                .foregroundStyle(Ob.text2)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, ObSpace.xs)

            // Facts: two by two on a phone, hairlines between.
            VStack(spacing: 0) {
                Hairline()
                HStack(spacing: 0) {
                    fact(fc.rootIds.count, "기한 지남")
                    Hairline(vertical: true)
                    fact(s.delayedCount, "밀리는 작업").padding(.leading, ObSpace.xl)
                }
                .fixedSize(horizontal: false, vertical: true)
                Hairline()
                HStack(spacing: 0) {
                    fact(s.conflictCount, "고정 일정 충돌", danger: true)
                    Hairline(vertical: true)
                    fact(s.maxShiftDays, "최대 지연", unit: "일").padding(.leading, ObSpace.xl)
                }
                .fixedSize(horizontal: false, vertical: true)
                Hairline()
            }
            .padding(.top, ObSpace.xl)

            if canApplyAll {
                VStack(alignment: .leading, spacing: ObSpace.md) {
                    Text("기한 지난 작업은 오늘로, 밀리는 작업은 예측된 날짜로 한 번에 옮겨요.")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text2)
                        .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await applyAll(fc) }
                    } label: {
                        HStack(spacing: ObSpace.sm) {
                            if busy == "all" {
                                ProgressView().controlSize(.small).tint(Ob.onPrimary)
                            }
                            Text("전체 일정 오늘 기준으로 재조정")
                        }
                    }
                    .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
                    .disabled(busy == "all")
                    .accessibilityLabel(busy == "all" ? "재조정하는 중" : "전체 일정 오늘 기준으로 재조정")
                }
                .padding(.top, ObSpace.lg)
            }
        }
    }

    /// One quiet figure: muted label over a big number. Only a real conflict gets colour.
    private func fact(_ n: Int, _ label: String, unit: String? = nil, danger: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                .lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text("\(n)")
                    .font(ObFont.figure)
                    .foregroundStyle(danger && n > 0 ? Ob.dangerText : Ob.text)
                if let unit {
                    Text(unit)
                        .font(ObFont.sub.weight(.medium))
                        .foregroundStyle(Ob.text3)
                }
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func applyAll(_ fc: ImpactReport) async {
        busy = "all"
        defer { busy = nil }
        let changes = changesFromReport(fc, true)
        if await store.reschedule(changes) {
            Haptics.success()
            store.history.notify("\(changes.count)개 작업을 오늘 기준으로 다시 맞췄어요", store.history.latest)
        }
    }

    // MARK: - overdue roots

    private func sectionHead(_ title: String, count: Int?, lead: String) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                Text(title)
                    .font(ObFont.title3)
                    .foregroundStyle(Ob.text)
                if let count {
                    Text("\(count)")
                        .font(ObFont.body.weight(.medium).monospacedDigit())
                        .foregroundStyle(Ob.text3)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Text(lead)
                .font(ObFont.sub)
                .foregroundStyle(Ob.text2)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, ObSpace.md)
    }

    private func rootsSection(_ roots: [ForecastRoot]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHead(
                "지금 밀리고 있는 일정",
                count: roots.count,
                lead: "기한 지난 작업마다 따라 밀리는 일정을 보여줘요. 이미 끝냈다면 완료로, 아니면 오늘로 옮겨 보세요."
            )
            Hairline()
            ForEach(roots) { r in
                rootView(r)
                Hairline()
            }
        }
    }

    private func rootView(_ r: ForecastRoot) -> some View {
        let t = r.task
        let editable = store.canEdit(t)
        let s = r.report.summary
        let hasImpact = s.delayedCount + s.conflictCount > 0
        let head = Self.rippleSummary(r.report)
        let due = t.dueDate ?? t.startDate

        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: ObSpace.md) {
                TaskCheckbox(status: t.status, priority: t.priority, disabled: !editable) {
                    Task { await store.toggleDone(t.id) }
                }
                .padding(-11)
                .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Button {
                        router.openTask(t.id)
                    } label: {
                        Text(t.title)
                            .font(ObFont.body.weight(.medium))
                            .foregroundStyle(Ob.text)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    rootMeta(r, due: due)
                        .font(ObFont.caption.monospacedDigit())
                        .foregroundStyle(Ob.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Group {
                if hasImpact {
                    VStack(alignment: .leading, spacing: ObSpace.xs) {
                        Label {
                            Text(head.text).fixedSize(horizontal: false, vertical: true)
                        } icon: {
                            Image(systemName: "exclamationmark.triangle")
                        }
                        .labelStyle(ComposeTightLabelStyle())
                        .font(ObFont.footnote.weight(.medium))
                        .foregroundStyle(head.tone.text)
                        .padding(.leading, 34)
                        ImpactView(report: r.report, hideRoot: true, compact: true)
                            .padding(.leading, ObSpace.md)
                    }
                } else {
                    Label {
                        Text("이 작업을 기다리는 일정은 없어요.")
                    } icon: {
                        Image(systemName: "checkmark.circle").foregroundStyle(Ob.ok)
                    }
                    .labelStyle(ComposeTightLabelStyle())
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .padding(.leading, 34)
                }
            }
            .padding(.top, 10)

            if editable {
                HStack(spacing: ObSpace.sm) {
                    Button {
                        Task { await store.toggleDone(t.id) }
                    } label: {
                        Label("완료했어요", systemImage: "checkmark")
                            .labelStyle(ComposeTightLabelStyle())
                    }
                    .buttonStyle(.ob(.ghost, size: .small, fullWidth: true))

                    Button {
                        Task { await moveToToday(r) }
                    } label: {
                        HStack(spacing: 6) {
                            if busy == t.id {
                                ProgressView().controlSize(.mini)
                            } else {
                                Image(systemName: "calendar.badge.clock")
                            }
                            Text("오늘로 옮기기\(s.delayedCount > 0 ? " · \(s.delayedCount)개 연쇄" : "")")
                        }
                    }
                    .buttonStyle(.ob(.outline, size: .small, fullWidth: true))
                    .disabled(busy == t.id)
                    .accessibilityLabel(busy == t.id ? "옮기는 중" : "오늘로 옮기기\(s.delayedCount > 0 ? ", \(s.delayedCount)개 연쇄" : "")")
                }
                .padding(.top, ObSpace.md)
            }
        }
        .padding(.vertical, ObSpace.lg)
    }

    /// "8일 지남 · #2 · 마감 11월 11일 (수) · 후속 6개" as one wrapping line (overdue in danger).
    private func rootMeta(_ r: ForecastRoot, due: ISODate?) -> Text {
        let overdue = Text(r.days == 1 ? "어제 마감" : "\(r.days)일 지남")
            .fontWeight(.medium)
            .foregroundStyle(Ob.dangerText)
        var rest = ["#\(r.task.number)"]
        if let due { rest.append("마감 \(formatRelativeKo(due, store.today))") }
        if r.downstream > 0 { rest.append("후속 \(r.downstream)개") }
        return Text("\(overdue)  ·  \(rest.joined(separator: "  ·  "))")
    }

    private func moveToToday(_ r: ForecastRoot) async {
        busy = r.task.id
        defer { busy = nil }
        let changes = changesFromReport(r.report, true)
        if await store.reschedule(changes, rootId: r.task.id) {
            Haptics.success()
            store.history.notify(changes.count > 1 ? "오늘로 옮기고 \(changes.count - 1)개 작업을 함께 조정했어요" : "오늘로 옮겼어요", store.history.latest)
        }
    }

    /// One-line summary of a root's ripple (shown when something is pushed).
    static func rippleSummary(_ r: ImpactReport) -> (tone: Tone, text: String) {
        let s = r.summary
        var parts: [String] = []
        if s.delayedCount > 0 { parts.append("작업 \(s.delayedCount)개가 최대 \(daysLabel(s.maxShiftDays)) 밀려요") }
        if s.conflictCount > 0 { parts.append("고정 일정 \(s.conflictCount)개와 충돌해요") }
        return (s.conflictCount > 0 ? .danger : s.delayedCount > 0 ? .warn : .ok, parts.joined(separator: " · "))
    }

    // MARK: - 핵심 작업

    private func keySection(_ list: [TaskLeverage], hasLinks: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHead(
                "핵심 작업",
                count: list.isEmpty ? nil : list.count,
                lead: "하루만 늦어도 다른 일정이 움직이는 작업이에요. 여기부터 지키면 전체 일정이 지켜져요."
            )
            if list.isEmpty {
                VStack(spacing: 0) {
                    Hairline()
                    if hasLinks {
                        EmptyState("모든 연결 작업에 여유가 있어요", message: "하루쯤 늦어져도 다른 일정은 움직이지 않아요.")
                    } else {
                        EmptyState("아직 연결된 작업이 없어요", message: "작업 상세에서 ‘먼저 끝나야 하는 작업’을 연결하면 무엇이 일정의 핵심인지 계산해 드려요.")
                    }
                }
            } else {
                ForecastTable(columns: [("작업", nil), ("여유", 72), ("1일 늦으면", 92)]) {
                    ForEach(Array(list.enumerated()), id: \.element.taskId) { i, l in
                        if let t = store.task(l.taskId) {
                            if i > 0 { Hairline() }
                            keyRow(l, t)
                        }
                    }
                }
            }
        }
    }

    private func keyRow(_ l: TaskLeverage, _ t: TaskItem) -> some View {
        Button {
            router.openTask(t.id)
        } label: {
            HStack(alignment: .center, spacing: ObSpace.sm) {
                titleCell(t, meta: "마감 \(t.dueDate.map { formatRelativeKo($0, store.today) } ?? "–") · 후속 \(l.downstreamCount)개")
                Group {
                    if let slack = l.slackDays {
                        if slack == 0 {
                            Text("여유 없음").fontWeight(.medium).foregroundStyle(Ob.dangerText)
                        } else {
                            Text(daysLabel(slack)).foregroundStyle(Ob.text)
                        }
                    } else {
                        Text("–").foregroundStyle(Ob.text3)
                    }
                }
                .font(ObFont.footnote.monospacedDigit())
                .frame(width: 72, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    if l.delayedIfLate > 0 {
                        Text("\(l.delayedIfLate)개 밀림").fontWeight(.medium).foregroundStyle(Ob.warnText)
                    }
                    if l.conflictsIfLate > 0 {
                        Text("충돌 \(l.conflictsIfLate)").fontWeight(.medium).foregroundStyle(Ob.dangerText)
                    }
                    if l.delayedIfLate + l.conflictsIfLate == 0 {
                        Text("영향 없음").foregroundStyle(Ob.text2)
                    }
                }
                .font(ObFont.footnote.monospacedDigit())
                .frame(width: 92, alignment: .leading)
            }
            .padding(.horizontal, ObSpace.md)
            .padding(.vertical, 10)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.obRow)
        .accessibilityElement(children: .combine)
    }

    private func titleCell(_ t: TaskItem, meta: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("#\(t.number)")
                    .font(ObFont.caption.monospacedDigit())
                    .foregroundStyle(Ob.text3)
                Text(t.title)
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
            }
            Text(meta)
                .font(ObFont.caption)
                .foregroundStyle(Ob.text3)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - 자꾸 미뤄지는 작업

    private func chronicSection(_ list: [TaskItem]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHead(
                "자꾸 미뤄지는 작업",
                count: list.count,
                lead: "두 번 이상 미룬 작업이에요. 더 작게 쪼개거나, 맡기거나, 과감히 지우는 것도 방법이에요."
            )
            ForecastTable(columns: [("작업", nil), ("미룬 횟수", 96)]) {
                ForEach(Array(list.enumerated()), id: \.element.id) { i, t in
                    if i > 0 { Hairline() }
                    Button {
                        router.openTask(t.id)
                    } label: {
                        HStack(spacing: ObSpace.sm) {
                            titleCell(t, meta: "마감 \(t.dueDate.map { formatRelativeKo($0, store.today) } ?? "–")")
                            Label("\(t.postponedCount)회 미룸", systemImage: "calendar.badge.clock")
                                .labelStyle(ComposeTightLabelStyle())
                                .font(ObFont.footnote.weight(.medium).monospacedDigit())
                                .foregroundStyle(Ob.warnText)
                                .frame(width: 96, alignment: .trailing)
                        }
                        .padding(.horizontal, ObSpace.md)
                        .padding(.vertical, 10)
                        .frame(minHeight: 56)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.obRow)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

// MARK: - pieces

/// One overdue task and only the ripple it causes.
struct ForecastRoot: Identifiable {
    var task: TaskItem
    var days: Int
    var report: ImpactReport
    var downstream: Int
    var id: String { task.id }

    /// Worst first: conflicts, then pushed tasks, then the longest overdue.
    @MainActor
    static func list(_ fc: ImpactReport, items: [PlanItem], store: AppStore) -> [ForecastRoot] {
        let roots: [ForecastRoot] = fc.rootIds.compactMap { id in
            guard let t = store.tasks[id], let anchor = t.dueDate ?? t.startDate else { return nil }
            let days = diffDays(store.today, anchor)
            let report = simulate(items, store.deps, [id: days])
            return ForecastRoot(task: t, days: days, report: report, downstream: Set(downstreamOf(store.deps, id)).count)
        }
        return JS.sorted(roots) { a, b in
            let ca = a.report.summary.conflictCount, cb = b.report.summary.conflictCount
            if cb != ca { return cb - ca }
            let da = a.report.summary.delayedCount, db = b.report.summary.delayedCount
            if db != da { return db - da }
            return b.days - a.days
        }
    }
}

/// A bordered table (web .tableWrap): a muted header row, hairline-separated rows.
private struct ForecastTable<Rows: View>: View {
    /// Header labels with a fixed width (nil = takes the slack).
    var columns: [(String, CGFloat?)]
    @ViewBuilder var rows: () -> Rows

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: ObSpace.sm) {
                ForEach(Array(columns.enumerated()), id: \.offset) { i, c in
                    let trailing = i == columns.count - 1 && columns.count == 2
                    Text(c.0)
                        .font(ObFont.caption.weight(.medium))
                        .foregroundStyle(Ob.text3)
                        .lineLimit(1)
                        .frame(width: c.1, alignment: trailing ? .trailing : .leading)
                        .frame(maxWidth: c.1 == nil ? .infinity : nil, alignment: .leading)
                }
            }
            .padding(.horizontal, ObSpace.md)
            .frame(minHeight: 34)
            .background(Ob.tint)
            .accessibilityHidden(true)
            Hairline()
            rows()
        }
        .clipShape(RoundedRectangle(cornerRadius: ObRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: ObRadius.lg).strokeBorder(Ob.border, lineWidth: 1))
    }
}

/// The "어떻게 계산하나요?" pill: a quiet fill while pressed.
private struct ForecastPillStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Ob.surface2 : .clear, in: Capsule())
            .animation(ObMotion.fast, value: configuration.isPressed)
    }
}
