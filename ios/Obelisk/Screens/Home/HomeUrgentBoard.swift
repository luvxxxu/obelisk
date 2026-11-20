import SwiftUI

// 급한 업무 board (web _home/UrgentBoard.tsx): 진행 중 · 시작 전 · 오늘 완료.
// On iPhone the columns page horizontally. Long-press a card and drag it to reorder or drop it in another
// column to change its status (hover over a column at the edge for a moment and the board pages to it);
// ▶ on a 시작 전 card starts it; the card's menu offers the same moves. The first reorder while sorted
// by urgency freezes what's on screen into manual positions and switches the board to 직접 정렬
// (the sort chip, or the toast's 긴급도순으로, goes back).

/// Cards per board column before "외 n개 더 보기".
private let HOME_COLUMN_CAP = 6
/// "급한 업무" = overdue, today, due within this many days, in progress, or high priority.
private let HOME_URGENT_DAYS = 3

enum HomeUrgentCol: String, CaseIterable, Hashable {
    case doing, todo, done

    var title: String {
        switch self {
        case .doing: "진행 중"
        case .todo: "시작 전"
        case .done: "오늘 완료"
        }
    }

    var status: TaskStatus {
        switch self {
        case .doing: .doing
        case .todo: .todo
        case .done: .done
        }
    }

    var morePage: Page {
        switch self {
        case .doing: .all
        case .todo: .today
        case .done: .logbook
        }
    }
}

/// 긴급도순: computed from dates/priority. 직접 정렬: the manual `position` the user dragged into.
enum HomeUrgentOrder: String {
    case urgency, manual
}

private let HOME_PRIORITY_TAG: [Int: (String, ProjectColor)] = [3: ("높음", .red), 2: ("보통", .amber), 1: ("낮음", .slate)]

/// Overdue first, then earliest date, then priority, then #number.
func homeByUrgency(_ today: ISODate, _ now: Clock) -> (TaskItem, TaskItem) -> Int {
    func when(_ t: TaskItem) -> String {
        if let d = t.dueDate { return dateTimeKey(d, t.dueTime) }
        if let s = t.startDate { return dateTimeKey(s, t.startTime, .start) }
        return "9999-12-31"
    }
    return { a, b in
        let oa = isOverdue(a, today, now) ? 0 : 1
        let ob = isOverdue(b, today, now) ? 0 : 1
        if oa != ob { return oa - ob }
        let da = when(a)
        let db = when(b)
        if da != db { return da < db ? -1 : 1 }
        if a.priority != b.priority { return b.priority - a.priority }
        return a.number - b.number
    }
}

struct HomeUrgentBoard: View {
    var today: ISODate
    var doneToday: [TaskItem]
    var now: Clock

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @AppStorage("obelisk.home-urgent-order") private var orderRaw = HomeUrgentOrder.urgency.rawValue
    /// Cards moved here stay on the board even if they no longer look urgent (e.g. 진행 중 → 시작 전).
    @State private var kept: Set<String> = []
    /// The column a dragged card hovers over, and the card it would land before.
    @State private var targetCol: HomeUrgentCol?
    @State private var targetCard: String?
    @State private var visibleCol: HomeUrgentCol? = .doing
    @State private var dwell: Task<Void, Never>?
    @Namespace private var cardSpace

    private var order: HomeUrgentOrder { HomeUrgentOrder(rawValue: orderRaw) ?? .urgency }

