import SwiftUI

/// Models: the shared catalogue with lifecycle, evaluation and placement.
struct ModelsScreen: View {
    var body: some View {
        ResourceScreen(spec: ResourceSpec(title: "Models", subtitle: "Catalogue, import, evaluation, approval and placement", tabs: [
            ResourceTab(title: "Catalogue", path: "admin/models", columns: [Column("Name", "name"), Column("Family", "family"), Column("Size", "parameterSize"), Column("Quant", "quantization"), Column("Format", "format"), Column("State", "state", .pill), Column("Import", "importState", .pill), Column("Label", "label", .label), Column("Pools", "pools", .count)], detailPath: { "admin/models/\($0["id"].text)" }, actions: [
                RowAction(title: "Evaluate", path: { "admin/models/\($0["id"].text)/evaluate" }, systemImage: "checkmark.seal"),
                RowAction(title: "Approve", path: { "admin/models/\($0["id"].text)/lifecycle" }, fields: [FormField("reason", "Reason")], fixed: ["to": "approved"]),
                RowAction(title: "Deprecate", path: { "admin/models/\($0["id"].text)/lifecycle" }, fields: [FormField("reason", "Reason")], destructive: true, fixed: ["to": "deprecated"]),
                RowAction(title: "Retire", path: { "admin/models/\($0["id"].text)/lifecycle" }, fields: [FormField("reason", "Reason")], destructive: true, confirm: "Retire this model?", fixed: ["to": "retired"]),
                RowAction(title: "Pull again", path: { "admin/models/\($0["id"].text)/pull" }, fields: [FormField("poolId", "Pool id", required: true)]),
                RowAction(title: "Record licence", method: .patch, path: { "admin/models/\($0["id"].text)" }, fields: [FormField("license", "Licence (JSON {name, url, notes})", .json, defaultValue: "{\"name\": \"\"}"), FormField("notes", "Notes", .multiline)])],
                create: CreateSpec(title: "Request import", path: "admin/models", fields: [FormField("name", "Name", required: true, help: "An Ollama name such as llama3.1:8b, or a server-held model with serverInstanceId."), FormField("source", "Source", required: true, defaultValue: "ollama"), FormField("label", "Label", .label, defaultValue: "internal"), FormField("poolId", "Pool id (places and pulls)"), FormField("expectedDigest", "Expected digest"), FormField("notes", "Notes", .multiline)])),
            ResourceTab(title: "Placements", path: "admin/pools", note: "Placements are read from the pool snapshot; add one with the Place action on Pools."),
            ResourceTab(title: "Thinking templates", path: "admin/profile-defaults", single: true),
            ResourceTab(title: "Label names", path: "admin/label-names", single: true)
        ]))
    }
}

