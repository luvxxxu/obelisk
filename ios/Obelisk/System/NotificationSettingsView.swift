import SwiftUI
import UserNotifications

/// 설정 › 알림: reminders before start and due times, and a morning summary. iOS only (the web sends the
/// same kind of alerts through webhooks).
struct NotificationSettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var phase
    @State private var prefs = ReminderPrefs.current
    @State private var status: UNAuthorizationStatus = .notDetermined

    var body: some View {
        List {
            if status == .denied {
                Section {
                    VStack(alignment: .leading, spacing: ObSpace.sm) {
                        Text("알림이 꺼져 있어요")
                            .font(ObFont.bodyStrong)
                            .foregroundStyle(Ob.text)
                        Text("iPhone 설정에서 Obelisk 알림을 허용해야 아래 알림을 받을 수 있어요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text2)
                        Button("설정 열기") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .buttonStyle(.ob(.outline, size: .small))
                        .padding(.top, ObSpace.xs)
                    }
                    .padding(.vertical, ObSpace.xs)
                }
                .listRowBackground(Ob.warnSoft)
                .listRowSeparator(.hidden)
            }

            Section {
                Toggle(isOn: $prefs.start) {
                    row("시작 시각 알림", "시작 시각이 있는 작업, 정한 시간 전에")
                }
                .padding(.vertical, ObSpace.xs)
                .obSettingsRow()
                Toggle(isOn: $prefs.due) {
                    row("마감 시각 알림", "마감 시각이 있는 작업, 정한 시간 전에")
                }
                .padding(.vertical, ObSpace.xs)
                .obSettingsRow()
                Picker("미리 알림", selection: $prefs.lead) {
                    ForEach(REMINDER_LEAD_OPTIONS, id: \.self) { m in
                        Text(m == 0 ? "정시에" : "\(formatDurationKo(m)) 전").tag(m)
                    }
                }
                .disabled(!prefs.start && !prefs.due)
                .obSettingsRow()
            } header: {
                ObListHeader("시각 알림")
            } footer: {
                Text("모든 공간에서 내 작업이 대상이에요. 알림에서 바로 완료하거나 10분 뒤로 미룰 수 있어요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .padding(.vertical, ObSpace.sm)
            }

            Section {
                Toggle(isOn: $prefs.digest) {
                    row("아침 요약", "그날 마감인 작업과 기한 지난 작업 수")
                }
                .padding(.vertical, ObSpace.xs)
                .obSettingsRow()
                Picker("보내는 시각", selection: $prefs.digestHour) {
                    ForEach(5 ..< 13, id: \.self) { h in
                        Text(formatTimeKo(fromMinutes(h * 60))).tag(h)
                    }
                }
                .disabled(!prefs.digest)
                .obSettingsRow()
            } header: {
                ObListHeader("요약")
            }
        }
        .obSettingsList()
        .task(id: phase) { status = await Reminders.authorizationStatus() }
        .onChange(of: prefs) { _, new in
            ReminderPrefs.current = new
            Reminders.sync(store)
            Task {
                if new.anything, status == .notDetermined {
                    _ = await Reminders.authorize()
                    status = await Reminders.authorizationStatus()
                }
            }
        }
    }

    private func row(_ title: String, _ help: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(ObFont.body).foregroundStyle(Ob.text)
            Text(help).font(ObFont.footnote).foregroundStyle(Ob.text3)
        }
    }
}
