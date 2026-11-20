import Observation
import SwiftUI

/// A sidebar destination (the web's top-level routes). Choosing one replaces the screen, like picking a
/// conversation in ChatGPT's sidebar; everything deeper is pushed on top.
enum Page: Hashable, Sendable {
    case home, overview, inbox, today, upcoming, mine, all, forecast, logbook
    case project(String)

    var label: String {
        switch self {
        case .home: "홈"
        case .overview: "모아보기"
        case .inbox: "인박스"
        case .today: "오늘"
        case .upcoming: "예정"
        case .mine: "내 작업"
        case .all: "전체 작업"
        case .forecast: "파급 예측"
        case .logbook: "완료 기록"
        case .project: "프로젝트"
        }
    }

    /// SF Symbol for the sidebar row (the web's Icon set mapped to SF Symbols).
    var symbol: String {
        switch self {
        case .home: "house"
        case .overview: "square.grid.2x2"
        case .inbox: "tray"
        case .today: "sun.max"
        case .upcoming: "calendar"
        case .mine: "person"
        case .all: "list.bullet"
        case .forecast: "chart.line.uptrend.xyaxis"
        case .logbook: "checkmark.circle"
        case .project: "folder"
        }
    }

    /// Whether the floating composer (quick add) shows on this page.
    var showsComposer: Bool {
        switch self {
        case .forecast, .logbook, .overview: false
        default: true
        }
    }

    /// Launch-argument / deep-link name: "today", "project:<id>".
    init?(slug: String) {
        switch slug {
        case "home", "": self = .home
        case "overview": self = .overview
        case "inbox": self = .inbox
        case "today": self = .today
        case "upcoming": self = .upcoming
        case "mine": self = .mine
        case "all": self = .all
        case "forecast": self = .forecast
        case "logbook": self = .logbook
        default:
            if slug.hasPrefix("project:") { self = .project(String(slug.dropFirst(8))) } else { return nil }
        }
    }
}

enum SettingsPage: String, Hashable, CaseIterable, Sendable {
    /// `admin` is 서버 관리 (operators only), listed apart from the rest.
    case general, notifications, org, ai, jev, webhooks, admin

    var label: String {
        switch self {
        case .general: "일반"
        case .notifications: "알림"
        case .org: "조직"
        case .ai: "AI 연결"
        case .jev: "Jev"
        case .webhooks: "웹훅"
        case .admin: "서버 관리"
        }
    }

    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .notifications: "bell"
        case .org: "building.2"
        case .ai: "powerplug"
        case .jev: "scalemass"
        case .webhooks: "arrow.left.arrow.right"
        case .admin: "shield"
        }
    }
}

/// Where 서버 관리 should open (a tab, and the users filter or the ownerless list): set by a link
/// (`obelisk://admin/users?filter=pending`) or the 개요 tab, taken by AdminView.
struct AdminFocus: Hashable, Sendable {
    var tab: AdminTab
    var userFilter: AdminUserFilter?
    var ownerless = false
}

enum AdminTab: String, CaseIterable, Identifiable, Hashable, Sendable {
    case overview, users, orgs, signup, notice, log
    var id: String { rawValue }

    var label: String {
        switch self {
        case .overview: "개요"
        case .users: "사용자"
        case .orgs: "조직"
        case .signup: "가입"
        case .notice: "공지"
        case .log: "기록"
        }
    }

    /// The muted line under the title (web AdminPage `lead`).
    var lead: String {
        switch self {
        case .overview: "이 서버의 상태와 설정을 봐요. 다른 사람의 작업 내용은 운영자도 볼 수 없어요."
        case .users: "이 서버의 계정이에요. 이름, 주소, 날짜와 개수만 보이고 작업 내용은 보이지 않아요."
        case .orgs: "이 서버의 조직이에요. 이름과 규모만 보이고 프로젝트와 작업 내용은 운영자도 볼 수 없어요."
        case .signup: "가입 방식은 바로 적용돼요. 환경 변수 SIGNUP_MODE는 처음 값으로만 쓰여요."
        case .notice: "점검이나 변경 사항을 이 서버의 모든 사용자에게 알려요."
        case .log: "운영자가 한 일이 남아요. 운영자끼리만 볼 수 있어요."
        }
    }
}

/// Pushed screens. Screens may also push their own Hashable values and register
/// `.navigationDestination(for:)` for them on their own views.
enum Destination: Hashable, Sendable {
    case task(String)
    /// 설정 home (account + a row per page).
    case settingsHome
    case settings(SettingsPage)
}

/// A sheet any screen can present without touching a shared enum:
///
///     router.present(.init(id: "postpone", detents: [.medium, .large]) { PostponeSheet(taskId: id) })
struct SheetRoute: Identifiable {
    let id: String
    var detents: Set<PresentationDetent> = [.large]
    var content: () -> AnyView

    init<V: View>(id: String, detents: Set<PresentationDetent> = [.large], @ViewBuilder content: @escaping () -> V) {
        self.id = id
        self.detents = detents
        self.content = { AnyView(content()) }
    }
}

@Observable
@MainActor
final class Router {
    var page: Page = .home
    var path = NavigationPath()
    var sidebarOpen = false
    var sheet: SheetRoute?
    /// A second sheet on top of the first (e.g. a date picker over the new-task sheet).
    var fullScreen: SheetRoute?
    /// 서버 관리 opens here next (AdminView takes it and clears it).
    var adminFocus: AdminFocus?

    /// Pick a sidebar page: clears anything pushed, closes the sidebar.
    func open(_ page: Page) {
        if self.page != page { path = NavigationPath() }
        self.page = page
        withAnimation(ObMotion.mid) { sidebarOpen = false }
    }

    func push(_ d: Destination) {
        path.append(d)
    }

    func push<V: Hashable>(_ value: V) {
        path.append(value)
    }

    func openTask(_ id: String) {
        sheet = nil
        path.append(Destination.task(id))
    }

    /// 설정 home, or one page directly.
    func openSettings(_ page: SettingsPage? = nil) {
        withAnimation(ObMotion.mid) { sidebarOpen = false }
        path.append(page.map(Destination.settings) ?? Destination.settingsHome)
    }

    func present(_ s: SheetRoute) {
        sheet = s
    }

    func dismissSheet() {
        sheet = nil
    }

    func toggleSidebar() {
        withAnimation(ObMotion.mid) { sidebarOpen.toggle() }
    }

    /// Signed out: the next account starts on 홈, not on what the last one had open.
    func reset() {
        page = .home
        path = NavigationPath()
        sidebarOpen = false
        sheet = nil
        fullScreen = nil
        adminFocus = nil
    }

    /// 서버 관리 on a given tab (pushes it unless it is already the top screen; AdminView follows `adminFocus`).
    func openAdmin(_ focus: AdminFocus) {
        adminFocus = focus
        withAnimation(ObMotion.mid) { sidebarOpen = false }
        if !adminOnTop { path.append(Destination.settings(.admin)) }
        adminOnTop = true
    }

    /// Set by AdminView while it is the visible screen, so a link doesn't push a second copy.
    var adminOnTop = false
}
