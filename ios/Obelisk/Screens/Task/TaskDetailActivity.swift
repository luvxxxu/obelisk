import SwiftUI

/// Who changed what (web TaskActivity): GET /api/tasks/:id/activity, reloaded whenever the task changes.
/// Six entries, then "이전 기록 N개 더 보기". Hidden while there is nothing to show.
struct TaskDetailActivity: View {
    var task: TaskItem

    @Environment(AppStore.self) private var store
    @State private var entries: [ActivityEntry]?
    @State private var all = false

    private struct Response: Decodable { var activity: [ActivityEntry] }

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            if let entries, !entries.isEmpty {
                TaskDetailSectionHead(icon: "clock.arrow.circlepath", title: "활동")
                // Relative times ("3분 전") move on with the app's minute clock.
                VStack(alignment: .leading, spacing: ObSpace.md) {
                    ForEach(all ? entries : Array(entries.prefix(6))) { e in
                        row(e)
                    }
                }
                .id(store.now.minutes)
                if entries.count > 6 {
                    Button(all ? "접기" : "이전 기록 \(entries.count - 6)개 더 보기") {
                        withAnimation(ObMotion.standard) { all.toggle() }
                    }
                    .font(ObFont.footnote.weight(.medium))
                    .foregroundStyle(Ob.text2)
                    .buttonStyle(.ob(.ghost, size: .small))
                    .padding(.leading, -12)
                }
            }
        }
        .task(id: "\(task.id)|\(task.updatedAt)") { await load() }
    }

    private func row(_ e: ActivityEntry) -> some View {
        let via = viaLabelKo(e.via, e.client)
        return HStack(alignment: .top, spacing: 10) {
            Avatar(name: e.actor.name, size: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text("\(Text(e.actor.name).fontWeight(.semibold).foregroundStyle(Ob.text)) \(describeActivity(e))")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text2)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 4) {
                    Text(relativeTime(e.createdAt))
                    if let via {
                        Text("·")
                        Image(systemName: e.via == .oauth ? "powerplug" : e.via == .webhook ? "link" : "key")
                            .font(.system(size: 10))
                        Text(via).lineLimit(1)
                    }
                }
                .font(ObFont.caption)
                .foregroundStyle(Ob.text3)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        do {
            let r: Response = try await API.shared.get("/api/tasks/\(task.id)/activity")
            entries = r.activity
        } catch is CancellationError {
            return
        } catch {
            if entries == nil { entries = [] }
        }
    }
}

/// "#12 · 11월 18일 생성 · 김미나 · 2회 미룸 · 11월 19일 완료" (web footer).
struct TaskDetailFooter: View {
    var task: TaskItem
    @Environment(AppStore.self) private var store

    var body: some View {
        var items = ["#\(task.number)"]
        var created = "\(Self.monthDay(task.createdAt, store.timezone)) 생성"
        if store.isOrg, let name = store.memberName(task.createdBy) { created += " · \(name)" }
        items.append(created)
        if task.postponedCount > 0 { items.append("\(task.postponedCount)회 미룸") }
        if let done = task.completedAt { items.append("\(Self.monthDay(done, store.timezone)) 완료") }
        return Text(items.joined(separator: " · "))
            .font(ObFont.caption.monospacedDigit())
            .foregroundStyle(Ob.text3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// "11월 18일" in the user's time zone (web toLocaleDateString ko-KR, month long + day).
    static func monthDay(_ iso: String, _ timezone: String) -> String {
        guard let date = ISO8601DateFormatter.parse(iso) else { return "" }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: timezone) ?? .current
        let c = cal.dateComponents([.month, .day], from: date)
        return "\(c.month ?? 1)월 \(c.day ?? 1)일"
    }
}
