import SwiftUI

/// Users: list, detail, roles and clearance, state, factor reset, password reset, sessions.
struct UsersScreen: View {
    @Environment(AppSession.self) private var session
    @State private var users: Loadable<[JSONValue]> = .idle
    @State private var roles: [JSONValue] = []
    @State private var query = ""
    @State private var selected: String?
    @State private var creating = false

    var body: some View {
        LoadableView(state: users, retry: load) { list in
            HStack(spacing: 0) {
                List(list, id: \.self, selection: Binding(get: { selected.flatMap { s in list.first { $0["id"].text == s } } }, set: { selected = $0?["id"].text })) { u in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack { Text(u["displayName"].string ?? u["username"].text).font(.body.weight(.medium)); Pill(u["state"].text); Spacer(); LabelBadge(u["clearance"].string, small: true) }
                        Text("\(u["username"].text)\(u["email"].string.map { " · \($0)" } ?? "") · \(u["roles"].array.map(\.text).joined(separator: ", "))").font(.caption).foregroundStyle(Exprsn.muted).lineLimit(1)
                    }
                }.listStyle(.plain).frame(minWidth: 320, idealWidth: 400)
                Divider()
                if let id = selected { UserDetail(id: id, roles: roles, reload: load) } else { EmptyState(title: "Choose a person", text: "Roles, clearance, factors, sessions and password resets.", systemImage: "person.crop.circle") }
            }
        }
        .searchable(text: $query, prompt: "Username, name or email")
        .onSubmit(of: .search) { Task { await load() } }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { creating = true } label: { Label("New local user", systemImage: "person.badge.plus") }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
        }
        .sheet(isPresented: $creating) {
            FormSheet(title: "New local user", fields: [FormField("username", "Username", required: true), FormField("displayName", "Display name"), FormField("email", "Email"), FormField("password", "Initial password (or invite by email)", .secure), FormField("invite", "Send an invitation link instead", .bool), FormField("roles", "Roles (JSON array of role ids)", .json, defaultValue: "[\"member\"]"), FormField("clearance", "Clearance", .label, defaultValue: "internal")]) { body in
                _ = try await session.client!.post("admin/users", body); await load()
            }
        }
        .task { await load(); roles = (try? await session.client?.get("admin/roles"))?.array ?? [] }
    }
    private func load() async { users = await loaded { (try await session.client!.get("admin/users", query: ["q": query.isEmpty ? nil : query, "limit": "500"])).rows(itemsKey: nil) } }
}

struct UserDetail: View {
    @Environment(AppSession.self) private var session
    var id: String
    var roles: [JSONValue]
    var reload: () async -> Void
    @State private var user: Loadable<JSONValue> = .idle
    @State private var chosenRoles: Set<String> = []
    @State private var clearance = "internal"
    @State private var problem: APIProblem?
    @State private var done: String?
    @State private var tempPassword = ""
    @State private var devices: [JSONValue] = []

