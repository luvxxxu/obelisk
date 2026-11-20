import SwiftUI

// The two Jev dialogs (web components/JevDialogs.tsx), shown in one sheet by `JevDialogSheet`.

// MARK: - A. priorities

/// Preselect what Jev is reasonably sure about; leave close calls for the user.
private let JEV_PRESELECT = 0.6

struct JevPriorityDialog: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<String> = []
    @State private var busy = false

    private var center: JevCenter { .shared }

    private var changes: [PrioritySuggestion] {
        (center.data?.suggestions ?? []).filter { sg in store.task(sg.taskId).map { sg.suggested != $0.priority } ?? false }
    }

    private var same: [PrioritySuggestion] {
        (center.data?.suggestions ?? []).filter { sg in store.task(sg.taskId).map { sg.suggested == $0.priority } ?? false }
    }

    /// Changes only when a new result arrives (not on every task edit).
    private var dataKey: String {
        center.data.map { $0.suggestions.map { "\($0.taskId)\($0.suggested)" }.joined(separator: ",") } ?? ""
    }

    private var loading: Bool { center.phase == .loading || center.phase == .idle }

    var body: some View {
        let changes = changes
        let same = same
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.xl) {
                Text("Jev가 작업마다 놓치면 무엇을 잃는지 판단하고, 마감까지 남은 날과 기다리는 작업 수를 더해 우선순위를 골랐어요.")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)

                if loading, center.data == nil {
                    JevLoadingRows(label: "Jev가 작업 \(store.activeTasks.count)개를 살펴보는 중…")
                } else if center.phase == .error, center.data == nil {
                    JevFailure(message: center.error ?? "Jev에 묻지 못했어요") {
                        Task { await center.refreshPriorities(store, force: true) }
                    }
                } else {
                    if let focus = center.data?.focus, let task = store.task(focus.taskId) {
                        focusWell(task, focus.reasons)
                    }
                    if changes.isEmpty {
                        JevCalm(text: "지금 우선순위가 Jev 판단과 모두 같아요.")
                    } else {
                        JevGroup("바꿀 작업", count: changes.count, hint: changes.count > 1 ? "애매한 건 비워 뒀어요" : nil) {
                            ForEach(changes, id: \.taskId) { sg in
                                if let task = store.task(sg.taskId) { row(sg, task, change: true) }
                            }
                        }
                    }
                    if !same.isEmpty {
                        JevGroup("그대로 둘 작업", count: same.count, collapsible: true) {
                            ForEach(same, id: \.taskId) { sg in
                                if let task = store.task(sg.taskId) { row(sg, task, change: false) }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.sm)
            .padding(.bottom, ObSpace.xxl)
            .animation(ObMotion.standard, value: center.phase)
        }
        .scrollIndicators(.hidden)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            JevFooter(
                note: "\(center.data?.model.map { "\($0) · " } ?? "")바꾼 뒤에도 언제든 되돌릴 수 있어요",
                disabled: busy || picked.isEmpty || loading,
                busy: busy,
                action: { Task { await apply(changes) } }
            ) {
                if !busy { Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)) }
                Text(picked.isEmpty ? "적용" : "\(picked.count)개 적용")
            }
        }
        .modifier(JevPrioritiesFollower(enabled: true))
        .onChange(of: dataKey, initial: true) {
            picked = Set(self.changes.filter { $0.confidence >= JEV_PRESELECT }.map(\.taskId))
        }
    }


    private func focusWell(_ task: TaskItem, _ reasons: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: "scope")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Ob.text3)
                Text("지금 할 일")
                    .font(ObFont.caption.weight(.medium))
                    .foregroundStyle(Ob.text2)
            }
            .accessibilityElement(children: .combine)
            JevTaskName(task: task, strong: true)
            JevReasons(reasons: reasons)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(ObSpace.md)
        .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.lg))
    }

    private func row(_ sg: PrioritySuggestion, _ task: TaskItem, change: Bool) -> some View {
        let checked = picked.contains(sg.taskId)
        return JevRow(off: change && !checked, lead: {
            if change {
                JevPick(checked: checked, label: "\(task.title) 우선순위 바꾸기") {
                    if checked { picked.remove(sg.taskId) } else { picked.insert(sg.taskId) }
                }
            } else {
                Color.clear.frame(width: 20, height: ObSize.row)
            }
        }, task: task, reasons: sg.reasons) {
            HStack(spacing: ObSpace.md) {
                if change {
                    JevPriorityChange(from: task.priority, to: sg.suggested)
                } else {
                    JevPriorityText(priority: sg.suggested)
                }
                Spacer(minLength: 0)
                JevConfidence(value: sg.confidence)
            }
        }
    }

    private func apply(_ changes: [PrioritySuggestion]) async {
        busy = true
        let list = changes.filter { picked.contains($0.taskId) }.map { JevCenter.PriorityChange(taskId: $0.taskId, priority: $0.suggested) }
        let n = await center.applyPriorities(store, list)
        busy = false
        if n > 0 { dismiss() }
    }
}

