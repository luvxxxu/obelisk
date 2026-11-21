import SwiftUI
import UIKit

private let TASK_DETAIL_FIXED_HINT = "회의·출시일처럼 움직일 수 없는 약속. 앞 작업이 늦어져도 밀리지 않고 ‘충돌’로 알려줘요."

/// The property card (web .props): 상태 · 우선순위 · 시작 · 마감 · 프로젝트 · 담당자 (organizations) · 고정 일정.
/// Choices are system menus; dates open the date sheet, times the time sheet.
struct TaskDetailProperties: View {
    var task: TaskItem
    var readOnly: Bool
    var open: (TaskDetailSheet) -> Void

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    /// Who can see the task's project: someone who can't can't be its assignee (organizations).
    @State private var access: ProjectAccessInfo?
    @State private var showFixedHint = false
    @State private var creatingProject = false
    @State private var projectName = ""

    private static let iconWidth: CGFloat = 22

    var body: some View {
        VStack(spacing: 0) {
            statusRow
            divider
            priorityRow
            divider
            dateRows
            divider
            projectRow
            if store.isOrg {
                divider
                assigneeRow
            }
            divider
            fixedRow
        }
        .padding(.horizontal, ObSpace.lg)
        .obCard(padding: 0)
        .task(id: store.isOrg ? task.projectId : nil) { await loadAccess() }
        .alert("새 프로젝트", isPresented: $creatingProject) {
            TextField("프로젝트 이름", text: $projectName)
            Button("만들기") { Task { await createProjectAndMove() } }
            Button("취소", role: .cancel) {}
        }
    }

    private var divider: some View {
        Hairline().padding(.leading, Self.iconWidth + ObSpace.md)
    }

    // MARK: row scaffolding

