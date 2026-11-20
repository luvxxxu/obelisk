import SwiftUI

/// ChatGPT-style shell: the sidebar sits underneath and the page slides right to reveal it (edge swipe or
/// the menu button). The top bar is the system navigation bar, so its buttons are Liquid Glass; the
/// workspace switcher is the title, like ChatGPT's model picker. Pages keep Obelisk's pure base.
struct MainShell: View {
    @Environment(Router.self) private var router
    @Environment(AppStore.self) private var store
    @Environment(\.colorScheme) private var scheme
    /// Live drag offset while the sidebar is being swiped open or closed.
    @State private var drag: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let width = min(ObSize.sidebarWidth, geo.size.width * 0.84)
            let base: CGFloat = router.sidebarOpen ? width : 0
            let x = min(max(base + drag, 0), width)
            let progress = width > 0 ? x / width : 0

            ZStack(alignment: .leading) {
                SidebarView()
                    .frame(width: width)
                    .offset(x: (x - width) * 0.3)
                    .accessibilityHidden(!router.sidebarOpen)
                    // Swipe left on the sidebar itself to close it (vertical scrolling still works).
                    .simultaneousGesture(closeDrag(width: width), including: router.sidebarOpen ? .all : .subviews)

                content
                    .frame(width: geo.size.width)
                    .overlay {
                        // Dim + tap/drag-to-close while the sidebar is showing.
                        if progress > 0 {
                            Rectangle()
                                .fill(scheme == .dark ? Color.white.opacity(0.06 * progress) : Color.black.opacity(0.12 * progress))
                                .ignoresSafeArea()
                                .contentShape(Rectangle())
                                .onTapGesture { close() }
                                .gesture(closeDrag(width: width))
                                .accessibilityLabel("메뉴 닫기")
                                .accessibilityAddTraits(.isButton)
                        }
                    }
                    .overlay(alignment: .leading) {
                        if progress > 0 { Hairline(vertical: true).ignoresSafeArea() }
                    }
                    .offset(x: x)
                    .accessibilityHidden(router.sidebarOpen)
            }
            // Swipe from the left edge to open, at a page's root (deeper, the edge swipe goes back).
            .gesture(EdgePanGesture(
                isEnabled: router.path.isEmpty && !router.sidebarOpen && router.sheet == nil,
                onChanged: { t in
                    if drag == 0, t > 0 { UIApplication.endEditing() }
                    drag = min(t, width)
                },
                onEnded: { t, v in settle(open: t + v * 0.15 > width * 0.4) }
            ))
        }
    }

    private var content: some View {
        @Bindable var router = router
        return NavigationStack(path: $router.path) {
            PageView(page: router.page)
                .id(router.page)
                // The operators' announcement (서버 관리 → 공지): one quiet line under the top bar.
                .safeAreaInset(edge: .top, spacing: 0) { NoticeBanner() }
                .navigationDestination(for: Destination.self) { DestinationView(destination: $0) }
                .toolbar { ShellToolbar() }
                .navigationBarTitleDisplayMode(.inline)
        }
        .overlay(alignment: .bottom) { ToastOverlay(raised: router.path.isEmpty && router.page.showsComposer) }
        .modifier(PendingChangePresenter(active: router.sheet == nil))
        // Jev auto-pilot (web AppShell JevAutoPilot): applies confident priorities when the user opted in.
        .jevAutoPilot()
        .sheet(item: $router.sheet) { s in
            s.content()
                .presentationDetents(s.detents)
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(ObRadius.xl + 8)
                .modifier(PendingChangePresenter(active: true))
                .overlay(alignment: .bottom) { ToastOverlay(raised: false) }
                .environment(store)
                .environment(router)
                .environment(store.toasts)
        }
        .fullScreenCover(item: $router.fullScreen) { s in
            s.content()
                .environment(store)
                .environment(router)
                .environment(store.toasts)
        }
    }

    /// Drag to close, measured in global coordinates: the views it sits on move while it runs, and
    /// local coordinates would feed the movement back into the measurement (flicker).
    private func closeDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .onChanged { v in
                guard router.sidebarOpen else { return }
                // Only a sideways swipe closes; a vertical one is the sidebar scrolling.
                guard drag != 0 || abs(v.translation.width) > abs(v.translation.height) else { return }
                drag = max(-width, min(0, v.translation.width))
            }
            .onEnded { v in
                guard router.sidebarOpen, drag != 0 else { return }
                settle(open: !(v.predictedEndTranslation.width < -width * 0.3))
            }
    }

    /// Finish a swipe: animate from where the finger left it to fully open or closed.
    private func settle(open: Bool) {
        let wasOpen = router.sidebarOpen
        withAnimation(ObMotion.mid) {
            router.sidebarOpen = open
            drag = 0
        }
        if open, !wasOpen { Haptics.select() }
    }

    private func close() {
        withAnimation(ObMotion.mid) { router.sidebarOpen = false }
    }
}

