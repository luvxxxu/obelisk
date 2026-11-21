import Foundation
import Observation
import SwiftUI

// 설정 › 웹훅: data and actions (web settings/webhooks/page.tsx + shared.tsx).
//
// One model per open 웹훅 page, shared by everything pushed from it (details, delivery log), so a
// change made on a detail screen shows on the list without a reload. Sheets and confirmations live on
// each screen (WebhooksActionHost), never here, so two screens never try to present the same sheet.

// MARK: - routes, sheets, confirmations

/// Values pushed from the 웹훅 page (registered with `.navigationDestination` on WebhooksSettingsView).
enum WebhooksRoute: Hashable {
    case outgoing(String)
    case incoming(String)
    /// 전달 기록 of an outgoing webhook.
    case deliveries(String)
    case delivery(hookId: String, deliveryId: String)
}

/// A signing secret or a secret URL, shown once (web RevealModal).
struct WebhooksRevealItem: Hashable {
    enum Kind: Hashable {
        case secret(Webhook, String)
        case url(IncomingWebhook, String)
    }

    var kind: Kind
    /// Just created (offers 테스트 보내기) rather than rotated.
    var fresh: Bool

    var title: String {
        switch kind {
        case .secret: fresh ? "보내는 웹훅을 만들었어요" : "새 서명 키를 만들었어요"
        case .url: fresh ? "받는 웹훅 URL을 만들었어요" : "새 URL을 만들었어요"
        }
    }
}

enum WebhooksSheet: Identifiable {
    /// nil = new webhook.
    case outgoingForm(Webhook?)
    case incomingForm(IncomingWebhook?)
    case reveal(WebhooksRevealItem)

    var id: String {
        switch self {
        case let .outgoingForm(h): "out-\(h?.id ?? "new")"
        case let .incomingForm(h): "in-\(h?.id ?? "new")"
        case let .reveal(r):
            switch r.kind {
            case let .secret(h, _): "reveal-secret-\(h.id)"
            case let .url(h, _): "reveal-url-\(h.id)"
            }
        }
    }
}

enum WebhooksConfirm: Identifiable {
    case deleteOut(Webhook)
    case deleteIn(IncomingWebhook)
    case rotateSecret(Webhook)
    case rotateUrl(IncomingWebhook)

    var id: String {
        switch self {
        case let .deleteOut(h): "delete-out-\(h.id)"
        case let .deleteIn(h): "delete-in-\(h.id)"
        case let .rotateSecret(h): "rotate-secret-\(h.id)"
        case let .rotateUrl(h): "rotate-url-\(h.id)"
        }
    }

    var title: String {
        switch self {
        case .rotateSecret: "서명 키를 다시 만들까요?"
        case .rotateUrl: "URL을 다시 만들까요?"
        case .deleteOut, .deleteIn: "웹훅을 삭제할까요?"
        }
    }

    var actionLabel: String {
        switch self {
        case .rotateSecret, .rotateUrl: "다시 만들기"
        case .deleteOut, .deleteIn: "삭제"
        }
    }

    var message: String {
        switch self {
        case .rotateSecret: "지금 쓰는 서명 키는 바로 무효가 돼요. 받는 서버의 키도 새 값으로 바꿔야 해요."
        case let .rotateUrl(h): "“\(h.name)”의 지금 URL은 바로 작동을 멈춰요. 이 URL을 쓰던 곳을 모두 새 주소로 바꿔야 해요."
        case let .deleteOut(h): "“\(h.name)”으로 더 이상 보내지 않고, 전달 기록도 함께 지워져요."
        case let .deleteIn(h): "“\(h.name)” URL로 오는 요청은 더 이상 처리되지 않아요."
        }
    }

    var hookId: String {
        switch self {
        case let .deleteOut(h), let .rotateSecret(h): h.id
        case let .deleteIn(h), let .rotateUrl(h): h.id
        }
    }

    var isDelete: Bool {
        switch self {
        case .deleteOut, .deleteIn: true
        default: false
        }
    }
}

// MARK: - a delivery as the log shows it

