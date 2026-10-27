import SwiftUI

/// Settings: the account's profile, preferences, password, API keys, sessions, factors, devices, notification
/// preferences, app passwords and the person's MCP access, as the console's Settings screen.
struct SettingsScreen: View {
    @Environment(AppSession.self) private var session
    @State private var tab = "account"

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $tab) {
                Text("Account").tag("account"); Text("API keys").tag("keys"); Text("Sessions").tag("sessions"); Text("Security").tag("security")
                Text("Devices").tag("devices"); Text("Notifications").tag("notifications"); Text("MCP access").tag("mcp"); Text("Inbox").tag("inbox"); Text("Jobs").tag("jobs")
            }.pickerStyle(.menu).labelsHidden().padding(12).frame(maxWidth: .infinity, alignment: .leading)
            Divider()
            switch tab {
            case "keys": APIKeysView()
            case "sessions": SessionsView()
            case "security": SecurityView()
            case "devices": DevicesView()
            case "notifications": NotificationPrefsView()
            case "mcp": MCPAccessView()
            case "inbox": InboxView()
            case "jobs": MyJobsView()
            default: AccountView()
            }
        }
    }
}

struct AccountView: View {
    @Environment(AppSession.self) private var session
    @State private var a11y = "system"
    @State private var current = ""
    @State private var newPassword = ""
    @State private var problem: APIProblem?
    @State private var done: String?
    @State private var profilePrefs: JSONValue = .null

    var body: some View {
        Form {
            if let me = session.me {
                Section("Who you are") {
                    KeyValueRow(key: "Name", value: me.user.displayName ?? me.user.username)
                    KeyValueRow(key: "Username", value: me.user.username)
                    KeyValueRow(key: "Email", value: (me.user.email ?? "") + (me.user.emailVerified == true ? " (verified)" : ""))
                    LabeledContent("Clearance") { LabelBadge(me.user.clearance, small: true) }
                    KeyValueRow(key: "Tenant", value: me.tenant?.name ?? "")
                    KeyValueRow(key: "Roles", value: me.roles.map(\.name).joined(separator: ", "))
                    KeyValueRow(key: "Credential", value: me.credential ?? "")
                    DisclosureGroup("Permissions (\(me.permissions.count))") { Text(me.permissions.joined(separator: "  ")).font(.exprsnMonoSmall).foregroundStyle(Exprsn.fg2) }
                }
                Section("Accessibility") {
                    Picker("Contrast", selection: $a11y) { Text("System").tag("system"); Text("AA").tag("aa"); Text("AAA (enhanced)").tag("aaa") }
                    Text("Stored with the account; it follows you to every device and the web console.").font(.caption).foregroundStyle(Exprsn.muted)
                }
                if session.me?.permissions.contains("chat:read") == true {
                    Section("Profile preferences") {
                        if profilePrefs.isNull { Text("Loading…").foregroundStyle(Exprsn.muted) } else { JSONTree(value: profilePrefs) }
                    }
                }
                Section("Password") {
                    SecureField("Current password", text: $current)
                    SecureField("New password", text: $newPassword)
                    Button("Change password") { Task { await session.changePassword(current: current, new: newPassword); current = ""; newPassword = "" } }.disabled(current.isEmpty || newPassword.count < 8)
                    Text("Every other session and OAuth grant ends. Directory accounts change their password in the directory.").font(.caption).foregroundStyle(Exprsn.muted)
                }
            }
            if let problem { Notice(.danger, problem.title, problem.detail) }
            if let done { Notice(.ok, done) }
        }
        .formStyle(.grouped)
        .onAppear { a11y = session.me?.preferences?.a11y ?? "system" }
        .onChange(of: a11y) { _, v in Task {
            guard v != (session.me?.preferences?.a11y ?? "system") else { return }
            do { _ = try await session.client?.patch("me/preferences", json(["a11y": .string(v)])); Exprsn.enhancedContrast = v != "system"; done = "Contrast mode saved." } catch { problem = error.asProblem }
        } }
        .task { profilePrefs = (try? await session.client?.get("me/profile-preferences")) ?? .object([:]) }
    }
}

