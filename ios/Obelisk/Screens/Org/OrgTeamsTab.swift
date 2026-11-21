import SwiftUI

/// 조직 › 팀 (web TeamsTab): groups of members that share projects together. Admins create, edit
/// (name + members) and delete them; everyone else sees who is in which team.
struct OrgTeamsTab: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var deleting: Team?

    private var admin: Bool { isWorkspaceAdmin(store.workspace?.role) }

    var body: some View {
        OrgSection(
            "팀 \(store.teams.count)개",
            lead: "팀에 프로젝트를 공유하면 팀원 모두가 같은 권한을 받아요. 사람이 바뀌어도 팀 구성만 고치면 돼요."
        ) {
            if admin {
                Button {
                    edit(nil)
                } label: {
                    Label("새 팀", systemImage: "plus")
                }
                .buttonStyle(.ob(.primary, size: .small))
            }
        } content: {
            OrgCard {
                if store.teams.isEmpty {
                    OrgEmptyRow(text: admin
                        ? "아직 팀이 없어요. ‘디자인’, ‘개발’처럼 자주 함께 공유받는 사람들을 묶어 보세요."
                        : "아직 팀이 없어요.")
                } else {
                    ForEach(store.teams) { t in row(t) }
                }
            }
            .animation(ObMotion.standard, value: store.teams)
        }
    }

    private func row(_ t: Team) -> some View {
        let members = t.memberIds.compactMap { id in store.members.first { $0.id == id } }
        let info = HStack(spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 3) {
                Text(t.name)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
                Text(members.isEmpty ? "팀원 없음" : members.map(\.name).joined(separator: ", "))
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            AvatarStack(names: members.map(\.name), size: 24, limit: 4)
        }
        .padding(.leading, ObSpace.lg)
        .padding(.trailing, admin ? 0 : ObSpace.lg)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: ObSize.row, alignment: .leading)

        // The row opens the editor (admins); the menu sits beside it, not inside the button.
        return HStack(spacing: 0) {
            if admin {
                Button {
                    edit(t)
                } label: {
                    info.contentShape(Rectangle())
                }
                .buttonStyle(OrgPressStyle())
                .accessibilityHint("팀 편집")
                Menu {
                    Button {
                        edit(t)
                    } label: {
                        Label("편집", systemImage: "pencil")
                    }
                    Button(role: .destructive) {
                        deleting = t
                    } label: {
                        Label("팀 삭제", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Ob.text2)
                        .frame(width: ObSize.row + ObSpace.sm, height: ObSize.row)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("\(t.name) 팀 메뉴")
                .confirmationDialog(
                    "‘\(t.name)’ 팀을 삭제할까요?",
                    isPresented: Binding(get: { deleting?.id == t.id }, set: { if !$0 { deleting = nil } }),
                    titleVisibility: .visible
                ) {
                    Button("삭제", role: .destructive) { Task { await delete(t) } }
                    Button("취소", role: .cancel) {}
                } message: {
                    Text("이 팀을 통해 받은 프로젝트 권한이 사라져요. 팀원 개인에게 준 권한은 그대로예요.")
                }
            } else {
                info.accessibilityElement(children: .combine)
            }
        }
    }

    private func edit(_ t: Team?) {
        router.present(.init(id: "org-team-\(t?.id ?? "new")", detents: [.large]) { OrgTeamSheet(team: t) })
    }

    private func delete(_ t: Team) async {
        guard let ws = store.workspace else { return }
        do {
            try await API.shared.send(.delete, "/api/workspaces/\(ws.id)/teams/\(t.id)")
            await store.refresh()
            store.toasts.show("팀을 삭제했어요")
        } catch {
            store.report(error)
        }
    }
}

/// 새 팀 / 팀 편집 (web TeamModal): a name and the members, picked from a searchable list.
struct OrgTeamSheet: View {
    var team: Team?

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var picked: Set<String> = []
    @State private var query = ""
    @State private var busy = false
    @FocusState private var nameFocused: Bool

    private var isNew: Bool { team == nil }
    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var list: [Member] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return store.members }
        return store.members.filter { $0.name.lowercased().contains(q) || $0.email.lowercased().contains(q) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    VStack(alignment: .leading, spacing: ObSpace.sm) {
                        Text("팀 이름")
                            .font(ObFont.footnote.weight(.medium))
                            .foregroundStyle(Ob.text2)
                        TextField("예: 디자인, 백엔드, 마케팅", text: $name)
                            .textFieldStyle(.ob(focused: nameFocused))
                            .focused($nameFocused)
                            .submitLabel(.done)
                            .onSubmit { Task { await save() } }
                            .onChange(of: name) { _, v in if v.count > 60 { name = String(v.prefix(60)) } }
                    }

                    VStack(alignment: .leading, spacing: ObSpace.sm) {
                        HStack {
                            Text("팀원")
                                .font(ObFont.footnote.weight(.medium))
                                .foregroundStyle(Ob.text2)
                            Spacer()
                            Text("\(picked.count)명 선택")
                                .font(ObFont.footnote.monospacedDigit())
                                .foregroundStyle(Ob.text3)
                        }
                        OrgSearchField(prompt: "이름이나 이메일로 찾기", text: $query, label: "팀원 찾기")
                        OrgCard(inset: 92) {
                            ForEach(list) { m in pickRow(m) }
                            if list.isEmpty {
                                OrgEmptyRow(text: "‘\(query)’에 맞는 멤버가 없어요")
                            }
                        }
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.xxl)
            }
            .scrollDismissesKeyboard(.interactively)
            .obPage()
            .navigationTitle(isNew ? "새 팀" : "팀 편집")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isNew ? "만들기" : "저장") { Task { await save() } }
                        .fontWeight(.semibold)
                        .disabled(trimmed.isEmpty || busy)
                }
            }
        }
        .onAppear {
            name = team?.name ?? ""
            picked = Set(team?.memberIds ?? [])
            if isNew { nameFocused = true }
        }
    }

    private func pickRow(_ m: Member) -> some View {
        let on = picked.contains(m.id)
        return Button {
            Haptics.select()
            if on { picked.remove(m.id) } else { picked.insert(m.id) }
        } label: {
            HStack(spacing: ObSpace.md) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(on ? Ob.primary : Ob.text4)
                Avatar(name: m.name, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.name).font(ObFont.body).foregroundStyle(Ob.text).lineLimit(1)
                    Text(m.email).font(ObFont.footnote).foregroundStyle(Ob.text3).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .orgRow(vertical: 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(OrgPressStyle())
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }

    private func save() async {
        guard !trimmed.isEmpty, !busy, let ws = store.workspace else { return }
        busy = true
        defer { busy = false }
        let body: JSONValue = ["name": .string(trimmed), "memberIds": .array(picked.sorted().map { .string($0) })]
        do {
            if let team {
                try await API.shared.send(.patch, "/api/workspaces/\(ws.id)/teams/\(team.id)", json: body)
            } else {
                try await API.shared.send(.post, "/api/workspaces/\(ws.id)/teams", json: body)
            }
            await store.refresh()
            store.toasts.show(isNew ? "‘\(trimmed)’ 팀을 만들었어요" : "팀을 저장했어요")
            dismiss()
        } catch {
            store.report(error)
        }
    }
}
