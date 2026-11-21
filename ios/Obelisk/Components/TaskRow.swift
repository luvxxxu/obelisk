import SwiftUI

/// Round task checkbox (web TaskRow Checkbox). Priority tints the ring (높음 red · 보통 amber · 낮음 blue),
/// "doing" shows a half-filled disc, done is filled with the primary colour.
struct TaskCheckbox: View {
    var status: TaskStatus
    var priority: Priority
    var disabled = false
    var size: CGFloat = 22
    var onToggle: () -> Void

    var body: some View {
        let done = status == .done
        let ring = ringColor
        Button {
            onToggle()
        } label: {
            ZStack {
                Circle()
                    .fill(done ? Ob.primary : (priority == 3 ? Ob.dangerSoft : Color.clear))
                Circle()
                    .strokeBorder(done ? Ob.primary : ring, lineWidth: 1.5)
                if status == .doing, !done {
                    Circle()
                        .trim(from: 0, to: 0.5)
                        .rotation(.degrees(90))
                        .fill(ring)
                        .padding(3.5)
                }
                if done {
                    Image(systemName: "checkmark")
                        .font(.system(size: size * 0.48, weight: .bold))
                        .foregroundStyle(Ob.onPrimary)
                        .transition(.opacity)
                }
            }
            .frame(width: size, height: size)
            .padding(11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .animation(ObMotion.standard, value: done)
        .accessibilityLabel(disabled ? "보기 전용" : done ? "완료 취소" : "완료")
    }

    private var ringColor: Color {
        switch priority {
        case 3: Ob.danger
        case 2: Ob.warn
        case 1: Ob.info
        default: status == .doing ? Ob.info : Ob.text4
        }
    }
}

/// One task in a list (web components/TaskRow.tsx): checkbox · title (+ note mark) · meta line
/// (date with tone, 고정, 대기 n, 후속 n, n회 미룸, project, assignee).
/// Tap opens the task; swipe right completes; swipe left postpones (with impact) or moves it to the
/// trash (undo from the toast, ⌘Z or a shake); long-press for the same actions plus the postpone choices.
/// In 선택 모드 (the list's edit mode) a tap picks the row instead, and the checkbox and swipes rest.
struct TaskRow: View {
    var task: TaskItem
    var showProject = true
    /// `.time`: a day group already names the date, so show only the time (if any).
    var showDate: DateDisplay = .full

    enum DateDisplay { case full, time, none }

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.editMode) private var editMode
    @State private var completing = false

    var body: some View {
        let editable = store.canEdit(task)
        let active = task.isActive
        let done = task.status == .done || completing
        let selecting = editMode?.wrappedValue.isEditing == true

        HStack(alignment: .top, spacing: 0) {
            // The list's own circle takes its place while picking: two circles side by side read as one
            // control too many.
            if !selecting {
                TaskCheckbox(
                    status: done ? .done : task.status,
                    priority: task.priority,
                    disabled: !editable,
                    onToggle: complete
                )
                .padding(.leading, -11 + ObSpace.xs)
                .padding(.top, -1)
                .transition(.opacity)
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(task.title)
                        .font(ObFont.body)
                        .foregroundStyle(done || task.status == .canceled ? Ob.text3 : Ob.text)
                        .strikethrough(done || task.status == .canceled, color: Ob.text4)
                        .lineLimit(2)
                    if !task.notes.isEmpty {
                        Image(systemName: "text.alignleft")
                            .font(.system(size: 11))
                            .foregroundStyle(Ob.text4)
                            .accessibilityLabel("메모 있음")
                    }
                }
                meta(active: active)
            }
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(Rectangle())
        // Off while selecting (not removed, so the row keeps its identity): the list's own tap picks.
        .gesture(TapGesture().onEnded { router.openTask(task.id) }, including: selecting ? .subviews : .all)
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: done ? "완료 취소" : "완료") { complete() }
        // Reveal only: a rightward swipe also opens the sidebar from the edge, so it must never complete by itself.
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if editable, !selecting, task.status != .canceled {
                Button {
                    complete()
                } label: {
                    Label(task.status == .done ? "완료 취소" : "완료", systemImage: task.status == .done ? "arrow.uturn.backward" : "checkmark")
                }
                .tint(task.status == .done ? Ob.text3 : Ob.ok)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if editable, !selecting {
                Button(role: .destructive) {
                    Task { await store.trashTasks([task.id]) }
                } label: {
                    Label("삭제", systemImage: "trash")
                }
                if canPostpone {
                    Button {
                        presentPostpone()
                    } label: {
                        Label("미루기", systemImage: "calendar.badge.clock")
                    }
                    .tint(Ob.warn)
                }
            }
        }
        .contextMenu { TaskContextMenu(task: task, presentPostpone: presentPostpone) }
    }