    var body: some View {
        let lists = self.lists
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            HomeListHeader(symbol: "rectangle.split.3x1", title: "작업", page: .today, pageLabel: "오늘 보기",
                           newLabel: "새 작업", onNew: { homeNewTask(router) }) {
                Button {
                    withAnimation(ObMotion.mid) { orderRaw = (order == .manual ? HomeUrgentOrder.urgency : .manual).rawValue }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.up.arrow.down").font(.system(size: 12, weight: .medium))
                        Text(order == .manual ? "직접 정렬" : "긴급도순")
                    }
                    .foregroundStyle(Ob.text3)
                }
                .buttonStyle(.ob(.ghost, size: .small))
                .accessibilityLabel("정렬: \(order == .manual ? "직접 정렬" : "긴급도순")")
                .accessibilityHint(order == .manual ? "긴급도순으로 보기" : "직접 정렬로 보기")
            }

            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(HomeUrgentCol.allCases, id: \.self) { col in
                        column(col, lists)
                            .homeBoardColumnWidth()
                            .id(col)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $visibleCol, anchor: .leading)
            .contentMargins(.horizontal, ObSpace.page, for: .scrollContent)
            .padding(.horizontal, -ObSpace.page)
            .animation(ObMotion.mid, value: signature(lists))
            .accessibilityLabel("급한 업무 보드")
            .onChange(of: targetCol) { _, col in pageWhileDragging(to: col) }
        }
    }

    // MARK: data

    private var lists: [HomeUrgentCol: [TaskItem]] {
        let soon = addDays(today, HOME_URGENT_DAYS)
        let cmp = homeByUrgency(today, now)
        func urgent(_ t: TaskItem) -> Bool {
            let d = t.dueDate ?? t.startDate
            return t.status == .doing || t.priority == 3 || isOverdue(t, today, now) || isToday(t, today) || (d.map { $0 <= soon } ?? false)
        }
        let sort: (TaskItem, TaskItem) -> Int = order == .manual
            ? { a, b in a.position != b.position ? (a.position < b.position ? -1 : 1) : cmp(a, b) }
            : cmp
        let open = JS.sorted(store.taskList.filter { ($0.status == .todo || $0.status == .doing) && (kept.contains($0.id) || urgent($0)) }, sort)
        return [
            .doing: open.filter { $0.status == .doing },
            .todo: open.filter { $0.status == .todo },
            .done: doneToday,
        ]
    }

    private func signature(_ lists: [HomeUrgentCol: [TaskItem]]) -> String {
        HomeUrgentCol.allCases.map { c in (lists[c] ?? []).prefix(HOME_COLUMN_CAP).map(\.id).joined(separator: ",") }.joined(separator: "|")
    }

    // MARK: columns and cards

    @ViewBuilder
    private func column(_ col: HomeUrgentCol, _ lists: [HomeUrgentCol: [TaskItem]]) -> some View {
        let all = lists[col] ?? []
        let visible = Array(all.prefix(HOME_COLUMN_CAP))
        let hidden = all.count - visible.count
        let targeted = targetCol == col

        HomeColumn(title: col.title, count: all.count, targeted: targeted, ghost: col == .done && all.isEmpty) {
            if visible.isEmpty {
                if col == .done {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold))
                        Text("여기에 놓으면 완료")
                    }
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .frame(maxWidth: .infinity, minHeight: 64)
                    .background(
                        RoundedRectangle(cornerRadius: ObRadius.md)
                            .strokeBorder(Ob.borderStrong, style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                    )
                }
            } else {
                VStack(spacing: ObSpace.sm) {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { i, t in
                        card(t, col: col, index: i, count: visible.count, lists: lists)
                    }
                }
            }
        } footer: {
            if hidden > 0 {
                HomeColumnButton(symbol: nil, label: "외 \(hidden)개 더 보기") { router.open(col.morePage) }
            }
            if col != .done {
                HomeColumnButton(symbol: "plus", label: "새 작업") { homeNewTask(router) }
            }
        }
        .contentShape(Rectangle())
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first else { return false }
            return drop(id, to: col, aimed: visible.filter { $0.id != id }.count, lists: lists)
        } isTargeted: { on in
            if on { targetCol = col } else if targetCol == col { targetCol = nil }
        }
    }

    private func card(_ t: TaskItem, col: HomeUrgentCol, index i: Int, count: Int, lists: [HomeUrgentCol: [TaskItem]]) -> some View {
        let canMoveUp = col != .done && i > 0
        let canMoveDown = col != .done && i < count - 1
        let from = col
        return VStack(spacing: ObSpace.xs) {
            if targetCard == t.id {
                Capsule()
                    .fill(Ob.text3)
                    .frame(height: 3)
                    .padding(.horizontal, ObSpace.xs)
                    .transition(.opacity)
            }
            HomeUrgentCard(
                task: t,
                today: today,
                now: now,
                project: store.project(t.projectId),
                onStart: col == .todo ? { move(t.id, from: .todo, to: .doing, aimed: 0, lists: lists) } : nil,
                onCheck: {
                    keep(t.id)
                    Task { await store.toggleDone(t.id) }
                }
            )
            .matchedGeometryEffect(id: t.id, in: cardSpace)
            .contentShape(.dragPreview, RoundedRectangle(cornerRadius: ObRadius.md))
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: ObRadius.md))
            .draggable(t.id)
            .dropDestination(for: String.self) { ids, _ in
                guard let id = ids.first, id != t.id else { return false }
                let others = (lists[col] ?? []).filter { $0.id != id }
                let aimed = others.firstIndex { $0.id == t.id } ?? others.count
                return drop(id, to: col, aimed: aimed, lists: lists)
            } isTargeted: { on in
                if on { targetCard = t.id } else if targetCard == t.id { targetCard = nil }
            }
            .contextMenu {
                Section {
                    if col != .doing {
                        Button {
                            move(t.id, from: from, to: .doing, aimed: min(i, HOME_COLUMN_CAP - 1), lists: lists)
                        } label: { Label("진행 중으로", systemImage: "play") }
                    }
                    if col != .todo {
                        Button {
                            move(t.id, from: from, to: .todo, aimed: min(i, HOME_COLUMN_CAP - 1), lists: lists)
                        } label: { Label("시작 전으로", systemImage: "circle") }
                    }
                    if canMoveUp {
                        Button {
                            move(t.id, from: from, to: from, aimed: i - 1, lists: lists)
                        } label: { Label("위로", systemImage: "arrow.up") }
                    }
                    if canMoveDown {
                        Button {
                            move(t.id, from: from, to: from, aimed: i + 1, lists: lists)
                        } label: { Label("아래로", systemImage: "arrow.down") }
                    }
                }
                HomeTaskMenu(task: t)
            }
            .accessibilityActions {
                if col != .doing {
                    Button("진행 중으로") { move(t.id, from: from, to: .doing, aimed: min(i, HOME_COLUMN_CAP - 1), lists: lists) }
                }
                if col != .todo {
                    Button("시작 전으로") { move(t.id, from: from, to: .todo, aimed: min(i, HOME_COLUMN_CAP - 1), lists: lists) }
                }
                if col != .done {
                    Button("오늘 완료로") { move(t.id, from: from, to: .done, aimed: 0, lists: lists) }
                }
                if canMoveUp { Button("위로") { move(t.id, from: from, to: from, aimed: i - 1, lists: lists) } }
                if canMoveDown { Button("아래로") { move(t.id, from: from, to: from, aimed: i + 1, lists: lists) } }
            }
        }
        .animation(ObMotion.standard, value: targetCard == t.id)
    }

    // MARK: moves

    private func column(of id: String, _ lists: [HomeUrgentCol: [TaskItem]]) -> HomeUrgentCol? {
        HomeUrgentCol.allCases.first { c in (lists[c] ?? []).contains { $0.id == id } }
    }

    /// A card dropped on a column (or on a card in it).
    @discardableResult
    private func drop(_ id: String, to: HomeUrgentCol, aimed: Int, lists: [HomeUrgentCol: [TaskItem]]) -> Bool {
        targetCol = nil
        targetCard = nil
        dwell?.cancel()
        guard let task = store.task(id) else { return false }
        let from = column(of: id, lists) ?? (task.status == .done ? .done : task.status == .doing ? .doing : .todo)
        Haptics.select()
        move(id, from: from, to: to, aimed: aimed, lists: lists)
        return true
    }

    private func move(_ id: String, from: HomeUrgentCol, to: HomeUrgentCol, aimed: Int, lists: [HomeUrgentCol: [TaskItem]]) {
        commit(id, from: from, to: to, index: landingIndex(id, from: from, to: to, aimed: aimed, lists: lists), lists: lists)
    }

    /// Index among the other cards of `to` where a card from `from` lands, given where the user aimed.
    private func landingIndex(_ id: String, from: HomeUrgentCol, to: HomeUrgentCol, aimed: Int, lists: [HomeUrgentCol: [TaskItem]]) -> Int {
        let others = (lists[to] ?? []).filter { $0.id != id }
        if to == .done { return 0 } // newest completion first
        if order == .urgency, from != to {
            // Sorted by urgency, a status change lands where the sort puts it.
            guard let task = store.task(id) else { return others.count }
            let cmp = homeByUrgency(today, now)
            return others.firstIndex { cmp(task, $0) < 0 } ?? others.count
        }
        return max(0, min(aimed, others.count))
    }

    private func keep(_ id: String) {
        if !kept.contains(id) { kept.insert(id) }
    }

    private func commit(_ id: String, from: HomeUrgentCol, to: HomeUrgentCol, index: Int, lists: [HomeUrgentCol: [TaskItem]]) {
        guard let task = store.task(id) else { return }
        guard store.canEdit(task) else {
            store.toasts.error(AppStore.readOnlyMessage)
            return
        }
        keep(id)

        if to == .done {
            if from != .done { Task { await store.toggleDone(id) } } // its own toast + undo
            return
        }

        let others = (lists[to] ?? []).filter { $0.id != id }
        if from == to, index == (lists[from] ?? []).firstIndex(where: { $0.id == id }) { return }
        let status: TaskStatus? = task.status != to.status ? to.status : nil
        var changes: [AppStore.TaskMove]
        var switched = false

        func moves(_ list: [SpreadItem]) -> [AppStore.TaskMove] {
            list.map { AppStore.TaskMove(taskId: $0.id, position: $0.position, status: nil) }
        }

        if order == .urgency, from != to {
            changes = [AppStore.TaskMove(taskId: id, position: task.position, status: status)]
        } else {
            let at = min(index, others.count)
            let ids = others.prefix(at).map(\.id) + [id] + others.dropFirst(at).map(\.id)
            if order == .urgency {
                // First manual move: freeze both open columns exactly as they look, then go manual.
                let other: HomeUrgentCol = to == .doing ? .todo : .doing
                changes = moves(spread(ids)) + moves(spread((lists[other] ?? []).map(\.id)))
                switched = true
            } else {
                let before = at > 0 ? others[at - 1].position : nil
                let after = at < others.count ? others[at].position : nil
                if let pos = positionBetween(before, after) {
                    changes = [AppStore.TaskMove(taskId: id, position: pos, status: nil)]
                } else {
                    changes = moves(spread(ids))
                }
            }
            if let status {
                changes = changes.map { c in
                    var c = c
                    if c.taskId == id { c.status = status }
                    return c
                }
            }
        }

        changes = changes.filter { c in
            guard let t = store.task(c.taskId) else { return false }
            return t.position != c.position || (c.status != nil && c.status != t.status)
        }
        guard !changes.isEmpty else { return }
        let undo: [AppStore.TaskMove] = changes.compactMap { c in
            guard let t = store.task(c.taskId) else { return nil }
            return AppStore.TaskMove(taskId: c.taskId, position: t.position, status: c.status != nil ? t.status : nil)
        }

        if switched { orderRaw = HomeUrgentOrder.manual.rawValue }
        Task {
            let ok = await store.moveTasks(changes)
            if !ok, switched { orderRaw = HomeUrgentOrder.urgency.rawValue }
        }
        if switched {
            store.toasts.show("직접 정렬로 바꿨어요 · 끌어 놓은 순서가 그대로 남아요", action: .init(label: "긴급도순으로") {
                withAnimation(ObMotion.mid) { orderRaw = HomeUrgentOrder.urgency.rawValue }
            })
        } else if status != nil {
            let store = self.store
            store.toasts.show("“\(task.title)” \(to.title)으로 옮겼어요", action: .init(label: "실행 취소") {
                Task { await store.moveTasks(undo) }
            })
        }
    }

    /// Hovering a dragged card over a column for a moment pages the board to it.
    private func pageWhileDragging(to col: HomeUrgentCol?) {
        dwell?.cancel()
        guard let col, col != visibleCol else { return }
        dwell = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(650))
            guard !Task.isCancelled, targetCol == col else { return }
            withAnimation(ObMotion.mid) { visibleCol = col }
        }
    }
}

