import SwiftUI

/// 조직 › 활동 (web ActivityTab): every change in the organization (admins) or in what you can see
/// (members), newest first, grouped by day, filtered by kind and by person, 60 at a time.
struct OrgActivityTab: View {
    var reload: Int

    @Environment(AppStore.self) private var store
    @State private var entries: [ActivityEntry]?
    @State private var more = true
    @State private var kind: OrgActivityFilter = .all
    /// "" = 모든 사람
    @State private var actor = ""
    @State private var loadingMore = false
    @State private var loadedKey = ""

    private static let pageSize = 60
    private struct Response: Decodable { var activity: [ActivityEntry] }

    private var admin: Bool { isWorkspaceAdmin(store.workspace?.role) }
    private var key: String { "\(store.workspace?.id ?? "")|\(actor)" }

    var body: some View {
        OrgSection(
            "활동",
            lead: admin
                ? "조직에서 일어난 모든 변경이에요. AI 앱이나 API 토큰으로 한 일도 표시돼요."
                : "볼 수 있는 프로젝트와 내 작업에서 일어난 변경이에요. 멤버·팀 관련 기록은 관리자만 볼 수 있어요."
        ) {
            actorMenu
        } content: {
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                Picker("종류", selection: $kind) {
                    ForEach(OrgActivityFilter.allCases.filter { admin || $0 != .people }) { f in
                        Text(f.label).tag(f)
                    }
                }
                .pickerStyle(.segmented)
                feed
            }
        }
        .task(id: "\(key)|\(reload)") { await first() }
        .onChange(of: admin) { _, isAdmin in
            if !isAdmin, kind == .people { kind = .all }
        }
    }

    // MARK: filters

    private var actorMenu: some View {
        Menu {
            Picker("사람", selection: $actor) {
                Text("모든 사람").tag("")
                ForEach(store.members) { m in
                    Text(m.name).tag(m.id)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "person")
                    .font(.system(size: 11, weight: .medium))
                Text(store.memberName(actor.isEmpty ? nil : actor) ?? "모든 사람")
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Ob.text3)
            }
            .font(ObFont.footnote)
            .foregroundStyle(Ob.text2)
            .padding(.horizontal, 10)
            .frame(minHeight: ObSize.controlSm)
            .background(Capsule().strokeBorder(Ob.border, lineWidth: 1))
            .frame(minHeight: ObSize.row)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("사람, \(store.memberName(actor.isEmpty ? nil : actor) ?? "모든 사람")")
    }

    // MARK: feed

    private var shown: [ActivityEntry] {
        (entries ?? []).filter { kind.matches(activityKind($0.action)) }
    }

    private var days: [(day: String, items: [ActivityEntry])] {
        var out: [(day: String, items: [ActivityEntry])] = []
        for e in shown {
            let day = OrgDates.dayLabel(e.createdAt, store.timezone)
            if out.last?.day == day {
                out[out.count - 1].items.append(e)
            } else {
                out.append((day, [e]))
            }
        }
        return out
    }

    @ViewBuilder
    private var feed: some View {
        if entries == nil {
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 160)
        } else if shown.isEmpty {
            Text("기록된 활동이 없어요.")
                .font(ObFont.sub)
                .foregroundStyle(Ob.text3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, ObSpace.xl)
                .padding(.horizontal, ObSpace.xs)
        } else {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(days, id: \.day) { d in
                    Text(d.day)
                        .font(ObFont.caption.weight(.medium))
                        .foregroundStyle(Ob.text3)
                        .padding(.top, ObSpace.lg)
                        .padding(.bottom, ObSpace.xs)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(d.items) { e in entry(e) }
                }
                if more {
                    Button {
                        Task { await loadMore() }
                    } label: {
                        Text(loadingMore ? "불러오는 중…" : "이전 기록 더 보기")
                    }
                    .buttonStyle(.ob(.outline, size: .small))
                    .disabled(loadingMore)
                    .frame(maxWidth: .infinity)
                    .padding(.top, ObSpace.lg)
                }
            }
            .padding(.horizontal, ObSpace.xs)
        }
    }

    private func entry(_ e: ActivityEntry) -> some View {
        let k = activityKind(e.action)
        let via = viaLabelKo(e.via, e.client)
        let project = k == .task ? store.project(e.projectId) : nil
        let showSubject = !e.subject.isEmpty && !e.action.hasPrefix("workspace.")
        var line = Text(e.actor.name).fontWeight(.medium).foregroundStyle(Ob.text)
        if showSubject {
            line = Text("\(line) · \(Text(e.subject).foregroundStyle(Ob.text))")
        }
        line = Text("\(line)\(Text(": \(describeActivity(e))").foregroundStyle(Ob.text2))")

        return HStack(alignment: .top, spacing: ObSpace.md) {
            Image(systemName: k.orgSymbol)
                .font(.system(size: 13))
                .foregroundStyle(Ob.text3)
                .frame(width: 16, height: 22)
            VStack(alignment: .leading, spacing: 3) {
                line
                    .font(ObFont.sub)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                FlowRow(spacing: ObSpace.sm, lineSpacing: 4) {
                    Text(OrgDates.time(e.createdAt, store.timezone))
                        .font(ObFont.caption.monospacedDigit())
                        .foregroundStyle(Ob.text3)
                    if let project {
                        HStack(spacing: 4) {
                            Circle().fill(project.color.palette.ink).frame(width: 6, height: 6)
                            Text(project.name).lineLimit(1)
                        }
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                    }
                    if let via {
                        HStack(spacing: 3) {
                            Image(systemName: e.via == .oauth ? "powerplug" : e.via == .webhook ? "link" : "key")
                                .font(.system(size: 9, weight: .medium))
                            Text(via).lineLimit(1)
                        }
                        .font(ObFont.micro)
                        .foregroundStyle(Ob.text2)
                        .padding(.horizontal, 6)
                        .frame(height: 18)
                        .overlay(RoundedRectangle(cornerRadius: ObRadius.xs).strokeBorder(Ob.border, lineWidth: 1))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, ObSpace.sm)
        .accessibilityElement(children: .combine)
    }

    // MARK: loading

    private func fetch(before: String? = nil) async throws -> [ActivityEntry] {
        guard let id = store.workspace?.id else { return [] }
        var q: [String: String?] = ["limit": "\(Self.pageSize)"]
        if let before { q["before"] = before }
        if !actor.isEmpty { q["actorId"] = actor }
        let r: Response = try await API.shared.get("/api/workspaces/\(id)/activity", query: q)
        return r.activity
    }

    private func first() async {
        if loadedKey != key {
            entries = nil
            loadedKey = key
        }
        do {
            let list = try await fetch()
            entries = list
            more = list.count == Self.pageSize
        } catch is CancellationError {
            return
        } catch {
            if entries == nil { entries = [] }
            store.report(error)
        }
    }

    private func loadMore() async {
        guard let last = entries?.last, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let list = try await fetch(before: last.createdAt)
            let seen = Set((entries ?? []).map(\.id))
            entries = (entries ?? []) + list.filter { !seen.contains($0.id) }
            more = list.count == Self.pageSize
        } catch is CancellationError {
            return
        } catch {
            store.report(error)
        }
    }
}

/// web KIND_FILTERS.
enum OrgActivityFilter: String, CaseIterable, Identifiable {
    case all, task, project, people
    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: "전체"
        case .task: "작업"
        case .project: "프로젝트·공유"
        case .people: "멤버·팀"
        }
    }

    func matches(_ k: ActivityKind) -> Bool {
        switch self {
        case .all: true
        case .task: k == .task
        case .project: k == .project
        case .people: k == .member || k == .team || k == .invite || k == .workspace
        }
    }
}

extension ActivityKind {
    /// web KIND_ICON mapped to SF Symbols.
    var orgSymbol: String {
        switch self {
        case .task: "checkmark.circle"
        case .project: "folder"
        case .member: "person"
        case .team: "person.2"
        case .invite: "link"
        case .workspace: "building.2"
        }
    }
}
