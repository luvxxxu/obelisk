import SwiftUI

/// 휴지통 (web app/(app)/trash/page.tsx): deleted tasks wait here for 30 days, grouped by the day they
/// were deleted. Swipe right to restore, left to delete for good, tap a row for both; in 선택 모드 the
/// bottom bar does either for every picked row. The list comes from the server (the store only holds
/// live tasks) and reloads whenever the store touches the trash.
struct TrashScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    /// nil until the first answer.
    @State private var items: [TrashItem]?
    @State private var failed = false
    /// The workspace `items` belong to (a switch shows the spinner, not the last space's trash).
    @State private var loadedFor: String?
    /// The row whose tap menu (되살리기 · 영구 삭제) is up.
    @State private var acting: TrashItem?
    /// Waiting on 영구 삭제 in the confirm dialog.
    @State private var purging: [TrashItem] = []
    @State private var confirmEmpty = false

    struct Day: Identifiable {
        var id: ISODate { date }
        var date: ISODate
        var items: [TrashItem]
    }

    var body: some View {
        let restorable = (items ?? []).filter(\.canRestore)
        let selection = router.selection

        SelectableList(rows: restorable.map(\.id)) {
            ListsHeader(
                "휴지통",
                description: "지운 작업은 \(TRASH_DAYS)일 동안 여기 있다가 자동으로 영구 삭제돼요.",
                actions: {
                    // While picking, the bottom bar is where the actions are.
                    if !restorable.isEmpty, !selection.isActive {
                        Button {
                            confirmEmpty = true
                        } label: {
                            ListsButtonLabel(title: "비우기", symbol: "trash")
                        }
                        .buttonStyle(.ob(.outline, size: .small))
                        .accessibilityLabel("휴지통 비우기")
                    }
                }
            )
            .listsPlainRow()

            if let items {
                ForEach(days(items)) { d in
                    let rel = formatRelativeKo(d.date, store.today)
                    Section {
                        ForEach(d.items) { item in
                            row(item)
                        }
                    } header: {
                        ListsDayHeader(
                            title: rel,
                            date: ListsText.namesDate(rel) ? nil : formatShortKo(d.date),
                            count: d.items.count
                        )
                    }
                }
                if items.isEmpty {
                    EmptyState("휴지통이 비어 있어요", message: "지운 작업은 여기서 \(TRASH_DAYS)일 동안 되살릴 수 있어요.")
                        .listsPlainRow()
                }
            } else if failed {
                EmptyState("휴지통을 불러오지 못했어요") {
                    Button("다시 시도") { Task { await load() } }
                        .buttonStyle(.ob(.outline, size: .small))
                }
                .listsPlainRow()
            } else {
                LoadingView().listsPlainRow()
            }
        }
        .obTaskList()
        .refreshable { await load() }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if selection.isActive { bar(selection.ordered) }
        }
        // First load, a workspace switch, and every trash change made here (a delete's undo, a restore).
        .task(id: "\(store.workspace?.id ?? "")#\(store.trashRevision)") { await load() }
        .confirmationDialog(
            acting?.task.title ?? "",
            isPresented: Binding(get: { acting != nil }, set: { if !$0 { acting = nil } }),
            titleVisibility: .visible,
            presenting: acting
        ) { item in
            Button("되살리기") { Task { await restore([item.id]) } }
            // This sheet is the confirmation: a second dialog can't open while it is closing.
            Button("영구 삭제", role: .destructive) { Task { await purge([item.id]) } }
            Button("취소", role: .cancel) {}
        } message: { item in
            Text("\(purgeLabel(item)) · 영구 삭제하면 되살릴 수 없어요.")
        }
        .confirmationDialog(
            purging.count == 1 ? "영구 삭제할까요?" : "작업 \(purging.count)개를 영구 삭제할까요?",
            isPresented: Binding(get: { !purging.isEmpty }, set: { if !$0 { purging = [] } }),
            titleVisibility: .visible
        ) {
            let ids = purging.map(\.id)
            Button("영구 삭제", role: .destructive) { Task { await purge(ids) } }
            Button("취소", role: .cancel) {}
        } message: {
            Text(purging.count == 1 ? "“\(purging[0].task.title)”을(를) 영구 삭제하면 되살릴 수 없어요." : "영구 삭제한 작업은 되살릴 수 없어요.")
        }
        .confirmationDialog("휴지통을 비울까요?", isPresented: $confirmEmpty, titleVisibility: .visible) {
            Button("휴지통 비우기", role: .destructive) { Task { await empty() } }
            Button("취소", role: .cancel) {}
        } message: {
            let kept = (items?.count ?? 0) - restorable.count
            Text("작업 \(restorable.count)개를 영구 삭제해요. 되살릴 수 없어요." + (kept > 0 ? " 권한이 없는 \(kept)개는 남아요." : ""))
        }
    }

    // MARK: rows

    /// 되살리기 · 영구 삭제 for the picked rows (영구 삭제 asks first, through the same dialog as a row).
    private func bar(_ ids: [String]) -> some View {
        SelectionBarShell {
            SelectionBarItem(title: "되살리기", symbol: "arrow.uturn.backward") {
                Task { await restore(ids) }
            }
            .disabled(ids.isEmpty)
            SelectionBarItem(title: "영구 삭제", symbol: "trash", tone: .danger) {
                let picked = Set(ids)
                purging = (items ?? []).filter { picked.contains($0.id) }
            }
            .disabled(ids.isEmpty)
        }
    }

    private func row(_ item: TrashItem) -> some View {
        let selecting = router.selection.isActive
        return TrashRow(item: item)
            // In 선택 모드 a tap picks the row (the list does it); the tap menu waits.
            .gesture(TapGesture().onEnded {
                if item.canRestore { acting = item } else { store.toasts.error("되살릴 권한이 없는 작업이에요") }
            }, including: selecting ? .subviews : .all)
            .selectionDisabled(!item.canRestore)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(named: "되살리기") { Task { await restore([item.id]) } }
            .accessibilityAction(named: "영구 삭제") { purging = [item] }
            // Reveal only: a rightward swipe from the edge also opens the sidebar.
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                if item.canRestore, !selecting {
                    Button {
                        Task { await restore([item.id]) }
                    } label: {
                        Label("되살리기", systemImage: "arrow.uturn.backward")
                    }
                    .tint(Ob.text3)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if item.canRestore, !selecting {
                    // Not `.destructive`: the row stays until the confirm says yes.
                    Button {
                        purging = [item]
                    } label: {
                        Label("영구 삭제", systemImage: "trash")
                    }
                    .tint(Ob.dangerSolid)
                }
            }
            .contextMenu {
                if item.canRestore {
                    Button {
                        Task { await restore([item.id]) }
                    } label: {
                        Label("되살리기", systemImage: "arrow.uturn.backward")
                    }
                    if !selecting {
                        Button {
                            router.selection.begin(with: item.id)
                        } label: {
                            Label("선택", systemImage: "checkmark.circle")
                        }
                    }
                    Divider()
                    Button(role: .destructive) {
                        purging = [item]
                    } label: {
                        Label("영구 삭제…", systemImage: "trash")
                    }
                }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: ObSpace.page, bottom: 0, trailing: ObSpace.page))
            .listRowBackground(Ob.bg)
            .listRowSeparatorTint(Ob.border)
            .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
    }

    private func purgeLabel(_ item: TrashItem) -> String {
        TrashRow.purgeText(item, today: store.today, timezone: store.timezone).text
    }

    /// By the day they were deleted, newest day first (the server already lists newest first).
    private func days(_ items: [TrashItem]) -> [Day] {
        let tz = store.timezone
        var order: [ISODate] = []
        var map: [ISODate: [TrashItem]] = [:]
        for item in items {
            let d = ISO8601DateFormatter.parse(item.deletedAt).map { todayIn(tz, now: $0) } ?? store.today
            if map[d] == nil { order.append(d) }
            map[d, default: []].append(item)
        }
        return order.sorted(by: >).map { Day(date: $0, items: map[$0]!) }
    }

    // MARK: actions (also what a selection bar calls with several ids)

    private func load() async {
        let ws = store.workspace?.id
        if loadedFor != ws {
            items = nil
            failed = false
        }
        guard let list = await store.fetchTrash() else {
            if items == nil { failed = true }
            return
        }
        guard ws == store.workspace?.id else { return }
        items = list
        loadedFor = ws
        failed = false
    }

    /// Back into the lists (undo from the toast moves them back here).
    private func restore(_ ids: [String]) async {
        guard let r = await store.restoreTasks(ids) else { return }
        let gone = Set(r.tasks.map(\.id) + r.missing)
        withAnimation(ObMotion.standard) { items?.removeAll { gone.contains($0.id) } }
        router.selection.end()
    }

    private func purge(_ ids: [String]) async {
        guard await store.purgeTrash(ids) != nil else { return }
        let gone = Set(ids)
        withAnimation(ObMotion.standard) { items?.removeAll { gone.contains($0.id) } }
        router.selection.end()
        store.toasts.show(ids.count == 1 ? "영구 삭제했어요" : "작업 \(ids.count)개를 영구 삭제했어요")
    }

    private func empty() async {
        guard let n = await store.emptyTrash() else { return }
        withAnimation(ObMotion.standard) { items?.removeAll(where: \.canRestore) }
        store.toasts.show(n > 0 ? "휴지통을 비웠어요 · 작업 \(n)개" : "휴지통을 비웠어요")
    }
}