/// One delivery, with its payload kept as stored so 보낸 본문 can show exactly what went out
/// (typed `WebhookDelivery` would lose key order and anything the catalog doesn't model).
struct WebhooksLogEntry: Identifiable, Hashable {
    var id: String
    var event: String
    var status: WebhookDeliveryStatus
    var attempts: Int
    var maxAttempts: Int
    var nextAttemptAt: String?
    var lastAttemptAt: String?
    var responseStatus: Int?
    var responseBody: String?
    var error: String?
    var durationMs: Int?
    var createdAt: String
    /// The payload as stored.
    var raw: JSONValue
    /// The same payload typed (for the Slack/Discord body), when it reads.
    var payload: WebhookPayload?

    /// "데모 · #12 기획서 — 새 작업"
    var text: String { payload?.text ?? raw["text"]?.string ?? "" }

    private struct Head: Decodable {
        var id: String
        var event: String
        var status: WebhookDeliveryStatus
        var attempts: Int
        var maxAttempts: Int
        var nextAttemptAt: String?
        var lastAttemptAt: String?
        var responseStatus: Int?
        var responseBody: String?
        var error: String?
        var durationMs: Int?
        var createdAt: String
    }

    init?(_ json: JSONValue) {
        guard let h = try? json.decode(Head.self) else {
            #if DEBUG
            print("[Webhooks] unreadable delivery: \(json)")
            #endif
            return nil
        }
        id = h.id
        event = h.event
        status = h.status
        attempts = h.attempts
        maxAttempts = h.maxAttempts
        nextAttemptAt = h.nextAttemptAt
        lastAttemptAt = h.lastAttemptAt
        responseStatus = h.responseStatus
        responseBody = h.responseBody
        error = h.error
        durationMs = h.durationMs
        createdAt = h.createdAt
        raw = json["payload"] ?? .null
        payload = try? raw.decode(WebhookPayload.self)
    }
}

// MARK: - model

@Observable
@MainActor
final class WebhooksModel {
    private(set) var overview: WebhooksOverview?
    /// Loading the page failed (shown instead of the lists, with a retry).
    private(set) var failed: String?
    /// The outgoing webhook a test is being sent to.
    private(set) var testing: String?
    /// 전달 기록 per webhook id, newest first; nil until loaded.
    private(set) var logs: [String: [WebhooksLogEntry]] = [:]
    /// The delivery being sent again.
    private(set) var redelivering: String?

    @ObservationIgnored weak var store: AppStore?
    @ObservationIgnored private var generation = 0

    func outgoing(_ id: String) -> Webhook? { overview?.webhooks.first { $0.id == id } }
    func incoming(_ id: String) -> IncomingWebhook? { overview?.incoming.first { $0.id == id } }
    func entry(_ hookId: String, _ id: String) -> WebhooksLogEntry? { logs[hookId]?.first { $0.id == id } }

    /// The workspace the data belongs to.
    private(set) var workspaceId: String?

    /// Another workspace opened: forget everything from the last one.
    func reset(_ workspaceId: String?) {
        self.workspaceId = workspaceId
        generation += 1
        overview = nil
        failed = nil
        testing = nil
        logs = [:]
        redelivering = nil
    }

    func load() async {
        let gen = generation
        do {
            let r: WebhooksOverview = try await API.shared.get("/api/webhooks")
            guard gen == generation else { return }
            overview = r
            failed = nil
        } catch is CancellationError {
            return
        } catch {
            guard gen == generation else { return }
            store?.report(error)
            if overview == nil { failed = (error as? LocalizedError)?.errorDescription ?? "웹훅을 불러오지 못했어요" }
        }
    }

    private func putOut(_ hook: Webhook) {
        guard var o = overview else { return }
        if let i = o.webhooks.firstIndex(where: { $0.id == hook.id }) { o.webhooks[i] = hook } else { o.webhooks.append(hook) }
        overview = o
    }

    private func putIn(_ hook: IncomingWebhook) {
        guard var o = overview else { return }
        if let i = o.incoming.firstIndex(where: { $0.id == hook.id }) { o.incoming[i] = hook } else { o.incoming.append(hook) }
        overview = o
    }