    private var canPostpone: Bool {
        store.canEdit(task) && task.isActive && (task.dueDate != nil || task.startDate != nil)
    }

    @ViewBuilder
    private func meta(active: Bool) -> some View {
        let project = showProject ? store.project(task.projectId) : nil
        let waitingOn = active ? store.blockers(of: task.id).filter(\.isActive).count : 0
        let blocking = active ? store.dependents(of: task.id).filter(\.isActive).count : 0
        let assignee = store.isOrg && task.assigneeId != nil ? (store.memberName(task.assigneeId) ?? "전 멤버") : nil
        let hasTimes = task.dueTime != nil || task.startTime != nil

        let content = { (now: Clock) -> AnyView in
            let tone = dateTone(task, store.today, now)
            let label: String? = switch showDate {
            case .full: spanLabel(task, store.today)
            case .time: timeLabel(task)
            case .none: nil
            }
            let soon = (label != nil && tone != .overdue && now.date == store.today) ? dueSoonLabel(task, now) : nil
            let hasMeta = label != nil || project != nil || assignee != nil || waitingOn > 0 || blocking > 0 || task.fixed || (task.postponedCount > 1 && active)
            guard hasMeta else { return AnyView(EmptyView()) }

            return AnyView(
                FlowRow(spacing: 10) {
                    if let label {
                        HStack(spacing: 3) {
                            if task.fixed { Image(systemName: "pin").font(.system(size: 10)) }
                            Text(tone == .overdue && task.dueDate != nil
                                 ? overdueLabel(task.dueDate!, store.today, task.dueTime, now)
                                 : (soon ?? label))
                        }
                        .font(ObFont.footnote.weight(tone == .overdue || tone == .today || soon != nil ? .medium : .regular))
                        .foregroundStyle(Self.dateColor(tone, imminent: soon != nil))
                    } else if task.fixed {
                        metaItem("pin", "고정")
                    }
                    if waitingOn > 0 { metaItem("lock", "대기 \(waitingOn)") }
                    if blocking > 0 { metaItem("link", "후속 \(blocking)") }
                    if task.postponedCount > 1, active {
                        metaItem("calendar.badge.clock", "\(task.postponedCount)회 미룸", color: Ob.warnText)
                    }
                    if let project {
                        HStack(spacing: 4) {
                            ProjectSwatch(color: project.color, size: 7)
                            Text(project.name).lineLimit(1)
                        }
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                    }
                    if let assignee {
                        HStack(spacing: 4) {
                            Avatar(name: assignee, size: 16)
                            Text(assignee).lineLimit(1)
                        }
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                    }
                }
            )
        }

        // Only rows with a time read the ticking clock ("40분 남음", "10분 지남"), so a list of all-day
        // tasks doesn't re-render on the minute.
        content(hasTimes ? store.now : Clock(date: store.today, minutes: 0))
    }

