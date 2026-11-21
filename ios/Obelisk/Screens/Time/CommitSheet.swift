import SwiftUI

/// 약속하기 전에 (web CommitDialog): before promising a date, see the safe date (85% and nothing else
/// gets riskier), the earliest date (and what it would push), the natural finish, and the odds for any day
/// on the strip. Then add the work with that date (or set an existing task's due date).
struct CommitSheet: View {
    /// An existing task to date; nil = new work.
    var taskId: String?
    var prefill: NewTask?

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var estimate: Int?
    @State private var projectId: String?
    /// The day being looked at (tap on the strip); nil = the safe date.
    @State private var picked: ISODate?
    @State private var result: CommitResponse?
    @State private var loading = false
    @State private var error: String?
    @State private var ready = false
    @State private var busy = false
    @State private var customEstimate = false
    @FocusState private var titleFocused: Bool

    private var task: TaskItem? { taskId.flatMap { store.task($0) } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    Text("작업을 언제까지 끝낼 수 있는지, 지금 일정과 지금까지의 기록으로 계산해요.")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .fixedSize(horizontal: false, vertical: true)
                    inputs
                    results
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, 120)
            }
            .scrollDismissesKeyboard(.interactively)
            .obPage()
            .navigationTitle("약속하기 전에")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        }
        .onAppear(perform: setUp)
        .task(id: requestKey) {
            guard ready else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await run()
        }
        .sheet(isPresented: $customEstimate) {
            MinutesEditorSheet(title: "예상 시간", initial: estimate ?? 60) { m in estimate = m }
                .presentationDetents([.medium])
        }
    }

    private var requestKey: String {
        [taskId ?? "", title.trimmingCharacters(in: .whitespaces), estimate.map(String.init) ?? "-", projectId ?? "-", picked ?? "-", ready ? "1" : "0"]
            .joined(separator: "|")
    }

    private func setUp() {
        guard !ready else { return }
        if let t = task {
            title = t.title
            estimate = t.estimateMinutes
            projectId = t.projectId
        } else if let p = prefill {
            title = p.title
            estimate = p.estimateMinutes
            projectId = p.projectId
            picked = p.dueDate
        }
        ready = true
        if task == nil, title.isEmpty { titleFocused = true }
    }

    private func run() async {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard taskId != nil || !t.isEmpty || estimate != nil else {
            result = nil
            return
        }
        loading = true
        defer { loading = false }
        var req = AppStore.CommitRequest()
        if let taskId {
            req.taskId = taskId
            if estimate != task?.estimateMinutes { req.estimateMinutes = estimate }
        } else {
            req.title = t
            req.estimateMinutes = estimate
            req.projectId = projectId
        }
        req.date = picked
        do {
            result = try await store.commitOdds(req)
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? LocalizedError)?.errorDescription ?? "계산하지 못했어요"
        }
    }

    // MARK: inputs

    @ViewBuilder
    private var inputs: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            if let t = task {
                HStack(spacing: ObSpace.sm) {
                    Text("#\(t.number)")
                        .font(ObFont.sub.monospacedDigit())
                        .foregroundStyle(Ob.text3)
                    Text(t.title)
                        .font(ObFont.title3)
                        .foregroundStyle(Ob.text)
                        .lineLimit(2)
                }
            } else {
                TextField("무엇을 약속하나요? (예: 견적서 보내기)", text: $title)
                    .textFieldStyle(.ob(focused: titleFocused))
                    .focused($titleFocused)
                    .submitLabel(.done)
            }
            VStack(alignment: .leading, spacing: ObSpace.sm) {
                Text("예상 시간")
                    .font(ObFont.footnote.weight(.semibold))
                    .foregroundStyle(Ob.text2)
                FlowRow(spacing: 6, lineSpacing: 6) {
                    ForEach(ESTIMATE_PRESETS, id: \.self) { m in
                        chip(formatDurationKo(m), on: estimate == m) {
                            estimate = estimate == m ? nil : m
                        }
                    }
                    chip(estimate.map { ESTIMATE_PRESETS.contains($0) ? "직접 입력" : formatDurationKo($0) } ?? "직접 입력",
                         on: estimate.map { !ESTIMATE_PRESETS.contains($0) } ?? false) {
                        customEstimate = true
                    }
                }
                if estimate == nil, let r = result, !r.estimated {
                    Text("예상 시간이 없으면 지금까지의 기록으로 \(formatDurationKo(r.minutes))로 봐요.")
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                }
            }
            if task == nil {
                projectMenu
            }
        }
    }

    private func chip(_ text: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.select()
            action()
        } label: {
            Text(text)
                .font(ObFont.footnote.weight(.medium))
                .foregroundStyle(on ? Ob.onPrimary : Ob.text)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(on ? Ob.primary : Ob.bg, in: Capsule())
                .overlay { if !on { Capsule().strokeBorder(Ob.borderStrong, lineWidth: 1) } }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var projectMenu: some View {
        let current = store.project(projectId)
        let writable = store.openProjects.filter { store.canWriteProject($0.id) }
        return Menu {
            Picker("프로젝트", selection: $projectId) {
                Label("인박스", systemImage: "tray").tag(String?.none)
                ForEach(writable) { p in
                    Text(p.name).tag(Optional(p.id))
                }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: ObSpace.sm) {
                Image(systemName: "folder")
                    .foregroundStyle(Ob.text3)
                Text("프로젝트")
                    .foregroundStyle(Ob.text2)
                Spacer(minLength: ObSpace.sm)
                if let current {
                    ProjectSwatch(color: current.color)
                }
                Text(current?.name ?? "인박스")
                    .foregroundStyle(Ob.text)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Ob.text3)
            }
            .font(ObFont.body)
            .padding(.horizontal, ObSpace.md)
            .frame(minHeight: ObSize.controlLg)
            .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.input, lineWidth: 1))
        }
        .tint(Ob.text)
    }

    // MARK: results

    @ViewBuilder
    private var results: some View {
        if let error {
            Text(error)
                .font(ObFont.footnote)
                .foregroundStyle(Ob.dangerText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .obCallout(.danger)
        }
        if let r = result {
            let report = r.report
            VStack(alignment: .leading, spacing: ObSpace.md) {
                option("안전한 날", report.safe, note: "이 날이면 다른 일정이 위험해지지 않아요", emphasis: true)
                if let e = report.earliest, e.date != report.safe?.date {
                    option("가장 빠른 날", e, note: nil, emphasis: false)
                }
                if let p = report.proposed, p.date != report.safe?.date, p.date != report.earliest?.date {
                    option("고른 날", p, note: nil, emphasis: false)
                }
                natural(report)
                strip(report)
            }
            .opacity(loading ? 0.55 : 1)
            .animation(ObMotion.standard, value: loading)
        } else if loading {
            LoadingView(label: "계산하는 중")
        } else if task == nil {
            EmptyState("무엇을 약속할지 적어 주세요", message: "제목이나 예상 시간을 넣으면 바로 계산해요.")
        }
    }

    private func option(_ label: String, _ o: CommitOption?, note: String?, emphasis: Bool) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                Text(label)
                    .font(ObFont.footnote.weight(.semibold))
                    .foregroundStyle(Ob.text2)
                Spacer(minLength: ObSpace.sm)
                if let o {
                    Text(percentKo(o.probability))
                        .font(ObFont.sub.monospacedDigit().weight(.medium))
                        .foregroundStyle(o.probability >= 0.85 ? Ob.okText : Ob.warnText)
                }
            }
            if let o {
                Text("\(formatRelativeKo(o.date, store.today)) · \(formatShortKo(o.date))")
                    .font(emphasis ? ObFont.title2 : ObFont.title3)
                    .foregroundStyle(Ob.text)
                if o.harmed.isEmpty {
                    Text(note ?? "다른 일정에 영향 없음")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("밀리는 일 \(o.harmed.count)개")
                            .font(ObFont.footnote.weight(.semibold))
                            .foregroundStyle(Ob.warnText)
                        ForEach(o.harmed.prefix(6), id: \.taskId) { h in
                            harmRow(h)
                        }
                    }
                }
                Button {
                    Haptics.select()
                    picked = o.date
                } label: {
                    Text(picked == o.date ? "이 날짜를 골랐어요" : "이 날짜로")
                }
                .buttonStyle(.ob(picked == o.date ? .primary : .outline, size: .small))
                .disabled(picked == o.date)
            } else {
                Text("6개월 안에서는 찾지 못했어요")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .obCard()
    }

    private func harmRow(_ h: CommitHarm) -> some View {
        let t = store.task(h.taskId)
        return HStack(spacing: ObSpace.sm) {
            Text(t.map { "#\($0.number)" } ?? "#?")
                .font(ObFont.caption.monospacedDigit())
                .foregroundStyle(Ob.text3)
            Text(t?.title ?? "볼 수 없는 작업")
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text)
                .lineLimit(1)
            Spacer(minLength: ObSpace.sm)
            Text("\(h.kind == "conflict" ? "충돌" : "제때") \(percentKo(h.before)) → \(percentKo(h.after))")
                .font(ObFont.caption.monospacedDigit())
                .foregroundStyle(Ob.warnText)
        }
        .accessibilityElement(children: .combine)
    }

    private func natural(_ r: CommitReport) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
            Text("순서대로 하면")
                .font(ObFont.footnote.weight(.semibold))
                .foregroundStyle(Ob.text2)
            Spacer(minLength: ObSpace.sm)
            Text("50% \(r.natural.p50.map { formatRelativeKo($0, store.today) } ?? "6개월 뒤") · 85% \(r.natural.p85.map { formatRelativeKo($0, store.today) } ?? "6개월 뒤")")
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text2)
        }
        .padding(.horizontal, ObSpace.xs)
    }

    /// One bar per day: height = the chance when promised for that day, a dot when it pushes other work.
    private func strip(_ r: CommitReport) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            Text("날짜별 확률")
                .font(ObFont.footnote.weight(.semibold))
                .foregroundStyle(Ob.text2)
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .bottom, spacing: 6) {
                        ForEach(r.days, id: \.date) { d in
                            dayBar(d, r)
                                .id(d.date)
                        }
                    }
                    .padding(.vertical, ObSpace.xs)
                }
                .onAppear {
                    if let target = picked ?? r.safe?.date { proxy.scrollTo(target, anchor: .center) }
                }
            }
            Text("점이 있는 날은 다른 일이 밀려요")
                .font(ObFont.caption)
                .foregroundStyle(Ob.text3)
        }
    }

    private func dayBar(_ d: CommitDay, _ r: CommitReport) -> some View {
        let selected = d.date == (picked ?? r.safe?.date)
        let good = d.probability >= r.confidence && d.harmed == 0
        return Button {
            Haptics.select()
            picked = d.date
        } label: {
            VStack(spacing: 4) {
                Text(percentKo(d.probability))
                    .font(.system(size: 10).monospacedDigit())
                    .foregroundStyle(selected ? Ob.text : Ob.text3)
                ZStack(alignment: .bottom) {
                    RoundedRectangle(cornerRadius: 4).fill(Ob.surface2)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(selected ? Ob.primary : good ? Ob.ok.opacity(0.75) : Ob.text4)
                        .frame(height: max(3, 72 * d.probability))
                }
                .frame(width: 30, height: 72)
                Circle()
                    .fill(d.harmed > 0 ? Ob.warn : .clear)
                    .frame(width: 5, height: 5)
                Text(dayLabel(d.date))
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(selected ? Ob.text : Ob.text2)
                Text(weekdayKo(d.date))
                    .font(.system(size: 10))
                    .foregroundStyle(Ob.text3)
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 2)
            .background(selected ? Ob.surface2 : .clear, in: RoundedRectangle(cornerRadius: ObRadius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(formatShortKo(d.date)) \(percentKo(d.probability))\(d.harmed > 0 ? ", 밀리는 일 \(d.harmed)개" : "")")
    }

    private func dayLabel(_ date: ISODate) -> String {
        let p = date.split(separator: "-").compactMap { Int($0) }
        return p.count == 3 ? "\(p[1])/\(p[2])" : date
    }

    private func weekdayKo(_ date: ISODate) -> String {
        ["일", "월", "화", "수", "목", "금", "토"][weekday(date)]
    }

    // MARK: footer

    private var chosen: ISODate? { picked ?? result?.report.safe?.date }

    @ViewBuilder
    private var footer: some View {
        if let date = chosen {
            Button {
                Task { await commit(date) }
            } label: {
                HStack(spacing: 6) {
                    if busy { ProgressView().controlSize(.small).tint(Ob.onPrimary) }
                    Text(task == nil ? "\(formatShortKo(date))로 추가" : "마감을 \(formatShortKo(date))로")
                }
            }
            .buttonStyle(.ob(.primary, fullWidth: true))
            .disabled(busy || (task == nil && title.trimmingCharacters(in: .whitespaces).isEmpty))
            .padding(.horizontal, ObSpace.page)
            .padding(.vertical, ObSpace.md)
            .background(Ob.bg.opacity(0.94))
            .overlay(alignment: .top) { Hairline() }
        }
    }

    private func commit(_ date: ISODate) async {
        busy = true
        defer { busy = false }
        if let t = task {
            if estimate != t.estimateMinutes { await store.setEstimate(t.id, estimate) }
            let id = t.id
            dismiss()
            try? await Task.sleep(for: .milliseconds(400))
            guard let cur = store.task(id) else { return }
            store.requestDateChange(id, AppStore.spanEndingOn(cur, date))
            return
        }
        var input = prefill ?? NewTask(title: "")
        input.title = title.trimmingCharacters(in: .whitespaces)
        input.estimateMinutes = estimate
        input.projectId = projectId
        input.dueDate = date
        input.dueTime = nil
        guard let created = await store.createTask(input) else { return }
        store.odds = nil
        Haptics.success()
        dismiss()
        store.toasts.show("“\(created.title)” \(formatShortKo(date))까지로 추가됨", action: .init(label: "보기") { [router] in
            router.openTask(created.id)
        })
    }
}
