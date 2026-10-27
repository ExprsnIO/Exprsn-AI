import Foundation
import SwiftData

/// First-launch provisioning from the environment or defaults (for managed installs and for driving the app from
/// a script): `EXPRSN_BOOTSTRAP_URL`, `EXPRSN_BOOTSTRAP_NAME`, `EXPRSN_BOOTSTRAP_TENANT`, `EXPRSN_BOOTSTRAP_USERNAME`
/// and, for key-based sign-in, `EXPRSN_BOOTSTRAP_API_KEY` (stored in the Keychain, never in the database).
/// A server with the same address is updated, not duplicated.
enum Bootstrap {
    /// A password given for the smoke run; used once by the sign-in screen, never stored.
    nonisolated(unsafe) static var password: String?
    /// An API key given for the smoke run, kept in memory so an ad-hoc signed build never prompts for the Keychain.
    nonisolated(unsafe) static var apiKey: String?
    static func run(context: ModelContext) -> ServerProfile? {
        let env = ProcessInfo.processInfo.environment
        func value(_ k: String) -> String? { env[k] ?? UserDefaults.standard.string(forKey: k) }
        guard let urlString = value("EXPRSN_BOOTSTRAP_URL"), let url = URL(string: urlString), url.host != nil else { return nil }
        let all = (try? context.fetch(FetchDescriptor<ServerProfile>())) ?? []
        let profile = all.first { $0.baseURL == urlString } ?? { let p = ServerProfile(name: value("EXPRSN_BOOTSTRAP_NAME") ?? url.host ?? "Exprsn-AI", baseURL: urlString); context.insert(p); return p }()
        if let t = value("EXPRSN_BOOTSTRAP_TENANT") { profile.tenant = t }
        if let u = value("EXPRSN_BOOTSTRAP_USERNAME") { profile.username = u }
        if value("EXPRSN_BOOTSTRAP_KIND") == "openai-compatible" { profile.kind = .openAICompatible }
        if let key = value("EXPRSN_BOOTSTRAP_API_KEY"), !key.isEmpty {
            profile.authMode = .apiKey
            if snapshotDirectory() != nil { apiKey = key } else { Keychain.set(key, for: profile.secretKey) }
        }
        if let pw = value("EXPRSN_BOOTSTRAP_PASSWORD"), !pw.isEmpty { profile.authMode = .session; password = pw }
        all.forEach { $0.isDefault = false }
        profile.isDefault = true
        try? context.save()
        return profile
    }
}
