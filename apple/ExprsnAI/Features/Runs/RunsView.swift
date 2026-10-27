import SwiftUI

/// Runs: start an agent, follow its lanes and steps, approve or reject tool calls, resume, replay; schedules.
struct RunsScreen: View {
    @Environment(AppSession.self) private var session
    @State private var runs: Loadable<[JSONValue]> = .idle
    @State private var agents: [JSONValue] = []
    @State private var selected: String?
    @State private var starting = false
    @State private var all = false
    @State private var tab = "runs"

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) { Text("Runs").tag("runs"); Text("Schedules").tag("schedules"); Text("Agents").tag("agents") }.pickerStyle(.segmented).padding(12).frame(maxWidth: 360)
            switch tab {
            case "schedules":
                ResourceScreen(spec: ResourceSpec(title: "Schedules", tabs: [ResourceTab(title: "Schedules", path: "agent-schedules", query: ["all": session.has("agents:manage") ? "true" : nil], itemsKey: "items", columns: [Column("Name", "name"), Column("Agent", "agent"), Column("Cron", "cronText"), Column("Enabled", "enabled", .bool), Column("Next", "nextRunAt", .date), Column("Last", "lastResult", .pill)], detailPath: { "agent-schedules/\($0["id"].text)" }, actions: [
                    RowAction(title: "Pause", method: .patch, path: { "agent-schedules/\($0["id"].text)" }, fixed: ["enabled": false]), RowAction(title: "Resume", method: .patch, path: { "agent-schedules/\($0["id"].text)" }, fixed: ["enabled": true]),
                    RowAction(title: "History", method: .get, path: { "agent-schedules/\($0["id"].text)/history" }), RowAction(title: "Delete", method: .delete, path: { "agent-schedules/\($0["id"].text)" }, destructive: true, confirm: "Delete this schedule?")],
                    create: CreateSpec(title: "New schedule", path: "agent-schedules", fields: [FormField("name", "Name", required: true), FormField("agent", "Agent name", required: true), FormField("cron", "Cron (five fields, UTC)", required: true, defaultValue: "0 9 * * 1-5"), FormField("input", "Input", .multiline, required: true), FormField("label", "Label", .label, defaultValue: "internal")]))]))
            case "agents":
                ResourceScreen(spec: ResourceSpec(title: "Agents", tabs: [ResourceTab(title: "Agents you may run", path: "agents", columns: [Column("Name", "name"), Column("Version", "version"), Column("Profile", "profile"), Column("Label", "label", .label), Column("Tools", "tools", .count), Column("Deprecated", "deprecated", .bool)])]))
            default:
                LoadableView(state: runs, retry: load) { list in
                    HStack(spacing: 0) {
                        VStack(spacing: 0) {
                            if session.has("agents:manage") { Toggle("Everyone's runs", isOn: $all).padding(.horizontal, 12).padding(.bottom, 6).onChange(of: all) { _, _ in Task { await load() } } }
                            List(list, id: \.self, selection: Binding(get: { selected.flatMap { s in list.first { $0["id"].text == s } } }, set: { selected = $0?["id"].text })) { r in
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack { Text(r["agent"].text).font(.body.weight(.medium)); Pill(r["state"].text); Spacer(); LabelBadge(r["label"].string, small: true) }
                                    Text("\(r["by"].text) · \(Fmt.when(r["createdAt"])) · \(r["usage"]["steps"].text) steps, \(Fmt.count(r["usage"]["tokens"].double)) tokens").font(.caption).foregroundStyle(Exprsn.muted)
                                }
                            }.listStyle(.plain)
                        }.frame(minWidth: 300, idealWidth: 380)
                        Divider()
                        if let id = selected { RunDetail(id: id, reload: load) } else { EmptyState(title: "Choose a run", text: "Or start an agent.", systemImage: "play.circle") }
                    }
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { starting = true } label: { Label("Start a run", systemImage: "play") }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
        }
        .sheet(isPresented: $starting) {
            FormSheet(title: "Start an agent run", fields: [FormField("agent", "Agent", .select(agents.map { $0["name"].text }), required: true, defaultValue: agents.first?["name"].text ?? ""), FormField("input", "Input", .multiline, required: true), FormField("label", "Label", .label, defaultValue: "internal")]) { body in
                let r = try await session.client!.post("runs", body); selected = r["id"].string; await load()
            }
        }
        .task { agents = (try? await session.client?.get("agents"))?.rows(itemsKey: nil) ?? []; await load() }
    }
    private func load() async { runs = await loaded { (try await session.client!.get("runs", query: ["all": all ? "true" : nil])).rows(itemsKey: "items") } }
}