    // MARK: outgoing

    func setEnabled(_ hook: Webhook, _ enabled: Bool) async {
        var next = hook
        next.enabled = enabled
        withAnimation(ObMotion.standard) { putOut(next) }
        Haptics.select()
        do {
            let r: WebhookResponse = try await API.shared.send(.patch, "/api/webhooks/\(hook.id)", body: UpdateWebhookInput(enabled: enabled))
            putOut(r.webhook)
            store?.toasts.show(enabled ? "“\(hook.name)”을(를) 켰어요" : "“\(hook.name)”을(를) 껐어요")
        } catch {
            withAnimation(ObMotion.standard) { putOut(hook) }
            store?.report(error)
        }
    }

    /// 테스트 보내기. `inline` (right after creating) returns the result instead of a toast.
    @discardableResult
    func test(_ hook: Webhook, inline: Bool = false) async -> WebhooksLogEntry? {
        guard testing == nil else { return nil }
        testing = hook.id
        defer { testing = nil }
        do {
            let r: JSONValue = try await API.shared.send(.post, "/api/webhooks/\(hook.id)/test")
            guard let d = r["delivery"].flatMap(WebhooksLogEntry.init) else {
                throw APIError(message: "서버 응답을 읽지 못했습니다", status: -1)
            }
            if !inline {
                if d.status == .success {
                    Haptics.success()
                    store?.toasts.show("테스트를 보냈어요 · HTTP \(d.responseStatus.map(String.init) ?? "")")
                } else {
                    store?.toasts.error("테스트 실패 · \(d.error ?? "응답 없음")")
                }
            }
            if logs[hook.id] != nil { logs[hook.id]?.insert(d, at: 0) }
            Task { await load() }
            return d
        } catch {
            store?.report(error)
            return nil
        }
    }

    /// Create (returns the signing secret, shown once) or save an edit. nil when it failed (already toasted).
    func saveOutgoing(_ initial: Webhook?, _ input: CreateWebhookInput) async -> (Webhook, String?)? {
        do {
            if let initial {
                let patch = UpdateWebhookInput(
                    name: input.name, url: input.url, format: input.format, events: input.events,
                    projectIds: input.projectIds, alertHour: input.alertHour, remindMinutes: input.remindMinutes
                )
                let r: WebhookResponse = try await API.shared.send(.patch, "/api/webhooks/\(initial.id)", body: patch)
                putOut(r.webhook)
                return (r.webhook, nil)
            }
            let r: WebhookCreatedResponse = try await API.shared.send(.post, "/api/webhooks", body: input)
            putOut(r.webhook)
            return (r.webhook, r.secret)
        } catch {
            store?.report(error)
            return nil
        }
    }

    // MARK: incoming

    func saveIncoming(_ initial: IncomingWebhook?, _ input: CreateIncomingWebhookInput) async -> (IncomingWebhook, String?)? {
        do {
            if let initial {
                let patch = UpdateIncomingWebhookInput(name: input.name, projectId: input.projectId, allowUpdates: input.allowUpdates)
                let r: IncomingWebhookResponse = try await API.shared.send(.patch, "/api/incoming-webhooks/\(initial.id)", body: patch)
                putIn(r.incoming)
                return (r.incoming, nil)
            }
            let r: IncomingWebhookCreatedResponse = try await API.shared.send(.post, "/api/incoming-webhooks", body: input)
            putIn(r.incoming)
            return (r.incoming, r.url)
        } catch {
            store?.report(error)
            return nil
        }
    }

    // MARK: confirmed actions

