import SwiftUI

/// 설정 › AI 연결 (web app/(app)/settings/ai/page.tsx): the MCP server address, the AI default space,
/// how to connect each AI tool, the Agent Skill download, personal API tokens and connected OAuth apps.
struct AISettingsView: View {
    @Environment(AppStore.self) private var store

    struct Integrations: Codable, Hashable, Sendable {
        var publicUrl: String
        var mcpUrl: String
        var skillUrl: String
    }

    struct TokenRow: Codable, Hashable, Identifiable, Sendable {
        var id: String
        var name: String
        var prefix: String
        var lastUsedAt: String?
        var createdAt: String
    }

    struct GrantRow: Codable, Hashable, Identifiable, Sendable {
        var id: String
        var clientName: String
        var clientId: String
        var lastUsedAt: String?
        var createdAt: String
    }

    private struct TokensResponse: Codable { var tokens: [TokenRow] }
    private struct GrantsResponse: Codable { var grants: [GrantRow] }
    private struct CreatedToken: Codable { var token: String }

    enum Client: String, CaseIterable, Identifiable {
        case claude, chatgpt, claudeCode, codex, other
        var id: String { rawValue }
        var label: String {
            switch self {
            case .claude: "Claude"
            case .chatgpt: "ChatGPT"
            case .claudeCode: "Claude Code"
            case .codex: "Codex"
            case .other: "기타"
            }
        }
    }

    struct Revoke: Identifiable {
        enum Kind { case token, grant }
        var kind: Kind
        var id: String
        var name: String
    }

    private static let features: [(String, String)] = [
        ("get_overview", "오늘 할 일·기한 지남·위험 요약"),
        ("create_tasks", "목표를 의존 관계 있는 계획으로 한 번에 생성"),
        ("simulate_delay", "미루면 무엇이 밀리는지 예측"),
        ("postpone_task", "연쇄 적용으로 일정 이동"),
        ("get_forecast", "기한 지난 작업이 일으키는 지연"),
        ("get_bottlenecks", "여유 없는 핵심 작업 순위"),
        ("update_task · complete_task", "모든 필드 수정·완료"),
        ("projects · dependencies", "프로젝트·선행 작업 관리"),
    ]

    @State private var info: Integrations?
    @State private var tokens: [TokenRow] = []
    @State private var grants: [GrantRow] = []
    @State private var loaded = false
    @State private var client: Client = .claude
    @State private var tokenName = ""
    @State private var creating = false
    /// The new token, shown once. It lives only in this screen's memory.
    @State private var fresh: String?
    @State private var skillFile: URL?
    @FocusState private var nameFocused: Bool

    private var mcpUrl: String { info?.mcpUrl ?? "\(Session.server)/mcp" }
    private var tokenHint: String { fresh ?? "obk_…" }

