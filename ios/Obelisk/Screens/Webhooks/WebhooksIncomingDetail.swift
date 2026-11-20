import SwiftUI

/// One incoming webhook (the web's row + its ⋯ menu as a screen): use count, last failure, where tasks
/// go and what it may change, then 수정 · URL 다시 만들기 · 삭제, and what a request may contain.
struct WebhooksIncomingDetail: View {
    var model: WebhooksModel
    var hookId: String

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var sheet: WebhooksSheet?
    @State private var confirm: WebhooksConfirm?

    var body: some View {
        Group {
            if let h = model.incoming(hookId) {
                content(h)
                    .navigationTitle(h.name)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("수정") { sheet = .incomingForm(h) }
                        }
                    }
            } else if model.overview == nil {
                LoadingView().navigationTitle("받는 웹훅")
            } else {
                EmptyState("받는 웹훅을 찾을 수 없습니다", message: "삭제되었을 수 있어요.")
                    .navigationTitle("받는 웹훅")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .obPage()
        .navigationBarTitleDisplayMode(.inline)
        .modifier(WebhooksActionHost(model: model, sheet: $sheet))
    }

    private func content(_ h: IncomingWebhook) -> some View {
        let _ = store.now
        let target = webhooksProjectName(store, h.projectId)
        return List {
            Section {
                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                        Text(h.useCount > 0 ? "\(webhooksCount(h.useCount))번 받음" : "아직 받은 적 없음")
                            .font(ObFont.bodyStrong)
                            .foregroundStyle(Ob.text)
                        if let at = h.lastUsedAt {
                            Text(relativeTime(at)).font(ObFont.footnote).foregroundStyle(Ob.text3)
                        }
                    }
                    HStack(spacing: ObSpace.md) {
                        Text("obh_…\(h.hint)")
                            .font(ObFont.mono)
                            .foregroundStyle(Ob.text2)
                        if let by = h.createdBy {
                            WebhooksMeta(symbol: nil, text: "\(by.name) 권한")
                        }
                    }
                    if let err = h.lastError {
                        WebhooksAlertLine(
                            tone: .danger, symbol: "exclamationmark.circle",
                            text: "마지막 요청 실패 · \(err)" + (h.lastErrorAt.map { " · \(relativeTime($0))" } ?? "")
                        )
                    }
                }
                .accessibilityElement(children: .combine)
                .webhooksRow()
                .listRowSeparator(.hidden, edges: .top)
            }

            Section {
                LabeledContent("새 작업을 넣을 곳") {
                    HStack(spacing: 6) {
                        Image(systemName: target == nil ? "tray" : "folder")
                            .imageScale(.small)
                            .foregroundStyle(Ob.text3)
                        Text(target ?? "인박스")
                    }
                }
                .webhooksRow()
                LabeledContent("기존 작업 바꾸기 허용") {
                    Text(h.allowUpdates ? "만들기 · 바꾸기" : "만들기만")
                }
                .webhooksRow()
            }
            .font(ObFont.body)
            .foregroundStyle(Ob.text)

            Section {
                Button {
                    sheet = .incomingForm(h)
                } label: {
                    Label("수정", systemImage: "square.and.pencil")
                }
                .webhooksRow()
                Button {
                    confirm = .rotateUrl(h)
                } label: {
                    Label("URL 다시 만들기", systemImage: "key")
                }
                .webhooksRow()
                .webhooksConfirm(model, $confirm, sheet: $sheet, when: { if case .rotateUrl = $0 { true } else { false } })
                Button(role: .destructive) {
                    confirm = .deleteIn(h)
                } label: {
                    Label("삭제", systemImage: "trash").foregroundStyle(Ob.dangerText)
                }
                .webhooksRow()
                .webhooksConfirm(model, $confirm, sheet: $sheet, when: { if case .deleteIn = $0 { true } else { false } }, onDeleted: { dismiss() })
            } header: {
                Color.clear.frame(height: ObSpace.sm)
            }
            .foregroundStyle(Ob.text)

            Section {
                WebhooksIncomingHelp(due: addDays(store.today, 3))
                    .webhooksRow()
            } header: {
                Color.clear.frame(height: ObSpace.sm)
            }
        }
        .webhooksList()
        .refreshable { await model.load() }
    }
}
