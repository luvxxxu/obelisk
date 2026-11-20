import SwiftUI

/// An organization invite link (web app/invite/[token]): who invites you where and with which role,
/// then join. Expired, revoked and used-up links say so; if you're already in, it just opens it.
struct InviteSheet: View {
    var token: String

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var invite: InvitePreview?
    @State private var error: String?
    @State private var busy = false

    private struct Response: Decodable { var invite: InvitePreview }
    private struct Accepted: Decodable { var workspaceId: String }

    private var path: String {
        "/api/invites/\(token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? token)"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Group {
                    if let invite {
                        content(invite)
                    } else if let error {
                        failure(error)
                    } else {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 240)
                    }
                }
                .padding(.horizontal, ObSpace.xl)
                .padding(.top, ObSpace.xl)
                .padding(.bottom, ObSpace.xxl)
                .animation(ObMotion.mid, value: invite)
            }
            .obPage()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
                }
            }
        }
        .task(id: token) { await load() }
    }

    // MARK: states

    private func failure(_ message: String) -> some View {
        VStack(spacing: ObSpace.lg) {
            LogoMark(size: 28)
            VStack(spacing: ObSpace.sm) {
                Text("초대 링크를 열 수 없어요")
                    .font(ObFont.title3)
                    .foregroundStyle(Ob.text)
                Text(message)
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text3)
                    .multilineTextAlignment(.center)
            }
            Button("Obelisk로 가기") { dismiss() }
                .buttonStyle(.ob(.outline, size: .large, fullWidth: true))
                .padding(.top, ObSpace.sm)
        }
        .frame(maxWidth: .infinity)
        .transition(.opacity)
    }

    private func content(_ inv: InvitePreview) -> some View {
        VStack(spacing: ObSpace.xl) {
            VStack(spacing: ObSpace.md) {
                OrgSpaceMark(kind: .org, name: inv.workspace.name, size: 52)
                VStack(spacing: ObSpace.xs) {
                    Text(inv.invitedBy.map { "\($0)님의 초대" } ?? "조직 초대")
                        .font(ObFont.footnote.weight(.medium))
                        .foregroundStyle(Ob.text3)
                    Text(inv.workspace.name)
                        .font(ObFont.title2)
                        .foregroundStyle(Ob.text)
                        .multilineTextAlignment(.center)
                        .accessibilityAddTraits(.isHeader)
                    Text("멤버 \(inv.workspace.memberCount)명 · \(inv.role.labelKo)로 참여해요")
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text2)
                }
            }

            if let error {
                VStack(alignment: .leading, spacing: 2) {
                    Label("참여하지 못했어요", systemImage: "exclamationmark.circle")
                        .font(ObFont.sub.weight(.semibold))
                        .foregroundStyle(Ob.dangerText)
                    Text(error)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.dangerText)
                        .padding(.leading, 26)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .obCallout(.danger)
                .transition(.opacity)
            }

            action(inv)

            OrgNotes(lines: [
                "공유받은 프로젝트만 볼 수 있어요. 내 개인 공간은 그대로 나만 봐요.",
                "연결한 AI도 이 조직에서 내 권한만큼만 일해요.",
            ])
            .padding(.top, ObSpace.sm)
        }
        .frame(maxWidth: .infinity)
        .transition(.opacity)
    }

    @ViewBuilder
    private func action(_ inv: InvitePreview) -> some View {
        if inv.alreadyMember == true {
            Button("이미 멤버예요 · 열기") { open(inv.workspace.id) }
                .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
        } else if !inv.valid {
            VStack(alignment: .leading, spacing: 2) {
                Label(reason(inv.reason), systemImage: "lock")
                    .font(ObFont.sub.weight(.semibold))
                    .foregroundStyle(Ob.warnText)
                Text("조직 관리자에게 새 링크를 요청하세요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.warnText)
                    .padding(.leading, 26)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .obCallout(.warn)
        } else {
            Button {
                Task { await join() }
            } label: {
                if busy {
                    HStack(spacing: ObSpace.sm) {
                        ProgressView().tint(Ob.onPrimary)
                        Text("참여하는 중…")
                    }
                } else {
                    Text("\(inv.workspace.name)에 참여하기")
                }
            }
            .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
            .disabled(busy)
        }
    }

    /// web REASON.
    private func reason(_ r: String?) -> String {
        switch r {
        case "expired": "기한이 지난 초대 링크예요."
        case "revoked": "관리자가 취소한 초대 링크예요."
        case "used_up": "사용 횟수가 모두 끝난 초대 링크예요."
        default: "사용할 수 없는 초대 링크예요."
        }
    }

    // MARK: actions

    private func load() async {
        do {
            let r: Response = try await API.shared.get(path)
            invite = r.invite
        } catch is CancellationError {
            return
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "초대 링크를 열 수 없어요"
        }
    }

    private func join() async {
        busy = true
        withAnimation(ObMotion.standard) { error = nil }
        do {
            let r: Accepted = try await API.shared.send(.post, "\(path)/accept")
            Haptics.success()
            open(r.workspaceId)
        } catch {
            if let e = error as? APIError, e.isUnauthorized {
                store.report(e)
                return
            }
            withAnimation(ObMotion.standard) {
                self.error = (error as? LocalizedError)?.errorDescription ?? "참여하지 못했어요"
            }
            busy = false
        }
    }

    /// Opening another workspace replaces the shell, so the sheet goes first.
    private func open(_ workspaceId: String) {
        router.dismissSheet()
        router.path = NavigationPath()
        router.open(.home)
        Task { @MainActor in await store.switchWorkspace(workspaceId) }
    }
}
