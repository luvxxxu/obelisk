import SwiftUI

/// 서버 관리 › 개요 (web admin/page.tsx): what needs a look, how big the server is, its version,
/// backups and configuration.
struct AdminOverviewTab: View {
    var reload: Int
    var open: (AdminFocus) -> Void

    @Environment(AppStore.self) private var store
    @State private var status: ServerStatus?
    @State private var settings: ServerSettings?
    @State private var ownerless = 0
    @State private var error: String?
    @State private var checking = false
    @State private var sendingMail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            if let error { AdminErrorCallout(message: error) }
            if let st = status {
                attention(st)
                usage(st)
                version(st)
                backups(st)
                checks(st)
            } else if error == nil {
                AdminLoading(height: 240)
            }
        }
        .task(id: reload) { await load() }
    }

    private func load() async {
        async let s: ServerStatus = API.shared.get("/api/admin/status")
        async let c: ServerSettings? = try? API.shared.get("/api/admin/settings")
        async let o: AdminOrgList? = try? API.shared.get("/api/admin/orgs", query: ["ownerless": "true", "limit": "1"])
        do {
            status = try await s
            error = nil
        } catch {
            if status == nil { self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했어요" }
        }
        settings = await c ?? settings
        ownerless = await o?.ownerless ?? ownerless
    }

    // MARK: 확인할 것

    private struct Item: Identifiable {
        var id: String
        var state: CheckState
        var text: String
        var detail: String?
        var focus: AdminFocus?
    }

    private func items(_ st: ServerStatus) -> [Item] {
        var out: [Item] = []
        if st.usage.pending > 0 {
            out.append(Item(id: "pending", state: .warn, text: "가입 승인을 기다리는 사람이 \(st.usage.pending)\u{2060}명 있어요",
                            focus: AdminFocus(tab: .users, userFilter: .pending)))
        }
        if ownerless > 0 {
            out.append(Item(id: "ownerless", state: .warn, text: "쓸 수 있는 소유자가 없는 조직이 \(ownerless)\u{2060}곳 있어요",
                            detail: "소유자가 모두 정지됐어요. 멤버 중 한 명을 소유자로 정할 수 있어요.",
                            focus: AdminFocus(tab: .orgs, ownerless: true)))
        }
        if st.update.state == .behind {
            out.append(Item(id: "update", state: .info, text: "새 버전이 있어요 · 커밋 \(st.update.behindBy.map(String.init) ?? "")개",
                            detail: "아래 버전 항목에서 바뀐 내용을 볼 수 있어요."))
        }
        for c in st.checks where c.state == .warn || c.state == .error {
            out.append(Item(id: c.id, state: c.state, text: "\(c.label) · \(c.value)", detail: c.hint))
        }
        if st.usage.failingWebhooks > 0 {
            out.append(Item(id: "hooks", state: .warn, text: "전달에 실패하고 있는 웹훅이 \(st.usage.failingWebhooks)\u{2060}개 있어요",
                            detail: "각 공간의 설정 › 웹훅에서 확인할 수 있어요."))
        }
        return out
    }

    private func attention(_ st: ServerStatus) -> some View {
        let list = items(st)
        return OrgSection("확인할 것") {
            OrgCard(inset: 44) {
                if list.isEmpty {
                    HStack(spacing: ObSpace.sm) {
                        AdminStateIcon(state: .ok)
                        Text("지금은 따로 확인할 것이 없어요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text2)
                    }
                    .orgRow()
                }
                ForEach(list) { i in
                    HStack(alignment: .firstTextBaseline, spacing: ObSpace.md) {
                        AdminStateIcon(state: i.state)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(i.text)
                                .font(ObFont.body)
                                .foregroundStyle(Ob.text)
                                .fixedSize(horizontal: false, vertical: true)
                            if let d = i.detail {
                                Text(d)
                                    .font(ObFont.footnote)
                                    .foregroundStyle(Ob.text3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if let f = i.focus {
                            Button("보기") { open(f) }
                                .buttonStyle(.ob(.outline, size: .small))
                        }
                    }
                    .orgRow()
                }
            }
        }
    }

    // MARK: 사용량

    private func usage(_ st: ServerStatus) -> some View {
        let u = st.usage
        let cells: [(String, String, String?)] = [
            ("사용자", formatCount(u.users), "최근 7일 \(formatCount(u.activeWeek))명 · 30일 \(formatCount(u.activeMonth))명"),
            ("조직", formatCount(u.orgs), "운영자 \(formatCount(u.admins))명"),
            ("작업", formatCount(u.tasks), "진행 중 \(formatCount(u.openTasks)) · 프로젝트 \(formatCount(u.projects))"),
            ("데이터베이스", formatBytes(u.dbBytes), "사진 \(formatCount(u.photos))장 · \(formatBytes(u.photoBytes))"),
            ("승인 대기", formatCount(u.pending), nil),
            ("정지된 계정", formatCount(u.suspended), nil),
            ("AI 연결", formatCount(u.aiConnections), "API 토큰 \(formatCount(u.apiTokens))개"),
            ("웹훅", formatCount(u.webhooks),
             u.failingWebhooks > 0 || u.disabledWebhooks > 0
                ? "실패 중 \(formatCount(u.failingWebhooks)) · 꺼짐 \(formatCount(u.disabledWebhooks))"
                : "모두 정상"),
        ]
        return OrgSection("사용량", lead: "숫자와 크기만 모아 봐요. 무엇을 적었는지는 세지 않아요.") {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: ObSpace.sm), GridItem(.flexible(), spacing: ObSpace.sm)], spacing: ObSpace.sm) {
                ForEach(cells, id: \.0) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.0)
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                        Text(c.1)
                            .font(.title3.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        Text(c.2 ?? " ")
                            .font(ObFont.caption)
                            .foregroundStyle(Ob.text3)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
                    .padding(ObSpace.md)
                    .overlay(RoundedRectangle(cornerRadius: ObRadius.lg).strokeBorder(Ob.border, lineWidth: 1))
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    // MARK: 버전

    private func summary(_ st: ServerStatus) -> String {
        let u = st.update
        switch u.state {
        case .off: return "확인하지 않아요"
        case .current: return "최신 버전이에요"
        case .behind: return "새 커밋 \(u.behindBy.map(String.init) ?? "")개가 있어요"
        case .error: return u.error ?? "확인하지 못했어요"
        case .unknown: return st.version.commit != nil ? "이 빌드의 커밋을 저장소에서 찾지 못했어요" : "이 빌드의 커밋을 알 수 없어요"
        }
    }

    private func version(_ st: ServerStatus) -> some View {
        let u = st.update
        let enabled = settings?.updateCheck ?? u.enabled
        let built = [
            u.state == .current ? u.latest?.message : nil,
            st.version.builtAt.map { "\(AdminDates.dateTime($0))에 빌드" },
        ].compactMap { $0 }.joined(separator: " · ")
        return OrgSection("버전", lead: "\(u.repo)의 \(u.branch) 브랜치와 비교해요. 업데이트는 배포 도구에서 다시 배포하면 돼요.") {
            if enabled {
                Button {
                    Task { await checkNow() }
                } label: {
                    if checking { ProgressView().controlSize(.small) } else { Text("지금 확인") }
                }
                .buttonStyle(.ob(.outline, size: .small))
                .disabled(checking)
            }
        } content: {
            OrgCard {
                AdminRow("이 서버", note: built.isEmpty ? nil : built) {
                    AdminValue(text: st.version.commit.map { String($0.prefix(7)) } ?? "알 수 없음", mono: true)
                }
                AdminRow("저장소", note: u.checkedAt.map { "\(relativeTime($0)) 확인" }) {
                    if let s = u.url, u.state != .off, let url = URL(string: s) {
                        Link(summary(st), destination: url)
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text)
                            .underline()
                            .multilineTextAlignment(.trailing)
                    } else {
                        AdminValue(text: summary(st))
                    }
                }
                if u.state == .unknown, let latest = u.latest {
                    AdminRow("저장소 최신 커밋", note: latest.message) {
                        AdminValue(text: String(latest.commit.prefix(7)), mono: true)
                    }
                }
                if !u.commits.isEmpty {
                    VStack(alignment: .leading, spacing: ObSpace.sm) {
                        ForEach(u.commits, id: \.commit) { c in
                            HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                                Text(String(c.commit.prefix(7)))
                                    .font(ObFont.mono)
                                    .foregroundStyle(Ob.text3)
                                Text(c.message)
                                    .font(ObFont.footnote)
                                    .foregroundStyle(Ob.text2)
                                    .lineLimit(2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                if let d = c.date {
                                    Text(AdminDates.date(d))
                                        .font(ObFont.caption)
                                        .foregroundStyle(Ob.text3)
                                        .fixedSize()
                                }
                            }
                        }
                    }
                    .orgRow()
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("새 커밋")
                }
                AdminToggleRow(
                    label: "업데이트 확인",
                    note: "몇 시간마다 GitHub에 이 서버의 커밋을 물어봐요. 끄면 서버가 GitHub에 요청하지 않아요.",
                    isOn: Binding(get: { enabled }, set: { on in Task { await setUpdateCheck(on) } })
                )
            }
        }
    }

    private func checkNow() async {
        checking = true
        defer { checking = false }
        do {
            let u: UpdateStatus = try await API.shared.send(.post, "/api/admin/status/update-check")
            status?.update = u
        } catch {
            store.adminFailed(error, "확인하지 못했어요")
        }
    }

    private func setUpdateCheck(_ on: Bool) async {
        do {
            settings = try await API.shared.send(.patch, "/api/admin/settings", json: ["updateCheck": .bool(on)])
            if let s: ServerStatus = try? await API.shared.get("/api/admin/status") { status = s }
        } catch {
            store.adminFailed(error, "바꾸지 못했어요")
        }
    }

    // MARK: 백업

    private func backups(_ st: ServerStatus) -> some View {
        let b = st.backup
        let state: CheckState = switch b.state {
        case .ok: .ok
        case .unavailable: .info
        case .stale: .warn
        case .missing: .error
        }
        let note: String? = switch b.state {
        case .unavailable: "백업 폴더(\(b.dir))를 볼 수 없어요. 최신 docker-compose.yml은 backend에 백업 볼륨을 읽기 전용으로 연결해요."
        case .missing: "아직 백업이 없어요."
        case .stale: "하루가 넘도록 새 백업이 없어요. backup 서비스 로그를 확인하세요."
        case .ok: nil
        }
        return OrgSection("백업", lead: "docker-compose의 backup 서비스가 매일 만드는 데이터베이스 덤프예요. 복구 방법은 README의 ‘백업과 복구’에 있어요.") {
            OrgCard {
                AdminRow("마지막 백업", state: state, note: note) {
                    AdminValue(text: b.latest.map { "\(AdminDates.dateTime($0.at)) · \(formatBytes($0.bytes))" } ?? "없음")
                }
                if b.state != .unavailable {
                    AdminRow("보관 중", note: b.keepDays.map { "\($0)일이 지난 백업은 지워요 (BACKUP_KEEP_DAYS)." }) {
                        AdminValue(text: "\(b.count)개 · \(formatBytes(b.totalBytes))")
                    }
                }
            }
        }
    }

    // MARK: 설정 점검

    private func checks(_ st: ServerStatus) -> some View {
        OrgSection("설정 점검", lead: "환경 변수로 정하는 값이에요. 바꾸려면 배포 도구에서 고친 뒤 다시 배포하세요. 비밀값은 설정 여부만 보여요.") {
            OrgCard {
                ForEach(st.checks.filter { $0.id != "backup" }) { c in
                    AdminRow(c.label, state: c.state, note: c.hint, stacked: c.value.count > 24 || (c.id == "smtp" && st.mail.available)) {
                        HStack(spacing: ObSpace.sm) {
                            AdminValue(text: c.value)
                            if c.id == "smtp", st.mail.available {
                                Spacer(minLength: 0)
                                Button(sendingMail ? "보내는 중…" : "테스트 메일") {
                                    Task { await testMail() }
                                }
                                .buttonStyle(.ob(.outline, size: .small))
                                .disabled(sendingMail)
                            }
                        }
                    }
                }
            }
        }
    }

    private func testMail() async {
        struct R: Decodable { var to: String; var toLog: Bool }
        sendingMail = true
        defer { sendingMail = false }
        do {
            let r: R = try await API.shared.send(.post, "/api/admin/test-mail")
            Haptics.success()
            store.toasts.show(r.toLog ? "메일 대신 백엔드 로그에 찍었어요" : "\(r.to)(으)로 테스트 메일을 보냈어요")
        } catch {
            store.adminFailed(error, "보내지 못했어요")
        }
    }
}
