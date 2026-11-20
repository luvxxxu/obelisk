import AppIntents

/// Siri phrases and the Shortcuts app's Obelisk actions (no setup needed).
struct ObeliskShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddTaskIntent(),
            phrases: [
                "\(.applicationName)에 할 일 추가",
                "\(.applicationName)에 할 일 추가해 줘",
                "\(.applicationName)에 작업 추가",
            ],
            shortTitle: "할 일 추가",
            systemImageName: "plus.circle"
        )
        AppShortcut(
            intent: TodayTasksIntent(),
            phrases: [
                "\(.applicationName) 오늘 할 일",
                "\(.applicationName)에서 오늘 할 일 알려 줘",
            ],
            shortTitle: "오늘 할 일",
            systemImageName: "sun.max"
        )
        AppShortcut(
            intent: CompleteTaskIntent(),
            phrases: [
                "\(.applicationName)에서 \(\.$task) 완료",
                "\(.applicationName) 작업 완료",
            ],
            shortTitle: "작업 완료",
            systemImageName: "checkmark.circle"
        )
    }
}
