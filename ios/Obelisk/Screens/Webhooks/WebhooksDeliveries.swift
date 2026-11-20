import SwiftUI

/// 전달 기록 of one outgoing webhook (web Deliveries.tsx): the last 50 deliveries, newest first, each
/// pushing its request and response.
struct WebhooksDeliveriesView: View {
    var model: WebhooksModel
    var hookId: String

    @Environment(AppStore.self) private var store

    var body: some View {
        let _ = store.now
        let list = model.logs[hookId]
        List {
            Text("최근 50건이에요. 실패하면 1분, 5분, 30분, 2시간, 6시간 뒤에 다시 보내고, 기록은 30일 동안 보관해요.")
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text2)
                .fixedSize(horizontal: false, vertical: true)
                .webhooksRow()
                .listRowSeparator(.hidden, edges: .top)
            if let list {
                if list.isEmpty {
                    VStack(spacing: ObSpace.sm) {
                        Image(systemName: "clock")
                            .font(.system(size: 18))
                            .foregroundStyle(Ob.text3)
                            .accessibilityHidden(true)
                        Text("아직 보낸 기록이 없어요. 메뉴의 ‘테스트 보내기’로 연결을 확인해 보세요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text3)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, ObSpace.xxl)
                    .webhooksRow()
                    .listRowSeparator(.hidden)
                } else {
                    ForEach(list) { d in
                        NavigationLink(value: WebhooksRoute.delivery(hookId: hookId, deliveryId: d.id)) {
                            WebhooksDeliveryRow(entry: d)
                        }
                        .webhooksRow()
                    }
                }
            } else {
                ForEach(0 ..< 3, id: \.self) { i in
                    HStack(spacing: ObSpace.md) {
                        RoundedRectangle(cornerRadius: 4).fill(Ob.surface2).frame(width: 52, height: 20)
                        RoundedRectangle(cornerRadius: 4).fill(Ob.surface2).frame(width: 140 + CGFloat(i) * 40, height: 13)
                        Spacer()
                    }
                    .accessibilityHidden(true)
                    .webhooksRow()
                }
            }
        }
        .webhooksList()
        .refreshable { await model.loadLog(hookId) }
        .task { await model.loadLog(hookId) }
        .obPage()
        .navigationTitle("전달 기록")
        .navigationSubtitle(model.outgoing(hookId)?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.loadLog(hookId) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("새로고침")
            }
        }
    }
}

/// [성공] task.created · 200 · 3분 전, then what happened.
struct WebhooksDeliveryRow: View {
    var entry: WebhooksLogEntry

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            HStack(spacing: ObSpace.sm) {
                WebhooksStatusChip(status: entry.status)
                Text(entry.event)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Ob.text2)
                    .lineLimit(1)
                Spacer(minLength: ObSpace.sm)
                Text(meta)
                    .font(ObFont.caption.monospacedDigit())
                    .foregroundStyle(Ob.text3)
                    .lineLimit(1)
                    .fixedSize()
            }
            if !entry.text.isEmpty {
                Text(entry.text)
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text)
                    .lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// "200 · 3분 전", "오류 · 3분 전", "3분 전"
    private var meta: String {
        let head = entry.responseStatus.map(String.init) ?? (entry.status == .failed ? "오류" : "")
        let when = relativeTime(entry.lastAttemptAt ?? entry.createdAt)
        return head.isEmpty ? when : "\(head) · \(when)"
    }
}

/// One delivery: state, attempts, when, the error, what was sent and what came back; 다시 보내기.
struct WebhooksDeliveryDetail: View {
    var model: WebhooksModel
    var hookId: String
    var deliveryId: String

    @Environment(AppStore.self) private var store
    /// After 다시 보내기 the screen follows the new delivery.
    @State private var current: String?

    var body: some View {
        let _ = store.now
        let id = current ?? deliveryId
        Group {
            if let e = model.entry(hookId, id), let hook = model.outgoing(hookId) {
                content(e, hook)
            } else if model.logs[hookId] == nil || model.overview == nil {
                LoadingView()
                    .task { if model.logs[hookId] == nil { await model.loadLog(hookId) } }
            } else {
                EmptyState("전달 기록을 찾을 수 없습니다", message: "기록은 30일 동안 보관해요.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .obPage()
        .navigationTitle(model.entry(hookId, id)?.event ?? "전달 기록")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func content(_ e: WebhooksLogEntry, _ hook: Webhook) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.xl) {
                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    HStack(spacing: ObSpace.sm) {
                        WebhooksStatusChip(status: e.status)
                        Text(e.event)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(Ob.text2)
                            .textSelection(.enabled)
                    }
                    if !e.text.isEmpty {
                        Text(e.text)
                            .font(ObFont.body)
                            .foregroundStyle(Ob.text)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                VStack(spacing: 0) {
                    fact("상태", stateText(e))
                    Hairline()
                    fact("시도", "\(e.attempts)/\(e.maxAttempts)회" + (e.durationMs.map { " · \($0)ms" } ?? ""))
                    Hairline()
                    fact("만든 시각", WebhooksTime.full(e.createdAt))
                }
                .padding(.horizontal, ObSpace.md)
                .obCard(padding: 0, radius: ObRadius.md)

                if let err = e.error {
                    HStack(alignment: .top, spacing: ObSpace.sm) {
                        Image(systemName: "exclamationmark.circle")
                            .foregroundStyle(Ob.danger)
                            .accessibilityHidden(true)
                        Text(err)
                            .font(ObFont.sub.weight(.medium))
                            .foregroundStyle(Ob.dangerText)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .obCallout(.danger)
                }

                bodyBlock("보낸 본문", WebhooksJSON.sentBody(hook.format, e))
                bodyBlock(
                    "응답" + (e.responseStatus.map { " · HTTP \($0)" } ?? ""),
                    e.attempts > 0 ? WebhooksJSON.response(e.responseBody) : "(아직 보내지 않음)"
                )

                HStack {
                    Spacer()
                    Button {
                        Task {
                            if let next = await model.redeliver(hookId, e) {
                                withAnimation(ObMotion.standard) { current = next.id }
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if model.redelivering == e.id {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "arrow.clockwise")
                            }
                            Text("다시 보내기")
                        }
                    }
                    .buttonStyle(.ob(.outline, size: .small))
                    .disabled(model.redelivering != nil)
                }
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.md)
            .padding(.bottom, 96)
            .id(e.id)
            .transition(.opacity)
        }
        .refreshable { await model.loadLog(hookId) }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ObSpace.md) {
            Text(label)
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .font(ObFont.sub)
                .foregroundStyle(Ob.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    /// "실패", "재시도 대기 · 오후 3:05에 다시 시도"
    private func stateText(_ e: WebhooksLogEntry) -> String {
        var s = e.status.webhooksLabel
        if e.status == .pending, let next = e.nextAttemptAt { s += " · \(WebhooksTime.clock(next))에 다시 시도" }
        return s
    }

    private func bodyBlock(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            WebhooksFieldLabel(title)
            WebhooksCodeBlock(code: text, wrap: true)
        }
    }
}