    /// Runs a confirmed delete or rotate. Rotations return what to reveal; deletes return nil.
    /// `ok` is false when the request failed (already toasted).
    func run(_ c: WebhooksConfirm) async -> (ok: Bool, reveal: WebhooksRevealItem?) {
        do {
            switch c {
            case let .deleteOut(h):
                try await API.shared.send(.delete, "/api/webhooks/\(h.id)")
                if var o = overview {
                    o.webhooks.removeAll { $0.id == h.id }
                    withAnimation(ObMotion.standard) { overview = o }
                }
                logs[h.id] = nil
                store?.toasts.show("“\(h.name)”을(를) 삭제했어요")
                return (true, nil)
            case let .deleteIn(h):
                try await API.shared.send(.delete, "/api/incoming-webhooks/\(h.id)")
                if var o = overview {
                    o.incoming.removeAll { $0.id == h.id }
                    withAnimation(ObMotion.standard) { overview = o }
                }
                store?.toasts.show("“\(h.name)”을(를) 삭제했어요")
                return (true, nil)
            case let .rotateSecret(h):
                let r: WebhookSecretResponse = try await API.shared.send(.post, "/api/webhooks/\(h.id)/secret")
                return (true, WebhooksRevealItem(kind: .secret(h, r.secret), fresh: false))
            case let .rotateUrl(h):
                let r: IncomingWebhookUrlResponse = try await API.shared.send(.post, "/api/incoming-webhooks/\(h.id)/rotate")
                await load()
                return (true, WebhooksRevealItem(kind: .url(incoming(h.id) ?? h, r.url), fresh: false))
            }
        } catch {
            store?.report(error)
            return (false, nil)
        }
    }

    // MARK: 전달 기록

    func loadLog(_ hookId: String) async {
        do {
            let r: JSONValue = try await API.shared.get("/api/webhooks/\(hookId)/deliveries")
            logs[hookId] = (r["deliveries"]?.array ?? []).compactMap(WebhooksLogEntry.init)
        } catch is CancellationError {
            return
        } catch {
            store?.report(error)
            if logs[hookId] == nil { logs[hookId] = [] }
        }
    }

    /// 다시 보내기: the new delivery goes on top of the log and is returned.
    func redeliver(_ hookId: String, _ entry: WebhooksLogEntry) async -> WebhooksLogEntry? {
        guard redelivering == nil else { return nil }
        redelivering = entry.id
        defer { redelivering = nil }
        do {
            let r: JSONValue = try await API.shared.send(.post, "/api/webhooks/\(hookId)/deliveries/\(entry.id)/redeliver")
            guard let d = r["delivery"].flatMap(WebhooksLogEntry.init) else {
                throw APIError(message: "서버 응답을 읽지 못했습니다", status: -1)
            }
            if d.status == .success {
                Haptics.success()
                store?.toasts.show("다시 보냈어요 · HTTP \(d.responseStatus.map(String.init) ?? "")")
            } else {
                store?.toasts.error("다시 보내지 못했어요 · \(d.error ?? "실패")")
            }
            logs[hookId, default: []].insert(d, at: 0)
            Task { await load() }
            return d
        } catch {
            store?.report(error)
            return nil
        }
    }
}

// MARK: - labels (web shared.tsx)

/// "자정", "정오", "오전 9시", "오후 3시"
func webhooksHourLabel(_ h: Int) -> String {
    if h == 0 { return "자정" }
    if h == 12 { return "정오" }
    return h < 12 ? "오전 \(h)시" : "오후 \(h - 12)시"
}

struct WebhooksStatus {
    var tone: Tone
    var label: String
    var detail: String?
}

/// "정상 · 3분 전", "실패 · HTTP 404 · 3분 전", "꺼짐" … (web hookStatus). `.neutral` stands for muted.
func webhooksHookStatus(_ h: Webhook) -> WebhooksStatus {
    if !h.enabled { return WebhooksStatus(tone: h.disabledReason != nil ? .warn : .neutral, label: "꺼짐", detail: nil) }
    guard let last = h.lastDelivery else { return WebhooksStatus(tone: .neutral, label: "대기 중", detail: "아직 보낸 적 없음") }
    let when = relativeTime(last.at)
    switch last.status {
    case .success: return WebhooksStatus(tone: .ok, label: "정상", detail: when)
    case .pending: return WebhooksStatus(tone: .info, label: "재시도 대기", detail: when)
    case .failed:
        return WebhooksStatus(tone: .danger, label: "실패", detail: last.responseStatus.map { "HTTP \($0) · \(when)" } ?? when)
    }
}

