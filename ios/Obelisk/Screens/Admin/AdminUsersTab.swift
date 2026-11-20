import SwiftUI

/// 서버 관리 › 사용자 (web admin/users): search, filter (승인 대기 · 메일 확인 전 · 정지됨 · 운영자),
/// and per account: approve/reject, suspend/unsuspend, a password reset link, let in without mail,
/// operator on/off, delete. Names, addresses, dates and counts only.
struct AdminUsersTab: View {
    var reload: Int
    @Binding var filter: AdminUserFilter

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var q = ""
    @State private var query = ""
    @State private var data: AdminUserList?
    @State private var error: String?
    @State private var loadingMore = false
    @State private var busy: String?
    @State private var rejecting: AdminUser?
    @State private var role: (user: AdminUser, admin: Bool)?

    private static let page = 50

    var body: some View {
        OrgSection(data.map { "사용자 \(formatCount($0.count(.all)))명" } ?? "사용자") {
            VStack(alignment: .leading, spacing: ObSpace.md) {
                OrgSearchField(prompt: "이름이나 이메일로 찾기", text: $q, label: "사용자 찾기")
                filters
                if let error { AdminErrorCallout(message: error) }
                if let data {
                    OrgCard(inset: 60) {
                        if data.users.isEmpty {
                            OrgEmptyRow(text: !query.isEmpty ? "‘\(query)’에 맞는 계정이 없어요" : filter == .pending ? "승인을 기다리는 사람이 없어요" : "계정이 없어요")
                        }
                        ForEach(data.users) { u in row(u) }
                    }
                    if data.users.count < data.total {
                        AdminMoreButton(label: "더 보기 (\(formatCount(data.total - data.users.count))명 더)", busy: loadingMore) {
                            Task { await more() }
                        }
                    }
                } else if error == nil {
                    AdminLoading()
                }
            }
        }
        // Type, pause, search.
        .task(id: q) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            query = q.trimmingCharacters(in: .whitespaces)
        }
        .task(id: Key(filter: filter, query: query, reload: reload)) { await load() }
    }

    /// 거절 and 운영자 지정·해제 ask first, anchored to the person's row (the popover points at them).
    private func confirmations(_ u: AdminUser) -> some ViewModifier {
        AdminUserConfirmations(
            user: u,
            rejecting: Binding(get: { rejecting?.id == u.id }, set: { if !$0 { rejecting = nil } }),
            role: Binding(get: { role?.user.id == u.id ? role?.admin : nil }, set: { if $0 == nil { role = nil } }),
            reject: { Task { await reject(u) } },
            setAdmin: { on in Task { await setAdmin(u, on) } }
        )
    }

    private struct Key: Hashable {
        var filter: AdminUserFilter
        var query: String
        var reload: Int
    }

    // MARK: filter chips

    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: ObSpace.xs) {
                ForEach(AdminUserFilter.allCases) { f in
                    let n = data?.count(f) ?? 0
                    Button {
                        guard filter != f else { return }
                        Haptics.select()
                        filter = f
                    } label: {
                        HStack(spacing: 5) {
                            Text(f.labelKo)
                            if f != .all, n > 0 {
                                Text("\(n)")
                                    .foregroundStyle(filter == f ? Ob.text2 : Ob.text3)
                                    .monospacedDigit()
                            }
                        }
                        .font(ObFont.footnote.weight(.medium))
                        .foregroundStyle(filter == f ? Ob.text : Ob.text2)
                        .padding(.horizontal, ObSpace.md)
                        .frame(height: 32)
                        .background(filter == f ? Ob.surface3 : Color.clear, in: Capsule())
                        .overlay(Capsule().strokeBorder(filter == f ? Color.clear : Ob.border, lineWidth: 1))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(filter == f ? [.isSelected] : [])
                }
            }
        }
        .scrollClipDisabled()
    }

    // MARK: rows

    private func row(_ u: AdminUser) -> some View {
        let me = u.id == store.user?.id
        let meta = [
            u.email,
            "\(AdminDates.date(u.createdAt)) 가입",
            u.lastSeenAt.map { "\(relativeTime($0)) 접속" } ?? "접속 기록 없음",
            u.orgs > 0 ? "조직 \(u.orgs)\(u.ownedOrgs > 0 ? " (소유 \(u.ownedOrgs))" : "")" : nil,
            u.aiConnections > 0 || u.apiTokens > 0 ? "AI 연결 \(u.aiConnections) · 토큰 \(u.apiTokens)" : nil,
        ].compactMap { $0 }
        return HStack(alignment: .top, spacing: ObSpace.md) {
            Avatar(name: u.name, size: 32)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 0) {
                    Text(u.name).foregroundStyle(Ob.text)
                    if me { Text(" (나)").foregroundStyle(Ob.text3) }
                }
                .font(ObFont.body)
                .lineLimit(1)
                badges(u)
                Text(meta.joined(separator: " · "))
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
                if u.state == .pending || u.state == .suspended {
                    HStack(spacing: ObSpace.sm) {
                        if u.state == .pending {
                            Button("승인") { Task { await approve(u) } }
                                .buttonStyle(.ob(.primary, size: .small))
                            Button("거절") { rejecting = u }
                                .buttonStyle(.ob(.outline, size: .small))
                        } else {
                            Button("정지 풀기") { Task { await unsuspend(u) } }
                                .buttonStyle(.ob(.outline, size: .small))
                        }
                    }
                    .disabled(busy == u.id)
                    .padding(.top, ObSpace.xs)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if busy == u.id {
                ProgressView().controlSize(.small).padding(.top, 6)
            }
            menu(u, me: me)
                .modifier(confirmations(u))
        }
        .orgRow(vertical: 12)
        .accessibilityElement(children: .contain)
    }

    private func badges(_ u: AdminUser) -> some View {
        FlowRow(spacing: 4, lineSpacing: 4) {
            if u.admin { Chip(text: "운영자", symbol: "shield", filled: true) }
            if u.state != .active {
                Chip(text: u.state.labelKo, tone: u.state == .suspended ? .danger : u.state == .pending ? .warn : .neutral, filled: true)
            }
            if u.emailVerified { Chip(text: "메일 확인됨", filled: true) }
        }
    }

    private func menu(_ u: AdminUser, me: Bool) -> some View {
        Menu {
            if u.state != .suspended {
                Button {
                    present("reset", u) { AdminResetLinkSheet(user: u) }
                } label: {
                    Label("비밀번호 재설정 링크", systemImage: "key")
                }
            }
            if u.state == .unverified {
                Button {
                    Task { await skipVerification(u) }
                } label: {
                    Label("메일 확인 없이 허용", systemImage: "envelope")
                }
            }
            if u.state == .active, !u.admin {
                Button {
                    role = (u, true)
                } label: {
                    Label("운영자로 지정", systemImage: "shield")
                }
            }
            if u.admin {
                Button {
                    role = (u, false)
                } label: {
                    Label("운영자에서 해제", systemImage: "shield.slash")
                }
            }
            if !me, !u.admin {
                Divider()
                if u.state == .suspended {
                    Button {
                        Task { await unsuspend(u) }
                    } label: {
                        Label("정지 풀기", systemImage: "arrow.uturn.backward")
                    }
                } else {
                    Button {
                        present("suspend", u) { AdminSuspendSheet(user: u) { replace($0, u.id) } }
                    } label: {
                        Label("정지", systemImage: "lock")
                    }
                }
                Button(role: .destructive) {
                    present("delete", u) { AdminDeleteUserSheet(user: u) { replace(nil, u.id) } }
                } label: {
                    Label("계정 삭제", systemImage: "trash")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Ob.text2)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("\(u.name) 관리")
    }

    private func present<V: View>(_ id: String, _ u: AdminUser, @ViewBuilder _ content: @escaping () -> V) {
        router.present(.init(id: "admin-\(id)-\(u.id)", detents: [.medium, .large], content: content))
    }

    // MARK: loading

    private func path(offset: Int) -> [String: String?] {
        [
            "filter": filter.rawValue,
            "offset": String(offset),
            "limit": String(Self.page),
            "q": query.isEmpty ? nil : query,
        ]
    }

    private func load() async {
        do {
            let d: AdminUserList = try await API.shared.get("/api/admin/users", query: path(offset: 0))
            data = d
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했어요"
        }
    }

    private func more() async {
        guard let data else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let d: AdminUserList = try await API.shared.get("/api/admin/users", query: path(offset: data.users.count))
            self.data = AdminUserList(users: data.users + d.users, total: d.total, counts: d.counts)
        } catch {
            store.adminFailed(error, "불러오지 못했어요")
        }
    }

    /// Swap one account in place after an action (or drop it when it no longer fits the filter), then
    /// refresh the counts on the filter chips.
    private func replace(_ u: AdminUser?, _ id: String) {
        guard var d = data else { return }
        if let u, filter.fits(u) {
            d.users = d.users.map { $0.id == id ? u : $0 }
        } else if d.users.contains(where: { $0.id == id }) {
            d.users.removeAll { $0.id == id }
            d.total = max(0, d.total - 1)
        }
        withAnimation(ObMotion.standard) { data = d }
        Task {
            if let r: AdminUserList = try? await API.shared.get("/api/admin/users", query: ["limit": "1", "q": query.isEmpty ? nil : query]) {
                data?.counts = r.counts
            }
        }
    }

    private struct UserResponse: Decodable { var user: AdminUser }

    private func act(_ u: AdminUser, failed: String, done: String, _ run: () async throws -> AdminUser?) async {
        busy = u.id
        defer { busy = nil }
        do {
            let r = try await run()
            replace(r, u.id)
            Haptics.success()
            store.toasts.show(done)
        } catch {
            store.adminFailed(error, failed)
        }
    }

    private func approve(_ u: AdminUser) async {
        await act(u, failed: "승인하지 못했어요", done: "\(u.name)님의 가입을 승인했어요") {
            let r: UserResponse = try await API.shared.send(.post, "/api/admin/users/\(adminPath(u.id))/approve")
            return r.user
        }
    }

    private func reject(_ u: AdminUser) async {
        await act(u, failed: "거절하지 못했어요", done: "\(u.name)님의 가입을 거절했어요") {
            try await API.shared.send(.post, "/api/admin/users/\(adminPath(u.id))/reject")
            return nil
        }
    }

    private func unsuspend(_ u: AdminUser) async {
        await act(u, failed: "정지를 풀지 못했어요", done: "\(u.name)님의 정지를 풀었어요") {
            let r: UserResponse = try await API.shared.send(.post, "/api/admin/users/\(adminPath(u.id))/unsuspend")
            return r.user
        }
    }

    private func skipVerification(_ u: AdminUser) async {
        await act(u, failed: "허용하지 못했어요", done: "\(u.name)님은 이제 메일 확인 없이 쓸 수 있어요") {
            let r: UserResponse = try await API.shared.send(.post, "/api/admin/users/\(adminPath(u.id))/skip-verification")
            return r.user
        }
    }

    private func setAdmin(_ u: AdminUser, _ admin: Bool) async {
        await act(u, failed: admin ? "운영자로 지정하지 못했어요" : "운영자에서 해제하지 못했어요",
                  done: admin ? "\(u.name)님을 운영자로 지정했어요" : "\(u.name)님을 운영자에서 해제했어요") {
            let r: UserResponse = try await API.shared.send(.post, "/api/admin/users/\(adminPath(u.id))/admin", json: ["admin": .bool(admin)])
            return r.user
        }
        // Stepping down yourself: the account loses 서버 관리.
        if u.id == store.user?.id, !admin { await store.refresh() }
    }
}

