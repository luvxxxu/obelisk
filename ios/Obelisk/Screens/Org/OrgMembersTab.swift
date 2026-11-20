import SwiftUI

/// 조직 › 멤버 (web MembersTab + InvitesCard): who is in the organization and their role, then the
/// invite links (admins). Owners change anyone; admins change admins and members; everyone can leave.
struct OrgMembersTab: View {
    var reload: Int

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var query = ""
    @State private var removing: Member?

    private var ws: Workspace? { store.workspace }
    private var admin: Bool { isWorkspaceAdmin(ws?.role) }
    private var owner: Bool { ws?.role == .owner }

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            members
            if admin { OrgInvitesSection(reload: reload, onCreate: openInvite) }
        }
    }

    // MARK: members

    private var filtered: [Member] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return store.members }
        return store.members.filter { $0.name.lowercased().contains(q) || $0.email.lowercased().contains(q) }
    }

    private var members: some View {
        OrgSection(
            "멤버 \(store.members.count)명",
            lead: "멤버는 공유받은 프로젝트만 볼 수 있어요. 소유자와 관리자는 모든 프로젝트를 관리하고 멤버·팀·초대 링크를 다뤄요."
        ) {
            if admin {
                Button(action: openInvite) {
                    Label("멤버 초대", systemImage: "person.badge.plus")
                }
                .buttonStyle(.ob(.primary, size: .small))
            }
        } content: {
            VStack(spacing: ObSpace.md) {
                if store.members.count > 6 {
                    OrgSearchField(prompt: "이름이나 이메일로 찾기", text: $query, label: "멤버 찾기")
                }
                OrgCard(inset: 60) {
                    ForEach(filtered) { m in
                        row(m)
                    }
                    if filtered.isEmpty {
                        OrgEmptyRow(text: "‘\(query)’에 맞는 멤버가 없어요")
                    }
                }
            }
        }
    }

    private func isMe(_ m: Member) -> Bool { m.id == store.user?.id }

    /// Owners are changed only by owners; admins handle admins and members.
    private func editable(_ m: Member) -> Bool { admin && !(m.role == .owner && !owner) }

    private func row(_ m: Member) -> some View {
        let me = isMe(m)
        let joined = relativeTime(m.joinedAt).replacingOccurrences(of: "사용 기록 없음", with: "")
        let teamNames = m.teamIds.compactMap { id in store.teams.first { $0.id == id }?.name }
        return HStack(alignment: .center, spacing: ObSpace.md) {
            Avatar(name: m.name, size: 32)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 0) {
                    Text(m.name).foregroundStyle(Ob.text)
                    if me { Text(" (나)").foregroundStyle(Ob.text3) }
                }
                .font(ObFont.body)
                .lineLimit(1)
                HStack(spacing: 0) {
                    Text(m.email)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(" · \(joined) 참여")
                        .lineLimit(1)
                        .fixedSize()
                }
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                if !teamNames.isEmpty {
                    FlowRow(spacing: 4, lineSpacing: 4) {
                        ForEach(Array(teamNames.prefix(3).enumerated()), id: \.offset) { _, name in
                            Chip(text: name, filled: true)
                        }
                        if teamNames.count > 3 { Chip(text: "+\(teamNames.count - 3)", filled: true) }
                    }
                    .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            roleControl(m, me: me)
                // Anchored to the role control, so the popover points at the person it is about.
                .confirmationDialog(
                    me ? "조직을 나갈까요?" : "\(m.name)님을 내보낼까요?",
                    isPresented: Binding(get: { removing?.id == m.id }, set: { if !$0 { removing = nil } }),
                    titleVisibility: .visible
                ) {
                    Button(me ? "나가기" : "내보내기", role: .destructive) {
                        Task {
                            if me { await leave() } else { await remove(m) }
                        }
                    }
                    Button("취소", role: .cancel) {}
                } message: {
                    Text(me
                        ? "이 조직의 프로젝트와 작업에 더 이상 접근할 수 없어요. 다시 들어오려면 초대 링크가 필요해요."
                        : "이 조직의 프로젝트 권한과 팀 소속이 사라지고, 맡고 있던 작업은 담당자 없음이 돼요. 만든 작업은 그대로 남아요.")
                }
        }
        .orgRow(vertical: 10)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func roleControl(_ m: Member, me: Bool) -> some View {
        if editable(m) {
            Menu {
                Section("역할") {
                    ForEach(WorkspaceRole.allCases.filter { $0 != .owner || owner }, id: \.self) { r in
                        // A toggle per role: menus draw it with a check column and a subtitle (web ROLE_HINT).
                        Toggle(isOn: Binding(
                            get: { m.role == r },
                            set: { on in
                                guard on, r != m.role else { return }
                                Task { await setRole(m, r) }
                            }
                        )) {
                            Text(r.labelKo)
                            Text(orgRoleHint(r))
                        }
                    }
                }
                Section {
                    Button(role: .destructive) {
                        removing = m
                    } label: {
                        Label(me ? "조직 나가기" : "내보내기", systemImage: me ? "rectangle.portrait.and.arrow.right" : "person.badge.minus")
                    }
                }
            } label: {
                OrgRoleLabel(role: m.role, chevron: true)
            }
            .menuOrder(.fixed)
            .accessibilityLabel("\(m.name) 역할, \(m.role.labelKo)")
        } else if me {
            Menu {
                Button(role: .destructive) {
                    removing = m
                } label: {
                    Label("조직 나가기", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                OrgRoleLabel(role: m.role, chevron: true)
            }
            .accessibilityLabel("내 역할, \(m.role.labelKo)")
        } else {
            OrgRoleLabel(role: m.role, chevron: false)
        }
    }

    // MARK: actions

    private func openInvite() {
        router.present(.init(id: "invite-members", detents: [.medium, .large]) { InviteMembersSheet() })
    }

    private func setRole(_ m: Member, _ role: WorkspaceRole) async {
        guard let ws else { return }
        do {
            try await API.shared.send(.patch, "/api/workspaces/\(ws.id)/members/\(m.id)", json: ["role": .string(role.rawValue)])
            await store.refresh()
            store.toasts.show("\(m.name)님을 \(role.labelKo)(으)로 바꿨어요")
        } catch {
            store.report(error)
        }
    }

    private func remove(_ m: Member) async {
        guard let ws else { return }
        do {
            try await API.shared.send(.delete, "/api/workspaces/\(ws.id)/members/\(m.id)")
            await store.refresh()
            store.toasts.show("\(m.name)님을 조직에서 내보냈어요")
        } catch {
            store.report(error)
        }
    }

    private func leave() async {
        await orgLeave(store: store, router: router)
    }
}

/// Leave the open organization (DELETE yourself), then open the personal space like the web.
@MainActor
func orgLeave(store: AppStore, router: Router) async {
    guard let ws = store.workspace, let me = store.user?.id else { return }
    do {
        try await API.shared.send(.delete, "/api/workspaces/\(ws.id)/members/\(me)")
        store.toasts.show("\(ws.name)에서 나왔어요")
        await orgOpenPersonal(store: store, router: router)
    } catch {
        store.report(error)
    }
}

/// After leaving or deleting an organization: back to the top of the personal space.
@MainActor
func orgOpenPersonal(store: AppStore, router: Router) async {
    router.dismissSheet()
    router.path = NavigationPath()
    router.open(.home)
    if let personal = store.workspaces.first(where: { $0.kind == .personal }) {
        await store.switchWorkspace(personal.id)
    } else {
        await store.refresh()
    }
}

/// Role as the web shows it beside a member: muted text, owners in full ink with a crown,
/// a chevron when it opens a menu.
struct OrgRoleLabel: View {
    var role: WorkspaceRole
    var chevron: Bool

    var body: some View {
        HStack(spacing: 4) {
            if role == .owner {
                Image(systemName: "crown")
                    .font(.system(size: 11, weight: .medium))
            }
            Text(role.labelKo)
            if chevron {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Ob.text3)
            }
        }
        .font(ObFont.footnote.weight(role == .owner ? .medium : .regular))
        .foregroundStyle(role == .owner ? Ob.text : Ob.text2)
        .padding(.horizontal, chevron ? 10 : 0)
        .frame(minHeight: ObSize.controlSm)
        .background {
            if chevron { Capsule().strokeBorder(Ob.border, lineWidth: 1) }
        }
        .frame(minHeight: ObSize.row)
        .contentShape(Rectangle())
    }
}

// MARK: - Invite links

/// 초대 링크 (web InvitesCard): the links still usable, each revocable. Reloads when the invite
/// sheet makes a new one.
struct OrgInvitesSection: View {
    var reload: Int
    var onCreate: () -> Void

    @Environment(AppStore.self) private var store
    @State private var invites: [Invite]?
    @State private var revoking: Set<String> = []

    private struct Response: Decodable { var invites: [Invite] }

    var body: some View {
        OrgSection(
            "초대 링크",
            lead: "링크를 받은 사람은 가입하거나 로그인한 뒤 바로 들어와요. 서버가 새 가입을 막아 두었어도 초대 링크로는 가입할 수 있어요."
        ) {
            Button(action: onCreate) {
                Label("새 링크", systemImage: "link")
            }
            .buttonStyle(.ob(.outline, size: .small))
        } content: {
            OrgCard {
                if let invites {
                    if invites.isEmpty {
                        OrgEmptyRow(text: "사용할 수 있는 초대 링크가 없어요.")
                    } else {
                        ForEach(invites) { inv in row(inv) }
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .orgRow(vertical: ObSpace.lg)
                }
            }
            .animation(ObMotion.standard, value: invites)
        }
        .task(id: "\(store.workspace?.id ?? "")|\(reload)") { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .orgInvitesChanged)) { _ in
            Task { await load() }
        }
    }

    private func row(_ inv: Invite) -> some View {
        let uses = inv.maxUses.map { "\(inv.uses)/\($0)회 사용" } ?? "\(inv.uses)회 사용"
        let until = inv.expiresAt.map { "\(OrgDates.monthDay($0, store.timezone))까지" } ?? "만료 없음"
        let by = inv.createdBy.map { " · \($0)" } ?? ""
        return HStack(spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 3) {
                Text("\(Text("…\(inv.hint)").font(.system(.footnote, design: .monospaced))) · \(inv.role.labelKo)로 초대")
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
                Text("\(uses) · \(until)\(by)")
                    .font(ObFont.footnote.monospacedDigit())
                    .foregroundStyle(Ob.text3)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("취소") {
                Task { await revoke(inv) }
            }
            .buttonStyle(.ob(.ghost, size: .small))
            .disabled(revoking.contains(inv.id))
            .accessibilityLabel("초대 링크 …\(inv.hint) 취소")
        }
        .orgRow(vertical: 10)
    }

    private func load() async {
        guard let id = store.workspace?.id else { return }
        do {
            let r: Response = try await API.shared.get("/api/workspaces/\(id)/invites")
            invites = r.invites
        } catch is CancellationError {
            return
        } catch {
            if invites == nil { invites = [] }
        }
    }

    private func revoke(_ inv: Invite) async {
        guard let id = store.workspace?.id else { return }
        revoking.insert(inv.id)
        defer { revoking.remove(inv.id) }
        do {
            try await API.shared.send(.delete, "/api/workspaces/\(id)/invites/\(inv.id)")
            invites?.removeAll { $0.id == inv.id }
            store.toasts.show("초대 링크를 취소했어요. 이미 들어온 사람은 그대로예요.")
        } catch {
            store.report(error)
        }
    }
}
