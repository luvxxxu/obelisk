import SwiftUI
import WidgetKit

@main
struct ObeliskWidgetBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        RiskWidget()
    }
}

// MARK: - Timeline

struct ObeliskEntry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
    /// Placeholder / gallery preview with sample data.
    var sample = false
}

struct ObeliskProvider: TimelineProvider {
    func placeholder(in context: Context) -> ObeliskEntry {
        ObeliskEntry(date: .now, snapshot: WidgetSample.snapshot, sample: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (ObeliskEntry) -> Void) {
        if context.isPreview, Snapshot.load() == nil {
            completion(ObeliskEntry(date: .now, snapshot: WidgetSample.snapshot, sample: true))
        } else {
            completion(ObeliskEntry(date: .now, snapshot: Snapshot.load()))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ObeliskEntry>) -> Void) {
        let s = Snapshot.load()
        // Redraw on the next minute boundaries that matter: every 15 minutes (time labels, overdue-at-a-time)
        // and just after midnight (a new day); the app also reloads the widget whenever its data changes.
        let now = Date()
        var dates = (0 ..< 8).map { now.addingTimeInterval(Double($0) * 15 * 60) }
        if let midnight = Calendar.current.nextDate(after: now, matching: DateComponents(hour: 0, minute: 1), matchingPolicy: .nextTime) {
            dates.append(midnight)
        }
        let entries = dates.sorted().map { ObeliskEntry(date: $0, snapshot: s) }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(2 * 60 * 60))))
    }
}

// MARK: - 오늘

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "today", provider: ObeliskProvider()) { entry in
            TodayWidgetView(entry: entry)
                .containerBackground(Ob.bg, for: .widget)
        }
        .configurationDisplayName("오늘")
        .description("기한 지난 작업과 오늘 할 일. 동그라미를 누르면 바로 완료돼요.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

// MARK: - 지연 위험

struct RiskWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "risk", provider: ObeliskProvider()) { entry in
            RiskWidgetView(entry: entry)
                .containerBackground(Ob.bg, for: .widget)
        }
        .configurationDisplayName("지연 위험")
        .description("기한 지난 작업 때문에 밀리는 일정과 고정 일정 충돌.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}
