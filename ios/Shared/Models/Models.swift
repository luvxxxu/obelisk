import Foundation

// A port of packages/core/src/types.ts. Foundation only: no SwiftUI here, so Shared/Models and
// Shared/Core compile with plain `swiftc` on macOS for the core tests (ios/CoreTests).
//
// Dates stay strings, exactly like the web: ISODate "YYYY-MM-DD", ISOTime "HH:MM", timestamps ISO 8601.
// All arithmetic lives in Shared/Core/Dates.swift.

typealias ISODate = String
typealias ISOTime = String

enum TaskStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case todo, doing, done, canceled

    var labelKo: String {
        switch self {
        case .todo: "할 일"
        case .doing: "진행 중"
        case .done: "완료"
        case .canceled: "취소"
        }
    }

    var isActive: Bool { self == .todo || self == .doing }
}

/// 0 = none, 1 = low, 2 = medium, 3 = high
typealias Priority = Int

enum PriorityInfo {
    static let labelKo: [Int: String] = [0: "없음", 1: "낮음", 2: "보통", 3: "높음"]
    static let name: [Int: String] = [0: "none", 1: "low", 2: "medium", 3: "high"]
}

enum ProjectColor: String, Codable, CaseIterable, Hashable, Sendable {
    case slate, red, orange, amber, green, teal, blue, indigo, violet, pink
}

enum WorkspaceKind: String, Codable, Hashable, Sendable { case personal, org }

enum WorkspaceRole: String, Codable, CaseIterable, Hashable, Sendable {
    case owner, admin, member

    var labelKo: String {
        switch self {
        case .owner: "소유자"
        case .admin: "관리자"
        case .member: "멤버"
        }
    }
}

/// view < edit < manage. Owners and admins manage every project in their workspace.
enum AccessLevel: String, Codable, CaseIterable, Hashable, Comparable, Sendable {
    case view, edit, manage

    var rank: Int {
        switch self {
        case .view: 1
        case .edit: 2
        case .manage: 3
        }
    }

    static func < (a: AccessLevel, b: AccessLevel) -> Bool { a.rank < b.rank }

    var labelKo: String {
        switch self {
        case .view: "보기"
        case .edit: "쓰기"
        case .manage: "관리"
        }
    }
}

/// What every member of a workspace gets on a project.
enum MemberAccess: String, Codable, CaseIterable, Hashable, Sendable {
    case none, view, edit

    var labelKo: String {
        switch self {
        case .none: "권한 없음"
        case .view: "보기"
        case .edit: "쓰기"
        }
    }
}

struct JevStatus: Codable, Hashable, Sendable {
    /// A key is stored and this server can open it.
    var connected: Bool
    /// A key is stored but can't be opened any more: enter it again.
    var keyUnreadable: Bool
    /// Last characters of the key, to tell keys apart.
    var hint: String?
    /// Apply high-confidence judgments without asking.
    var autoApply: Bool
    /// The service's base URL; nil = TypeSafe.
    var baseUrl: String?
    /// The model asked; nil = the server's default.
    var model: String?
}

struct User: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var email: String
    var name: String
    var timezone: String
    var defaultWorkspaceId: String?
    var jev: JevStatus
    /// Their own arrangement of the home dashboard; nil = the default layout.
    var homeLayout: HomeLayout?
    /// Runs this server (서버 관리). nil = a server from before 서버 관리.
    var admin: Bool?
    /// The address was confirmed by a link mailed to it. nil = a server from before 서버 관리.
    var emailVerified: Bool?
    var createdAt: String
    /// Work days, hours, breaks, focus share. nil = a server from before time planning.
    var workHours: WorkHours? = nil

    var isAdmin: Bool { admin == true }
    /// Work hours with the defaults filled in.
    var hours: WorkHours { workHours ?? .standard }
}

/// Home dashboard arrangement, saved per user. iOS uses the `mobile` part (a single column: order + hidden).
struct HomeLayout: Codable, Hashable, Sendable {
    var v: Int = 1
    var desktop: Desktop
    var mobile: Mobile

    struct Desktop: Codable, Hashable, Sendable {
        var items: [HomeLayoutItem]
        var hidden: [String]
    }

    struct Mobile: Codable, Hashable, Sendable {
        var order: [String]
        var hidden: [String]
    }
}

