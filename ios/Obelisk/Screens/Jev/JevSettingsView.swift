import SwiftUI

/// 설정 › Jev (web app/(app)/settings/jev/page.tsx): connect, replace or remove the key, pick the
/// System One service (TypeSafe, OpenRouter, Cloudflare, a custom server) and model, auto-apply, and
/// what Jev does (with the two dialogs one tap away).
struct JevSettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    enum Service: String, CaseIterable, Identifiable {
        case typesafe, openrouter, cloudflare, custom
        var id: String { rawValue }

        var label: String {
            switch self {
            case .typesafe: "TypeSafe"
            case .openrouter: "OpenRouter"
            case .cloudflare: "Cloudflare"
            case .custom: "직접 입력"
            }
        }

        var preset: JevPreset? {
            switch self {
            case .typesafe: JEV_PRESETS.first { $0.id == .typesafe }
            case .openrouter: JEV_PRESETS.first { $0.id == .openrouter }
            case .cloudflare: JEV_PRESETS.first { $0.id == .cloudflare }
            case .custom: nil
            }
        }

        var keyLabel: String {
            switch self {
            case .typesafe: "TypeSafe API 키"
            case .openrouter: "OpenRouter API 키"
            case .cloudflare: "Cloudflare API 토큰"
            case .custom: "API 키"
            }
        }

        var keyPlaceholder: String {
            switch self {
            case .typesafe: "apikey_…"
            case .openrouter: "sk-or-v1-…"
            case .cloudflare: "Workers AI 권한이 있는 토큰"
            case .custom: "Authorization: Bearer 로 보낼 키"
            }
        }

        /// "…로 전송돼요"
        var sentTo: String {
            switch self {
            case .typesafe: "TypeSafe로"
            case .openrouter: "OpenRouter로"
            case .cloudflare: "Cloudflare로"
            case .custom: "설정한 서버로"
            }
        }

        /// Where the key comes from and who bills it.
        var help: String {
            switch self {
            case .typesafe:
                "키는 [TypeSafe 콘솔](https://docs.typesafe.ai/introduction/quickstart)에서 만들 수 있어요. 요금은 보낸 글자 수(입력 토큰)만큼 TypeSafe에 청구돼요."
            case .openrouter:
                "TypeSafe 계정 없이 OpenRouter 키 하나로 Jev를 써요. 키는 [OpenRouter 설정](https://openrouter.ai/settings/keys)에서 만들고, 요금은 OpenRouter 크레딧에서 빠져요."
            case .cloudflare:
                "Cloudflare가 만든 Jev 호환 판단 모델(Clef)을 Workers AI에서 써요. 하루 10,000 뉴런까지 무료이고, 무료 플랜은 한도를 넘으면 다음 날 오전 9시까지 멈춰요. 계정 ID와 Workers AI 권한이 있는 토큰은 [이 안내](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)대로 만들 수 있어요."
            case .custom:
                "System One API(`state`·`questions` → `answers`)를 그대로 받는 서버면 어디든 돼요. 주소 끝에 `/systemone`이 없으면 자동으로 붙여요."
            }
        }

        static func of(_ baseUrl: String?) -> Service {
            switch jevPresetOf(baseUrl) {
            case .typesafe: .typesafe
            case .openrouter: .openrouter
            case .cloudflare: .cloudflare
            case nil: .custom
            }
        }

