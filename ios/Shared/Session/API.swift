import Foundation

enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", patch = "PATCH", put = "PUT", delete = "DELETE"
}

/// A failed request, with the server's own (Korean) message when it sent one.
struct APIError: LocalizedError, Sendable {
    let message: String
    /// HTTP status; 0 = could not reach the server.
    let status: Int
    /// A machine-readable reason some answers carry, e.g. "email_unverified" or "pending_approval".
    var code: String? = nil

    var errorDescription: String? { message }
    var isUnauthorized: Bool { status == 401 }
    var isNotFound: Bool { status == 404 }
    /// Signed in, but the account isn't let in yet (403 with a gate code).
    var gate: AccountGate? { status == 403 ? code.flatMap(AccountGate.init(rawValue:)) : nil }
}

/// The REST client. Mirrors web/src/lib/api.ts: same paths, same headers, same error messages.
///
///     let r: TasksResponse = try await API.shared.get("/api/tasks", query: ["view": "today"])
///     let r: TaskResponse = try await API.shared.send(.patch, "/api/tasks/\(id)", json: ["dueDate": .null])
///     try await API.shared.send(.delete, "/api/tasks/\(id)")
final class API: @unchecked Sendable {
    static let shared = API()

    private let session: URLSession
    let decoder = JSONDecoder()
    let encoder = JSONEncoder()

    init() {
        let config = URLSessionConfiguration.default
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 30
        session = URLSession(configuration: config)
    }

    // MARK: requests

    func get<T: Decodable>(_ path: String, query: [String: String?] = [:], as type: T.Type = T.self) async throws -> T {
        let data = try await raw(.get, path, query: query, body: nil)
        return try decode(type, data)
    }

    func send<T: Decodable>(_ method: HTTPMethod, _ path: String, json: JSONValue? = nil, as type: T.Type = T.self) async throws -> T {
        let body = try json.map { try encoder.encode($0) }
        let data = try await raw(method, path, body: body)
        return try decode(type, data)
    }

    func send<T: Decodable, B: Encodable>(_ method: HTTPMethod, _ path: String, body: B, as type: T.Type = T.self) async throws -> T {
        let data = try await raw(method, path, body: try encoder.encode(body))
        return try decode(type, data)
    }

    /// For calls whose response body you don't need.
    @discardableResult
    func send(_ method: HTTPMethod, _ path: String, json: JSONValue? = nil) async throws -> JSONValue {
        let body = try json.map { try encoder.encode($0) }
        let data = try await raw(method, path, body: body)
        if data.isEmpty { return .null }
        return (try? decoder.decode(JSONValue.self, from: data)) ?? .null
    }

    /// The absolute URL for a server path (for links the user opens in Safari, downloads, invite links).
    func url(_ path: String, query: [String: String?] = [:]) -> URL? {
        var comps = URLComponents(string: Session.server + path)
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }.sorted { $0.name < $1.name }
        if !items.isEmpty {
            let existing = comps?.queryItems ?? []
            comps?.queryItems = existing + items
        }
        return comps?.url
    }

    // MARK: plumbing

    func raw(_ method: HTTPMethod, _ path: String, query: [String: String?] = [:], body: Data?, workspace: String?? = nil) async throws -> Data {
        try await perform(method, path, query: query, body: body, workspace: workspace).0
    }

    /// Like `raw`, plus the HTTP response (login reads its Set-Cookie header).
    func perform(_ method: HTTPMethod, _ path: String, query: [String: String?] = [:], body: Data?, workspace: String?? = nil) async throws -> (Data, HTTPURLResponse) {
        guard let url = url(path, query: query) else { throw APIError(message: "서버 주소가 올바르지 않습니다", status: 0) }
        var req = URLRequest(url: url)
        req.httpMethod = method.rawValue
        req.httpShouldHandleCookies = false
        req.setValue("ios", forHTTPHeaderField: "x-obelisk-client")
        req.setValue("application/json", forHTTPHeaderField: "accept")
        if let token = Session.token {
            req.setValue("\(Session.cookieName)=\(token)", forHTTPHeaderField: "Cookie")
        }
        let ws: String? = workspace ?? Session.workspaceId
        if let ws { req.setValue(ws, forHTTPHeaderField: "x-obelisk-workspace") }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            if (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw APIError(message: "서버에 연결할 수 없습니다", status: 0)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "서버에 연결할 수 없습니다", status: 0)
        }
        if !(200 ..< 300).contains(http.statusCode) {
            throw APIError(
                message: Self.message(from: data) ?? "요청을 처리하지 못했습니다 (\(http.statusCode))",
                status: http.statusCode,
                code: Self.code(from: data)
            )
        }
        return (data, http)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        if T.self == JSONValue.self, data.isEmpty { return JSONValue.null as! T }
        do {
            return try decoder.decode(type, from: data)
        } catch {
            #if DEBUG
            print("[API] decode \(T.self) failed: \(error)")
            #endif
            throw APIError(message: "서버 응답을 읽지 못했습니다", status: -1)
        }
    }

    /// NestJS errors: { message: string | string[] }
    static func message(from data: Data) -> String? {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        if let s = json["message"]?.string, !s.isEmpty { return s }
        if let first = json["message"]?.array?.first?.string { return first }
        if let s = json["error_description"]?.string { return s }
        return nil
    }

    /// `code` in an error body (the gate codes on 403).
    static func code(from data: Data) -> String? {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        return json["code"]?.string
    }
}

// MARK: - Auth

struct UserResponse: Codable, Sendable { var user: User }

extension API {
    /// POST /api/auth/login, then keeps the session cookie. Throws APIError with the server's message.
    func login(email: String, password: String) async throws -> User {
        Session.token = nil
        let body: JSONValue = ["email": .string(email), "password": .string(password)]
        let (data, res) = try await perform(.post, "/api/auth/login", body: try encoder.encode(body), workspace: .some(nil))
        guard let token = Session.sessionToken(from: res) else {
            throw APIError(message: "로그인 세션을 받지 못했습니다", status: -1)
        }
        Session.token = token
        return try decode(UserResponse.self, data).user
    }

    struct SignupResult: Codable, Sendable {
        var user: User
        var joinedWorkspaceId: String?
        /// Why the new account can't use the app yet (confirm the address / wait for approval).
        var gate: AccountGate?
    }

    func signup(name: String, email: String, password: String, inviteToken: String? = nil) async throws -> SignupResult {
        Session.token = nil
        var body: [String: JSONValue] = [
            "name": .string(name), "email": .string(email), "password": .string(password),
            "timezone": .string(TimeZone.current.identifier),
        ]
        if let inviteToken { body["inviteToken"] = .string(inviteToken) }
        let (data, res) = try await perform(.post, "/api/auth/signup", body: try encoder.encode(JSONValue.object(body)), workspace: .some(nil))
        guard let token = Session.sessionToken(from: res) else {
            throw APIError(message: "가입 세션을 받지 못했습니다", status: -1)
        }
        Session.token = token
        return try decode(SignupResult.self, data)
    }

    /// Can someone sign up here (with this invite), and what follows. Unreachable = closed.
    func signupStatus(invite: String? = nil) async -> SignupStatus {
        let r: SignupStatus? = try? await get("/api/auth/signup-status", query: ["invite": invite])
        return r ?? .closed
    }

    func logout() async {
        _ = try? await send(.post, "/api/auth/logout")
        Session.signOutLocally()
    }
}