// MARK: - B. postpone

struct JevPostponeDialog: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var scope: PostponeScope
    @State private var capacity: Int?
    @State private var plan: PostponePlan?
    @State private var error: String?
    @State private var loading = true
    @State private var picked: Set<String> = []
    @State private var busy = false
    @State private var seq = 0
    /// Rows whose ripple (함께 n개) is unfolded.
    @State private var expanded: Set<String> = []

    init(initialScope: JevPostponeScope) {
        _scope = State(initialValue: initialScope == .week ? .week : .today)
    }

    private struct RunKey: Hashable {
        var scope: PostponeScope
        var capacity: Int?
    }

    private var cap: Int { plan?.capacity ?? capacity ?? 5 }

    private var groups: (postpone: [PostponeCandidate], could: [PostponeCandidate], keep: [PostponeCandidate]) {
        let list = (plan?.candidates ?? []).filter { store.task($0.taskId) != nil }
        return (
            list.filter { $0.verdict == .postpone },
            list.filter { $0.verdict == .could },
            list.filter { $0.verdict == .keep || $0.verdict == .fixed }
        )
    }

    /// Live load after the picks the user actually kept.
    private var loadAfter: [ISODate: Int] {
        var m: [ISODate: Int] = [:]
        for d in plan?.days ?? [] { m[d.date] = d.load }
        for c in plan?.candidates ?? [] {
            guard picked.contains(c.taskId), let to = c.toDate else { continue }
            m[c.day] = (m[c.day] ?? 0) - 1
            if let n = m[to] { m[to] = n + 1 }
        }
        return m
    }

    var body: some View {
        let groups = groups
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.xl) {
                Text("Jev가 미뤄도 괜찮은 일을 고르고, 파급 엔진이 고정 일정과 부딪히지 않는 여유 있는 날을 찾았어요.")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)

                controls

                if let plan { JevLoadBars(plan: plan, after: loadAfter) }

                if loading, plan == nil {
                    JevLoadingRows(label: "Jev가 미뤄도 되는 일을 고르는 중…")
                } else if let error {
                    JevFailure(message: error) { Task { await run() } }
                } else if let plan {
                    VStack(alignment: .leading, spacing: ObSpace.xl) {
                        if groups.postpone.isEmpty, groups.could.isEmpty {
                            JevCalm(text: plan.overloaded
                                ? "미룰 만한 작업이 없어요. 하루 양을 늘리거나 직접 골라 주세요."
                                : "하루 \(plan.capacity)개 안에 들어와요. 미룰 필요가 없어요.")
                        }
                        if !groups.postpone.isEmpty {
                            JevGroup("미룰 작업", count: groups.postpone.count) {
                                ForEach(groups.postpone, id: \.taskId) { c in candidateRow(c, pickable: true) }
                            }
                        }
                        if !groups.could.isEmpty {
                            JevGroup("미뤄도 되는 작업", count: groups.could.count, hint: "필요하면 골라서 함께 미루세요") {
                                ForEach(groups.could, id: \.taskId) { c in candidateRow(c, pickable: true) }
                            }
                        }
                        if !groups.keep.isEmpty {
                            JevGroup("그대로 둘 작업", count: groups.keep.count, collapsible: true) {
                                ForEach(groups.keep, id: \.taskId) { c in candidateRow(c, pickable: false) }
                            }
                        }
                    }
                    .opacity(loading ? 0.5 : 1)
                    .allowsHitTesting(!loading)
                    .animation(ObMotion.standard, value: loading)
                }
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.sm)
            .padding(.bottom, ObSpace.xxl)
        }
        .scrollIndicators(.hidden)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            JevFooter(
                note: "뒤따르는 작업도 함께 옮기고, 한 번에 되돌릴 수 있어요",
                disabled: busy || loading || picked.isEmpty,
                busy: busy,
                action: { Task { await apply() } }
            ) {
                if !busy { Image(systemName: "calendar.badge.clock").font(.system(size: 14, weight: .medium)) }
                Text(picked.isEmpty ? "미루기" : "\(picked.count)개 미루기")
            }
        }
        .task(id: RunKey(scope: scope, capacity: capacity)) {
            // The stepper can move fast: ask once it settles.
            if plan != nil {
                try? await Task.sleep(for: .milliseconds(300))
                if Task.isCancelled { return }
            }
            await run()
        }
    }

    // MARK: controls

    private var controls: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            Picker("범위", selection: $scope) {
                Text("오늘").tag(PostponeScope.today)
                Text("이번 주").tag(PostponeScope.week)
            }
            .pickerStyle(.segmented)

            HStack(spacing: ObSpace.sm) {
                Text("하루")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text2)
                Text("\(cap)개")
                    .font(ObFont.sub.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Ob.text)
                if plan != nil, capacity == nil, let source = plan?.capacitySource {
                    Text(source == .history ? "최근 14일 페이스" : "기본값")
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                }
                Spacer(minLength: ObSpace.sm)
                Stepper("하루에 할 수 있는 양", value: Binding(
                    get: { cap },
                    set: { n in capacity = max(1, min(30, n)) }
                ), in: 1 ... 30)
                .labelsHidden()
                .accessibilityLabel("하루에 할 수 있는 양")
                .accessibilityValue("\(cap)개")
            }
        }
    }

    // MARK: rows

    @ViewBuilder
    private func candidateRow(_ c: PostponeCandidate, pickable: Bool) -> some View {
        if let task = store.task(c.taskId) {
            let movable = pickable && c.toDate != nil
            let checked = picked.contains(c.taskId)
            let open = expanded.contains(c.taskId)
            VStack(alignment: .leading, spacing: 0) {
                JevRow(off: movable && !checked, lead: {
                    if movable {
                        JevPick(checked: checked, label: "\(task.title) 미루기") {
                            if checked { picked.remove(c.taskId) } else { picked.insert(c.taskId) }
                        }
                    } else {
                        Image(systemName: c.verdict == .fixed ? "pin" : "lock")
                            .font(.system(size: 13))
                            .foregroundStyle(Ob.text3)
                            .frame(height: ObSize.row)
                            .accessibilityLabel(c.verdict == .fixed ? "고정 일정" : "그대로 둠")
                    }
                }, task: task, reasons: c.reasons) {
                    side(c, open: open)
                }
                if open, let to = c.toDate, let report = try? simulateDelay(store.planItemsNow, store.deps, taskId: c.taskId, toDate: to) {
                    ImpactView(report: report, hideRoot: true, compact: true)
                        .padding(.leading, ObSize.row - ObSpace.md + ObSpace.xs)
                        .padding(.vertical, ObSpace.md)
                        .overlay(alignment: .bottom) { Hairline() }
                        .transition(.opacity)
                }
            }
        }
    }

    @ViewBuilder
    private func side(_ c: PostponeCandidate, open: Bool) -> some View {
        if let to = c.toDate {
            HStack(spacing: ObSpace.md) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Ob.text3)
                    Text(formatRelativeKo(to, store.today))
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text)
                    Text(formatShortKo(to))
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: 0)
                if c.delayed > 0 {
                    Button {
                        withAnimation(ObMotion.standard) {
                            if open { expanded.remove(c.taskId) } else { expanded.insert(c.taskId) }
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Text("함께 \(c.delayed)개")
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .bold))
                                .rotationEffect(.degrees(open ? 180 : 0))
                        }
                        .font(ObFont.caption.weight(.medium))
                        .foregroundStyle(Ob.warnText)
                        .padding(.horizontal, 7)
                        .frame(height: 22)
                        .background(Ob.warnSoft, in: RoundedRectangle(cornerRadius: ObRadius.xs))
                        .frame(minHeight: ObSize.row - 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(JevPressStyle())
                    .accessibilityLabel("함께 밀리는 작업 \(c.delayed)개")
                    .accessibilityHint(open ? "접기" : "무엇이 밀리는지 보기")
                } else {
                    Text("영향 없음")
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                }
            }
        } else if c.verdict == .fixed {
            Text("고정 일정")
                .font(ObFont.caption)
                .foregroundStyle(Ob.text3)
        }
    }

    // MARK: actions


    private func run() async {
        seq += 1
        let mine = seq
        loading = true
        error = nil
        do {
            let pl = try await JevCenter.shared.fetchPostponePlan(scope, capacity: capacity)
            guard mine == seq else { return }
            withAnimation(ObMotion.standard) {
                plan = pl
                picked = Set(pl.candidates.filter { $0.verdict == .postpone }.map(\.taskId))
                expanded = []
            }
        } catch is CancellationError {
            return
        } catch {
            if let e = error as? APIError, e.isUnauthorized {
                store.report(error)
                return
            }
            if mine == seq { self.error = jevMessage(error) }
        }
        if mine == seq { loading = false }
    }

    private func apply() async {
        guard let plan else { return }
        busy = true
        let n = await JevCenter.shared.applyPostpone(store, plan.candidates.filter { picked.contains($0.taskId) && $0.toDate != nil })
        busy = false
        if n > 0 { dismiss() }
    }
}

