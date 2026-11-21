import SwiftUI
import UIKit

/// What pasted lines default to on a page (web PasteContext): the same defaults as the page's composer.
struct PasteContext: Sendable {
    /// Where lines without a known `#project` land (nil = 인박스).
    var projectId: String?
    /// Lines without a date get this due date.
    var defaultDueDate: ISODate?
    var assigneeId: String?
}

/// The commands every surface shares (web lib/task-actions.ts): the selection bar, the row menu and the
/// hardware shortcuts all call these, so a change made any of those ways reads the same in its toast
/// and takes the same ⌘Z. Several tasks at once always make one undo entry.
extension AppStore {
    /// One bulk request (duplicate, paste) holds at most this many tasks (the server's limit).
    static let maxBatch = 100

    private func tasksOf(_ ids: [String]) -> [TaskItem] {
        var seen = Set<String>()
        return ids.compactMap { seen.insert($0).inserted ? tasks[$0] : nil }
    }

    /// The tasks the user may change; says so when some (or all) are view-only.
    func editableOnly(_ ids: [String]) -> [TaskItem] {
        let list = tasksOf(ids)
        let ok = list.filter(canEdit)
        let blocked = list.count - ok.count
        if blocked > 0 {
            toasts.error(ok.isEmpty ? Self.readOnlyMessage : "보기 전용 작업 \(blocked)개는 바꿀 수 없어요")
        }
        return ok
    }

    private func projectLabel(_ projectId: String?) -> String {
        guard let projectId else { return "인박스" }
        return project(projectId)?.name ?? "프로젝트"
    }

    // MARK: status

    /// 완료 (⌘↵): when every task is done they reopen, otherwise the open ones are completed. One undo.
    func completeTasks(_ ids: [String]) async {
        let list = editableOnly(ids)
        guard !list.isEmpty else { return }
        let reopen = list.allSatisfy { $0.status == .done }
        let targets = reopen ? list : list.filter(\.isActive)
        if targets.count == 1 { return await toggleDone(targets[0].id) }
        guard !targets.isEmpty else { return }
        let status: TaskStatus = reopen ? .todo : .done
        let changes = targets.map { TaskMove(taskId: $0.id, position: $0.position, status: status) }
        // Undo and redo put completions back with the times they had (`sendMoves` fills them in).
        guard let r = await sendMoves(changes), !r.forward.isEmpty else { return }
        let label = reopen ? "작업 \(r.forward.count)개 완료 취소" : "작업 \(r.forward.count)개 완료"
        let entry = history.push(label, undo: { [weak self] in
            await self?.moveTasks(r.back, record: false) ?? false
        }, redo: { [weak self] in
            await self?.moveTasks(r.forward, record: false) ?? false
        })
        // Part of a big batch was refused: its error toast stays up; ⌘Z still takes back the rest.
        guard r.ok else { return }
        if !reopen { Haptics.success() }
        history.notify(label, entry)
    }

    // MARK: dates

    /// Move open tasks to new dates (web requestGroupChange). One task goes through `requestDateChange`.
    /// Several are previewed together: when other work would slip or a fixed date would break, the
    /// impact sheet asks first (함께 옮기기 / 고른 작업만); otherwise they move at once. One undo entry.
    private func moveDates(_ list: [TaskItem], label: String, done: String, _ next: (TaskItem) -> TimedSpan) async {
        let moves = list.compactMap { t -> GroupMove? in
            let n = next(t)
            guard n.startDate != t.startDate || n.dueDate != t.dueDate else { return nil }
            return GroupMove(taskId: t.id, next: n)
        }
        guard let first = moves.first else { return }
        if moves.count == 1 {
            requestDateChange(first.taskId, first.next)
            return
        }
        let preview = previewGroupNow(moves)
        if preview.hasImpact {
            pendingChange = PendingChange(taskId: first.taskId, title: "작업 \(moves.count)개", next: first.next, preview: preview, count: moves.count)
            return
        }
        if await reschedule(preview.only, label: label) {
            history.notify("작업 \(moves.count)개를 \(done)", history.latest)
        }
    }

