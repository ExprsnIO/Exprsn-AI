import Foundation
import SwiftData
import Observation

/// What `GET /api/me` says about the signed-in person.
struct Me: Decodable, Sendable {
    struct User: Decodable, Sendable { var id: String; var username: String; var displayName: String?; var clearance: String?; var email: String?; var emailVerified: Bool? }
    struct Role: Decodable, Sendable { var id: String; var name: String }
    struct Tenant: Decodable, Sendable { var id: String; var slug: String; var name: String }
    struct Workspace: Decodable, Sendable, Identifiable, Hashable { var id: String; var name: String; var label: String? }
    struct MFA: Decodable, Sendable { var verified: Bool?; var methods: [String]?; var recoveryCodesRemaining: Int? }
    struct Preferences: Decodable, Sendable { var a11y: String? }
    struct StepUp: Decodable, Sendable { var windowSeconds: Int?; var authAt: Double?; var methods: [String]? }

    var user: User
    var roles: [Role]
    var permissions: [String]
    var tenant: Tenant?
    var workspaces: [Me.Workspace]
    var workspace: String?
    var credential: String?
    var mfa: MFA?
    var preferences: Preferences?
    var stepUp: StepUp?
}

/// The answer of `POST /api/auth/login`, the second-factor routes and `GET /api/auth/session`.
struct SessionInfo: Decodable, Sendable {
    struct MFAInfo: Decodable, Sendable { var methods: [String]?; var trustedDeviceDays: Int?; var enrolBy: Double? }
    struct User: Decodable, Sendable { var id: String; var username: String; var displayName: String? }
    var authenticated: Bool
    var stage: String?
    var csrf: String?
    var mfa: MFAInfo?
    var user: User?
    var expiresAt: Double?
}

/// The app's one session: which server is current, who is signed in, what they may do.
@MainActor
@Observable
final class AppSession {
    enum State: Equatable {
        case noServer
        case signedOut
        case mfa(methods: [String], trustedDeviceDays: Int)
        case enroll
        case passwordChange
        case signedIn
    }

    private(set) var server: ServerProfile?
    private(set) var client: APIClient?
    private(set) var state: State = .noServer
    private(set) var me: Me?
    var sessionInfo: SessionInfo?
    var lastProblem: APIProblem?
    var busy = false
    /// Raised when a route answered `401 Step-up required`; Settings asks for the password or a code.
    var stepUpNeeded = false
    var notificationsUnread = 0

    var permissions: Set<String> { Set(me?.permissions ?? []) }
    var isSystemAdmin: Bool { me?.roles.contains { $0.id == "system-admin" } ?? false }
    var currentWorkspace: Me.Workspace? { me?.workspaces.first { $0.id == me?.workspace } }
    var isExprsn: Bool { server?.kind == .exprsn }

    func has(_ permission: String) -> Bool { permissions.contains(permission) }
    func has(any list: [String]) -> Bool { list.isEmpty || list.contains { permissions.contains($0) } }
    func has(all list: [String]) -> Bool { list.allSatisfy { permissions.contains($0) } }

    // MARK: Choosing a server

    /// Switches to a server, restoring its stored session or API key.
    func use(_ profile: ServerProfile) async {
        guard let url = profile.url else { state = .noServer; return }
        server = profile
        let c = APIClient(baseURL: url)
        c.workspaceId = profile.workspaceId
        c.dataLabel = profile.dataLabel
        client = c
        me = nil
        sessionInfo = nil
        lastProblem = nil
        if profile.kind == .openAICompatible {
            if let key = Bootstrap.apiKey ?? Keychain.get(profile.secretKey) { c.credential = .bearer(key); state = .signedIn } else { state = .signedOut }
            return
        }
        switch profile.authMode {
        case .apiKey:
            if let key = Bootstrap.apiKey ?? Keychain.get(profile.secretKey) {
                c.credential = .apiKey(key)
                await refreshMe()
            } else { state = .signedOut }
        case .session:
            if let raw = Keychain.get(profile.cookieKey), let data = raw.data(using: .utf8), let pairs = try? JSONDecoder().decode([[String: String]].self, from: data) {
                c.restoreCookies(pairs)
                if let csrf = Keychain.get(profile.csrfKey) { c.credential = .session(csrf: csrf) }
                await resumeSession()
            } else if let pw = Bootstrap.password, let user = profile.username {
                Bootstrap.password = nil
                state = .signedOut
                await signIn(username: user, password: pw, tenant: profile.tenant)
            } else { state = .signedOut }
        }
    }

    func clearServer() {
        server = nil; client = nil; me = nil; sessionInfo = nil; state = .noServer
    }

    // MARK: Sign-in

    private func apply(_ info: SessionInfo) async {
        sessionInfo = info
        if let csrf = info.csrf { client?.credential = .session(csrf: csrf) }
        persistSession()
        switch info.stage {
        case "active":
            await refreshMe()
        case "mfa": state = .mfa(methods: info.mfa?.methods ?? [], trustedDeviceDays: info.mfa?.trustedDeviceDays ?? 0)
        case "enroll": state = .enroll
        case "password": state = .passwordChange
        default: state = .signedOut
        }
    }

    func signIn(username: String, password: String, tenant: String?) async {
        guard let client else { return }
        busy = true; defer { busy = false }
        lastProblem = nil
        do {
            let info: SessionInfo = try await client.decode(.post, "auth/login", body: json(["username": .string(username), "password": .string(password), "tenant": tenant.flatMap { $0.isEmpty ? nil : .string($0) }]))
            server?.username = username
            await apply(info)
        } catch { lastProblem = error.asProblem }
    }

