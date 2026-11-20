import SwiftUI

/// 서버 관리 › 기록 (web admin/log): what operators did, newest first.
struct AdminLogTab: View {
    var reload: Int

    @Environment(AppStore.self) private var store
    @State private var entries: [AdminLogEntry]?
    @State private var total = 0
    @State private var error: String?
    @State private var busy = false

    private static let page = 50

    var body: some View {
        OrgSection(entries == nil ? "기록" : "기록 \(formatCount(total))개") {
            VStack(alignment: .leading, spacing: ObSpace.md) {
                if let error { AdminErrorCallout(message: error) }
                if let entries {
                    OrgCard {
                        if entries.isEmpty { OrgEmptyRow(text: "아직 기록이 없어요") }
                        ForEach(entries) { e in row(e) }
                    }
                    if entries.count < total {
                        AdminMoreButton(label: "더 보기", busy: busy) { Task { await more() } }
                    }
                } else if error == nil {
                    AdminLoading()
                }
            }
        }
        .task(id: reload) { await load() }
    }

    private func row(_ e: AdminLogEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                Text("\(Text(e.actorName).fontWeight(.medium).foregroundStyle(Ob.text)) · \(e.describedKo)")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(relativeTime(e.createdAt))
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
                    .fixedSize()
                    .accessibilityLabel(AdminDates.dateTime(e.createdAt))
            }
            if !e.targetLabel.isEmpty {
                Text(e.targetLabel)
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .lineLimit(2)
            }
        }
        .orgRow(vertical: 10)
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        do {
            let r: AdminLogPage = try await API.shared.get("/api/admin/log", query: ["limit": String(Self.page)])
            entries = r.entries
            total = r.total ?? r.entries.count
            error = nil
        } catch is CancellationError {
        } catch {
            if entries == nil { self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했어요" }
        }
    }

    private func more() async {
        guard let entries else { return }
        busy = true
        defer { busy = false }
        do {
            let r: AdminLogPage = try await API.shared.get("/api/admin/log", query: ["limit": String(Self.page), "offset": String(entries.count)])
            self.entries = entries + r.entries
            if let t = r.total { total = t }
        } catch {
            store.adminFailed(error, "불러오지 못했어요")
        }
    }
}