// MARK: - load

/// Today: one meter (before / after the picks, with the capacity line). This week: seven small bars.
struct JevLoadBars: View {
    var plan: PostponePlan
    var after: [ISODate: Int]

    var body: some View {
        Group {
            if plan.scope == .today, let d = plan.days.first {
                meter(d)
            } else {
                week
            }
        }
        .padding(ObSpace.md)
        .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.lg))
        .animation(ObMotion.slow, value: after)
    }

    private func meter(_ d: PostponeDayLoad) -> some View {
        let now = after[d.date] ?? d.after
        let maxN = Double(max(plan.capacity + 2, d.load))
        let over = now > plan.capacity
        return VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("오늘")
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text2)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if d.load != now {
                        Text("\(d.load)개")
                            .strikethrough()
                            .foregroundStyle(Ob.text3)
                            .fontWeight(.regular)
                        Image(systemName: "arrow.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Ob.text3)
                    }
                    Text("\(now)개")
                        .foregroundStyle(over ? Ob.warnText : Ob.text)
                }
                .font(ObFont.title3.monospacedDigit())
                Spacer(minLength: ObSpace.sm)
                Text("하루 \(plan.capacity)개 기준\(d.load > plan.capacity ? " · \(d.load - plan.capacity)개 넘침" : "")")
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
                    .multilineTextAlignment(.trailing)
            }
            .accessibilityElement(children: .combine)

            GeometryReader { g in
                let w = g.size.width
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: ObRadius.xs).fill(Ob.surface3)
                    RoundedRectangle(cornerRadius: ObRadius.xs)
                        .fill(Ob.warn.opacity(0.22))
                        .frame(width: w * min(1, Double(d.load) / maxN))
                    RoundedRectangle(cornerRadius: ObRadius.xs)
                        .fill(over ? Ob.warn : Ob.text2)
                        .frame(width: w * min(1, Double(now) / maxN))
                    Capsule()
                        .fill(Ob.text)
                        .frame(width: 2, height: 16)
                        .offset(x: w * min(1, Double(plan.capacity) / maxN) - 1)
                }
            }
            .frame(height: 8)
            .accessibilityHidden(true)
        }
    }

    private var week: some View {
        let maxN = Double(max(plan.capacity + 1, plan.days.map(\.load).max() ?? 0))
        return HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(plan.days.enumerated()), id: \.element.date) { i, d in
                let now = after[d.date] ?? d.after
                let over = now > plan.capacity
                VStack(spacing: 6) {
                    ZStack(alignment: .bottom) {
                        RoundedRectangle(cornerRadius: ObRadius.xs).fill(Ob.surface2)
                        RoundedRectangle(cornerRadius: ObRadius.xs)
                            .fill(d.load > plan.capacity ? Ob.warn.opacity(0.22) : Ob.surface3)
                            .frame(height: 64 * Double(d.load) / maxN)
                        RoundedRectangle(cornerRadius: ObRadius.xs)
                            .fill(over ? Ob.warn : Ob.text2)
                            .frame(height: 64 * Double(now) / maxN)
                    }
                    .frame(width: 18, height: 64)
                    .overlay(alignment: .bottom) {
                        Capsule()
                            .fill(Ob.text)
                            .frame(width: 26, height: 2)
                            .offset(y: -64 * Double(plan.capacity) / maxN + 1)
                    }
                    VStack(spacing: 1) {
                        Text(i == 0 ? "오늘" : WEEKDAYS_KO[weekday(d.date)])
                            .font(ObFont.micro)
                            .foregroundStyle(i == 0 ? Ob.text2 : Ob.text3)
                        Text(i == 0 ? " " : String(formatShortKo(d.date).prefix { $0 != " " }))
                            .font(ObFont.micro.monospacedDigit())
                            .foregroundStyle(Ob.text3)
                        HStack(spacing: 1) {
                            if d.load != now {
                                Text("\(d.load)").strikethrough().foregroundStyle(Ob.text3).fontWeight(.regular)
                                Text("→").foregroundStyle(Ob.text3)
                            }
                            Text("\(now)").foregroundStyle(over ? Ob.warnText : Ob.text)
                        }
                        .font(ObFont.caption.weight(.medium).monospacedDigit())
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    }
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(i == 0 ? "오늘" : formatShortKo(d.date)) \(d.load != now ? "\(d.load)개에서 \(now)개" : "\(now)개")\(over ? ", 하루 \(plan.capacity)개 넘음" : "")")
            }
        }
    }
}

