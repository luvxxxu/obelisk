import SwiftUI
import UIKit

/// Undo for the whole shell: shaking the phone walks `store.history`, the same list the toasts'
/// 실행 취소 and hardware ⌘Z / ⌘⇧Z (ShellKeys, with the other shortcuts) use.
///
/// Why not the window's `UndoManager`: its actions run synchronously and its stack can't be inspected,
/// while ours are network calls that may fail (and are then dropped), can be undone out of order from a
/// toast, and would interleave with text fields' typing undo on the same manager. Keeping one history
/// and only borrowing the triggers (key commands and the window's shake) keeps them from drifting.
struct UndoControls: ViewModifier {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var shake: ShakeChoice?

    /// What the shake alert offers, fixed when it opens.
    struct ShakeChoice: Identifiable {
        let id = UUID()
        var undo: String?
        var redo: String?
    }

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: .obeliskShake)) { _ in shaken() }
            .alert(
                shake?.undo != nil ? "실행 취소" : "다시 실행",
                isPresented: Binding(get: { shake != nil }, set: { if !$0 { shake = nil } }),
                presenting: shake
            ) { choice in
                if choice.undo != nil {
                    Button("실행 취소") { Task { await store.history.undo() } }
                }
                if let redo = choice.redo {
                    Button(choice.undo != nil ? "다시 실행 · \(redo)" : "다시 실행") { Task { await store.history.redo() } }
                }
                Button("취소", role: .cancel) {}
            } message: { choice in
                Text(choice.undo ?? choice.redo ?? "")
            }
    }

    /// Like iOS's shake to undo: ask first (a shake is easy to do by accident), say nothing when there is
    /// nothing to undo, and leave a shake while typing to UIKit's own alert for the text.
    private func shaken() {
        guard shake == nil, router.sheet == nil, router.fullScreen == nil else { return }
        guard !(UIResponder.obFirstResponder is UITextInput) else { return }
        let h = store.history
        guard !h.busy, h.canUndo || h.canRedo else { return }
        shake = ShakeChoice(undo: h.undoLabel, redo: h.redoLabel)
    }
}

extension View {
    func undoControls() -> some View { modifier(UndoControls()) }
}

extension Notification.Name {
    /// The device was shaken (posted by the key window, below).
    static let obeliskShake = Notification.Name("dev.lxvu.obelisk.shake")
}

extension UIWindow {
    /// SwiftUI has no shake event and the app's window isn't ours to subclass, so the window reports it.
    /// `super` keeps UIKit's own shake to undo for text fields.
    override open func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { NotificationCenter.default.post(name: .obeliskShake, object: self) }
        super.motionEnded(motion, with: event)
    }
}

extension UIResponder {
    private static weak var captured: UIResponder?

    /// The view being edited right now (a text field or view), if any.
    static var obFirstResponder: UIResponder? {
        captured = nil
        UIApplication.shared.sendAction(#selector(obCaptureFirstResponder), to: nil, from: nil, for: nil)
        return captured
    }

    @objc private func obCaptureFirstResponder() {
        UIResponder.captured = self
    }
}
