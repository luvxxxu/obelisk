import SwiftUI

/// The top-bar title: "개인 공간 ⌄", like ChatGPT's model picker. A native menu of spaces,
/// 모아보기 (when there is more than one), organization settings and 새 조직 만들기.
struct WorkspaceSwitcher: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        Menu {
            if store.workspaces.count > 1 {
                Button {
                    router.open(.overview)
                } label: {
                    Label("모아보기", systemImage: "square.grid.2x2")
                    Text("모든 공간에서 내가 할 일")
                }
                Divider()
            }

            Section("공간") {
                ForEach(store.workspaces) { w in
                    Button {
                        guard w.id != store.workspace?.id else { return }
                        Haptics.select()
                        router.open(.home)
                        Task { await store.switchWorkspace(w.id) }
                    } label: {
                        if w.id == store.workspace?.id {
                            Label(w.name, systemImage: "checkmark")
                        } else {
                            Text(w.name)
                        }
                        Text(w.kind == .personal ? "나만 보는 공간" : "멤버 \(w.memberCount)명")
                    }
                }
            }

            if store.isOrg {
                Section {
                    Button {
                        router.openSettings(.org)
                    } label: {
                        Label("조직 설정", systemImage: "building.2")
                    }
                    if store.isWorkspaceAdmin {
                        Button {
                            router.openSettings(.org)
                            router.present(.init(id: "invite-members", detents: [.medium, .large]) { InviteMembersSheet() })
                        } label: {
                            Label("멤버 초대", systemImage: "person.badge.plus")
                        }
                    }
                }
            }

            // An operator may keep organizations to themselves (서버 관리 → 가입 → 조직 만들기).
            if store.server.canCreateOrg {
                Section {
                    Button {
                        router.present(.init(id: "create-workspace", detents: [.medium]) { CreateWorkspaceSheet() })
                    } label: {
                        Label("새 조직 만들기", systemImage: "plus")
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(store.workspace?.name ?? "Obelisk")
                    .font(.headline)
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Ob.text3)
            }
            .padding(.horizontal, ObSpace.sm)
            .frame(minHeight: 36)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("공간 전환, 지금: \(store.workspace?.name ?? "")")
        }
        .menuOrder(.fixed)
    }
}
