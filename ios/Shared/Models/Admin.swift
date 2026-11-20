import Foundation

// A port of packages/core/src/admin.ts for the 서버 관리 screens (operators only). Metadata only:
// names, addresses, dates, counts and sizes, never what anyone wrote.

enum OrgCreation: String, Codable, Hashable, Sendable, CaseIterable {
    case everyone, admins

    var labelKo: String { self == .everyone ? "누구나" : "운영자만" }
}

/// GET/PATCH /api/admin/settings
struct ServerSettings: Codable, Hashable, Sendable {
    var signupMode: SignupMode
    /// The mode SIGNUP_MODE gives, used until an operator picks one here.
    var envSignupMode: SignupMode
    /// True while no mode was picked here (the environment's mode applies).
    var signupModeFromEnv: Bool
    var requireEmailVerification: Bool
    var allowedEmailDomains: [String]
    var orgCreation: OrgCreation
    var updateCheck: Bool
    var announcement: Announcement?
    /// The server can send mail (SMTP_URL, or a development server printing to the log).
    var mailAvailable: Bool
    /// Mail goes to the log instead of a mailbox (development without SMTP_URL).
    var mailToLog: Bool
}

extension SignupMode: CaseIterable {
    static let allCases: [SignupMode] = [.open, .approval, .invite, .closed]

    /// What the mode means, under the picker (web admin/signup MODE_HELP).
    var helpKo: String {
        switch self {
        case .open: "주소를 아는 사람은 누구나 계정을 만들 수 있어요."
        case .approval: "누구나 가입을 신청하고, 운영자가 승인하면 쓸 수 있어요. 초대 링크로 오면 승인 없이 바로 써요."
        case .invite: "조직 초대 링크나 서버 초대 링크가 있어야 가입할 수 있어요."
        case .closed: "새 계정을 받지 않아요. 초대 링크로도 가입할 수 없고, 이미 있는 계정만 조직 초대를 받을 수 있어요."
        }
    }
}

enum AdminAccountState: String, Codable, Hashable, Sendable {
    case active, suspended, pending, unverified

    var labelKo: String {
        switch self {
        case .active: "사용 중"
        case .suspended: "정지됨"
        case .pending: "승인 대기"
        case .unverified: "메일 확인 전"
        }
    }
}

/// One account as an operator sees it: who, when, how many. Never what they wrote.
struct AdminUser: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var email: String
    var name: String
    var avatarUrl: String?
    var admin: Bool
    var state: AdminAccountState
    var emailVerified: Bool
    var createdAt: String
    var lastSeenAt: String?
    var suspendedAt: String?
    var pendingSince: String?
    /// Organizations they belong to, and how many of those they own.
    var orgs: Int
    var ownedOrgs: Int
    var apiTokens: Int
    var aiConnections: Int
}

enum AdminUserFilter: String, Codable, Hashable, Sendable, CaseIterable, Identifiable {
    case all, pending, unverified, suspended, admins
    var id: String { rawValue }

    var labelKo: String {
        switch self {
        case .all: "전체"
        case .pending: "승인 대기"
        case .unverified: "메일 확인 전"
        case .suspended: "정지됨"
        case .admins: "운영자"
        }
    }

    func fits(_ u: AdminUser) -> Bool {
        switch self {
        case .all: true
        case .admins: u.admin
        case .pending: u.state == .pending
        case .unverified: u.state == .unverified
        case .suspended: u.state == .suspended
        }
    }
}

struct AdminUserList: Codable, Hashable, Sendable {
    var users: [AdminUser]
    /// Matches for the current search and filter.
    var total: Int
    var counts: [String: Int]

    func count(_ f: AdminUserFilter) -> Int { counts[f.rawValue] ?? 0 }
}

struct AdminOrgOwner: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var email: String
    var suspended: Bool
}

struct AdminOrg: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var avatarUrl: String?
    var createdAt: String
    var members: Int
    var owners: [AdminOrgOwner]
    /// No owner who can still sign in: an operator can name one of the members.
    var ownerless: Bool
    var projects: Int
    var tasks: Int
}

struct AdminOrgList: Codable, Hashable, Sendable {
    var orgs: [AdminOrg]
    var total: Int
    var ownerless: Int
}

struct AdminOrgMember: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var email: String
    var role: WorkspaceRole
    var suspended: Bool
}

