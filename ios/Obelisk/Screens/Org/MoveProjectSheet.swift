import SwiftUI

/// Move a project (with its tasks) to another space (web components/MoveProjectDialog.tsx), e.g. bring a
/// personal project into an organization. The server checks "manage" here and project creation there.
struct MoveProjectSheet: View {
    var projectId: String

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var target: String?
    @State private var busy = false

    private var project: Project? { store.project(projectId) }
    private var taskCount: Int { store.tasks.values.filter { $0.projectId == projectId }.count }
    private var targets: [WorkspaceSummary] { store.workspaces.filter { $0.id != store.workspace?.id } }
    private var chosen: WorkspaceSummary? { targets.first { $0.id == target } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    OrgSheetHeader(
                        title: "다른 공간으로 옮기기",
                        description: "‘\(project?.name ?? "프로젝트")’과(와) 작업 \(taskCount)개를 함께 옮겨요."
                    )
                    if targets.isEmpty {
                        Text("옮길 수 있는 다른 공간이 없어요. 맨 위의 공간 이름을 눌러 조직을 먼저 만들어 보세요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text3)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .obWell(padding: ObSpace.lg)
                    } else {
                        OrgCard(inset: 56) {
                            ForEach(targets) { w in
                                OrgSpaceOption(
                                    space: w,
                                    meta: w.kind == .personal ? "나만 보는 공간" : "멤버 \(w.memberCount)명",
                                    selected: target == w.id
                                ) {
                                    Haptics.select()
                                    withAnimation(ObMotion.fast) { target = w.id }
                                }
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("옮길 공간")
                    }
                    OrgNotes(lines: [
                        "작업 번호(#)는 옮긴 공간에서 새로 매겨져요.",
                        "이 프로젝트 밖의 작업과 연결된 선행·후속 관계는 끊어져요.",
                        "공유 설정은 초기화돼요. 옮긴 곳에서는 나와 관리자만 볼 수 있어요.",
                        "옮긴 공간의 멤버가 아닌 담당자는 해제돼요.",
                    ])
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await submit() }
                } label: {
                    ZStack {
                        Text(chosen.map { "\(orgWorkspaceLabel($0))(으)로 옮기기" } ?? "옮기기")
                            .opacity(busy ? 0 : 1)
                        if busy { ProgressView().tint(Ob.onPrimary) }
                    }
                }
                .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
                .disabled(chosen == nil || busy)
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
    }

    private func submit() async {
        guard let chosen, let project, !busy else { return }
        busy = true
        let res = await store.moveProject(project.id, to: chosen.id)
        guard let res else {
            busy = false
            return
        }
        // Opening the other space replaces the shell, so the sheet goes first.
        router.dismissSheet()
        router.path = NavigationPath()
        await store.switchWorkspace(res.workspace.id)
        router.open(.project(project.id))
        store.toasts.show(
            "‘\(project.name)’을(를) \(orgWorkspaceLabel(chosen))(으)로 옮겼어요\(res.linksCut > 0 ? " · 연결 \(res.linksCut)개를 끊었어요" : "")"
        )
    }
}
