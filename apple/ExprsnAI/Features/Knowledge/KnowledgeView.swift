import SwiftUI
import UniformTypeIdentifiers

/// Knowledge: bases, their documents and sources, uploads and search.
struct KnowledgeScreen: View {
    @Environment(AppSession.self) private var session
    @State private var bases: Loadable<[JSONValue]> = .idle
    @State private var selected: String?
    @State private var creating = false

    var body: some View {
        LoadableView(state: bases, retry: load) { list in
            HStack(spacing: 0) {
                List(list, id: \.self, selection: Binding(get: { selected.flatMap { s in list.first { $0["id"].text == s } } }, set: { selected = $0?["id"].text })) { b in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack { Text(b["name"].text).font(.body.weight(.medium)); Pill(b["status"].text); Spacer(); LabelBadge(b["label"].string, small: true) }
                        Text("\(b["documents"].text.isEmpty ? "" : b["documents"].text + " documents · ")\(b["embedModel"].text) · \(b["sharing"].text)").font(.caption).foregroundStyle(Exprsn.muted)
                    }
                }.listStyle(.plain).frame(minWidth: 280, idealWidth: 340)
                Divider()
                if let id = selected { KnowledgeBaseDetail(id: id, reload: load) } else { EmptyState(title: "Choose a base", text: "Documents, sources, search and sharing.", systemImage: "books.vertical") }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if session.has("knowledge:manage") { Button { creating = true } label: { Label("New base", systemImage: "plus") } }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
        }
        .sheet(isPresented: $creating) {
            FormSheet(title: "New knowledge base", fields: [FormField("name", "Name", required: true), FormField("description", "Description"), FormField("label", "Label", .label, defaultValue: "internal"), FormField("embedModel", "Embedding model", required: true, help: "An approved model with the embedding capability."), FormField("sharing", "Sharing", .select(["members", "curators"]), defaultValue: "members")]) { body in
                _ = try await session.client!.post("knowledge/bases", body); await load()
            }
        }
        .task { await load() }
    }
    private func load() async { bases = await loaded { (try await session.client!.get("knowledge/bases")).rows(itemsKey: nil) } }
}

struct KnowledgeBaseDetail: View {
    @Environment(AppSession.self) private var session
    var id: String
    var reload: () async -> Void
    @State private var base: Loadable<JSONValue> = .idle
    @State private var documents: [JSONValue] = []
    @State private var query = ""
    @State private var results: [JSONValue] = []
    @State private var uploading = false
    @State private var problem: APIProblem?
    @State private var addingSource = false
    @State private var tab = "documents"