    private func rowLabel(_ icon: String, _ label: String) -> some View {
        HStack(spacing: ObSpace.md) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(Ob.text3)
                .frame(width: Self.iconWidth)
            Text(label)
                .font(ObFont.body)
                .foregroundStyle(Ob.text2)
                .lineLimit(1)
        }
    }

    /// A row whose value opens a menu. Read-only rows show the value as plain text.
    @ViewBuilder
    private func menuRow<Items: View, Value: View>(
        icon: String, label: String, a11y: String,
        @ViewBuilder items: () -> Items, @ViewBuilder value: () -> Value
    ) -> some View {
        let row = HStack(spacing: ObSpace.sm) {
            rowLabel(icon, label)
            Spacer(minLength: ObSpace.sm)
            value()
            if !readOnly {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Ob.text3)
            }
        }
        .frame(minHeight: 52)
        .contentShape(Rectangle())

        if readOnly {
            row.accessibilityElement(children: .combine)
        } else {
            Menu {
                items()
            } label: {
                row
            }
            .tint(Ob.text)
            .accessibilityLabel(a11y)
        }
    }

    // MARK: 상태 · 우선순위

    private var statusRow: some View {
        menuRow(icon: "circle.dashed", label: "상태", a11y: "상태: \(task.status.labelKo)") {
            Picker("상태", selection: Binding(get: { task.status }, set: setStatus)) {
                ForEach(TaskStatus.allCases, id: \.self) { s in
                    Label(s.labelKo, systemImage: TaskDetailStatusIcon.symbol(s)).tag(s)
                }
            }
            .pickerStyle(.inline)
        } value: {
            HStack(spacing: 6) {
                TaskDetailStatusIcon(status: task.status)
                Text(task.status.labelKo)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
            }
        }
    }

    private var priorityRow: some View {
        let label = PriorityInfo.labelKo[task.priority] ?? "없음"
        return menuRow(icon: "flag", label: "우선순위", a11y: "우선순위: \(label)") {
            Picker("우선순위", selection: Binding(get: { task.priority }, set: setPriority)) {
                ForEach([0, 1, 2, 3], id: \.self) { p in
                    Label(PriorityInfo.labelKo[p] ?? "", systemImage: TaskDetailPriorityIcon.symbol(p)).tag(p)
                }
            }
            .pickerStyle(.inline)
        } value: {
            HStack(spacing: 6) {
                TaskDetailPriorityIcon(priority: task.priority)
                Text(label)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
            }
        }
    }

    private func setStatus(_ s: TaskStatus) {
        guard s != task.status else { return }
        var p = TaskPatch()
        p.status = s
        if s == .done { Haptics.success() }
        Task { await store.updateTask(task.id, p) }
    }

    private func setPriority(_ v: Priority) {
        guard v != task.priority else { return }
        var p = TaskPatch()
        p.priority = v
        Task { await store.updateTask(task.id, p) }
    }

    // MARK: 시작 · 마감

    @ViewBuilder
    private var dateRows: some View {
        // A due time makes "overdue" and "due soon" minute-precise, so only then does the card read the
        // ticking clock.
        dateRowsBody(task.dueTime != nil ? store.now : nowIn(store.timezone))
    }

    private func dateRowsBody(_ now: Clock) -> some View {
        let today = store.today
        let dueOverdue = task.isActive && task.dueDate != nil && dateTone(task, today, now) == .overdue
        let dueSoon = task.isActive && !dueOverdue && now.date == today ? dueSoonLabel(task, now) : nil
        let badge: (String, Tone)? = dueOverdue
            ? (overdueLabel(task.dueDate!, today, task.dueTime, now), .danger)
            : dueSoon.map { ($0, .warn) }
        return VStack(spacing: 0) {
            dateRow(
                icon: "calendar", label: "시작", field: "시작일", timeField: "시작 시각", placeholder: "시작일 설정",
                date: task.startDate, time: task.startTime, overdue: false, badge: nil,
                dateSheet: .startDate, timeSheet: .startTime
            )
            divider
            dateRow(
                icon: "calendar.badge.clock", label: "마감", field: "마감일", timeField: "마감 시각", placeholder: "마감일 설정",
                date: task.dueDate, time: task.dueTime, overdue: dueOverdue, badge: badge,
                dateSheet: .dueDate, timeSheet: .dueTime
            )
        }
    }

    private func dateRow(
        icon: String, label: String, field: String, timeField: String, placeholder: String,
        date: ISODate?, time: ISOTime?, overdue: Bool, badge: (String, Tone)?,
        dateSheet: TaskDetailSheet, timeSheet: TaskDetailSheet
    ) -> some View {
        let today = store.today
        let labelView = HStack(spacing: ObSpace.sm) {
            rowLabel(icon, label)
            if let badge {
                Chip(text: badge.0, tone: badge.1, filled: true)
            }
        }
        let dateText = date.map { formatRelativeKo($0, today) }
        let pills = HStack(spacing: 6) {
            TaskDetailPill(
                text: dateText ?? (readOnly ? "없음" : placeholder),
                meta: date.flatMap { Self.dateMeta($0, today) },
                empty: date == nil, overdue: overdue, interactive: !readOnly,
                a11y: "\(field): \(dateText ?? "없음")"
            ) { open(dateSheet) }
            if date != nil, !readOnly || time != nil {
                TaskDetailPill(
                    text: time.map(formatTimeKo) ?? "시간",
                    symbol: time == nil ? "clock" : nil,
                    empty: time == nil, overdue: overdue && time != nil, interactive: !readOnly,
                    a11y: "\(timeField): \(time.map(formatTimeKo) ?? "없음")"
                ) { open(timeSheet) }
            }
        }
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: ObSpace.sm) {
                labelView
                Spacer(minLength: ObSpace.sm)
                pills
            }
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                labelView
                pills.padding(.leading, Self.iconWidth + ObSpace.md - 10)
            }
        }
        .padding(.vertical, ObSpace.xs)
        .frame(minHeight: 52)
    }

    /// A relative label ("금요일") gets the plain date next to it ("11/20"); full dates don't.
    static func dateMeta(_ d: ISODate, _ today: ISODate) -> String? {
        if formatRelativeKo(d, today).contains("월 ") { return nil }
        let p = d.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return "\(p[1])/\(p[2])"
    }

    // MARK: 프로젝트

    private var projectRow: some View {
        let current = store.project(task.projectId)
        let writable = store.openProjects.filter { store.canWriteProject($0.id) }
        return menuRow(icon: "folder", label: "프로젝트", a11y: "프로젝트: \(current?.name ?? "인박스")") {
            Picker("프로젝트", selection: Binding(get: { task.projectId }, set: moveTo)) {
                Label("인박스", systemImage: "tray").tag(String?.none)
                if !writable.isEmpty {
                    Section("프로젝트") {
                        ForEach(writable) { p in
                            Label { Text(p.name) } icon: { TaskDetailDot.image(p.color) }
                                .tag(Optional(p.id))
                        }
                    }
                }
            }
            .pickerStyle(.inline)
            if store.workspace?.canCreateProjects ?? true {
                Button {
                    projectName = ""
                    creatingProject = true
                } label: {
                    Label("새 프로젝트…", systemImage: "plus")
                }
            }
            if let current {
                Divider()
                Button {
                    router.open(.project(current.id))
                } label: {
                    Label("프로젝트 열기", systemImage: "arrow.up.right")
                }
            }
        } value: {
            HStack(spacing: 6) {
                if let current {
                    Circle().fill(current.color.palette.ink).frame(width: 8, height: 8)
                    Text(current.name)
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text)
                        .lineLimit(1)
                } else {
                    Image(systemName: "tray")
                        .font(.system(size: 13))
                        .foregroundStyle(Ob.text3)
                    Text("인박스")
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text)
                }
            }
        }
    }

    private func moveTo(_ projectId: String?) {
        guard projectId != task.projectId else { return }
        var p = TaskPatch()
        p.projectId = .some(projectId)
        Task { await store.updateTask(task.id, p) }
    }

    /// Typing a name that exists moves the task there; otherwise the project is made first (web ProjectPicker).
    private func createProjectAndMove() async {
        let name = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        if let hit = store.openProjects.first(where: { $0.name.lowercased() == name.lowercased() }) {
            if store.canWriteProject(hit.id) { moveTo(hit.id) }
            return
        }
        // The server's default colour for a new project (projects.service.ts), which the store can't omit.
        let palette = ProjectColor.allCases
        let color = palette[(store.projects.count + 6) % palette.count]
        if let p = await store.createProject(name: name, color: color) { moveTo(p.id) }
    }

    // MARK: 담당자 (organizations)

    private var assigneeRow: some View {
        let ids = task.assigneeIds
        let names = store.assigneeNames(task)
        let me = store.user?.id
        let members = store.members.enumerated()
            .sorted { a, b in
                let am = a.element.id == me, bm = b.element.id == me
                return am != bm ? am : a.offset < b.offset
            }
            .map(\.element)
        let full = ids.count >= ASSIGNEES_MAX
        return menuRow(icon: "person", label: "담당자", a11y: "담당자: \(names.isEmpty ? "없음" : names.joined(separator: ", "))") {
            // Several people: each tap adds or removes one, and the list stays open for the next.
            Section {
                ForEach(members) { m in
                    let ok = canSee(m.id)
                    let on = ids.contains(m.id)
                    Toggle(isOn: Binding(get: { on }, set: { _ in toggle(m.id) })) {
                        Text(m.id == me ? "\(m.name) (나)" : m.name)
                        Text(ok ? m.email : "프로젝트 권한 없음")
                    }
                    .disabled(!on && (!ok || full))
                    .menuActionDismissBehavior(.disabled)
                }
                if members.isEmpty {
                    Text("일치하는 멤버가 없어요")
                }
            } header: {
                if ids.count > 1 { Text("\(ids.count)명 지정됨") }
            }
            if !ids.isEmpty {
                Section {
                    Button {
                        setAssignees([])
                    } label: {
                        Label("담당자 없음", systemImage: "xmark")
                    }
                }
            }
        } value: {
            HStack(spacing: 6) {
                if !names.isEmpty {
                    AvatarStack(names: names, size: 22, limit: 3)
                    Text(names.joined(separator: ", "))
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                } else {
                    Text(readOnly ? "없음" : "담당자 지정")
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text3)
                }
            }
        }
    }

    private func canSee(_ userId: String) -> Bool {
        guard task.projectId != nil, let access else { return true }
        return access.effective.contains { $0.userId == userId && $0.level != nil }
    }

    /// Adds or removes one person. Reads the store's copy, not this view's: with the list kept open,
    /// taps can come faster than the row re-renders.
    private func toggle(_ id: String) {
        var ids = (store.task(task.id) ?? task).assigneeIds
        if let i = ids.firstIndex(of: id) {
            ids.remove(at: i)
        } else {
            guard ids.count < ASSIGNEES_MAX else { return }
            ids.append(id)
        }
        setAssignees(ids)
    }

    private func setAssignees(_ ids: [String]) {
        guard ids != (store.task(task.id) ?? task).assigneeIds else { return }
        var p = TaskPatch()
        p.assigneeIds = ids
        Task { await store.updateTask(task.id, p) }
    }

    private func loadAccess() async {
        struct R: Decodable { var access: ProjectAccessInfo }
        guard store.isOrg, let pid = task.projectId else {
            access = nil
            return
        }
        let r: R? = try? await API.shared.get("/api/projects/\(pid)/access")
        access = r?.access
    }

    // MARK: 고정 일정

    private var fixedRow: some View {
        HStack(spacing: ObSpace.md) {
            Image(systemName: "pin")
                .font(.system(size: 15))
                .foregroundStyle(Ob.text3)
                .frame(width: Self.iconWidth)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 2) {
                    Text("고정 일정")
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text2)
                    Button {
                        showFixedHint = true
                    } label: {
                        Image(systemName: "info.circle")
                            .font(.system(size: 13))
                            .foregroundStyle(Ob.text3)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(TASK_DETAIL_FIXED_HINT)
                    .popover(isPresented: $showFixedHint, arrowEdge: .bottom) {
                        Text(TASK_DETAIL_FIXED_HINT)
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(width: 260, alignment: .leading)
                            .padding(ObSpace.md)
                            .presentationCompactAdaptation(.popover)
                    }
                }
                .frame(height: 24)
                Text(task.fixed ? "늦어져도 밀리지 않아요" : "회의·출시일처럼 못 옮기는 일정")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: ObSpace.sm)
            Toggle("고정 일정", isOn: Binding(get: { task.fixed }, set: { v in
                var p = TaskPatch()
                p.fixed = v
                Task { await store.updateTask(task.id, p) }
            }))
            .labelsHidden()
            .tint(Ob.primary)
            .disabled(readOnly)
        }
        .padding(.vertical, ObSpace.sm)
        .frame(minHeight: 60)
    }
}

