import Foundation

// Port of packages/core/src/activity.ts — Korean phrases for activity-log entries.
// Values use arrows ("마감일 11/20 → 11/22") so no particle has to agree with a name.
//
// Key order: the server stores `data` as Postgres jsonb, which hands keys back shortest first, then
// bytewise. `[String: JSONValue]` has no order, so changed fields are listed in that same jsonb order —
// exactly what the web shows for entries it loaded from the API.

let FIELD_KO: [String: String] = [
    "title": "제목",
    "status": "상태",
    "priority": "우선순위",
    "startDate": "시작일",
    "dueDate": "마감일",
    "startTime": "시작 시각",
    "dueTime": "마감 시각",
    "fixed": "고정",
    "estimateMinutes": "예상 시간",
    "project": "프로젝트",
    "assignee": "담당자",
    "name": "이름",
    "color": "색",
    "membersCanCreateProjects": "멤버 프로젝트 생성",
]

/// Keys in the order Postgres jsonb returns them: shorter first, then bytewise.
func jsonbKeyOrder(_ keys: [String]) -> [String] {
    keys.sorted { a, b in
        let ua = Array(a.utf8)
        let ub = Array(b.utf8)
        if ua.count != ub.count { return ua.count < ub.count }
        return ua.lexicographicallyPrecedes(ub)
    }
}

private func entries(_ v: JSONValue?) -> [(String, JSONValue)] {
    switch v {
    case let .object(o)?: return jsonbKeyOrder(Array(o.keys)).map { ($0, o[$0]!) }
    case let .array(a)?: return a.enumerated().map { (String($0.offset), $0.element) }
    case let .string(s)?: return s.map { String($0) }.enumerated().map { (String($0.offset), .string($0.element)) }
    default: return []
    }
}

private func val(_ field: String, _ v: JSONValue?) -> String {
    if v == nil || v == .null || v == .string("") {
        return field == "project" ? "인박스" : "없음"
    }
    switch field {
    case "status":
        if case let .string(s)? = v, let st = TaskStatus(rawValue: s) { return st.labelKo }
        return JS.string(v)
    case "priority":
        let key = JS.string(v)
        if ["0", "1", "2", "3"].contains(key), let label = PriorityInfo.labelKo[Int(key)!] { return label }
        return key
    case "startDate", "dueDate":
        return formatShortKo(JS.string(v))
    case "startTime", "dueTime":
        if case let .string(s)? = v, isISOTime(s) { return formatTimeKo(s) }
        return JS.string(v)
    case "estimateMinutes":
        if case let .number(n)? = v { return formatDurationKo(Int(n)) }
        return JS.string(v)
    case "fixed", "membersCanCreateProjects":
        return JS.truthy(v) ? "켬" : "끔"
    case "title", "name":
        return "“\(JS.string(v))”"
    default:
        return JS.string(v)
    }
}

private let LEVEL_LABEL_KO: [String: String] = ["none": "권한 없음", "view": "보기", "edit": "쓰기", "manage": "관리"]

private func level(_ l: JSONValue?) -> String {
    let key = (l == nil || l == .null) ? "none" : JS.string(l)
    return LEVEL_LABEL_KO[key] ?? JS.string(l)
}

private func role(_ r: JSONValue?) -> String {
    let key = JS.string(r)
    return WorkspaceRole(rawValue: key)?.labelKo ?? key
}

/// "마감일 11/20 → 11/22" per changed field, with friendlier words for status and assignee.
func changePhrases(_ changes: JSONValue?) -> [String] {
    guard JS.truthy(changes) else { return [] }
    var out: [String] = []
    for (field, raw) in entries(changes) {
        if field == "notes" {
            out.append("메모 수정")
            continue
        }
        let from = raw["from"]
        let to = raw["to"]
        if field == "status" {
            if to == .string("done") { out.append("완료") }
            else if to == .string("canceled") { out.append("취소") }
            else if from == .string("done") || from == .string("canceled") {
                out.append(to == .string("doing") ? "다시 열고 진행 중으로" : "다시 열기")
            } else { out.append("상태 → \(val("status", to))") }
            continue
        }
        if field == "assignee" {
            out.append(JS.truthy(to) ? "담당자 → \(JS.string(to))" : "담당자 해제")
            continue
        }
        if field == "archived" { continue }
        let label = FIELD_KO[field] ?? field
        out.append("\(label) \(val(field, from)) → \(val(field, to))")
    }
    return out
}

/// Dictionary form of `changePhrases`.
func changePhrases(_ changes: [String: JSONValue]?) -> [String] {
    changePhrases(changes.map(JSONValue.object))
}

/// What happened, without the actor ("마감일 11/20 → 11/22", "프로젝트를 만들었습니다").
/// The caller puts the actor's name and, in a feed, the subject in front.
func describeActivity(_ e: ActivityEntry) -> String {
    describeActivity(action: e.action, data: e.data, subject: e.subject)
}