/// Top bar: menu (glass) · workspace switcher (title) · search + new task (glass).
struct ShellToolbar: ToolbarContent {
    @Environment(Router.self) private var router

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button {
                UIApplication.endEditing()
                router.toggleSidebar()
                Haptics.select()
            } label: {
                Image(systemName: "line.3.horizontal")
            }
            .accessibilityLabel("메뉴 열기")
        }
        ToolbarItem(placement: .principal) {
            WorkspaceSwitcher()
        }
        .sharedBackgroundVisibility(.hidden)
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button {
                router.present(.init(id: "search", detents: [.large]) { SearchSheet() })
            } label: {
                Image(systemName: "magnifyingglass")
            }
            .accessibilityLabel("검색")
            Button {
                router.present(.init(id: "new-task", detents: [.medium, .large]) { NewTaskSheet(prefill: router.newTaskPrefill) })
            } label: {
                Image(systemName: "square.and.pencil")
            }
            .accessibilityLabel("새 작업")
        }
    }
}

extension Router {
    /// What a new task should default to on the current page (a project page files it there).
    var newTaskPrefill: NewTask {
        var t = NewTask(title: "")
        if case let .project(id) = page { t.projectId = id }
        return t
    }
}

/// The page for a sidebar destination, with the composer docked at the bottom where it belongs.
struct PageView: View {
    var page: Page
    @Environment(AppStore.self) private var store

    var body: some View {
        screen
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .obPage()
            // Dragging a list down puts the keyboard away (composer, inline edits).
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if page.showsComposer, canCompose {
                    Composer(page: page)
                }
            }
    }

    private var canCompose: Bool {
        if case let .project(id) = page { return store.canWriteProject(id) }
        return true
    }

    @ViewBuilder
    private var screen: some View {
        switch page {
        case .home: HomeScreen()
        case .overview: OverviewScreen()
        case .inbox: InboxScreen()
        case .today: TodayScreen()
        case .upcoming: UpcomingScreen()
        case .mine: MineScreen()
        case .all: AllScreen()
        case .forecast: ForecastScreen()
        case .logbook: LogbookScreen()
        case let .project(id): ProjectScreen(projectId: id)
        }
    }
}

/// Pushed screens.
struct DestinationView: View {
    var destination: Destination

    var body: some View {
        switch destination {
        case let .task(id):
            TaskDetailScreen(taskId: id)
        case .settingsHome:
            SettingsHomeView()
        case let .settings(page):
            SettingsScreen(page: page)
        }
    }
}

/// Floating glass capsule above the composer; tap the action (실행 취소) or swipe it away.
struct ToastOverlay: View {
    var raised: Bool
    @Environment(Toasts.self) private var toasts

    var body: some View {
        ZStack {
            if let t = toasts.current {
                HStack(spacing: ObSpace.md) {
                    if t.isError {
                        Image(systemName: "exclamationmark.circle")
                            .foregroundStyle(Ob.danger)
                    }
                    Text(t.message)
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text)
                        .lineLimit(2)
                    if let a = t.action {
                        Button(a.label) {
                            a.run()
                            toasts.dismiss()
                        }
                        .font(ObFont.sub.weight(.semibold))
                        .foregroundStyle(Ob.text)
                    }
                }
                .padding(.horizontal, ObSpace.lg)
                .frame(minHeight: 44)
                .obGlass(in: Capsule())
                .padding(.horizontal, ObSpace.lg)
                .padding(.bottom, raised ? 84 : ObSpace.lg)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .gesture(DragGesture(minimumDistance: 10).onEnded { v in
                    if v.translation.height > 10 { toasts.dismiss() }
                })
                .id(t.id)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .animation(ObMotion.mid, value: toasts.current?.id)
    }
}

/// Presents the impact sheet for a pending date change from whichever level is on top
/// (the page, or a sheet that started the change).
struct PendingChangePresenter: ViewModifier {
    var active: Bool
    @Environment(AppStore.self) private var store

    func body(content: Content) -> some View {
        content.sheet(item: Binding(
            get: { active ? store.pendingChange : nil },
            set: { if $0 == nil, store.pendingChange != nil { Task { await store.resolvePending(.cancel) } } }
        )) { change in
            PendingChangeSheet(change: change)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .environment(store)
        }
    }
}