/// Profiles: versioned, published model profiles with canaries and fallbacks.
struct ProfilesScreen: View {
    var body: some View {
        ResourceScreen(spec: ResourceSpec(title: "Profiles", subtitle: "What chat, /v1, agents and workflows call", tabs: [
            ResourceTab(title: "Profiles", path: "admin/profiles", columns: [Column("Name", "displayName"), Column("Id", "name", .mono), Column("Model", "model.name"), Column("Pool", "pool"), Column("Residency", "residency", .pill), Column("Status", "status", .pill), Column("Label", "label", .label), Column("Version", "version")], detailPath: { "admin/profiles/\($0["id"].text)" }, actions: [
                RowAction(title: "Publish", path: { "admin/profiles/\($0["id"].text)/publish" }, fixed: ["status": "published"], systemImage: "checkmark.seal"),
                RowAction(title: "Disable", path: { "admin/profiles/\($0["id"].text)/publish" }, destructive: true, fixed: ["status": "disabled"]),
                RowAction(title: "Edit", method: .patch, path: { "admin/profiles/\($0["id"].text)" }, fields: [FormField("displayName", "Display name"), FormField("systemPrompt", "System prompt", .multiline), FormField("temperature", "Temperature", .number), FormField("numCtx", "Context tokens", .number), FormField("thinkDefault", "Think by default", .bool), FormField("thinkCeiling", "Allow thinking", .bool), FormField("label", "Label", .label, defaultValue: "internal"), FormField("note", "Version note")]),
                RowAction(title: "Canary", method: .put, path: { "admin/profiles/\($0["id"].text)/canary" }, fields: [FormField("modelId", "Model id", required: true), FormField("percent", "Percent", .number, required: true, defaultValue: "10")]),
                RowAction(title: "Promote canary", path: { "admin/profiles/\($0["id"].text)/canary/promote" }),
                RowAction(title: "Versions", method: .get, path: { "admin/profiles/\($0["id"].text)/versions" }),
                RowAction(title: "Rollback", path: { "admin/profiles/\($0["id"].text)/rollback" }, fields: [FormField("version", "Version", .number, required: true)]),
                RowAction(title: "Delete", method: .delete, path: { "admin/profiles/\($0["id"].text)" }, destructive: true, confirm: "Delete this profile?")],
                create: CreateSpec(title: "New profile", path: "admin/profiles", fields: [FormField("name", "Id (slug)", required: true), FormField("displayName", "Display name", required: true), FormField("modelId", "Model id", required: true), FormField("poolId", "Pool id"), FormField("systemPrompt", "System prompt", .multiline), FormField("temperature", "Temperature", .number, defaultValue: "0.7"), FormField("numCtx", "Context tokens", .number, defaultValue: "8192"), FormField("thinkCeiling", "Allow thinking", .bool), FormField("label", "Label", .label, defaultValue: "internal"), FormField("description", "Description")])),
            ResourceTab(title: "Evaluations", path: "admin/profiles/evaluations", itemsKey: "items"),
            ResourceTab(title: "Agent identities", path: "admin/agent-identities", itemsKey: "items", permission: "agents:manage")
        ]))
    }
}

/// Pools: the live gateway snapshot with instances, loaded models and memory.
struct PoolsScreen: View {
    @Environment(AppSession.self) private var session
    @State private var pools: Loadable<[JSONValue]> = .idle
    @State private var problem: APIProblem?
    @State private var action: (title: String, path: String, fields: [FormField])?