    private func metaItem(_ symbol: String, _ text: String, color: Color = Ob.text3) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 10))
            Text(text)
        }
        .font(ObFont.footnote)
        .foregroundStyle(color)
    }

    static func dateColor(_ tone: DateTone, imminent: Bool) -> Color {
        if imminent { return Ob.warnText }
        switch tone {
        case .overdue: return Ob.dangerText
        case .today: return Ob.text
        case .soon: return Ob.text2
        case .done: return Ob.text4
        default: return Ob.text3
        }
    }

    private func complete() {
        guard store.canEdit(task) else {
            store.toasts.error(AppStore.readOnlyMessage)
            return
        }
        if task.status == .done {
            Task { await store.toggleDone(task.id) }
            return
        }
        withAnimation(ObMotion.standard) { completing = true }
        Task {
            try? await Task.sleep(for: .milliseconds(380))
            await store.toggleDone(task.id)
            completing = false
        }
    }

    private func presentPostpone() {
        router.present(.init(id: "postpone-\(task.id)", detents: [.medium]) { PostponeMenuSheet(taskId: task.id) })
    }
}

/// Long-press menu for a task (web TaskMenu): 열기 · 완료 · 오늘로 · 미루기 ▸ (each choice with its impact)
/// · 우선순위 ▸ · 프로젝트로 옮기기 ▸ · 복제 · 텍스트로 복사 · 링크 복사 · 선택 · 휴지통으로 옮기기.
/// On a picked row in 선택 모드 it acts on every pick, like a right-click on picked rows on the web.
struct TaskContextMenu: View {
    var task: TaskItem
    var presentPostpone: () -> Void
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let selection = router.selection
        if selection.isActive, selection.ids.contains(task.id), selection.ids.count > 1 {
            let ids = selection.ordered
            Section("작업 \(ids.count)개") {
                TaskBulkMenuItems(ids: ids)
            }
        } else {
            single
        }
    }

    @ViewBuilder
    private var single: some View {
        let editable = store.canEdit(task)
        let selection = router.selection
        Button {
            router.openTask(task.id)
        } label: {
            Label("열기", systemImage: "arrow.up.right")
        }
        if editable {
            Button {
                Task { await store.toggleDone(task.id) }
            } label: {
                Label(task.status == .done ? "완료 취소" : "완료", systemImage: task.status == .done ? "arrow.uturn.backward" : "checkmark.circle")
            }
            if task.isActive, (task.dueDate ?? task.startDate) != store.today {
                Button {
                    Task { await store.moveToToday([task.id]) }
                } label: {
                    Label("오늘로", systemImage: "sun.max")
                }
            }
            if task.isActive, task.dueDate != nil || task.startDate != nil {
                Menu {
                    Section("미루면 어떻게 될까요?") {
                        ForEach(store.postponeOptions(task)) { o in
                            Button {
                                store.requestDateChange(task.id, o.next)
                            } label: {
                                Text(o.label)
                                Text(o.effect)
                            }
                        }
                    }
                    Button {
                        presentPostpone()
                    } label: {
                        Label("날짜 선택…", systemImage: "calendar")
                    }
                } label: {
                    Label("미루기", systemImage: "calendar.badge.clock")
                }
            }
            Menu {
                PriorityItems(ids: [task.id])
            } label: {
                Label("우선순위", systemImage: "flag")
            }
            Menu {
                ProjectMoveItems(ids: [task.id])
            } label: {
                Label("프로젝트로 옮기기", systemImage: "folder")
            }
        }
        Divider()
        if store.canWriteProject(task.projectId) {
            Button {
                Task { await selection.duplicate([task.id], store) }
            } label: {
                Label("복제", systemImage: "plus.square.on.square")
            }
        }
        Button {
            store.copyTasks([task.id])
        } label: {
            Label("텍스트로 복사", systemImage: "doc.on.doc")
        }
        Button {
            store.copyTaskLinks([task.id])
        } label: {
            Label("링크 복사", systemImage: "link")
        }
        // Only where the row sits in a pickable list (not on 홈's cards).
        if !selection.isActive, selection.rows.contains(task.id) {
            Button {
                selection.begin(with: task.id)
            } label: {
                Label("선택", systemImage: "checkmark.circle")
            }
        }
        if editable {
            Divider()
            Button(role: .destructive) {
                selection.trash([task.id], store)
            } label: {
                Label("휴지통으로 옮기기", systemImage: "trash")
            }
        }
    }
}

