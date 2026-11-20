import AppIntents
import Foundation
import WidgetKit

// Siri / Shortcuts / interactive widget actions. Compiled into the app and the widget (the widget's
// checkboxes run CompleteTaskIntent in the widget process); the phrases live in Obelisk/System/AppShortcuts.swift.

/// A task of the workspace the app last had open (from the App Group snapshot).
struct TaskEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "작업" }
    static var defaultQuery = TaskEntityQuery()

    var id: String
    var title: String
    var number: Int
    var subtitle: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: subtitle.isEmpty ? nil : "\(subtitle)")
    }

    init(_ t: TaskItem, today: ISODate) {
        id = t.id
        title = t.title
        number = t.number
        subtitle = spanLabel(t, today) ?? ""
    }
}

struct TaskEntityQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TaskEntity] {
        guard let s = Snapshot.load() else { return [] }
        let today = s.currentToday
        return s.tasks.filter { identifiers.contains($0.id) }.map { TaskEntity($0, today: today) }
    }

    /// Suggestions: what's overdue and due today, then the rest of the open work.
    func suggestedEntities() async throws -> [TaskEntity] {
        guard let s = Snapshot.load() else { return [] }
        let today = s.currentToday
        let first = s.overdueTasks + s.todayTasks
        let rest = sortTasks(s.activeTasks.filter { t in !first.contains { $0.id == t.id } })
        return (first + rest).prefix(30).map { TaskEntity($0, today: today) }
    }

    func entities(matching string: String) async throws -> [TaskEntity] {
        guard let s = Snapshot.load() else { return [] }
        let q = string.trimmingCharacters(in: .whitespaces).lowercased()
        let today = s.currentToday
        return sortTasks(s.activeTasks)
            .filter { $0.title.lowercased().contains(q) || "#\($0.number)" == q }
            .prefix(30)
            .map { TaskEntity($0, today: today) }
    }
}

/// "Obelisk에 할 일 추가": parses the phrase like the composer.
struct AddTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "할 일 추가"
    static var description = IntentDescription("Obelisk에 할 일을 추가해요. “내일 오후 3시”, “#프로젝트”, “!높음” 같은 표현을 알아들어요.")

    @Parameter(title: "할 일", requestValueDialog: "무엇을 추가할까요?")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("\(\.$text) 추가")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let r = try await QuickCreate.create(text)
        WidgetCenter.shared.reloadAllTimelines()
        let tail = r.summary.isEmpty ? "" : " · \(r.summary)"
        return .result(dialog: "“\(r.task.title)” 추가했어요\(tail)")
    }
}

/// "Obelisk 오늘 할 일": reads out what's overdue and due today.
struct TodayTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "오늘 할 일"
    static var description = IntentDescription("기한 지난 작업과 오늘 할 일을 알려 줘요.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard Session.isSignedIn else { throw QuickCreate.Failure.signedOut }
        let s = (try? await Snapshot.refresh()) ?? Snapshot.load()
        guard let s else { return .result(dialog: "아직 불러온 작업이 없어요. Obelisk 앱을 한 번 열어 주세요.") }
        let overdue = s.overdueTasks
        let today = s.todayTasks
        if overdue.isEmpty, today.isEmpty {
            return .result(dialog: "오늘은 비어 있어요.")
        }
        var parts: [String] = []
        if !today.isEmpty { parts.append("오늘 할 일 \(today.count)개") }
        if !overdue.isEmpty { parts.append("기한 지난 작업 \(overdue.count)개") }
        let names = (overdue + today).prefix(3).map(\.title).joined(separator: ", ")
        return .result(dialog: "\(parts.joined(separator: ", "))가 있어요. \(names)")
    }
}

/// Complete (or reopen) a task: Shortcuts, Siri and the widget's checkboxes.
struct CompleteTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "작업 완료"
    static var description = IntentDescription("작업을 완료로 표시해요.")

    @Parameter(title: "작업")
    var task: TaskEntity

    init() {}

    init(taskId: String, title: String) {
        task = TaskEntity(id: taskId, title: title, number: 0, subtitle: "")
    }

    static var parameterSummary: some ParameterSummary {
        Summary("\(\.$task) 완료")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let wasDone = Snapshot.load()?.tasks.first { $0.id == task.id }?.status == .done
        try await QuickCreate.setDone(task.id, !wasDone)
        WidgetCenter.shared.reloadAllTimelines()
        return .result(dialog: wasDone ? "“\(task.title)”을(를) 다시 열었어요" : "“\(task.title)” 완료")
    }
}

extension TaskEntity {
    init(id: String, title: String, number: Int, subtitle: String) {
        self.id = id
        self.title = title
        self.number = number
        self.subtitle = subtitle
    }
}