extension WebhookDeliveryStatus {
    /// 성공 · 실패 · 재시도 대기
    var webhooksLabel: String {
        switch self {
        case .success: "성공"
        case .failed: "실패"
        case .pending: "재시도 대기"
        }
    }

    var webhooksSymbol: String {
        switch self {
        case .success: "checkmark.circle"
        case .failed: "xmark.circle"
        case .pending: "clock"
        }
    }

    /// ok / danger; pending stays neutral like the web's muted icon.
    var webhooksTone: Tone {
        switch self {
        case .success: .ok
        case .failed: .danger
        case .pending: .neutral
        }
    }
}

let WEBHOOKS_FORMAT_HINT: [WebhookFormat: String] = [
    .json: "서명된 JSON을 POST해요. 내 서버, Zapier, Make, n8n 등에서 받을 수 있어요.",
    .slack: "Slack Incoming Webhook으로 채널에 한국어 메시지를 보내요.",
    .discord: "Discord 채널 웹훅으로 한국어 메시지를 보내요. 멘션은 울리지 않아요.",
]

let WEBHOOKS_VERIFY_SNIPPET = """
// Node.js: 요청이 Obelisk에서 왔는지 확인 (rawBody = 받은 본문 그대로)
import { createHmac, timingSafeEqual } from 'node:crypto';

function fromObelisk(rawBody, headers, secret) {
  const ts = headers['x-obelisk-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 5분 지난 요청은 거절
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const got = String(headers['x-obelisk-signature'] ?? '');
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
"""

/// curl examples for a fresh incoming URL (web incomingExamples).
func webhooksIncomingExamples(_ url: String, allowUpdates: Bool, due: ISODate) -> [(title: String, code: String)] {
    var out: [(title: String, code: String)] = [
        (
            "한 줄로 만들기 (빠른 추가와 같은 문법)",
            "curl -X POST \"\(url)\" \\\n  -H \"content-type: text/plain\" \\\n  --data \"보고서 초안 내일 !높음\""
        ),
        (
            "JSON으로 만들기",
            "curl -X POST \"\(url)\" \\\n  -H \"content-type: application/json\" \\\n  -d '{\"title\":\"배포 확인\",\"dueDate\":\"\(due)\",\"priority\":\"high\",\"assignees\":[\"me\"]}'"
        ),
    ]
    if allowUpdates {
        out.append((
            "기존 작업 바꾸기",
            "curl -X POST \"\(url)\" \\\n  -H \"content-type: application/json\" \\\n  -d '{\"action\":\"complete\",\"task\":\"#12\"}'"
        ))
    }
    return out
}

/// "개인 공간" for the personal space, the organization's name otherwise (web workspaceLabel).
func webhooksSpaceLabel(_ w: Workspace?) -> String {
    guard let w else { return "Obelisk" }
    return w.kind == .personal ? "개인 공간" : w.name
}

/// "1,234"
func webhooksCount(_ n: Int) -> String {
    n.formatted(.number.locale(Locale(identifier: "ko_KR")))
}

enum WebhooksTime {
    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ko_KR")
        f.timeZone = .current
        f.dateFormat = format
        return f
    }

    private static let clockFormat = formatter("a h:mm")
    private static let fullFormat = formatter("y. M. d. a h:mm:ss")

    /// "오후 3:05" (toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }))
    static func clock(_ iso: String) -> String {
        JS.parseDate(iso).map { clockFormat.string(from: $0) } ?? iso
    }

    /// "2026. 11. 19. 오후 3:05:12" (toLocaleString('ko-KR'))
    static func full(_ iso: String) -> String {
        JS.parseDate(iso).map { fullFormat.string(from: $0) } ?? iso
    }
}

// MARK: - bodies as the log shows them (JSON.stringify(…, null, 2))

enum WebhooksJSON {
    /// packages/core PAYLOAD_ORDER: the reading order the server sends a JSON payload in.
    static let payloadOrder = ["id", "event", "createdAt", "workspace", "actor", "subject", "summary", "text", "url", "task", "project", "changes", "alert", "data"]

