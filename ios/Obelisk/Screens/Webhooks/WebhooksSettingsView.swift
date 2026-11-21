import SwiftUI

/// 설정 › 웹훅 (web app/(app)/settings/webhooks/page.tsx): outgoing webhooks (작업 변경과 일정 알림을
/// 보내요) and incoming ones (비밀 URL로 작업을 만들거나 바꿔요). Rows push a detail screen; creating and
/// editing happen in sheets; secrets and URLs are shown once.
struct WebhooksSettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var model = WebhooksModel()
    @State private var sheet: WebhooksSheet?
    @State private var confirm: WebhooksConfirm?

    var body: some View {
        List {
            intro
            if let failed = model.failed, model.overview == nil {
                failedState(failed)
            } else if let o = model.overview, !o.canManage {
                locked
            } else {
                outgoingSection
                incomingSection
            }
        }
        .webhooksList()
        .refreshable { await model.load() }
        .task(id: store.workspace?.id) {
            model.store = store
            // Runs again each time the page reappears (coming back from a detail): only another
            // workspace starts over; otherwise refresh in place.
            if model.workspaceId != store.workspace?.id {
                model.reset(store.workspace?.id)
            }
            await model.load()
        }
        .navigationDestination(for: WebhooksRoute.self) { route in
            WebhooksRouteView(model: model, route: route)
        }
        .modifier(WebhooksActionHost(model: model, sheet: $sheet))
    }

    // MARK: intro

    private var intro: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            Text("작업이 바뀌거나 마감이 다가오면 Slack·Discord·내 서버로 알리고, 다른 서비스에서 Obelisk로 작업을 만들거나 바꿔요.")
                .font(ObFont.sub)
                .foregroundStyle(Ob.text2)
                .fixedSize(horizontal: false, vertical: true)
            if let ws = store.workspace {
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                    WebhooksSpaceMark(workspace: ws)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                    Text(scopeLine(ws))
                        .font(ObFont.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.top, ObSpace.xs)
        .webhooksRow()
        .listRowSeparator(.hidden)
    }

    private func scopeLine(_ ws: Workspace) -> AttributedString {
        var name = AttributedString(webhooksSpaceLabel(ws))
        name.foregroundColor = Ob.text
        name.font = ObFont.footnote.weight(.medium)
        var rest = AttributedString("의 웹훅이에요." + (store.workspaces.count > 1 ? " 다른 공간은 맨 위의 공간 이름을 눌러 바꾼 뒤 설정하세요." : ""))
        rest.foregroundColor = Ob.text2
        return name + rest
    }

    private var locked: some View {
        HStack(alignment: .top, spacing: ObSpace.md) {
            Image(systemName: "lock")
                .font(.system(size: 15))
                .foregroundStyle(Ob.text2)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                Text("웹훅은 조직 소유자와 관리자만 설정할 수 있어요")
                    .font(ObFont.sub.weight(.semibold))
                    .foregroundStyle(Ob.text)
                Text("웹훅은 이 조직의 변경 내용을 외부로 보내거나 외부 요청으로 작업을 바꾸기 때문에 관리자만 다룰 수 있어요. 필요하면 관리자에게 요청하세요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .obCallout(.neutral, padding: ObSpace.lg)
        .accessibilityElement(children: .combine)
        .webhooksRow()
        .listRowSeparator(.hidden)
    }

    private func failedState(_ message: String) -> some View {
        EmptyState("웹훅을 불러오지 못했어요", message: message) {
            Button("다시 시도") { Task { await model.load() } }
                .buttonStyle(.ob(.outline, size: .small))
        }
        .webhooksRow()
        .listRowSeparator(.hidden)
    }

    // MARK: outgoing

    private var outgoingSection: some View {
        Section {
            if let o = model.overview {
                if o.webhooks.isEmpty {
                    WebhooksEmptyRow(
                        title: "아직 보내는 웹훅이 없어요",
                        message: "팀 채널에서 완료, 기한 지남, 고정 일정 충돌 알림을 받아 보세요.",
                        action: "보내는 웹훅 추가"
                    ) { sheet = .outgoingForm(nil) }
                        .webhooksRow()
                } else {
                    ForEach(o.webhooks) { h in
                        NavigationLink(value: WebhooksRoute.outgoing(h.id)) {
                            WebhooksOutgoingRow(hook: h, testing: model.testing == h.id)
                        }
                        .webhooksRow()
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            // Not role: .destructive, which removes the row before the confirmation can ask.
                            Button("삭제", systemImage: "trash") { confirm = .deleteOut(h) }
                                .tint(Ob.dangerSolid)
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button(h.enabled ? "끄기" : "켜기", systemImage: h.enabled ? "pause" : "play") {
                                Task { await model.setEnabled(h, !h.enabled) }
                            }
                            .tint(Ob.text2)
                        }
                        .contextMenu { outgoingMenu(h) }
                        .webhooksConfirm(model, $confirm, sheet: $sheet, hook: h.id)
                    }
                }
            } else {
                WebhooksSkeletonRows()
            }
        } header: {
            WebhooksSectionHead("보내는 웹훅", lead: "작업 변경과 일정 알림을 Slack, Discord, 또는 JSON을 받는 서버로 보내요.") {
                if let o = model.overview, !o.webhooks.isEmpty {
                    WebhooksAddButton { sheet = .outgoingForm(nil) }
                        .accessibilityLabel("보내는 웹훅 추가")
                }
            }
        }
    }

    @ViewBuilder
    private func outgoingMenu(_ h: Webhook) -> some View {
        Button("테스트 보내기", systemImage: "play") { Task { await model.test(h) } }
            .disabled(model.testing != nil)
        Button("전달 기록", systemImage: "checklist") { router.push(WebhooksRoute.deliveries(h.id)) }
        Button("수정", systemImage: "square.and.pencil") { sheet = .outgoingForm(h) }
        if h.format == .json {
            Button("서명 키 다시 만들기", systemImage: "key") { confirm = .rotateSecret(h) }
        }
        Divider()
        Button("삭제", systemImage: "trash", role: .destructive) { confirm = .deleteOut(h) }
    }

    // MARK: incoming

    private var incomingSection: some View {
        Section {
            if let o = model.overview {
                if o.incoming.isEmpty {
                    WebhooksEmptyRow(
                        title: "아직 받는 웹훅이 없어요",
                        message: "GitHub Actions, 아이폰 단축어, Zapier, Slack 슬래시 명령에서 작업을 만들거나 완료해 보세요.",
                        action: "받는 웹훅 추가"
                    ) { sheet = .incomingForm(nil) }
                        .webhooksRow()
                } else {
                    ForEach(o.incoming) { h in
                        NavigationLink(value: WebhooksRoute.incoming(h.id)) {
                            WebhooksIncomingRow(hook: h)
                        }
                        .webhooksRow()
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            // Not role: .destructive, which removes the row before the confirmation can ask.
                            Button("삭제", systemImage: "trash") { confirm = .deleteIn(h) }
                                .tint(Ob.dangerSolid)
                        }
                        .contextMenu {
                            Button("수정", systemImage: "square.and.pencil") { sheet = .incomingForm(h) }
                            Button("URL 다시 만들기", systemImage: "key") { confirm = .rotateUrl(h) }
                            Divider()
                            Button("삭제", systemImage: "trash", role: .destructive) { confirm = .deleteIn(h) }
                        }
                        .webhooksConfirm(model, $confirm, sheet: $sheet, hook: h.id)
                    }
                }
                WebhooksIncomingHelp(due: addDays(store.today, 3))
                    .webhooksRow()
            } else {
                WebhooksSkeletonRows()
            }
        } header: {
            WebhooksSectionHead("받는 웹훅", lead: "비밀 URL로 POST하면 작업이 만들어지거나 바뀌어요. 만든 사람의 권한으로 실행되고 활동 기록에 남아요.") {
                if let o = model.overview, !o.incoming.isEmpty {
                    WebhooksAddButton { sheet = .incomingForm(nil) }
                        .accessibilityLabel("받는 웹훅 추가")
                }
            }
        }
    }
}

