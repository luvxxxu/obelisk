import SwiftUI

/// Sign in / sign up (web app/AuthForm.tsx), plus the server address so self-hosted servers work.
/// Sign-up says before it is pressed what follows (operator, domains, mail confirmation, approval) and
/// takes an invite link: a server invite (`/signup?invite=osi_…`) or an organization invite.
struct LoginView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    enum Mode { case login, signup }
    enum Field: Hashable { case name, email, password, server, invite }

    @State private var mode: Mode = .login
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var server = Session.server
    @State private var editingServer = false
    @State private var busy = false
    @State private var error: String?
    /// GET /api/auth/signup-status for this server and invite; nil while it loads.
    @State private var status: SignupStatus?
    @State private var invite: InviteLink?
    /// The organization an organization invite names (nil for a server invite or a dead link).
    @State private var inviteOrg: String?
    @State private var enteringInvite = false
    @State private var inviteText = ""
    @State private var inviteError: String?
    @FocusState private var focus: Field?

    private var signupAllowed: Bool? { status?.allowed }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.xxl) {
                VStack(alignment: .leading, spacing: ObSpace.md) {
                    LogoMark(size: 32)
                        .padding(.bottom, ObSpace.sm)
                    Text(mode == .login ? "Obelisk에 로그인" : "계정 만들기")
                        .font(ObFont.title)
                        .foregroundStyle(Ob.text)
                    Text(lead)
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if mode == .signup, signupAllowed == false {
                    VStack(alignment: .leading, spacing: ObSpace.xs) {
                        Text("지금은 가입할 수 없어요").font(ObFont.bodyStrong).foregroundStyle(Ob.text)
                        Text(closedReason)
                            .font(ObFont.sub).foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .obCallout(.neutral)
                }

                VStack(spacing: ObSpace.md) {
                    if mode == .signup {
                        field("이름", text: $name, field: .name)
                            .textContentType(.name)
                    }
                    field("이메일", text: $email, field: .email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    passwordField
                }

                if let error {
                    Text(error)
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.dangerText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .transition(.opacity)
                }

                Button {
                    Task { await submit() }
                } label: {
                    if busy {
                        Text("잠시만요…")
                    } else {
                        Text(mode == .login ? "로그인" : "시작하기")
                    }
                }
                .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
                .disabled(busy || !canSubmit)

                if mode == .signup, let notes = status?.notes, !notes.isEmpty {
                    VStack(spacing: 4) {
                        ForEach(notes, id: \.self) { Text($0) }
                    }
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, -ObSpace.md)
                    .transition(.opacity)
                }

                HStack(spacing: 6) {
                    Text(mode == .login ? "처음이신가요?" : "이미 계정이 있나요?")
                        .foregroundStyle(Ob.text3)
                    Button(mode == .login ? "계정 만들기" : "로그인") {
                        withAnimation(ObMotion.standard) {
                            mode = mode == .login ? .signup : .login
                            error = nil
                        }
                    }
                    .foregroundStyle(Ob.text)
                    .fontWeight(.medium)
                }
                .font(ObFont.sub)
                .frame(maxWidth: .infinity)

                if mode == .signup || invite != nil { inviteRow }

                serverRow
            }
            .padding(.horizontal, ObSpace.xxl)
            .padding(.top, 72)
            .padding(.bottom, ObSpace.xxxl)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .obPage()
        .animation(ObMotion.standard, value: error)
        .animation(ObMotion.standard, value: status)
        .animation(ObMotion.standard, value: enteringInvite)
        .animation(ObMotion.standard, value: invite)
        // What sign-up allows here (with this invite): on the way in, and whenever the server or link changes.
        .task(id: StatusKey(server: editingServer ? nil : server, invite: invite?.token, signup: mode == .signup)) {
            guard mode == .signup, !editingServer else { return }
            status = await API.shared.signupStatus(invite: invite?.token)
        }
        .onAppear(perform: takePendingInvite)
        .onChange(of: store.pendingSignupInvite) { _, _ in takePendingInvite() }
    }

    private struct StatusKey: Hashable {
        /// nil while the address is being typed: only a committed server is asked.
        var server: String?
        var invite: String?
        var signup: Bool
    }

    /// The line under the title (web AuthForm's description).
    private var lead: String {
        guard let invite else { return "할 일을 적고, 미루면 무엇이 밀리는지 미리 확인하세요." }
        if invite.isServerInvite {
            return mode == .login ? "이미 계정이 있다면 그대로 로그인하세요." : "초대 링크로 이 서버에 가입해요."
        }
        if mode == .login {
            return "로그인하면 \(inviteOrg.map { "‘\($0)’ " } ?? "")초대를 수락할 수 있어요."
        }
        return "계정을 만들면 \(inviteOrg.map { "‘\($0)’에 " } ?? "초대받은 조직에 ")바로 참여해요."
    }

    private var closedReason: String {
        if invite != nil { return "초대 링크가 만료됐거나 더 이상 쓸 수 없어요. 링크를 준 사람에게 새 링크를 받으세요." }
        if status?.mode == .invite {
            return "이 서버는 초대 링크로만 가입할 수 있어요. 서버 운영자나 조직 관리자에게 받은 초대 링크를 아래에 붙여 넣으세요."
        }
        return "이 서버는 새 계정 가입을 받지 않아요. 서버 운영자에게 문의하세요."
    }

    // MARK: invite link

    /// "초대 링크가 있어요" → a field for the link; with one in use, which kind and a way to drop it.
    private var inviteRow: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            if let invite {
                HStack(spacing: 6) {
                    Image(systemName: "link")
                    Text(invite.isServerInvite ? "서버 초대 링크" : inviteOrg.map { "‘\($0)’ 초대 링크" } ?? "조직 초대 링크")
                        .lineLimit(1)
                    Button("지우기") { setInvite(nil) }
                        .fontWeight(.medium)
                        .foregroundStyle(Ob.text2)
                }
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                .frame(maxWidth: .infinity)
            } else if enteringInvite {
                Text("초대 링크").font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
                TextField(text: $inviteText, prompt: Text(verbatim: "https://…/signup?invite=…")) { Text("초대 링크") }
                    .textFieldStyle(.ob(focused: focus == .invite))
                    .focused($focus, equals: .invite)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit(commitInvite)
                Text(inviteError ?? "서버 운영자나 조직 관리자에게 받은 링크를 붙여 넣으세요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(inviteError == nil ? Ob.text3 : Ob.dangerText)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Button {
                    enteringInvite = true
                    focus = .invite
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "link")
                        Text("초대 링크가 있어요")
                    }
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func commitInvite() {
        if inviteText.trimmingCharacters(in: .whitespaces).isEmpty {
            inviteError = nil
            enteringInvite = false
            return
        }
        guard let link = InviteLink(inviteText) else {
            inviteError = "초대 링크를 읽지 못했어요. 받은 링크 전체를 붙여 넣어 주세요."
            Haptics.error()
            return
        }
        setInvite(link)
    }

    /// Use this invite (nil: none). A web link to another server moves the login screen to that server.
    private func setInvite(_ link: InviteLink?) {
        inviteError = nil
        inviteText = ""
        enteringInvite = false
        if focus == .invite { focus = nil }
        if let s = link?.server, Session.normalize(s) != Session.server {
            Session.server = s
            server = Session.server
            editingServer = false
        }
        invite = link
        inviteOrg = nil
        guard let link else { return }
        if link.isServerInvite {
            mode = .signup
        } else {
            Task { await loadInviteOrg(link.token) }
        }
    }

    private func loadInviteOrg(_ token: String) async {
        struct R: Decodable { var invite: InvitePreview }
        let path = "/api/invites/\(token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? token)"
        guard let r: R = try? await API.shared.get(path), invite?.token == token else { return }
        inviteOrg = r.invite.valid ? r.invite.workspace.name : nil
    }

    /// A link opened while signed out (DeepLinks) lands here.
    private func takePendingInvite() {
        guard let link = store.pendingSignupInvite else { return }
        store.pendingSignupInvite = nil
        setInvite(link)
    }

    private var canSubmit: Bool {
        !email.isEmpty && !password.isEmpty && (mode == .login || (!name.trimmingCharacters(in: .whitespaces).isEmpty && signupAllowed != false))
    }

    private func field(_ label: String, text: Binding<String>, field: Field) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
            TextField("", text: text)
                .textFieldStyle(.ob(focused: focus == field))
                .focused($focus, equals: field)
                .submitLabel(.next)
                .onSubmit { advance(from: field) }
        }
    }

    private var passwordField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("비밀번호").font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
            HStack(spacing: 0) {
                Group {
                    if showPassword {
                        TextField("", text: $password)
                    } else {
                        SecureField("", text: $password)
                    }
                }
                .textContentType(mode == .login ? .password : .newPassword)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focus, equals: .password)
                .submitLabel(.go)
                .onSubmit { Task { await submit() } }
                Button {
                    showPassword.toggle()
                } label: {
                    Image(systemName: showPassword ? "eye.slash" : "eye")
                        .foregroundStyle(Ob.text3)
                        .frame(width: 36, height: 36)
                }
                .accessibilityLabel("비밀번호 표시")
            }
            .font(ObFont.body)
            .padding(.leading, ObSpace.md)
            .padding(.trailing, ObSpace.xs)
            .frame(minHeight: ObSize.controlLg)
            .overlay(
                RoundedRectangle(cornerRadius: ObRadius.md)
                    .strokeBorder(focus == .password ? Ob.text3 : Ob.input, lineWidth: 1)
            )
            if mode == .signup {
                Text("8자 이상으로 만들어 주세요.").font(ObFont.footnote).foregroundStyle(Ob.text3)
            }
        }
    }

    private var serverRow: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            if editingServer {
                Text("서버 주소").font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
                TextField("https://obelisk.example.com", text: $server)
                    .textFieldStyle(.ob(focused: focus == .server))
                    .focused($focus, equals: .server)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { commitServer() }
            } else {
                Button {
                    editingServer = true
                    focus = .server
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "server.rack")
                        Text(URL(string: server)?.host() ?? server)
                        Text("변경").fontWeight(.medium).foregroundStyle(Ob.text2)
                    }
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.top, ObSpace.lg)
    }

    private func advance(from f: Field) {
        switch f {
        case .name: focus = .email
        case .email: focus = .password
        default: focus = nil
        }
    }

    private func commitServer() {
        Session.server = server
        server = Session.server
        editingServer = false
    }

    private func submit() async {
        guard canSubmit, !busy else { return }
        if editingServer { commitServer() }
        focus = nil
        busy = true
        error = nil
        defer { busy = false }
        do {
            if mode == .login {
                let user = try await API.shared.login(email: email.trimmingCharacters(in: .whitespaces), password: password)
                await store.signedIn(user: user)
            } else {
                if password.count < 8 {
                    error = "비밀번호는 8자 이상으로 만들어 주세요."
                    return
                }
                let r = try await API.shared.signup(
                    name: name.trimmingCharacters(in: .whitespaces),
                    email: email.trimmingCharacters(in: .whitespaces),
                    password: password,
                    inviteToken: invite?.token
                )
                // Signing up through an organization invite already joined it: no need to show the invite again.
                if r.joinedWorkspaceId != nil, router.sheet?.id == "invite" { router.dismissSheet() }
                await store.signedIn(user: r.user, workspaceId: r.joinedWorkspaceId)
            }
        } catch {
            let msg = (error as? APIError)?.message
            self.error = msg ?? (mode == .login ? "로그인하지 못했어요" : "계정을 만들지 못했어요")
            Haptics.error()
        }
    }
}
