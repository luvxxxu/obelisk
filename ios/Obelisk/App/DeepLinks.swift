import SwiftUI

/// obelisk:// links, used by the widget, notifications, Siri/Shortcuts and the share extension.
///
///   obelisk://task/<id or number>       open a task
///   obelisk://page/<slug>               today, inbox, upcoming, forecast, project:<id>, …
///   obelisk://new?title=…&notes=…       open the new-task sheet prefilled
///   obelisk://invite/<token>            accept an organization invite (signed out: sign up or log in with it)
///   obelisk://signup?invite=osi_…       sign up with a server invite (signed out)
///   obelisk://settings/<page>           general, org, ai, jev, webhooks, admin
///   obelisk://admin/<tab>?filter=…      서버 관리: overview, users (filter=pending…), orgs (ownerless=1), signup, notice, log
///   https://<server>/t/<id>, /invite/<token>, /signup?invite=…, /projects/<id>  (web links pasted or shared into the app)
@MainActor
enum DeepLinks {
    static func handle(_ url: URL, store: AppStore, router: Router) {
        let parts: [String]
        let host: String
        if url.scheme == "obelisk" {
            host = url.host() ?? ""
            parts = url.pathComponents.filter { $0 != "/" }
        } else {
            let comps = url.pathComponents.filter { $0 != "/" }
            host = comps.first ?? ""
            parts = Array(comps.dropFirst())
        }
        let query = Dictionary(
            (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") },
            uniquingKeysWith: { _, b in b }
        )

        switch host {
        case "task", "t":
            guard let ref = parts.first else { return }
            Task {
                if store.status != .ready { await store.load() }
                let byNumber = Int(ref).flatMap { n in store.tasks.values.first { $0.number == n }?.id }
                if let id = byNumber {
                    router.openTask(id)
                } else if let id = await store.resolveTaskLink(ref) {
                    router.openTask(id)
                } else {
                    store.toasts.error("작업을 찾을 수 없어요")
                }
            }
        case "page":
            if let slug = parts.first, let page = Page(slug: slug) { router.open(page) }
        case "projects":
            if let id = parts.first { router.open(.project(id)) }
        case "new":
            router.present(.init(id: "new-task", detents: [.medium, .large]) {
                NewTaskSheet(prefill: NewTask(title: query["title"] ?? "", notes: query["notes"] ?? ""))
            })
        case "invite":
            guard let token = parts.first else { return }
            // Signed out: the sign-up form takes the link too (signing up through it joins right away);
            // the sheet waits for after a login.
            if store.status == .unauthenticated { store.pendingSignupInvite = InviteLink(url.absoluteString) ?? InviteLink(token: token) }
            router.present(.init(id: "invite", detents: [.medium, .large]) { InviteSheet(token: token) })
        case "signup":
            guard let link = InviteLink(url.absoluteString) else { return }
            if store.status == .unauthenticated {
                store.pendingSignupInvite = link
            } else {
                store.toasts.show("서버 초대 링크는 새 계정을 만들 때 써요. 이미 로그인되어 있어요.")
            }
        case "settings":
            router.openSettings(SettingsPage(rawValue: parts.first ?? ""))
        case "admin":
            // 서버 관리, e.g. the "가입 신청" mail's /admin/users?filter=pending.
            guard store.status == .ready else { return }
            let tab = AdminTab(rawValue: parts.first ?? "") ?? .overview
            router.openAdmin(AdminFocus(
                tab: tab,
                userFilter: query["filter"].flatMap(AdminUserFilter.init(rawValue:)),
                ownerless: query["ownerless"] == "1" || query["ownerless"] == "true"
            ))
        default:
            break
        }
    }
}
