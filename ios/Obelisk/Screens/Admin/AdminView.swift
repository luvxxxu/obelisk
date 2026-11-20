import SwiftUI

/// 서버 관리 (web app/(app)/admin): the server's operators run it from here. Title and lead, then six
/// tabs pinned under the navigation bar: 개요 · 사용자 · 조직 · 가입 · 공지 · 기록. Metadata only: the
/// server never shows anyone's tasks or projects here. Anyone who isn't an operator sees a note.
struct AdminView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var tab: AdminTab = .overview
    /// Where 사용자 and 조직 open (a link or 개요's "보기").
    @State private var userFilter: AdminUserFilter = .all
    @State private var ownerless = false
    /// Bumped by pull-to-refresh: the open tab loads again.
    @State private var reload = 0

    var body: some View {
        Group {
            if store.user?.isAdmin == true {
                content
            } else {
                ScrollView {
                    EmptyState(
                        "서버 운영자만 볼 수 있어요",
                        message: "가입, 사용자, 서버 설정은 이 서버의 운영자가 관리해요. 운영자가 되려면 지금 운영자에게 요청하세요."
                    )
                    .padding(.top, ObSpace.xxxl)
                }
                .obPage()
            }
        }
        .onAppear {
            router.adminOnTop = true
            takeFocus()
        }
        .onDisappear { router.adminOnTop = false }
        .onChange(of: router.adminFocus) { _, _ in takeFocus() }
    }

    private func takeFocus() {
        guard let f = router.adminFocus else { return }
        router.adminFocus = nil
        go(f)
    }

    /// Jump to a tab (개요's "보기", a link).
    private func go(_ f: AdminFocus) {
        if let filter = f.userFilter { userFilter = filter }
        if f.tab == .orgs { ownerless = f.ownerless }
        if tab != f.tab {
            Haptics.select()
            tab = f.tab
        }
    }

    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                header
                Section {
                    Group {
                        switch tab {
                        case .overview: AdminOverviewTab(reload: reload, open: go)
                        case .users: AdminUsersTab(reload: reload, filter: $userFilter)
                        case .orgs: AdminOrgsTab(reload: reload, ownerless: $ownerless)
                        case .signup: AdminSignupTab(reload: reload)
                        case .notice: AdminNoticeTab(reload: reload)
                        case .log: AdminLogTab(reload: reload)
                        }
                    }
                    .id(tab)
                    .transition(.opacity)
                    .padding(.horizontal, ObSpace.page)
                    .padding(.top, ObSpace.lg)
                    .padding(.bottom, ObSpace.xxxl)
                } header: {
                    tabs
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable {
            reload += 1
            await store.refresh()
        }
        .obPage()
        .animation(ObMotion.standard, value: tab)
    }

    private var header: some View {
        Text(tab.lead)
            .font(ObFont.sub)
            .foregroundStyle(Ob.text3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.md)
            .padding(.bottom, ObSpace.lg)
            .animation(nil, value: tab)
    }

    private var tabs: some View {
        Picker("서버 관리", selection: Binding(
            get: { tab },
            set: { t in
                guard t != tab else { return }
                Haptics.select()
                tab = t
            }
        )) {
            ForEach(AdminTab.allCases) { t in
                Text(t.label).tag(t)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, ObSpace.page)
        .padding(.vertical, ObSpace.sm)
        .background(Ob.bg)
    }
}

// MARK: - Shared pieces

/// Dates the way the web's admin pages print them (ko-KR, the device's time zone).
enum AdminDates {
    private static let dateTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ko_KR")
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ko_KR")
        f.dateStyle = .medium
        f.timeStyle = .none
        return f
    }()

    /// "2026. 11. 20. 오후 6:04"
    static func dateTime(_ iso: String?) -> String {
        guard let iso, let d = JS.parseDate(iso) else { return "" }
        return dateTimeFormatter.string(from: d)
    }

    /// "2026. 11. 20."
    static func date(_ iso: String?) -> String {
        guard let iso, let d = JS.parseDate(iso) else { return "" }
        return dateFormatter.string(from: d)
    }
}

extension CheckState {
    var symbol: String {
        switch self {
        case .ok: "checkmark.circle"
        case .warn: "exclamationmark.triangle"
        case .error: "exclamationmark.circle"
        case .info: "info.circle"
        }
    }