struct ServerInvite: Codable, Hashable, Identifiable, Sendable {
    var id: String
    /// Last characters of the link, to tell links apart.
    var hint: String
    var note: String
    var maxUses: Int?
    var uses: Int
    var expiresAt: String?
    var revokedAt: String?
    var createdAt: String
    var createdBy: String?
    var valid: Bool

    /// Why a dead link is dead.
    var endedLabel: String {
        if revokedAt != nil { return "취소됨" }
        if let maxUses, uses >= maxUses { return "다 씀" }
        return "만료됨"
    }
}

struct AdminLogEntry: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var actorId: String?
    var actorName: String
    var action: String
    var targetId: String?
    var targetLabel: String
    var data: [String: JSONValue]?
    var createdAt: String

    /// Operator log line in Korean, e.g. "정지했어요 · 스팸" (core describeAdminAction).
    var describedKo: String {
        let d = data ?? [:]
        func str(_ k: String) -> String {
            switch d[k] {
            case let .string(s)?: s
            case let .number(n)?: n.rounded() == n ? String(Int(n)) : String(n)
            case let .bool(b)?: b ? "true" : "false"
            default: ""
            }
        }
        switch action {
        case "admin.claimed": return "서버 로그의 링크로 운영자가 됐어요"
        case "admin.first": return "서버의 첫 계정이라 운영자가 됐어요"
        case "admin.granted": return "운영자로 지정했어요"
        case "admin.revoked": return "운영자에서 해제했어요"
        case "user.approved": return "가입을 승인했어요"
        case "user.rejected": return "가입 신청을 거절했어요"
        case "user.suspended": return str("note").isEmpty ? "정지했어요" : "정지했어요 · \(str("note"))"
        case "user.unsuspended": return "정지를 풀었어요"
        case "user.deleted": return "계정을 삭제했어요"
        case "user.reset_link": return d["mailed"]?.bool == true ? "비밀번호 재설정 링크를 메일로 보냈어요" : "비밀번호 재설정 링크를 만들었어요"
        case "user.verification_skipped": return "메일 확인 없이 쓰도록 허용했어요"
        case "org.owner_set": return "소유자로 지정했어요 · \(str("userName"))"
        case "settings.updated":
            let changes = d["changes"]?.object ?? [:]
            let parts = changes.keys.sorted(by: Self.settingOrder).map { key -> String in
                let c = changes[key] ?? .null
                return "\(Self.settingLabel[key] ?? key) \(Self.settingValue(key, c["from"] ?? .null)) → \(Self.settingValue(key, c["to"] ?? .null))"
            }
            return parts.isEmpty ? "설정을 바꿨어요" : "설정 · \(parts.joined(separator: " · "))"
        case "announcement.set": return "공지를 올렸어요"
        case "announcement.cleared": return "공지를 내렸어요"
        case "invite.created": return "서버 초대 링크를 만들었어요"
        case "invite.revoked": return "서버 초대 링크를 취소했어요"
        case "mail.sent":
            let sent = d["sent"]?.int ?? 0
            let failed = d["failed"]?.int ?? 0
            return "전체 메일을 보냈어요 · \(str("subject")) · \(sent)명\(failed > 0 ? ", 실패 \(failed)" : "")"
        default: return action
        }
    }

    private static let settingKeys = ["signupMode", "requireEmailVerification", "allowedEmailDomains", "orgCreation", "updateCheck"]
    private static func settingOrder(_ a: String, _ b: String) -> Bool {
        (settingKeys.firstIndex(of: a) ?? 99) < (settingKeys.firstIndex(of: b) ?? 99)
    }

    private static let settingLabel: [String: String] = [
        "signupMode": "가입",
        "requireEmailVerification": "메일 확인",
        "allowedEmailDomains": "도메인",
        "orgCreation": "조직 만들기",
        "updateCheck": "업데이트 확인",
    ]

    private static func settingValue(_ key: String, _ v: JSONValue) -> String {
        switch key {
        case "signupMode":
            guard let s = v.string else { return "환경 변수" }
            return SignupMode(rawValue: s)?.labelKo ?? s
        case "orgCreation":
            return v.string == "admins" ? "운영자만" : "누구나"
        case "allowedEmailDomains":
            let list = (v.array ?? []).compactMap(\.string)
            return list.isEmpty ? "제한 없음" : list.joined(separator: ", ")
        default:
            if let b = v.bool { return b ? "켬" : "끔" }
            if let s = v.string { return s }
            if let n = v.int { return String(n) }
            return ""
        }
    }
}