/// One task on the board: title, priority and project tags, date, how often it was postponed; ▶ and ✓.
private struct HomeUrgentCard: View {
    var task: TaskItem
    var today: ISODate
    var now: Clock
    var project: Project?
    var onStart: (() -> Void)?
    var onCheck: () -> Void

    @Environment(Router.self) private var router

    var body: some View {
        let done = task.status == .done
        let overdue = isOverdue(task, today, now)
        let date = overdue && task.dueDate != nil ? overdueLabel(task.dueDate!, today, task.dueTime, now) : spanLabel(task, today)
        let pr = HOME_PRIORITY_TAG[task.priority]

        ZStack(alignment: .topTrailing) {
            Button {
                router.openTask(task.id)
            } label: {
                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    Text(task.title)
                        .font(ObFont.body.weight(.medium))
                        .foregroundStyle(done ? Ob.text3 : Ob.text)
                        .strikethrough(done, color: Ob.text4)
                        .multilineTextAlignment(.leading)
                        .lineLimit(3)
                        .padding(.trailing, onStart != nil ? 64 : 32)
                    if pr != nil || project != nil {
                        FlowRow(spacing: 4, lineSpacing: 4) {
                            if let pr { HomeTag(pr.0, hue: pr.1) }
                            if let project { HomeTag(project.name, hue: project.color) }
                        }
                    }
                    if let date, !done {
                        HomeCardMeta(symbol: task.fixed ? "pin" : overdue ? "exclamationmark.circle" : "calendar",
                                     text: date, tone: overdue ? .danger : .neutral)
                    }
                    if task.postponedCount >= 2, !done {
                        HomeCardMeta(symbol: "calendar.badge.clock", text: "\(task.postponedCount)회 미룸")
                    }
                }
                .padding(.horizontal, ObSpace.md)
                .padding(.top, 10)
                .padding(.bottom, ObSpace.md)
                .frame(maxWidth: .infinity, minHeight: ObSize.row, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(HomeCardButtonStyle(radius: ObRadius.md))

            HStack(spacing: 0) {
                if let onStart {
                    Button(action: onStart) {
                        Image(systemName: "play.fill")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(Ob.text3)
                            .padding(.leading, 1)
                            .frame(width: 20, height: 20)
                            .overlay(Circle().strokeBorder(Ob.text4, lineWidth: 1.5))
                            .frame(width: 32, height: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("진행 중으로 옮기기")
                }
                Button(action: onCheck) {
                    ZStack {
                        Circle().fill(done ? Ob.primary : Ob.bg)
                        Circle().strokeBorder(done ? Ob.primary : Ob.text4, lineWidth: 1.5)
                        if done {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(Ob.onPrimary)
                        }
                    }
                    .frame(width: 20, height: 20)
                    .frame(width: 36, height: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(done ? "완료 취소" : "완료로 표시")
            }
            .padding(.trailing, 2)
        }
        .accessibilityElement(children: .contain)
    }
}
