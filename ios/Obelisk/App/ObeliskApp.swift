import SwiftUI

@main
struct ObeliskApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var toasts: Toasts
    @State private var store: AppStore
    @State private var router = Router()

    init() {
        let toasts = Toasts()
        _toasts = State(initialValue: toasts)
        _store = State(initialValue: AppStore(toasts: toasts))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(router)
                .environment(toasts)
                .onAppear { AppContext.shared.attach(store: store, router: router) }
        }
    }
}

/// Lets non-view code (notification taps, App Intents, background refresh) reach the live store and router.
@MainActor
final class AppContext {
    static let shared = AppContext()
    private(set) weak var store: AppStore?
    private(set) weak var router: Router?
    /// A link that arrived before the UI was ready (cold launch from a notification or widget).
    var pendingURL: URL?

    func attach(store: AppStore, router: Router) {
        self.store = store
        self.router = router
        if let url = pendingURL {
            pendingURL = nil
            DeepLinks.handle(url, store: store, router: router)
        }
    }

    func open(_ url: URL) {
        if let store, let router { DeepLinks.handle(url, store: store, router: router) } else { pendingURL = url }
    }
}

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var phase
    @AppStorage("obelisk-theme", store: AppGroup.defaults) private var theme: ThemePref = .system

    var body: some View {
        ZStack {
            Ob.bg.ignoresSafeArea()
            switch store.status {
            case .ready:
                MainShell()
                    .transition(.opacity)
            case .unauthenticated:
                LoginView()
                    .transition(.opacity)
            case .gated:
                // Signed in, not let in yet: confirm the address or wait for approval.
                GateView(gate: store.gate ?? .pendingApproval)
                    .id(store.gate)
                    .transition(.opacity)
            case .error:
                SplashView(error: store.error) { Task { await store.load() } }
            case .idle, .loading:
                SplashView()
            }
        }
        .animation(ObMotion.mid, value: store.status)
        // Signed out (or the session ended): the next account opens on 홈. A link opened after this
        // (an invite while signed out) still sets its sheet for after the login.
        .onChange(of: store.status) { old, new in
            if new == .unauthenticated, old == .ready || old == .gated { router.reset() }
        }
        .preferredColorScheme(theme.colorScheme)
        .tint(Ob.primary)
        .toggleStyle(.obSwitch)
        .onOpenURL { DeepLinks.handle($0, store: store, router: router) }
        .task {
            #if DEBUG
            await DevLaunch.prepare(store: store, router: router)
            #endif
            // Last workspace from the cache first (instant), then the server.
            let restored = store.restoreFromCache()
            if store.status == .idle || store.status == .unauthenticated || restored { await store.load(silent: restored) }
            #if DEBUG
            DevLaunch.route(router: router, store: store)
            #endif
        }
        // One minute clock for the whole app (time labels, overdue-at-the-minute).
        .task(id: phase) {
            guard phase == .active else { return }
            store.tickClock()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(nextMinuteDelay()))
                if Task.isCancelled { break }
                store.tickClock()
            }
        }
        // Background sync while the app is in front (AI tools and the web edit the same data).
        .task(id: phase) {
            guard phase == .active else { return }
            if store.status == .ready { await store.load(silent: true) }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                if Task.isCancelled { break }
                if store.status == .ready { await store.load(silent: true) }
            }
        }
    }
}

struct SplashView: View {
    var error: String?
    var retry: (() -> Void)?

    init(error: String? = nil, retry: (() -> Void)? = nil) {
        self.error = error
        self.retry = retry
    }

    var body: some View {
        VStack(spacing: ObSpace.lg) {
            LogoMark(size: error == nil ? 36 : 28)
            if let error {
                Text(error)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text2)
                    .multilineTextAlignment(.center)
                if let retry {
                    Button("다시 시도", action: retry).buttonStyle(.obOutline)
                }
            }
        }
        .padding(ObSpace.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .obPage()
    }
}

#if DEBUG
/// Simulator conveniences, DEBUG builds only. Set with `xcrun simctl launch` (SIMCTL_CHILD_ env vars)
/// or the scheme:
///   OBELISK_SERVER=http://localhost:4100           server to talk to
///   OBELISK_DEV_EMAIL / OBELISK_DEV_PASSWORD       sign in automatically when signed out
///   -route today | project:<id>                    open a sidebar page
///   -push task:<id|#number> | settings:<home|general|org|ai|jev|webhooks>   push a screen on top
///   -theme light | dark                            force a theme
///   -workspace <id>                                open that workspace (e.g. an organization)
enum DevLaunch {
    @MainActor
    static func prepare(store: AppStore, router: Router) async {
        let env = ProcessInfo.processInfo.environment
        if let t = UserDefaults.standard.string(forKey: "theme"), let pref = ThemePref(rawValue: t) {
            AppGroup.defaults.set(pref.rawValue, forKey: "obelisk-theme")
        }
        if let ws = UserDefaults.standard.string(forKey: "workspace"), !ws.isEmpty {
            Session.workspaceId = ws
        }
        guard !Session.isSignedIn, let email = env["OBELISK_DEV_EMAIL"], let password = env["OBELISK_DEV_PASSWORD"] else { return }
        if let user = try? await API.shared.login(email: email, password: password) {
            store.setUser(user)
        }
    }

    @MainActor
    static func route(router: Router, store: AppStore) {
        if let r = UserDefaults.standard.string(forKey: "route"), let page = Page(slug: r) {
            router.open(page)
        }
        if let p = UserDefaults.standard.string(forKey: "push") {
            let parts = p.split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { return }
            switch parts[0] {
            case "task":
                let ref = parts[1].hasPrefix("#") ? String(parts[1].dropFirst()) : parts[1]
                if let n = Int(ref), let t = store.tasks.values.first(where: { $0.number == n }) {
                    router.openTask(t.id)
                } else {
                    router.openTask(ref)
                }
            case "settings":
                router.openSettings(SettingsPage(rawValue: parts[1]))
            default: break
            }
        }
    }
}
#endif