    /// What was POSTed: the ordered payload for JSON webhooks, the chat message for Slack/Discord.
    static func sentBody(_ format: WebhookFormat, _ e: WebhooksLogEntry) -> String {
        if format != .json, let p = e.payload {
            let msg = chatMessage(p, format)
            let order = format == .slack ? ["text", "unfurl_links", "unfurl_media"] : ["content", "username", "allowed_mentions"]
            return pretty(.object(msg), top: order)
        }
        return pretty(e.raw, top: payloadOrder)
    }

    /// The receiver's answer, indented when it is JSON (key order kept), as is otherwise.
    static func response(_ body: String?) -> String {
        guard let body, !body.isEmpty else { return "(빈 응답)" }
        return reindent(body) ?? body
    }

    /// `JSON.stringify(v, null, 2)`. Top-level keys follow `top`, then (like every nested object) the order
    /// Postgres jsonb keeps them in: shorter keys first, then byte order.
    static func pretty(_ v: JSONValue, top: [String] = []) -> String {
        var out = ""
        write(v, indent: 0, top: top, into: &out)
        return out
    }

    private static func jsonbOrder(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        if x.count != y.count { return x.count < y.count }
        return x.lexicographicallyPrecedes(y)
    }

    private static func write(_ v: JSONValue, indent: Int, top: [String], into out: inout String) {
        let pad = String(repeating: "  ", count: indent)
        let inner = String(repeating: "  ", count: indent + 1)
        switch v {
        case .null: out += "null"
        case let .bool(b): out += b ? "true" : "false"
        case let .number(n): out += number(n)
        case let .string(s): out += quote(s)
        case let .array(a):
            if a.isEmpty { out += "[]"; return }
            out += "[\n"
            for (i, x) in a.enumerated() {
                out += inner
                write(x, indent: indent + 1, top: [], into: &out)
                out += i < a.count - 1 ? ",\n" : "\n"
            }
            out += pad + "]"
        case let .object(o):
            if o.isEmpty { out += "{}"; return }
            let first = top.filter { o[$0] != nil }
            let rest = o.keys.filter { !first.contains($0) }.sorted(by: jsonbOrder)
            let keys = first + rest
            out += "{\n"
            for (i, k) in keys.enumerated() {
                out += inner + quote(k) + ": "
                write(o[k]!, indent: indent + 1, top: [], into: &out)
                out += i < keys.count - 1 ? ",\n" : "\n"
            }
            out += pad + "}"
        }
    }

    private static func number(_ n: Double) -> String {
        if n.rounded() == n, abs(n) < 1e15 { return String(Int64(n)) }
        return String(n)
    }

    private static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        return out + "\""
    }

    /// Re-indents valid JSON text with two spaces, keeping its key order (nil when it isn't JSON).
    static func reindent(_ s: String) -> String? {
        guard let data = s.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) != nil
        else { return nil }
        let chars = Array(s.unicodeScalars)
        var out = String.UnicodeScalarView()
        var indent = 0
        var inString = false
        var escaped = false
        func newline() {
            out.append("\n")
            for _ in 0 ..< indent * 2 { out.append(" ") }
        }
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if inString {
                out.append(c)
                if escaped { escaped = false } else if c == "\\" { escaped = true } else if c == "\"" { inString = false }
                i += 1
                continue
            }
            switch c {
            case "\"":
                inString = true
                out.append(c)
            case "{", "[":
                var j = i + 1
                while j < chars.count, [" ", "\n", "\r", "\t"].contains(chars[j]) { j += 1 }
                let close: Unicode.Scalar = c == "{" ? "}" : "]"
                if j < chars.count, chars[j] == close {
                    out.append(c)
                    out.append(close)
                    i = j + 1
                    continue
                }
                out.append(c)
                indent += 1
                newline()
            case "}", "]":
                indent = max(0, indent - 1)
                newline()
                out.append(c)
            case ",":
                out.append(c)
                newline()
            case ":":
                out.append(c)
                out.append(" ")
            case " ", "\n", "\r", "\t":
                break
            default:
                out.append(c)
            }
            i += 1
        }
        return String(out)
    }
}
