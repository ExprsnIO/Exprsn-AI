import SwiftUI
import SwiftData

/// Native MCP connections: inspect any Streamable HTTP MCP server (an Exprsn-AI workspace's own server among
/// them), list its tools and call one by hand.
struct MCPClientScreen: View {
    @Environment(\.modelContext) private var context
    @Environment(AppSession.self) private var session
    @Query(sort: \MCPConnection.createdAt) private var connections: [MCPConnection]
    @State private var selected: MCPConnection?
    @State private var adding = false

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                List(connections, selection: Binding(get: { selected?.id }, set: { id in selected = connections.first { $0.id == id } })) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.name).font(.body.weight(.medium))
                        Text(c.url).font(.caption2).foregroundStyle(Exprsn.muted).lineLimit(1)
                        HStack { if let s = c.lastStatus { Pill(s) }; if c.toolCount > 0 { Text("\(c.toolCount) tools").font(.caption2).foregroundStyle(Exprsn.muted) } }
                    }.tag(c.id)
                    .contextMenu { Button("Remove", role: .destructive) { Keychain.remove(c.tokenKey); context.delete(c); if selected?.id == c.id { selected = nil } } }
                }.listStyle(.plain)
                if session.isExprsn {
                    Button { Task { await addFromExprsn() } } label: { Label("Add this workspace's MCP server", systemImage: "plus.circle") }.buttonStyle(.borderless).padding(8).font(.caption)
                }
            }.frame(width: 280).background(Exprsn.nav)
            Divider()
            if let c = selected { MCPConnectionDetail(connection: c) } else { EmptyState(title: "Choose a connection", text: "Or add an MCP server by its Streamable HTTP address.", systemImage: "point.3.connected.trianglepath.dotted") }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Label("Add connection", systemImage: "plus") } } }
        .sheet(isPresented: $adding) { MCPConnectionEditor() }
    }

    /// Exprsn-AI publishes an MCP server per workspace (`GET /me/mcp-server`); add it with the session's API key.
    private func addFromExprsn() async {
        guard let client = session.client, let r = try? await client.get("me/mcp-server") else { return }
        for s in r["servers"].array {
            let c = MCPConnection(name: "\(session.server?.name ?? "Exprsn-AI") · \(s["workspace"].text)", url: s["url"].text, authKind: "bearer")
            c.serverProfileId = session.server?.id
            if case .apiKey(let key) = client.credential { Keychain.set(key, for: c.tokenKey) }
            context.insert(c)
        }
        try? context.save()
    }
}

struct MCPConnectionEditor: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = "https://"
    @State private var bearer = false
    @State private var token = ""
    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                TextField("Address (Streamable HTTP endpoint)", text: $url)
                Toggle("Send a bearer token", isOn: $bearer)
                if bearer { SecureField("Token", text: $token) }
                Text("Exprsn-AI workspace servers take an API key with tools:invoke, or an OAuth access token.").font(.caption).foregroundStyle(Exprsn.muted)
            }
            .formStyle(.grouped)
            .navigationTitle("Add MCP connection")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Add") {
                    let c = MCPConnection(name: name, url: url, authKind: bearer ? "bearer" : "none")
                    if bearer { Keychain.set(token, for: c.tokenKey) }
                    context.insert(c); try? context.save(); dismiss()
                }.disabled(name.isEmpty || URL(string: url)?.host == nil) }
            }
        }.frame(minWidth: 440, minHeight: 260)
    }
}

struct MCPConnectionDetail: View {
    @Environment(\.modelContext) private var context
    var connection: MCPConnection
    @State private var info: MCPClient.InitResult?
    @State private var tools: [MCPClient.Tool] = []
    @State private var resources: [JSONValue] = []
    @State private var problem: APIProblem?
    @State private var selectedTool: MCPClient.Tool?
    @State private var args = "{}"
    @State private var result: JSONValue?
    @State private var busy = false
    @State private var newToken = ""