private struct AdminUserConfirmations: ViewModifier {
    var user: AdminUser
    @Binding var rejecting: Bool
    /// true: 운영자로 지정 · false: 해제 · nil: not asking.
    @Binding var role: Bool?
    var reject: () -> Void
    var setAdmin: (Bool) -> Void

    func body(content: Content) -> some View {
        content
            .confirmationDialog("\(user.name)님의 가입을 거절할까요?", isPresented: $rejecting, titleVisibility: .visible) {
                Button("거절", role: .destructive, action: reject)
                Button("취소", role: .cancel) {}
            } message: {
                Text("신청하며 만든 계정이 바로 삭제돼요. 다시 가입하려면 처음부터 신청해야 해요.")
            }
            .confirmationDialog(
                role == true ? "\(user.name)님을 운영자로 지정할까요?" : "\(user.name)님을 운영자에서 해제할까요?",
                isPresented: Binding(get: { role != nil }, set: { if !$0 { role = nil } }),
                titleVisibility: .visible
            ) {
                if role == true {
                    Button("운영자로 지정") { setAdmin(true) }
                } else {
                    Button("해제", role: .destructive) { setAdmin(false) }
                }
                Button("취소", role: .cancel) {}
            } message: {
                Text(role == true
                    ? "운영자는 가입 방식과 서버 설정을 바꾸고, 계정을 승인·정지·삭제하고, 다른 운영자를 지정할 수 있어요. 다른 사람의 작업 내용은 운영자도 볼 수 없어요."
                    : "서버 관리 화면에 더 이상 들어올 수 없어요. 운영자는 최소 한 명 있어야 해요.")
            }
    }
}

