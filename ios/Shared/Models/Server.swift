import Foundation

// A port of the parts of packages/core/src/admin.ts every signed-in client needs (서버 관리):
// who may sign up, why an account isn't let in yet, and what the bootstrap says about the server.

/// Who may create an account here.
/// open: anyone · approval: anyone may apply, an operator lets them in · invite: only with an invite link
/// (organization invite, claim link or server invite) · closed: no new accounts at all.
enum SignupMode: String, Codable, Hashable, Sendable {
    case open, approval, invite, closed

    var labelKo: String {
        switch self {
        case .open: "열림"
        case .approval: "승인제"
        case .invite: "초대만"
        case .closed: "닫힘"
        }
    }
}

/// Why a signed-in account can't use the app yet. Suspended accounts can't sign in at all.
/// Any session request answers 403 `{ code, message }` with one of these.
enum AccountGate: String, Codable, Hashable, Sendable {
    case emailUnverified = "email_unverified"
    case pendingApproval = "pending_approval"
}

/// GET /api/auth/signup-status: can someone sign up here, and what follows.
struct SignupStatus: Codable, Hashable, Sendable {
    var allowed: Bool
    /// No account exists yet: this one becomes the server's operator.
    var first: Bool
    var mode: SignupMode
    /// The invite in the query works (and skips approval and the domain list).
    var invited: Bool
    /// Without an invite, an operator approves the account before it can be used.
    var approval: Bool
    /// The new account confirms its address by mail first.
    var verifyEmail: Bool
    /// Sign-ups without an invite must use one of these domains.
    var domains: [String]

    static let closed = SignupStatus(allowed: false, first: false, mode: .closed, invited: false, approval: false, verifyEmail: false, domains: [])

    init(allowed: Bool, first: Bool, mode: SignupMode, invited: Bool, approval: Bool, verifyEmail: Bool, domains: [String]) {
        self.allowed = allowed
        self.first = first
        self.mode = mode
        self.invited = invited
        self.approval = approval
        self.verifyEmail = verifyEmail
        self.domains = domains
    }

    /// A server from before 서버 관리 answers only `{ allowed }`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        allowed = try c.decode(Bool.self, forKey: .allowed)
        first = try c.decodeIfPresent(Bool.self, forKey: .first) ?? false
        mode = (try? c.decodeIfPresent(SignupMode.self, forKey: .mode)) ?? (allowed ? .open : .closed)
        invited = try c.decodeIfPresent(Bool.self, forKey: .invited) ?? false
        approval = try c.decodeIfPresent(Bool.self, forKey: .approval) ?? false
        verifyEmail = try c.decodeIfPresent(Bool.self, forKey: .verifyEmail) ?? false
        domains = try c.decodeIfPresent([String].self, forKey: .domains) ?? []
    }

    /// What happens after "시작하기", said before it is pressed (web AuthForm `notes`).
    var notes: [String] {
        guard allowed else { return [] }
        var out: [String] = []
        if first { out.append("첫 계정이라 이 서버의 운영자가 돼요.") }
        if !domains.isEmpty { out.append("\(domains.map { "@\($0)" }.joined(separator: ", ")) 주소로만 가입할 수 있어요.") }
        if verifyEmail { out.append("가입하면 메일로 주소를 확인해요.") }
        if approval { out.append("운영자가 가입을 승인하면 쓸 수 있어요.") }
        return out
    }
}

struct Announcement: Codable, Hashable, Sendable {
    var text: String
    /// When it was last changed: a dismissed banner comes back when this moves.
    var at: String
}

/// What every signed-in client needs to know about the server (in the bootstrap).
struct ServerInfo: Codable, Hashable, Sendable {
    var announcement: Announcement?
    /// Organizations can be created by anyone, or only by operators.
    var canCreateOrg: Bool

    /// A server from before 서버 관리: no announcement, anyone may create organizations.
    static let legacy = ServerInfo(announcement: nil, canCreateOrg: true)
}

/// GET /api/auth/me: also answers for an account that isn't let in yet.
struct MeResponse: Codable, Sendable {
    var user: User
    /// Why the account can't use the app yet; nil = fully in.
    var gate: AccountGate?
    /// The server can send mail (confirmation links, password resets).
    var mailAvailable: Bool?
}

/// An invite link someone was given: a server invite (`/signup?invite=osi_…`), an organization invite
/// (`/invite/<token>` or `?invite=<token>`), as a web link, an obelisk:// link or the bare token.
struct InviteLink: Hashable, Sendable {
    var token: String
    /// The server the link points at (`https://host[:port]`), when it was a web link.
    var server: String?

    /// A server invite only opens sign-up; it names no organization.
    var isServerInvite: Bool { token.hasPrefix("osi_") }

    init(token: String, server: String? = nil) {
        self.token = token
        self.server = server
    }

    init?(_ raw: String) {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if let comps = URLComponents(string: s), let scheme = comps.scheme?.lowercased(), ["http", "https", "obelisk"].contains(scheme) {
            let path = comps.path.split(separator: "/").map(String.init)
            // obelisk://invite/<token> puts "invite" in the host.
            let parts = scheme == "obelisk" ? [comps.host ?? ""] + path : path
            var token = comps.queryItems?.first { $0.name == "invite" }?.value
            if token == nil, let i = parts.firstIndex(of: "invite"), i + 1 < parts.count { token = parts[i + 1] }
            guard let token, Self.looksLikeToken(token) else { return nil }
            self.token = token
            if scheme != "obelisk", let host = comps.host, !host.isEmpty {
                server = "\(scheme)://\(host)\(comps.port.map { ":\($0)" } ?? "")"
            }
            return
        }
        guard Self.looksLikeToken(s) else { return nil }
        token = s
    }

    private static func looksLikeToken(_ s: String) -> Bool {
        s.count >= 8 && s.count <= 200 && s.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || "_-".unicodeScalars.contains($0) }
    }
}