    private var client: MCPClient { MCPClient(url: URL(string: connection.url)!, token: connection.usesBearer ? Keychain.get(connection.tokenKey) : nil) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading) { Text(connection.name).font(.title2.weight(.semibold)); Text(connection.url).font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted).textSelection(.enabled) }
                    Spacer()
                    Button { Task { await connect() } } label: { Label("Connect", systemImage: "bolt") }.buttonStyle(.borderedProminent).disabled(busy)
                }
                if let problem { Notice(.danger, problem.title, problem.detail) }
                if let info {
                    HStack(spacing: 8) { Pill("connected", tone: .ok); Text("protocol \(info.protocolVersion)").font(.caption); Text(info.serverInfo["name"].text + " " + info.serverInfo["version"].text).font(.caption).foregroundStyle(Exprsn.muted) }
                    if let i = info.instructions { Text(i).font(.callout).foregroundStyle(Exprsn.fg2) }
                }
                if connection.usesBearer {
                    HStack { SecureField("Replace the stored token", text: $newToken).textFieldStyle(.roundedBorder); Button("Save") { Keychain.set(newToken, for: connection.tokenKey); newToken = "" }.disabled(newToken.isEmpty) }
                }
                if !tools.isEmpty {
                    Eyebrow("Tools (\(tools.count))")
                    ForEach(tools) { t in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(t.title ?? t.name).font(.body.weight(.medium))
                                if t.annotations["readOnlyHint"].bool == true { Pill("read-only", tone: .ok) }
                                if t.annotations["destructiveHint"].bool == true { Pill("destructive", tone: .danger) }
                                Spacer()
                                Button("Call…") { selectedTool = t; args = t.inputSchema["properties"].object.isEmpty ? "{}" : "{\n  " + t.inputSchema["properties"].object.keys.sorted().map { "\"\($0)\": \"\"" }.joined(separator: ",\n  ") + "\n}"; result = nil }.controlSize(.small)
                            }
                            Text(t.name).font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted)
                            if let d = t.description { Text(d).font(.caption).foregroundStyle(Exprsn.fg2) }
                        }.panel()
                    }
                }
                if !resources.isEmpty {
                    Eyebrow("Resources (\(resources.count))")
                    ForEach(Array(resources.enumerated()), id: \.offset) { _, r in Text("\(r["name"].text)  \(r["uri"].text)").font(.exprsnMonoSmall) }
                }
            }.padding(16)
        }
        .sheet(item: $selectedTool) { t in
            NavigationStack {
                Form {
                    Section("Arguments (JSON)") { TextEditor(text: $args).font(.exprsnMonoSmall).frame(minHeight: 140) }
                    Section("Schema") { Text(t.inputSchema.prettyPrinted).font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted) }
                    if let result { Section("Result") { Text(result.prettyPrinted).font(.exprsnMonoSmall).textSelection(.enabled) } }
                }
                .formStyle(.grouped)
                .navigationTitle(t.name)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { selectedTool = nil } }
                    ToolbarItem(placement: .confirmationAction) { Button("Call") { Task { await call(t) } }.disabled(busy) }
                }
            }.frame(minWidth: 520, minHeight: 460)
        }
        .task(id: connection.id) { info = nil; tools = []; resources = []; problem = nil }
    }

    private func connect() async {
        busy = true; defer { busy = false }
        problem = nil
        do {
            let c = client
            info = try await c.initialize()
            tools = try await c.listTools()
            resources = (try? await c.listResources()) ?? []
            connection.lastCheckedAt = Date(); connection.lastStatus = "healthy"; connection.toolCount = tools.count
            connection.protocolVersion = info?.protocolVersion; connection.serverInfo = info?.serverInfo.text
            try? context.save()
        } catch {
            problem = error.asProblem
            connection.lastCheckedAt = Date(); connection.lastStatus = "unreachable"; try? context.save()
        }
    }

    private func call(_ t: MCPClient.Tool) async {
        busy = true; defer { busy = false }
        guard let d = args.data(using: .utf8), let a = try? JSONDecoder().decode(JSONValue.self, from: d) else { result = ["error": "Arguments are not valid JSON"]; return }
        do { result = try await client.callTool(t.name, arguments: a) } catch { result = ["error": .string(error.asProblem.errorDescription ?? "failed")] }
    }
}
