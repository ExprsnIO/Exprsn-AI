import SwiftUI
import UniformTypeIdentifiers

/// Files: browse folders, upload, download, versions, share, trash.
struct FilesScreen: View {
    @Environment(AppSession.self) private var session
    @State private var folder: String?
    @State private var listing: Loadable<JSONValue> = .idle
    @State private var path: [JSONValue] = []
    @State private var uploading = false
    @State private var problem: APIProblem?
    @State private var selected: JSONValue?
    @State private var newFolder = false
    @State private var folderName = ""
    @State private var saving: BundleDocument?
    @State private var saveName = "file"
    @State private var showSave = false
    @State private var usage: JSONValue = .null
    @State private var showTrash = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                Button("Root") { folder = nil; path = [] }.buttonStyle(.borderless)
                ForEach(Array(path.enumerated()), id: \.offset) { i, p in
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Exprsn.muted)
                    Button(p["name"].text) { folder = p["id"].text; path = Array(path.prefix(i + 1)) }.buttonStyle(.borderless)
                }
                Spacer()
                if !usage.isNull, let max = usage["workspace"]["maxBytes"].double { Meter(label: "Workspace storage", valueText: "\(Fmt.bytes(usage["workspace"]["usedBytes"].double)) of \(Fmt.bytes(max))", fraction: (usage["workspace"]["usedBytes"].double ?? 0) / max).frame(width: 220) }
            }.padding(12)
            if let problem { Notice(.danger, problem.title, problem.detail).padding(.horizontal, 12) }
            LoadableView(state: listing, retry: load) { l in
                HStack(spacing: 0) {
                    List {
                        if showTrash {
                            Section("Trash") {
                                ForEach(l["folders"].array + l["files"].array, id: \.self) { f in HStack { Image(systemName: f["size"].isNull ? "folder" : "doc"); Text(f["name"].text); Spacer(); Button("Restore") { Task { await act(.post, "files/trash/restore", json(["kind": f["size"].isNull ? "folder" : "file", "id": .string(f["id"].text)])) } }.controlSize(.small) } }
                                Button("Empty trash", role: .destructive) { Task { await act(.post, "files/trash/empty") } }
                            }
                        } else {
                            Section("Folders") {
                                ForEach(l["folders"].array, id: \.self) { f in
                                    Button { path.append(f); folder = f["id"].text } label: { HStack { Image(systemName: "folder.fill").foregroundStyle(Exprsn.accent); Text(f["name"].text); Spacer() } }.buttonStyle(.plain)
                                        .contextMenu { Button("Delete", role: .destructive) { Task { await act(.delete, "files/folders/\(f["id"].text)") } } }
                                }
                            }
                            Section("Files") {
                                ForEach(l["files"].array, id: \.self) { f in
                                    HStack {
                                        Image(systemName: "doc").foregroundStyle(Exprsn.fg2)
                                        VStack(alignment: .leading, spacing: 1) { Text(f["name"].text); Text("\(Fmt.bytes(f["size"].double)) · \(f["type"].text) · \(f["ownerName"].text) · \(Fmt.when(f["updatedAt"].isNull ? f["createdAt"] : f["updatedAt"]))").font(.caption).foregroundStyle(Exprsn.muted) }
                                        Spacer(); Pill(f["state"].text); LabelBadge(f["label"].string, small: true)
                                    }
                                    .contentShape(Rectangle()).onTapGesture { selected = f }
                                    .contextMenu {
                                        Button("Download") { Task { await download(f) } }
                                        Button("Delete", role: .destructive) { Task { await act(.delete, "files/\(f["id"].text)") } }
                                    }
                                }
                            }
                        }
                    }
                    if let f = selected { Divider(); FileDetail(file: f, download: { await download(f) }, reload: load).frame(width: 340) }
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Toggle(isOn: $showTrash) { Label("Trash", systemImage: "trash") }.onChange(of: showTrash) { _, _ in Task { await load() } }
                Button { newFolder = true } label: { Label("New folder", systemImage: "folder.badge.plus") }
                Button { uploading = true } label: { Label("Upload", systemImage: "arrow.up.doc") }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
        }
        .alert("New folder", isPresented: $newFolder) { TextField("Name", text: $folderName); Button("Create") { Task { await act(.post, "files/folders", json(["name": .string(folderName), "parentId": folder.map { .string($0) }])); folderName = "" } }; Button("Cancel", role: .cancel) {} }
        .fileImporter(isPresented: $uploading, allowedContentTypes: [.data], allowsMultipleSelection: true) { r in
            guard case .success(let urls) = r else { return }
            Task {
                for url in urls {
                    let ok = url.startAccessingSecurityScopedResource(); defer { if ok { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else { continue }
                    do { _ = try await session.client!.upload("files/uploads", data: data, contentType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream", query: ["name": url.lastPathComponent, "label": "internal", "folder": folder]) } catch { problem = error.asProblem }
                }
                await load()
            }
        }
        .fileExporter(isPresented: $showSave, document: saving, contentType: UTType(filenameExtension: (saveName as NSString).pathExtension) ?? .data, defaultFilename: saveName) { _ in }
        .task(id: folder) { await load(); usage = (try? await session.client?.get("files/usage")) ?? .null }
    }

    private func load() async {
        listing = await loaded { try await session.client!.get(showTrash ? "files/trash" : "files/browse", query: ["folder": folder]) }
    }
    private func act(_ m: HTTPMethod, _ path: String, _ body: JSONValue? = nil) async {
        problem = nil
        do { _ = try await session.client!.json(m, path, body: body); await load() } catch { problem = error.asProblem }
    }
    private func download(_ f: JSONValue) async {
        do { let (d, _, name) = try await session.client!.download("files/\(f["id"].text)/content"); saving = BundleDocument(data: d); saveName = name ?? f["name"].text; showSave = true } catch { problem = error.asProblem }
    }
}

struct FileDetail: View {
    @Environment(AppSession.self) private var session
    var file: JSONValue
    var download: () async -> Void
    var reload: () async -> Void
    @State private var versions: [JSONValue] = []
    @State private var shares: [JSONValue] = []
    @State private var link: String?
    @State private var tags = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(file["name"].text).font(.headline)
                HStack { Pill(file["state"].text); LabelBadge(file["label"].string, small: true); Text(Fmt.bytes(file["size"].double)).font(.caption) }
                KeyValueRow(key: "Type", value: file["type"].text)
                KeyValueRow(key: "Owner", value: file["ownerName"].text)
                KeyValueRow(key: "Version", value: file["currentVersion"].text)
                HStack { Button("Download") { Task { await download() } }; Button("Save tags") { Task { _ = try? await session.client?.put("files/\(file["id"].text)/tags", json(["tags": .array(tags.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) })])) } } }.controlSize(.small)
                TextField("Tags, comma separated", text: $tags).textFieldStyle(.roundedBorder)
                Eyebrow("Versions")
                ForEach(versions, id: \.self) { v in HStack { Text("v\(v["number"].text)"); Pill(v["state"].text); Text(Fmt.bytes(v["size"].double)).font(.caption); Spacer(); Text(Fmt.when(v["createdAt"])).font(.caption).foregroundStyle(Exprsn.muted); Button("Restore") { Task { _ = try? await session.client?.post("files/\(file["id"].text)/versions/\(v["number"].text)/restore"); await reload() } }.controlSize(.mini) } }
                Eyebrow("Shares")
                ForEach(shares, id: \.self) { s in HStack { Text(s["userName"].string ?? s["workspaceName"].string ?? s["group"].string ?? "Link"); Pill(s["kind"].text, tone: .info); Pill(s["state"].text); Spacer(); Button("Revoke") { Task { _ = try? await session.client?.delete("files/\(file["id"].text)/shares/\(s["id"].text)"); await loadMeta() } }.controlSize(.mini) } }
                Button("Create a link (24 h)") { Task { let r = try? await session.client?.post("files/\(file["id"].text)/shares", json(["kind": "link", "expiresInHours": 24])); link = r?["url"].string ?? r?["token"].string; await loadMeta() } }.controlSize(.small)
                if let link { Text(link).font(.exprsnMonoSmall).textSelection(.enabled) }
            }.padding(12)
        }
        .task(id: file["id"].text) { tags = file["tags"].array.map(\.text).joined(separator: ", "); await loadMeta() }
    }
    private func loadMeta() async {
        versions = (try? await session.client?.get("files/\(file["id"].text)/versions"))?.rows(itemsKey: nil) ?? []
        shares = (try? await session.client?.get("files/\(file["id"].text)/shares"))?.rows(itemsKey: nil) ?? []
    }
}
