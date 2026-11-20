import SwiftUI

/// 새 조직 만들기 (web CreateOrgModal): a name, then the app opens the new organization's settings
/// with the invite sheet up, like the web does.
struct CreateWorkspaceSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @FocusState private var focused: Bool

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    OrgSheetHeader(
                        title: "새 조직 만들기",
                        description: "팀과 함께 쓰는 공간이에요. 프로젝트마다 누가 보고, 누가 고칠 수 있는지 정할 수 있어요."
                    )
                    VStack(alignment: .leading, spacing: ObSpace.sm) {
                        Text("조직 이름")
                            .font(ObFont.footnote.weight(.medium))
                            .foregroundStyle(Ob.text2)
                        TextField("예: 에이컴퍼니, 디자인 스튜디오", text: $name)
                            .textFieldStyle(.ob(focused: focused))
                            .focused($focused)
                            .submitLabel(.done)
                            .onSubmit(submit)
                            .onChange(of: name) { _, v in if v.count > 80 { name = String(v.prefix(80)) } }
                            .accessibilityLabel("조직 이름")
                        Text("만든 사람이 소유자가 되고, 다음 화면에서 초대 링크로 멤버를 부를 수 있어요.")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
            }
            .scrollDismissesKeyboard(.interactively)
            .obPage()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("만들기", action: submit)
                        .fontWeight(.semibold)
                        .disabled(trimmed.isEmpty)
                }
            }
        }
        .onAppear { focused = true }
    }

    /// Switching workspaces replaces the whole shell (and any sheet on it), so the sheet goes first and
    /// the work carries on outside it.
    private func submit() {
        let n = trimmed
        guard !n.isEmpty else { return }
        focused = false
        router.dismissSheet()
        router.path = NavigationPath()
        router.open(.home)
        Task { @MainActor in
            guard await store.createWorkspace(name: n) != nil else { return }
            router.openSettings(.org)
            router.present(.init(id: "invite-members", detents: [.medium, .large]) { InviteMembersSheet() })
        }
    }
}
