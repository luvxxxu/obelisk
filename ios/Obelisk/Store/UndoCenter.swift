import Foundation
import Observation

/// One undo/redo history for the session (web lib/undo.ts). Every task change the store makes pushes an
/// entry once the server has accepted it; the toast's 실행 취소, a shake and hardware ⌘Z / ⌘⇧Z all walk
/// the same list, so they always agree on what "undo" means.
///
///     let entry = store.history.push("작업 3개 삭제", undo: { await store.restoreTasks(ids, record: false) != nil },
///                                    redo: { await store.trashTasks(ids, record: false, quiet: true) })
///     store.history.notify("작업 3개를 휴지통으로 옮겼어요", entry)
///
/// An entry's functions return false when they could not run (the task is gone, no permission, the
/// network failed and the store already said so): the entry is then dropped without another message.
@Observable
@MainActor
final class UndoCenter {
    typealias Operation = @MainActor () async -> Bool

    struct Entry: Identifiable {
        let id: Int
        /// Short noun for the toast and the shake alert: "작업 3개 삭제", "우선순위 변경".
        var label: String
        /// Edits with the same key a moment apart merge into one entry (typing a title, then the notes).
        var key: String?
        var at: Date
        var undo: Operation
        var redo: Operation
    }

    /// How many entries are kept; the oldest go first.
    static let limit = 100
    /// Same-key edits closer together than this become one entry.
    static let mergeWindow: TimeInterval = 60

    private(set) var undoStack: [Entry] = []
    private(set) var redoStack: [Entry] = []
    /// An undo or redo is running; presses meanwhile are ignored (no queue), like the web.
    private(set) var busy = false
    private var nextId = 1
    /// Counts pushes, so an undo that finishes after a newer change doesn't become redoable.
    private var pushes = 0
    private let toasts: Toasts

    init(toasts: Toasts) {
        self.toasts = toasts
    }

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }
    var undoLabel: String? { undoStack.last?.label }
    var redoLabel: String? { redoStack.last?.label }
    /// The entry the last change pushed: a caller that wants its own toast for it takes it right after
    /// the store call returns (same main-actor turn, nothing else can push in between).
    var latest: Entry? { undoStack.last }

    /// Record a change that already happened. A new change clears what could be redone.
    @discardableResult
    func push(_ label: String, key: String? = nil, undo: @escaping Operation, redo: @escaping Operation) -> Entry {
        pushes += 1
        redoStack.removeAll()
        if let key, var last = undoStack.last, last.key == key, Date().timeIntervalSince(last.at) < Self.mergeWindow {
            // Keep the oldest "before" and the newest "after".
            last.redo = redo
            last.at = Date()
            undoStack[undoStack.count - 1] = last
            return last
        }
        let entry = Entry(id: nextId, label: label, key: key, at: Date(), undo: undo, redo: redo)
        nextId += 1
        undoStack.append(entry)
        if undoStack.count > Self.limit { undoStack.removeFirst(undoStack.count - Self.limit) }
        return entry
    }

    /// ⌘Z or a shake: the newest change.
    func undo() async {
        guard !busy else { return }
        guard let entry = undoStack.last else {
            toasts.show("되돌릴 작업이 없어요")
            return
        }
        await run(entry, undoing: true)
    }

    /// ⌘⇧Z: the change undone last.
    func redo() async {
        guard !busy else { return }
        guard let entry = redoStack.last else {
            toasts.show("다시 실행할 작업이 없어요")
            return
        }
        await run(entry, undoing: false)
    }

    /// A toast's 실행 취소: that change, wherever it is in the list (already undone = nothing to do).
    func undo(_ entry: Entry) async {
        guard !busy, let current = undoStack.first(where: { $0.id == entry.id }) else { return }
        await run(current, undoing: true)
    }

    /// A toast's 다시 실행 after an undo.
    func redo(_ entry: Entry) async {
        guard !busy, let current = redoStack.first(where: { $0.id == entry.id }) else { return }
        await run(current, undoing: false)
    }

    /// Workspace switch, sign-out: the entries point at tasks that are no longer loaded.
    func clear() {
        undoStack.removeAll()
        redoStack.removeAll()
    }

    /// A toast for a change, with 실행 취소 when it was recorded.
    func notify(_ message: String, _ entry: Entry?) {
        toasts.show(message, action: entry.map { e in
            .init(label: UNDO_LABEL_KO) { [weak self] in Task { await self?.undo(e) } }
        })
    }

    private func run(_ entry: Entry, undoing: Bool) async {
        busy = true
        defer { busy = false }
        let before = pushes
        let ok = await (undoing ? entry.undo() : entry.redo())
        undoStack.removeAll { $0.id == entry.id }
        redoStack.removeAll { $0.id == entry.id }
        guard ok else { return }
        // Undoing never merges into a later edit.
        var moved = entry
        moved.key = nil
        if undoing {
            // A change made while this ran cleared what could be redone; this joins it.
            if pushes == before { redoStack.append(moved) }
            Haptics.tap()
            toasts.show("실행 취소함 · \(entry.label)", action: .init(label: "다시 실행") { [weak self] in
                Task { await self?.redo(moved) }
            })
        } else {
            undoStack.append(moved)
            Haptics.tap()
            toasts.show("다시 실행함 · \(entry.label)", action: .init(label: UNDO_LABEL_KO) { [weak self] in
                Task { await self?.undo(moved) }
            })
        }
    }
}
