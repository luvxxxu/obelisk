import SwiftUI

/// 새 작업: the web's quick-add dialog (QuickAddModal: one natural-language line with its parsed chips,
/// Jev's suggestions and the syntax help) plus every field the API takes: status, priority, start and
/// due (with times), project, assignee (organizations), fixed, notes and 먼저 끝나야 하는 작업.
///
/// Words recognised in the title fill the fields (they win while they're there); setting a field by hand
/// takes the matching words out of the title. Tap a chip to keep its words as plain title text.
struct NewTaskSheet: View {
    var prefill: NewTask
    /// Token kinds already cancelled in the composer.
    var disabledKinds: [QuickAddKind] = []
    /// Called once the task exists (the composer clears its line).
    var onCreated: ((TaskItem) -> Void)?

    init(prefill: NewTask, disabled: [QuickAddKind] = [], onCreated: ((TaskItem) -> Void)? = nil) {
        self.prefill = prefill
        self.disabledKinds = disabled
        self.onCreated = onCreated
    }

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var disabled: [QuickAddKind] = []
    @State private var notes = ""
    @State private var status: TaskStatus = .todo
    @State private var priority: Priority = 0
    @State private var projectId: String?
    @State private var startDate: ISODate?
    @State private var startTime: ISOTime?
    @State private var dueDate: ISODate?
    @State private var dueTime: ISOTime?
    @State private var fixed = false
    @State private var estimate: Int?
    @State private var customEstimate = false
    @State private var assigneeIds: [String] = []
    @State private var blockedBy: [String] = []
    @State private var busy = false
    @State private var ready = false
    @State private var datePick: ComposeDateField?
    @State private var jev = ComposeJevState()
    @State private var path = NavigationPath()
    @FocusState private var focus: ComposeFormFocus?

    var body: some View {
        let parsed = parseQuickAdd(text, store.today, disabled: disabled, nowMinutes: ComposeParse.nowMinutes(store))
        let matched = parsed.projectName.flatMap { matchProject(store.openProjects, $0) }
        let span = effectiveSpan(parsed)
        let canAdd = !parsed.title.composeTrimmed.isEmpty && spanError(span) == nil && !busy

        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(description)
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, ObSpace.md)

                    titleField(parsed)
                    chipsAndJev(parsed, matched: matched, span: span)