    func completeMFA(method: String, code: String, rememberDevice: Bool) async {
        guard let client else { return }
        busy = true; defer { busy = false }
        lastProblem = nil
        let path = method == "recovery" ? "auth/mfa/recovery" : method == "email" ? "auth/mfa/email" : "auth/mfa/totp"
        do {
            let info: SessionInfo = try await client.decode(.post, path, body: json(["code": .string(code), "rememberDevice": .bool(rememberDevice)]))
            await apply(info)
        } catch { lastProblem = error.asProblem }
    }

    func sendEmailCode() async {
        guard let client else { return }
        do { _ = try await client.post("auth/mfa/email/send") } catch { lastProblem = error.asProblem }
    }

    func useAPIKey(_ key: String) async {
        guard let client, let server else { return }
        busy = true; defer { busy = false }
        lastProblem = nil
        client.credential = server.kind == .exprsn ? .apiKey(key) : .bearer(key)
        if server.kind == .openAICompatible {
            do { _ = try await client.get("/v1/models"); Keychain.set(key, for: server.secretKey); state = .signedIn }
            catch { lastProblem = error.asProblem; client.credential = .none }
            return
        }
        await refreshMe()
        if state == .signedIn { Keychain.set(key, for: server.secretKey) } else { client.credential = .none }
    }

    func resumeSession() async {
        guard let client else { return }
        do {
            let info: SessionInfo = try await client.decode(.get, "auth/session")
            if info.authenticated || info.stage != nil { await apply(info) } else { state = .signedOut }
        } catch { lastProblem = error.asProblem; state = .signedOut }
    }

    func refreshMe() async {
        guard let client else { return }
        do {
            let m: Me = try await client.decode(.get, "me")
            me = m
            debugLog("signed in as \(m.user.username) with \(m.permissions.count) permissions")
            Exprsn.enhancedContrast = (m.preferences?.a11y ?? "system") != "system"
            if client.workspaceId == nil, let ws = m.workspace { client.workspaceId = ws }
            state = .signedIn
            server?.lastSignInAt = Date()
        } catch {
            let p = error.asProblem
            lastProblem = p
            debugLog("refreshMe failed: \(p.title) \(p.detail ?? "")")
            if p.status == 401 { state = p.stage == "password" ? .passwordChange : p.stage == "mfa" ? .mfa(methods: [], trustedDeviceDays: 0) : .signedOut }
            else { state = .signedOut }
        }
    }

    func changePassword(current: String, new: String) async {
        guard let client else { return }
        busy = true; defer { busy = false }
        do {
            let r = try await client.post("me/password", json(["currentPassword": .string(current), "newPassword": .string(new)]))
            if let csrf = r["csrf"].string { client.credential = .session(csrf: csrf) }
            persistSession()
            await refreshMe()
        } catch { lastProblem = error.asProblem }
    }

    func switchWorkspace(_ id: String) async {
        guard let client else { return }
        do {
            if case .session = client.credential { _ = try await client.put("me/workspace", json(["workspaceId": .string(id)])) }
            client.workspaceId = id
            server?.workspaceId = id
            await refreshMe()
        } catch { lastProblem = error.asProblem }
    }

    func signOut() async {
        if let client, case .session = client.credential { _ = try? await client.post("auth/logout") }
        forgetCredentials()
        me = nil; sessionInfo = nil; state = .signedOut
        client?.credential = .none
        client?.clearCookies()
    }

    func forgetCredentials() {
        guard let server else { return }
        Keychain.remove(server.cookieKey); Keychain.remove(server.csrfKey); Keychain.remove(server.secretKey)
    }

    private func persistSession() {
        guard let client, let server else { return }
        let pairs = client.cookies
        if let data = try? JSONEncoder().encode(pairs), let s = String(data: data, encoding: .utf8) { Keychain.set(s, for: server.cookieKey) }
        if case .session(let csrf) = client.credential { Keychain.set(csrf, for: server.csrfKey) }
    }

    /// Routes call this with any error so a `401 Step-up required` is noticed once.
    func note(_ error: Error) {
        let p = error.asProblem
        if p.stepUpRequired { stepUpNeeded = true }
        lastProblem = p
    }

    func stepUp(password: String?, code: String?) async -> Bool {
        guard let client else { return false }
        do {
            _ = try await client.post("me/step-up", json(["password": password.map { .string($0) }, "code": code.map { .string($0) }]))
            stepUpNeeded = false
            return true
        } catch { lastProblem = error.asProblem; return false }
    }
}


/// Diagnostics to standard error, only when the smoke harness or `EXPRSN_DEBUG` asks.
func debugLog(_ text: String) {
    let env = ProcessInfo.processInfo.environment
    guard env["EXPRSN_SNAPSHOT_DIR"] != nil || env["EXPRSN_DEBUG"] != nil else { return }
    let line = "[exprsn] " + text + "\n"
    FileHandle.standardError.write(Data(line.utf8))
    if let dir = snapshotDirectory() {
        if let h = FileHandle(forWritingAtPath: dir + "/log.txt") { h.seekToEndOfFile(); h.write(Data(line.utf8)); h.closeFile() }
        else { try? line.write(toFile: dir + "/log.txt", atomically: true, encoding: .utf8) }
    }
}

/// Where the smoke run writes: `EXPRSN_SNAPSHOT_DIR` when writable, else the app's Documents (inside its sandbox).
func snapshotDirectory() -> String? {
    guard let asked = ProcessInfo.processInfo.environment["EXPRSN_SNAPSHOT_DIR"] else { return nil }
    for dir in [asked, NSHomeDirectory() + "/Documents/snapshots"] {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if FileManager.default.isWritableFile(atPath: dir) { return dir }
    }
    return nil
}