struct AdminLogPage: Codable, Hashable, Sendable {
    var entries: [AdminLogEntry]
    var total: Int?
}

enum CheckState: String, Codable, Hashable, Sendable {
    case ok, warn, error, info
}

struct ServerCheck: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var label: String
    var state: CheckState
    /// What is set, never a secret's value.
    var value: String
    var hint: String?
}

struct UpdateCommit: Codable, Hashable, Sendable {
    var commit: String
    var date: String?
    var message: String
}

struct UpdateStatus: Codable, Hashable, Sendable {
    enum State: String, Codable, Hashable, Sendable { case off, current, behind, unknown, error }

    var enabled: Bool
    var state: State
    var repo: String
    var branch: String
    var checkedAt: String?
    var behindBy: Int?
    var latest: UpdateCommit?
    /// Newest first, at most a handful.
    var commits: [UpdateCommit]
    var url: String?
    var error: String?
}

struct BackupStatus: Codable, Hashable, Sendable {
    enum State: String, Codable, Hashable, Sendable { case ok, stale, missing, unavailable }
    struct Latest: Codable, Hashable, Sendable {
        var name: String
        var at: String
        var bytes: Int
    }

    var state: State
    var dir: String
    var count: Int
    var totalBytes: Int
    var latest: Latest?
    var keepDays: Int?
}

struct ServerUsage: Codable, Hashable, Sendable {
    var users: Int
    var activeWeek: Int
    var activeMonth: Int
    var pending: Int
    var suspended: Int
    var admins: Int
    var orgs: Int
    var projects: Int
    var tasks: Int
    var openTasks: Int
    var dbBytes: Int
    var photos: Int
    var photoBytes: Int
    var webhooks: Int
    var failingWebhooks: Int
    var disabledWebhooks: Int
    var apiTokens: Int
    var aiConnections: Int
}

struct ServerStatus: Codable, Hashable, Sendable {
    struct Version: Codable, Hashable, Sendable {
        var commit: String?
        var builtAt: String?
    }

    struct Mail: Codable, Hashable, Sendable {
        var available: Bool
        var toLog: Bool
        var from: String
        var host: String?
    }

    var version: Version
    var update: UpdateStatus
    var checks: [ServerCheck]
    var usage: ServerUsage
    var backup: BackupStatus
    var mail: Mail
}

struct AdminMailJob: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var subject: String
    var audience: String
    var total: Int
    var sent: Int
    var failed: Int
    var done: Bool
    var startedAt: String
    var finishedAt: String?
    var startedBy: String
}

/// GET /api/admin/users/:id/deletion (the same preview as deleting your own account).
struct AccountDeletionPreview: Codable, Hashable, Sendable {
    struct Blocker: Codable, Hashable, Sendable {
        var id: String
        var name: String
        var memberCount: Int
    }

    struct SoloOrg: Codable, Hashable, Sendable {
        var id: String
        var name: String
    }

    struct Personal: Codable, Hashable, Sendable {
        var projects: Int
        var tasks: Int
    }

    /// Organizations where they are the last owner and other people remain.
    var blockers: [Blocker]
    /// Organizations where they are the only member: deleted with the account.
    var soloOrgs: [SoloOrg]
    var personal: Personal
    /// Organizations they stay a member of until the account is gone.
    var sharedOrgs: Int
}

/// "1.4 MB" (web admin bytes()).
func formatBytes(_ n: Int) -> String {
    if n < 1024 { return "\(n) B" }
    let units = ["KB", "MB", "GB", "TB"]
    var v = Double(n) / 1024
    var i = 0
    while v >= 1024, i < units.count - 1 {
        v /= 1024
        i += 1
    }
    return v >= 100 ? "\(Int(v.rounded())) \(units[i])" : String(format: "%.1f %@", v, units[i])
}

/// "1,234" in Korean grouping.
func formatCount(_ n: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.locale = Locale(identifier: "ko_KR")
    return f.string(from: NSNumber(value: n)) ?? String(n)
}