    /// 오늘로 (T): open tasks that don't already end today are moved so they do (undated ones get today).
    func moveToToday(_ ids: [String]) async {
        let open = editableOnly(ids).filter(\.isActive)
        guard !open.isEmpty else { return }
        let moving = open.filter { ($0.dueDate ?? $0.startDate) != today }
        guard !moving.isEmpty else {
            toasts.show(open.count == 1 ? "이미 오늘 할 작업이에요" : "모두 이미 오늘 할 작업이에요")
            return
        }
        let day = today
        await moveDates(moving, label: "오늘로", done: "오늘로 옮겼어요") { Self.spanEndingOn($0, day) }
    }

    /// The bulk 미루기 choices (the single-task menu keeps its per-task impact list).
    enum Postpone: Hashable {
        case days(Int)
        case nextMonday

        var label: String {
            switch self {
            case .days(1): "하루 미루기"
            case .days(2): "이틀 미루기"
            case .days(7): "일주일 미루기"
            case let .days(n): "\(n)일 미루기"
            case .nextMonday: "다음 주 월요일"
            }
        }
    }

    /// 미루기 (P = a day): open dated tasks move later. A day shifts both ends; the longer choices count
    /// from today for overdue work, like the row menu.
    func postponeTasks(_ ids: [String], _ choice: Postpone = .days(1)) async {
        let open = editableOnly(ids).filter(\.isActive)
        guard !open.isEmpty else { return }
        let dated = open.filter { $0.startDate != nil || $0.dueDate != nil }
        guard !dated.isEmpty else {
            toasts.show("날짜가 있는 작업이 없어요")
            return
        }
        let day = today
        let monday = addDays(startOfWeek(today), 7)
        await moveDates(dated, label: "미루기", done: "미뤘어요") { t in
            let anchor = t.dueDate ?? t.startDate ?? day
            let base = anchor < day ? day : anchor
            switch choice {
            case .days(1): return Self.shiftSpan(t, 1)
            case let .days(n): return Self.spanEndingOn(t, addDays(base, n))
            case .nextMonday: return Self.spanEndingOn(t, monday)
            }
        }
    }

    /// 날짜 선택…: every task ends on `date` (undated ones get it as their due date).
    func scheduleTasks(_ ids: [String], on date: ISODate) async {
        let open = editableOnly(ids).filter(\.isActive)
        guard !open.isEmpty else { return }
        await moveDates(open, label: "날짜 변경", done: "\(formatRelativeKo(date, today))(으)로 옮겼어요") { Self.spanEndingOn($0, date) }
    }

    // MARK: fields

    /// 우선순위 (1–4 on the web): one value for all of them, one undo.
    func setPriority(_ ids: [String], _ p: Priority) async {
        let changing = editableOnly(ids).filter { $0.priority != p }
        guard !changing.isEmpty else { return }
        var patch = TaskPatch()
        patch.priority = p
        let saved = await patchTasks(changing.map { TaskEdit(id: $0.id, patch: patch) }, label: "우선순위 변경")
        // Some refused: their error toast stays up (the undo entry still covers the saved ones).
        guard !saved.isEmpty, saved.count == changing.count else { return }
        let name = PriorityInfo.labelKo[p] ?? ""
        history.notify(saved.count == 1 ? "우선순위 \(name)" : "작업 \(saved.count)개 우선순위 \(name)", history.latest)
    }

    /// 프로젝트로 옮기기 (nil = 인박스). False when nothing moved.
    @discardableResult
    func moveToProject(_ ids: [String], _ projectId: String?) async -> Bool {
        guard canWriteProject(projectId) else {
            toasts.error("‘\(projectLabel(projectId))’ 프로젝트는 보기 전용이라 작업을 옮길 수 없어요")
            return false
        }
        let moving = editableOnly(ids).filter { $0.projectId != projectId }
        guard !moving.isEmpty else { return false }
        var patch = TaskPatch()
        patch.projectId = .some(projectId)
        let saved = await patchTasks(moving.map { TaskEdit(id: $0.id, patch: patch) }, label: "프로젝트 이동")
        guard !saved.isEmpty else { return false }
        // Some refused: their error toast (why) stays up; the undo entry still covers the moved ones.
        guard saved.count == moving.count else { return true }
        let name = projectLabel(projectId)
        history.notify(
            saved.count == 1 ? "“\(saved[0].title)”을(를) \(name)(으)로 옮겼어요" : "작업 \(saved.count)개를 \(name)(으)로 옮겼어요",
            history.latest
        )
        return true
    }

