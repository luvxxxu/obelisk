import SwiftUI

/// 받는 웹훅 추가 / 받는 웹훅 수정 (web IncomingForm.tsx), in a sheet. After creating, the same sheet
/// shows the secret URL once with ready-to-run examples.
struct WebhooksIncomingForm: View {
    var model: WebhooksModel
    var initial: IncomingWebhook?

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    /// "" = 인박스
    @State private var projectId: String
    @State private var allowUpdates: Bool
    @State private var saving = false
    @State private var created: WebhooksRevealItem?
    @State private var detent: PresentationDetent = .medium
    @FocusState private var nameFocused: Bool

    init(model: WebhooksModel, initial: IncomingWebhook?) {
        self.model = model
        self.initial = initial
        _name = State(initialValue: initial?.name ?? "")
        _projectId = State(initialValue: initial?.projectId ?? "")
        _allowUpdates = State(initialValue: initial?.allowUpdates ?? true)
    }

    var body: some View {
        NavigationStack {
            if let created {
                WebhooksRevealContent(model: model, item: created) { dismiss() }
                    .transition(.opacity)
            } else {
                form
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .interactiveDismissDisabled(created != nil)
    }

    /// Projects new tasks may go to: live ones the user can write to (and the current one).
    private var writable: [Project] {
        store.projects
            .filter { ($0.archivedAt == nil && $0.access >= .edit) || $0.id == initial?.projectId }
            .sorted { $0.position < $1.position }
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.xxl) {
                Text("비밀 URL로 요청을 받으면 내 권한으로 작업을 만들거나 바꿔요.")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text2)

                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    WebhooksFieldLabel("이름")
                    TextField("예: GitHub Actions, 아이폰 단축어", text: $name)
                        .textFieldStyle(.ob(focused: nameFocused))
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .onSubmit { Task { await save() } }
                        .onChange(of: name) { _, v in if v.count > 80 { name = String(v.prefix(80)) } }
                        .accessibilityLabel("이름")
                    WebhooksHelp("활동 기록에 “웹훅 ‘\(JS.trim(name).isEmpty ? "이름" : JS.trim(name))’ 통해”로 남아요.")
                }

                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    WebhooksFieldLabel("새 작업을 넣을 곳")
                    Menu {
                        Picker("새 작업을 넣을 곳", selection: $projectId) {
                            Label("인박스", systemImage: "tray").tag("")
                            ForEach(writable) { p in
                                Text(p.name).tag(p.id)
                            }
                        }
                    } label: {
                        HStack(spacing: ObSpace.sm) {
                            if let p = store.project(projectId.isEmpty ? nil : projectId) {
                                ProjectSwatch(color: p.color)
                                Text(p.name).foregroundStyle(Ob.text).lineLimit(1)
                            } else {
                                Image(systemName: "tray").foregroundStyle(Ob.text3)
                                Text(projectId.isEmpty ? "인박스" : "삭제된 프로젝트").foregroundStyle(Ob.text)
                            }
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Ob.text3)
                        }
                        .font(ObFont.body)
                        .padding(.horizontal, ObSpace.md)
                        .frame(minHeight: ObSize.controlLg)
                        .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                        .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.input, lineWidth: 1))
                        .contentShape(Rectangle())
                    }
                    .accessibilityLabel("새 작업을 넣을 곳")
                    .accessibilityValue(store.project(projectId.isEmpty ? nil : projectId)?.name ?? "인박스")
                    WebhooksHelp("요청에 project를 적으면 그 프로젝트로 들어가요 (쓰기 권한이 있는 곳만).")
                }

                Toggle(isOn: $allowUpdates) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("기존 작업 바꾸기 허용")
                            .font(ObFont.body)
                            .foregroundStyle(Ob.text)
                        Text("“#12 완료”, 마감일·우선순위 변경 같은 요청도 받아요."
                            + (projectId.isEmpty ? " 내가 쓰기 권한을 가진 작업이면 어디든 바꿀 수 있어요." : " 고른 프로젝트의 작업만 바꿀 수 있어요."))
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .toggleStyle(WebhooksSwitchStyle())
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.sm)
            .padding(.bottom, ObSpace.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .obPage()
        .navigationTitle(initial == nil ? "받는 웹훅 추가" : "받는 웹훅 수정")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("취소") { dismiss() }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            WebhooksFooterBar {
                Button {
                    Task { await save() }
                } label: {
                    Text(saving ? "저장하는 중…" : initial == nil ? "URL 만들기" : "저장")
                }
                .buttonStyle(.ob(.primary, fullWidth: true))
                .disabled(JS.trim(name).isEmpty || saving)
            }
        }
        .onAppear { if initial == nil { nameFocused = true } }
    }

    private func save() async {
        guard !JS.trim(name).isEmpty, !saving else { return }
        saving = true
        nameFocused = false
        let input = CreateIncomingWebhookInput(
            name: JS.trim(name),
            projectId: .some(projectId.isEmpty ? nil : projectId),
            allowUpdates: allowUpdates
        )
        guard let (hook, url) = await model.saveIncoming(initial, input) else {
            saving = false
            return
        }
        if let url {
            Haptics.success()
            detent = .large
            withAnimation(ObMotion.standard) {
                created = WebhooksRevealItem(kind: .url(hook, url), fresh: true)
            }
        } else {
            store.toasts.show("저장했어요")
            dismiss()
        }
    }
}