struct HomeLayoutItem: Codable, Hashable, Sendable {
    var id: String
    var x: Int
    var y: Int
    var w: Int
    var h: Int
    var fixed: Bool?
}

/// Who can reach a project, for the share sheet.
struct ProjectAccessInfo: Codable, Hashable, Sendable {
    struct MemberGrant: Codable, Hashable, Sendable {
        var userId: String
        var level: AccessLevel
    }

    struct TeamGrant: Codable, Hashable, Sendable {
        var teamId: String
        var level: AccessLevel
    }

    struct Effective: Codable, Hashable, Sendable {
        var userId: String
        var level: AccessLevel?
        /// 'role' | 'member' | 'team' | 'everyone' | nil
        var source: String?
    }

    var projectId: String
    var memberAccess: MemberAccess
    var members: [MemberGrant]
    var teams: [TeamGrant]
    var effective: [Effective]
}

struct Invite: Codable, Hashable, Identifiable, Sendable {
    var id: String
    /// 'admin' | 'member'
    var role: WorkspaceRole
    /// Last characters of the link, to tell links apart.
    var hint: String
    var expiresAt: String?
    var maxUses: Int?
    var uses: Int
    var createdBy: String?
    var createdAt: String
}

/// What an invite link shows before you accept it.
struct InvitePreview: Codable, Hashable, Sendable {
    struct WorkspaceInfo: Codable, Hashable, Sendable {
        var id: String
        var name: String
        var memberCount: Int
    }

    var workspace: WorkspaceInfo
    var role: WorkspaceRole
    var invitedBy: String?
    var valid: Bool
    /// 'expired' | 'revoked' | 'used_up'
    var reason: String?
    var alreadyMember: Bool?
}

enum ActivityVia: String, Codable, Hashable, Sendable {
    case session, api_token, oauth, webhook, system
}

struct ActivityEntry: Codable, Hashable, Identifiable, Sendable {
    struct Actor: Codable, Hashable, Sendable {
        var id: String?
        var name: String
    }

    var id: String
    var action: String
    var actor: Actor
    var via: ActivityVia
    var client: String?
    var projectId: String?
    var taskId: String?
    var subject: String
    var data: [String: JSONValue]
    var createdAt: String
}

struct WorkspaceSummary: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var kind: WorkspaceKind
    var name: String
    var role: WorkspaceRole
    var memberCount: Int
}

struct Workspace: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var kind: WorkspaceKind
    var name: String
    var role: WorkspaceRole
    var memberCount: Int
    var membersCanCreateProjects: Bool
    /// Whether the current user may create projects here.
    var canCreateProjects: Bool
    var createdAt: String

    var summary: WorkspaceSummary {
        WorkspaceSummary(id: id, kind: kind, name: name, role: role, memberCount: memberCount)
    }
}

struct Member: Codable, Hashable, Identifiable, Sendable {
    /// The member's user id.
    var id: String
    var name: String
    var email: String
    var role: WorkspaceRole
    var joinedAt: String
    var teamIds: [String]
}

struct Team: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var memberIds: [String]
    var createdAt: String
}

struct Project: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var workspaceId: String
    var name: String
    var color: ProjectColor
    var position: Double
    var archivedAt: String?
    /// The current user's effective access. Projects without access are never sent.
    var access: AccessLevel
    var memberAccess: MemberAccess
    var createdBy: String?
    var createdAt: String
    var updatedAt: String
}

/// `Task` in the web code. Renamed so it never shadows Swift concurrency's `Task`.
struct TaskItem: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var workspaceId: String
    /// Short per-workspace sequence number, shown as #12.
    var number: Int
    var title: String
    var notes: String
    var status: TaskStatus
    var priority: Priority
    var projectId: String?
    var startDate: ISODate?
    /// "HH:MM" in the user's time zone. Only set with a startDate.
    var startTime: ISOTime?
    var dueDate: ISODate?
    /// "by 15:30". Only set with a dueDate.
    var dueTime: ISOTime?
    /// Fixed tasks (meetings, hard deadlines) never move when something upstream slips.
    var fixed: Bool
    var position: Double
    var postponedCount: Int
    /// Who works on it, in the order they were added (empty = unassigned). All count equally.
    var assigneeIds: [String]
    var createdBy: String?
    var completedAt: String?
    var createdAt: String
    var updatedAt: String
    /// Minutes it is expected to take; nil = not estimated.
    var estimateMinutes: Int? = nil
    /// Minutes tracked on it so far (finished time entries, everyone's). nil = a server from before time planning.
    var actualMinutes: Int? = nil

    var isActive: Bool { status.isActive }
    /// Tracked minutes (0 when none).
    var actual: Int { actualMinutes ?? 0 }
    /// Whether `userId` is among the assignees.
    func isAssigned(to userId: String?) -> Bool {
        guard let userId, !userId.isEmpty else { return false }
        return assigneeIds.contains(userId)
    }
}

