import Foundation
import Security

/// Shared by the app, the widget and the share extension.
enum AppGroup {
    static let id = "group.dev.lxvu.obelisk"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: id) ?? .standard
    }

    /// The shared container (snapshot for widgets, pending share items).
    static var containerURL: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }
}

/// Where the app talks to, and the signed-in session.
///
/// The iOS app signs in exactly like the web: POST /api/auth/login sets the `obelisk_session` cookie.
/// We keep that token in the Keychain (access group = the App Group, so extensions can read it)
/// and send it back as a Cookie header with `x-obelisk-client: ios`. A cookie session (not an API
/// token) is what lets the app do everything the web can, including session-only actions such as
/// sharing projects and minting API tokens.
enum Session {
    static let cookieName = "obelisk_session"
    static let defaultServer = "https://obelisk.lxvu.dev"

    private static let serverKey = "obelisk.server"
    private static let workspaceKey = "obelisk.workspace"
    private static let keychainAccount = "session"
    private static let keychainService = "dev.lxvu.obelisk"

    // MARK: server

    /// Base URL without a trailing slash, e.g. https://obelisk.lxvu.dev
    static var server: String {
        get {
            #if DEBUG
            if let env = ProcessInfo.processInfo.environment["OBELISK_SERVER"], !env.isEmpty {
                return normalize(env)
            }
            #endif
            return AppGroup.defaults.string(forKey: serverKey).map(normalize) ?? defaultServer
        }
        set { AppGroup.defaults.set(normalize(newValue), forKey: serverKey) }
    }

    static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty, !s.contains("://") {
            s = (s.hasPrefix("localhost") || s.hasPrefix("127.") ? "http://" : "https://") + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    // MARK: open workspace (sent as x-obelisk-workspace)

    static var workspaceId: String? {
        get { AppGroup.defaults.string(forKey: workspaceKey) }
        set {
            if let v = newValue { AppGroup.defaults.set(v, forKey: workspaceKey) }
            else { AppGroup.defaults.removeObject(forKey: workspaceKey) }
        }
    }

    // MARK: token (Keychain)

    static var token: String? {
        get { Keychain.read(service: keychainService, account: keychainAccount) }
        set {
            if let v = newValue { Keychain.write(v, service: keychainService, account: keychainAccount) }
            else { Keychain.delete(service: keychainService, account: keychainAccount) }
        }
    }

    static var isSignedIn: Bool { token != nil }

    /// Pull `obelisk_session` out of a login/sign-up response.
    static func sessionToken(from response: HTTPURLResponse) -> String? {
        guard let url = response.url else { return nil }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { out, kv in
            if let k = kv.key as? String, let v = kv.value as? String { out[k] = v }
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
        if let c = cookies.first(where: { $0.name == cookieName }), !c.value.isEmpty { return c.value }
        // Fallback: parse the raw header (some stacks fold multiple Set-Cookie headers).
        let raw = headers.first { $0.key.lowercased() == "set-cookie" }?.value ?? ""
        for part in raw.components(separatedBy: CharacterSet(charactersIn: ",;")) {
            let kv = part.trimmingCharacters(in: .whitespaces)
            if kv.hasPrefix(cookieName + "=") {
                let v = String(kv.dropFirst(cookieName.count + 1))
                return v.isEmpty ? nil : v
            }
        }
        return nil
    }

    static func signOutLocally() {
        token = nil
        workspaceId = nil
    }
}

/// Minimal generic-password Keychain wrapper. Uses the App Group as access group so the widget and
/// share extension can read the session; falls back to the default group where that entitlement is
/// missing (e.g. some simulator setups).
enum Keychain {
    private static func query(service: String, account: String, group: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if group { q[kSecAttrAccessGroup as String] = AppGroup.id }
        return q
    }

    static func read(service: String, account: String) -> String? {
        for group in [true, false] {
            var q = query(service: service, account: account, group: group)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: AnyObject?
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data {
                return String(data: data, encoding: .utf8)
            }
        }
        return nil
    }

    static func write(_ value: String, service: String, account: String) {
        delete(service: service, account: account)
        let data = Data(value.utf8)
        for group in [true, false] {
            var q = query(service: service, account: account, group: group)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            if SecItemAdd(q as CFDictionary, nil) == errSecSuccess { return }
        }
    }

    static func delete(service: String, account: String) {
        for group in [true, false] {
            SecItemDelete(query(service: service, account: account, group: group) as CFDictionary)
        }
    }
}