struct APIKeysView: View {
    @Environment(AppSession.self) private var session
    @State private var keys: Loadable<[JSONValue]> = .idle
    @State private var creating = false
    @State private var name = ""
    @State private var scopes: Set<String> = []
    @State private var expiresDays = 90
    @State private var created: String?
    @State private var problem: APIProblem?

    var body: some View {
        VStack(spacing: 0) {
            if let created {
                Notice(.ok, "Key created. Copy it now; it is shown once.", created, actionLabel: "Copy") {
                    #if os(macOS)
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(created, forType: .string)
                    #else
                    UIPasteboard.general.string = created
                    #endif
                }.padding(12)
            }
            if let problem { Notice(.danger, problem.title, problem.detail).padding(12) }
            LoadableView(state: keys, retry: load) { list in
                List {
                    if list.isEmpty { Text("No API keys. Keys carry a subset of your permissions and are sent as `Authorization: Bearer exai_k1_…`.").foregroundStyle(Exprsn.muted) }
                    ForEach(Array(list.enumerated()), id: \.offset) { _, k in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack { Text(k["name"].text).font(.body.weight(.medium)); Pill(k["state"].text) }
                                Text("\(k["prefix"].text)… · \(k["scopes"].array.count) scopes · created \(Fmt.when(k["createdAt"]))\(k["lastUsedAt"].isNull ? "" : " · used \(Fmt.when(k["lastUsedAt"]))")").font(.caption).foregroundStyle(Exprsn.muted)
                                Text(k["scopes"].array.map(\.text).joined(separator: " ")).font(.exprsnMonoSmall).foregroundStyle(Exprsn.fg2).lineLimit(2)
                            }
                            Spacer()
                            Button("Revoke", role: .destructive) { Task { _ = try? await session.client?.delete("me/api-keys/\(k["id"].text)"); await load() } }.controlSize(.small)
                        }
                    }
                }
            }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { scopes = Set(session.me?.permissions ?? []); creating = true } label: { Label("New key", systemImage: "plus") } } }
        .sheet(isPresented: $creating) { createSheet }
        .task { await load() }
    }

    private var createSheet: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                Stepper("Expires in \(expiresDays) days", value: $expiresDays, in: 1...365)
                Section("Scopes (never wider than your roles)") {
                    HStack { Button("All mine") { scopes = Set(session.me?.permissions ?? []) }; Button("None") { scopes = [] }; Button("Chat only") { scopes = ["chat:read", "chat:write", "inference:invoke", "context:read"] } }.controlSize(.small)
                    ForEach((session.me?.permissions ?? []).sorted(), id: \.self) { p in
                        Toggle(p, isOn: Binding(get: { scopes.contains(p) }, set: { if $0 { scopes.insert(p) } else { scopes.remove(p) } })).font(.exprsnMonoSmall)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("New API key")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { creating = false } }
                ToolbarItem(placement: .confirmationAction) { Button("Create") { Task { await create() } }.disabled(name.isEmpty || scopes.isEmpty) }
            }
        }.frame(minWidth: 480, minHeight: 480)
    }

    private func load() async { keys = await loaded { (try await session.client?.get("me/api-keys"))?.array ?? [] } }
    private func create() async {
        problem = nil
        do {
            let r = try await session.client!.post("me/api-keys", json(["name": .string(name), "scopes": .array(scopes.sorted().map { .string($0) }), "expiresAt": .number(Date().addingTimeInterval(Double(expiresDays) * 86400).timeIntervalSince1970 * 1000)]))
            created = r["secret"].string ?? r["key"].string ?? r["token"].string
            creating = false; name = ""
            await load()
        } catch { problem = error.asProblem; session.note(error); creating = false }
    }
}