    /// The value every task shares (a check in the menus), or nil when they differ.
    func sharedValue<V: Equatable>(_ ids: [String], _ value: (TaskItem) -> V) -> V? {
        let list = tasksOf(ids)
        guard let first = list.first.map(value), list.allSatisfy({ value($0) == first }) else { return nil }
        return first
    }

    // MARK: copy, paste

    /// One quick-add line per task, in the order given (screen order from the selection), so pasting
    /// it back here, on the web or into a chat reads the same: `견적서 보내기 11/22 15:00 #런칭 !높음`.
    func tasksAsText(_ ids: [String]) -> String {
        tasksOf(ids).map { taskLine($0, today, $0.projectId.map(projectLabel)) }.joined(separator: "\n")
    }

    /// 텍스트로 복사 (⌘C).
    func copyTasks(_ ids: [String]) {
        let list = tasksOf(ids)
        guard !list.isEmpty else { return }
        UIPasteboard.general.string = tasksAsText(ids)
        toasts.show(list.count == 1 ? "작업을 복사했어요" : "작업 \(list.count)개를 복사했어요")
    }

    /// 링크 복사: one web link per line (they open the app too).
    func copyTaskLinks(_ ids: [String]) {
        let list = tasksOf(ids)
        guard !list.isEmpty else { return }
        UIPasteboard.general.string = list.map { "\(Session.server)/t/\($0.id)" }.joined(separator: "\n")
        toasts.show(list.count == 1 ? "작업 링크를 복사했어요" : "작업 링크 \(list.count)개를 복사했어요")
    }

    /// What ⌘V means on a page (web pasteContext); nil = the page doesn't take pasted tasks.
    func pasteContext(_ page: Page) -> PasteContext? {
        switch page {
        case .inbox, .all: return PasteContext()
        case .today: return PasteContext(defaultDueDate: today)
        case .upcoming: return PasteContext(defaultDueDate: addDays(today, 1))
        case .mine: return isOrg ? PasteContext(assigneeId: user?.id) : nil
        case let .project(id): return project(id) != nil && canWriteProject(id) ? PasteContext(projectId: id) : nil
        default: return nil
        }
    }

    /// ⌘V and the composer's 줄마다 작업 만들기: each non-empty line (list markers dropped) is read like quick
    /// add. A `#project` you can write to is used; an unknown one is not created, the line lands where
    /// the page puts new tasks. One undo moves them all to the trash. Returns the new tasks.
    @discardableResult
    func pasteTasks(_ text: String, _ ctx: PasteContext) async -> [TaskItem] {
        var lines = pasteLines(text)
        guard !lines.isEmpty else { return [] }
        if lines.count > Self.maxBatch {
            toasts.show("한 번에 \(Self.maxBatch)줄까지만 붙여넣었어요")
            lines = Array(lines.prefix(Self.maxBatch))
        }
        let clock = clockNow(timezone)
        let nowMinutes = clock.date == today ? clock.minutes : nil
        let open = openProjects
        let inputs = lines.compactMap { line -> NewTask? in
            let q = parseQuickAdd(line, today, nowMinutes: nowMinutes)
            let title = String(q.title.prefix(500)).composeTrimmed
            guard !title.isEmpty else { return nil }
            let matched = q.projectName.flatMap { matchProject(open, $0) }
            var t = NewTask(title: title)
            t.projectId = matched.map(\.id).flatMap { canWriteProject($0) ? $0 : nil } ?? ctx.projectId
            t.startDate = q.startDate
            t.startTime = q.startTime
            t.dueDate = q.dueDate ?? (q.startDate != nil ? nil : ctx.defaultDueDate)
            t.dueTime = q.dueDate != nil ? q.dueTime : nil
            t.priority = q.priority ?? 0
            t.fixed = q.fixed
            t.assigneeId = ctx.assigneeId
            return t
        }
        guard !inputs.isEmpty else {
            toasts.show("붙여넣을 작업이 없어요")
            return []
        }
        if let p = ctx.projectId, !canWriteProject(p) {
            toasts.error(Self.readOnlyMessage)
            return []
        }
        let n = inputs.count
        let made = await createTasks(inputs, label: n == 1 ? "작업 붙여넣기" : "작업 \(n)개 붙여넣기")
        guard !made.isEmpty else { return [] }
        Haptics.tap()
        history.notify(made.count == 1 ? "“\(made[0].title)”을(를) 붙여넣었어요" : "작업 \(made.count)개를 붙여넣었어요", history.latest)
        return made
    }
}