// MARK: - pushed screens

struct WebhooksRouteView: View {
    var model: WebhooksModel
    var route: WebhooksRoute

    var body: some View {
        switch route {
        case let .outgoing(id): WebhooksOutgoingDetail(model: model, hookId: id)
        case let .incoming(id): WebhooksIncomingDetail(model: model, hookId: id)
        case let .deliveries(id): WebhooksDeliveriesView(model: model, hookId: id)
        case let .delivery(hookId, deliveryId): WebhooksDeliveryDetail(model: model, hookId: hookId, deliveryId: deliveryId)
        }
    }
}

// MARK: - rows

/// "+ 추가" (web small outline button in the section head).
struct WebhooksAddButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            WebhooksButtonLabel("추가", symbol: "plus")
        }
        .buttonStyle(.ob(.outline, size: .small))
    }
}

/// An empty section: what it's for and the button that starts it (web SettingsRow + button).
struct WebhooksEmptyRow: View {
    var title: String
    var message: String
    var action: String
    var run: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(ObFont.body).foregroundStyle(Ob.text)
                Text(message)
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(action: run) {
                WebhooksButtonLabel(action, symbol: "plus")
            }
            .buttonStyle(.ob(.outline, size: .small))
        }
        .padding(.vertical, ObSpace.xs)
    }
}