struct SessionsView: View {
    @Environment(AppSession.self) private var session
    @State private var rows: Loadable<[JSONValue]> = .idle
    var body: some View {
        LoadableView(state: rows, retry: load) { list in
            List {
                ForEach(Array(list.enumerated()), id: \.offset) { _, s in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack { Text(s["method"].text).font(.body.weight(.medium)); if s["current"].bool == true { Pill("this session", tone: .accent) }; Pill(s["stage"].text) }
                            Text("\(s["ip"].text) · \(s["userAgent"].text)").font(.caption).foregroundStyle(Exprsn.muted).lineLimit(1)
                            Text("Signed in \(Fmt.when(s["createdAt"])) · last seen \(Fmt.when(s["lastSeenAt"]))").font(.caption2).foregroundStyle(Exprsn.muted)
                        }
                        Spacer()
                        if s["current"].bool != true { Button("End", role: .destructive) { Task { _ = try? await session.client?.delete("me/sessions/\(s["id"].text)"); await load() } }.controlSize(.small) }
                    }
                }
                Section { Button("Sign out everywhere else", role: .destructive) { Task { _ = try? await session.client?.post("me/sessions/revoke-others"); await load() } } }
            }
        }
        .task { await load() }
    }
    private func load() async { rows = await loaded { (try await session.client?.get("me/sessions"))?.array ?? [] } }
}

struct SecurityView: View {
    @Environment(AppSession.self) private var session
    @State private var mfa: JSONValue = .null
    @State private var grants: [JSONValue] = []
    @State private var appPasswords: [JSONValue] = []
    @State private var enrolling: JSONValue?
    @State private var code = ""
    @State private var label = "Authenticator"
    @State private var newAppPassword: String?
    @State private var problem: APIProblem?
    @State private var recoveryCodes: [String]?

    var body: some View {
        Form {
            Section("Second factors") {
                ForEach(mfa["factors"].array, id: \.self) { f in
                    HStack { Text(f["label"].string ?? f["kind"].text); Pill(f["kind"].text, tone: .info); Spacer(); Text(Fmt.when(f["lastUsedAt"])).font(.caption).foregroundStyle(Exprsn.muted)
                        Button("Remove", role: .destructive) { Task { await run { _ = try await session.client?.delete("me/mfa/\(f["id"].text)") } } }.controlSize(.small) }
                }
                KeyValueRow(key: "Recovery codes left", value: mfa["recoveryCodesRemaining"].text)
                HStack {
                    TextField("Label", text: $label).frame(maxWidth: 160)
                    Button("Add authenticator") { Task { await run { enrolling = try await session.client?.post("me/mfa/totp", json(["label": .string(label)])) } } }
                    Button("New recovery codes") { Task { await run { recoveryCodes = (try await session.client?.post("me/mfa/recovery-codes"))?["codes"].array.map(\.text) } } }
                }
                if let e = enrolling {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Add this secret to your authenticator, then confirm with a code:").font(.caption)
                        Text(e["secret"].string ?? e["uri"].text).font(.exprsnMonoSmall).textSelection(.enabled)
                        HStack { TextField("Code", text: $code); Button("Confirm") { Task { await run { _ = try await session.client?.post("me/mfa/totp/\(e["id"].text)/confirm", json(["code": .string(code)])); enrolling = nil; code = "" } } } }
                    }
                }
                if let codes = recoveryCodes { Text(codes.joined(separator: "   ")).font(.exprsnMonoSmall).textSelection(.enabled); Text("Shown once. Keep them somewhere safe.").font(.caption).foregroundStyle(Exprsn.warnFg) }
            }
            Section("App passwords (CalDAV, CardDAV, WebDAV)") {
                ForEach(appPasswords, id: \.self) { p in
                    HStack { Text(p["name"].text); Spacer(); Text(Fmt.when(p["lastUsedAt"])).font(.caption).foregroundStyle(Exprsn.muted); Button("Revoke", role: .destructive) { Task { await run { _ = try await session.client?.delete("me/app-passwords/\(p["id"].text)") } } }.controlSize(.small) }
                }
                Button("New app password") { Task { await run { newAppPassword = (try await session.client?.post("me/app-passwords", json(["name": .string("Exprsn-AI for Apple")])))?["password"].string } } }
                if let p = newAppPassword { Text(p).font(.exprsnMonoSmall).textSelection(.enabled); Text("Shown once.").font(.caption).foregroundStyle(Exprsn.warnFg) }
            }
            Section("OAuth grants") {
                if grants.isEmpty { Text("No applications hold a grant.").foregroundStyle(Exprsn.muted) }
                ForEach(grants, id: \.self) { g in HStack { Text(g["clientName"].string ?? g["clientId"].text); Spacer(); Button("Revoke", role: .destructive) { Task { await run { _ = try await session.client?.delete("me/grants/\(g["clientId"].text)") } } }.controlSize(.small) } }
            }
            if let problem { Notice(.danger, problem.title, problem.detail) }
        }
        .formStyle(.grouped)
        .task { await load() }
    }

    private func load() async {
        mfa = (try? await session.client?.get("me/mfa")) ?? .null
        grants = (try? await session.client?.get("me/grants"))?.array ?? []
        let ap = try? await session.client?.get("me/app-passwords")
        appPasswords = ap?.rows(itemsKey: "passwords") ?? []
    }
    private func run(_ work: () async throws -> Void) async {
        problem = nil
        do { try await work(); await load() } catch { problem = error.asProblem; session.note(error) }
    }
}