    var body: some View {
        LoadableView(state: pools, retry: load) { list in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let problem { Notice(.danger, problem.title, problem.detail) }
                    ForEach(list, id: \.self) { p in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(p["name"].text).font(.title3.weight(.semibold)); Pill(p["accelerator"].text, tone: .info); Text("zone \(p["zone"].text)").font(.caption).foregroundStyle(Exprsn.muted); LabelBadge(p["labelCeiling"].string, small: true)
                                Spacer()
                                Button("Add instance") { action = ("Register instance on \(p["name"].text)", "admin/pools/\(p["id"].text)/instances", [FormField("name", "Name", required: true), FormField("url", "URL", required: true, defaultValue: "http://127.0.0.1:11434"), FormField("deploy", "Deploy", .select(["docker", "baremetal"]), defaultValue: "baremetal"), FormField("kind", "Kind", .select(["ollama", "openai"]), defaultValue: "ollama"), FormField("settings", "Settings (JSON)", .json, defaultValue: "{}")]) }.controlSize(.small)
                                Button("Place model") { action = ("Place a model on \(p["name"].text)", "admin/placements", [FormField("modelId", "Model id", required: true), FormField("poolId", "Pool id", required: true, defaultValue: p["id"].text), FormField("residency", "Residency", .select(["pinned", "warm", "cold"]), defaultValue: "warm"), FormField("pull", "Pull now", .bool, defaultValue: "true")]) }.controlSize(.small)
                                Button("Upgrade…") { action = ("Rolling upgrade of \(p["name"].text)", "admin/pools/\(p["id"].text)/upgrade", [FormField("targetVersion", "Target Ollama version", required: true), FormField("waitMinutes", "Wait minutes", .number, defaultValue: "10")]) }.controlSize(.small)
                            }
                            if let d = p["description"].string { Text(d).font(.callout).foregroundStyle(Exprsn.fg2) }
                            ForEach(p["instances"].array, id: \.self) { i in instance(i) }
                            if !p["placements"].array.isEmpty {
                                Eyebrow("Placements")
                                ForEach(p["placements"].array, id: \.self) { pl in
                                    HStack { Text(pl["model"].string ?? pl["modelName"].text).font(.callout); Pill(pl["residency"].text, tone: .info); Spacer(); Button("Remove", role: .destructive) { Task { await run(.delete, "admin/placements/\(pl["id"].text)") } }.controlSize(.small) }
                                }
                            }
                        }.panel()
                    }
                    if list.isEmpty { EmptyState(title: "No pools", text: "Create one, then register Ollama or Chat Completions instances on it.", systemImage: "cpu") }
                }.padding(16)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { action = ("New pool", "admin/pools", [FormField("name", "Name", required: true), FormField("accelerator", "Accelerator", .select(["cuda", "rocm", "metal", "cpu"]), defaultValue: "metal"), FormField("zone", "Zone", required: true, defaultValue: "internal"), FormField("labelCeiling", "Label ceiling", .label, defaultValue: "internal"), FormField("description", "Description")]) } label: { Label("New pool", systemImage: "plus") }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
        }
        .sheet(item: Binding(get: { action.map { FormRequest(title: $0.title, path: $0.path, fields: $0.fields) } }, set: { if $0 == nil { action = nil } })) { r in
            FormSheet(title: r.title, fields: r.fields) { body in _ = try await session.client!.post(r.path, body); await load() }
        }
        .task { await load() }
    }

    private func instance(_ i: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(i["name"].text).font(.body.weight(.medium)); Pill(i["health"].text); Pill(i["state"].text, tone: .neutral)
                Text(i["url"].text).font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted).lineLimit(1)
                Spacer()
                Text("v\(i["version"].text) · \(Fmt.ms(i["latencyMs"].double)) · \(i["inflight"].text) in flight, \(i["queued"].text) queued").font(.caption).foregroundStyle(Exprsn.muted)
            }
            if let total = i["memory"]["totalBytes"].double, total > 0 {
                Meter(label: "Memory", valueText: "\(Fmt.bytes(i["memory"]["usedBytes"].double)) of \(Fmt.bytes(total))", fraction: (i["memory"]["usedBytes"].double ?? 0) / total, tone: ((i["memory"]["usedBytes"].double ?? 0) / total) > 0.9 ? .warn : .neutral)
            }
            if !i["loaded"].array.isEmpty {
                HStack { ForEach(i["loaded"].array, id: \.self) { m in
                    HStack(spacing: 4) { Text(m["name"].text).font(.caption); Pill(m["residency"].text, tone: m["residency"].string == "pinned" ? .accent : .neutral); Button { Task { await run(.post, "admin/instances/\(i["id"].text)/unload", json(["model": .string(m["name"].text)])) } } label: { Image(systemName: "xmark.circle") }.buttonStyle(.borderless) }
                        .padding(4).background(Exprsn.selection, in: Capsule())
                } }.flexibleWrap()
            }
            HStack {
                Button("Load…") { action = ("Load a model on \(i["name"].text)", "admin/instances/\(i["id"].text)/load", [FormField("model", "Model name", required: true), FormField("pinned", "Pin", .bool)]) }
                Button(i["state"].string == "draining" ? "Undrain" : "Drain") { Task { await run(.post, "admin/instances/\(i["id"].text)/\(i["state"].string == "draining" ? "undrain" : "drain")") } }
                Button("Events") { action = ("Events of \(i["name"].text)", "admin/instances/\(i["id"].text)/events", []) }
                Button("Remove", role: .destructive) { Task { await run(.delete, "admin/instances/\(i["id"].text)") } }
            }.controlSize(.small).buttonStyle(.bordered)
        }
        .padding(8).background(Exprsn.panel2, in: RoundedRectangle(cornerRadius: 8))
    }

    private func load() async { pools = await loaded { (try await session.client!.get("admin/pools")).rows(itemsKey: "pools") } }
    private func run(_ m: HTTPMethod, _ path: String, _ body: JSONValue? = nil) async {
        problem = nil
        do { _ = try await session.client!.json(m, path, body: body); await load() } catch { problem = error.asProblem }
    }
}

struct FormRequest: Identifiable { var id: String { path }; var title: String; var path: String; var fields: [FormField] }

