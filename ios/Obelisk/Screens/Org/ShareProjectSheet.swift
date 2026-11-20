import SwiftUI

/// Who can see and edit a project (web components/ShareDialog.tsx): what every member of the
/// organization gets, plus grants to people and teams. Changes apply immediately. Without "manage"
/// it is read-only, so anyone who can see a project can also see who else can.
struct ShareProjectSheet: View {
    var projectId: String

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var info: ProjectAccessInfo?
    @State private var busy = false
    @State private var query = ""
    @State private var addLevel: AccessLevel = .edit
    @FocusState private var adderFocused: Bool

    private struct Response: Codable { var access: ProjectAccessInfo }

    private var project: Project? { store.project(projectId) }
    private var canManage: Bool { project?.access == .manage }
    private var orgName: String { store.workspace?.name ?? "조직" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    OrgSheetHeader(
                        title: "‘\(project?.name ?? "프로젝트")’ 공유",
                        description: canManage
                            ? "바꾸면 바로 적용돼요. 소유자와 관리자는 언제나 모든 프로젝트를 관리할 수 있어요."
                            : "이 프로젝트에 누가 접근할 수 있는지 볼 수 있어요. 바꾸려면 관리 권한이 필요해요."
                    )
                    if let info {
                        VStack(alignment: .leading, spacing: ObSpace.lg) {
                            if canManage { adder(info) }
                            list(info)
                        }
                        .opacity(busy ? 0.6 : 1)
                        .allowsHitTesting(!busy)
                        .animation(ObMotion.fast, value: busy)
                        .transition(.opacity)
                    } else {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 200)
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
                .animation(ObMotion.mid, value: info == nil)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) { footer }
            .obPage()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .task(id: projectId) { await load() }
    }

    // MARK: adder

    private struct Candidate: Identifiable, Hashable {
        enum Kind { case member, team }
        var kind: Kind
        var id: String
        var name: String
        var meta: String
    }

    private func candidates(_ info: ProjectAccessInfo) -> [Candidate] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let granted = Set(info.members.map(\.userId) + info.teams.map(\.teamId))
        let teams = store.teams
            .filter { !granted.contains($0.id) }
            .map { Candidate(kind: .team, id: $0.id, name: $0.name, meta: "팀 · \($0.memberIds.count)명") }
        let people = store.members
            .filter { !granted.contains($0.id) && !isWorkspaceAdmin($0.role) }
            .map { Candidate(kind: .member, id: $0.id, name: $0.name, meta: $0.email) }
        return (teams + people)
            .filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.meta.lowercased().contains(q) }
            .prefix(8)
            .map { $0 }
    }

    private func adder(_ info: ProjectAccessInfo) -> some View {
        let showSuggestions = adderFocused || !query.trimmingCharacters(in: .whitespaces).isEmpty
        let list = candidates(info)
        return VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(spacing: ObSpace.sm) {
                Image(systemName: "person.badge.plus")
                    .font(.system(size: 15))
                    .foregroundStyle(Ob.text3)
                TextField("멤버나 팀 이름으로 추가", text: $query)
                    .font(ObFont.body)
                    .focused($adderFocused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { if let first = list.first { add(first) } }
                    .accessibilityLabel("멤버나 팀 추가")
                ShareLevelMenu(
                    value: addLevel.rawValue,
                    options: AccessLevel.allCases.map(\.rawValue),
                    label: "추가할 권한"
                ) { v in
                    if let l = AccessLevel(rawValue: v) { addLevel = l }
                }
            }
            .padding(.leading, ObSpace.md)
            .padding(.trailing, ObSpace.xs)
            .frame(minHeight: ObSize.controlLg)
            .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: ObRadius.md)
                    .strokeBorder(adderFocused ? Ob.text3 : Ob.input, lineWidth: 1)
            )

            if showSuggestions {
                OrgCard(inset: 60) {
                    if list.isEmpty {
                        OrgEmptyRow(text: "추가할 수 있는 멤버나 팀이 없어요")
                    } else {
                        ForEach(list) { c in
                            Button {
                                add(c)
                            } label: {
                                HStack(spacing: ObSpace.md) {
                                    if c.kind == .team {
                                        OrgTeamMark(size: 32)
                                    } else {
                                        Avatar(name: c.name, size: 32)
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(c.name).font(ObFont.body).foregroundStyle(Ob.text).lineLimit(1)
                                        Text(c.meta).font(ObFont.footnote).foregroundStyle(Ob.text3).lineLimit(1)
                                    }
                                    Spacer(minLength: ObSpace.sm)
                                    Text("\(addLevel.labelKo)로 추가")
                                        .font(ObFont.footnote)
                                        .foregroundStyle(Ob.text3)
                                }
                                .orgRow(vertical: 10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(OrgPressStyle())
                        }
                    }
                }
                .transition(.opacity)
            }
        }
        .animation(ObMotion.standard, value: showSuggestions)
    }

    private func add(_ c: Candidate) {
        query = ""
        let level = addLevel
        let grant: JSONValue = c.kind == .team
            ? ["teams": [["teamId": .string(c.id), "level": .string(level.rawValue)]]]
            : ["members": [["userId": .string(c.id), "level": .string(level.rawValue)]]]
        Task {
            await apply(grant, done: "\(c.name)\(c.kind == .team ? " 팀" : "님")에게 \(level.labelKo) 권한을 줬어요")
        }
    }

    // MARK: list

    private func list(_ info: ProjectAccessInfo) -> some View {
        let admins = store.members.filter { isWorkspaceAdmin($0.role) }
        let teamGrants = info.teams.compactMap { g in store.teams.first { $0.id == g.teamId }.map { (g, $0) } }
        let memberGrants = info.members.compactMap { g in
            store.members.first { $0.id == g.userId && !isWorkspaceAdmin($0.role) }.map { (g, $0) }
        }

        return OrgCard(inset: 60) {
            // Everyone in the organization.
            row(
                mark: AnyView(Image(systemName: "building.2").orgShareMark()),
                name: Text("\(orgName)의 모든 멤버"),
                meta: Self.levelHint(info.memberAccess.rawValue)
            ) {
                ShareLevelMenu(
                    value: info.memberAccess.rawValue,
                    options: MemberAccess.allCases.map(\.rawValue),
                    label: "조직 전체 권한",
                    disabled: !canManage
                ) { v in
                    guard let m = MemberAccess(rawValue: v), m != info.memberAccess else { return }
                    Task {
                        await apply(
                            ["memberAccess": .string(m.rawValue)],
                            done: m == .none ? "이제 초대한 사람만 볼 수 있어요" : "조직 전체에 \(m.labelKo) 권한을 줬어요"
                        )
                    }
                }
            }

            ForEach(teamGrants, id: \.0.teamId) { g, team in
                row(mark: AnyView(OrgTeamMark(size: 32)), name: Text(team.name), meta: "팀 · \(team.memberIds.count)명") {
                    ShareLevelMenu(
                        value: g.level.rawValue,
                        options: AccessLevel.allCases.map(\.rawValue),
                        label: "\(team.name) 팀 권한",
                        disabled: !canManage,
                        onRemove: canManage ? {
                            Task { await apply(["teams": [["teamId": .string(g.teamId), "level": .null]]]) }
                        } : nil
                    ) { v in
                        guard v != g.level.rawValue else { return }
                        Task { await apply(["teams": [["teamId": .string(g.teamId), "level": .string(v)]]]) }
                    }
                }
            }

            ForEach(memberGrants, id: \.0.userId) { g, m in
                let me = g.userId == store.user?.id
                row(
                    mark: AnyView(Avatar(name: m.name, size: 32)),
                    name: Text("\(m.name)\(Text(me ? " (나)" : "").foregroundStyle(Ob.text3))"),
                    meta: m.email
                ) {
                    ShareLevelMenu(
                        value: g.level.rawValue,
                        options: AccessLevel.allCases.map(\.rawValue),
                        label: "\(m.name) 권한",
                        disabled: !canManage,
                        onRemove: canManage ? {
                            Task { await apply(["members": [["userId": .string(g.userId), "level": .null]]]) }
                        } : nil
                    ) { v in
                        guard v != g.level.rawValue else { return }
                        Task { await apply(["members": [["userId": .string(g.userId), "level": .string(v)]]]) }
                    }
                }
            }

            // Owners and admins: always manage.
            row(
                mark: AnyView(Image(systemName: "shield").orgShareMark()),
                name: Text("소유자 · 관리자 \(admins.count)명"),
                meta: admins.map { "\($0.name)(\($0.role.labelKo))" }.joined(separator: ", ")
            ) {
                Text("항상 관리")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
            }
        }
        .animation(ObMotion.standard, value: info)
    }

    private func row<Control: View>(mark: AnyView, name: Text, meta: String, @ViewBuilder control: () -> Control) -> some View {
        HStack(spacing: ObSpace.md) {
            mark
            VStack(alignment: .leading, spacing: 2) {
                name
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
                Text(meta)
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control()
        }
        .orgRow(vertical: 10)
    }

    /// web LEVEL_HINT.
    static func levelHint(_ raw: String) -> String {
        switch raw {
        case "none": "초대한 사람만"
        case "view": "작업을 볼 수 있어요"
        case "edit": "작업을 추가·수정·삭제할 수 있어요"
        case "manage": "공유·이름·보관·삭제까지"
        default: ""
        }
    }

    // MARK: footer

    private var footer: some View {
        HStack(spacing: ObSpace.md) {
            Text(info.map { i in "멤버 \(i.effective.count)명 중 \(i.effective.filter { $0.level != nil }.count)명이 볼 수 있어요" } ?? " ")
                .font(ObFont.footnote.monospacedDigit())
                .foregroundStyle(Ob.text3)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                orgCopy(Session.server + "/projects/\(projectId)", toast: "프로젝트 링크를 복사했어요", store: store)
            } label: {
                Label("링크 복사", systemImage: "link")
            }
            .buttonStyle(.ob(.outline, size: .small))
        }
        .padding(.horizontal, ObSpace.page)
        .padding(.vertical, ObSpace.sm)
        .background(Ob.bg)
        .overlay(alignment: .top) { Hairline() }
    }

    // MARK: network

    private func load() async {
        // Sharing exists only in organizations (the web shows this dialog only there).
        guard store.isOrg else {
            dismiss()
            return
        }
        do {
            let r: Response = try await API.shared.get("/api/projects/\(projectId)/access")
            info = r.access
        } catch is CancellationError {
            return
        } catch {
            store.report(error)
            dismiss()
        }
    }

    private func apply(_ patch: JSONValue, done: String? = nil) async {
        busy = true
        defer { busy = false }
        do {
            let r: Response = try await API.shared.send(.put, "/api/projects/\(projectId)/access", json: patch)
            info = r.access
            Task { await store.refresh() }
            if let done { store.toasts.show(done) }
        } catch {
            store.report(error)
        }
    }
}