struct DevicesView: View {
    @Environment(AppSession.self) private var session
    @State private var rows: Loadable<[JSONValue]> = .idle
    var body: some View {
        LoadableView(state: rows, retry: load) { list in
            List {
                if list.isEmpty { Text("No push devices registered.").foregroundStyle(Exprsn.muted) }
                ForEach(Array(list.enumerated()), id: \.offset) { _, d in
                    HStack {
                        VStack(alignment: .leading) {
                            HStack { Text(d["name"].string ?? d["platform"].text).font(.body.weight(.medium)); Pill(d["state"].text); if d["current"].bool == true { Pill("this app", tone: .accent) } }
                            Text("\(d["platform"].text) · \(d["provider"].text) · \(d["fingerprint"].text) · seen \(Fmt.when(d["lastSeenAt"]))").font(.caption).foregroundStyle(Exprsn.muted)
                        }
                        Spacer()
                        Button("Revoke", role: .destructive) { Task { _ = try? await session.client?.delete("me/devices/\(d["id"].text)"); await load() } }.controlSize(.small)
                    }
                }
                Section { Text("This app registers for push when the install has an APNs provider; until then notifications arrive in the Inbox tab.").font(.caption).foregroundStyle(Exprsn.muted) }
            }
        }
        .task { await load() }
    }
    private func load() async { rows = await loaded { (try await session.client?.get("me/devices"))?["devices"].array ?? [] } }
}

struct NotificationPrefsView: View {
    @Environment(AppSession.self) private var session
    @State private var prefs: Loadable<JSONValue> = .idle
    @State private var changes: [String: [String: Bool]] = [:]
    @State private var problem: APIProblem?

    var body: some View {
        LoadableView(state: prefs, retry: load) { p in
            Form {
                Section("Quiet hours and digests") {
                    KeyValueRow(key: "Time zone", value: p["timeZone"].text)
                    KeyValueRow(key: "Digest hour", value: p["digestHour"].text)
                    KeyValueRow(key: "Urgent passes quiet hours", value: p["urgentPassesQuiet"].text)
                }
                let channels = p["channels"].array.map(\.text)
                ForEach(p["kinds"].array, id: \.self) { k in
                    Section {
                        ForEach(channels, id: \.self) { ch in
                            let cur = changes[k["id"].text]?[ch] ?? (k["channels"][ch]["enabled"].bool ?? false)
                            Toggle(ch.replacingOccurrences(of: "_", with: " ").capitalized, isOn: Binding(get: { cur }, set: { changes[k["id"].text, default: [:]][ch] = $0 }))
                                .disabled(k["mandatory"].bool == true || !k["lockedBy"].isNull)
                        }
                    } header: { HStack { Text(k["title"].text); if k["mandatory"].bool == true { Pill("mandatory", tone: .info) }; if let l = k["lockedBy"].string { Pill("locked by \(l)", tone: .warn) } } } footer: { Text(k["description"].text) }
                }
                Section {
                    Button("Save") { Task { await save() } }.disabled(changes.isEmpty)
                    Button("Back to the tenant defaults", role: .destructive) { Task { _ = try? await session.client?.delete("me/notification-preferences"); changes = [:]; await load() } }
                }
                if let problem { Notice(.danger, problem.title, problem.detail) }
            }.formStyle(.grouped)
        }
        .task { await load() }
    }
    private func load() async { prefs = await loaded { try await session.client!.get("me/notification-preferences") } }
    private func save() async {
        var kinds: [String: JSONValue] = [:]
        for (kind, chans) in changes { kinds[kind] = .object(chans.mapValues { .object(["enabled": .bool($0), "timing": "instant"]) }) }
        do { _ = try await session.client?.put("me/notification-preferences", json(["kinds": .object(kinds)])); changes = [:]; await load() } catch { problem = error.asProblem }
    }
}