                    properties(parsed, matched: matched, span: span)
                        .padding(.top, ObSpace.xl)
                    if let error = spanError(span) {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.dangerText)
                            .padding(.top, ObSpace.sm)
                            .padding(.horizontal, ObSpace.xs)
                    }

                    notesField
                        .padding(.top, ObSpace.xxl)
                    blockersSection
                        .padding(.top, ObSpace.xxl)

                    VStack(alignment: .leading, spacing: 0) {
                        Hairline()
                        ComposeSyntaxHelp(chipsAbove: false)
                            .padding(.top, 14)
                    }
                    .padding(.top, ObSpace.xxl)
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.xs)
                .padding(.bottom, ObSpace.xxxl)
                .animation(ObMotion.standard, value: parsed.tokens)
            }
            .scrollDismissesKeyboard(.interactively)
            .obPage()
            .navigationTitle("새 작업")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await submit() }
                    } label: {
                        if busy {
                            ProgressView()
                        } else {
                            Text("추가").fontWeight(.semibold)
                        }
                    }
                    .disabled(!canAdd)
                    .accessibilityLabel("추가")
                }
            }
            .navigationDestination(for: ComposeFormRoute.self) { route in
                switch route {
                case .project:
                    ComposeProjectPicker(selection: parsed.projectName != nil ? matched?.id : projectId) { id in
                        setProject(id)
                    }
                case .assignee:
                    ComposeAssigneePicker(selection: $assigneeIds, projectId: effectiveProject(parsed, matched))
                case .blockers:
                    ComposeBlockerPicker(selection: $blockedBy, projectId: effectiveProject(parsed, matched))
                }
            }
        }
        .sheet(item: $datePick) { field in
            datePicker(field, span: span)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .task(id: triageKey(parsed, matched: matched, span: span)) {
            await jev.run(
                key: triageKey(parsed, matched: matched, span: span),
                title: parsed.title.composeTrimmed,
                startDate: span.startDate,
                dueDate: span.dueDate,
                projectId: .some(effectiveProject(parsed, matched)),
                connected: store.user?.jev.connected ?? false,
                autoApply: store.user?.jev.autoApply ?? false
            )
        }
        .onChange(of: jev.suggestion) { _, s in
            // Auto-apply (opt-in): what Jev is sure about lands in the fields.
            guard let s else { return }
            if jev.accepted.contains(.priority), parsed.priority == nil, priority == 0 { priority = s.priority.value }
            if jev.accepted.contains(.fixed), !parsed.fixed { fixed = true }
        }
        .onAppear(perform: setUp)
    }

    // MARK: - set up

    private var description: String {
        switch router.page {
        case .mine:
            return "여기서 추가한 작업은 내가 담당자로 지정돼요."
        case let .project(id):
            if let p = store.project(id), store.canWriteProject(id) {
                return "#프로젝트를 따로 적지 않으면 ‘\(p.name)’에 추가돼요."
            }
        case .today:
            return "날짜를 적지 않으면 오늘 할 일로 추가돼요."
        default:
            break
        }
        return "자연어로 적으면 날짜 · 프로젝트 · 우선순위를 알아서 읽어요."
    }

    private func setUp() {
        guard !ready else { return }
        ready = true
        text = prefill.title
        disabled = disabledKinds
        notes = prefill.notes
        status = prefill.status ?? .todo
        priority = prefill.priority ?? 0
        // A view-only project can't take new tasks: they go to your inbox instead.
        projectId = prefill.projectId.flatMap { store.canWriteProject($0) && store.project($0) != nil ? $0 : nil }
        startDate = prefill.startDate
        startTime = prefill.startDate == nil ? nil : prefill.startTime
        dueDate = prefill.dueDate
        dueTime = prefill.dueDate == nil ? nil : prefill.dueTime
        fixed = prefill.fixed
        estimate = prefill.estimateMinutes
        assigneeIds = prefill.assigneeIds
        blockedBy = prefill.blockedBy
        // The page's defaults, like the web dialog: 오늘 → due today, 내 작업 → assigned to me.
        if router.page == .today, dueDate == nil, startDate == nil { dueDate = store.today }
        if router.page == .mine, assigneeIds.isEmpty, store.isOrg, let me = store.user?.id { assigneeIds = [me] }
        Task {
            try? await Task.sleep(for: .milliseconds(80))
            focus = .title
        }
    }

    // MARK: - effective values (title words win while they're there)

    private func hasDateToken(_ p: QuickAddResult) -> Bool {
        p.tokens.contains { $0.kind == .date || $0.kind == .time }
    }

    private func effectiveSpan(_ p: QuickAddResult) -> ComposeSpan {
        if hasDateToken(p) {
            return ComposeSpan(startDate: p.startDate, startTime: p.startTime, dueDate: p.dueDate, dueTime: p.dueTime)
        }
        return ComposeSpan(startDate: startDate, startTime: startTime, dueDate: dueDate, dueTime: dueTime)
    }

    private func effectiveProject(_ p: QuickAddResult, _ matched: Project?) -> String? {
        p.projectName != nil ? matched?.id : projectId
    }

    /// The server's own check (schemas.ts spanIssues), shown before it says no.
    private func spanError(_ s: ComposeSpan) -> String? {
        spanIssues(startDate: s.startDate, startTime: s.startTime, dueDate: s.dueDate, dueTime: s.dueTime).first?.message
    }

    /// Take the words of `kinds` out of the title (a field now says it).
    private func absorb(_ kinds: Set<QuickAddKind>) {
        let p = parseQuickAdd(text, store.today, disabled: disabled, nowMinutes: ComposeParse.nowMinutes(store))
        let tokens = p.tokens.filter { kinds.contains($0.kind) }
        guard !tokens.isEmpty else { return }
        if kinds.contains(.date) || kinds.contains(.time), hasDateToken(p) {
            startDate = p.startDate
            startTime = p.startTime
            dueDate = p.dueDate
            dueTime = p.dueTime
        }
        text = ComposeParse.strip(text, tokens)
    }

    private func setProject(_ id: String?) {
        absorb([.project])
        projectId = id
    }

    private func setDates(_ field: ComposeDateField, _ date: ISODate?, _ time: ISOTime?) {
        absorb([.date, .time])
        switch field {
        case .start:
            startDate = date
            startTime = date == nil ? nil : time
            if let d = date, let due = dueDate, d > due { dueDate = d }
        case .due:
            dueDate = date
            dueTime = date == nil ? nil : time
            if let d = date, let s = startDate, s > d { startDate = d }
        }
    }

    // MARK: - title

    private func titleField(_ parsed: QuickAddResult) -> some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(ComposeContext.defaultPlaceholder)
                    .foregroundStyle(Ob.text3)
                    .lineLimit(1)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            TextField("", text: $text, axis: .vertical)
                .lineLimit(1 ... 4)
                .focused($focus, equals: .title)
                .submitLabel(.done)
                .accessibilityLabel("새 작업")
                .onChange(of: text) { old, new in
                    guard new.contains("\n") else { return }
                    // Return adds the task (like ↵ on the web); pasted lines become one.
                    let returned = new.hasSuffix("\n") && String(new.dropLast()) == old
                    text = new.replacingOccurrences(of: "\n", with: returned ? "" : " ")
                    if returned { Task { await submit() } }
                }
        }
        .font(ObFont.body)
        .foregroundStyle(Ob.text)
        .tint(Ob.text)
        .padding(.horizontal, 18)
        .padding(.vertical, 15)
        .frame(minHeight: 52)
        .background(Ob.bg, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(focus == .title ? Ob.text3 : Ob.input, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { focus = .title }
        .animation(ObMotion.fast, value: focus == .title)
    }

    @ViewBuilder
    private func chipsAndJev(_ parsed: QuickAddResult, matched: Project?, span: ComposeSpan) -> some View {
        let chips = ComposeParse.chips(parsed, today: store.today, matched: matched)
        let offers = jevOffers(parsed)
        let live = jev.live(triageKey(parsed, matched: matched, span: span), title: parsed.title.composeTrimmed)
        let typing = !text.composeTrimmed.isEmpty
        if !chips.isEmpty {
            FlowRow(spacing: 6, lineSpacing: 6) {
                ForEach(chips) { c in
                    ComposeChip(chip: c) {
                        Haptics.select()
                        if let k = c.kind { disabled.append(k) }
                    }
                }
            }
            .padding(.top, 10)
            .transition(.opacity)
        }
        if typing, !offers.isEmpty || (jev.asking && live == nil && (store.user?.jev.connected ?? false)) {
            ComposeJevRow(
                offers: offers,
                asking: jev.asking,
                isOn: { jevIsOn($0, parsed) },
                onToggle: { toggleJev($0, parsed) },
                onTakeAll: { for o in offers where !jevIsOn(o.kind, parsed) { toggleJev(o.kind, parsed) } }
            )
            .padding(.top, 8)
            .transition(.opacity)
        }
    }

    // MARK: - Jev

    private func triageKey(_ p: QuickAddResult, matched: Project?, span: ComposeSpan) -> String {
        [p.title.composeTrimmed, span.startDate ?? "-", span.dueDate ?? "-", effectiveProject(p, matched) ?? "inbox"].joined(separator: "|")
    }

    private func jevOffers(_ parsed: QuickAddResult) -> [ComposeJevOffer] {
        let matched = parsed.projectName.flatMap { matchProject(store.openProjects, $0) }
        let span = effectiveSpan(parsed)
        guard let live = jev.live(triageKey(parsed, matched: matched, span: span), title: parsed.title.composeTrimmed) else { return [] }
        var out: [ComposeJevOffer] = []
        // The project is always chosen here (a field), so Jev only weighs priority and fixed.
        if parsed.priority == nil, live.priority.value > 0, priority == 0 || priority == live.priority.value {
            out.append(ComposeJevOffer(kind: .priority, text: "우선순위 \(PriorityInfo.labelKo[live.priority.value] ?? "")", confidence: live.priority.confidence))
        }
        if !parsed.fixed, live.fixed.value {
            out.append(ComposeJevOffer(kind: .fixed, text: "고정 일정", confidence: live.fixed.probability))
        }
        return out
    }

    private func jevIsOn(_ k: ComposeJevKind, _ parsed: QuickAddResult) -> Bool {
        guard let s = jev.suggestion else { return false }
        switch k {
        case .priority: return priority != 0 && priority == s.priority.value
        case .fixed: return fixed
        case .project: return false
        }
    }

    private func toggleJev(_ k: ComposeJevKind, _ parsed: QuickAddResult) {
        guard let s = jev.suggestion else { return }
        let on = jevIsOn(k, parsed)
        switch k {
        case .priority: priority = on ? 0 : s.priority.value
        case .fixed: fixed = !on
        case .project: break
        }
    }

    // MARK: - properties

    private func properties(_ parsed: QuickAddResult, matched: Project?, span: ComposeSpan) -> some View {
        VStack(spacing: 0) {
            statusRow
            rowDivider
            priorityRow(parsed)
            rowDivider
            dateRow(.start, span: span)
            rowDivider
            dateRow(.due, span: span)
            rowDivider
            NavigationLink(value: ComposeFormRoute.project) {
                ComposeFormRow(symbol: "folder", label: "프로젝트") {
                    projectValue(parsed, matched: matched)
                }
            }
            .buttonStyle(.obRow)
            if store.isOrg {
                rowDivider
                NavigationLink(value: ComposeFormRoute.assignee) {
                    ComposeFormRow(symbol: "person", label: "담당자") {
                        if !assigneeIds.isEmpty {
                            let me = store.user?.id
                            let names = assigneeIds.map { id in
                                let name = store.memberName(id) ?? "전 멤버"
                                return id == me && assigneeIds.count == 1 ? "\(name) (나)" : name
                            }
                            HStack(spacing: 6) {
                                AvatarStack(names: names, size: 22, limit: 3)
                                Text(names.joined(separator: ", ")).foregroundStyle(Ob.text).lineLimit(1)
                            }
                        } else {
                            Text("담당자 지정").foregroundStyle(Ob.text3)
                        }
                    }
                }
                .buttonStyle(.obRow)
            }
            rowDivider
            estimateRow(parsed)
            rowDivider
            fixedRow(parsed)
        }
        .obCard(padding: 0)
    }

    private var rowDivider: some View {
        Hairline().padding(.leading, 50)
    }

    private var statusRow: some View {
        Menu {
            Picker("상태", selection: $status) {
                ForEach(TaskStatus.allCases, id: \.self) { s in
                    Label(s.labelKo, systemImage: TaskDetailStatusIcon.symbol(s)).tag(s)
                }
            }
        } label: {
            ComposeFormRow(symbol: "circle.dashed", label: "상태", chevron: "chevron.up.chevron.down") {
                HStack(spacing: 6) {
                    TaskDetailStatusIcon(status: status)
                    Text(status.labelKo).foregroundStyle(Ob.text)
                }
            }
        }
        .tint(Ob.text)
        .accessibilityLabel("상태: \(status.labelKo)")
    }

    private func priorityRow(_ parsed: QuickAddResult) -> some View {
        let value = parsed.priority ?? priority
        return Menu {
            Picker("우선순위", selection: Binding(
                get: { parsed.priority ?? priority },
                set: { v in
                    absorb([.priority])
                    priority = v
                }
            )) {
                ForEach([0, 1, 2, 3], id: \.self) { p in
                    Label(PriorityInfo.labelKo[p] ?? "", systemImage: TaskDetailPriorityIcon.symbol(p)).tag(p)
                }
            }
        } label: {
            ComposeFormRow(symbol: "flag", label: "우선순위", chevron: "chevron.up.chevron.down") {
                HStack(spacing: 6) {
                    TaskDetailPriorityIcon(priority: value)
                    Text(PriorityInfo.labelKo[value] ?? "없음").foregroundStyle(Ob.text)
                }
            }
        }
        .tint(Ob.text)
        .accessibilityLabel("우선순위: \(PriorityInfo.labelKo[value] ?? "없음")")
    }

    private func dateRow(_ field: ComposeDateField, span: ComposeSpan) -> some View {
        let date = field == .start ? span.startDate : span.dueDate
        let time = field == .start ? span.startTime : span.dueTime
        return Button {
            focus = nil
            datePick = field
        } label: {
            ComposeFormRow(symbol: field == .start ? "calendar" : "calendar.badge.clock", label: field.label) {
                if let date {
                    Text(ComposeParse.whenText(date, time, today: store.today))
                        .foregroundStyle(Ob.text)
                        .lineLimit(1)
                } else {
                    Text(field.placeholder).foregroundStyle(Ob.text3)
                }
            }
        }
        .buttonStyle(.obRow)
        .accessibilityLabel("\(field.label): \(date.map { ComposeParse.whenText($0, time, today: store.today) } ?? "없음")")
    }

    @ViewBuilder
    private func projectValue(_ parsed: QuickAddResult, matched: Project?) -> some View {
        if let name = parsed.projectName {
            if let m = matched {
                HStack(spacing: 6) {
                    ProjectSwatch(color: m.color, size: 9)
                    Text(m.name).foregroundStyle(Ob.text).lineLimit(1)
                }
            } else {
                Text("새 프로젝트 “\(name)”").foregroundStyle(Ob.text).lineLimit(1)
            }
        } else if let p = store.project(projectId) {
            HStack(spacing: 6) {
                ProjectSwatch(color: p.color, size: 9)
                Text(p.name).foregroundStyle(Ob.text).lineLimit(1)
            }
        } else {
            HStack(spacing: 6) {
                Image(systemName: "tray").font(.system(size: 13)).foregroundStyle(Ob.text3)
                Text("인박스").foregroundStyle(Ob.text)
            }
        }
    }

    /// 예상 시간: a "~1h" in the title wins until a value is picked here.
    private func estimateRow(_ parsed: QuickAddResult) -> some View {
        let value = parsed.estimateMinutes ?? estimate
        return Menu {
            EstimateMenuItems(current: value) { m in
                absorb([.estimate])
                estimate = m
            } onCustom: {
                customEstimate = true
            }
        } label: {
            ComposeFormRow(symbol: "hourglass", label: "예상 시간", chevron: "chevron.up.chevron.down") {
                Text(value.map(formatDurationKo) ?? "없음")
                    .foregroundStyle(value == nil ? Ob.text3 : Ob.text)
            }
        }
        .tint(Ob.text)
        .sheet(isPresented: $customEstimate) {
            MinutesEditorSheet(title: "예상 시간", initial: value ?? 60) { m in
                absorb([.estimate])
                estimate = m
            }
            .presentationDetents([.medium])
        }
    }

    private func fixedRow(_ parsed: QuickAddResult) -> some View {
        let on = parsed.fixed || fixed
        return Toggle(isOn: Binding(
            get: { parsed.fixed || fixed },
            set: { v in
                if !v { absorb([.fixed]) }
                fixed = v
            }
        )) {
            HStack(spacing: 12) {
                Image(systemName: "pin")
                    .font(.system(size: 15))
                    .foregroundStyle(Ob.text3)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text("고정 일정").font(ObFont.body).foregroundStyle(Ob.text2)
                    Text(on ? "늦어져도 밀리지 않아요" : "회의·출시일처럼 못 옮기는 일정")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                }
            }
        }
        .tint(Ob.primary)
        .padding(.horizontal, ObSpace.lg)
        .padding(.vertical, ObSpace.sm)
        .frame(minHeight: 60)
        .accessibilityHint("회의·출시일처럼 움직일 수 없는 약속. 앞 작업이 늦어져도 밀리지 않고 ‘충돌’로 알려줘요.")
    }

    @ViewBuilder
    private func datePicker(_ field: ComposeDateField, span: ComposeSpan) -> some View {
        DateTimePickerSheet(
            title: field.label,
            date: field == .start ? span.startDate : span.dueDate,
            time: field == .start ? span.startTime : span.dueTime,
            today: store.today,
            minDate: nil
        ) { d, t in
            setDates(field, d, t)
        }
    }

    // MARK: - notes, blockers

    private var notesField: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            Label("메모", systemImage: "text.alignleft")
                .labelStyle(ComposeTightLabelStyle())
                .font(ObFont.footnote.weight(.semibold))
                .foregroundStyle(Ob.text2)
            TextField("메모, 링크, 체크리스트…", text: $notes, axis: .vertical)
                .lineLimit(3 ... 12)
                .focused($focus, equals: .notes)
                .font(ObFont.body)
                .foregroundStyle(Ob.text)
                .tint(Ob.text)
                .padding(.horizontal, ObSpace.md)
                .padding(.vertical, ObSpace.md)
                .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: ObRadius.md)
                        .strokeBorder(focus == .notes ? Ob.text3 : Ob.input, lineWidth: 1)
                )
                .accessibilityLabel("메모")
        }
    }

    private var blockersSection: some View {
        let list = blockedBy.compactMap { store.task($0) }
        return VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(spacing: ObSpace.sm) {
                Label("먼저 끝나야 하는 작업", systemImage: "lock")
                    .labelStyle(ComposeTightLabelStyle())
                    .font(ObFont.footnote.weight(.semibold))
                    .foregroundStyle(Ob.text2)
                if !list.isEmpty {
                    Text("\(list.count)").font(ObFont.footnote.monospacedDigit()).foregroundStyle(Ob.text3)
                }
                Spacer(minLength: 0)
                NavigationLink(value: ComposeFormRoute.blockers) {
                    Label("추가", systemImage: "plus")
                        .labelStyle(ComposeTightLabelStyle())
                }
                .buttonStyle(.ob(.ghost, size: .small))
                .accessibilityLabel("먼저 끝나야 하는 작업 추가")
            }
            if list.isEmpty {
                Text("이 작업을 막고 있는 작업이 없어요")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, ObSpace.md)
                    .padding(.horizontal, ObSpace.md)
                    .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.md))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, t in
                        if i > 0 { Hairline().padding(.leading, 40) }
                        HStack(spacing: 10) {
                            TaskDetailStatusIcon(status: t.status)
                                .frame(width: 20)
                            HStack(spacing: 6) {
                                Text("#\(t.number)").font(ObFont.footnote.monospacedDigit()).foregroundStyle(Ob.text3)
                                Text(t.title).font(ObFont.sub).foregroundStyle(Ob.text).lineLimit(1)
                            }
                            Spacer(minLength: ObSpace.sm)
                            if let d = t.dueDate {
                                Text(formatShortKo(d)).font(ObFont.caption.monospacedDigit()).foregroundStyle(Ob.text3)
                            }
                            Button {
                                Haptics.select()
                                blockedBy.removeAll { $0 == t.id }
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Ob.text3)
                                    .frame(width: 36, height: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("연결 해제")
                        }
                        .padding(.leading, ObSpace.md)
                        .padding(.trailing, ObSpace.xs)
                        .frame(minHeight: 44)
                    }
                }
                .obCard(padding: 0, radius: ObRadius.md)
            }
        }
    }

    // MARK: - submit

    private func submit() async {
        let parsed = parseQuickAdd(text, store.today, disabled: disabled, nowMinutes: ComposeParse.nowMinutes(store))
        let title = parsed.title.composeTrimmed
        let span = effectiveSpan(parsed)
        guard !title.isEmpty, !busy, spanError(span) == nil else { return }
        let matched = parsed.projectName.flatMap { matchProject(store.openProjects, $0) }
        if let m = matched, !store.canWriteProject(m.id) {
            store.toasts.error("‘\(m.name)’ 프로젝트는 보기 전용이라 작업을 추가할 수 없어요")
            return
        }
        busy = true
        defer { busy = false }
        var pid = projectId
        if let name = parsed.projectName {
            if let m = matched {
                pid = m.id
            } else if let p = await store.createProject(name: name) {
                pid = p.id
            }
        }
        var input = NewTask(title: title)
        input.notes = notes.composeTrimmed.isEmpty ? "" : notes
        input.status = status == .todo ? nil : status
        input.priority = parsed.priority ?? priority
        input.projectId = pid
        input.startDate = span.startDate
        input.startTime = span.startTime
        input.dueDate = span.dueDate
        input.dueTime = span.dueTime
        input.fixed = parsed.fixed || fixed
        input.estimateMinutes = parsed.estimateMinutes ?? estimate
        input.assigneeIds = store.isOrg ? assigneeIds : []
        input.blockedBy = blockedBy
        guard let created = await store.createTask(input) else { return }
        Haptics.tap()
        onCreated?(created)
        let page = router.page
        dismiss()
        if !ComposeContext.shows(created, on: page, store) {
            store.toasts.show("“\(created.title)” 추가됨", action: .init(label: "보기") { [router] in
                router.openTask(created.id)
            })
        }
    }
}

