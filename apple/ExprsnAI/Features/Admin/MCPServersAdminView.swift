import SwiftUI

/// MCP servers an install registers for its models: register, check, approve tools, bind to profiles.
struct MCPServersAdminScreen: View {
    @Environment(AppSession.self) private var session
    @State private var servers: Loadable<[JSONValue]> = .idle
    @State private var selected: String?
    @State private var registering = false

    var body: some View {
        LoadableView(state: servers, retry: load) { list in
            HStack(spacing: 0) {
                List(list, id: \.self, selection: Binding(get: { selected.flatMap { s in list.first { $0["id"].text == s } } }, set: { selected = $0?["id"].text })) { s in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack { Text(s["name"].text).font(.body.weight(.medium)); Pill(s["health"].text); Spacer() }
                        Text(s["url"].text).font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted).lineLimit(1)
                        Text("\(s["tools"].text) tools · \(s["approved"].text) approved · \(s["pending"].text) pending · auth \(s["auth"].text) · zone \(s["zone"].text)").font(.caption).foregroundStyle(Exprsn.muted)
                    }
                }.listStyle(.plain).frame(minWidth: 300, idealWidth: 380)
                Divider()
                if let id = selected { MCPServerDetail(id: id, reload: load) } else { EmptyState(title: "Choose a server", text: "Streamable HTTP only; hosts must be internal unless allow-listed.", systemImage: "point.3.filled.connected.trianglepath.dotted") }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { registering = true } label: { Label("Register", systemImage: "plus") }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
        }
        .sheet(isPresented: $registering) {
            FormSheet(title: "Register MCP server", fields: [FormField("name", "Name", required: true), FormField("url", "URL (Streamable HTTP)", required: true, defaultValue: "http://"), FormField("zone", "Zone", required: true, defaultValue: "internal"), FormField("auth", "Authentication", .select(["none", "service", "user"]), defaultValue: "none"), FormField("credential", "Service token", .secure), FormField("description", "Description", .multiline)]) { body in
                _ = try await session.client!.post("admin/mcp-servers", body); await load()
            }
        }
        .task { await load() }
    }
    private func load() async { servers = await loaded { (try await session.client!.get("admin/mcp-servers")).rows(itemsKey: "items") } }
}

struct MCPServerDetail: View {
    @Environment(AppSession.self) private var session
    var id: String
    var reload: () async -> Void
    @State private var server: Loadable<JSONValue> = .idle
    @State private var problem: APIProblem?
    @State private var report: [JSONValue] = []
    @State private var approving: JSONValue?
    @State private var profiles: [JSONValue] = []
    @State private var bindProfile = ""
    @State private var rotating = false
    @State private var confirmRemove = false

