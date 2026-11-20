import SwiftUI

/// 설정 › 일반 › 프로필 › 이메일 (web settings/EmailRow.tsx): the sign-in address, whether it is confirmed,
/// and changing it (a link goes to the new address; the account moves only when that link is opened).
struct EmailSettingsRow: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    /// The server can send mail; nil while asking.
    @State private var mail: Bool?
    @State private var sending = false

    private var verified: Bool { store.user?.emailVerified == true }

    private var help: String {
        if mail == false { return "로그인에 쓰는 주소예요. 이 서버는 메일을 보낼 수 없어서 확인하거나 바꿀 수 없어요." }
        if verified { return "로그인에 쓰는 주소예요. 바꾸면 새 주소로 보낸 링크를 열어야 바뀌어요." }
        return "로그인에 쓰는 주소예요. 확인해 두면 다른 서버에서 옮겨 온 조직의 자리에 링크 없이 들어갈 수 있어요."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: ObSpace.md) {
                Text("이메일")
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                    .layoutPriority(1)
                Spacer(minLength: ObSpace.sm)
                Text(store.user?.email ?? "")
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Chip(text: verified ? "확인됨" : "확인 전", tone: verified ? .ok : .neutral, filled: true)
                    .fixedSize()
            }
            Text(help)
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                .fixedSize(horizontal: false, vertical: true)
            if mail == true {
                HStack(spacing: ObSpace.sm) {
                    if !verified {
                        Button(sending ? "보내는 중…" : "확인 메일 보내기") {
                            Task { await verify() }
                        }
                        .buttonStyle(.ob(.outline, size: .small))
                        .disabled(sending)
                    }
                    Button("바꾸기") {
                        let current = store.user?.email ?? ""
                        router.present(.init(id: "change-email", detents: [.medium, .large]) { ChangeEmailSheet(current: current) })
                    }
                    .buttonStyle(.ob(.outline, size: .small))
                }
                .padding(.top, ObSpace.sm)
                .transition(.opacity)
            }
        }
        .orgRow()
        .animation(ObMotion.standard, value: mail)
        .task {
            struct R: Decodable { var available: Bool }
            let r: R? = try? await API.shared.get("/api/auth/password-reset")
            mail = r?.available ?? false
        }
    }

    private func verify() async {
        sending = true
        defer { sending = false }
        do {
            try await API.shared.send(.post, "/api/auth/email/verify")
            Haptics.success()
            store.toasts.show("\(store.user?.email ?? "")(으)로 확인 메일을 보냈어요")
        } catch {
            store.toasts.error((error as? LocalizedError)?.errorDescription ?? "메일을 보내지 못했어요")
        }
    }
}

/// 이메일 바꾸기 (web ChangeEmailDialog): the new address and the password; a link goes to the new address.
struct ChangeEmailSheet: View {
    var current: String

    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var busy = false
    @State private var error: String?
    @State private var sent: String?
    @FocusState private var focus: Field?

    enum Field: Hashable { case email, password }

    private var canSend: Bool { !busy && !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.xl) {
                    if let sent {
                        OrgSheetHeader(title: "확인 메일을 보냈어요")
                        Text("\(Text(sent).foregroundStyle(Ob.text).fontWeight(.medium))(으)로 확인 메일을 보냈어요. 24시간 안에 메일의 버튼을 누르면 주소가 바뀌어요.")
                            .font(ObFont.body)
                            .foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        OrgSheetHeader(
                            title: "이메일 바꾸기",
                            description: "지금 주소는 \(current)이에요. 새 주소로 보낸 링크를 열면 바뀌고, 지금 주소로도 알림이 가요."
                        )
                        if let error {
                            Text(error)
                                .font(ObFont.sub)
                                .foregroundStyle(Ob.dangerText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .obCallout(.danger)
                                .transition(.opacity)
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("새 이메일").font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
                            // Verbatim: a localized key would turn the address into a blue link.
                            TextField(text: $email, prompt: Text(verbatim: "name@example.com")) { Text("새 이메일") }
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
                            ObPasswordField(text: $password, show: $showPassword, focused: focus == .password)
                                .focused($focus, equals: .password)
                                .submitLabel(.send)
                                .onSubmit { Task { await submit() } }
                        }
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
                .animation(ObMotion.standard, value: error)
                .animation(ObMotion.standard, value: sent)
            }
            .scrollDismissesKeyboard(.interactively)
            .obPage()
            .toolbar {
                if sent != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("확인") { dismiss() }
                            .fontWeight(.semibold)
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("취소") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(busy ? "보내는 중…" : "보내기") { Task { await submit() } }
                            .fontWeight(.semibold)
                            .disabled(!canSend)
                    }
                }
            }
        }
        .onAppear { focus = .email }
    }

    private func submit() async {
        guard canSend else { return }
        let address = email.trimmingCharacters(in: .whitespaces)
        focus = nil
        busy = true
        error = nil
        defer { busy = false }
        do {
            // A wrong password answers 401: the form's error, not a signed-out session.
            try await API.shared.send(.post, "/api/auth/email/change", json: ["email": .string(address), "password": .string(password)])
            Haptics.success()
            sent = address.lowercased()
        } catch {
            Haptics.error()
            self.error = (error as? LocalizedError)?.errorDescription ?? "메일을 보내지 못했어요"
        }
    }
}
