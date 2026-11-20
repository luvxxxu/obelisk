import SwiftUI

/// 서버 관리 › 가입 (web admin/signup): who can make an account, what they must prove, who may create
/// organizations, and server invite links that let one person in.
struct AdminSignupTab: View {
    var reload: Int

    @Environment(AppStore.self) private var store
    @State private var settings: ServerSettings?
    @State private var error: String?
    @State private var saving: String?
    @State private var domains = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            if let error { AdminErrorCallout(message: error) }
            if let st = settings {
                mode(st)
                emailRules(st)
                orgs(st)
                AdminInvitesSection(mode: st.signupMode, reload: reload)
            } else if error == nil {
                AdminLoading(height: 240)
            }
        }
        .task(id: reload) { await load() }
    }

    private func load() async {
        do {
            let s: ServerSettings = try await API.shared.get("/api/admin/settings")
            apply(s)
            error = nil
        } catch is CancellationError {
        } catch {
            if settings == nil { self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했어요" }
        }
    }

    private func apply(_ s: ServerSettings) {
        settings = s
        domains = s.allowedEmailDomains.joined(separator: ", ")
    }

    private func save(_ patch: [String: JSONValue], key: String, done: String? = nil) async {
        saving = key
        defer { saving = nil }
        do {
            let s: ServerSettings = try await API.shared.send(.patch, "/api/admin/settings", json: .object(patch))
            withAnimation(ObMotion.standard) { apply(s) }
            if let done {
                Haptics.success()
                store.toasts.show(done)
            }
            // 조직 만들기 changes what this account may do too.
            if patch["orgCreation"] != nil { await store.refresh() }
        } catch {
            store.adminFailed(error, "바꾸지 못했어요")
        }
    }

    // MARK: 가입 방식

    private func mode(_ st: ServerSettings) -> some View {
        OrgSection("가입 방식") {
            VStack(alignment: .leading, spacing: ObSpace.md) {
                Picker("가입 방식", selection: Binding(
                    get: { st.signupMode },
                    set: { m in
                        guard m != st.signupMode else { return }
                        Task { await save(["signupMode": .string(m.rawValue)], key: "mode", done: "가입 방식을 ‘\(m.labelKo)’으로 바꿨어요") }
                    }
                )) {
                    ForEach(SignupMode.allCases, id: \.self) { m in
                        Text(m.labelKo).tag(m)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(saving == "mode")
                Text(st.signupMode.helpKo + (st.signupModeFromEnv ? " 지금은 환경 변수 값을 따르고 있어요." : ""))
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, ObSpace.xs)
                    .animation(nil, value: st.signupMode)
            }
        }
    }

    // MARK: 메일 주소 확인

    private var parsedDomains: [String] {
        domains
            .split(whereSeparator: { $0 == "," || $0.isWhitespace })
            .map { String($0).trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "^@+", with: "", options: .regularExpression).lowercased() }
            .filter { !$0.isEmpty }
    }

    private func emailRules(_ st: ServerSettings) -> some View {
        let lead = st.mailAvailable
            ? (st.mailToLog ? "개발 모드라 확인 메일은 백엔드 로그에 찍혀요." : "확인 메일은 SMTP_URL로 보내요.")
            : "SMTP_URL이 설정되지 않아 메일을 보낼 수 없어서 켤 수 없어요."
        let dirty = parsedDomains != st.allowedEmailDomains
        return OrgSection("메일 주소 확인", lead: lead) {
            OrgCard {
                AdminToggleRow(
                    label: "새 계정은 메일 확인 필수",
                    note: "켜면 새로 가입한 계정은 메일로 받은 링크를 열어야 쓸 수 있어요. 지금 있는 계정은 그대로 쓰고, 설정에서 언제든 확인할 수 있어요.",
                    isOn: Binding(
                        get: { st.requireEmailVerification },
                        set: { v in
                            if v, !st.mailAvailable {
                                store.toasts.error("메일을 보낼 수 없는 서버예요. SMTP_URL을 먼저 설정하세요.")
                                return
                            }
                            Task { await save(["requireEmailVerification": .bool(v)], key: "verify", done: v ? "새 계정은 메일을 확인해야 써요" : "메일 확인을 껐어요") }
                        }
                    )
                )
                .disabled(saving == "verify")
                AdminRow("가입할 수 있는 도메인",
                         note: "적으면 초대 링크 없이 가입하는 사람은 이 도메인 주소만 쓸 수 있고, 주소 확인도 함께 해요. 비우면 제한하지 않아요.",
                         stacked: true) {
                    HStack(spacing: ObSpace.sm) {
                        TextField(text: $domains, prompt: Text(verbatim: "company.com, example.org")) { Text("가입할 수 있는 도메인") }
                            .textFieldStyle(.ob)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .disabled(!st.mailAvailable && st.allowedEmailDomains.isEmpty)
                        Button("저장") {
                            let list = parsedDomains
                            Task {
                                await save(["allowedEmailDomains": .array(list.map(JSONValue.string))], key: "domains",
                                           done: list.isEmpty ? "도메인 제한을 없앴어요" : "\(list.map { "@\($0)" }.joined(separator: ", "))만 가입할 수 있어요")
                            }
                        }
                        .buttonStyle(.ob(.primary))
                        .disabled(!dirty || saving == "domains")
                    }
                }
            }
        }
    }

    // MARK: 조직

    private func orgs(_ st: ServerSettings) -> some View {
        OrgSection("조직") {
            OrgCard {
                AdminRow("조직 만들기",
                         note: "‘운영자만’이면 다른 사람은 새 조직을 만들거나 다른 서버의 조직 파일을 가져올 수 없어요. 이미 있는 조직은 그대로예요.",
                         stacked: true) {
                    Picker("조직 만들기", selection: Binding(
                        get: { st.orgCreation },
                        set: { v in
                            guard v != st.orgCreation else { return }
                            Task { await save(["orgCreation": .string(v.rawValue)], key: "org") }
                        }
                    )) {
                        ForEach(OrgCreation.allCases, id: \.self) { v in
                            Text(v.labelKo).tag(v)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(saving == "org")
                }
            }
        }
    }
}

// MARK: - 서버 초대 링크

struct AdminInvitesSection: View {
    var mode: SignupMode
    var reload: Int

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var invites: [ServerInvite]?
    @State private var revoking: ServerInvite?
    @State private var bump = 0

    private var live: [ServerInvite] { invites?.filter(\.valid) ?? [] }
    private var ended: [ServerInvite] { Array((invites?.filter { !$0.valid } ?? []).prefix(10)) }

    var body: some View {
        OrgSection(
            "서버 초대 링크",
            lead: mode == .closed
                ? "가입 방식이 ‘닫힘’이라 지금은 초대 링크로도 가입할 수 없어요."
                : "조직에 넣지 않고 이 서버에 가입만 하게 하는 링크예요. 링크로 가입하면 승인과 도메인 제한을 건너뛰어요."
        ) {
            Button {
                router.present(.init(id: "admin-invite", detents: [.medium, .large]) {
                    AdminCreateInviteSheet { bump += 1 }
                })
            } label: {
                Label("만들기", systemImage: "plus")
            }
            .buttonStyle(.ob(.primary, size: .small))
        } content: {
            if invites == nil {
                AdminLoading(height: 60)
            } else {
                OrgCard {
                    if live.isEmpty, ended.isEmpty {
                        OrgEmptyRow(text: "아직 만든 링크가 없어요")
                    }
                    ForEach(live + ended) { i in row(i) }
                }
            }
        }
        .task(id: Key(reload: reload, bump: bump)) { await load() }
    }

    private struct Key: Hashable {
        var reload: Int
        var bump: Int
    }

    private func row(_ i: ServerInvite) -> some View {
        let uses = "\(i.uses)명 가입\(i.maxUses.map { " / \($0)번" } ?? "")"
        let expiry = i.expiresAt.map { "\(AdminDates.date($0)) 만료" } ?? "만료 없음"
        return HStack(alignment: .center, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: ObSpace.sm) {
                    Text("…\(i.hint)").font(ObFont.mono).foregroundStyle(Ob.text)
                    if !i.note.isEmpty {
                        Text(i.note).font(ObFont.body).foregroundStyle(Ob.text).lineLimit(1)
                    }
                    if !i.valid { Chip(text: i.endedLabel, filled: true) }
                }
                Text("\(uses) · \(expiry) · \(i.createdBy ?? "알 수 없음") · \(relativeTime(i.createdAt))")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .opacity(i.valid ? 1 : 0.7)
            if i.valid {
                Button("취소") { revoking = i }
                    .buttonStyle(.ob(.outline, size: .small))
                    .confirmationDialog(
                        "이 초대 링크를 취소할까요?",
                        isPresented: Binding(get: { revoking?.id == i.id }, set: { if !$0 { revoking = nil } }),
                        titleVisibility: .visible
                    ) {
                        Button("링크 취소", role: .destructive) { Task { await revoke(i) } }
                        Button("닫기", role: .cancel) {}
                    } message: {
                        Text("이 링크로는 더 이상 가입할 수 없어요. 이미 가입한 계정은 그대로예요.")
                    }
            }
        }
        .orgRow(vertical: 12)
    }

    private func load() async {
        struct R: Decodable { var invites: [ServerInvite] }
        if let r: R = try? await API.shared.get("/api/admin/invites") {
            withAnimation(ObMotion.standard) { invites = r.invites }
        } else if invites == nil {
            invites = []
        }
    }

    private func revoke(_ i: ServerInvite) async {
        do {
            try await API.shared.send(.delete, "/api/admin/invites/\(adminPath(i.id))")
            Haptics.success()
            store.toasts.show("초대 링크를 취소했어요")
            bump += 1
        } catch {
            store.adminFailed(error, "취소하지 못했어요")
        }
    }
}

/// 서버 초대 링크 만들기 (web CreateInvite): a note, how many uses, when it ends; the link shows once.
struct AdminCreateInviteSheet: View {
    var onCreated: () -> Void

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var maxUses: Int? = 1
    @State private var days: Int? = 7
    @State private var url: String?
    @State private var busy = false
    @FocusState private var focused: Bool

    private static let uses: [(value: Int?, label: String)] = [(1, "1번"), (5, "5번"), (25, "25번"), (nil, "제한 없음")]
    private static let expires: [(value: Int?, label: String)] = [(1, "1일"), (7, "7일"), (30, "30일"), (nil, "없음")]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    OrgSheetHeader(
                        title: "서버 초대 링크",
                        description: url == nil
                            ? "링크를 가진 사람은 정한 횟수만큼 이 서버에 가입할 수 있어요."
                            : "링크는 지금 한 번만 보여요. 복사해서 전해 주세요."
                    )
                    if let url {
                        JevCopyField(value: url, label: "초대 링크", done: "초대 링크를 복사했어요", wraps: true)
                        ShareLink(item: url) {
                            Label("공유", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(.ob(.outline, size: .large, fullWidth: true))
                    } else {
                        VStack(alignment: .leading, spacing: ObSpace.sm) {
                            Text("메모 \(Text("(누구에게 줬는지, 목록에만 보여요)").foregroundStyle(Ob.text3))")
                                .font(ObFont.footnote.weight(.medium))
                                .foregroundStyle(Ob.text2)
                            TextField("예: 디자인팀 김민지", text: $note)
                                .textFieldStyle(.ob(focused: focused))
                                .focused($focused)
                                .submitLabel(.done)
                                .onChange(of: note) { _, v in if v.count > 80 { note = String(v.prefix(80)) } }
                                .accessibilityLabel("메모")
                        }
                        option("쓸 수 있는 횟수", Self.uses, $maxUses)
                        option("만료", Self.expires, $days)
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
                .animation(ObMotion.standard, value: url)
            }
            .scrollDismissesKeyboard(.interactively)
            .obPage()
            .toolbar {
                if url == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("취소") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(busy ? "만드는 중…" : "만들기") { Task { await create() } }
                            .fontWeight(.semibold)
                            .disabled(busy)
                    }
                } else {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("완료") { dismiss() }
                            .fontWeight(.semibold)
                    }
                }
            }
        }
    }

    private func option(_ title: String, _ options: [(value: Int?, label: String)], _ selection: Binding<Int?>) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            Text(title).font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
            Picker(title, selection: Binding(
                get: { options.firstIndex { $0.value == selection.wrappedValue } ?? 0 },
                set: { selection.wrappedValue = options[$0].value }
            )) {
                ForEach(options.indices, id: \.self) { i in
                    Text(options[i].label).tag(i)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private func create() async {
        struct R: Decodable { var url: String }
        focused = false
        busy = true
        defer { busy = false }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        var body: [String: JSONValue] = ["maxUses": .orNull(maxUses), "expiresInDays": .orNull(days)]
        if !trimmed.isEmpty { body["note"] = .string(trimmed) }
        do {
            let r: R = try await API.shared.send(.post, "/api/admin/invites", json: .object(body))
            Haptics.success()
            url = r.url
            onCreated()
        } catch {
            store.adminFailed(error, "만들지 못했어요")
        }
    }
}
