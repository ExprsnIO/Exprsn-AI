import SwiftUI
import SwiftData

/// Prompts: the server's prompt library (render a template into the chat draft) and prompts kept on the device.
struct PromptsScreen: View {
    @Environment(AppSession.self) private var session
    @Environment(\.modelContext) private var context
    @Query(sort: \LocalPrompt.updatedAt, order: .reverse) private var local: [LocalPrompt]
    @State private var library: Loadable<JSONValue> = .idle
    @State private var selected: JSONValue?
    @State private var detail: JSONValue?
    @State private var variables: [String: String] = [:]
    @State private var rendered: String?
    @State private var editing: LocalPrompt?
    @State private var tab = "library"
    @State private var creating = false

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) { Text("Library").tag("library"); Text("On this device (\(local.count))").tag("local") }.pickerStyle(.segmented).frame(maxWidth: 360).padding(12)
            if tab == "local" { localList } else { libraryView }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if tab == "local" { Button { editing = LocalPrompt(title: "", body: ""); } label: { Label("New", systemImage: "plus") } }
                else if library.value?["canManage"].bool == true { Button { creating = true } label: { Label("New template", systemImage: "plus") } }
            }
        }
        .sheet(item: $editing) { p in LocalPromptEditor(prompt: p) }
        .sheet(isPresented: $creating) {
            FormSheet(title: "New prompt template", fields: [FormField("name", "Name", required: true), FormField("description", "Description"), FormField("body", "Body ({{name}} marks a variable)", .multiline, required: true), FormField("label", "Label", .label, defaultValue: "internal")]) { body in
                _ = try await session.client!.post("prompts", body); await load()
            }
        }
        .task { await load() }
    }

    private var libraryView: some View {
        LoadableView(state: library, retry: load) { lib in
            HStack(spacing: 0) {
                List(lib["templates"].array, id: \.self, selection: $selected) { t in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack { Text(t["name"].text).font(.body.weight(.medium)); Pill(t["state"].text); Spacer(); LabelBadge(t["label"].string, small: true) }
                        Text("\(t["scope"].text) · v\(t["publishedVersion"].text) · \(t["description"].text)").font(.caption).foregroundStyle(Exprsn.muted).lineLimit(1)
                    }.tag(t)
                }.listStyle(.plain).frame(minWidth: 280, idealWidth: 340)
                Divider()
                if let d = detail {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(d["name"].text).font(.title2.weight(.semibold))
                            if let desc = d["description"].string { Text(desc).foregroundStyle(Exprsn.fg2) }
                            let v = d["versions"].array.last ?? .null
                            Text(v["body"].text).font(.exprsnMonoSmall).padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Exprsn.panel2, in: RoundedRectangle(cornerRadius: 8))
                            if !v["variables"].array.isEmpty {
                                Eyebrow("Variables")
                                ForEach(v["variables"].array, id: \.self) { vv in
                                    TextField(vv["name"].text, text: Binding(get: { variables[vv["name"].text] ?? vv["default"].text }, set: { variables[vv["name"].text] = $0 }), prompt: Text(vv["description"].text)).textFieldStyle(.roundedBorder)
                                }
                            }
                            HStack {
                                Button("Render") { Task { await render(d) } }.buttonStyle(.borderedProminent)
                                if let r = rendered { Button("Use in Chat") { useInChat(r) } }
                                if lib["canManage"].bool == true {
                                    Menu("Lifecycle") {
                                        Button("Publish latest") { Task { _ = try? await session.client?.post("prompts/\(d["id"].text)/state", json(["state": "published"])); await load() } }
                                        Button("Deprecate") { Task { _ = try? await session.client?.post("prompts/\(d["id"].text)/state", json(["state": "deprecated"])); await load() } }
                                        Button("Retire", role: .destructive) { Task { _ = try? await session.client?.post("prompts/\(d["id"].text)/state", json(["state": "retired"])); await load() } }
                                    }
                                }
                            }
                            if let r = rendered { Text(r).padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Exprsn.panel, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Exprsn.line)).textSelection(.enabled) }
                        }.padding(16)
                    }
                } else { EmptyState(title: "Choose a template", systemImage: "text.quote") }
            }
        }
        .onChange(of: selected) { _, t in Task { rendered = nil; variables = [:]; if let t { detail = try? await session.client?.get("prompts/\(t["id"].text)") } } }
    }

    private var localList: some View {
        List {
            if local.isEmpty { Text("Prompts you keep on this device. They travel in the app export.").foregroundStyle(Exprsn.muted) }
            ForEach(local) { p in
                VStack(alignment: .leading, spacing: 3) {
                    HStack { Text(p.title).font(.body.weight(.medium)); Spacer(); ForEach(p.tags, id: \.self) { Pill($0, tone: .neutral) } }
                    Text(p.body).font(.callout).foregroundStyle(Exprsn.fg2).lineLimit(3)
                    HStack { Button("Use in Chat") { useInChat(p.body) }; Button("Edit") { editing = p }; Button("Delete", role: .destructive) { context.delete(p) } }.controlSize(.small).buttonStyle(.borderless)
                }
            }
        }
    }

    private func load() async { library = await loaded { try await session.client!.get("prompts") } }
    private func render(_ d: JSONValue) async {
        let r = try? await session.client?.post("prompts/\(d["id"].text)/render", json(["variables": .object(variables.mapValues { .string($0) })]))
        rendered = r?["text"].string ?? r?["detail"].string
    }
    private func useInChat(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
        NotificationCenter.default.post(name: .navigate, object: Screen.chat)
    }
}

struct LocalPromptEditor: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    var prompt: LocalPrompt
    @State private var title = ""
    @State private var body_ = ""
    @State private var tags = ""
    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                TextEditor(text: $body_).frame(minHeight: 160)
                TextField("Tags, comma separated", text: $tags)
            }
            .formStyle(.grouped)
            .navigationTitle(prompt.title.isEmpty ? "New prompt" : "Edit prompt")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") {
                    prompt.title = title; prompt.body = body_; prompt.tags = tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }; prompt.updatedAt = Date()
                    if prompt.modelContext == nil { context.insert(prompt) }
                    try? context.save(); dismiss()
                }.disabled(title.isEmpty || body_.isEmpty) }
            }
            .onAppear { title = prompt.title; body_ = prompt.body; tags = prompt.tags.joined(separator: ", ") }
        }.frame(minWidth: 460, minHeight: 360)
    }
}