        var defaultModel: String {
            switch self {
            case .typesafe, .custom: ""
            default: preset?.models.first ?? ""
            }
        }
    }

    private static let modelNote: [String: String] = [
        "~typesafe/jev-latest": "항상 최신 Jev",
        "clef": "27B · 더 정확해요",
        "clef-flash": "9B · 더 빠르고, 같은 무료 한도로 약 6배 더 써요",
    ]

    private struct Feature: Identifiable {
        var id: String { title }
        var title: String
        var body: String
        var place: String
    }

    private static let features: [Feature] = [
        Feature(
            title: "우선순위 자동 판단",
            body: "Jev가 작업마다 놓치면 무엇을 잃는지 판단하고, 마감까지 남은 날과 기다리는 작업 수를 더해 높음·보통·낮음을 제안해요.",
            place: "홈 · 검색"
        ),
        Feature(
            title: "미룰 작업 고르기",
            body: "오늘이나 이번 주가 평소 페이스를 넘으면 미뤄도 괜찮은 일을 고르고, 고정 일정과 부딪히지 않는 여유 있는 날로 옮겨요.",
            place: "홈 · 오늘"
        ),
        Feature(
            title: "새 작업 자동 분류",
            body: "빠른 입력에 적은 내용을 보고 프로젝트, 우선순위, 고정 일정 여부를 추천해요. 제안을 누르면 바로 적용돼요.",
            place: "빠른 입력"
        ),
        Feature(
            title: "선후 관계 찾기",
            body: "먼저 끝나야 할 작업과 이 작업을 기다릴 작업을 찾아 연결을 제안해요. 연결할수록 지연 예측이 정확해져요.",
            place: "작업 상세"
        ),
    ]

    private enum FieldId: Hashable { case account, url, model, key }

    @State private var service: Service = .typesafe
    @State private var model = ""
    @State private var accountId = ""
    @State private var customUrl = ""
    @State private var key = ""
    @State private var showKey = false
    @State private var busy = false
    @State private var confirmDisconnect = false
    /// The switch as the user set it while the save is on its way.
    @State private var autoApplyDraft: Bool?
    @FocusState private var focus: FieldId?

    private var jev: JevStatus {
        store.user?.jev ?? JevStatus(connected: false, keyUnreadable: false, hint: nil, autoApply: false, baseUrl: nil, model: nil)
    }

    private var stored: Service { .of(jev.baseUrl) }

    private struct Stored: Equatable {
        var baseUrl: String?
        var model: String?
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                connectionSection
                behaviourSection
                featuresSection
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.lg)
            .padding(.bottom, ObSpace.xxxl * 2)
        }
        .scrollDismissesKeyboard(.interactively)
        .obPage()
        // The stored connection changed (loaded, saved, disconnected): show it.
        .onChange(of: Stored(baseUrl: jev.baseUrl, model: jev.model), initial: true) { _, s in
            let id = Service.of(s.baseUrl)
            service = id
            model = s.model ?? id.defaultModel
            accountId = Self.accountOf(s.baseUrl)
            customUrl = id == .custom ? (s.baseUrl ?? "") : ""
        }
        .confirmationDialog("Jev 연결을 해제할까요?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("연결 해제", role: .destructive) {
                Task { await disconnect() }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("저장된 키와 서비스 설정을 지워요. 이미 적용한 우선순위나 일정은 그대로 남아요.")
        }
        .jevAutoPilot()
    }

    // MARK: - connection

    private var badge: (text: String, tone: Tone) {
        jev.connected ? ("연결됨", .ok) : jev.keyUnreadable ? ("다시 입력 필요", .danger) : ("연결 안 됨", .neutral)
    }

    private var connectionSection: some View {
        JevSettingsSection(
            "Jev 연결",
            badge: badge,
            lead: "Jev는 TypeSafe의 판단 모델이에요. 같은 System One API를 쓰는 곳이면 어디든 연결할 수 있어요: TypeSafe, OpenRouter, 무료 한도가 있는 Cloudflare, 직접 띄운 서버. 연결하면 작업마다 중요도와 미뤄도 되는지를 판단해 주고, 날짜와 파급 계산은 Obelisk의 지연 예측 엔진이 그대로 맡아요."
        ) {
            VStack(alignment: .leading, spacing: 0) {
                if jev.keyUnreadable {
                    unreadableAlert.padding(.bottom, ObSpace.md)
                }
                if jev.connected || jev.keyUnreadable {
                    JevSettingsRow("연결된 서비스") {
                        connectedDescription
                    } control: {
                        Button("연결 해제") { confirmDisconnect = true }
                            .buttonStyle(.ob(.dangerGhost, size: .small))
                    }
                }
                JevSettingsRow(jev.connected ? "서비스·모델 바꾸기" : "서비스", stacked: true) {
                    Text(jevRich(service.help))
                        .tint(Ob.text)
                } control: {
                    form
                }
                privacyNote
            }
        }
    }

    private var unreadableAlert: some View {
        HStack(alignment: .top, spacing: ObSpace.md) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 15))
                .foregroundStyle(Ob.danger)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("저장된 키(…\(jev.hint ?? ""))를 열 수 없어요")
                    .font(ObFont.sub.weight(.semibold))
                    .foregroundStyle(Ob.dangerText)
                Text("서버의 암호화 키(SECRET_KEY)가 바뀌었거나 다른 서버의 데이터를 옮겨 오면 이렇게 돼요. 아래에 키를 다시 입력하면 바로 다시 연결돼요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .obCallout(.danger)
        .accessibilityElement(children: .combine)
    }

    private var connectedLabel: String {
        stored == .custom ? Self.hostOf(jev.baseUrl) : stored.label
    }

    private var connectedDescription: some View {
        let mono = Font.system(.footnote, design: .monospaced)
        let model = Text(jev.model ?? "jev-latest").font(mono)
        let key = Text("•••• \(jev.hint ?? "")").font(mono)
        return Text("\(connectedLabel) · \(model) · \(key)\(jev.keyUnreadable ? " · 열 수 없는 키" : "")")
        .accessibilityLabel("\(connectedLabel), 모델 \(jev.model ?? "jev-latest"), 키 끝자리 \(jev.hint ?? "")\(jev.keyUnreadable ? ", 열 수 없는 키" : "")")
    }

    // MARK: form

    private var m: String { model.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var account: String { accountId.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var accountOk: Bool { account.range(of: "^[0-9a-fA-F]{32}$", options: .regularExpression) != nil }
    private var url: String {
        var u = customUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        while u.hasSuffix("/") { u.removeLast() }
        return u
    }
    private var k: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// What would be saved: the service's base URL (nil = TypeSafe) and model (nil = default).
    private var draft: (baseUrl: String?, model: String?, ready: Bool) {
        let model: String? = m.isEmpty ? nil : m
        switch service {
        case .typesafe:
            return (nil, model, true)
        case .openrouter:
            return (Service.openrouter.preset?.baseUrl, model, model != nil)
        case .cloudflare:
            let ready = accountOk && model != nil
            return (ready ? cloudflareJevUrl(account, m) : nil, model, ready)
        case .custom:
            let ok = url.range(of: "^https?://\\S+$", options: [.regularExpression, .caseInsensitive]) != nil
            return (url.isEmpty ? nil : url, model, ok && model != nil)
        }
    }

    private var changed: Bool { draft.baseUrl != jev.baseUrl || draft.model != jev.model }
    private var sameHost: Bool { Self.originOf(draft.baseUrl) == Self.originOf(jev.baseUrl) }
    /// Without a new key only the model (or path) on the same host can change: a stored key never moves hosts.
    private var canSave: Bool { draft.ready && !busy && (!k.isEmpty || (jev.connected && changed && sameHost)) }
    private var needsKey: Bool { jev.connected && changed && !sameHost && k.isEmpty }

    private var saveLabel: String {
        k.isEmpty && jev.connected ? "저장" : jev.connected ? "바꾸기" : jev.keyUnreadable ? "다시 연결" : "연결"
    }

    private var endpoint: String? {
        if let b = draft.baseUrl { return jevEndpoint(b) }
        return service == .typesafe ? jevEndpoint(DEFAULT_JEV_BASE_URL) : nil
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: ObSpace.lg) {
            Picker("서비스", selection: Binding(get: { service }, set: pick)) {
                ForEach(Service.allCases) { s in Text(s.label).tag(s) }
            }
            .pickerStyle(.segmented)

            if service == .cloudflare {
                JevField(
                    label: "계정 ID",
                    help: !account.isEmpty && !accountOk ? "계정 ID는 32자리 영문·숫자예요." : nil,
                    helpTone: .danger
                ) {
                    TextField("32자리 영문·숫자", text: $accountId)
                        .textFieldStyle(JevMonoFieldStyle(focused: focus == .account))
                        .focused($focus, equals: .account)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .onSubmit { focus = .model }
                }
            }

            if service == .custom {
                JevField(label: "Base URL") {
                    TextField("https://example.com/v1", text: $customUrl)
                        .textFieldStyle(JevMonoFieldStyle(focused: focus == .url))
                        .focused($focus, equals: .url)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .onSubmit { focus = .model }
                }
            }

            JevField(label: "모델", help: Self.modelNote[m]) {
                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    TextField(service == .typesafe ? "jev-latest (기본)" : "서비스에서 쓰는 모델 이름", text: $model)
                        .textFieldStyle(JevMonoFieldStyle(focused: focus == .model))
                        .focused($focus, equals: .model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .onSubmit { focus = .key }
                    let suggestions = service == .typesafe ? [] : (service.preset?.models ?? [])
                    if suggestions.count > 1 {
                        FlowRow(spacing: 6, lineSpacing: 6) {
                            ForEach(suggestions, id: \.self) { id in
                                modelChip(id)
                            }
                        }
                    }
                }
            }

            JevField(
                label: service.keyLabel,
                note: jev.connected && sameHost ? "같은 서비스면 비워 둬도 돼요" : nil,
                help: needsKey
                    ? "다른 서비스로 바꾸려면 그 서비스의 키도 입력하세요. 저장된 키는 다른 주소로 보내지 않아요."
                    : "저장하기 전에 키가 실제로 동작하는지 한 번 확인해요."
            ) {
                HStack(spacing: ObSpace.sm) {
                    keyField
                    Button {
                        focus = nil
                        Task { await save() }
                    } label: {
                        HStack(spacing: 6) {
                            if busy { ProgressView().controlSize(.small).tint(Ob.onPrimary) }
                            Text(saveLabel)
                        }
                    }
                    .buttonStyle(.ob(.primary, size: .large))
                    .disabled(!canSave)
                }
            }

            if let endpoint {
                VStack(alignment: .leading, spacing: 2) {
                    Text("요청 주소")
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                    Text(endpoint)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Ob.text2)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .animation(ObMotion.standard, value: service)
    }

    private func modelChip(_ id: String) -> some View {
        let on = m == id
        return Button {
            Haptics.select()
            model = id
        } label: {
            Text(id)
                .font(.system(.caption, design: .monospaced).weight(on ? .semibold : .regular))
                .foregroundStyle(on ? Ob.text : Ob.text2)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(on ? Ob.surface3 : Ob.surface2, in: Capsule())
                .frame(minHeight: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(JevPressStyle())
        .accessibilityLabel("추천 모델 \(id)")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var keyField: some View {
        HStack(spacing: 0) {
            Group {
                if showKey {
                    TextField(service.keyPlaceholder, text: $key)
                } else {
                    SecureField(service.keyPlaceholder, text: $key)
                }
            }
            .font(ObFont.body)
            .focused($focus, equals: .key)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .privacySensitive()
            .submitLabel(.done)
            .onSubmit { Task { await save() } }
            .padding(.leading, ObSpace.md)

            Button {
                showKey.toggle()
            } label: {
                Image(systemName: showKey ? "eye.slash" : "eye")
                    .font(.system(size: 15))
                    .foregroundStyle(Ob.text3)
                    .frame(width: ObSize.row, height: ObSize.controlLg)
                    .contentShape(Rectangle())
            }
            .buttonStyle(JevPressStyle())
            .accessibilityLabel(showKey ? "키 숨기기" : "키 보기")
        }
        .frame(minHeight: ObSize.controlLg)
        .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: ObRadius.md)
                .strokeBorder(focus == .key ? Ob.text3 : Ob.input, lineWidth: 1)
        )
    }

    private var privacyNote: some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline()
            HStack(alignment: .top, spacing: ObSpace.sm) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 14))
                    .foregroundStyle(Ob.text3)
                    .padding(.top, 1)
                    .accessibilityHidden(true)
                Text(jevRich("Jev를 쓸 때마다 **작업 제목, 메모 앞부분, 날짜, 프로젝트 이름, 연결된 작업 제목**이 \(service.sentTo) 전송돼요. 이메일이나 멤버 이름은 보내지 않고, 조직에서는 내가 볼 수 있는 작업만 보내요."))
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text2)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 14)
        }
    }

    private func pick(_ id: Service) {
        Haptics.select()
        service = id
        model = id == stored ? (jev.model ?? id.defaultModel) : id.defaultModel
    }

    private func save() async {
        guard canSave else { return }
        let newKey = k
        let wasConnected = jev.connected
        let label = service.label
        busy = true
        let input = JevSettingsInput(apiKey: newKey.isEmpty ? nil : .some(newKey), baseUrl: .some(draft.baseUrl), model: .some(draft.model))
        let res = await JevCenter.shared.saveSettings(store, input)
        busy = false
        guard res != nil else { return }
        key = ""
        showKey = false
        Haptics.success()
        store.toasts.show(newKey.isEmpty ? "모델을 바꿨어요" : wasConnected ? "\(label)로 바꿨어요" : "Jev를 연결했어요")
    }

    private func disconnect() async {
        if await JevCenter.shared.saveSettings(store, JevSettingsInput(apiKey: .some(nil))) != nil {
            store.toasts.show("Jev 연결을 해제했어요")
        }
    }

    // MARK: - behaviour

    private var behaviourSection: some View {
        JevSettingsSection("판단 적용", lead: "기본은 제안만 보여주고 내가 골라 적용해요.") {
            JevSettingsRow("확신이 높으면 바로 적용") {
                Text("켜면 Jev가 80% 이상 확신하는 판단은 바로 반영해요(새 작업의 프로젝트·우선순위·고정 여부, 그리고 우선순위가 비어 있는 작업만). 미루기와 선후 관계 연결은 언제나 확인을 받아요.")
            } control: {
                Toggle("확신이 높으면 바로 적용", isOn: Binding(
                    get: { autoApplyDraft ?? jev.autoApply },
                    set: setAutoApply
                ))
                .labelsHidden()
                .tint(Ob.primary)
            }
        }
    }

    private func setAutoApply(_ on: Bool) {
        guard jev.connected else {
            store.toasts.error("먼저 Jev를 연결하세요")
            return
        }
        autoApplyDraft = on
        Task {
            let r = await JevCenter.shared.saveSettings(store, JevSettingsInput(autoApply: on))
            autoApplyDraft = nil
            if r != nil { store.toasts.show(on ? "확신이 높은 판단은 바로 적용해요" : "이제 모든 판단을 제안으로만 보여줘요") }
        }
    }

    // MARK: - what it does

    private var featuresSection: some View {
        JevSettingsSection(
            "Jev가 하는 일",
            lead: "Jev는 의미를 판단하고, 날짜·파급 계산은 지연 예측 엔진이 해요. 어떤 판단이든 이유와 확신도를 함께 보여줘요."
        ) {
            VStack(alignment: .leading, spacing: 0) {
                if jev.connected {
                    FlowRow(spacing: ObSpace.sm, lineSpacing: ObSpace.sm) {
                        Button("우선순위 정리 열기") { router.presentJev(.priority) }
                            .buttonStyle(.ob(.outline, size: .small))
                        Button("미룰 작업 고르기") { router.presentJev(.postpone(scope: .today)) }
                            .buttonStyle(.ob(.outline, size: .small))
                    }
                    .padding(.bottom, ObSpace.lg)
                }
                ForEach(Self.features) { f in
                    VStack(alignment: .leading, spacing: 2) {
                        Hairline().padding(.bottom, 14)
                        HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                            Text(f.title)
                                .font(ObFont.body.weight(.medium))
                                .foregroundStyle(Ob.text)
                            Text(f.place)
                                .font(ObFont.caption)
                                .foregroundStyle(Ob.text3)
                        }
                        Text(f.body)
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text2)
                            .lineSpacing(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 14)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    // MARK: - helpers


    private static func accountOf(_ url: String?) -> String {
        guard let url,
              let re = try? NSRegularExpression(pattern: "/accounts/([0-9a-f]{32})(/|$)", options: .caseInsensitive),
              let match = re.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
              let r = Range(match.range(at: 1), in: url) else { return "" }
        return String(url[r])
    }

    private static func originOf(_ baseUrl: String?) -> String {
        let raw = baseUrl ?? DEFAULT_JEV_BASE_URL
        guard let c = URLComponents(string: raw), let scheme = c.scheme, let host = c.host else { return raw }
        return "\(scheme.lowercased())://\(host.lowercased())\(c.port.map { ":\($0)" } ?? "")"
    }

    private static func hostOf(_ url: String?) -> String {
        guard let url, let c = URLComponents(string: url), let host = c.host, !host.isEmpty else { return "직접 입력" }
        return host + (c.port.map { ":\($0)" } ?? "")
    }
}