/// The person's MCP access: the workspace servers they may use and their held calls; the per-user vault of
/// tokens for MCP servers the tenant registered with `auth: user`.
struct MCPAccessView: View {
    @Environment(AppSession.self) private var session
    @State private var access: JSONValue = .null
    @State private var holds: [JSONValue] = []
    @State private var userServers: [JSONValue] = []
    @State private var tokenFor: JSONValue?
    @State private var token = ""
    @State private var problem: APIProblem?

    var body: some View {
        Form {
            Section("Your MCP servers") {
                if access["servers"].array.isEmpty { Text("No workspace of yours publishes an MCP server.").foregroundStyle(Exprsn.muted) }
                ForEach(access["servers"].array, id: \.self) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack { Text(s["workspace"].text).font(.body.weight(.medium)); LabelBadge(s["label"].string, small: true); if s["requireDpop"].bool == true { Pill("DPoP", tone: .info) } }
                        Text(s["url"].text).font(.exprsnMonoSmall).textSelection(.enabled)
                        Text("Groups: \(s["groups"].text)").font(.caption).foregroundStyle(Exprsn.muted)
                    }
                }
                Text("Connect an MCP client (or the MCP connections screen of this app) to the address with an API key holding tools:invoke, or through OAuth.").font(.caption).foregroundStyle(Exprsn.muted)
            }
            Section("Held calls") {
                if holds.isEmpty { Text("Nothing waits for your decision.").foregroundStyle(Exprsn.muted) }
                ForEach(holds, id: \.self) { h in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack { Text(h["tool"].text).font(.body.weight(.medium)); Pill(h["sideEffect"].text); Pill(h["state"].text); Spacer(); Text(Fmt.when(h["createdAt"])).font(.caption).foregroundStyle(Exprsn.muted) }
                        Text("\(h["client"].text) in \(h["workspace"].text): \(h["reason"].text)").font(.caption).foregroundStyle(Exprsn.fg2)
                        Text(h["arguments"].prettyPrinted).font(.exprsnMonoSmall).lineLimit(6)
                        if h["state"].string == "pending" {
                            HStack { Button("Approve") { Task { await decide(h, "approve") } }; Button("Reject", role: .destructive) { Task { await decide(h, "reject") } } }.controlSize(.small)
                        }
                    }
                }
            }
            Section("Tokens for per-user MCP servers") {
                if userServers.isEmpty { Text("No registered MCP server asks for a token of your own.").foregroundStyle(Exprsn.muted) }
                ForEach(userServers, id: \.self) { s in
                    HStack {
                        VStack(alignment: .leading) { Text(s["name"].text); Text(s["connected"].bool == true ? "Connected\(s["expired"].bool == true ? " (expired)" : "")" : "No token").font(.caption).foregroundStyle(Exprsn.muted) }
                        Spacer()
                        Button("Set token…") { tokenFor = s }.controlSize(.small)
                        if s["connected"].bool == true { Button("Remove", role: .destructive) { Task { _ = try? await session.client?.delete("mcp/servers/\(s["id"].text)/token"); await load() } }.controlSize(.small) }
                    }
                }
            }
            if let problem { Notice(.danger, problem.title, problem.detail) }
        }
        .formStyle(.grouped)
        .sheet(item: Binding(get: { tokenFor.map { IdentifiedJSON($0) } }, set: { tokenFor = $0?.value })) { s in
            NavigationStack {
                Form { SecureField("Token", text: $token) }
                    .navigationTitle("Token for \(s.value["name"].text)")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { tokenFor = nil } }
                        ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { _ = try? await session.client?.put("mcp/servers/\(s.value["id"].text)/token", json(["token": .string(token)])); token = ""; tokenFor = nil; await load() } } }
                    }
            }.frame(minWidth: 400, minHeight: 160)
        }
        .task { await load() }
    }
    private func load() async {
        access = (try? await session.client?.get("me/mcp-server")) ?? .null
        holds = (try? await session.client?.get("me/mcp-holds", query: ["state": "all"]))?["holds"].array ?? []
        userServers = (try? await session.client?.get("mcp/servers"))?.rows(itemsKey: "servers") ?? []
    }
    private func decide(_ h: JSONValue, _ decision: String) async {
        do { _ = try await session.client?.post("me/mcp-holds/\(h["id"].text)/decide", json(["decision": .string(decision)])); await load() } catch { problem = error.asProblem }
    }
}