    var color: Color {
        switch self {
        case .ok: Ob.ok
        case .warn: Ob.warn
        case .error: Ob.danger
        case .info: Ob.text3
        }
    }
}

/// The state glyph in front of a check or an attention line.
struct AdminStateIcon: View {
    var state: CheckState
    var body: some View {
        Image(systemName: state.symbol)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(state.color)
            .accessibilityHidden(true)
    }
}

/// One row inside an OrgCard: a label (with an optional state glyph) and a value or control on the
/// right, an optional full-width note below (web SettingsRow).
struct AdminRow<Trailing: View>: View {
    var label: String
    var state: CheckState?
    var note: String?
    /// The control goes under the label instead of beside it (long values, inputs).
    var stacked = false
    @ViewBuilder var trailing: () -> Trailing

    init(_ label: String, state: CheckState? = nil, note: String? = nil, stacked: Bool = false, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.label = label
        self.state = state
        self.note = note
        self.stacked = stacked
        self.trailing = trailing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if stacked {
                title
                if let note { noteText(note) }
                trailing()
                    .padding(.top, ObSpace.sm)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.md) {
                    title.layoutPriority(1)
                    Spacer(minLength: ObSpace.sm)
                    trailing()
                }
                if let note { noteText(note) }
            }
        }
        .orgRow()
    }

    private var title: some View {
        HStack(spacing: ObSpace.sm) {
            if let state { AdminStateIcon(state: state) }
            Text(label)
                .font(ObFont.body)
                .foregroundStyle(Ob.text)
        }
    }

    private func noteText(_ s: String) -> some View {
        Text(s)
            .font(ObFont.footnote)
            .foregroundStyle(Ob.text3)
            .fixedSize(horizontal: false, vertical: true)
    }
}

extension AdminRow where Trailing == EmptyView {
    init(_ label: String, state: CheckState? = nil, note: String? = nil) {
        self.init(label, state: state, note: note, trailing: { EmptyView() })
    }
}

/// A row that is a switch: label and note on the left, the switch on the right (ObSwitchStyle draws
/// the label itself, so it can't sit in an AdminRow's trailing slot).
struct AdminToggleRow: View {
    var label: String
    var note: String?
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                if let note {
                    Text(note)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .orgRow()
    }
}

/// The value on the right of an AdminRow.
struct AdminValue: View {
    var text: String
    var mono = false
    var body: some View {
        Text(text)
            .font(mono ? ObFont.mono : ObFont.sub)
            .foregroundStyle(Ob.text2)
            .multilineTextAlignment(.trailing)
            .textSelection(.enabled)
    }
}

/// "불러오지 못했어요" with the server's message.
struct AdminErrorCallout: View {
    var message: String
    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            Text("불러오지 못했어요").font(ObFont.bodyStrong).foregroundStyle(Ob.dangerText)
            Text(message).font(ObFont.sub).foregroundStyle(Ob.dangerText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .obCallout(.danger)
    }
}

/// A centered spinner where a list is loading.
struct AdminLoading: View {
    var height: CGFloat = 120
    var body: some View {
        ProgressView()
            .frame(maxWidth: .infinity, minHeight: height)
    }
}

/// "더 보기 (12명 더)" under a paged list.
struct AdminMoreButton: View {
    var label: String
    var busy: Bool
    var action: () -> Void
    var body: some View {
        Button(busy ? "불러오는 중…" : label, action: action)
            .buttonStyle(.ob(.ghost, size: .small))
            .disabled(busy)
            .frame(maxWidth: .infinity)
    }
}

/// A text segmented control in a row of its own (web ui.segmented), wrapping to the width it gets.
struct AdminSegments<Value: Hashable>: View {
    var options: [(value: Value, label: String)]
    @Binding var selection: Value
    var label: String

    var body: some View {
        Picker(label, selection: $selection) {
            ForEach(options, id: \.value) { o in
                Text(o.label).tag(o.value)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityLabel(label)
    }
}

/// Percent-encode one path segment (ids are UUIDs, but stay safe).
func adminPath(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? s
}

extension AppStore {
    /// An admin action failed: say so with the server's message (a 401 still signs out).
    func adminFailed(_ error: Error, _ lead: String) {
        if let e = error as? APIError, e.isUnauthorized {
            report(error)
            return
        }
        if error is CancellationError { return }
        let msg = (error as? LocalizedError)?.errorDescription ?? "요청을 처리하지 못했어요"
        toasts.error("\(lead): \(msg)")
    }
}