/// Two quiet placeholder rows while the page loads (web ListSkeleton).
struct WebhooksSkeletonRows: View {
    var body: some View {
        ForEach(0 ..< 2, id: \.self) { i in
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    RoundedRectangle(cornerRadius: 4).fill(Ob.surface2).frame(width: 140 + CGFloat(i) * 30, height: 14)
                    RoundedRectangle(cornerRadius: 4).fill(Ob.surface2).frame(width: 220, height: 11)
                }
                Spacer()
                RoundedRectangle(cornerRadius: 4).fill(Ob.surface2).frame(width: 60, height: 14)
            }
            .padding(.vertical, ObSpace.xs)
            .accessibilityHidden(true)
            .webhooksRow()
        }
    }
}

/// An outgoing webhook on the list (web .row): name · format, masked URL, events, scope and alert times,
/// why it was turned off; status on the right.
struct WebhooksOutgoingRow: View {
    var hook: Webhook
    var testing = false

    @Environment(AppStore.self) private var store

    var body: some View {
        let _ = store.now
        let st = webhooksHookStatus(hook)
        let labels = hook.events.map(\.label)
        let schedule = hook.events.contains { isScheduleEvent($0.rawValue) }
        let reminder = hook.events.contains { isReminderEvent($0.rawValue) }
        HStack(alignment: .top, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                    Text(hook.name)
                        .font(ObFont.body.weight(.medium))
                        .foregroundStyle(Ob.text)
                        .lineLimit(1)
                    Text(hook.format.label)
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                        .fixedSize()
                }
                Text(maskWebhookUrl(hook.url))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Ob.text3)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(labels.prefix(5).joined(separator: " · ") + (labels.count > 5 ? " 외 \(labels.count - 5)개" : ""))
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text2)
                    .fixedSize(horizontal: false, vertical: true)
                if hook.projectIds != nil || schedule || reminder {
                    FlowRow(spacing: ObSpace.md, lineSpacing: 2) {
                        if let ids = hook.projectIds {
                            WebhooksMeta(symbol: "folder", text: "프로젝트 \(ids.count)개")
                        }
                        if schedule {
                            WebhooksMeta(symbol: "clock", text: "매일 \(webhooksHourLabel(hook.alertHour))")
                        }
                        if reminder {
                            WebhooksMeta(symbol: "bell", text: "시각 \(remindLeadLabel(hook.remindMinutes))")
                        }
                    }
                }
                if let reason = hook.disabledReason, !hook.enabled {
                    WebhooksAlertLine(tone: .warn, symbol: "exclamationmark.triangle", text: "\(reason). 주소를 확인하고 다시 켜세요.")
                        .padding(.top, 2)
                }
            }
            .opacity(hook.enabled ? 1 : 0.55)
            Spacer(minLength: 0)
            if testing {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("테스트 보내는 중")
            } else {
                WebhooksStatusText(status: st)
            }
        }
        .animation(ObMotion.standard, value: hook.enabled)
    }
}

