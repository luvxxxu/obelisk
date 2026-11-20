import SwiftUI

/// 서버 관리 › 조직 (web admin/orgs): every organization's name and size, and for one whose owners are
/// all suspended, naming one of its members as owner. Never projects or tasks.
struct AdminOrgsTab: View {
    var reload: Int
    @Binding var ownerless: Bool

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var q = ""
    @State private var query = ""
    @State private var data: AdminOrgList?
    @State private var error: String?
    @State private var loadingMore = false
    @State private var bump = 0

    private static let page = 50

    var body: some View {
        OrgSection(
            data.map { "조직 \(formatCount($0.total))곳" } ?? "조직",
            lead: "소유자가 모두 정지되면 그 조직은 아무도 관리할 수 없어요. 그때만 운영자가 남은 멤버 중 한 명을 소유자로 정할 수 있어요."
        ) {
            VStack(alignment: .leading, spacing: ObSpace.md) {
                OrgSearchField(prompt: "조직 이름으로 찾기", text: $q, label: "조직 찾기")
                Picker("보기", selection: $ownerless) {
                    Text("전체").tag(false)
                    Text(data.map { $0.ownerless > 0 ? "소유자 없음 \($0.ownerless)" : "소유자 없음" } ?? "소유자 없음").tag(true)
                }
                .pickerStyle(.segmented)
                if let error { AdminErrorCallout(message: error) }
                if let data {
                    OrgCard(inset: 60) {
                        if data.orgs.isEmpty {
                            OrgEmptyRow(text: ownerless ? "소유자가 없는 조직이 없어요" : !query.isEmpty ? "‘\(query)’에 맞는 조직이 없어요" : "아직 조직이 없어요")
                        }
                        ForEach(data.orgs) { o in row(o) }
                    }
                    if data.orgs.count < data.total {
                        AdminMoreButton(label: "더 보기 (\(formatCount(data.total - data.orgs.count))곳 더)", busy: loadingMore) {
                            Task { await more() }
                        }
                    }
                } else if error == nil {
                    AdminLoading()
                }
            }
        }
        .task(id: q) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            query = q.trimmingCharacters(in: .whitespaces)
        }
        .task(id: Key(ownerless: ownerless, query: query, reload: reload, bump: bump)) { await load() }
    }

    private struct Key: Hashable {
        var ownerless: Bool
        var query: String
        var reload: Int
        var bump: Int
    }

    private func row(_ o: AdminOrg) -> some View {
        HStack(alignment: .top, spacing: ObSpace.md) {
            OrgSpaceMark(kind: .org, name: o.name, size: 32)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: ObSpace.sm) {
                    Text(o.name)
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text)
                        .lineLimit(1)
                    if o.ownerless { Chip(text: "소유자 없음", tone: .warn, filled: true) }
                }
                Text("멤버 \(formatCount(o.members)) · 프로젝트 \(formatCount(o.projects)) · 작업 \(formatCount(o.tasks)) · \(AdminDates.date(o.createdAt)) 만듦")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
                Text("소유자 \(o.owners.isEmpty ? "없음" : o.owners.map { "\($0.name)\($0.suspended ? " (정지됨)" : "")" }.joined(separator: ", "))")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
                if o.ownerless {
                    Button("소유자 지정") {
                        router.present(.init(id: "admin-recover-\(o.id)", detents: [.medium, .large]) {
                            AdminRecoverOrgSheet(org: o) { bump += 1 }
                        })
                    }
                    .buttonStyle(.ob(.outline, size: .small))
                    .padding(.top, ObSpace.xs)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .orgRow(vertical: 12)
        .accessibilityElement(children: .contain)
    }

    private func path(offset: Int) -> [String: String?] {
        [
            "offset": String(offset),
            "limit": String(Self.page),
            "ownerless": ownerless ? "true" : nil,
            "q": query.isEmpty ? nil : query,
        ]
    }

    private func load() async {
        do {
            let d: AdminOrgList = try await API.shared.get("/api/admin/orgs", query: path(offset: 0))
            data = d
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했어요"
        }
    }

    private func more() async {
        guard let data else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let d: AdminOrgList = try await API.shared.get("/api/admin/orgs", query: path(offset: data.orgs.count))
            self.data = AdminOrgList(orgs: data.orgs + d.orgs, total: d.total, ownerless: d.ownerless)
        } catch {
            store.adminFailed(error, "불러오지 못했어요")
        }
    }
}

/// ‘조직’의 소유자 지정 (web RecoverDialog): pick a member who can still sign in.
struct AdminRecoverOrgSheet: View {
    var org: AdminOrg
    var onDone: () -> Void

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var members: [AdminOrgMember]?
    @State private var pick: String?
    @State private var busy = false
    @State private var error: String?

    private var chosen: AdminOrgMember? { members?.first { $0.id == pick } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    OrgSheetHeader(
                        title: "‘\(org.name)’의 소유자 지정",
                        description: "고른 멤버가 소유자가 돼요. 조직의 활동 기록에도 서버 운영자가 지정했다고 남아요."
                    )
                    if let error {
                        Text(error)
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.dangerText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .obCallout(.danger)
                    }
                    if let members {
                        OrgCard(inset: 16) {
                            ForEach(members) { m in option(m) }
                        }
                    } else if error == nil {
                        AdminLoading(height: 80)
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await submit() }
                } label: {
                    Text(busy ? "지정하는 중…" : chosen.map { "\($0.name)님을 소유자로" } ?? "소유자로 지정")
                }
                .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
                .disabled(pick == nil || busy)
                .padding(.horizontal, ObSpace.page)
                .padding(.vertical, ObSpace.sm)
                .background(Ob.bg)
            }
            .obPage()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
            }
        }
        .task {
            struct R: Decodable { var members: [AdminOrgMember] }
            do {
                let r: R = try await API.shared.get("/api/admin/orgs/\(adminPath(org.id))/members")
                members = r.members
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했어요"
            }
        }
    }

    private func option(_ m: AdminOrgMember) -> some View {
        Button {
            guard !m.suspended else { return }
            Haptics.select()
            pick = m.id
        } label: {
            HStack(spacing: ObSpace.md) {
                Image(systemName: pick == m.id ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(pick == m.id ? Ob.text : Ob.text4)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: ObSpace.sm) {
                        Text(m.name).font(ObFont.body).foregroundStyle(Ob.text).lineLimit(1)
                        Chip(text: m.role.labelKo, filled: true)
                        if m.suspended { Chip(text: "정지됨", tone: .danger, filled: true) }
                    }
                    Text(m.email).font(ObFont.footnote).foregroundStyle(Ob.text3).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .orgRow(vertical: 10)
            .contentShape(Rectangle())
            .opacity(m.suspended ? 0.5 : 1)
        }
        .buttonStyle(OrgPressStyle())
        .disabled(m.suspended)
        .accessibilityAddTraits(pick == m.id ? [.isSelected] : [])
    }

    private func submit() async {
        guard let pick, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await API.shared.send(.post, "/api/admin/orgs/\(adminPath(org.id))/owner", json: ["userId": .string(pick)])
            Haptics.success()
            store.toasts.show("소유자를 지정했어요")
            onDone()
            dismiss()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "지정하지 못했어요"
        }
    }
}