struct IdentifiedJSON: Identifiable { var value: JSONValue; var id: String { value.rowId }; init(_ v: JSONValue) { value = v } }

struct InboxView: View {
    @Environment(AppSession.self) private var session
    @State private var items: Loadable<[JSONValue]> = .idle
    var body: some View {
        LoadableView(state: items, retry: load) { list in
            List {
                if list.isEmpty { Text("No notifications.").foregroundStyle(Exprsn.muted) }
                ForEach(Array(list.enumerated()), id: \.offset) { _, n in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack { if n["read"].bool != true { Circle().fill(Exprsn.accent).frame(width: 7, height: 7) }; Text(n["title"].text).font(.body.weight(n["read"].bool == true ? .regular : .semibold)); Spacer(); Pill(n["kind"].text, tone: .info); Text(Fmt.when(n["createdAt"])).font(.caption).foregroundStyle(Exprsn.muted) }
                        if let b = n["body"].string { Text(b).font(.callout).foregroundStyle(Exprsn.fg2) }
                        if let r = n["route"].string, let s = Screen(rawValue: r) { Button("Open \(s.title)") { NotificationCenter.default.post(name: .navigate, object: s) }.buttonStyle(.borderless).font(.caption) }
                    }
                }
            }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Mark all read") { Task { _ = try? await session.client?.post("me/notifications/read", json([:])); await load() } } } }
        .task { await load() }
    }
    private func load() async { items = await loaded { (try await session.client?.get("me/notifications"))?["items"].array ?? [] } }
}

struct MyJobsView: View {
    @Environment(AppSession.self) private var session
    @State private var items: Loadable<[JSONValue]> = .idle
    var body: some View {
        LoadableView(state: items, retry: load) { list in
            List {
                if list.isEmpty { Text("No jobs started by you.").foregroundStyle(Exprsn.muted) }
                ForEach(Array(list.enumerated()), id: \.offset) { _, j in
                    HStack {
                        VStack(alignment: .leading) {
                            HStack { Text(j["type"].text).font(.body.weight(.medium)); Pill(j["state"].text) }
                            if let m = j["message"].string { Text(m).font(.caption).foregroundStyle(Exprsn.fg2) }
                            if let e = j["error"].string { Text(e).font(.caption).foregroundStyle(Exprsn.dangerFg) }
                            if let p = j["progress"].double, j["state"].string == "running" { ProgressView(value: p, total: 1).controlSize(.small) }
                        }
                        Spacer()
                        Text(Fmt.when(j["createdAt"])).font(.caption).foregroundStyle(Exprsn.muted)
                        if ["queued", "running"].contains(j["state"].string ?? "") { Button("Cancel", role: .destructive) { Task { _ = try? await session.client?.post("me/jobs/\(j["id"].text)/cancel"); await load() } }.controlSize(.small) }
                    }
                }
            }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") } } }
        .task { await load() }
    }
    private func load() async { items = await loaded { (try await session.client?.get("me/jobs"))?.rows(itemsKey: "items") ?? [] } }
}