/// An incoming webhook on the list: name · obh_…hint, where tasks go, what it may do, whose rights;
/// how often it was used on the right.
struct WebhooksIncomingRow: View {
    var hook: IncomingWebhook

    @Environment(AppStore.self) private var store

    var body: some View {
        let _ = store.now
        let target = webhooksProjectName(store, hook.projectId)
        HStack(alignment: .top, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                    Text(hook.name)
                        .font(ObFont.body.weight(.medium))
                        .foregroundStyle(Ob.text)
                        .lineLimit(1)
                    Text("obh_…\(hook.hint)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Ob.text3)
                        .fixedSize()
                }
                FlowRow(spacing: ObSpace.md, lineSpacing: 2) {
                    WebhooksMeta(symbol: target == nil ? "tray" : "folder", text: target ?? "인박스")
                    WebhooksMeta(symbol: nil, text: hook.allowUpdates ? "만들기 · 바꾸기" : "만들기만")
                    if let by = hook.createdBy {
                        WebhooksMeta(symbol: nil, text: "\(by.name) 권한")
                    }
                }
                if let err = hook.lastError {
                    WebhooksAlertLine(tone: .danger, symbol: "exclamationmark.circle", text: "마지막 요청 실패 · \(err)")
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
            WebhooksStatusText(status: WebhooksStatus(
                tone: .neutral,
                label: hook.useCount > 0 ? "\(webhooksCount(hook.useCount))번 받음" : "아직 받은 적 없음",
                detail: hook.lastUsedAt.map { relativeTime($0) }
            ))
        }
    }
}

/// The project new tasks go to; "삭제된 프로젝트" when it is gone, nil for the inbox.
@MainActor
func webhooksProjectName(_ store: AppStore, _ id: String?) -> String? {
    guard let id else { return nil }
    return store.project(id)?.name ?? "삭제된 프로젝트"
}

/// Personal space keeps the Obelisk mark; an organization shows its initial (web WorkspaceMark, sm).
struct WebhooksSpaceMark: View {
    var workspace: Workspace
    var body: some View {
        Group {
            if workspace.kind == .personal {
                LogoMark(size: 14)
            } else {
                Text(String(workspace.name.prefix(1)))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Ob.text)
                    .frame(width: 18, height: 18)
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Ob.borderStrong, lineWidth: 1))
            }
        }
        .frame(width: 18, height: 18)
        .accessibilityHidden(true)
    }
}

/// 보낼 수 있는 내용: request formats for incoming webhooks, collapsed by default (web IncomingHelp).
struct WebhooksIncomingHelp: View {
    var due: ISODate
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open.animation(ObMotion.standard)) {
            VStack(alignment: .leading, spacing: ObSpace.lg) {
                item("텍스트", "`보고서 초안 내일 !높음 #런칭`처럼 빠른 추가와 같은 문법으로 써요. 둘째 줄부터는 메모가 돼요.\n`#12 완료` · `#12 시작` · `#12 취소` · `#12 다시 열기` · `#12 금요일까지` · `#12 !높음`")
                item("JSON 만들기", "`title`(필수), `notes`, `dueDate`·`startDate`(`\(due)` 또는 “내일”), `priority`(none·low·medium·high), `project`(이름), `assignees`(이메일·이름·me, 여러 명은 배열이나 쉼표로), `fixed`, `status`")
                item("JSON 바꾸기", "`action`(complete·start·cancel·reopen·update) + `task`(`\"#12\"`) + 바꿀 필드")
                item("응답", "`{ ok, action, task: { ref, title, url, … }, text }` · 실패하면 4xx와 `message`")
                item("Slack", "슬래시 명령의 Request URL로 쓰면 `/할일 보고서 내일`처럼 채널에서 바로 작업을 만들 수 있어요.")
            }
            .padding(.top, ObSpace.md)
        } label: {
            Text("보낼 수 있는 내용")
                .font(ObFont.sub.weight(.medium))
                .foregroundStyle(Ob.text2)
        }
        .tint(Ob.text3)
    }

    private func item(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            Text(title)
                .font(ObFont.footnote.weight(.semibold))
                .foregroundStyle(Ob.text)
            Text(webhooksRich(text))
                .font(ObFont.footnote)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}