    /// The server's PUBLIC_URL differs from the address this app talks to: AI tools' OAuth may fail.
    private var mismatch: Bool {
        guard let info else { return false }
        return Self.origin(info.publicUrl) != Self.origin(Session.server)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                Text("Claude, ChatGPT 같은 AI 도구가 Obelisk의 모든 기능을 MCP와 Agent Skill로 사용할 수 있어요.")
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text2)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                mcpSection
                AIWorkspaceSection()
                connectSection
                skillSection
                tokensSection
                grantsSection
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.lg)
            .padding(.bottom, ObSpace.xxxl * 2)
        }
        .task {
            await refresh()
            loaded = true
        }
        .scrollDismissesKeyboard(.interactively)
        .obPage()
        .refreshable { await refresh() }
        .task { skillFile = await Self.downloadSkill() }
    }

    // MARK: - MCP

    private var mcpSection: some View {
        JevSettingsSection("MCP 서버 주소", lead: "AI 도구의 커넥터 설정에 이 주소를 붙여넣으면 연결돼요.") {
            VStack(alignment: .leading, spacing: ObSpace.lg) {
                JevCopyField(value: mcpUrl, label: "MCP 서버 주소", done: "MCP 주소를 복사했어요")
                if mismatch, let info {
                    HStack(alignment: .top, spacing: ObSpace.md) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 15))
                            .foregroundStyle(Ob.warn)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("접속 주소가 서버 설정과 달라요")
                                .font(ObFont.sub.weight(.semibold))
                                .foregroundStyle(Ob.warnText)
                            Text(jevRich("서버의 `PUBLIC_URL`이 **\(info.publicUrl)**로 설정되어 있지만 지금은 **\(Session.server)**로 접속 중이에요. AI 도구의 OAuth 로그인이 실패할 수 있으니 배포 환경변수 `PUBLIC_URL`을 실제 주소로 맞춰주세요."))
                                .font(ObFont.footnote)
                                .foregroundStyle(Ob.text2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .obCallout(.warn)
                    .accessibilityElement(children: .combine)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text("AI가 할 수 있는 일")
                        .font(ObFont.footnote.weight(.semibold))
                        .foregroundStyle(Ob.text2)
                        .padding(.bottom, ObSpace.sm)
                    ForEach(Self.features, id: \.0) { k, v in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(k)
                                .font(.system(.footnote, design: .monospaced))
                                .foregroundStyle(Ob.text)
                            Text(v)
                                .font(ObFont.footnote)
                                .foregroundStyle(Ob.text2)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 10)
                        .overlay(alignment: .top) { Hairline() }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    // MARK: - how to connect

    private var connectSection: some View {
        JevSettingsSection("연결 방법", lead: "쓰고 있는 AI 도구를 고르고 순서대로 따라 하세요.") {
            VStack(alignment: .leading, spacing: ObSpace.lg) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Client.allCases) { c in clientChip(c) }
                    }
                }
                .scrollClipDisabled()
                .accessibilityElement(children: .contain)
                .accessibilityLabel("AI 도구")

                steps
                    .id(client)
                    .transition(.opacity)
            }
        }
    }

    private func clientChip(_ c: Client) -> some View {
        let on = client == c
        return Button {
            Haptics.select()
            withAnimation(ObMotion.standard) { client = c }
        } label: {
            Text(c.label)
                .font(ObFont.footnote.weight(on ? .semibold : .medium))
                .foregroundStyle(on ? Ob.text : Ob.text2)
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(on ? Ob.surface3 : Color.clear, in: Capsule())
                .overlay { if !on { Capsule().strokeBorder(Ob.border, lineWidth: 1) } }
                .frame(minHeight: ObSize.row)
                .contentShape(Rectangle())
        }
        .buttonStyle(JevPressStyle())
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    @ViewBuilder
    private var steps: some View {
        switch client {
        case .claude:
            AISteps(items: [
                .text("Claude(웹·데스크톱)에서 **Customize → Connectors**를 열고 **Add → Add custom connector**를 눌러요. Team·Enterprise 플랜은 Owner가 **Organization settings → Connectors**에서 추가해야 해요."),
                .text("이름은 **Obelisk**, URL에는 위의 MCP 주소를 붙여넣고 **Continue**. 인증 설정은 **Detected**로 표시된 그대로 두고 **Add**해요."),
                .text("**연결**을 누르면 Obelisk 승인 화면이 열려요. 로그인 후 **허용**하면 끝."),
                .text("아래 **Agent Skill**도 함께 올리면 Claude가 지연 예측을 언제 써야 하는지까지 알게 돼요."),
            ])
        case .chatgpt:
            AISteps(items: [
                .text("ChatGPT **Plugins**에서 **+ → Add custom MCP server**를 눌러요. Codex에 추가한 MCP 서버는 ChatGPT 대화에 공유되지 않으니 여기서 따로 추가해야 해요."),
                .text("이름 **Obelisk**, Server URL에 위 주소, Authentication은 **OAuth**를 고르고 경고를 확인한 뒤 **Create as a plugin**을 눌러요."),
                .text("내 플러그인에서 Obelisk를 열어 **+**로 설치하고, 위쪽 탭을 **Work**로 바꾼 새 대화에서 **@Obelisk**를 골라 물어보면 돼요. Obelisk 승인 화면이 뜨면 로그인 후 허용해요."),
            ])
        case .claudeCode:
            AISteps(items: [
                .code("OAuth로 연결(권장). 실행 후 **/mcp**에서 Obelisk를 선택해 로그인해요.", "claude mcp add --transport http obelisk \(mcpUrl)"),
                .code("또는 개인 토큰으로 연결:", "claude mcp add --transport http obelisk \(mcpUrl) --header \"Authorization: Bearer \(tokenHint)\""),
                .text("Skill 설치: 아래에서 받은 zip을 풀어 **~/.claude/skills/obelisk**에 넣어요."),
            ])
        case .codex:
            AISteps(items: [
                .code("**~/.codex/config.toml**에 추가해요.", "[mcp_servers.obelisk]\nurl = \"\(mcpUrl)\"\nbearer_token_env_var = \"OBELISK_TOKEN\""),
                .code("개인 토큰을 환경변수로 지정해요.", "export OBELISK_TOKEN=\"\(tokenHint)\""),
                .text("Skill 설치: zip을 풀어 **~/.codex/skills/obelisk**에 넣어요."),
            ])
        case .other:
            AISteps(items: [
                .text("Streamable HTTP를 지원하는 모든 MCP 클라이언트에서 사용할 수 있어요 (Cursor, Windsurf, VS Code 등)."),
                .code(
                    "OAuth 2.1(동적 클라이언트 등록, PKCE)을 지원하면 URL만 넣으면 돼요. 아니라면 헤더로 토큰을 전달하세요:",
                    "{\n  \"mcpServers\": {\n    \"obelisk\": {\n      \"url\": \"\(mcpUrl)\",\n      \"headers\": { \"Authorization\": \"Bearer \(tokenHint)\" }\n    }\n  }\n}"
                ),
                .text("MCP가 없는 환경에서는 REST API를 직접 쓸 수 있어요. Skill 안의 **references/rest-api.md**를 참고하세요."),
            ])
        }
    }

    // MARK: - agent skill

    private var skillSection: some View {
        JevSettingsSection(
            "Agent Skill",
            lead: "MCP가 ‘무엇을 할 수 있는지’라면, Skill은 ‘언제 어떻게 써야 하는지’예요. 미루기 전 반드시 파급 예측을 먼저 보여주고, 목표를 의존 관계가 있는 계획으로 쪼개는 방법이 담겨 있어요. 이 서버 주소가 미리 들어간 상태로 받아져요."
        ) {
            skillButton
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                installRow("Claude", "설정 → 기능 → Skills → 업로드")
                installRow("Claude Code", "`~/.claude/skills/obelisk`에 압축 해제")
                installRow("Codex", "`~/.codex/skills/obelisk`에 압축 해제")
            }
        }
    }

    /// Share sheet (Files, AirDrop, Mail) once the archive is here; otherwise open it in Safari.
    @ViewBuilder
    private var skillButton: some View {
        let label = HStack(spacing: 5) {
            Image(systemName: "arrow.down.to.line").font(.system(size: 13, weight: .medium))
            Text("obelisk-skill.zip 받기")
        }
        if let skillFile {
            ShareLink(item: skillFile, preview: SharePreview("obelisk-skill.zip")) { label }
                .buttonStyle(.ob(.outline, size: .small))
        } else if let url = API.shared.url("/api/skill.zip") {
            Link(destination: url) { label }
                .buttonStyle(.ob(.outline, size: .small))
        }
    }

    private func installRow(_ name: String, _ how: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ObSpace.md) {
            Text(name)
                .font(ObFont.sub.weight(.semibold))
                .foregroundStyle(Ob.text)
                .frame(width: 112, alignment: .leading)
            Text(jevRich(how))
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 12)
        .overlay(alignment: .top) { Hairline() }
        .accessibilityElement(children: .combine)
    }

    // MARK: - tokens

    private var tokensSection: some View {
        JevSettingsSection("개인 API 토큰", lead: "OAuth를 지원하지 않는 도구나 스크립트용이에요. 토큰은 만들 때 한 번만 보여드려요.") {
            VStack(alignment: .leading, spacing: ObSpace.lg) {
                VStack(spacing: 0) {
                    AITableHead(name: "이름")
                    if !loaded {
                        AISkeletonRows()
                    } else if tokens.isEmpty {
                        AIEmptyRow(text: "아직 만든 토큰이 없어요")
                    } else {
                        ForEach(tokens) { t in
                            AIListRow(
                                title: t.name, sub: t.prefix, subMono: true, when: relativeTime(t.lastUsedAt),
                                action: "폐기", question: "토큰을 폐기할까요?"
                            ) {
                                await revokeNow(Revoke(kind: .token, id: t.id, name: t.name))
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    TextField("토큰 이름 (예: Claude Code 노트북)", text: $tokenName)
                        .textFieldStyle(.ob(focused: nameFocused))
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .onSubmit { Task { await createToken() } }
                        .accessibilityLabel("새 토큰 이름")
                    Button {
                        Task { await createToken() }
                    } label: {
                        HStack(spacing: 5) {
                            if creating {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "plus").font(.system(size: 13, weight: .semibold))
                            }
                            Text("토큰 만들기")
                        }
                    }
                    .buttonStyle(.ob(.outline, size: .large))
                    .disabled(creating)
                }

                if let fresh {
                    VStack(alignment: .leading, spacing: ObSpace.md) {
                        HStack(alignment: .top, spacing: ObSpace.sm) {
                            Image(systemName: "checkmark.circle")
                                .font(.system(size: 15))
                                .foregroundStyle(Ob.ok)
                                .accessibilityHidden(true)
                            Text("새 토큰이에요. 지금 복사해 두세요. 다시 볼 수 없어요.")
                                .font(ObFont.sub.weight(.semibold))
                                .foregroundStyle(Ob.okText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        JevCopyField(value: fresh, label: "새 토큰", done: "토큰을 복사했어요", wraps: true)
                            .privacySensitive()
                    }
                    .obCallout(.ok)
                    .transition(.opacity)
                }
            }
            .animation(ObMotion.standard, value: fresh)
        }
    }

    // MARK: - connected apps

    private var grantsSection: some View {
        JevSettingsSection("연결된 앱", lead: "OAuth로 접근을 허용한 AI 도구들이에요. 연결을 끊으면 즉시 접근이 차단돼요.") {
            VStack(spacing: 0) {
                AITableHead(name: "앱")
                if !loaded {
                    AISkeletonRows()
                } else if grants.isEmpty {
                    AIEmptyRow(text: "연결된 앱이 없어요")
                } else {
                    ForEach(grants) { g in
                        AIListRow(
                            title: g.clientName, sub: "\(Self.koDate(g.createdAt)) 연결", subMono: false, when: relativeTime(g.lastUsedAt),
                            action: "연결 끊기", question: "연결을 끊을까요?"
                        ) {
                            await revokeNow(Revoke(kind: .grant, id: g.id, name: g.clientName))
                        }
                    }
                }
            }
        }
    }

    // MARK: - actions


    private func refresh() async {
        do {
            async let i: Integrations = API.shared.get("/api/integrations")
            async let t: TokensResponse = API.shared.get("/api/tokens")
            async let g: GrantsResponse = API.shared.get("/api/oauth/grants")
            let (ii, tt, gg) = try await (i, t, g)
            info = ii
            withAnimation(ObMotion.standard) {
                tokens = tt.tokens
                grants = gg.grants
            }
        } catch {
            store.report(error)
        }
    }

    private func createToken() async {
        guard !creating else { return }
        let trimmed = tokenName.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmed.isEmpty ? "AI 도구" : trimmed
        creating = true
        defer { creating = false }
        do {
            let r: CreatedToken = try await API.shared.send(.post, "/api/tokens", json: ["name": .string(name)])
            nameFocused = false
            Haptics.success()
            fresh = r.token
            tokenName = ""
            await refresh()
        } catch {
            store.report(error)
        }
    }

    private func revokeNow(_ r: Revoke) async {
        do {
            try await API.shared.send(.delete, r.kind == .token ? "/api/tokens/\(r.id)" : "/api/oauth/grants/\(r.id)")
            await refresh()
        } catch {
            store.report(error)
        }
    }

    /// The skill archive in a temporary file, ready for the share sheet.
    private static func downloadSkill() async -> URL? {
        do {
            let data = try await API.shared.raw(.get, "/api/skill.zip", body: nil)
            guard !data.isEmpty else { return nil }
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("obelisk-skill", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent("obelisk-skill.zip")
            try data.write(to: file, options: .atomic)
            return file
        } catch {
            return nil
        }
    }

    private static func origin(_ s: String) -> String {
        guard let c = URLComponents(string: s), let scheme = c.scheme, let host = c.host else { return s }
        return "\(scheme.lowercased())://\(host.lowercased())\(c.port.map { ":\($0)" } ?? "")"
    }

    /// `new Date(iso).toLocaleDateString('ko-KR')`: "2026. 11. 14."
    private static func koDate(_ iso: String) -> String {
        guard let d = ISO8601DateFormatter.parse(iso) else { return "" }
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        return "\(c.year ?? 0). \(c.month ?? 0). \(c.day ?? 0)."
    }
}

// MARK: - pieces

/// The AI default space: which workspace AI tools use when a request doesn't name one (2+ spaces only).
struct AIWorkspaceSection: View {
    @Environment(AppStore.self) private var store

    private struct UserResult: Codable { var user: User }

    var body: some View {
        if store.workspaces.count >= 2 {
            let current = store.user?.defaultWorkspaceId ?? store.workspaces.first?.id
            JevSettingsSection(
                "AI 기본 공간",
                lead: "연결 하나로 개인 공간과 모든 조직을 다뤄요. AI가 공간을 따로 말하지 않으면 여기서 고른 곳에서 일해요. 조직에서는 내 계정 권한(보기·쓰기·관리)이 그대로 적용돼요."
            ) {
                VStack(alignment: .leading, spacing: ObSpace.md) {
                    VStack(spacing: 0) {
                        ForEach(Array(store.workspaces.enumerated()), id: \.element.id) { i, w in
                            if i > 0 { Hairline().padding(.leading, 52) }
                            option(w, selected: current == w.id)
                        }
                    }
                    .obCard(padding: 0, radius: ObRadius.lg)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("AI 기본 공간")

                    Text(jevRich("AI에게 “에이컴퍼니에서 할 일 보여줘”처럼 공간을 말하면 그 공간을 써요. `list_workspaces` 도구로 목록을 확인할 수 있어요."))
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func label(_ w: WorkspaceSummary) -> String { w.kind == .personal ? "개인 공간" : w.name }

    private func option(_ w: WorkspaceSummary, selected: Bool) -> some View {
        Button {
            guard !selected else { return }
            Haptics.select()
            Task { await choose(w) }
        } label: {
            HStack(spacing: ObSpace.md) {
                Group {
                    if w.kind == .personal {
                        LogoMark(size: 18)
                            .frame(width: 28, height: 28)
                            .background(Ob.surface2, in: RoundedRectangle(cornerRadius: ObRadius.sm))
                    } else {
                        Text(String(w.name.prefix(1)))
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Ob.text)
                            .frame(width: 28, height: 28)
                            .background(Ob.surface3, in: RoundedRectangle(cornerRadius: ObRadius.sm))
                    }
                }
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(label(w))
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text)
                        .lineLimit(1)
                    Text(w.kind == .personal ? "나만 보는 공간" : "조직 · 멤버 \(w.memberCount)명")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Ob.text)
                }
            }
            .padding(.horizontal, ObSpace.md)
            .frame(minHeight: 58)
            .contentShape(Rectangle())
        }
        .buttonStyle(.obRow)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func choose(_ w: WorkspaceSummary) async {
        do {
            let r: UserResult = try await API.shared.send(.patch, "/api/auth/me", json: ["defaultWorkspaceId": .string(w.id)])
            store.setUser(r.user)
            store.toasts.show("AI 기본 공간을 \(label(w))(으)로 바꿨어요")
        } catch {
            store.report(error)
        }
    }
}

/// Numbered steps with bold UI names, some followed by a copyable command.
struct AISteps: View {
    enum Item {
        case text(String)
        case code(String, String)
    }

    var items: [Item]

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.md) {
                    Text("\(i + 1)")
                        .font(ObFont.footnote.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Ob.text3)
                        .frame(width: 22, height: 22)
                        .background(Ob.surface2, in: Circle())
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: ObSpace.sm) {
                        switch item {
                        case let .text(s):
                            stepText(s)
                        case let .code(s, code):
                            stepText(s)
                            JevCodeBlock(code: code)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .contain)
            }
        }
    }

    private func stepText(_ s: String) -> some View {
        Text(jevRich(s))
            .font(ObFont.sub)
            .foregroundStyle(Ob.text2)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Column labels over a token / app list (web table head).
struct AITableHead: View {
    var name: String
    var body: some View {
        HStack(spacing: ObSpace.md) {
            Text(name)
            Spacer()
            Text("마지막 사용")
            Color.clear.frame(width: AI_ACTION_WIDTH - 12, height: 1)
        }
        .font(ObFont.caption.weight(.medium))
        .foregroundStyle(Ob.text3)
        .padding(.bottom, ObSpace.sm)
        .accessibilityHidden(true)
    }
}

/// Width of the revoke column, so 마지막 사용 lines up over the times.
private let AI_ACTION_WIDTH: CGFloat = 84

/// Name + sub line · last used · a revoke action that asks first. Hairline above.
struct AIListRow: View {
    var title: String
    var sub: String
    var subMono: Bool
    var when: String
    var action: String
    var question: String
    var run: () async -> Void

    @State private var confirm = false

    var body: some View {
        HStack(alignment: .center, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
                Text(sub)
                    .font(subMono ? .system(.caption, design: .monospaced) : ObFont.caption)
                    .foregroundStyle(Ob.text3)
                    .lineLimit(1)
            }
            Spacer(minLength: ObSpace.sm)
            Text(when)
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                .lineLimit(1)
            Button(action, role: .destructive) { confirm = true }
                .buttonStyle(.ob(.dangerGhost, size: .small))
                .frame(width: AI_ACTION_WIDTH, alignment: .trailing)
                .padding(.trailing, -12)
                .accessibilityLabel("\(title) \(action)")
                .confirmationDialog(question, isPresented: $confirm, titleVisibility: .visible) {
                    Button(action, role: .destructive) { Task { await run() } }
                    Button("취소", role: .cancel) {}
                } message: {
                    Text("“\(title)”은(는) 더 이상 Obelisk에 접근할 수 없어요.")
                }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 60)
        .overlay(alignment: .top) { Hairline() }
        .accessibilityElement(children: .contain)
    }
}

struct AIEmptyRow: View {
    var text: String
    var body: some View {
        Text(text)
            .font(ObFont.sub)
            .foregroundStyle(Ob.text3)
            .frame(maxWidth: .infinity, minHeight: 60)
            .overlay(alignment: .top) { Hairline() }
    }
}

struct AISkeletonRows: View {
    var body: some View {
        VStack(spacing: 0) {
            ForEach(0 ..< 2, id: \.self) { _ in
                HStack(spacing: ObSpace.md) {
                    VStack(alignment: .leading, spacing: 6) {
                        JevSkeleton(width: 120, height: 13)
                        JevSkeleton(width: 80, height: 11)
                    }
                    Spacer()
                    JevSkeleton(width: 64, height: 13)
                    JevSkeleton(width: 40, height: 13)
                }
                .frame(minHeight: 60)
                .overlay(alignment: .top) { Hairline() }
            }
        }
        .accessibilityLabel("불러오는 중")
    }
}