/// A tappable value inside a property row: faint fill, radius 8 (the web's ghost select trigger).
struct TaskDetailPill: View {
    var text: String
    var meta: String?
    var symbol: String?
    var empty = false
    var overdue = false
    var interactive = true
    var a11y: String
    var action: () -> Void

    var body: some View {
        let ink: Color = overdue ? Ob.dangerText : (empty ? Ob.text3 : Ob.text)
        let content = HStack(spacing: 5) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 12))
            }
            Text(text)
                .font(ObFont.sub.weight(overdue ? .medium : .regular))
                .lineLimit(1)
            if let meta {
                Text(meta)
                    .font(ObFont.caption.monospacedDigit())
                    .foregroundStyle(overdue ? Ob.dangerText.opacity(0.8) : Ob.text3)
            }
        }
        .foregroundStyle(ink)
        .monospacedDigit()

        if interactive {
            Button(action: action) {
                content
                    .padding(.horizontal, 10)
                    .frame(minHeight: 34)
                    .background(Ob.surface2, in: RoundedRectangle(cornerRadius: ObRadius.sm))
                    .padding(.vertical, 5)
                    .contentShape(Rectangle())
            }
            .buttonStyle(TaskDetailPressStyle())
            .accessibilityLabel(a11y)
        } else {
            content
                .frame(minHeight: 34)
                .accessibilityLabel(a11y)
        }
    }
}

