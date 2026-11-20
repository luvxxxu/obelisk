import SwiftUI

/// One outgoing webhook (the web's row + its ⋯ menu as a screen): status, on/off, what it sends and when,
/// then 테스트 보내기 · 전달 기록 · 수정 · 서명 키 다시 만들기 · 삭제.
struct WebhooksOutgoingDetail: View {
    var model: WebhooksModel
    var hookId: String

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var sheet: WebhooksSheet?
    @State private var confirm: WebhooksConfirm?

    var body: some View {
        Group {
            if let h = model.outgoing(hookId) {
                content(h)
                    .navigationTitle(h.name)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("수정") { sheet = .outgoingForm(h) }
                        }
                    }
            } else if model.overview == nil {
                LoadingView().navigationTitle("보내는 웹훅")
            } else {
                EmptyState("웹훅을 찾을 수 없습니다", message: "삭제되었을 수 있어요.")
                    .navigationTitle("보내는 웹훅")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .obPage()
        .navigationBarTitleDisplayMode(.inline)
        .modifier(WebhooksActionHost(model: model, sheet: $sheet))
    }

    private func content(_ h: Webhook) -> some View {
        let _ = store.now
        let st = webhooksHookStatus(h)
        let schedule = h.events.contains { isScheduleEvent($0.rawValue) }
        let reminder = h.events.contains { isReminderEvent($0.rawValue) }
        return List {
            Section {
                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                        Text(st.label)
                            .font(ObFont.bodyStrong)
                            .foregroundStyle(st.tone == .danger || st.tone == .warn ? st.tone.text : Ob.text)
                        if let d = st.detail {
                            Text(d).font(ObFont.footnote).foregroundStyle(Ob.text3)
                        }
                        Spacer(minLength: 0)
                        if model.testing == h.id {
                            ProgressView().controlSize(.small).accessibilityLabel("테스트 보내는 중")
                        }
                    }
                    Text(maskWebhookUrl(h.url))
                        .font(ObFont.mono)
                        .foregroundStyle(Ob.text2)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if let reason = h.disabledReason, !h.enabled {
                        WebhooksAlertLine(tone: .warn, symbol: "exclamationmark.triangle", text: "\(reason). 주소를 확인하고 다시 켜세요.")
                    }
                }
                .accessibilityElement(children: .combine)
                .webhooksRow()
                .listRowSeparator(.hidden, edges: .top)

                Toggle(isOn: Binding(get: { h.enabled }, set: { v in Task { await model.setEnabled(h, v) } })) {
                    Text("켜기").font(ObFont.body).foregroundStyle(Ob.text)
                }
                .toggleStyle(WebhooksSwitchStyle())
                .accessibilityLabel("\(h.name) 켜기")
                .webhooksRow()
            }

            Section {
                ForEach(groups(h)) { g in
                    VStack(alignment: .leading, spacing: ObSpace.xs) {
                        Text(g.label)
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                        Text(g.events.filter { h.events.contains($0.key) }.map(\.label).joined(separator: " · "))
                            .font(ObFont.body)
                            .foregroundStyle(Ob.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .webhooksRow()
                }
            } header: {
                WebhooksSectionHead("보낼 이벤트")
            }

            Section {
                LabeledContent("보내는 형식", value: h.format.label)
                    .webhooksRow()
                LabeledContent("프로젝트 범위") {
                    Text(scopeText(h))
                        .multilineTextAlignment(.trailing)
                }
                .webhooksRow()
                if schedule {
                    LabeledContent("일정 알림 시각") {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("매일 \(webhooksHourLabel(h.alertHour))")
                            Text(h.timezone).font(ObFont.caption).foregroundStyle(Ob.text3)
                        }
                    }
                    .webhooksRow()
                }
                if reminder {
                    LabeledContent("시각 알림을 보낼 때") {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(remindLeadLabel(h.remindMinutes))
                            Text(h.timezone).font(ObFont.caption).foregroundStyle(Ob.text3)
                        }
                    }
                    .webhooksRow()
                }
            }
            .font(ObFont.body)
            .foregroundStyle(Ob.text)

            Section {
                Button {
                    Task { await model.test(h) }
                } label: {
                    Label("테스트 보내기", systemImage: "play")
                }
                .disabled(model.testing != nil)
                .webhooksRow()
                NavigationLink(value: WebhooksRoute.deliveries(h.id)) {
                    Label("전달 기록", systemImage: "checklist")
                }
                .webhooksRow()
                Button {
                    sheet = .outgoingForm(h)
                } label: {
                    Label("수정", systemImage: "square.and.pencil")
                }
                .webhooksRow()
                if h.format == .json {
                    Button {
                        confirm = .rotateSecret(h)
                    } label: {
                        Label("서명 키 다시 만들기", systemImage: "key")
                    }
                    .webhooksRow()
                    .webhooksConfirm(model, $confirm, sheet: $sheet, when: { if case .rotateSecret = $0 { true } else { false } })
                }
                Button(role: .destructive) {
                    confirm = .deleteOut(h)
                } label: {
                    Label("삭제", systemImage: "trash").foregroundStyle(Ob.dangerText)
                }
                .webhooksRow()
                .webhooksConfirm(model, $confirm, sheet: $sheet, when: { if case .deleteOut = $0 { true } else { false } }, onDeleted: { dismiss() })
            } header: {
                Color.clear.frame(height: ObSpace.sm)
            }
            .foregroundStyle(Ob.text)
        }
        .webhooksList()
        .refreshable { await model.load() }
    }

    private func groups(_ h: Webhook) -> [WebhookEventGroup] {
        WEBHOOK_EVENT_GROUPS.filter { g in g.events.contains { h.events.contains($0.key) } }
    }

    /// "모든 프로젝트" or the chosen projects by name.
    private func scopeText(_ h: Webhook) -> String {
        guard let ids = h.projectIds else { return "모든 프로젝트" }
        let names = ids.map { store.project($0)?.name ?? "삭제된 프로젝트" }
        return names.isEmpty ? "고른 프로젝트만" : names.joined(separator: ", ")
    }
}