struct RunDetail: View {
    @Environment(AppSession.self) private var session
    var id: String
    var reload: () async -> Void
    @State private var run: Loadable<JSONValue> = .idle
    @State private var problem: APIProblem?
    @State private var note = ""

    var body: some View {
        LoadableView(state: run, retry: load) { r in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack { Text(r["agent"].text).font(.title2.weight(.semibold)); Text("v\(r["agentVersion"].text)").foregroundStyle(Exprsn.muted); Pill(r["state"].text); Spacer(); LabelBadge(r["label"].string) }
                    if let e = r["error"].string { Notice(.danger, "Failed", e) }
                    HStack(spacing: 10) {
                        StatTile(value: "\(r["usage"]["steps"].text)/\(r["budgets"]["steps"].text)", label: "Steps")
                        StatTile(value: "\(Fmt.count(r["usage"]["tokens"].double))/\(Fmt.count(r["budgets"]["tokens"].double))", label: "Tokens")
                        StatTile(value: "\(r["usage"]["toolCalls"].text)/\(r["budgets"]["toolCalls"].text)", label: "Tool calls")
                        StatTile(value: Fmt.ms(r["usage"]["wallMs"].double), label: "Wall time")
                    }
                    HStack {
                        if ["queued", "running", "waiting"].contains(r["state"].string ?? "") { Button("Cancel", role: .destructive) { Task { await act("runs/\(id)/cancel", nil) } } }
                        if r["state"].string == "budget" { Button("Resume with a larger budget") { Task { await act("runs/\(id)/resume", json(["budgets": ["steps": .number(Double((r["budgets"]["steps"].int ?? 20) * 2)), "tokens": .number(Double((r["budgets"]["tokens"].int ?? 50000) * 2))]])) } } }
                        Button("Replay from step 1") { Task { await act("runs/\(id)/replay", json(["fromStep": 1])) } }
                    }.controlSize(.small)
                    VStack(alignment: .leading, spacing: 2) { Eyebrow("Input"); Text(r["input"].text).font(.callout).textSelection(.enabled) }.panel()
                    if let out = r["output"].string, !out.isEmpty { VStack(alignment: .leading, spacing: 2) { Eyebrow("Answer"); MarkdownText(out) }.panel() }
                    Eyebrow("Steps")
                    ForEach(r["steps"].array, id: \.self) { s in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("\(s["n"].text)").font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted).frame(width: 24)
                                Image(systemName: s["lane"].string == "think" ? "brain" : s["lane"].string == "calc" ? "function" : "wrench").foregroundStyle(Exprsn.muted)
                                Text(s["title"].text).font(.body.weight(.medium)); Pill(s["state"].text)
                                if let t = s["meta"]["tool"].string { Text(t).font(.exprsnMonoSmall) }
                                if let se = s["meta"]["sideEffect"].string { Pill(se, tone: se == "read" ? .ok : .warn) }
                                Spacer(); Text(Fmt.ms(s["meta"]["durationMs"].double)).font(.caption).foregroundStyle(Exprsn.muted)
                            }
                            if let d = s["detail"].string ?? s["detail"]["content"].string { Text(d).font(.callout).foregroundStyle(Exprsn.fg2).lineLimit(8).textSelection(.enabled) }
                            else if !s["detail"].isNull { Text(s["detail"].prettyPrinted).font(.exprsnMonoSmall).foregroundStyle(Exprsn.fg2).lineLimit(10) }
                            if s["state"].string == "waiting" {
                                HStack {
                                    TextField("Note", text: $note).textFieldStyle(.roundedBorder)
                                    Button("Approve") { Task { await act("runs/\(id)/steps/\(s["n"].text)/decision", json(["decision": "approve", "note": .string(note)])) } }.buttonStyle(.borderedProminent)
                                    Button("Reject", role: .destructive) { Task { await act("runs/\(id)/steps/\(s["n"].text)/decision", json(["decision": "reject", "note": .string(note)])) } }
                                }.controlSize(.small)
                            }
                        }.panel(padding: 8)
                    }
                    if let problem { Notice(.danger, problem.title, problem.detail) }
                }.padding(16)
            }
        }
        .task(id: id) {
            await load()
            while !Task.isCancelled, let st = run.value?["state"].string, ["queued", "running", "waiting"].contains(st) {
                try? await Task.sleep(nanoseconds: 2_000_000_000); await load()
            }
        }
    }
    private func load() async { run = await loaded { try await session.client!.get("runs/\(id)") } }
    private func act(_ path: String, _ body: JSONValue?) async {
        problem = nil
        do { _ = try await session.client!.post(path, body); await load(); await reload() } catch { problem = error.asProblem }
    }
}