// MARK: - not connected

/// The sheet opened without a working key: say why and lead to 설정 › Jev.
struct JevConnectPrompt: View {
    var jev: JevStatus?
    @Environment(Router.self) private var router

    var body: some View {
        let unreadable = jev?.keyUnreadable == true
        VStack(spacing: ObSpace.md) {
            JevMark(size: 26)
                .padding(.bottom, ObSpace.xs)
            Text(unreadable ? "Jev 키를 다시 입력해 주세요" : "Jev가 연결되어 있지 않아요")
                .font(ObFont.bodyStrong)
                .foregroundStyle(Ob.text)
                .multilineTextAlignment(.center)
            Text(unreadable
                ? "저장된 키\(jev?.hint.map { "(…\($0))" } ?? "")를 이 서버의 암호화 키로 열 수 없어요."
                : "Jev를 연결하면 우선순위를 정해 주고, 일이 몰리는 날엔 미뤄도 되는 일을 골라 드려요.")
                .font(ObFont.sub)
                .foregroundStyle(Ob.text3)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                router.dismissSheet()
                router.openSettings(.jev)
            } label: {
                HStack(spacing: 6) {
                    Text(unreadable ? "키 다시 입력" : "Jev 설정 열기")
                    Image(systemName: "arrow.right").font(.system(size: 13, weight: .semibold))
                }
            }
            .buttonStyle(.ob(.outline))
            .padding(.top, ObSpace.sm)
        }
        .padding(.horizontal, ObSpace.xxxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.bottom, 60)
    }
}
