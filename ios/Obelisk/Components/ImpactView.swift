import SwiftUI

/// What a delay does (web components/ImpactView.tsx): a one-line verdict with counts, project finish
/// slips, and the tree of affected tasks (each right under the task that pushed it) with a kind badge
/// (what happens) and an amount (by how much).
struct ImpactView: View {
    var report: ImpactReport
    var hideRoot = false
    var compact = false
    /// Tapping a task opens it (off inside sheets that resolve a change).
    var linkTasks = true

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let head = Self.headline(report)
        let items = Self.treeOrder(report.impacts).filter { !(hideRoot && $0.kind == .root) }
        let minDepth = hideRoot ? 1 : 0

        VStack(alignment: .leading, spacing: ObSpace.md) {
            if !compact {
                HStack(alignment: .top, spacing: ObSpace.md) {
                    Image(systemName: head.tone == .ok ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(head.tone.ink)
                        .font(.system(size: 17))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(head.text)
                            .font(ObFont.body.weight(.medium))
                            .foregroundStyle(head.tone.text)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: ObSpace.md) {
                            stat("밀림", report.summary.delayedCount)
                            stat("충돌", report.summary.conflictCount)
                            stat("흡수", report.summary.absorbedCount)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .obCallout(head.tone)
            }

            if !report.summary.projectSlips.isEmpty {
                VStack(spacing: 0) {
                    ForEach(report.summary.projectSlips, id: \.projectId) { slip in
                        let p = store.project(slip.projectId)
                        HStack(spacing: ObSpace.sm) {
                            Circle().fill(p?.color.palette.ink ?? Ob.text3).frame(width: 7, height: 7)
                            Text(p?.name ?? "프로젝트")
                                .font(ObFont.sub.weight(.medium))
                                .foregroundStyle(Ob.text)
                                .lineLimit(1)
                            Spacer(minLength: ObSpace.sm)
                            Text("완료 \(formatShortKo(slip.from)) → \(formatShortKo(slip.to))")
                                .font(ObFont.footnote)
                                .foregroundStyle(Ob.text3)
                            Text("+\(daysLabel(slip.shiftDays))")
                                .font(ObFont.footnote.weight(.semibold).monospacedDigit())
                                .foregroundStyle(Ob.warnText)
                        }
                        .frame(minHeight: 36)
                    }
                }
            }

            if !items.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.taskId) { index, im in
                        row(im, depth: max(0, im.depth - minDepth))
                        if index < items.count - 1 { Hairline().padding(.leading, CGFloat(max(0, im.depth - minDepth)) * 16 + 18) }
                    }
                }
            }
        }
    }

    private func stat(_ label: String, _ n: Int) -> some View {
        HStack(spacing: 3) {
            Text(label).foregroundStyle(Ob.text3)
            Text("\(n)").fontWeight(.semibold).foregroundStyle(Ob.text2).monospacedDigit()
        }
        .font(ObFont.footnote)
    }

    private func row(_ im: TaskImpact, depth: Int) -> some View {
        let tone = Self.kindTone(im.kind)
        return Button {
            guard linkTasks else { return }
            router.openTask(im.taskId)
        } label: {
            HStack(alignment: .center, spacing: ObSpace.sm) {
                if depth > 0 {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 11))
                        .foregroundStyle(Ob.text4)
                        .padding(.leading, CGFloat(depth - 1) * 16)
                } else {
                    Circle().fill(tone == .neutral ? Ob.text3 : tone.ink).frame(width: 6, height: 6)
                        .padding(.horizontal, 2)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        if let n = im.number {
                            Text("#\(n)").foregroundStyle(Ob.text3).monospacedDigit()
                        }
                        Text(im.title).foregroundStyle(Ob.text).lineLimit(1)
                    }
                    .font(ObFont.sub)
                    Group {
                        if im.kind == .shifted || im.kind == .root {
                            Text("\(Self.spanText(im.from)) → \(Self.spanText(im.to))")
                        } else {
                            Text(Self.spanText(im.from))
                        }
                    }
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
                }
                Spacer(minLength: ObSpace.sm)
                VStack(alignment: .trailing, spacing: 2) {
                    Chip(text: Self.kindLabel(im), tone: tone, filled: true)
                    Text(Self.amountText(im))
                        .font(ObFont.caption.monospacedDigit())
                        .foregroundStyle(tone == .neutral ? Ob.text3 : tone.text)
                }
            }
            .padding(.vertical, ObSpace.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!linkTasks)
    }

    // MARK: presentation (same strings as the web)

    static func headline(_ report: ImpactReport) -> (tone: Tone, text: String) {
        let s = report.summary
        if s.delayedCount == 0, s.conflictCount == 0 {
            return (.ok, s.absorbedCount > 0 ? "여유 시간이 흡수해서 다른 일정은 그대로예요" : "다른 일정에는 영향이 없어요")
        }
        var parts: [String] = []
        if s.delayedCount > 0 { parts.append("작업 \(s.delayedCount)개가 최대 \(daysLabel(s.maxShiftDays)) 밀려요") }
        if s.conflictCount > 0 { parts.append("고정 일정 \(s.conflictCount)개와 충돌해요") }
        return (s.conflictCount > 0 ? .danger : .warn, parts.joined(separator: " · "))
    }

    static func spanText(_ span: DateSpan) -> String {
        if let a = span.startDate, let b = span.dueDate, a != b {
            let end = formatShortKo(b)
            let trimmed = end.range(of: "^\\d+/", options: .regularExpression).map { String(end[$0.upperBound...]) } ?? end
            return "\(formatShortKo(a))–\(trimmed)"
        }
        if let one = span.dueDate ?? span.startDate { return formatShortKo(one) }
        return "날짜 없음"
    }

    /// Depth-first order so every task sits right under the task that pushed it.
    static func treeOrder(_ impacts: [TaskImpact]) -> [TaskImpact] {
        let ids = Set(impacts.map(\.taskId))
        var byVia: [String: [TaskImpact]] = [:]
        let rootKey = "\u{0}"
        for im in impacts {
            let key = im.viaId.flatMap { ids.contains($0) ? $0 : nil } ?? rootKey
            byVia[key, default: []].append(im)
        }
        var out: [TaskImpact] = []
        var seen = Set<String>()
        func visit(_ im: TaskImpact) {
            guard !seen.contains(im.taskId) else { return }
            seen.insert(im.taskId)
            out.append(im)
            for child in byVia[im.taskId] ?? [] { visit(child) }
        }
        for root in byVia[rootKey] ?? [] { visit(root) }
        for im in impacts { visit(im) }
        return out
    }

    static func kindTone(_ k: ImpactKind) -> Tone {
        switch k {
        case .root: .neutral
        case .shifted: .warn
        case .conflict: .danger
        case .absorbed: .ok
        case .unscheduled: .neutral
        }
    }

    static func kindLabel(_ im: TaskImpact) -> String {
        switch im.kind {
        case .root: im.shiftDays > 0 ? "미룸" : im.shiftDays < 0 ? "당김" : "변경"
        case .shifted: "밀림"
        case .conflict: "충돌"
        case .absorbed: "흡수"
        case .unscheduled: "미정"
        }
    }

    static func amountText(_ im: TaskImpact) -> String {
        switch im.kind {
        case .root: im.shiftDays >= 0 ? "+\(daysLabel(im.shiftDays))" : "−\(daysLabel(-im.shiftDays))"
        case .shifted: "+\(daysLabel(im.shiftDays))"
        case .conflict: "\(daysLabel(im.overrunDays)) 초과"
        case .absorbed: "여유 \(im.slackDays ?? 0)일 남음"
        case .unscheduled: im.shiftDays != 0 ? "+\(daysLabel(im.shiftDays)) 대기" : "대기 늘어남"
        }
    }
}