// MARK: - 비밀번호 재설정 링크

/// A one-time link to set a new password, to copy and hand over (or mail, when the server can).
struct AdminResetLinkSheet: View {
    var user: AdminUser

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var url: String?
    @State private var mailed = false
    @State private var busy: Busy?
    @State private var mailOK = false

    enum Busy { case link, mail }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    OrgSheetHeader(
                        title: "비밀번호 재설정 링크",
                        description: "\(user.name)님(\(user.email))이 새 비밀번호를 정할 수 있는 링크예요. 60분 동안 한 번만 쓸 수 있고, 쓰면 다른 기기에서 모두 로그아웃돼요."
                    )
                    if let url {
                        Text(mailed
                            ? "\(user.email)(으)로 보냈어요. 메일이 오지 않으면 아래 링크를 직접 전해 주세요."
                            : "본인에게만 전해 주세요. 이 링크를 가진 사람은 누구든 이 계정의 비밀번호를 바꿀 수 있어요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                        JevCopyField(value: url, label: "재설정 링크", done: "링크를 복사했어요", wraps: true)
                    } else {
                        Text("운영자는 비밀번호를 직접 정하거나 볼 수 없어요. 링크를 받은 사람이 정해요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                        VStack(spacing: ObSpace.sm) {
                            Button(busy == .link ? "만드는 중…" : "링크 만들기") { Task { await make(mail: false) } }
                                .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
                            if mailOK {
                                Button(busy == .mail ? "보내는 중…" : "메일로 보내기") { Task { await make(mail: true) } }
                                    .buttonStyle(.ob(.outline, size: .large, fullWidth: true))
                            }
                        }
                        .disabled(busy != nil)
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
                .animation(ObMotion.standard, value: url)
            }
            .obPage()
            .toolbar {
                ToolbarItem(placement: url == nil ? .cancellationAction : .confirmationAction) {
                    Button(url == nil ? "취소" : "닫기") { dismiss() }
                        .fontWeight(url == nil ? .regular : .semibold)
                }
            }
        }
        .task {
            struct R: Decodable { var available: Bool }
            let r: R? = try? await API.shared.get("/api/auth/password-reset")
            mailOK = r?.available ?? false
        }
    }

    private func make(mail: Bool) async {
        struct R: Decodable { var url: String; var mailed: Bool }
        busy = mail ? .mail : .link
        defer { busy = nil }
        do {
            let r: R = try await API.shared.send(.post, "/api/admin/users/\(adminPath(user.id))/reset-link", json: ["mail": .bool(mail)])
            Haptics.success()
            url = r.url
            mailed = r.mailed
        } catch {
            store.adminFailed(error, "링크를 만들지 못했어요")
        }
    }
}

