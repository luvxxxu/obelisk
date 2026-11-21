import SwiftUI
import UIKit

/// Task detail (web components/TaskDetail.tsx). The web shows it as a side panel; here it is a pushed
/// screen: title · properties · notes · dependencies · Jev link suggestions · delay preview · activity · meta.
struct TaskDetailScreen: View {
    var taskId: String

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// The task was here at some point (so it disappearing means it was deleted, not that it never existed).
    @State private var seen = false
    /// Only the screen on top pops itself; one further down the stack shows the empty state instead.
    @State private var visible = false

    var body: some View {
        let task = store.task(taskId)
        Group {
            if let task {
                TaskDetailContent(task: task)
                    .id(task.id)
            } else {
                TaskDetailMissing()
            }
        }
        .onAppear {
            visible = true
            if task != nil { seen = true }
        }
        .onDisappear { visible = false }
        .onChange(of: task == nil) { _, gone in
            if !gone {
                seen = true
            } else if seen, visible {
                dismiss()
            }
        }
    }
}

/// Deleted, or it lives in a workspace that isn't open (web: 작업을 찾을 수 없어요).
struct TaskDetailMissing: View {
    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 22))
                .foregroundStyle(Ob.text3)
                .accessibilityHidden(true)
            EmptyState("작업을 찾을 수 없어요", message: "삭제되었을 수 있어요.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.bottom, 80)
        .obPage()
        .navigationTitle("작업 상세")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// What a sheet on the detail screen is for.
enum TaskDetailSheet: String, Identifiable {
    case startDate, dueDate, startTime, dueTime, postponeDate, addBlocker, addDependent
    var id: String { rawValue }
}

struct TaskDetailContent: View {
    var task: TaskItem

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    enum Field: Hashable { case title, notes }

    @FocusState private var focus: Field?
    @State private var title: String
    @State private var notes: String
    @State private var notesSave: Task<Void, Never>?
    @State private var sheet: TaskDetailSheet?
    /// Runs once the sheet is gone: a date change may need the impact sheet, which can't open over ours.
    @State private var afterSheet: (() -> Void)?
    @State private var confirmDelete = false

    init(task: TaskItem) {
        self.task = task
        _title = State(initialValue: task.title)
        _notes = State(initialValue: task.notes)
    }

    private var readOnly: Bool {
        return !store.canEdit(task)
    }
    private var link: URL { URL(string: "\(Session.server)/t/\(task.id)") ?? URL(string: "https://obelisk.lxvu.dev")! }

    var body: some View {
        ScrollViewReader { _ in
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xxl) {
                    VStack(alignment: .leading, spacing: ObSpace.md) {
                        header
                        if readOnly { readOnlyNote }
                    }
                    VStack(alignment: .leading, spacing: ObSpace.md) {
                        TaskDetailProperties(task: task, readOnly: readOnly) { sheet = $0 }
                        TaskOddsLine(task: task)
                    }
                    TaskTimeSection(task: task, readOnly: readOnly).id("time")
                    notesSection.id("notes")
                    TaskDetailDependencySection(mode: .blockedBy, task: task, readOnly: readOnly) { sheet = .addBlocker }
                        .id("blockers")
                    TaskDetailDependencySection(mode: .blocks, task: task, readOnly: readOnly) { sheet = .addDependent }
                    if task.isActive, !readOnly, store.user?.jev.connected == true {
                        TaskDetailJevLinks(task: task).id("jev")
                    }
                    if task.isActive, task.dueDate != nil || task.startDate != nil, !readOnly {
                        TaskDetailDelaySimulator(task: task).id("delay")
                    }
                    TaskDetailActivity(task: task).id("activity")
                    TaskDetailFooter(task: task).id("footer")
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.xxxl + ObSpace.xxl)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .obPage()
        .navigationTitle("#\(task.number)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .sheet(item: $sheet, onDismiss: runAfterSheet) { s in
            sheetView(s)
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(ObRadius.xl + 8)
                .environment(store)
                .environment(router)
                .environment(store.toasts)
        }
        .confirmationDialog("작업을 삭제할까요?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("삭제", role: .destructive) {
                Task { await store.deleteTask(task.id) }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("“\(task.title)”과(와) 연결된 의존 관계가 모두 삭제돼요. 되돌릴 수 없어요.")
        }
        .onChange(of: task.title) { _, v in
            if focus != .title { title = v }
        }
        .onChange(of: task.notes) { _, v in
            if focus != .notes { notes = v }
        }
        .onChange(of: focus) { old, new in
            if old == .title, new != .title { saveTitle() }
            if old == .notes, new != .notes { saveNotes() }
        }
        .onDisappear {
            saveTitle()
            saveNotes()
        }
    }

    // MARK: title

    private var header: some View {
        HStack(alignment: .top, spacing: ObSpace.xs) {
            TaskCheckbox(status: task.status, priority: task.priority, disabled: readOnly, size: 24) {
                Task { await store.toggleDone(task.id) }
            }
            .padding(.leading, -11)
            .padding(.top, -8)

            Group {
                if readOnly {
                    Text(task.title)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .accessibilityAddTraits(.isHeader)
                } else {
                    TextField("작업 제목", text: $title, axis: .vertical)
                        .accessibilityLabel("작업 제목")
                        .focused($focus, equals: .title)
                        .submitLabel(.done)
                        .onChange(of: title) { _, v in
                            guard v.contains("\n") else { return }
                            // Return commits the title (no line breaks in titles, like the web).
                            var s = v
                            while s.hasSuffix("\n") { s.removeLast() }
                            title = s.replacingOccurrences(of: "\n", with: " ")
                            focus = nil
                        }
                }
            }
            .font(ObFont.title2)
            .foregroundStyle(task.status == .done ? Ob.text3 : Ob.text)
            .strikethrough(task.status == .done, color: Ob.text4)
        }
    }

    private var readOnlyNote: some View {
        HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
            Image(systemName: "eye")
                .foregroundStyle(Ob.text3)
            Text("보기 전용")
                .fontWeight(.semibold)
                .foregroundStyle(Ob.text)
            Text("쓰기 권한이 없어 볼 수만 있어요")
                .foregroundStyle(Ob.text2)
        }
        .font(ObFont.footnote)
        .frame(maxWidth: .infinity, alignment: .leading)
        .obCallout(.neutral)
        .accessibilityElement(children: .combine)
    }

    private func saveTitle() {
        guard let t = store.task(task.id), store.canEdit(t) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            title = t.title
            return
        }
        guard trimmed != t.title else { return }
        var p = TaskPatch()
        p.title = trimmed
        Task { await store.updateTask(t.id, p) }
    }

    // MARK: notes (saved a moment after typing stops, and on leaving the field)

    private var notesSection: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            TaskDetailSectionHead(icon: "text.alignleft", title: "메모")
            if readOnly {
                Text(task.notes.isEmpty ? "메모 없음" : task.notes)
                    .font(ObFont.body)
                    .foregroundStyle(task.notes.isEmpty ? Ob.text3 : Ob.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, ObSpace.md)
                    .padding(.vertical, ObSpace.md)
                    .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.md))
            } else {
                TextField("메모, 링크, 체크리스트…", text: $notes, axis: .vertical)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                    .lineLimit(3...)
                    .focused($focus, equals: .notes)
                    .padding(.horizontal, ObSpace.md)
                    .padding(.vertical, ObSpace.md)
                    .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: ObRadius.md)
                            .strokeBorder(focus == .notes ? Ob.text3 : Ob.input, lineWidth: 1)
                    )
                    .animation(ObMotion.fast, value: focus == .notes)
                    .onChange(of: notes) { _, _ in
                        if focus == .notes { scheduleNotesSave() }
                    }
                    .accessibilityLabel("메모")
            }
        }
    }

    private func scheduleNotesSave() {
        notesSave?.cancel()
        notesSave = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(900))
            guard !Task.isCancelled else { return }
            saveNotes()
        }
    }

    private func saveNotes() {
        notesSave?.cancel()
        guard let t = store.task(task.id), store.canEdit(t), notes != t.notes else { return }
        var p = TaskPatch()
        p.notes = notes
        Task { await store.updateTask(t.id, p) }
    }

    // MARK: toolbar (완료 · 미루기 · 작업 취소 · 링크 복사 · 공유 · 삭제)

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if !readOnly {
                    Section {
                        Button {
                            Task { await store.toggleDone(task.id) }
                        } label: {
                            Label(task.status == .done ? "완료 취소" : "완료",
                                  systemImage: task.status == .done ? "arrow.uturn.backward" : "checkmark.circle")
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
                                    sheet = .postponeDate
                                } label: {
                                    Label("날짜 선택…", systemImage: "calendar")
                                }
                            } label: {
                                Label("미루기", systemImage: "calendar.badge.clock")
                            }
                        }
                        Button {
                            var p = TaskPatch()
                            p.status = task.status == .canceled ? .todo : .canceled
                            Task { await store.updateTask(task.id, p) }
                        } label: {
                            Label(task.status == .canceled ? "취소 해제" : "작업 취소 (보관)", systemImage: "archivebox")
                        }
                    }
                }
                Section {
                    Button {
                        UIPasteboard.general.string = link.absoluteString
                        store.toasts.show("작업 링크를 복사했어요")
                    } label: {
                        Label("링크 복사", systemImage: "link")
                    }
                    ShareLink(item: link, subject: Text(task.title)) {
                        Label("공유", systemImage: "square.and.arrow.up")
                    }
                }
                if !readOnly {
                    Section {
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("삭제", systemImage: "trash")
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .accessibilityLabel("더 보기")
        }
        ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button("완료") { focus = nil }
                .fontWeight(.semibold)
        }
    }

    // MARK: sheets

    @ViewBuilder
    private func sheetView(_ s: TaskDetailSheet) -> some View {
        switch s {
        case .startDate:
            DateTimePickerSheet(title: "시작일", date: task.startDate, time: task.startTime, today: store.today) { d, t in
                afterSheet = { setStart(d, t) }
            }
            .presentationDetents([.large])
        case .dueDate:
            DateTimePickerSheet(title: "마감일", date: task.dueDate, time: task.dueTime, today: store.today) { d, t in
                afterSheet = { setDue(d, t) }
            }
            .presentationDetents([.large])
        case .startTime:
            TaskDetailTimeSheet(title: "시작 시각", value: task.startTime, min: nil) { t in
                afterSheet = { setStartTime(t) }
            }
            .presentationDetents([.height(420), .large])
        case .dueTime:
            let sameDay = task.startDate != nil && task.startDate == task.dueDate
            TaskDetailTimeSheet(title: "마감 시각", value: task.dueTime, min: sameDay ? task.startTime : nil) { t in
                afterSheet = { setDueTime(t) }
            }
            .presentationDetents([.height(420), .large])
        case .postponeDate:
            DateTimePickerSheet(
                title: "날짜 선택", date: task.dueDate ?? task.startDate, time: nil, today: store.today,
                allowsTime: false, clearable: false
            ) { d, _ in
                guard let d else { return }
                let id = task.id
                afterSheet = {
                    guard let t = store.task(id) else { return }
                    store.requestDateChange(id, AppStore.spanEndingOn(t, d))
                }
            }
            .presentationDetents([.large])
        case .addBlocker:
            TaskDetailDependencyPicker(mode: .blockedBy, taskId: task.id)
                .presentationDetents([.medium, .large])
        case .addDependent:
            TaskDetailDependencyPicker(mode: .blocks, taskId: task.id)
                .presentationDetents([.medium, .large])
        }
    }

    private func runAfterSheet() {
        let run = afterSheet
        afterSheet = nil
        run?()
    }

    // MARK: dates (web setStart / setDue / setStartTime / setDueTime; every change goes through requestDateChange)

    /// A later start than the due carries the due along, keeping the length.
    private func setStart(_ d: ISODate?, _ time: ISOTime?) {
        guard let t = store.task(task.id) else { return }
        var due = t.dueDate
        if let d, let dd = due, d > dd {
            let len = t.startDate.map { diffDays(dd, $0) } ?? 0
            due = addDays(d, len)
        }
        var span = TimedSpan(startDate: d, dueDate: due)
        if d != nil { span.startTime = .some(time) }
        store.requestDateChange(t.id, span)
    }

    /// A due before the start pulls the start back to it.
    private func setDue(_ d: ISODate?, _ time: ISOTime?) {
        guard let t = store.task(task.id) else { return }
        var start = t.startDate
        if let d, let s = start, s > d { start = d }
        var span = TimedSpan(startDate: start, dueDate: d)
        if d != nil { span.dueTime = .some(time) }
        store.requestDateChange(t.id, span)
    }

    private func setStartTime(_ time: ISOTime?) {
        guard let t = store.task(task.id) else { return }
        store.requestDateChange(t.id, TimedSpan(startDate: t.startDate, dueDate: t.dueDate, startTime: .some(time)))
    }

    private func setDueTime(_ time: ISOTime?) {
        guard let t = store.task(task.id) else { return }
        store.requestDateChange(t.id, TimedSpan(startDate: t.startDate, dueDate: t.dueDate, dueTime: .some(time)))
    }
}

/// Section title with a quiet icon, an optional count and a trailing action (web .sectionHead).
struct TaskDetailSectionHead<Trailing: View>: View {
    var icon: String
    var title: String
    var count: Int?
    @ViewBuilder var trailing: () -> Trailing

    init(icon: String, title: String, count: Int? = nil, @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.icon = icon
        self.title = title
        self.count = count
        self.trailing = trailing
    }

    var body: some View {
        HStack(spacing: ObSpace.sm) {
            HStack(spacing: ObSpace.sm) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Ob.text3)
                    .frame(width: 16)
                Text(title)
                    .font(ObFont.sub.weight(.semibold))
                    .foregroundStyle(Ob.text)
                if let count, count > 0 {
                    Text("\(count)")
                        .font(ObFont.caption.weight(.medium).monospacedDigit())
                        .foregroundStyle(Ob.text2)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 20, minHeight: 18)
                        .background(Ob.surface2, in: Capsule())
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            trailing()
        }
        .frame(minHeight: 28)
    }
}