/// Shown whenever a date edit would ripple into other tasks (web PostponeDialog).
struct PendingChangeSheet: View {
    var change: PendingChange
    @Environment(AppStore.self) private var store

    var body: some View {
        let p = change.preview
        let summary = p.report.summary
        let others = p.cascade.count - 1
        let days = p.shiftDays
        let target = change.next.dueDate ?? change.next.startDate

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.lg) {
                    VStack(alignment: .leading, spacing: ObSpace.xs) {
                        Text(title(days: days, target: target))
                            .font(ObFont.title3)
                            .foregroundStyle(Ob.text)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("적용하기 전에 아래 영향을 확인하고, 어떻게 옮길지 골라 주세요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text3)
                    }

                    ImpactView(report: p.report, linkTasks: false)

                    if !p.startsBeforeBlockers.isEmpty {
                        VStack(alignment: .leading, spacing: ObSpace.xs) {
                            Label("먼저 끝나야 하는 작업보다 앞서 시작하게 돼요", systemImage: "lock")
                                .font(ObFont.sub.weight(.semibold))
                                .foregroundStyle(Ob.dangerText)
                            ForEach(p.startsBeforeBlockers, id: \.taskId) { b in
                                Text("\(b.number.map { "#\($0) " } ?? "")\(b.title) · \(formatShortKo(b.dueDate)) 마감, \(daysLabel(b.overlapDays)) 겹침")
                                    .font(ObFont.footnote)
                                    .foregroundStyle(Ob.dangerText)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .obCallout(.danger)
                    }

                    if others > 0 {
                        VStack(alignment: .leading, spacing: ObSpace.md) {
                            choice("연쇄 적용", "뒤에 이어진 작업 \(others)개도 필요한 만큼 함께 옮겨요.")
                            choice("이 작업만 변경", summary.conflictCount == 0
                                ? "뒤 작업들이 이 작업보다 먼저 시작하는 일정이 돼요."
                                : "이 작업만 옮기고, 뒤 작업 일정은 그대로 둬요.")
                        }
                    }

                    if summary.conflictCount > 0 {
                        Label("고정 일정은 자동으로 옮기지 않아요. 충돌을 없애려면 지연 폭을 줄이거나, 고정 일정 자체를 직접 조정하세요.", systemImage: "info.circle")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: ObSpace.sm) {
                    Button(others > 0 ? "연쇄 적용 · \(others)개 함께 이동" : "변경") {
                        Task { await store.resolvePending(.cascade) }
                    }
                    .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
                    Button("이 작업만 변경") {
                        Task { await store.resolvePending(.only) }
                    }
                    .buttonStyle(.ob(.outline, size: .large, fullWidth: true))
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .background(Ob.bg)
            }
            .obPage()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { Task { await store.resolvePending(.cancel) } }
                }
            }
        }
    }

    private func title(days: Int, target: ISODate?) -> String {
        if days == 0 { return "“\(change.title)” 일정을 바꾸면" }
        let to = target.map { "\(formatShortKo($0))로 " } ?? ""
        return "“\(change.title)”을(를) \(to)\(daysLabel(abs(days))) \(days > 0 ? "미루면" : "당기면")"
    }

    private func choice(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(ObFont.sub.weight(.semibold)).foregroundStyle(Ob.text)
            Text(text).font(ObFont.footnote).foregroundStyle(Ob.text3)
        }
    }
}