// MARK: - form pieces

struct ComposeSpan: Hashable {
    var startDate: ISODate?
    var startTime: ISOTime?
    var dueDate: ISODate?
    var dueTime: ISOTime?
}

enum ComposeFormFocus: Hashable {
    case title, notes
}

enum ComposeFormRoute: Hashable {
    case project, assignee, blockers
}

enum ComposeDateField: String, Identifiable {
    case start, due
    var id: String { rawValue }
    var label: String { self == .start ? "시작" : "마감" }
    var placeholder: String { self == .start ? "시작일 설정" : "마감일 설정" }
}

/// One property row, with the task detail screen's metrics: icon · label · value · chevron (min 52pt).
struct ComposeFormRow<Value: View>: View {
    var symbol: String
    var label: String
    var chevron = "chevron.right"
    @ViewBuilder var value: () -> Value

    var body: some View {
        HStack(spacing: ObSpace.sm) {
            HStack(spacing: ObSpace.md) {
                Image(systemName: symbol)
                    .font(.system(size: 15))
                    .foregroundStyle(Ob.text3)
                    .frame(width: 22)
                Text(label)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text2)
                    .lineLimit(1)
            }
            .layoutPriority(1)
            Spacer(minLength: ObSpace.sm)
            value()
                .font(ObFont.body)
            Image(systemName: chevron)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Ob.text3)
        }
        .padding(.horizontal, ObSpace.lg)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