    var body: some View {
        LoadableView(state: server, retry: load) { s in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        VStack(alignment: .leading) { Text(s["name"].text).font(.title2.weight(.semibold)); Text(s["url"].text).font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted).textSelection(.enabled) }
                        Spacer()
                        Pill(s["health"].text)
                        Pill(s["state"].text)
                    }
                    if let d = s["healthDetail"].string, !d.isEmpty { Text(d).font(.callout).foregroundStyle(Exprsn.fg2) }
                    HStack(spacing: 10) {
                        Text("protocol \(s["protocolVersion"].text)"); Text("\(s["serverInfo"]["name"].text) \(s["serverInfo"]["version"].text)"); Text("latency \(Fmt.ms(s["latencyMs"].double))"); Text("checked \(Fmt.when(s["lastCheckedAt"]))"); Text("failures \(s["failures"].text)")
                    }.font(.caption).foregroundStyle(Exprsn.muted)
                    HStack {
                        Button { Task { await check() } } label: { Label("Check now", systemImage: "stethoscope") }
                        if s["auth"].string == "service" { Button { rotating = true } label: { Label("Rotate credential", systemImage: "key") } }
                        Button(role: .destructive) { confirmRemove = true } label: { Label("Deregister", systemImage: "trash") }
                    }.controlSize(.small)
                    if let problem { Notice(.danger, problem.title, problem.detail) }
                    if !report.isEmpty {
                        Eyebrow("Last check")
                        ForEach(report, id: \.self) { r in HStack { Pill(r["result"].text); Text(r["check"].text).font(.callout); Text(r["detail"].text).font(.caption).foregroundStyle(Exprsn.muted) } }
                    }
                    Eyebrow("Tools (\(s["tools"].array.count))")
                    ForEach(s["tools"].array, id: \.self) { t in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(t["name"].text).font(.body.weight(.medium)); Pill(t["state"].text)
                                if let se = t["sideEffect"].string { Pill(se, tone: se == "read" ? .ok : se == "write" ? .warn : .danger) }
                                if let l = t["label"].string { LabelBadge(l, small: true) }
                                Spacer()
                                if ["pending", "changed"].contains(t["state"].string ?? "") { Button("Approve…") { approving = t }.controlSize(.small) }
                                if t["state"].string == "changed" { Button("Keep disabled") { Task { await act("admin/mcp-servers/\(id)/tools/\(t["name"].text)/reject-change") } }.controlSize(.small) }
                                if t["state"].string == "approved" { Button("Revoke", role: .destructive) { Task { await act("admin/mcp-servers/\(id)/tools/\(t["name"].text)/revoke") } }.controlSize(.small) }
                            }
                            if let d = t["description"].string { Text(d).font(.caption).foregroundStyle(Exprsn.fg2) }
                            if let sug = t["suggestedSideEffect"].string { Text("Suggested side effect: \(sug) (annotations are hints)").font(.caption2).foregroundStyle(Exprsn.muted) }
                        }.panel()
                    }
                    Eyebrow("Profiles using this server")
                    ForEach(s["bindings"].array, id: \.self) { b in
                        HStack { Text(b["profile"].text); Text(b["model"].text).font(.caption).foregroundStyle(Exprsn.muted); Text("\(b["toolCount"].text) tools").font(.caption); Pill(b["status"].text); Spacer()
                            Button("Unbind", role: .destructive) { Task { await act("admin/mcp-servers/\(id)/bind/\(b["profileId"].text)", method: .delete) } }.controlSize(.small) }
                    }
                    if session.has("profiles:manage") {
                        HStack {
                            Picker("Bind to profile", selection: $bindProfile) { Text("Choose…").tag(""); ForEach(profiles, id: \.self) { p in Text(p["displayName"].string ?? p["name"].text).tag(p["id"].text) } }.fixedSize()
                            Button("Bind approved tools") { Task { await act("admin/mcp-servers/\(id)/bind", body: json(["profileId": .string(bindProfile)])) } }.disabled(bindProfile.isEmpty).controlSize(.small)
                        }
                    }
                    if !s["connections"].array.isEmpty {
                        Eyebrow("Per-user tokens")
                        ForEach(s["connections"].array, id: \.self) { c in Text("\(c["user"].string ?? c["userName"].text) · \(Fmt.when(c["updatedAt"]))").font(.caption) }
                    }
                    if !s["events"].array.isEmpty {
                        Eyebrow("Timeline")
                        ForEach(s["events"].array.prefix(20), id: \.self) { e in HStack(alignment: .top) { Text(Fmt.when(e["at"].isNull ? e["createdAt"] : e["at"])).font(.caption).foregroundStyle(Exprsn.muted).frame(width: 90, alignment: .leading); Text(e["text"].string ?? e["kind"].string ?? e.text).font(.callout) } }
                    }
                }.padding(16)
            }
        }
        .task(id: id) { await load(); profiles = (try? await session.client?.get("admin/profiles"))?.rows(itemsKey: "items") ?? [] }
        .sheet(item: Binding(get: { approving.map(IdentifiedJSON.init) }, set: { approving = $0?.value })) { t in
            FormSheet(title: "Approve \(t.value["name"].text)", fields: [FormField("sideEffect", "Side effect", .select(["read", "write", "destructive"]), required: true, defaultValue: t.value["suggestedSideEffect"].string ?? "read"), FormField("confirm", "Confirm before each call", .select(["never", "always"]), defaultValue: "never", help: "Write and destructive tools need confirm: always."), FormField("label", "Ceiling label", .label, defaultValue: "internal")]) { body in
                _ = try await session.client!.post("admin/mcp-servers/\(id)/tools/\(t.value["name"].text)/approve", body); await load(); await reload()
            }
        }
        .sheet(isPresented: $rotating) { FormSheet(title: "Rotate service credential", fields: [FormField("secret", "New token", .secure, required: true)]) { body in _ = try await session.client!.put("admin/mcp-servers/\(id)/credential", body); await load() } }
        .confirmationDialog("Deregister this server?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Deregister", role: .destructive) { Task { await act("admin/mcp-servers/\(id)", method: .delete); await reload() } }
        } message: { Text("Its tools leave every profile, registry entries are deprecated and user tokens deleted.") }
    }
    private func load() async { server = await loaded { try await session.client!.get("admin/mcp-servers/\(id)") } }
    private func check() async {
        do { let r = try await session.client!.post("admin/mcp-servers/\(id)/check"); report = r["report"].array; await load(); await reload() } catch { problem = error.asProblem }
    }
    private func act(_ path: String, method: HTTPMethod = .post, body: JSONValue? = nil) async {
        problem = nil
        do { _ = try await session.client!.json(method, path, body: body); await load(); await reload() } catch { problem = error.asProblem }
    }
}