    var body: some View {
        LoadableView(state: user, retry: load) { u in
            Form {
                Section {
                    HStack { Text(u["displayName"].string ?? u["username"].text).font(.title3.weight(.semibold)); Pill(u["state"].text); Spacer(); if u["mfaRequired"].bool == true { Pill("MFA required", tone: .info) } }
                    KeyValueRow(key: "Username", value: u["username"].text)
                    KeyValueRow(key: "Email", value: u["email"].text)
                    KeyValueRow(key: "Last sign-in", value: Fmt.when(u["lastLoginAt"]))
                    KeyValueRow(key: "Created", value: Fmt.when(u["createdAt"]))
                    if let r = u["disabledReason"].string { KeyValueRow(key: "Disabled because", value: r) }
                }
                Section("Access") {
                    ForEach(roles, id: \.self) { r in
                        Toggle(isOn: Binding(get: { chosenRoles.contains(r["id"].text) }, set: { if $0 { chosenRoles.insert(r["id"].text) } else { chosenRoles.remove(r["id"].text) } })) {
                            VStack(alignment: .leading) { Text(r["name"].text); Text(r["description"].text).font(.caption).foregroundStyle(Exprsn.muted) }
                        }
                    }
                    Picker("Clearance", selection: $clearance) { ForEach(DataLabel.allCases) { Text($0.title).tag($0.rawValue) } }
                    Button("Save access") { Task { await patch(json(["roles": .array(chosenRoles.sorted().map { .string($0) }), "clearance": .string(clearance)])) } }
                    Text("Mapped roles come from directory groups and are recomputed at sign-in; direct grants are saved here. Saving ends the person's sessions.").font(.caption).foregroundStyle(Exprsn.muted)
                }
                Section("State") {
                    HStack {
                        if u["state"].string == "active" { Button("Disable", role: .destructive) { Task { await patch(json(["state": "disabled"])) } } } else { Button("Enable") { Task { await patch(json(["state": "active"])) } } }
                        Button("Reset second factors") { Task { await post("admin/users/\(id)/reset-mfa", nil) } }
                        Button("End sessions") { Task { for s in u["sessions"].array { _ = try? await session.client?.delete("admin/sessions/\(s["id"].text)") }; await load() } }
                    }.controlSize(.small)
                }
                Section("Password") {
                    HStack { SecureField("Temporary password", text: $tempPassword); Button("Set") { Task { await post("admin/users/\(id)/password", json(["mode": "temporary", "password": .string(tempPassword)])); tempPassword = "" } }.disabled(tempPassword.count < 8) }
                    Button("Email a reset link") { Task { await post("admin/users/\(id)/password", json(["mode": "link"])) } }
                    KeyValueRow(key: "Local password", value: u["password"]["local"].bool == true ? (u["password"]["mustChange"].bool == true ? "set, must change" : "set") : "managed by the directory")
                }
                Section("Identities, factors and sessions") {
                    ForEach(u["identities"].array, id: \.self) { i in KeyValueRow(key: i["provider"].text, value: i["externalId"].text, mono: true) }
                    ForEach(u["factors"].array, id: \.self) { f in KeyValueRow(key: f["kind"].text, value: "\(f["label"].text) · used \(Fmt.when(f["lastUsedAt"]))") }
                    ForEach(u["sessions"].array, id: \.self) { s in KeyValueRow(key: s["method"].text, value: "\(s["ip"].text) · \(Fmt.when(s["lastSeenAt"]))") }
                    ForEach(devices, id: \.self) { d in HStack { Text("\(d["platform"].text) \(d["name"].text)"); Pill(d["state"].text); Spacer(); Button("Revoke") { Task { _ = try? await session.client?.delete("admin/users/\(id)/devices/\(d["id"].text)"); await load() } }.controlSize(.small) } }
                }
                if !u["attributes"].object.isEmpty { Section("Attributes") { JSONTree(value: u["attributes"]) } }
                if let problem { Notice(.danger, problem.title, problem.detail) }
                if let done { Notice(.ok, done) }
            }.formStyle(.grouped)
        }
        .task(id: id) { await load() }
    }
    private func load() async {
        user = await loaded { try await session.client!.get("admin/users/\(id)") }
        if let u = user.value { chosenRoles = Set(u["roles"].array.map { $0["id"].string ?? $0.text }); clearance = u["clearance"].string ?? "internal" }
        devices = (try? await session.client?.get("admin/users/\(id)/devices"))?.rows(itemsKey: "devices") ?? []
    }
    private func patch(_ body: JSONValue) async {
        problem = nil; done = nil
        do { _ = try await session.client!.patch("admin/users/\(id)", body); done = "Saved."; await load(); await reload() } catch { problem = error.asProblem }
    }
    private func post(_ path: String, _ body: JSONValue?) async {
        problem = nil; done = nil
        do { let r = try await session.client!.post(path, body); done = r.isNull ? "Done." : r.text; await load() } catch { problem = error.asProblem }
    }
}

/// Tenants: the tenant, its workspaces, members, quotas, retention, webhooks, templates.
struct TenantsScreen: View {
    @Environment(AppSession.self) private var session
    @State private var tenants: Loadable<[JSONValue]> = .idle
    @State private var selected: String?