// MARK: - 정지

struct AdminSuspendSheet: View {
    var user: AdminUser
    var onDone: (AdminUser) -> Void

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    OrgSheetHeader(title: "\(user.name)님을 정지할까요?")
                    OrgNotes(lines: [
                        "바로 로그아웃되고 다시 로그인할 수 없어요.",
                        "API 토큰과 AI 연결(Claude, ChatGPT 등)이 끊겨요. 정지를 풀어도 다시 연결해야 해요.",
                        "이 사람이 만든 받는 웹훅이 멈춰요.",
                        "작업, 프로젝트, 조직 멤버 자리는 그대로 남아요.",
                    ])
                    VStack(alignment: .leading, spacing: ObSpace.sm) {
                        Text("메모 \(Text("(운영 기록에만 남아요)").foregroundStyle(Ob.text3))")
                            .font(ObFont.footnote.weight(.medium))
                            .foregroundStyle(Ob.text2)
                        TextField("예: 스팸 계정", text: $note)
                            .textFieldStyle(.ob(focused: focused))
                            .focused($focused)
                            .submitLabel(.done)
                            .onChange(of: note) { _, v in if v.count > 200 { note = String(v.prefix(200)) } }
                            .accessibilityLabel("메모")
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await submit() }
                } label: {
                    Text(busy ? "정지하는 중…" : "정지")
                }
                .buttonStyle(.ob(.danger, size: .large, fullWidth: true))
                .disabled(busy)
                .padding(.horizontal, ObSpace.page)
                .padding(.vertical, ObSpace.sm)
                .background(Ob.bg)
            }
            .obPage()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
            }
        }
    }

    private func submit() async {
        struct R: Decodable { var user: AdminUser }
        busy = true
        defer { busy = false }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let r: R = try await API.shared.send(.post, "/api/admin/users/\(adminPath(user.id))/suspend",
                                                 json: trimmed.isEmpty ? [:] : ["note": .string(trimmed)])
            Haptics.success()
            store.toasts.show("\(user.name)님을 정지했어요")
            onDone(r.user)
            dismiss()
        } catch {
            store.adminFailed(error, "정지하지 못했어요")
        }
    }
}

