import SwiftUI

/// The `List` of a task page, with 선택 모드 (web: ⌘A, sweep and ⌘-click picks). In selection mode the
/// list is in edit mode: rows pick instead of open, a two-finger pan (or a drag down the circles) picks
/// a run of rows, and the page's bottom bar acts on the picks. Rows are tagged by their `ForEach` ids.
///
///     SelectableList(rows: overdue.map(\.id) + todays.map(\.id)) {
///         TaskSection("기한 지남", tasks: overdue, tone: .danger)
///         TaskSection(nil, tasks: todays)
///     }
///     .obTaskList()
struct SelectableList<Content: View>: View {
    /// Every row the list shows, top to bottom, leaving out folded groups: what 모두 선택 and ⌘A pick.
    var rows: [String]
    @ViewBuilder var content: () -> Content

    @Environment(Router.self) private var router
    @Environment(AppStore.self) private var store
    @State private var token = UUID()

    var body: some View {
        @Bindable var selection = router.selection
        let editing = selection.isActive
        List(selection: $selection.ids) {
            content()
        }
        // Both ways: a two-finger pan that starts picking turns selection mode on.
        .environment(\.editMode, Binding(
            get: { editing ? .active : .inactive },
            set: { $0.isEditing ? selection.begin() : selection.end() }
        ))
        .onAppear { selection.register(token, rows) }
        .onChange(of: rows) { _, r in selection.register(token, r) }
        .onChange(of: store.workspace?.id) { selection.end() }
        .onDisappear { selection.unregister(token) }
    }
}

extension TaskSelection {
    /// ⌫, the bar's 삭제, the row menu: to the trash at once with an undo toast; a batch of 10 or more
    /// asks first (the shell's dialog reads `pendingTrash`).
    func trash(_ ids: [String], _ store: AppStore) {
        let ok = store.editableOnly(ids).map(\.id)
        guard !ok.isEmpty else { return }
        if ok.count >= Self.confirmTrashAt {
            pendingTrash = ok
            return
        }
        Task { await moveToTrash(ok, store) }
    }

    /// The dialog's 휴지통으로 옮기기.
    func confirmTrash(_ store: AppStore) {
        let ids = pendingTrash
        pendingTrash = []
        guard !ids.isEmpty else { return }
        Task { await moveToTrash(ids, store) }
    }

    /// 복제 (⌘D): the copies are picked when selecting, so the next action takes them (web setPicked).
    func duplicate(_ list: [String], _ store: AppStore) async {
        let made = await store.duplicateTasks(list)
        if isActive, !made.isEmpty { ids = Set(made.map(\.id)) }
    }

    private func moveToTrash(_ list: [String], _ store: AppStore) async {
        let picked = ids
        guard await store.trashTasks(list) else { return }
        // The picks are gone with them: selection mode has nothing left to act on.
        if !picked.isEmpty, picked.isSubset(of: Set(list)) { end() }
    }
}

// MARK: - Bottom bar

/// The bar that takes the composer's place while picking: 완료 · 미루기 · 프로젝트 · 우선순위 · 삭제.
/// Floating chrome on Liquid Glass, like the composer it replaces.
struct SelectionBar: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let selection = router.selection
        let ids = selection.ordered
        let none = ids.isEmpty
        let allDone = !none && store.sharedValue(ids, { $0.status == .done }) == true

        SelectionBarShell {
            SelectionBarItem(title: allDone ? "완료 취소" : "완료", symbol: allDone ? "arrow.uturn.backward" : "checkmark.circle") {
                Task { await store.completeTasks(ids) }
            }
            .disabled(none)

            Menu {
                Button {
                    Task { await store.moveToToday(ids) }
                } label: {
                    Label("오늘로", systemImage: "sun.max")
                }
                BulkPostponeItems(ids: ids)
            } label: {
                SelectionBarLabel(title: "미루기", symbol: "calendar.badge.clock")
            }
            // Menus open upward from the bar and would list bottom-up (the first item last): keep the written order.
            .menuOrder(.fixed)
            .disabled(none)

            Menu {
                ProjectMoveItems(ids: ids)
            } label: {
                SelectionBarLabel(title: "프로젝트", symbol: "folder")
            }
            .menuOrder(.fixed)
            .disabled(none)

            Menu {
                PriorityItems(ids: ids)
            } label: {
                SelectionBarLabel(title: "우선순위", symbol: "flag")
            }
            .menuOrder(.fixed)
            .disabled(none)

            SelectionBarItem(title: "삭제", symbol: "trash", tone: .danger) {
                selection.trash(ids, store)
            }
            .disabled(none)
        }
    }
}

