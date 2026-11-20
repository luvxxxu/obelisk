import SwiftUI

/// 설정 › 일반 (web app/(app)/settings/page.tsx): 프로필 (이름 · 이메일 · 시간대), 기본 공간, 화면 (테마),
/// 계정 (로그아웃), and an iOS-only 앱 section (server, version).
struct GeneralSettingsView: View {
    @Environment(AppStore.self) private var store
    @AppStorage("obelisk-theme", store: AppGroup.defaults) private var theme: ThemePref = .system

    @State private var name = ""
    @State private var tz = "Asia/Seoul"
    @State private var synced = false
    @State private var saving = false
    @State private var choosingSpace: String?
    @State private var confirmLogout = false
    @FocusState private var nameFocused: Bool

    private static let themes: [ThemePref] = [.system, .light, .dark]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                profile
                if store.workspaces.count >= 2 { defaultSpace }
                appearance
                account
                app
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.md)
            .padding(.bottom, ObSpace.xxxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .obPage()
        .navigationDestination(for: GeneralTimeZoneRoute.self) { _ in
            GeneralTimeZonePicker(selection: $tz)
        }
        .onAppear(perform: sync)
        .onChange(of: store.user?.id) { _, _ in
            synced = false
            sync()
        }
    }

    // MARK: 프로필

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var dirty: Bool { trimmedName != (store.user?.name ?? "") || tz != (store.user?.timezone ?? "") }

    private var profile: some View {
        OrgSection("프로필", lead: "이름과 시간대를 바꿀 수 있어요.") {
            OrgCard {
                GeneralRow("이름") {
                    TextField("이름", text: $name)
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text)
                        .multilineTextAlignment(.trailing)
                        .textContentType(.name)
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .onChange(of: name) { _, v in if v.count > 80 { name = String(v.prefix(80)) } }
                        .accessibilityLabel("이름")
                }
                if store.user?.emailVerified != nil {
                    EmailSettingsRow()
                } else {
                    // A server from before 서버 관리: the address can't be confirmed or changed there.
                    GeneralRow("이메일", help: "로그인에 쓰는 주소라 여기서는 바꿀 수 없어요.") {
                        Text(store.user?.email ?? "")
                            .font(ObFont.body)
                            .foregroundStyle(Ob.text2)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
                NavigationLink(value: GeneralTimeZoneRoute()) {
                    GeneralRow("시간대", help: "‘오늘’과 기한 지남 판단, AI 도구가 받는 날짜가 이 시간대를 기준으로 해요.") {
                        HStack(spacing: ObSpace.xs) {
                            Text(tz)
                                .font(ObFont.body)
                                .foregroundStyle(Ob.text2)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Ob.text4)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(OrgPressStyle())
                .accessibilityHint("시간대 목록 열기")
                OrgSaveFooter(dirty: dirty, canSave: dirty && !trimmedName.isEmpty, busy: saving) {
                    Task { await save() }
                }
            }
        }
    }

    private func sync() {
        guard !synced, let u = store.user else { return }
        name = u.name
        tz = u.timezone
        synced = true
    }

    private func save() async {
        guard dirty, !trimmedName.isEmpty, !saving else { return }
        nameFocused = false
        saving = true
        defer { saving = false }
        do {
            let r: UserResponse = try await API.shared.send(
                .patch, "/api/auth/me",
                json: ["name": .string(trimmedName), "timezone": .string(tz)]
            )
            store.setUser(r.user)
            name = r.user.name
            tz = r.user.timezone
            await store.refresh()
            Haptics.success()
            store.toasts.show("저장했어요")
        } catch {
            store.report(error)
        }
    }

    // MARK: 기본 공간

    private var defaultSpace: some View {
        let current = choosingSpace ?? store.user?.defaultWorkspaceId ?? store.workspaces.first?.id
        return OrgSection(
            "기본 공간",
            lead: "새로 로그인하거나 열던 공간에 들어갈 수 없을 때 여기서 고른 공간을 열어요. AI 도구도 공간을 따로 말하지 않으면 이 공간에서 일해요."
        ) {
            OrgCard(inset: 56) {
                ForEach(store.workspaces) { w in
                    OrgSpaceOption(
                        space: w,
                        meta: w.kind == .personal ? "나만 보는 공간" : "조직 · 멤버 \(w.memberCount)명",
                        selected: current == w.id
                    ) {
                        guard current != w.id, choosingSpace == nil else { return }
                        Haptics.select()
                        Task { await chooseDefault(w) }
                    }
                }
            }
        }
    }

    private func chooseDefault(_ w: WorkspaceSummary) async {
        choosingSpace = w.id
        defer { choosingSpace = nil }
        do {
            let r: UserResponse = try await API.shared.send(.patch, "/api/auth/me", json: ["defaultWorkspaceId": .string(w.id)])
            store.setUser(r.user)
            store.toasts.show("기본 공간을 \(orgWorkspaceLabel(w))(으)로 바꿨어요")
        } catch {
            store.report(error)
        }
    }

    // MARK: 화면

    private var appearance: some View {
        OrgSection("화면", lead: "테마는 바로 적용되고 이 기기에 저장돼요.") {
            OrgCard {
                VStack(alignment: .leading, spacing: ObSpace.md) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("테마").font(ObFont.body).foregroundStyle(Ob.text)
                        Text("‘시스템’은 기기의 라이트 · 다크 설정을 따라가요.")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Picker("테마", selection: Binding(
                        get: { theme },
                        set: { t in
                            Haptics.select()
                            withAnimation(ObMotion.mid) { theme = t }
                        }
                    )) {
                        ForEach(Self.themes) { t in
                            Text(t.label).tag(t)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                .orgRow()
            }
        }
    }

    // MARK: 계정

    private var account: some View {
        OrgSection("계정", lead: store.user.map { "\($0.email) 계정으로 로그인되어 있어요." }) {
            OrgCard {
                GeneralRow("로그아웃", help: "이 기기에서 로그아웃해요. 작업은 그대로 남아 있어요.") {
                    Button("로그아웃") { confirmLogout = true }
                        .buttonStyle(.ob(.outline, size: .small))
                        .confirmationDialog("로그아웃할까요?", isPresented: $confirmLogout, titleVisibility: .visible) {
                            Button("로그아웃", role: .destructive) { Task { await store.logout() } }
                            Button("취소", role: .cancel) {}
                        } message: {
                            Text("이 기기에서 로그아웃해요. 작업은 그대로 남아 있어요.")
                        }
                }
            }
        }
    }

    // MARK: 앱 (iOS only)

    private var app: some View {
        OrgSection("앱") {
            OrgCard {
                GeneralRow("서버", help: "로그아웃한 뒤 로그인 화면에서 바꿀 수 있어요.") {
                    Text(Session.server)
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text2)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                GeneralRow("버전") {
                    Text(Self.version)
                        .font(ObFont.body.monospacedDigit())
                        .foregroundStyle(Ob.text2)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private static var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info["CFBundleVersion"] as? String
        return build.map { "\(short) (\($0))" } ?? short
    }
}

/// One row: title on the left, value or control on the right, an optional full-width help line below.
private struct GeneralRow<Trailing: View>: View {
    var title: String
    var help: String?
    @ViewBuilder var trailing: () -> Trailing

    init(_ title: String, help: String? = nil, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.title = title
        self.help = help
        self.trailing = trailing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: ObSpace.md) {
                Text(title)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                    .layoutPriority(1)
                Spacer(minLength: ObSpace.sm)
                trailing()
            }
            if let help {
                Text(help)
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
            }
        }
        .orgRow()
    }
}

// MARK: - Time zone picker

struct GeneralTimeZoneRoute: Hashable {}

/// The searchable list of IANA zones (web <select> of Intl.supportedValuesOf('timeZone')), each with its
/// Korean name and UTC offset. Picking one goes back; the profile's 저장 applies it.
struct GeneralTimeZonePicker: View {
    @Binding var selection: String
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        let zones = GeneralZone.all
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = q.isEmpty ? zones : zones.filter { $0.search.contains(q) }
        ScrollViewReader { proxy in
            List {
                if q.isEmpty, let device = GeneralZone.device {
                    row(device, meta: "이 기기의 시간대 · \(device.offset)", id: "device")
                }
                ForEach(shown) { z in
                    row(z, meta: z.meta, id: z.id)
                }
                if shown.isEmpty {
                    Text("‘\(query)’에 맞는 시간대가 없어요")
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text3)
                        .listRowBackground(Ob.bg)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, ObSize.row)
            .obPage()
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "시간대 찾기")
            .navigationTitle("시간대")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { proxy.scrollTo(selection, anchor: .center) }
        }
    }

    private func row(_ z: GeneralZone, meta: String, id: String) -> some View {
        Button {
            Haptics.select()
            selection = z.id
            dismiss()
        } label: {
            HStack(spacing: ObSpace.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(z.id)
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text)
                    Text(meta)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                }
                Spacer(minLength: ObSpace.sm)
                if z.id == selection {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Ob.text)
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .id(id)
        .listRowBackground(Ob.bg)
        .listRowSeparatorTint(Ob.border)
        .accessibilityAddTraits(z.id == selection ? [.isSelected] : [])
    }
}

/// An IANA zone with its Korean generic name ("대한민국 시간") and current offset ("GMT+9").
struct GeneralZone: Identifiable, Hashable {
    let id: String
    let name: String
    let offset: String
    let search: String

    var meta: String { name.isEmpty ? offset : "\(name) · \(offset)" }

    init(_ id: String) {
        self.id = id
        let zone = TimeZone(identifier: id)
        name = zone?.localizedName(for: .generic, locale: Locale(identifier: "ko_KR")) ?? ""
        let seconds = zone?.secondsFromGMT() ?? 0
        let h = abs(seconds) / 3600
        let m = (abs(seconds) % 3600) / 60
        let sign = seconds < 0 ? "-" : "+"
        offset = seconds == 0 ? "GMT" : (m == 0 ? "GMT\(sign)\(h)" : String(format: "GMT%@%d:%02d", sign, h, m))
        search = [id, id.replacingOccurrences(of: "_", with: " "), name, offset].joined(separator: " ").lowercased()
    }

    /// Every zone the system knows, alphabetical (what Intl.supportedValuesOf gives the web), plus UTC.
    static let all: [GeneralZone] = {
        var ids = Set(TimeZone.knownTimeZoneIdentifiers)
        ids.insert("UTC")
        return ids.sorted().map(GeneralZone.init)
    }()

    static var device: GeneralZone? {
        let id = TimeZone.current.identifier
        return all.first { $0.id == id } ?? GeneralZone(id)
    }
}
