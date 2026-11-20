import SwiftUI

/// 조직 › 일반 (web GeneralTab): the organization's name, whether members may create projects,
/// leaving, and (owners) deleting the organization.
struct OrgGeneralTab: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var name = ""
    @State private var saving = false
    @State private var confirmLeave = false
    @FocusState private var nameFocused: Bool

    private var ws: Workspace? { store.workspace }
    private var admin: Bool { isWorkspaceAdmin(ws?.role) }
    private var owner: Bool { ws?.role == .owner }
    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            info
            defaults
            dangerZone
        }
        .onAppear { name = ws?.name ?? "" }
        .onChange(of: ws?.name) { _, n in name = n ?? "" }
    }

    // MARK: 조직 정보

    private var info: some View {
        OrgSection("조직 정보", lead: "사이드바와 초대 화면에 보이는 이름이에요.") {
            OrgCard {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: ObSpace.md) {
                        Text("이름").font(ObFont.body).foregroundStyle(Ob.text)
                        Spacer(minLength: ObSpace.sm)
                        TextField("이름", text: $name)
                            .font(ObFont.body)
                            .foregroundStyle(admin ? Ob.text : Ob.text3)
                            .multilineTextAlignment(.trailing)
                            .disabled(!admin)
                            .focused($nameFocused)
                            .submitLabel(.done)
                            .onSubmit { Task { await saveName() } }
                            .onChange(of: name) { _, v in if v.count > 80 { name = String(v.prefix(80)) } }
                            .accessibilityLabel("조직 이름")
                    }
                    if !admin {
                        Text("소유자와 관리자만 바꿀 수 있어요.")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                    }
                }
                .orgRow()
                if admin {
                    OrgSaveFooter(
                        dirty: trimmed != (ws?.name ?? ""),
                        canSave: !trimmed.isEmpty && trimmed != (ws?.name ?? ""),
                        busy: saving
                    ) {
                        Task { await saveName() }
                    }
                }
            }
        }
    }

    private func saveName() async {
        guard admin, !trimmed.isEmpty, trimmed != ws?.name, !saving else { return }
        nameFocused = false
        saving = true
        defer { saving = false }
        await patch(["name": .string(trimmed)], done: "조직 이름을 바꿨어요")
    }

    // MARK: 권한 기본값

    private var defaults: some View {
        OrgSection("권한 기본값", lead: "새 프로젝트는 항상 비공개로 시작해요. 만든 사람이 관리 권한을 갖고 필요한 사람에게 공유해요.") {
            OrgCard {
                Toggle(isOn: Binding(
                    get: { ws?.membersCanCreateProjects ?? true },
                    set: { v in
                        guard admin else {
                            store.toasts.error("관리자만 바꿀 수 있어요")
                            return
                        }
                        Task {
                            await patch(
                                ["membersCanCreateProjects": .bool(v)],
                                done: v ? "멤버도 프로젝트를 만들 수 있어요" : "이제 관리자만 프로젝트를 만들 수 있어요"
                            )
                        }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("멤버도 프로젝트를 만들 수 있어요")
                            .font(ObFont.body)
                            .foregroundStyle(Ob.text)
                        Text("끄면 소유자와 관리자만 새 프로젝트를 만들 수 있어요.")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityLabel("멤버 프로젝트 생성 허용")
                .orgRow()
            }
        }
    }

    // MARK: 조직 나가기 · 삭제

    private var dangerZone: some View {
        OrgSection("조직 나가기 · 삭제") {
            OrgCard {
                row("조직 나가기", help: "이 조직의 프로젝트에 더 이상 접근할 수 없어요. 마지막 소유자는 나갈 수 없어요.") {
                    Button("나가기") { confirmLeave = true }
                        .buttonStyle(.ob(.outline, size: .small))
                        .confirmationDialog("조직을 나갈까요?", isPresented: $confirmLeave, titleVisibility: .visible) {
                            Button("나가기", role: .destructive) { Task { await orgLeave(store: store, router: router) } }
                            Button("취소", role: .cancel) {}
                        } message: {
                            Text("이 조직의 프로젝트와 작업에 더 이상 접근할 수 없어요. 다시 들어오려면 초대 링크가 필요해요.")
                        }
                }
                if owner {
                    row("조직 삭제", help: "모든 프로젝트·작업·활동 기록이 영구히 지워져요. 되돌릴 수 없어요.") {
                        Button("조직 삭제") {
                            router.present(.init(id: "org-delete", detents: [.medium, .large]) { OrgDeleteSheet() })
                        }
                        .buttonStyle(.ob(.danger, size: .small))
                    }
                }
            }
        }
    }

    private func row<C: View>(_ title: String, help: String, @ViewBuilder control: () -> C) -> some View {
        HStack(alignment: .center, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(ObFont.body).foregroundStyle(Ob.text)
                Text(help)
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control()
        }
        .orgRow()
    }

    private func patch(_ body: JSONValue, done: String) async {
        guard let ws else { return }
        do {
            try await API.shared.send(.patch, "/api/workspaces/\(ws.id)", json: body)
            await store.refresh()
            store.toasts.show(done)
        } catch {
            store.report(error)
        }
    }
}

/// 조직을 삭제할까요? (web delete Modal): type the organization's name to unlock 영구 삭제.
struct OrgDeleteSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    private var name: String { store.workspace?.name ?? "" }
    private var matches: Bool { !name.isEmpty && confirm.trimmingCharacters(in: .whitespacesAndNewlines) == name }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    OrgSheetHeader(
                        title: "조직을 삭제할까요?",
                        description: "프로젝트, 작업, 팀, 초대 링크, 활동 기록이 모두 영구히 삭제되고 모든 멤버가 접근을 잃어요."
                    )
                    VStack(alignment: .leading, spacing: ObSpace.sm) {
                        Text("확인을 위해 \(Text(name).fontWeight(.semibold).foregroundStyle(Ob.text))을(를) 입력하세요")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text2)
                        TextField(name, text: $confirm)
                            .textFieldStyle(.ob(focused: focused))
                            .focused($focused)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .onSubmit { Task { await delete() } }
                            .accessibilityLabel("확인용 조직 이름")
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await delete() }
                } label: {
                    ZStack {
                        Text("영구 삭제").opacity(busy ? 0 : 1)
                        if busy { ProgressView().tint(.white) }
                    }
                }
                .buttonStyle(.ob(.danger, size: .large, fullWidth: true))
                .disabled(!matches || busy)
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
        .onAppear { focused = true }
    }

    private func delete() async {
        guard matches, !busy, let ws = store.workspace else { return }
        busy = true
        do {
            try await API.shared.send(.delete, "/api/workspaces/\(ws.id)", json: ["confirm": .string(confirm.trimmingCharacters(in: .whitespacesAndNewlines))])
            store.toasts.show("\(ws.name) 조직을 삭제했어요")
            await orgOpenPersonal(store: store, router: router)
        } catch {
            busy = false
            store.report(error)
        }
    }
}