/// web LevelSelect: the current level with a chevron; a menu of levels, plus 권한 제거 when allowed.
/// Read-only (no manage access) shows the level as plain text.
struct ShareLevelMenu: View {
    var value: String
    var options: [String]
    var label: String
    var disabled = false
    var onRemove: (() -> Void)?
    var onChange: (String) -> Void

    init(value: String, options: [String], label: String, disabled: Bool = false, onRemove: (() -> Void)? = nil, onChange: @escaping (String) -> Void) {
        self.value = value
        self.options = options
        self.label = label
        self.disabled = disabled
        self.onRemove = onRemove
        self.onChange = onChange
    }

    var body: some View {
        if disabled {
            Text(orgLevelLabel(value))
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text2)
                .accessibilityLabel("\(label), \(orgLevelLabel(value))")
        } else {
            Menu {
                Picker(label, selection: Binding(get: { value }, set: { onChange($0) })) {
                    ForEach(options, id: \.self) { o in
                        Text(orgLevelLabel(o)).tag(o)
                    }
                }
                if let onRemove {
                    Divider()
                    Button("권한 제거", role: .destructive, action: onRemove)
                }
            } label: {
                HStack(spacing: 4) {
                    Text(orgLevelLabel(value))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Ob.text3)
                }
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text)
                .padding(.horizontal, 10)
                .frame(minHeight: ObSize.controlSm)
                .background(Capsule().strokeBorder(Ob.border, lineWidth: 1))
                .frame(minHeight: ObSize.row)
                .contentShape(Rectangle())
            }
            .menuOrder(.fixed)
            .accessibilityLabel("\(label), \(orgLevelLabel(value))")
        }
    }
}

extension Image {
    /// web .orgMark: a glyph in an outlined disc, the size of a row avatar.
    fileprivate func orgShareMark() -> some View {
        self
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Ob.text2)
            .frame(width: 32, height: 32)
            .overlay(Circle().strokeBorder(Ob.borderStrong, lineWidth: 1))
            .accessibilityHidden(true)
    }
}
