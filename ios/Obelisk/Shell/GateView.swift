import SwiftUI

/// Signed in, but not let in yet (web components/GateScreen.tsx): the address isn't confirmed, or an
/// operator hasn't approved the sign-up. Shown instead of the app; checks again whenever the app comes
/// back to the front (the mailed link opens in Safari) and every 30 seconds while it is in front.
struct GateView: View {
    var gate: AccountGate

    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var phase

    enum Busy { case send, check }
    enum Field: Hashable { case email, password }

    /// GET /api/auth/me has answered (or failed: the buttons still work without it).
    @State private var loaded = false
    @State private var mailAvailable = false
    @State private var busy: Busy?
    @State private var changing = false
    @State private var newEmail = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var error: String?
    /// A quiet line under the buttons: mail sent, or "not yet" after a check.
    @State private var note: String?
    @State private var sentTo: String?
    @FocusState private var focus: Field?

    private var unverified: Bool { gate == .emailUnverified }
    private var email: String? { store.user.map(\.email).flatMap { $0.isEmpty ? nil : $0 } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.xxl) {
                header

                if !loaded {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    VStack(alignment: .leading, spacing: ObSpace.lg) {
                        if let error {
                            VStack(alignment: .leading, spacing: ObSpace.xs) {
                                Text("요청을 처리하지 못했어요").font(ObFont.bodyStrong).foregroundStyle(Ob.dangerText)
                                Text(error).font(ObFont.sub).foregroundStyle(Ob.dangerText)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .obCallout(.danger)
                            .transition(.opacity)
                        }
                        if unverified, changing {
                            changeForm
                                .transition(.opacity)
                        } else {
                            buttons
                                .transition(.opacity)
                        }
                        if let note {
                            Text(note)
                                .font(ObFont.footnote)
                                .foregroundStyle(Ob.text3)
                                .frame(maxWidth: .infinity)
                                .multilineTextAlignment(.center)
                                .transition(.opacity)
                        }
                    }
                }

                Button("다른 계정으로 로그인") {
                    Task { await store.logout() }
                }
                .font(ObFont.sub.weight(.medium))
                .foregroundStyle(Ob.text2)
                .frame(maxWidth: .infinity)
                .padding(.top, ObSpace.lg)
            }
            .padding(.horizontal, ObSpace.xxl)
            .padding(.top, 72)
            .padding(.bottom, ObSpace.xxxl)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .obPage()
        .animation(ObMotion.standard, value: changing)
        .animation(ObMotion.standard, value: error)
        .animation(ObMotion.standard, value: note)
        .task { await loadMe() }
        // Confirmed in Safari, or approved meanwhile: coming back is enough.
        .task(id: phase) {
            guard phase == .active else { return }
            await recheck()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { break }
                await recheck()
            }
        }
    }

    // MARK: parts

    private var header: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            LogoMark(size: 32)
                .padding(.bottom, ObSpace.sm)
            Text(unverified ? "메일 주소를 확인해 주세요" : "가입 승인을 기다리고 있어요")
                .font(ObFont.title)
                .foregroundStyle(Ob.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            description
                .font(ObFont.body)
                .foregroundStyle(Ob.text2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var description: Text {
        if unverified {
            let lead: Text = (sentTo ?? email).map { Text("\(address($0)) 주소로") } ?? Text("가입한 주소로")
            return Text("\(lead) 보낸 메일의 버튼을 누르면 바로 시작할 수 있어요. 링크는 24시간 동안 쓸 수 있어요.")
        }
        if let email, mailAvailable {
            return Text("이 서버는 운영자가 가입을 승인해야 쓸 수 있어요. 승인되면 \(address(email)) 주소로 알려 드려요.")
        }
        return Text("이 서버는 운영자가 가입을 승인해야 쓸 수 있어요.")
    }

    private func address(_ s: String) -> Text {
        Text(s).foregroundStyle(Ob.text).fontWeight(.medium)
    }

    private var buttons: some View {
        VStack(spacing: ObSpace.sm) {
            Button {
                Task { await check() }
            } label: {
                Text(busy == .check ? "확인하는 중…" : unverified ? "확인했어요" : "다시 확인하기")
            }
            .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
            .disabled(busy == .check)

            if unverified {
                Button {
                    Task { await resend() }
                } label: {
                    Text(busy == .send ? "보내는 중…" : "확인 메일 다시 받기")
                }
                .buttonStyle(.ob(.outline, size: .large, fullWidth: true))
                .disabled(busy == .send || !mailAvailable)

                Button("주소를 잘못 적었어요") {
                    error = nil
                    note = nil
                    changing = true
                    focus = .email
                }
                .buttonStyle(.ob(.ghost, size: .large, fullWidth: true))
            }
        }
    }

    private var changeForm: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 6) {
                Text("새 메일 주소").font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
                // Verbatim: a localized key would turn the address into a blue link.
                TextField(text: $newEmail, prompt: Text(verbatim: "name@example.com")) { Text("새 메일 주소") }
                    .textFieldStyle(.ob(focused: focus == .email))
                    .focused($focus, equals: .email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("비밀번호").font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
                ObPasswordField(text: $password, show: $showPassword, focused: focus == .password, contentType: .password)
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit { Task { await change() } }
                Text("본인 확인을 위해 비밀번호를 입력해 주세요.").font(ObFont.footnote).foregroundStyle(Ob.text3)
            }
            VStack(spacing: ObSpace.sm) {
                Button {
                    Task { await change() }
                } label: {
                    Text(busy == .send ? "보내는 중…" : "이 주소로 확인 메일 받기")
                }
                .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
                .disabled(busy == .send || newEmail.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)

                Button("취소") {
                    focus = nil
                    changing = false
                    error = nil
                }
                .buttonStyle(.ob(.ghost, size: .large, fullWidth: true))
            }
            .padding(.top, ObSpace.xs)
        }
    }

    // MARK: actions

    private func loadMe() async {
        do {
            let r: MeResponse = try await API.shared.get("/api/auth/me")
            store.setUser(r.user)
            mailAvailable = r.mailAvailable ?? false
        } catch let e as APIError where e.isUnauthorized {
            store.signedOut()
            return
        } catch {
            // Keep the screen usable: the buttons still work without the address.
        }
        loaded = true
    }

    /// Back in front or on the timer: load quietly; the store leaves this screen when the account is in.
    private func recheck() async {
        guard busy == nil, !changing else { return }
        await store.load(silent: true)
    }

    private func check() async {
        busy = .check
        error = nil
        note = nil
        await store.load(silent: true)
        busy = nil
        if store.status == .gated {
            Haptics.error()
            note = store.gate == .emailUnverified
                ? "아직 확인되지 않았어요. 메일의 버튼을 누른 뒤 다시 눌러 주세요."
                : "아직 승인되지 않았어요. 승인되면 바로 쓸 수 있어요."
        }
    }

    private func resend() async {
        busy = .send
        error = nil
        note = nil
        defer { busy = nil }
        do {
            try await API.shared.send(.post, "/api/auth/email/verify")
            sentTo = sentTo ?? email
            Haptics.success()
            note = "확인 메일을 다시 보냈어요"
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "메일을 보내지 못했어요"
        }
    }

    private func change() async {
        let address = newEmail.trimmingCharacters(in: .whitespaces)
        guard !address.isEmpty, !password.isEmpty, busy == nil else { return }
        focus = nil
        busy = .send
        error = nil
        defer { busy = nil }
        do {
            // A wrong password answers 401 here: it is the form's error, not a signed-out session.
            try await API.shared.send(.post, "/api/auth/email/change", json: ["email": .string(address), "password": .string(password)])
            sentTo = address.lowercased()
            changing = false
            password = ""
            Haptics.success()
            note = "새 주소로 확인 메일을 보냈어요"
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "메일을 보내지 못했어요"
            Haptics.error()
        }
    }
}

/// A password box with a show/hide eye, matching the login form.
struct ObPasswordField: View {
    @Binding var text: String
    @Binding var show: Bool
    var focused: Bool
    var contentType: UITextContentType = .password

    var body: some View {
        HStack(spacing: 0) {
            Group {
                if show {
                    TextField("", text: $text)
                } else {
                    SecureField("", text: $text)
                }
            }
            .textContentType(contentType)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            Button {
                show.toggle()
            } label: {
                Image(systemName: show ? "eye.slash" : "eye")
                    .foregroundStyle(Ob.text3)
                    .frame(width: 36, height: 36)
            }
            .accessibilityLabel(show ? "비밀번호 숨기기" : "비밀번호 표시")
        }
        .font(ObFont.body)
        .padding(.leading, ObSpace.md)
        .padding(.trailing, ObSpace.xs)
        .frame(minHeight: ObSize.controlLg)
        .overlay(
            RoundedRectangle(cornerRadius: ObRadius.md)
                .strokeBorder(focused ? Ob.text3 : Ob.input, lineWidth: 1)
        )
    }
}
