import SwiftUI

/// 멤버 초대 (web InviteModal): pick a role, an expiry and how many people may use it, make a link,
/// then share or copy it. The link is shown only once.
struct InviteMembersSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var role: WorkspaceRole = .member
    @State private var expires: Int? = 7
    @State private var uses: Int? = nil
    @State private var url: String?
    @State private var busy = false

    private static let expiry: [(Int?, String)] = [(1, "1일"), (7, "7일"), (30, "30일"), (nil, "만료 없음")]
    private static let usesOptions: [(Int?, String)] = [(1, "1회"), (5, "5회"), (25, "25회"), (nil, "제한 없음")]

    private struct Response: Decodable {
        var invite: Invite
        var url: String
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.lg) {
                    Text(url == nil
                        ? "메일 없이 링크로 초대해요. 들어온 사람은 공유받은 프로젝트만 볼 수 있어요."
                        : "이 링크는 지금 한 번만 보여드려요. 메신저나 메일로 전달하세요.")
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let url {
                        linkBox(url)
                    } else {
                        form
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.sm)
                .padding(.bottom, ObSpace.lg)
                .animation(ObMotion.mid, value: url)
            }
            .safeAreaInset(edge: .bottom) { footer }
            .obPage()
            .navigationTitle(url == nil ? "\(store.workspace?.name ?? "조직")에 초대" : "초대 링크가 준비됐어요")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if url == nil {
                        Button("취소") { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if url != nil {
                        Button("완료") { dismiss() }
                            .fontWeight(.semibold)
                    }
                }
            }
        }
    }

    // MARK: form

    private var form: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            choice("역할") {
                Picker("역할", selection: $role) {
                    Text("멤버").tag(WorkspaceRole.member)
                    Text("관리자").tag(WorkspaceRole.admin)
                }
                .pickerStyle(.segmented)
                Text(role == .admin ? "관리자는 모든 프로젝트와 멤버를 관리할 수 있어요." : "멤버는 공유받은 프로젝트만 볼 수 있어요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .animation(ObMotion.fast, value: role)
            }
            choice("만료") {
                Picker("만료", selection: $expires) {
                    ForEach(Self.expiry, id: \.1) { o in Text(o.1).tag(o.0) }
                }
                .pickerStyle(.segmented)
            }
            choice("사용 횟수") {
                Picker("사용 횟수", selection: $uses) {
                    ForEach(Self.usesOptions, id: \.1) { o in Text(o.1).tag(o.0) }
                }
                .pickerStyle(.segmented)
            }
        }
    }

    private func choice<C: View>(_ label: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            Text(label)
                .font(ObFont.footnote.weight(.medium))
                .foregroundStyle(Ob.text2)
            content()
        }
    }

    // MARK: link

    private func linkBox(_ url: String) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            Text(url)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(Ob.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(ObSpace.md)
                .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.input, lineWidth: 1))
                .accessibilityLabel("초대 링크")
                .accessibilityValue(url)
            HStack(spacing: ObSpace.sm) {
                if let link = URL(string: url) {
                    ShareLink(item: link, subject: Text("\(store.workspace?.name ?? "조직") 초대")) {
                        Label("공유", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.ob(.primary, fullWidth: true))
                }
                Button {
                    orgCopy(url, toast: "초대 링크를 복사했어요", store: store)
                } label: {
                    Label("복사", systemImage: "doc.on.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.ob(.outline, fullWidth: true))
            }
        }
        .transition(.opacity)
    }

    // MARK: footer

    private var footer: some View {
        Group {
            if url != nil {
                Button("링크 하나 더") {
                    withAnimation(ObMotion.mid) { url = nil }
                }
                .buttonStyle(.ob(.outline, size: .large, fullWidth: true))
            } else {
                Button {
                    Task { await create() }
                } label: {
                    ZStack {
                        Text("링크 만들기").opacity(busy ? 0 : 1)
                        if busy { ProgressView().tint(Ob.onPrimary) }
                    }
                }
                .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
                .disabled(busy || store.workspace == nil)
            }
        }
        .padding(.horizontal, ObSpace.page)
        .padding(.vertical, ObSpace.sm)
        .background(Ob.bg)
    }

    private func create() async {
        guard let ws = store.workspace, !busy else { return }
        busy = true
        defer { busy = false }
        let body: JSONValue = [
            "role": .string(role.rawValue),
            "expiresInDays": expires.map { .number(Double($0)) } ?? .null,
            "maxUses": uses.map { .number(Double($0)) } ?? .null,
        ]
        do {
            let r: Response = try await API.shared.send(.post, "/api/workspaces/\(ws.id)/invites", json: body)
            Haptics.success()
            withAnimation(ObMotion.mid) { url = r.url }
            NotificationCenter.default.post(name: .orgInvitesChanged, object: nil)
        } catch {
            store.report(error)
        }
    }
}