/// The row menu for several picked tasks: the bar's actions plus 복제 and the copies.
private struct TaskBulkMenuItems: View {
    var ids: [String]
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let allDone = store.sharedValue(ids, { $0.status == .done }) == true
        Button {
            Task { await store.completeTasks(ids) }
        } label: {
            Label(allDone ? "완료 취소" : "완료", systemImage: allDone ? "arrow.uturn.backward" : "checkmark.circle")
        }
        Button {
            Task { await store.moveToToday(ids) }
        } label: {
            Label("오늘로", systemImage: "sun.max")
        }
        Menu {
            BulkPostponeItems(ids: ids)
        } label: {
            Label("미루기", systemImage: "calendar.badge.clock")
        }
        Menu {
            PriorityItems(ids: ids)
        } label: {
            Label("우선순위", systemImage: "flag")
        }
        Menu {
            ProjectMoveItems(ids: ids)
        } label: {
            Label("프로젝트로 옮기기", systemImage: "folder")
        }
        Divider()
        Button {
            Task { await router.selection.duplicate(ids, store) }
        } label: {
            Label("복제", systemImage: "plus.square.on.square")
        }
        Button {
            store.copyTasks(ids)
        } label: {
            Label("텍스트로 복사", systemImage: "doc.on.doc")
        }
        Button {
            store.copyTaskLinks(ids)
        } label: {
            Label("링크 복사", systemImage: "link")
        }
        Divider()
        Button(role: .destructive) {
            router.selection.trash(ids, store)
        } label: {
            Label("휴지통으로 옮기기", systemImage: "trash")
        }
    }
}

/// The swipe-to-postpone sheet: quick choices with what each one does to other work, or a date.
struct PostponeMenuSheet: View {
    var taskId: String
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var picking = false

    var body: some View {
        if let task = store.task(taskId) {
            if picking {
                DateTimePickerSheet(title: "날짜 선택", date: task.dueDate ?? task.startDate, time: nil, today: store.today, allowsTime: false, clearable: false) { d, _ in
                    if let d { store.requestDateChange(task.id, AppStore.spanEndingOn(task, d)) }
                    dismiss()
                }
            } else {
                NavigationStack {
                    List {
                        Section {
                            ForEach(store.postponeOptions(task)) { o in
                                Button {
                                    dismiss()
                                    store.requestDateChange(task.id, o.next)
                                } label: {
                                    HStack {
                                        Label(o.label, systemImage: "calendar.badge.clock")
                                            .foregroundStyle(Ob.text)
                                        Spacer()
                                        Chip(text: o.effect, tone: o.tone, filled: true)
                                    }
                                }
                                .obSettingsRow()
                            }
                        } header: {
                            ObListHeader("미루면 어떻게 될까요?")
                        }
                        Section {
                            Button {
                                withAnimation(ObMotion.standard) { picking = true }
                            } label: {
                                Label("날짜 선택…", systemImage: "calendar")
                                    .foregroundStyle(Ob.text)
                            }
                            .obSettingsRow()
                        }
                    }
                    .obSettingsList()
                    .navigationTitle(task.title)
                    .navigationBarTitleDisplayMode(.inline)
                }
            }
        } else {
            EmptyState("작업을 찾을 수 없어요")
        }
    }
}

/// Wraps its children onto new lines when they don't fit (meta lines, chip rows).
struct FlowRow: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, width: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > maxWidth {
                y += lineHeight + lineSpacing
                x = 0
                lineHeight = 0
            }
            x += s.width + spacing
            width = max(width, x - spacing)
            lineHeight = max(lineHeight, s.height)
        }
        return CGSize(width: min(width, maxWidth), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for v in subviews {
            var s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX {
                y += lineHeight + lineSpacing
                x = bounds.minX
                lineHeight = 0
            }
            s.width = min(s.width, bounds.width)
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            lineHeight = max(lineHeight, s.height)
        }
    }
}