// MARK: - shown once

/// A rotated secret or URL in its own sheet.
struct WebhooksRevealSheet: View {
    var model: WebhooksModel
    var item: WebhooksRevealItem

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WebhooksRevealContent(model: model, item: item) { dismiss() }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled()
    }
}

/// The secret or URL, shown once with copy and share, how to use it, and (right after creating an
/// outgoing webhook) 테스트 보내기 (web RevealModal).
struct WebhooksRevealContent: View {
    var model: WebhooksModel
    var item: WebhooksRevealItem
    var done: () -> Void

    @Environment(AppStore.self) private var store
    @State private var result: WebhooksLogEntry?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.xxl) {
                switch item.kind {
                case let .secret(hook, secret):
                    if hook.format == .json {
                        VStack(alignment: .leading, spacing: ObSpace.sm) {
                            WebhooksFieldLabel("서명 키")
                            WebhooksCopyField(value: secret, label: "서명 키", done: "서명 키를 복사했어요")
                            WebhooksHelp("지금 복사해 두세요. 다시 볼 수 없어요. 모든 요청에 X-Obelisk-Signature 헤더로 서명이 붙어요.")
                        }
                        VStack(alignment: .leading, spacing: ObSpace.sm) {
                            WebhooksFieldLabel("받는 쪽에서 서명 확인하기")
                            WebhooksCodeBlock(code: WEBHOOKS_VERIFY_SNIPPET)
                        }
                    } else {
                        Text("이제 고른 이벤트가 \(hook.format.label) 채널로 가요. 테스트 메시지로 연결을 확인해 보세요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if item.fresh { testBox(hook) }
                case let .url(hook, url):
                    VStack(alignment: .leading, spacing: ObSpace.sm) {
                        WebhooksFieldLabel("URL")
                        WebhooksCopyField(value: url, label: "받는 웹훅 URL", done: "URL을 복사했어요")
                        WebhooksHelp("이 URL을 아는 누구나 내 권한으로 작업을 만들 수 있어요. 지금 복사해 두세요. 다시 볼 수 없어요.")
                    }
                    ForEach(webhooksIncomingExamples(url, allowUpdates: hook.allowUpdates, due: addDays(store.today, 3)), id: \.title) { ex in
                        VStack(alignment: .leading, spacing: ObSpace.sm) {
                            WebhooksFieldLabel(ex.title)
                            WebhooksCodeBlock(code: ex.code)
                        }
                    }
                }
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.sm)
            .padding(.bottom, ObSpace.xxl)
        }
        .obPage()
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            WebhooksFooterBar {
                Button("완료", action: done)
                    .buttonStyle(.ob(.primary, fullWidth: true))
            }
        }
    }

    private func testBox(_ hook: Webhook) -> some View {
        let busy = model.testing == hook.id
        return HStack(spacing: ObSpace.md) {
            Button {
                result = nil
                Task { result = await model.test(hook, inline: true) }
            } label: {
                HStack(spacing: 6) {
                    if busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "play")
                    }
                    Text("테스트 보내기")
                }
            }
            .buttonStyle(.ob(.outline))
            .disabled(busy)
            if let r = result {
                let ok = r.status == .success
                Label(
                    ok ? "받았어요 · HTTP \(r.responseStatus.map(String.init) ?? "")" : (r.error ?? "실패"),
                    systemImage: ok ? "checkmark.circle" : "xmark.circle"
                )
                .font(ObFont.sub.weight(.medium))
                .foregroundStyle(ok ? Ob.okText : Ob.dangerText)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
            }
            Spacer(minLength: 0)
        }
        .animation(ObMotion.standard, value: result?.id)
    }
}