// MARK: - 계정 삭제

struct AdminDeleteUserSheet: View {
    var user: AdminUser
    var onDone: () -> Void

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var preview: AccountDeletionPreview?
    @State private var confirm = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var blocked: Bool { !(preview?.blockers.isEmpty ?? true) }
    private var matches: Bool { confirm.trimmingCharacters(in: .whitespaces).lowercased() == user.email.lowercased() }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    OrgSheetHeader(title: "\(user.email) 계정을 삭제할까요?")
                    if let error {
                        Text(error)
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.dangerText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .obCallout(.danger)
                    }
                    if let p = preview {
                        if blocked {
                            Text("\(p.blockers.map { "‘\($0.name)’" }.joined(separator: ", "))의 마지막 소유자라서 지금은 삭제할 수 없어요. 조직 안에서 다른 멤버를 소유자로 정해야 해요. 소유자가 정지된 상태라면 먼저 조직 탭에서 소유자를 지정하세요.")
                                .font(ObFont.sub)
                                .foregroundStyle(Ob.text2)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            OrgNotes(lines: [
                                "개인 공간의 프로젝트 \(p.personal.projects)개, 작업 \(p.personal.tasks)개가 지워져요.",
                                p.soloOrgs.isEmpty ? nil : "혼자 있는 조직 \(p.soloOrgs.map { "‘\($0.name)’" }.joined(separator: ", "))도 지워져요.",
                                p.sharedOrgs > 0 ? "다른 사람과 함께 쓰던 조직 \(p.sharedOrgs)곳에서는 빠지고, 만든 작업은 남아요." : nil,
                                "되돌릴 수 없어요.",
                            ].compactMap { $0 })
                            VStack(alignment: .leading, spacing: ObSpace.sm) {
                                Text("확인을 위해 \(Text(user.email).fontWeight(.semibold).foregroundStyle(Ob.text))을 입력하세요")
                                    .font(ObFont.footnote)
                                    .foregroundStyle(Ob.text2)
                                TextField("", text: $confirm)
                                    .textFieldStyle(.ob(focused: focused))
                                    .focused($focused)
                                    .keyboardType(.emailAddress)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .submitLabel(.done)
                                    .accessibilityLabel("확인용 이메일")
                            }
                        }
                    } else if error == nil {
                        AdminLoading(height: 80)
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) {
                if preview != nil, !blocked {
                    Button {
                        Task { await delete() }
                    } label: {
                        Text(busy ? "삭제하는 중…" : "영구 삭제")
                    }
                    .buttonStyle(.ob(.danger, size: .large, fullWidth: true))
                    .disabled(busy || !matches)
                    .padding(.horizontal, ObSpace.page)
                    .padding(.vertical, ObSpace.sm)
                    .background(Ob.bg)
                }
            }
            .obPage()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
            }
        }
        .task {
            do {
                preview = try await API.shared.get("/api/admin/users/\(adminPath(user.id))/deletion")
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했어요"
            }
        }
    }

    private func delete() async {
        guard matches, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await API.shared.send(.delete, "/api/admin/users/\(adminPath(user.id))", json: ["confirm": .string(confirm.trimmingCharacters(in: .whitespaces))])
            Haptics.success()
            store.toasts.show("\(user.email) 계정을 삭제했어요")
            onDone()
            dismiss()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "삭제하지 못했어요"
        }
    }
}