/// Pressed = a touch darker, calm (no scale).
struct TaskDetailPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.6 : 1)
            .animation(ObMotion.fast, value: configuration.isPressed)
    }
}

/// Status glyph in its meaning colour: doing = info, done = ok (web StatusIcon).
struct TaskDetailStatusIcon: View {
    var status: TaskStatus
    var size: CGFloat = 15

    static func symbol(_ s: TaskStatus) -> String {
        switch s {
        case .todo: "circle"
        case .doing: "circle.righthalf.filled"
        case .done: "checkmark.circle"
        case .canceled: "xmark.circle"
        }
    }

    static func color(_ s: TaskStatus) -> Color {
        switch s {
        case .todo: Ob.text3
        case .doing: Ob.info
        case .done: Ob.ok
        case .canceled: Ob.text4
        }
    }

    var body: some View {
        Image(systemName: Self.symbol(status))
            .font(.system(size: size))
            .foregroundStyle(Self.color(status))
            .accessibilityLabel(status.labelKo)
    }
}

/// Priority flag in the priority's ink; none is a quiet dash (web PriorityIcon).
struct TaskDetailPriorityIcon: View {
    var priority: Priority

    static func symbol(_ p: Priority) -> String { p == 0 ? "minus" : "flag" }

    static func color(_ p: Priority) -> Color {
        switch p {
        case 1: Ob.info
        case 2: Ob.warn
        case 3: Ob.danger
        default: Ob.text3
        }
    }