// MARK: - pickers (pushed inside the sheet)

/// 프로젝트: 인박스, writable projects, or 새 프로젝트 “…” (web TaskDetail ProjectPicker).
struct ComposeProjectPicker: View {
    var selection: String?
    var onPick: (String?) -> Void

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var q = ""
    @State private var creating = false

    var body: some View {
        let needle = q.composeTrimmed.lowercased()
        // Tasks can only move into projects you may write to.
        let list = store.openProjects.filter { store.canWriteProject($0.id) && (needle.isEmpty || $0.name.lowercased().contains(needle)) }
        let canCreate = !needle.isEmpty
            && !store.projects.contains { $0.name.lowercased() == needle }
            && (store.workspace?.canCreateProjects ?? true)

        List {
            if needle.isEmpty {
                composePickRow(selected: selection == nil) {
                    Image(systemName: "tray").foregroundStyle(Ob.text2).frame(width: 20)
                    Text("인박스").foregroundStyle(Ob.text)
                } action: {
                    pick(nil)
                }
            }
            if !list.isEmpty {
                Section {
                    ForEach(list) { p in
                        composePickRow(selected: p.id == selection) {
                            ProjectSwatch(color: p.color, size: 10).frame(width: 20)
                            Text(p.name).foregroundStyle(Ob.text).lineLimit(1)
                        } action: {
                            pick(p.id)
                        }
                    }
                } header: {
                    ComposePickerHeader(title: "프로젝트")
                }
            }
            if canCreate {
                Section {
                    composePickRow(selected: false) {
                        if creating {
                            ProgressView().frame(width: 20)
                        } else {
                            Image(systemName: "plus").foregroundStyle(Ob.text2).frame(width: 20)
                        }
                        Text("새 프로젝트 “\(q.composeTrimmed)”").foregroundStyle(Ob.text).lineLimit(1)
                    } action: {
                        guard !creating else { return }
                        creating = true
                        Task {
                            let p = await store.createProject(name: q.composeTrimmed)
                            creating = false
                            if let p { pick(p.id) }
                        }
                    }
                }
            }
        }
        .composePickerList()
        .searchable(text: $q, placement: .navigationBarDrawer(displayMode: .always), prompt: "프로젝트 검색 또는 새로 만들기")
        .navigationTitle("프로젝트")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func pick(_ id: String?) {
        Haptics.select()
        onPick(id)
        dismiss()
    }
}

/// 담당자: members of the organization, those who can't see the project disabled (web AssigneePicker).
/// Several can be picked: a tap adds or removes one and the list stays open.
struct ComposeAssigneePicker: View {
    @Binding var selection: [String]
    var projectId: String?

