import Foundation

/// The last workspace the app loaded, written to the App Group container so the widget, Siri/Shortcuts
/// intents and the share extension can show real data without a network round trip.
/// The app writes it after every load and every local change; extensions only read it
/// (they refresh it through the API when they need fresher data).
struct Snapshot: Codable, Sendable {
    var savedAt: Date
    var today: ISODate
    var timezone: String
    var userId: String
    var userName: String
    var workspace: WorkspaceSummary
    var projects: [Project]
    var tasks: [TaskItem]
    var dependencies: [Dependency]

    private static var url: URL { AppGroup.containerURL.appendingPathComponent("snapshot.json") }

    static func load() -> Snapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try? d.decode(Snapshot.self, from: data)
    }

    func save() {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        guard let data = try? e.encode(self) else { return }
        try? data.write(to: Self.url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func clear() {
        try? FileManager.default.removeItem(at: url)
    }

    func project(_ id: String?) -> Project? {
        guard let id else { return nil }
        return projects.first { $0.id == id }
    }
}
