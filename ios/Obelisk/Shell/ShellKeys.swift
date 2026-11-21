import SwiftUI
import UIKit

/// Hardware-keyboard shortcuts for the shell (web lib/shortcuts.ts, as far as a phone goes). They work
/// on an iPhone with a keyboard and in iPad compatibility mode, and list in the ⌘ overlay there.
///
/// ⌘N 새 작업 · ⌘K / ⌘F 검색 · ⌘Z / ⌘⇧Z · ⌘A 선택 모드에서 모두 선택 · ⌫ / ⌘⌫ 휴지통 · ⌘↵ 완료 · ⌘D 복제 ·
/// ⌘C 텍스트로 복사 · ⌘V 줄마다 작업 만들기 · Esc 선택 끝내기.
///
/// They act on the picks in 선택 모드, else on the task whose detail is open. While a text field is
/// being edited, ⌘Z / ⌘A / ⌘C / ⌘V / ⌫ belong to the text: the key goes to the field instead (in case
/// UIKit handed it to us rather than to the field). Keys that need targets only exist while there are
/// some and no sheet is up, so a plain ⌫ or ⌘↵ is never claimed on a page where nothing could be
/// deleted or completed. Anything else presented over the shell (the detail's own pickers, a dialog,
/// the impact sheet) is checked when the key is pressed: the tasks behind it are left alone.
struct ShellKeys: ViewModifier {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    func body(content: Content) -> some View {
        content.background { keys }
    }

    /// Invisible buttons that only carry the key commands.
    private var keys: some View {
        let hasTargets = !targets.isEmpty && noSheet
        let selecting = router.selection.isActive && noSheet
        return ZStack {
            key("새 작업", "n") { newTask() }
            key("검색", "k") { search() }
            key("검색", "f") { search() }
            key("실행 취소", "z") { Task { await undo() } }
            key("다시 실행", "z", [.command, .shift]) { Task { await redo() } }
            key("모두 선택", "a") { selectAll() }
            key("복사", "c") { copy() }
            key("붙여넣기", "v") { paste() }
            if hasTargets {
                key("완료", .return) { complete() }
                key("복제", "d") { duplicate() }
                key("휴지통으로 옮기기", .delete, []) { trash(plain: true) }
                key("휴지통으로 옮기기", .delete) { trash(plain: false) }
            }
            if selecting {
                key("선택 끝내기", .escape, []) { if !covered { router.selection.end() } }
            }
        }
        .frame(width: 0, height: 0)
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func key(_ title: String, _ k: KeyEquivalent, _ modifiers: EventModifiers = .command, action: @escaping () -> Void) -> some View {
        Button(title, action: action).keyboardShortcut(k, modifiers: modifiers)
    }

    // MARK: what the keys act on

    /// The picks (tasks still loaded, top to bottom), else the open task detail.
    private var targets: [String] {
        let selection = router.selection
        if selection.isActive { return selection.ordered.filter { store.tasks[$0] != nil } }
        if !router.path.isEmpty, let id = router.taskOnTop, store.tasks[id] != nil { return [id] }
        return []
    }

    /// The text field or view being edited, if any.
    private var field: UIResponder? {
        let r = UIResponder.obFirstResponder
        return r is UITextInput ? r : nil
    }

    /// Hand an edit command to whoever is editing (select all, copy, paste in a text field).
    private func send(_ action: Selector) {
        UIApplication.shared.sendAction(action, to: nil, from: nil, for: nil)
    }

    private var noSheet: Bool { router.sheet == nil && router.fullScreen == nil }

    /// Something covers the shell right now: a router sheet, or anything else presented (asked at the
    /// press, since a screen's own `.sheet` and dialogs don't go through the router).
    private var covered: Bool { !noSheet || UIApplication.obPresenting }

    // MARK: actions

    private func newTask() {
        guard noSheet else { return }
        router.selection.end()
        let prefill = router.newTaskPrefill
        router.present(.init(id: "new-task", detents: [.medium, .large]) { NewTaskSheet(prefill: prefill) })
    }

    private func search() {
        guard noSheet else { return }
        router.selection.end()
        router.present(.init(id: "search", detents: [.large]) { SearchSheet() })
    }

    /// While typing, ⌘Z belongs to the text (if the field didn't take it itself), never to a task change.
    private func undo() async {
        if let field {
            if field.undoManager?.canUndo == true { field.undoManager?.undo() }
            return
        }
        await store.history.undo()
    }

    private func redo() async {
        if let field {
            if field.undoManager?.canRedo == true { field.undoManager?.redo() }
            return
        }
        await store.history.redo()
    }

    /// ⌘A: every row of the page's list, in 선택 모드.
    private func selectAll() {
        if field != nil { return send(#selector(UIResponderStandardEditActions.selectAll(_:))) }
        guard router.path.isEmpty, !covered else { return }
        router.selection.selectAll()
    }

    private func copy() {
        if field != nil { return send(#selector(UIResponderStandardEditActions.copy(_:))) }
        guard !covered else { return }
        let ids = targets
        guard !ids.isEmpty else { return }
        store.copyTasks(ids)
    }

    /// ⌘V on a list page: each pasted line becomes a task with the page's defaults.
    private func paste() {
        if field != nil { return send(#selector(UIResponderStandardEditActions.paste(_:))) }
        guard router.path.isEmpty, !covered, let ctx = store.pasteContext(router.page),
              UIPasteboard.general.hasStrings, let text = UIPasteboard.general.string else { return }
        let selection = router.selection
        Task {
            let made = await store.pasteTasks(text, ctx)
            if selection.isActive, !made.isEmpty { selection.ids = Set(made.map(\.id)) }
        }
    }

    private func complete() {
        guard field == nil, !covered else { return }
        let ids = targets
        Task { await store.completeTasks(ids) }
    }

    private func duplicate() {
        guard field == nil, !covered else { return }
        let ids = targets
        let selection = router.selection
        Task { await selection.duplicate(ids, store) }
    }

    private func trash(plain: Bool) {
        if let field {
            if plain { (field as? UIKeyInput)?.deleteBackward() }
            return
        }
        // ⌫ in a picker over the task detail must not trash the task behind it.
        guard !covered else { return }
        router.selection.trash(targets, store)
    }
}

extension UIApplication {
    /// The key window shows something presented over its root (a sheet, a full-screen cover, an alert
    /// or confirmation dialog), whoever presented it.
    @MainActor
    static var obPresenting: Bool {
        let windows = shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        let window = windows.first(where: \.isKeyWindow) ?? windows.first
        return window?.rootViewController?.presentedViewController != nil
    }
}

extension View {
    func shellKeys() -> some View { modifier(ShellKeys()) }
}