/// Registry: tools, skills and agents with review and the test harness.
struct RegistryScreen: View {
    var body: some View {
        ResourceScreen(spec: ResourceSpec(title: "Registry", subtitle: "Tools, skills and agents: review, publish, deprecate, test", tabs: [
            ResourceTab(title: "Tools", path: "admin/registry", query: ["kind": "tool"], columns: [Column("Name", "name"), Column("Version", "version"), Column("Impl", "impl", .pill), Column("Side effect", "sideEffect", .pill), Column("Status", "status", .pill), Column("Label", "label", .label), Column("Checks", "checksPassed", .bool)], detailPath: { "admin/registry/\($0["id"].text)" }, actions: registryActions),
            ResourceTab(title: "Skills", path: "admin/registry", query: ["kind": "skill"], columns: [Column("Name", "name"), Column("Version", "version"), Column("Status", "status", .pill), Column("Label", "label", .label)], detailPath: { "admin/registry/\($0["id"].text)" }, actions: registryActions,
                create: CreateSpec(title: "New skill", path: "admin/registry", fields: [FormField("name", "Name", required: true), FormField("version", "Version", required: true, defaultValue: "1.0.0"), FormField("description", "Description", .multiline, required: true), FormField("label", "Label", .label, defaultValue: "internal"), FormField("definition", "Definition (JSON {instructions, tools})", .json, required: true, defaultValue: "{\"instructions\": \"\", \"tools\": []}"), FormField("kind", "Kind", .select(["skill"]), defaultValue: "skill")])),
            ResourceTab(title: "Agents", path: "admin/registry", query: ["kind": "agent"], columns: [Column("Name", "name"), Column("Version", "version"), Column("Status", "status", .pill), Column("Label", "label", .label), Column("Owner", "owner")], detailPath: { "admin/registry/\($0["id"].text)" }, actions: registryActions + [RowAction(title: "Test run", path: { "admin/registry/\($0["id"].text)/test" }, fields: [FormField("input", "Input", .multiline, required: true)], systemImage: "play")],
                create: CreateSpec(title: "New agent", path: "admin/registry", fields: [FormField("name", "Name", required: true), FormField("version", "Version", required: true, defaultValue: "1.0.0"), FormField("description", "Description", .multiline, required: true), FormField("label", "Label", .label, defaultValue: "internal"), FormField("definition", "Definition (JSON)", .json, required: true, defaultValue: "{\"profile\": \"\", \"systemPrompt\": \"\", \"tools\": [], \"skills\": [], \"budgets\": {\"steps\": 20, \"tokens\": 50000, \"wallSeconds\": 600, \"toolCalls\": 20}}"), FormField("kind", "Kind", .select(["agent"]), defaultValue: "agent")]), permission: "agents:manage"),
            ResourceTab(title: "Inventory", path: "admin/inventory", itemsKey: "items", permission: "tools:manage")
        ]))
    }

    private var registryActions: [RowAction] {
        [
            RowAction(title: "Run checks", path: { "admin/registry/\($0["id"].text)/checks" }),
            RowAction(title: "Submit for review", path: { "admin/registry/\($0["id"].text)/submit" }),
            RowAction(title: "Approve", path: { "admin/registry/\($0["id"].text)/review" }, fields: [FormField("note", "Note"), FormField("scope", "Scope", .select(["tenant", "workspace"]), defaultValue: "tenant")], fixed: ["decision": "approve"]),
            RowAction(title: "Reject", path: { "admin/registry/\($0["id"].text)/review" }, fields: [FormField("note", "Note", required: true)], destructive: true, fixed: ["decision": "reject"]),
            RowAction(title: "Deprecate", path: { "admin/registry/\($0["id"].text)/lifecycle" }, fields: [FormField("replacement", "Replacement")], destructive: true, fixed: ["to": "deprecated"]),
            RowAction(title: "Retire", path: { "admin/registry/\($0["id"].text)/lifecycle" }, destructive: true, confirm: "Retire this entry?", fixed: ["to": "retired"]),
            RowAction(title: "New version", path: { "admin/registry/\($0["id"].text)/versions" }, fields: [FormField("version", "Version", required: true)]),
            RowAction(title: "Test", path: { "admin/registry/\($0["id"].text)/test" }, fields: [FormField("arguments", "Arguments (JSON)", .json, defaultValue: "{}")], systemImage: "play")
        ]
    }
}
