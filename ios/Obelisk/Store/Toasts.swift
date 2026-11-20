import Foundation
import Observation
import UIKit

/// Short confirmations and errors, shown as a floating glass capsule above the composer
/// (the web's Toaster). One at a time; a new one replaces the old.
@Observable
@MainActor
final class Toasts {
    struct Action {
        var label: String
        var run: () -> Void
    }

    struct Item: Identifiable {
        let id = UUID()
        var message: String
        var isError: Bool
        var action: Action?
    }

    private(set) var current: Item?
    private var dismissTask: Task<Void, Never>?

    func show(_ message: String, action: Action? = nil) {
        present(Item(message: message, isError: false, action: action))
    }

    func error(_ message: String) {
        Haptics.error()
        present(Item(message: message, isError: true, action: nil))
    }

    func dismiss() {
        dismissTask?.cancel()
        current = nil
    }

    private func present(_ item: Item) {
        current = item
        dismissTask?.cancel()
        let seconds: Double = item.action != nil ? 5 : (item.isError ? 4.5 : 3)
        dismissTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled, self?.current?.id == item.id else { return }
            self?.current = nil
        }
    }
}

/// Light haptics for completing, failing and selecting. Never decorative.
enum Haptics {
    @MainActor static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    @MainActor static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    @MainActor static func select() { UISelectionFeedbackGenerator().selectionChanged() }
    @MainActor static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
