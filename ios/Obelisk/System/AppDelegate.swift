import BackgroundTasks
import UIKit
import UserNotifications
import WidgetKit

/// Notification taps and actions, and background refresh (widget + reminders stay current while the app
/// isn't open).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let refreshTask = "dev.lxvu.obelisk.refresh"

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Task { @MainActor in Reminders.registerCategories() }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTask, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return }
            Self.handleRefresh(task)
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            Self.scheduleRefresh()
        }
        return true
    }

    // MARK: background refresh

    static func scheduleRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: refreshTask)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    private static func handleRefresh(_ task: BGAppRefreshTask) {
        scheduleRefresh()
        let work = Task {
            guard Session.isSignedIn else { return }
            do {
                let snapshot = try await Snapshot.refresh()
                await Reminders.sync(snapshot: snapshot)
                WidgetCenter.shared.reloadAllTimelines()
            } catch {}
        }
        task.expirationHandler = { work.cancel() }
        Task {
            await work.value
            task.setTaskCompleted(success: !work.isCancelled)
        }
    }

    // MARK: notifications

    /// Show reminders as banners even while the app is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let taskId = content.userInfo["taskId"] as? String
        switch response.actionIdentifier {
        case Reminders.completeAction:
            guard let taskId else { return }
            // Runs without opening the app: PATCH directly with the shared session.
            _ = try? await API.shared.send(.patch, "/api/tasks/\(taskId)", json: ["status": "done"])
            Snapshot.update(task: taskId) { $0.status = .done }
            WidgetCenter.shared.reloadAllTimelines()
            await MainActor.run {
                if let store = AppContext.shared.store { Task { await store.refresh() } }
            }
        case Reminders.snoozeAction:
            guard let taskId else { return }
            await Reminders.snooze(content, taskId: taskId)
        default:
            await MainActor.run {
                if let taskId, let url = URL(string: "obelisk://task/\(taskId)") {
                    AppContext.shared.open(url)
                } else if let url = URL(string: "obelisk://page/today") {
                    AppContext.shared.open(url)
                }
            }
        }
    }
}