/// Most people one task can have (`ASSIGNEES_MAX` in schemas.ts).
let ASSIGNEES_MAX = 20

extension TaskItem {
    private enum CodingKeys: String, CodingKey {
        case id, workspaceId, number, title, notes, status, priority, projectId, startDate, startTime, dueDate, dueTime
        case fixed, position, postponedCount, assigneeIds, createdBy, completedAt, createdAt, updatedAt
        case estimateMinutes, actualMinutes
    }
    /// A server (or a cached widget snapshot) from before tasks could have several people.
    private enum LegacyKeys: String, CodingKey { case assigneeId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workspaceId = try c.decode(String.self, forKey: .workspaceId)
        number = try c.decode(Int.self, forKey: .number)
        title = try c.decode(String.self, forKey: .title)
        notes = try c.decode(String.self, forKey: .notes)
        status = try c.decode(TaskStatus.self, forKey: .status)
        priority = try c.decode(Priority.self, forKey: .priority)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        startDate = try c.decodeIfPresent(String.self, forKey: .startDate)
        startTime = try c.decodeIfPresent(String.self, forKey: .startTime)
        dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate)
        dueTime = try c.decodeIfPresent(String.self, forKey: .dueTime)
        fixed = try c.decode(Bool.self, forKey: .fixed)
        position = try c.decode(Double.self, forKey: .position)
        postponedCount = try c.decode(Int.self, forKey: .postponedCount)
        if let ids = try c.decodeIfPresent([String].self, forKey: .assigneeIds) {
            assigneeIds = ids
        } else {
            let legacy = try decoder.container(keyedBy: LegacyKeys.self).decodeIfPresent(String.self, forKey: .assigneeId)
            assigneeIds = legacy.map { [$0] } ?? []
        }
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy)
        completedAt = try c.decodeIfPresent(String.self, forKey: .completedAt)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        estimateMinutes = try c.decodeIfPresent(Int.self, forKey: .estimateMinutes)
        actualMinutes = try c.decodeIfPresent(Int.self, forKey: .actualMinutes)
    }
}

/// `taskId` cannot start until `dependsOnId` is finished.
struct Dependency: Codable, Hashable, Sendable {
    var taskId: String
    var dependsOnId: String
}

/// How long a deleted task waits in the trash (휴지통) before it is removed for good.
let TRASH_DAYS = 30

/// A deleted task waiting in the trash, as `GET /api/trash` lists it (newest first).
struct TrashItem: Codable, Hashable, Identifiable, Sendable {
    /// The task as it was when it was deleted (same id and #number it gets back on restore).
    var task: TaskItem
    /// Its dependency links at that moment; a restore re-links those whose other end still exists.
    var dependencies: [Dependency]
    var deletedAt: String
    var deletedBy: String?
    var deletedByName: String?
    /// When it will be removed for good (deletedAt + TRASH_DAYS).
    var purgeAt: String
    /// Whether you may restore it or delete it for good (edit access where it would land).
    var canRestore: Bool

    var id: String { task.id }
}

/// `POST /api/trash/restore`: the tasks back in the list, and the links that were re-made.
struct RestoreResult: Codable, Hashable, Sendable {
    var tasks: [TaskItem]
    var dependencies: [Dependency]
    /// Asked-for ids that were not in the trash any more (already restored or removed).
    var missing: [String]
}

struct Bootstrap: Codable, Sendable {
    var user: User
    var today: ISODate
    var workspace: Workspace
    var workspaces: [WorkspaceSummary]
    var members: [Member]
    var teams: [Team]
    var projects: [Project]
    var tasks: [TaskItem]
    var dependencies: [Dependency]
    /// The operators' announcement and whether you may create organizations. nil = a server from before 서버 관리.
    var server: ServerInfo?
}