    var body: some View {
        Image(systemName: Self.symbol(priority))
            .font(.system(size: 13, weight: priority == 0 ? .semibold : .regular))
            .foregroundStyle(Self.color(priority))
            .accessibilityHidden(true)
    }
}

/// Coloured project swatches for system menus, which draw template images in one ink.
enum TaskDetailDot {
    static func image(_ color: ProjectColor) -> Image {
        let config = UIImage.SymbolConfiguration(pointSize: 10, weight: .regular)
        guard let img = UIImage(systemName: "circle.fill", withConfiguration: config)?
            .withTintColor(UIColor(color.palette.ink), renderingMode: .alwaysOriginal)
        else { return Image(systemName: "circle.fill") }
        return Image(uiImage: img)
    }
}

/// A time of day (web TimePickerPanel): wheel, "시간 지우기", and for a same-day due the length from the start.
struct TaskDetailTimeSheet: View {
    var title: String
    var value: ISOTime?
    /// Same-day start time: earlier times are off and the length shows.
    var min: ISOTime?
    var onPick: (ISOTime?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var picked = Date()

    var body: some View {
        NavigationStack {
            VStack(spacing: ObSpace.md) {
                DatePicker("시각", selection: $picked, in: range, displayedComponents: .hourAndMinute)
                    .datePickerStyle(.wheel)
                    .labelsHidden()
                    .environment(\.locale, Locale(identifier: "ko_KR"))
                    .frame(maxWidth: .infinity)
                if let min {
                    let len = toMinutes(DayMath.isoTime(picked)) - toMinutes(min)
                    Text(len <= 0 ? "시작 \(formatTimeKo(min))" : "시작 \(formatTimeKo(min)) · \(formatDurationKo(len))")
                        .font(ObFont.footnote.monospacedDigit())
                        .foregroundStyle(Ob.text3)
                }
                Spacer(minLength: 0)
                if value != nil {
                    Button {
                        onPick(nil)
                        dismiss()
                    } label: {
                        Label("시간 지우기", systemImage: "xmark")
                    }
                    .buttonStyle(.ob(.dangerGhost))
                }
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.bottom, ObSpace.lg)
            .obPage()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("설정") {
                        onPick(DayMath.isoTime(picked))
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
        .onAppear {
            picked = DayMath.time(from: value ?? suggested) ?? .now
        }
    }

    /// Just after the start time, else the coming hour (web suggestedTime).
    private var suggested: ISOTime {
        if let min { return fromMinutes(Swift.min(DAY_MINUTES - 1, toMinutes(min) + 60)) }
        let now = nowIn(TimeZone.current)
        return fromMinutes(Swift.min(DAY_MINUTES - 30, Int((Double(now.minutes) / 60).rounded(.up)) * 60))
    }

    private var range: ClosedRange<Date> {
        let lo = DayMath.time(from: min ?? "00:00") ?? .distantPast
        let hi = DayMath.time(from: "23:59") ?? .distantFuture
        return lo ... Swift.max(lo, hi)
    }
}