    @Environment(AppStore.self) private var store
    @State private var q = ""
    @State private var access: ProjectAccessInfo?

    private struct AccessResponse: Codable { var access: ProjectAccessInfo }

    var body: some View {
        let ql = q.composeTrimmed.lowercased()
        let me = store.user?.id
        let list = store.members
            .filter { ql.isEmpty || $0.name.lowercased().contains(ql) || $0.email.lowercased().contains(ql) }
            .sorted { ($0.id == me ? 0 : 1) < ($1.id == me ? 0 : 1) }

        List {
            if ql.isEmpty {
                composePickRow(selected: selection.isEmpty) {
                    Image(systemName: "person.slash").foregroundStyle(Ob.text2).frame(width: 24)
                    Text("담당자 없음").foregroundStyle(Ob.text)
                } action: {
                    Haptics.select()
                    selection = []
                }
            }
            ForEach(list) { m in
                let on = selection.contains(m.id)
                let visible = canSee(m.id)
                let ok = visible && (on || selection.count < ASSIGNEES_MAX)
                composePickRow(selected: on) {
                    Avatar(name: m.name, size: 24)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(m.id == me ? "\(m.name) (나)" : m.name)
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                        Text(visible ? m.email : "프로젝트 권한 없음")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                            .lineLimit(1)
                    }
                } action: {
                    toggle(m.id)
                }
                .disabled(!ok && !on)
                .opacity(ok || on ? 1 : 0.5)
                .accessibilityHint(ok || on ? "" : visible ? "담당자는 \(ASSIGNEES_MAX)명까지 지정할 수 있어요." : "이 프로젝트를 볼 수 없는 멤버예요. 먼저 공유하세요.")
            }
            if list.isEmpty {
                Text("일치하는 멤버가 없어요")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text3)
                    .listRowBackground(Ob.bg)
                    .listRowSeparator(.hidden)
            }
        }
        .composePickerList()
        .searchable(text: $q, placement: .navigationBarDrawer(displayMode: .always), prompt: "이름이나 이메일로 찾기")
        .navigationTitle(selection.count > 1 ? "담당자 \(selection.count)명" : "담당자")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: projectId) {
            // Who can see this task's project: someone who can't can't be its assignee.
            guard let projectId else {
                access = nil
                return
            }
            do {
                let r: AccessResponse = try await API.shared.get("/api/projects/\(projectId)/access")
                access = r.access
            } catch {
                access = nil
            }
        }
    }

    private func canSee(_ id: String) -> Bool {
        guard projectId != nil, let access else { return true }
        return access.effective.contains { $0.userId == id && $0.level != nil }
    }

    private func toggle(_ id: String) {
        Haptics.select()
        if let i = selection.firstIndex(of: id) {
            selection.remove(at: i)
        } else if selection.count < ASSIGNEES_MAX {
            selection.append(id)
        }
    }
}

