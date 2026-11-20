import SwiftUI

/// 설정 home: account, then one row per settings page (web SettingsNav tabs as an iOS list).
struct SettingsHomeView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var confirmLogout = false

    var body: some View {
        List {
            Section {
                HStack(spacing: ObSpace.md) {
                    Avatar(name: store.user?.name ?? "?", size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.user?.name ?? "계정").font(ObFont.bodyStrong).foregroundStyle(Ob.text)
                        Text(store.user?.email ?? "").font(ObFont.footnote).foregroundStyle(Ob.text3)
                    }
                }
                .padding(.vertical, ObSpace.md)
                .obSettingsRow()
            }
            Section {
                ForEach(pages, id: \.self) { page in
                    NavigationLink(value: Destination.settings(page)) {
                        Label(page.label, systemImage: page.symbol)
                            .foregroundStyle(Ob.text)
                    }
                    .obSettingsRow()
                }
            }
            if store.user?.isAdmin == true {
                // 서버 관리: the server's operators only, apart from the account's own settings.
                Section {
                    NavigationLink(value: Destination.settings(.admin)) {
                        Label(SettingsPage.admin.label, systemImage: SettingsPage.admin.symbol)
                            .foregroundStyle(Ob.text)
                    }
                    .obSettingsRow()
                } footer: {
                    Text("이 서버의 운영자라서 보여요. 가입, 사용자, 서버 설정을 관리해요.")
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                }
            }
            Section {
                Button(role: .destructive) {
                    confirmLogout = true
                } label: {
                    Text("로그아웃").foregroundStyle(Ob.dangerText)
                }
                .obSettingsRow()
            } footer: {
                Text("서버 \(URL(string: Session.server)?.host() ?? Session.server)")
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
                    .padding(.top, ObSpace.sm)
            }
        }
        .obSettingsList()
        .navigationTitle("설정")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("로그아웃할까요?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("로그아웃", role: .destructive) { Task { await store.logout() } }
        }
    }

    private var pages: [SettingsPage] {
        SettingsPage.allCases.filter { $0 != .admin && ($0 != .org || store.isOrg) }
    }
}

/// One settings page, pushed from 설정 or opened directly (e.g. 계정 메뉴 › AI 연결).
struct SettingsScreen: View {
    var page: SettingsPage

    var body: some View {
        Group {
            switch page {
            case .general: GeneralSettingsView()
            case .notifications: NotificationSettingsView()
            case .org: OrgSettingsView()
            case .ai: AISettingsView()
            case .jev: JevSettingsView()
            case .webhooks: WebhooksSettingsView()
            case .admin: AdminView()
            }
        }
        .obPage()
        .navigationTitle(page.label)
        .navigationBarTitleDisplayMode(.inline)
    }
}
