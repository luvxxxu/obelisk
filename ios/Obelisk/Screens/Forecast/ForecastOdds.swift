import SwiftUI

/// 파급 예측 › 완료 확률 (web forecast OddsSection): when the work will really be done, learned from the
/// user's own history. Overall and per-project 50% / 85% dates, the tasks unlikely to make their due date,
/// fixed dates at risk, and one line on what the numbers are based on.
struct ForecastOddsSection: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                HStack(alignment: .firstTextBaseline) {
                    Text("완료 확률")
                        .font(ObFont.title3)
                        .foregroundStyle(Ob.text)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button {
                        router.present(.init(id: "commit-new", detents: [.large]) { CommitSheet() })
                    } label: {
                        ListsButtonLabel(title: "약속하기 전에", symbol: "calendar.badge.checkmark")
                    }
                    .buttonStyle(.ob(.outline, size: .small))
                }
                Text("지금까지 끝낸 작업과 기록한 시간으로 수백 번 시뮬레이션해서, 언제 끝날지와 마감을 지킬 확률을 계산해요.")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text2)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.bottom, ObSpace.md)

            if let o = store.odds {
                content(o)
                    .opacity(loading ? 0.6 : 1)
            } else {
                LoadingView(label: "계산하는 중")
            }
        }
        .task(id: store.revision) {
            loading = true
            await store.loadOdds(force: store.odds != nil)
            loading = false
        }
    }

    @ViewBuilder
    private func content(_ o: OddsResponse) -> some View {
        let today = store.today
        let atRisk = o.report.tasks
            .filter { ($0.onTime ?? 1) < 0.6 }
            .compactMap { x in store.task(x.taskId).map { (x, $0) } }
            .sorted { ($0.0.onTime ?? 0) < ($1.0.onTime ?? 0) }
        let fixed = o.report.tasks
            .filter { ($0.conflict ?? 0) >= 0.15 }
            .compactMap { x in store.task(x.taskId).map { (x, $0) } }
            .sorted { ($0.0.conflict ?? 0) > ($1.0.conflict ?? 0) }
        let projects = o.report.projects
            .filter { $0.projectId != nil }
            .compactMap { p in store.project(p.projectId).map { (p, $0) } }
            .sorted { ($0.0.p85 ?? "9999") < ($1.0.p85 ?? "9999") }

        VStack(alignment: .leading, spacing: ObSpace.lg) {
            if let overall = o.report.overall {
                HStack(spacing: 0) {
                    dateStat("절반의 확률로", overall.p50, today)
                    Hairline(vertical: true).frame(height: 40)
                    dateStat("85% 확률로", overall.p85, today)
                }
                .padding(.vertical, ObSpace.md)
                .obCard(padding: 0)
                .accessibilityElement(children: .combine)
            }

            if !projects.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(projects.enumerated()), id: \.element.0.projectId) { i, x in
                        if i > 0 { Hairline() }
                        Button {
                            router.open(.project(x.1.id))
                        } label: {
                            HStack(spacing: ObSpace.sm) {
                                ProjectSwatch(color: x.1.color)
                                Text(x.1.name)
                                    .font(ObFont.sub)
                                    .foregroundStyle(Ob.text)
                                    .lineLimit(1)
                                Text("\(x.0.tasks)개")
                                    .font(ObFont.caption)
                                    .foregroundStyle(Ob.text3)
                                Spacer(minLength: ObSpace.sm)
                                Text("50% \(short(x.0.p50, today)) · 85% \(short(x.0.p85, today))")
                                    .font(ObFont.footnote.monospacedDigit())
                                    .foregroundStyle(Ob.text2)
                            }
                            .padding(.horizontal, ObSpace.md)
                            .frame(minHeight: ObSize.row)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.obRow)
                    }
                }
                .obCard(padding: 0)
            }

            VStack(alignment: .leading, spacing: ObSpace.sm) {
                Text("제때 끝내기 어려운 작업")
                    .font(ObFont.footnote.weight(.semibold))
                    .foregroundStyle(Ob.text)
                if atRisk.isEmpty {
                    Text("마감을 넘길 가능성이 큰 작업은 없어요.")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(atRisk.prefix(10).enumerated()), id: \.element.0.taskId) { i, x in
                            if i > 0 { Hairline() }
                            riskRow(x.1, value: "제때 \(percentKo(x.0.onTime ?? 0))", meta: "마감 \(x.1.dueDate.map { formatRelativeKo($0, today) } ?? "–") · 85% \(short(x.0.p85, today))", tone: (x.0.onTime ?? 0) < 0.3 ? .danger : .warn)
                        }
                    }
                    .obCard(padding: 0)
                }
            }

            if !fixed.isEmpty {
                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    Text("위험한 고정 일정")
                        .font(ObFont.footnote.weight(.semibold))
                        .foregroundStyle(Ob.text)
                    VStack(spacing: 0) {
                        ForEach(Array(fixed.prefix(8).enumerated()), id: \.element.0.taskId) { i, x in
                            if i > 0 { Hairline() }
                            riskRow(x.1, value: "충돌 \(percentKo(x.0.conflict ?? 0))", meta: "\(x.1.startDate.map { formatRelativeKo($0, today) } ?? x.1.dueDate.map { formatRelativeKo($0, today) } ?? "") · 앞 작업이 그날까지 안 끝날 확률", tone: .danger)
                        }
                    }
                    .obCard(padding: 0)
                }
            }

            Text(basis(o))
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func dateStat(_ label: String, _ date: ISODate?, _ today: ISODate) -> some View {
        VStack(spacing: 2) {
            Text(date.map { formatRelativeKo($0, today) } ?? "6개월 뒤 이후")
                .font(ObFont.bodyStrong)
                .foregroundStyle(Ob.text)
            Text("\(label) 모두 끝나요")
                .font(ObFont.caption)
                .foregroundStyle(Ob.text3)
        }
        .frame(maxWidth: .infinity)
    }

    private func riskRow(_ t: TaskItem, value: String, meta: String, tone: Tone) -> some View {
        Button {
            router.openTask(t.id)
        } label: {
            HStack(spacing: ObSpace.sm) {
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
                Text(value)
                    .font(ObFont.footnote.weight(.medium).monospacedDigit())
                    .foregroundStyle(tone.text)
            }
            .padding(.horizontal, ObSpace.md)
            .padding(.vertical, ObSpace.sm)
            .frame(minHeight: ObSize.row)
            .contentShape(Rectangle())
        }
        .buttonStyle(.obRow)
    }

    private func short(_ d: ISODate?, _ today: ISODate) -> String {
        d.map { formatRelativeKo($0, today) } ?? "6개월 뒤"
    }

    /// 근거: how long estimates run, the deadline record, focus, the default estimate, other spaces.
    private func basis(_ o: OddsResponse) -> String {
        let c = o.calibration
        var parts: [String] = []
        if c.ratioSamples > 0, let r = c.medianRatio {
            parts.append("예상보다 \(String(format: "%.1f", r))배 걸림 (\(c.ratioSamples)개)")
        } else {
            parts.append("예상 대비 실제 기록이 없어 1.25배로 봐요")
        }
        if c.slipSamples > 0, let on = c.onTimeRate {
            parts.append("첫 마감 지킨 비율 \(percentKo(on))")
        }
        parts.append("하루 집중 \(percentKo(c.focus))")
        parts.append("예상 없는 작업 기본 \(formatDurationKo(c.defaultEstimate))")
        if o.external > 0 { parts.append("다른 공간 작업 \(o.external)개 포함") }
        return "근거: " + parts.joined(separator: " · ")
    }
}