/// 먼저 끝나야 하는 작업: open tasks, the same project first, search by title or #number.
struct ComposeBlockerPicker: View {
    @Binding var selection: [String]
    var projectId: String?

    @Environment(AppStore.self) private var store
    @State private var q = ""

    var body: some View {
        let needle = q.composeTrimmed.lowercased()
        let number = needle.replacingOccurrences(of: "#", with: "")
        let chosen = selection.compactMap { store.task($0) }
        let candidates = store.activeTasks
            .filter { !selection.contains($0.id) }
            .filter { needle.isEmpty || $0.title.lowercased().contains(needle) || String($0.number) == number }
            .sorted { a, b in
                let pa = a.projectId == projectId ? 0 : 1
                let pb = b.projectId == projectId ? 0 : 1
                return pa != pb ? pa < pb : a.number > b.number
            }
            .prefix(30)

        List {
            if !chosen.isEmpty, needle.isEmpty {
                Section {
                    ForEach(chosen) { t in row(t, selected: true) }
                } header: {
                    ComposePickerHeader(title: "연결됨")
                }
            }
            Section {
                ForEach(Array(candidates)) { t in row(t, selected: false) }
                if candidates.isEmpty {
                    Text("연결할 수 있는 작업이 없어요")
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text3)
                        .listRowBackground(Ob.bg)
                        .listRowSeparator(.hidden)
                }
            } header: {
                if !chosen.isEmpty, needle.isEmpty { ComposePickerHeader(title: "작업") }
            }
        }
        .composePickerList()
        .searchable(text: $q, placement: .navigationBarDrawer(displayMode: .always), prompt: "작업 검색 (제목 또는 #번호)")
        .navigationTitle("먼저 끝나야 하는 작업")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ t: TaskItem, selected: Bool) -> some View {
        composePickRow(selected: selected) {
            Text("#\(t.number)")
                .font(ObFont.footnote.monospacedDigit())
                .foregroundStyle(Ob.text3)
                .frame(minWidth: 28, alignment: .leading)
            Text(t.title)
                .foregroundStyle(Ob.text)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let d = t.dueDate {
                Text(formatRelativeKo(d, store.today))
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .lineLimit(1)
            }
        } action: {
            Haptics.select()
            withAnimation(ObMotion.standard) {
                if selected { selection.removeAll { $0 == t.id } } else { selection.append(t.id) }
            }
        }
    }
}

// MARK: - picker list styling

private struct ComposePickerHeader: View {
    var title: String
    var body: some View {
        Text(title)
            .font(ObFont.footnote.weight(.semibold))
            .foregroundStyle(Ob.text3)
            .textCase(nil)
    }
}

extension View {
    fileprivate func composePickerList() -> some View {
        self
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Ob.bg)
            .environment(\.defaultMinListRowHeight, ObSize.row)
    }
}

/// A tappable picker row with a trailing check when selected.
@ViewBuilder
private func composePickRow<Content: View>(selected: Bool, @ViewBuilder content: () -> Content, action: @escaping () -> Void) -> some View {
    Button(action: action) {
        HStack(spacing: 12) {
            content()
            Spacer(minLength: 0)
            if selected {
                Image(systemName: "checkmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Ob.text)
            }
        }
        .font(ObFont.body)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .listRowInsets(EdgeInsets(top: 0, leading: ObSpace.page, bottom: 0, trailing: ObSpace.page))
    .listRowBackground(Ob.bg)
    .listRowSeparatorTint(Ob.border)
    .listRowSeparator(.hidden, edges: .top)
    .accessibilityAddTraits(selected ? .isSelected : [])
}