/// One trashed task: title, then #number · where it goes back to · when it goes for good · who deleted it.
struct TrashRow: View {
    var item: TrashItem
    @Environment(AppStore.self) private var store

    var body: some View {
        let t = item.task
        let purge = Self.purgeText(item, today: store.today, timezone: store.timezone)
        VStack(alignment: .leading, spacing: 3) {
            Text(t.title)
                .font(ObFont.body)
                .foregroundStyle(item.canRestore ? Ob.text : Ob.text3)
                .lineLimit(2)
            FlowRow(spacing: 10) {
                Text("#\(t.number)")
                    .font(ObFont.footnote.monospacedDigit())
                    .foregroundStyle(Ob.text3)
                // Where a restore puts it: its project, or the inbox when that project is gone.
                if let p = store.project(t.projectId) {
                    HStack(spacing: 4) {
                        ProjectSwatch(color: p.color, size: 7)
                        Text(p.name).lineLimit(1)
                    }
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                } else {
                    meta("tray", "인박스")
                }
                Text(purge.text)
                    .font(ObFont.footnote)
                    .foregroundStyle(purge.soon ? Ob.warnText : Ob.text3)
                if store.isOrg, let who = deleter {
                    Text(who)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .lineLimit(1)
                }
                if !item.canRestore { meta("eye", "보기 전용") }
            }
        }
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var deleter: String? {
        if let id = item.deletedBy, id == store.user?.id { return "내가 삭제" }
        return item.deletedByName.map { "\($0)님이 삭제" }
    }

    private func meta(_ symbol: String, _ text: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 10))
            Text(text)
        }
        .font(ObFont.footnote)
        .foregroundStyle(Ob.text3)
    }

    /// "12일 후 영구 삭제" (warn tone in the last three days), "오늘 영구 삭제".
    static func purgeText(_ item: TrashItem, today: ISODate, timezone: String) -> (text: String, soon: Bool) {
        let day = ISO8601DateFormatter.parse(item.purgeAt).map { todayIn(timezone, now: $0) } ?? addDays(today, TRASH_DAYS)
        let left = diffDays(day, today)
        return (left <= 0 ? "오늘 영구 삭제" : "\(left)일 후 영구 삭제", left <= 3)
    }
}
