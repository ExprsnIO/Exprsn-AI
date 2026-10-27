import SwiftUI

/// Memory: your memories, the workspace's and the agents'; proposals to accept or reject; forget.
struct MemoryScreen: View {
    @Environment(AppSession.self) private var session
    @State private var tab = "mine"
    @State private var data: Loadable<JSONValue> = .idle
    @State private var adding = false
    @State private var problem: APIProblem?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("", selection: $tab) {
                    Text("Mine\(count("mine"))").tag("mine"); Text("Workspace\(count("workspace"))").tag("workspace"); Text("Agents\(count("agents"))").tag("agents")
                }.pickerStyle(.segmented).frame(maxWidth: 420).onChange(of: tab) { _, _ in Task { await load() } }
                Spacer()
                if let d = data.value { Text("Backend \(d["backend"].text)\(d["curator"].bool == true ? " · you are a curator" : "")").font(.caption).foregroundStyle(Exprsn.muted) }
            }.padding(12)
            if let problem { Notice(.danger, problem.title, problem.detail).padding(.horizontal, 12) }
            LoadableView(state: data, retry: load) { d in
                let items = d["items"].array
                if items.isEmpty { EmptyState(title: "No memories here", text: "Memories are proposed from chat (\"remember that…\") and by agents, or added by hand.", systemImage: "brain") }
                else {
                    List(items, id: \.self) { m in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack { Pill(m["state"].text); Pill(m["type"].text, tone: .info); Pill(m["origin"].text, tone: .neutral); Spacer(); LabelBadge(m["label"].string, small: true); Text(Fmt.when(m["updatedAt"])).font(.caption).foregroundStyle(Exprsn.muted) }
                            Text(m["text"].text).font(.body).textSelection(.enabled)
                            if let s = m["source"]["title"].string { Text("From \(s)").font(.caption).foregroundStyle(Exprsn.muted) }
                            if !m["expiryProposal"].isNull { Notice(.warn, "Expiry proposed: \(m["expiryProposal"]["reason"].text)", nil, actionLabel: "Accept") { Task { await act("memory/\(m["id"].text)/expiry/accept") } } }
                            HStack {
                                if m["state"].string == "proposed" {
                                    Button("Accept") { Task { await act("memory/\(m["id"].text)/accept") } }.buttonStyle(.borderedProminent)
                                    Button("Reject") { Task { await act("memory/\(m["id"].text)/reject") } }
                                }
                                Button("Forget", role: .destructive) { Task { await act("memory/\(m["id"].text)", method: .delete) } }
                            }.controlSize(.small)
                        }
                    }
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { adding = true } label: { Label("Add", systemImage: "plus") }
                Menu {
                    Button("Export this tab as JSON") { Task { _ = try? await session.client?.post("memory/exports", json(["tab": .string(tab), "format": "json"])) } }
                    Button("Export this tab as CSV") { Task { _ = try? await session.client?.post("memory/exports", json(["tab": .string(tab), "format": "csv"])) } }
                    if session.has("knowledge:manage") { Divider(); Button("Consolidate now") { Task { await act("memory/consolidate") } }; Button("Reindex") { Task { await act("memory/reindex") } } }
                } label: { Label("More", systemImage: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $adding) {
            FormSheet(title: "Add a memory", fields: [FormField("text", "Text", .multiline, required: true), FormField("scope", "Scope", .select(["user", "workspace"]), defaultValue: "user"), FormField("type", "Type", .select(["fact", "preference", "episodic", "progress", "quirk"]), defaultValue: "fact"), FormField("label", "Label", .label, defaultValue: "internal")]) { body in
                _ = try await session.client!.post("memory", body); await load()
            }
        }
        .task { await load() }
    }
    private func count(_ t: String) -> String { data.value?["counts"][t].int.map { " (\($0))" } ?? "" }
    private func load() async { data = await loaded { try await session.client!.get("memory", query: ["tab": tab]) } }
    private func act(_ path: String, method: HTTPMethod = .post) async {
        problem = nil
        do { _ = try await session.client!.json(method, path); await load() } catch { problem = error.asProblem }
    }
}
