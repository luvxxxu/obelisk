import SwiftUI

/// 설정 › 조직 (web app/(app)/settings/org/page.tsx): the open organization's name and your role, then
/// four tabs: 멤버 (members + invite links), 팀, 활동 (activity log), 일반 (name, defaults, leave/delete).
/// The tabs stay pinned under the navigation bar while the content scrolls.
struct OrgSettingsView: View {
    @Environment(AppStore.self) private var store
    @State private var tab: OrgTab = .members
    /// Bumped by pull-to-refresh: tabs with their own data (invites, activity) reload.
    @State private var reload = 0

    var body: some View {
        if let ws = store.workspace, ws.kind == .org {
            content(ws)
        } else {
            ScrollView {
                EmptyState(
                    "조직을 열면 여기서 관리할 수 있어요",
                    message: store.server.canCreateOrg
                        ? "지금은 개인 공간이 열려 있어요. 맨 위의 공간 이름을 눌러 조직으로 전환하거나 새 조직을 만들어 보세요."
                        : "지금은 개인 공간이 열려 있어요. 맨 위의 공간 이름을 눌러 조직으로 전환하세요. 이 서버에서는 운영자만 조직을 만들 수 있어요."
                )
                .padding(.top, ObSpace.xxxl)
            }
            .obPage()
        }
    }

    private func content(_ ws: Workspace) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                header(ws)
                Section {
                    Group {
                        switch tab {
                        case .members: OrgMembersTab(reload: reload)
                        case .teams: OrgTeamsTab()
                        case .activity: OrgActivityTab(reload: reload)
                        case .general: OrgGeneralTab()
                        }
                    }
                    .id(tab)
                    .transition(.opacity)
                    .padding(.horizontal, ObSpace.page)
                    .padding(.top, ObSpace.lg)
                    .padding(.bottom, ObSpace.xxxl)
                } header: {
                    tabs
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable {
            await store.refresh()
            reload += 1
        }
        .obPage()
        .animation(ObMotion.standard, value: tab)
    }

    private func header(_ ws: Workspace) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            Text(ws.name)
                .font(ObFont.title2)
                .foregroundStyle(Ob.text)
                .accessibilityAddTraits(.isHeader)
            Text("\(ws.role.labelKo)로 참여 중 · 멤버 \(store.members.count)명 · 팀 \(store.teams.count)개")
                .font(ObFont.sub)
                .foregroundStyle(Ob.text3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, ObSpace.page)
        .padding(.top, ObSpace.md)
        .padding(.bottom, ObSpace.lg)
    }

    private var tabs: some View {
        Picker("조직 설정", selection: Binding(
            get: { tab },
            set: { t in
                guard t != tab else { return }
                Haptics.select()
                tab = t
            }
        )) {
            ForEach(OrgTab.allCases) { t in
                Text(t.label).tag(t)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, ObSpace.page)
        .padding(.vertical, ObSpace.sm)
        .background(Ob.bg)
    }
}

enum OrgTab: String, CaseIterable, Identifiable {
    case members, teams, activity, general
    var id: String { rawValue }

    var label: String {
        switch self {
        case .members: "멤버"
        case .teams: "팀"
        case .activity: "활동"
        case .general: "일반"
        }
    }
}