    var body: some View {
        LoadableView(state: tenants, retry: load) { list in
            HStack(spacing: 0) {
                List(list, id: \.self, selection: Binding(get: { selected.flatMap { s in list.first { $0["id"].text == s } } }, set: { selected = $0?["id"].text })) { t in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack { Text(t["name"].text).font(.body.weight(.medium)); Pill(t["state"].text) }
                        Text("\(t["slug"].text) · \(t["users"].text) users · \(t["workspaces"].array.count) workspaces · key \(t["key"]["state"].text)").font(.caption).foregroundStyle(Exprsn.muted)
                    }
                }.listStyle(.plain).frame(minWidth: 280, idealWidth: 340)
                Divider()
                if let id = selected, let t = list.first(where: { $0["id"].text == id }) { TenantDetail(tenant: t, reload: load) } else { EmptyState(title: "Choose a tenant", systemImage: "building.2") }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if session.isSystemAdmin { NavigationLink { FormSheet(title: "New tenant", fields: [FormField("slug", "Slug", required: true), FormField("name", "Name", required: true), FormField("directoryDn", "Directory DN")]) { body in _ = try await session.client!.post("admin/tenants", body); await load() } } label: { Label("New tenant", systemImage: "plus") } }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
        }
        .task { await load() }
    }
    private func load() async { tenants = await loaded { (try await session.client!.get("admin/tenants")).rows(itemsKey: nil) } }
}

struct TenantDetail: View {
    @Environment(AppSession.self) private var session
    var tenant: JSONValue
    var reload: () async -> Void
    @State private var tab = "workspaces"
    private var tid: String { tenant["id"].text }

    var body: some View {
        VStack(spacing: 0) {
            HStack { Text(tenant["name"].text).font(.title2.weight(.semibold)); Pill(tenant["state"].text); Spacer(); Text("Key \(tenant["key"]["name"].text) v\(tenant["key"]["version"].text) (\(tenant["key"]["kms"].text))").font(.caption).foregroundStyle(Exprsn.muted) }.padding(12)
            Picker("", selection: $tab) { Text("Workspaces").tag("workspaces"); Text("Quota").tag("quota"); Text("Retention").tag("retention"); Text("Webhooks").tag("webhooks"); Text("Templates").tag("templates"); Text("File quota").tag("files") }.pickerStyle(.segmented).padding(.horizontal, 12)
            switch tab {
            case "quota": ResourceScreen(spec: ResourceSpec(title: "Quota", tabs: [ResourceTab(title: "Quota", path: "admin/tenants/\(tid)/quota", single: true), ResourceTab(title: "All quotas", path: "admin/quotas", single: true)]))
            case "retention": ResourceScreen(spec: ResourceSpec(title: "Retention", tabs: [ResourceTab(title: "Conversations", path: "admin/tenants/\(tid)/retention", single: true, note: "Set with PUT {conversationDays}; run now with POST …/retention/run.")]))
            case "webhooks": ResourceScreen(spec: AdminCatalog.spec(for: .plugins).tabs.first { $0.title == "Webhooks" }.map { ResourceSpec(title: "Webhooks", tabs: [$0]) } ?? ResourceSpec(title: "Webhooks", tabs: []))
            case "templates": ResourceScreen(spec: ResourceSpec(title: "Templates", tabs: [ResourceTab(title: "Provisioning templates", path: "admin/tenants/templates", itemsKey: "items")]))
            case "files": ResourceScreen(spec: ResourceSpec(title: "Storage", tabs: [ResourceTab(title: "Storage usage", path: "admin/usage/storage", single: true)]))
            default:
                ResourceScreen(spec: ResourceSpec(title: "Workspaces", tabs: [
                    ResourceTab(title: "Workspaces", path: "admin/tenants/\(tid)/workspaces", columns: [Column("Name", "name"), Column("Ceiling", "label", .label), Column("Visibility", "visibility", .pill), Column("State", "state", .pill), Column("Members", "members", .count)], detailPath: { "admin/tenants/\(tid)/workspaces/\($0["id"].text)/members" }, actions: [
                        RowAction(title: "Add member", path: { "admin/tenants/\(tid)/workspaces/\($0["id"].text)/members" }, fields: [FormField("userId", "User id", required: true)], systemImage: "person.badge.plus"),
                        RowAction(title: "Archive", method: .patch, path: { "admin/tenants/\(tid)/workspaces/\($0["id"].text)" }, destructive: true, confirm: "Archive this workspace?", fixed: ["state": "archived"]),
                        RowAction(title: "Quota", method: .get, path: { "admin/tenants/\(tid)/workspaces/\($0["id"].text)/quota" })],
                        create: CreateSpec(title: "New workspace", path: "admin/tenants/\(tid)/workspaces", fields: [FormField("name", "Name", required: true), FormField("description", "Description"), FormField("labelCeiling", "Label ceiling", .label, defaultValue: "internal"), FormField("visibility", "Visibility", .select(["tenant", "members"]), defaultValue: "tenant")]))
                ]))
            }
        }
    }
}