/// `describeActivity` from its parts (the TS takes `Pick<ActivityEntry, 'action' | 'data' | 'subject'>`).
func describeActivity(action: String, data: [String: JSONValue]?, subject: String = "") -> String {
    let d = JSONValue.object(data ?? [:])
    let changes = d["changes"]
    switch action {
    case "task.created":
        return JS.truthy(d["assignee"]) ? "작업을 만들고 \(JS.string(d["assignee"]))님을 담당자로 지정했습니다" : "작업을 만들었습니다"
    case "task.updated":
        let parts = changePhrases(changes).joined(separator: " · ")
        let cause = JS.truthy(d["cause"]) ? " · \(JS.string(d["cause"])) 지연으로 함께 밀림" : ""
        return (parts.isEmpty ? "작업을 수정했습니다" : parts) + cause
    case "task.postponed":
        let days = JS.number(JS.coalesce(d["days"], 0))
        let verb = days >= 0 ? "\(JS.numberString(days))일 미뤘습니다" : "\(JS.numberString(-days))일 앞당겼습니다"
        let moved = JS.number(JS.coalesce(d["moved"], 0))
        return JS.truthy(d["cascade"]) && moved != 0 && !moved.isNaN ? "\(verb) · 후속 작업 \(JS.numberString(moved))개도 함께 옮김" : verb
    case "task.deleted":
        return "작업을 삭제했습니다"
    case "dependency.added":
        return "선행 작업 연결 · \(JS.string(JS.coalesce(d["blockedBy"], "")))"
    case "dependency.removed":
        return "선행 작업 연결 해제 · \(JS.string(JS.coalesce(d["blockedBy"], "")))"
    case "project.created":
        return JS.truthy(d["memberAccess"]) && d["memberAccess"] != .string("none")
            ? "프로젝트를 만들었습니다 · 조직 전체 \(level(d["memberAccess"]))"
            : "프로젝트를 만들었습니다"
    case "project.updated":
        let parts = changePhrases(changes).joined(separator: " · ")
        return parts.isEmpty ? "프로젝트를 수정했습니다" : parts
    case "project.archived":
        return "프로젝트를 보관했습니다"
    case "project.unarchived":
        return "프로젝트를 보관 해제했습니다"
    case "project.deleted":
        return d["tasks"] == .string("deleted") ? "프로젝트와 작업을 삭제했습니다" : "프로젝트를 삭제했습니다 · 작업은 인박스로"
    case "project.access":
        let list = changes?.array ?? []
        let parts = list.map { c -> String in
            if JS.truthy(c["everyone"]) {
                let ev = c["everyone"]
                return "조직 전체 \(level(ev?["from"])) → \(level(ev?["to"]))"
            }
            let who = JS.truthy(c["member"]) ? JS.string(c["member"]) : "팀 \(JS.string(c["team"]))"
            return "\(who) \(level(c["from"])) → \(level(c["to"]))"
        }
        return "공유 설정 · \(parts.joined(separator: " · "))"
    case "project.moved_out":
        return "\(JS.string(d["to"]))(으)로 옮겼습니다 · 작업 \(JS.numberString(JS.number(JS.coalesce(d["tasks"], 0))))개"
    case "project.moved_in":
        return "\(JS.string(d["from"]))에서 옮겨 왔습니다 · 작업 \(JS.numberString(JS.number(JS.coalesce(d["tasks"], 0))))개"
    case "workspace.created":
        return "조직을 만들었습니다"
    case "workspace.updated":
        return "조직 설정 · \(changePhrases(changes).joined(separator: " · "))"
    case "member.joined":
        return "초대 링크로 참여했습니다 · \(role(d["role"]))"
    case "member.role":
        return "역할 \(role(d["from"])) → \(role(d["to"]))"
    case "member.removed":
        return "조직에서 내보냈습니다"
    case "member.left":
        return "조직을 떠났습니다"
    case "invite.created":
        return "\(role(d["role"])) 초대 링크를 만들었습니다"
    case "invite.revoked":
        return "초대 링크를 취소했습니다"
    case "team.created":
        return "팀을 만들었습니다"
    case "team.updated":
        var parts: [String] = []
        if JS.truthy(d["renamed"]) {
            parts.append("이름 \(val("name", d["renamed"]?["from"])) → \(val("name", d["renamed"]?["to"]))")
        }
        func count(_ v: JSONValue?) -> Int {
            switch v {
            case let .array(a)?: return a.count
            case let .string(s)?: return JS.length(s)
            default: return 0
            }
        }
        let added = count(d["added"])
        let removed = count(d["removed"])
        if added != 0 { parts.append("멤버 \(added)명 추가") }
        if removed != 0 { parts.append("멤버 \(removed)명 제외") }
        return "팀 수정 · \(parts.joined(separator: " · "))"
    case "team.deleted":
        return "팀을 삭제했습니다"
    default:
        return action
    }
}

/// Which kind of thing an entry is about, for grouping and icons.
enum ActivityKind: String, Codable, CaseIterable, Hashable, Sendable {
    case task, project, member, team, invite, workspace
}

func activityKind(_ action: String) -> ActivityKind {
    let head = action.components(separatedBy: ".")[0]
    if head == "dependency" { return .task }
    return ActivityKind(rawValue: head) ?? .workspace
}

/// "Claude 통해", "API 토큰 “CI”", "웹훅 “Zapier” 통해"; nil for the web app and the system.
func viaLabelKo(_ via: ActivityVia, _ client: String?) -> String? {
    switch via {
    case .oauth: return client.jsTruthy ? "\(client!) 통해" : "AI 앱 통해"
    case .api_token: return client.jsTruthy ? "API 토큰 “\(client!)”" : "API 토큰"
    case .webhook: return client.jsTruthy ? "웹훅 “\(client!)” 통해" : "웹훅 통해"
    default: return nil
    }
}
