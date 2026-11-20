import Foundation
import WidgetKit

/// What happens outside the app when its data changes: the widget reloads, local due/start-time
/// notifications are rescheduled. Called by AppStore 0.8s after the last change (coalesced),
/// after the App Group snapshot has been written.
@MainActor
enum SideEffects {
    static func storeChanged(_ store: AppStore) {
        WidgetCenter.shared.reloadAllTimelines()
        Reminders.sync(store)
    }

    static func signedOut() {
        WidgetCenter.shared.reloadAllTimelines()
        Reminders.clearAll()
    }
}