    var body: some View {
        LoadableView(state: base, retry: load) { b in
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text(b["name"].text).font(.title2.weight(.semibold)); Pill(b["status"].text); LabelBadge(b["label"].string, small: true); Spacer()
                        if session.has("knowledge:manage") {
                            Button(b["status"].string == "published" ? "Unpublish" : "Publish") { Task { await act(.patch, "knowledge/bases/\(id)", json(["status": b["status"].string == "published" ? "draft" : "published"])) } }
                            Button("Reindex") { Task { await act(.post, "knowledge/bases/\(id)/reindex") } }
                            Button("Refresh sources") { Task { await act(.post, "knowledge/bases/\(id)/refresh", json(["what": "all"])) } }
                        }
                        Button { uploading = true } label: { Label("Upload", systemImage: "arrow.up.doc") }
                    }.controlSize(.small)
                    if let d = b["description"].string { Text(d).font(.callout).foregroundStyle(Exprsn.fg2) }
                    Text("Embedding \(b["embedModel"].text) · vectors \(b["vectorStore"].text) · \(b["sources"].array.count) sources · \(b["quarantined"].text.isEmpty ? "" : b["quarantined"].text + " quarantined")").font(.caption).foregroundStyle(Exprsn.muted)
                    if let problem { Notice(.danger, problem.title, problem.detail) }
                    Picker("", selection: $tab) { Text("Documents").tag("documents"); Text("Search").tag("search"); Text("Sources").tag("sources"); Text("Access").tag("access") }.pickerStyle(.segmented)
                }.padding(12)
                Divider()
                switch tab {
                case "search":
                    VStack(spacing: 8) {
                        TextField("Search this base", text: $query).textFieldStyle(.roundedBorder).onSubmit { Task { await search() } }.padding(12)
                        List(results, id: \.self) { r in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack { Text(r["title"].string ?? r["document"].string ?? r["name"].text).font(.body.weight(.medium)); Spacer(); Text(String(format: "%.2f", r["score"].double ?? 0)).font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted) }
                                Text(r["text"].string ?? r["passage"].string ?? r["chunk"].text).font(.callout).foregroundStyle(Exprsn.fg2).lineLimit(4)
                            }
                        }.listStyle(.plain)
                    }
                case "sources":
                    List {
                        ForEach(b["sources"].array, id: \.self) { s in
                            HStack {
                                VStack(alignment: .leading) { HStack { Text(s["kind"].text).font(.body.weight(.medium)); Pill(s["state"].text) }; Text(s["location"].text).font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted); Text("\(s["schedule"].text) · last sync \(Fmt.when(s["lastSyncAt"]))").font(.caption).foregroundStyle(Exprsn.muted) }
                                Spacer()
                                Button("Sync") { Task { await act(.post, "knowledge/sources/\(s["id"].text)/sync") } }.controlSize(.small)
                                Button("Remove", role: .destructive) { Task { await act(.delete, "knowledge/sources/\(s["id"].text)") } }.controlSize(.small)
                            }
                        }
                        if session.has("knowledge:manage") { Button("Add a source…") { addingSource = true } }
                    }
                case "access":
                    ResourceScreen(spec: ResourceSpec(title: "Access", tabs: [ResourceTab(title: "Grants", path: "knowledge/bases/\(id)/access", columns: [Column("Kind", "kind", .pill), Column("Name", "name"), Column("Access", "access", .pill), Column("By", "createdBy")], actions: [RowAction(title: "Remove", method: .delete, path: { "knowledge/bases/\(id)/access/\($0["id"].text)" }, destructive: true)], create: CreateSpec(title: "Share", path: "knowledge/bases/\(id)/access", fields: [FormField("kind", "Kind", .select(["workspace", "user", "profile"]), defaultValue: "user"), FormField("id", "Id", required: true), FormField("access", "Access", .select(["read", "manage"]), defaultValue: "read")]))]))
                default:
                    List(documents, id: \.self) { d in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack { Text(d["name"].string ?? d["title"].text).font(.body.weight(.medium)); Pill(d["state"].text); LabelBadge(d["label"].string, small: true) }
                                Text("\(d["type"].text) · \(Fmt.bytes(d["size"].double)) · \(d["chunks"].text) chunks · \(d["categories"].text)").font(.caption).foregroundStyle(Exprsn.muted)
                            }
                            Spacer()
                            Menu {
                                Button("Reindex") { Task { await act(.post, "knowledge/documents/\(d["id"].text)/reindex") } }
                                Button("Delete", role: .destructive) { Task { await act(.delete, "knowledge/documents/\(d["id"].text)") } }
                            } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize()
                        }
                    }.listStyle(.plain)
                }
            }
        }
        .task(id: id) { await load() }
        .fileImporter(isPresented: $uploading, allowedContentTypes: [.data], allowsMultipleSelection: true) { r in
            guard case .success(let urls) = r else { return }
            Task {
                for url in urls {
                    let ok = url.startAccessingSecurityScopedResource(); defer { if ok { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else { continue }
                    do { _ = try await session.client!.upload("knowledge/bases/\(id)/uploads", data: data, contentType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream", query: ["name": url.lastPathComponent, "label": base.value?["label"].string ?? "internal"]) } catch { problem = error.asProblem }
                }
                await load()
            }
        }
        .sheet(isPresented: $addingSource) {
            FormSheet(title: "Add a source", fields: [FormField("kind", "Kind", .select(["s3", "git", "database", "web", "dataset"]), required: true, defaultValue: "git"), FormField("location", "Location", required: true, help: "s3://bucket/prefix/, an https git URL, pg: schema.view, or a site URL."), FormField("schedule", "Schedule", .select(["manual", "15m", "hourly", "daily"]), defaultValue: "daily"), FormField("labelFloor", "Label floor", .label, defaultValue: "internal"), FormField("connectionId", "Connection id (database)")]) { body in
                _ = try await session.client!.post("knowledge/bases/\(id)/sources", body); await load()
            }
        }
    }
    private func load() async {
        base = await loaded { try await session.client!.get("knowledge/bases/\(id)") }
        documents = (try? await session.client?.get("knowledge/bases/\(id)/documents"))?.rows(itemsKey: nil) ?? []
    }
    private func search() async { results = (try? await session.client?.get("knowledge/bases/\(id)/search", query: ["q": query]))?.rows(itemsKey: "results") ?? [] }
    private func act(_ m: HTTPMethod, _ path: String, _ body: JSONValue? = nil) async {
        problem = nil
        do { _ = try await session.client!.json(m, path, body: body); await load(); await reload() } catch { problem = error.asProblem }
    }
}