/// The glass capsule the bar's items sit in (shared with 휴지통's 되살리기 · 영구 삭제).
struct SelectionBarShell<Items: View>: View {
    @ViewBuilder var items: () -> Items

    var body: some View {
        HStack(spacing: 0) {
            items()
        }
        .padding(.horizontal, ObSpace.xs)
        .frame(minHeight: ComposerMetrics.height + 8)
        .obGlass(in: Capsule(), interactive: true)
        .padding(.horizontal, ObSpace.md)
        .padding(.top, ObSpace.xs)
        .padding(.bottom, ObSpace.sm)
        .transition(.opacity)
    }
}

/// Icon over a short word, filling an equal share of the bar.
struct SelectionBarLabel: View {
    var title: String
    var symbol: String
    var tone: Tone = .neutral
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        VStack(spacing: 3) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .regular))
            Text(title)
                .font(ObFont.caption)
                .lineLimit(1)
        }
        // Disabled reads like the system's disabled menus next to it (grey, not faded).
        .foregroundStyle(!enabled ? Ob.text3 : tone == .danger ? Ob.dangerText : Ob.text)
        .frame(maxWidth: .infinity, minHeight: ObSize.row)
        .contentShape(Rectangle())
    }
}

struct SelectionBarItem: View {
    var title: String
    var symbol: String
    var tone: Tone = .neutral
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            SelectionBarLabel(title: title, symbol: symbol, tone: tone)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Menu items shared by the bar and the row menu

/// 하루 · 이틀 · 일주일 · 다음 주 월요일 · 날짜 선택… for several tasks at once.
struct BulkPostponeItems: View {
    var ids: [String]
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        Section {
            ForEach([AppStore.Postpone.days(1), .days(2), .days(7), .nextMonday], id: \.self) { choice in
                Button(choice.label) { Task { await store.postponeTasks(ids, choice) } }
            }
        }
        Button {
            let today = store.today
            router.present(.init(id: "selection-date", detents: [.large]) {
                DateTimePickerSheet(title: "날짜 선택", date: nil, time: nil, today: today, allowsTime: false, clearable: false) { d, _ in
                    guard let d else { return }
                    Task { await store.scheduleTasks(ids, on: d) }
                }
            })
        } label: {
            Label("날짜 선택…", systemImage: "calendar")
        }
    }
}

/// 인박스 + every project you can write to, the shared one checked.
struct ProjectMoveItems: View {
    var ids: [String]
    @Environment(AppStore.self) private var store

    var body: some View {
        let current = store.sharedValue(ids, { $0.projectId })
        Button {
            Task { await store.moveToProject(ids, nil) }
        } label: {
            MenuCheckLabel(title: "인박스", checked: current == .some(nil), symbol: "tray")
        }
        let writable = store.openProjects.filter { store.canWriteProject($0.id) }
        if !writable.isEmpty {
            Divider()
            ForEach(writable) { p in
                Button {
                    Task { await store.moveToProject(ids, p.id) }
                } label: {
                    MenuCheckLabel(title: p.name, checked: current == .some(p.id), symbol: "folder")
                }
            }
        }
    }
}

/// 높음 · 보통 · 낮음 · 없음 (the web's keys 1–4), the shared one checked.
struct PriorityItems: View {
    var ids: [String]
    @Environment(AppStore.self) private var store

    var body: some View {
        let current = store.sharedValue(ids, { $0.priority })
        ForEach([3, 2, 1, 0], id: \.self) { p in
            Button {
                Task { await store.setPriority(ids, p) }
            } label: {
                MenuCheckLabel(title: PriorityInfo.labelKo[p] ?? "", checked: current == p, symbol: nil)
            }
        }
    }
}

/// A menu row with a check on the current value (menus show a label's icon; the check takes its place).
struct MenuCheckLabel: View {
    var title: String
    var checked: Bool
    var symbol: String?

    var body: some View {
        if checked {
            Label(title, systemImage: "checkmark")
        } else if let symbol {
            Label(title, systemImage: symbol)
        } else {
            Text(title)
        }
    }
}
