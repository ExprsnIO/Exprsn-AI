import SwiftUI
import SwiftData
import UniformTypeIdentifiers

/// Chat: the conversation list, the thread and the composer, as the console's Chat screen.
struct ChatScreen: View {
    @Environment(AppSession.self) private var session
    @Environment(\.modelContext) private var context
    @State private var store: ChatStore?
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    var body: some View {
        Group {
            if let store {
                #if os(iOS)
                if sizeClass == .compact { CompactChat(store: store) } else { WideChat(store: store) }
                #else
                WideChat(store: store)
                #endif
            } else { ProgressView() }
        }
        .task(id: session.server?.id) {
            guard let client = session.client, let sid = session.server?.id else { return }
            let s = ChatStore(client: client, serverId: sid)
            store = s
            await s.loadAll()
        }
        .onReceive(NotificationCenter.default.publisher(for: .newConversation)) { _ in store?.newConversation() }
        .onReceive(NotificationCenter.default.publisher(for: .harnessSendChat)) { n in
            guard let store, let prompt = n.object as? String else { return }
            store.newConversation(); store.draft = prompt
            if let name = ProcessInfo.processInfo.environment["EXPRSN_SNAPSHOT_CHAT_PROFILE"], let p = store.profiles.first(where: { $0.name == name }) { store.selectedProfileId = p.id; store.think = p.thinkDefault ?? .off }
            Task { await store.send(context: context) }
        }
    }
}

struct WideChat: View {
    @Bindable var store: ChatStore
    @State private var listVisible = true
    var body: some View {
        HStack(spacing: 0) {
            if listVisible {
                ConversationList(store: store).frame(width: 280)
                Divider()
            }
            ThreadView(store: store)
        }
        .toolbar {
            ToolbarItem(placement: .navigation) { Button { withAnimation { listVisible.toggle() } } label: { Label("Conversations", systemImage: "sidebar.left") } }
        }
    }
}

#if os(iOS)
struct CompactChat: View {
    @Bindable var store: ChatStore
    var body: some View {
        if store.selectedId == nil && store.detail.value == nil && !store.conversations.isLoading && store.filteredConversations.isEmpty == false && store.draft.isEmpty {
            ConversationList(store: store)
        } else if store.selectedId == nil {
            ThreadView(store: store).toolbar { ToolbarItem(placement: .navigation) { Button("Conversations") { store.newConversation(); } } }
        } else {
            ThreadView(store: store).toolbar { ToolbarItem(placement: .navigation) { Button { store.newConversation() } label: { Label("Back", systemImage: "chevron.left") } } }
        }
    }
}
#endif

struct ConversationList: View {
    @Bindable var store: ChatStore
    @Environment(\.modelContext) private var context
    @State private var renaming: ConversationSummary?
    @State private var newName = ""
    @State private var newFolder = false
    @State private var folderName = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Menu {
                    Button("All conversations") { store.selectedFolder = nil; Task { await store.loadConversations() } }
                    Button("No folder") { store.selectedFolder = "none"; Task { await store.loadConversations() } }
                    if !store.folders.isEmpty { Divider() }
                    ForEach(store.folders) { f in
                        Button("\(String(repeating: "  ", count: f.depth ?? 0))\(f.name) (\(f.conversations ?? 0))") { store.selectedFolder = f.id; Task { await store.loadConversations() } }
                    }
                    Divider()
                    Button("New folder…") { newFolder = true }
                    Toggle("Show archived", isOn: Binding(get: { store.showArchived }, set: { store.showArchived = $0; Task { await store.loadConversations() } }))
                } label: {
                    Label(store.selectedFolder == nil ? "All" : store.selectedFolder == "none" ? "No folder" : (store.folders.first { $0.id == store.selectedFolder }?.name ?? "Folder"), systemImage: "folder")
                }.menuStyle(.borderlessButton).fixedSize()
                Spacer()
                Button { store.newConversation() } label: { Label("New", systemImage: "square.and.pencil") }.labelStyle(.iconOnly).help("New conversation")
            }
            .padding(10)
            TextField("Search conversations", text: $store.query).textFieldStyle(.roundedBorder).padding(.horizontal, 10).padding(.bottom, 6)
            LoadableView(state: store.conversations, retry: { await store.loadConversations() }) { _ in
                List(store.filteredConversations, selection: Binding(get: { store.selectedId }, set: { id in if let id { Task { await store.open(id, context: context) } } })) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.title?.isEmpty == false ? c.title! : "Untitled").lineLimit(1).font(.body.weight(store.selectedId == c.id ? .semibold : .regular))
                        HStack(spacing: 6) {
                            LabelBadge(c.label, small: true)
                            Text(Fmt.when(c.updated)).font(.caption2).foregroundStyle(Exprsn.muted)
                            if c.archived == true { Pill("archived", tone: .neutral) }
                        }
                    }
                    .tag(c.id)
                    .contextMenu {
                        Button("Rename…") { renaming = c; newName = c.title ?? "" }
                        Button(c.archived == true ? "Unarchive" : "Archive") { Task { await store.archive(c, c.archived != true) } }
                        Menu("Move to folder") {
                            Button("No folder") { Task { await store.file(c, in: nil) } }
                            ForEach(store.folders) { f in Button(f.name) { Task { await store.file(c, in: f.id) } } }
                        }
                        Divider()
                        Button("Delete", role: .destructive) { Task { await store.delete(c) } }
                    }
                }
                .listStyle(.plain)
            }
        }
        .background(Exprsn.nav)
        .alert("Rename conversation", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newName)
            Button("Rename") { if let c = renaming { Task { await store.rename(c, to: newName) } }; renaming = nil }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .alert("New folder", isPresented: $newFolder) {
            TextField("Name", text: $folderName)
            Button("Create") { Task { await store.createFolder(folderName) }; folderName = "" }
            Button("Cancel", role: .cancel) {}
        }
    }
}

/// The open conversation: its active branch and the composer.
struct ThreadView: View {
    @Bindable var store: ChatStore
    @Environment(AppSession.self) private var session
    @Environment(\.modelContext) private var context
    @State private var editing: ChatMessage?
    @State private var editText = ""
    @State private var reporting: ChatMessage?
    @State private var reportReason = "harmful"
    @State private var reportNote = ""
    @State private var sharing = false
    @State private var exporting = false
    @State private var importingFile = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if let d = store.detail.value {
                            ForEach(d.activeBranch) { m in
                                MessageBubble(message: m, siblings: d.siblings(of: m), store: store, onEdit: { editing = m; editText = m.content }, onReport: { reporting = m })
                                    .id(m.id)
                            }
                        } else if store.detail.isLoading {
                            ProgressView().frame(maxWidth: .infinity).padding(40)
                        } else if let p = store.detail.problem {
                            ProblemView(problem: p)
                        } else {
                            welcome
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: 860)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: store.detail.value?.messages.last?.content) { _, _ in
                    if let last = store.detail.value?.activeBranch.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            Divider()
            Composer(store: store, importingFile: $importingFile)
        }
        .background(Exprsn.bg)
        .navigationTitle(store.detail.value?.title ?? "New conversation")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let d = store.detail.value {
                    LabelBadge(d.label, small: true)
                    Menu {
                        Button { sharing = true } label: { Label("Share…", systemImage: "square.and.arrow.up") }
                        Button { exporting = true } label: { Label("Export…", systemImage: "doc.text") }
                        Button { copyTranscript() } label: { Label("Copy transcript", systemImage: "doc.on.doc") }
                    } label: { Label("Actions", systemImage: "ellipsis.circle") }
                }
            }
        }
        .sheet(isPresented: $sharing) { if let d = store.detail.value { ShareSheet(conversationId: d.id) } }
        .sheet(isPresented: $exporting) { if let d = store.detail.value { ExportConversationSheet(conversationId: d.id, title: d.title) } }
        .sheet(item: $editing) { m in
            NavigationStack {
                Form { TextEditor(text: $editText).frame(minHeight: 160) }
                    .navigationTitle("Edit and ask again")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { editing = nil } }
                        ToolbarItem(placement: .confirmationAction) { Button("Send") { Task { await store.edit(m, content: editText) }; editing = nil } }
                    }
            }.frame(minWidth: 460, minHeight: 280)
        }
        .sheet(item: $reporting) { m in
            NavigationStack {
                Form {
                    Picker("Reason", selection: $reportReason) { ForEach(["harmful", "wrong", "leak", "policy", "other"], id: \.self) { Text($0.capitalized).tag($0) } }
                    TextField("Note (optional)", text: $reportNote)
                    Text("The flag goes to the reviewers of this workspace with the answer's text.").font(.caption).foregroundStyle(Exprsn.muted)
                }
                .formStyle(.grouped)
                .navigationTitle("Report this answer")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { reporting = nil } }
                    ToolbarItem(placement: .confirmationAction) { Button("Report") { Task { await store.report(m, reason: reportReason, note: reportNote) }; reporting = nil } }
                }
            }.frame(minWidth: 420, minHeight: 240)
        }
        .fileImporter(isPresented: $importingFile, allowedContentTypes: [.data], allowsMultipleSelection: true) { r in
            guard case .success(let urls) = r else { return }
            Task {
                for url in urls {
                    let ok = url.startAccessingSecurityScopedResource(); defer { if ok { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else { continue }
                    let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                    await store.attach(data: data, name: url.lastPathComponent, type: type, label: store.detail.value?.label ?? "internal")
                }
            }
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Start a conversation").font(.title2.weight(.semibold))
            Text("Pick a profile below, write your question, and send. Answers stream in as they are generated; thinking and tool calls show under each answer. Attach files with the paperclip; they are scanned before the model sees them.")
                .foregroundStyle(Exprsn.fg2)
            if let p = store.selectedProfile {
                HStack(spacing: 8) {
                    Pill(p.residency == "loaded" ? "loaded" : "cold", tone: p.residency == "loaded" ? .ok : .warn)
                    if p.vision == true { Pill("vision", tone: .info) }
                    if let t = p.tools, !t.isEmpty { Pill("\(t.count) tools", tone: .info) }
                    LabelBadge(p.label, small: true)
                }
                if let d = p.description { Text(d).font(.callout).foregroundStyle(Exprsn.muted) }
            }
        }
        .padding(.top, 40)
    }

    private func copyTranscript() {
        guard let d = store.detail.value else { return }
        let text = d.activeBranch.map { "**\($0.role == "user" ? "You" : ($0.profile ?? "Assistant"))**\n\n\($0.content)" }.joined(separator: "\n\n---\n\n")
        #if os(macOS)
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}

struct MessageBubble: View {
    var message: ChatMessage
    var siblings: [ChatMessage]
    var store: ChatStore
    var onEdit: () -> Void
    var onReport: () -> Void
    @State private var showThinking = false
    @Environment(AppSession.self) private var session

    private var isUser: Bool { message.role == "user" }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(isUser ? "You" : (message.profile ?? "Assistant")).font(.caption.weight(.semibold)).foregroundStyle(Exprsn.fg2)
                if let model = message.model, !isUser { Text(model).font(.caption2).foregroundStyle(Exprsn.muted) }
                if message.isGenerating { ProgressView().controlSize(.mini) }
                if message.state == "stopped" || message.state == "failed" || message.state == "interrupted" || message.state == "held" { Pill(message.state) }
                if siblings.count > 1, let i = siblings.firstIndex(where: { $0.id == message.id }) {
                    HStack(spacing: 2) {
                        Button { Task { await store.setHead(siblings[max(0, i - 1)]) } } label: { Image(systemName: "chevron.left") }.disabled(i == 0)
                        Text("\(i + 1)/\(siblings.count)").font(.caption2).monospacedDigit()
                        Button { Task { await store.setHead(siblings[min(siblings.count - 1, i + 1)]) } } label: { Image(systemName: "chevron.right") }.disabled(i == siblings.count - 1)
                    }.buttonStyle(.borderless).foregroundStyle(Exprsn.muted)
                }
            }
            if let t = message.thinking, !t.isEmpty, !isUser {
                DisclosureGroup(isExpanded: $showThinking) { Text(t).font(.callout).foregroundStyle(Exprsn.fg2).textSelection(.enabled).padding(.top, 4) } label: { Label("Thinking", systemImage: "brain").font(.caption).foregroundStyle(Exprsn.muted) }
            }
            if !message.guardInfo.isNull, let action = message.guardInfo["action"].string {
                Notice(action == "block" ? .danger : .warn, "Guardrail: \(action)", message.guardInfo["reason"].string ?? message.guardInfo["rules"].text)
            }
            if message.content.isEmpty && message.isGenerating {
                Text("…").foregroundStyle(Exprsn.muted)
            } else {
                MarkdownText(message.content)
                    .padding(12)
                    .background(isUser ? Exprsn.bubble : Exprsn.panel, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(isUser ? Color.clear : Exprsn.line))
            }
            if !message.tools.isEmpty {
                ForEach(Array(message.tools.enumerated()), id: \.offset) { _, t in
                    HStack(spacing: 6) {
                        Image(systemName: "wrench").foregroundStyle(Exprsn.muted)
                        Text(t["name"].text).font(.caption.weight(.medium))
                        Text(t["expression"].string ?? t["arguments"].text).font(.exprsnMonoSmall).lineLimit(1).foregroundStyle(Exprsn.fg2)
                        if let r = t["result"].object["exact"]?.string ?? t["result"].string { Text("= \(r)").font(.exprsnMonoSmall) }
                        if let e = t["error"].string { Text(e).font(.caption).foregroundStyle(Exprsn.dangerFg) }
                    }
                }
            }
            let sources = message.citations.map { c -> String in
                let name = [c["title"].string, c["name"].string, c["docName"].string, c["document"]["name"].string, c["document"].string, c["kbName"].string, c["kb"]["name"].string, c["memory"].string].compactMap { $0 }.first ?? (c["kind"].string ?? "")
                let where_ = c["passage"].string.map { " – " + $0.prefix(120) } ?? ""
                return name.isEmpty && where_.isEmpty ? "" : name + where_ + (c["restricted"].bool == true ? " (above your clearance)" : "")
            }.filter { !$0.isEmpty }
            if !sources.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Eyebrow("Sources")
                    ForEach(Array(sources.enumerated()), id: \.offset) { i, t in Text("[\(i + 1)] \(t)").font(.caption).foregroundStyle(Exprsn.fg2).lineLimit(2) }
                }
            }
            if !message.attachments.isEmpty {
                HStack { ForEach(Array(message.attachments.enumerated()), id: \.offset) { _, a in Label(a["name"].text, systemImage: "paperclip").font(.caption) } }
            }
            if let e = message.error { Text(e).font(.caption).foregroundStyle(Exprsn.dangerFg) }
            HStack(spacing: 10) {
                if !isUser {
                    if message.isGenerating { Button { Task { await store.stop(message) } } label: { Label("Stop", systemImage: "stop.circle") } }
                    else {
                        Button { Task { await store.regenerate(message) } } label: { Label("Regenerate", systemImage: "arrow.clockwise") }
                        if message.state == "stopped" || message.state == "interrupted" { Button { Task { await store.continue(message) } } label: { Label("Continue", systemImage: "play") } }
                        Button { copy() } label: { Label("Copy", systemImage: "doc.on.doc") }
                        Button(action: onReport) { Label("Report", systemImage: "flag") }
                    }
                } else {
                    Button(action: onEdit) { Label("Edit", systemImage: "pencil") }
                }
                if !isUser, let u = message.usage.object["outputTokens"]?.int, u > 0 { Text("\(u) tokens · \(Fmt.ms(message.usage["firstTokenMs"].double)) to first token").font(.caption2).foregroundStyle(Exprsn.muted) }
            }
            .buttonStyle(.borderless).labelStyle(.iconOnly).font(.caption).foregroundStyle(Exprsn.muted)
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }

    private func copy() {
        #if os(macOS)
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message.content, forType: .string)
        #else
        UIPasteboard.general.string = message.content
        #endif
    }
}

/// Markdown with code blocks drawn in the console's codebox style.
struct MarkdownText: View {
    var text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                switch seg {
                case .code(let lang, let code):
                    VStack(alignment: .leading, spacing: 4) {
                        if !lang.isEmpty { Text(lang).font(.caption2).foregroundStyle(Exprsn.muted) }
                        ScrollView(.horizontal) { Text(code).font(.exprsnMonoSmall).textSelection(.enabled).padding(8) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Exprsn.panel2, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Exprsn.line2))
                case .text(let t):
                    Text((try? AttributedString(markdown: t, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(t))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private enum Segment { case text(String), code(String, String) }
    private var segments: [Segment] {
        var out: [Segment] = []
        var inCode = false, lang = "", buf = ""
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if inCode { out.append(.code(lang, buf)); buf = ""; inCode = false }
                else { if !buf.isEmpty { out.append(.text(buf)) }; buf = ""; inCode = true; lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces) }
            } else { buf += (buf.isEmpty ? "" : "\n") + line }
        }
        if !buf.isEmpty { out.append(inCode ? .code(lang, buf) : .text(buf)) }
        return out
    }
}

struct Composer: View {
    @Bindable var store: ChatStore
    @Binding var importingFile: Bool
    @Environment(\.modelContext) private var context
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 8) {
            if let p = store.problem { Notice(.danger, p.title, p.detail, actionLabel: "Dismiss") { store.problem = nil } }
            if !store.pendingAttachments.isEmpty {
                HStack { ForEach(Array(store.pendingAttachments.enumerated()), id: \.offset) { i, a in
                    HStack(spacing: 4) { Image(systemName: "paperclip"); Text(a["name"].text).font(.caption); Button { store.pendingAttachments.remove(at: i) } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.borderless) }
                        .padding(6).background(Exprsn.selection, in: Capsule())
                } ; Spacer() }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button { importingFile = true } label: { Image(systemName: "paperclip") }.buttonStyle(.borderless).help("Attach a file")
                TextEditor(text: $store.draft)
                    .font(.body)
                    .frame(minHeight: 40, maxHeight: 160)
                    .fixedSize(horizontal: false, vertical: true)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .background(Exprsn.panel, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Exprsn.line))
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        Task { await store.send(context: context) }
                        return .handled
                    }
                Button { Task { await store.send(context: context) } } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .buttonStyle(.borderless).disabled(store.draft.trimmingCharacters(in: .whitespaces).isEmpty || store.sending || store.selectedProfile == nil)
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("Send (Return; Shift-Return for a new line)")
            }
            HStack(spacing: 12) {
                Picker("Profile", selection: Binding(get: { store.selectedProfileId ?? "" }, set: { store.selectedProfileId = $0; store.think = store.selectedProfile?.thinkDefault ?? .off })) {
                    ForEach(store.profiles) { p in Text(p.title + (p.deprecated == true ? " (deprecated)" : "")).tag(p.id) }
                }.frame(maxWidth: 340)
                if let p = store.selectedProfile, p.thinkLevels.count > 1 {
                    Picker("Thinking", selection: $store.think) { ForEach(p.thinkLevels) { Text($0.title).tag($0) } }.frame(maxWidth: 180)
                }
                if let p = store.selectedProfile {
                    LabelBadge(p.label, small: true).fixedSize()
                    Text(p.model ?? "").font(.caption2).foregroundStyle(Exprsn.muted).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(12)
        .background(Exprsn.nav)
        .onAppear { focused = true }
    }
}

/// Share a conversation with a person, a workspace or by link.
struct ShareSheet: View {
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    var conversationId: String
    @State private var shares: [JSONValue] = []
    @State private var targets: [JSONValue] = []
    @State private var query = ""
    @State private var link: String?
    @State private var hours = 24
    @State private var problem: APIProblem?

    var body: some View {
        NavigationStack {
            List {
                Section("Shared with") {
                    if shares.isEmpty { Text("Nobody yet").foregroundStyle(Exprsn.muted) }
                    ForEach(Array(shares.enumerated()), id: \.offset) { _, s in
                        HStack {
                            Text(s["userName"].string ?? s["workspaceName"].string ?? "Link").font(.body)
                            Pill(s["kind"].text, tone: .info); Pill(s["state"].text)
                            Spacer()
                            Button("Revoke", role: .destructive) { Task { _ = try? await session.client?.delete("conversations/\(conversationId)/shares/\(s["id"].text)"); await load() } }.controlSize(.small)
                        }
                    }
                }
                Section("Share with a person or workspace") {
                    TextField("Search", text: $query).onSubmit { Task { await search() } }
                    ForEach(Array(targets.enumerated()), id: \.offset) { _, t in
                        HStack {
                            Text(t["name"].text); Pill(t["kind"].text, tone: .info)
                            if t["cleared"].bool == false { Text("not cleared").font(.caption).foregroundStyle(Exprsn.dangerFg) }
                            Spacer()
                            Button("Share") { Task { await share(t) } }.controlSize(.small).disabled(t["cleared"].bool == false)
                        }
                    }
                }
                Section("Link") {
                    Stepper("Valid for \(hours) hours", value: $hours, in: 1...720)
                    Button("Create a link") { Task { await createLink() } }
                    if let link { Text(link).font(.exprsnMonoSmall).textSelection(.enabled); Text("Shown once. Copy it now.").font(.caption).foregroundStyle(Exprsn.warnFg) }
                }
                if let problem { Notice(.danger, problem.title, problem.detail) }
            }
            .navigationTitle("Share")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }.frame(minWidth: 480, minHeight: 420)
    }

    private func load() async { shares = (try? await session.client?.get("conversations/\(conversationId)/shares"))?.array ?? [] }
    private func search() async { targets = (try? await session.client?.get("conversations/\(conversationId)/share-targets", query: ["q": query]))?.array ?? [] }
    private func share(_ t: JSONValue) async {
        do {
            let kind = t["kind"].text
            _ = try await session.client?.post("conversations/\(conversationId)/shares", kind == "workspace" ? json(["kind": "workspace", "workspaceId": .string(t["id"].text)]) : json(["kind": "user", "userId": .string(t["id"].text)]))
            await load()
        } catch { problem = error.asProblem }
    }
    private func createLink() async {
        do { let r = try await session.client?.post("conversations/\(conversationId)/shares", json(["kind": "link", "expiresInHours": .number(Double(hours))])); link = r?["url"].string ?? r?["token"].string; await load() }
        catch { problem = error.asProblem }
    }
}

/// Export a conversation through the server (Word, PDF, Markdown…) and save the file.
struct ExportConversationSheet: View {
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    var conversationId: String
    var title: String
    @State private var format = "markdown"
    @State private var state = "Choose a format."
    @State private var document: BundleDocument?
    @State private var saving = false
    @State private var ext = "md"
    private let formats = [("markdown", "md"), ("json", "json"), ("docx", "docx"), ("odt", "odt"), ("pdf", "pdf"), ("html", "html"), ("txt", "txt"), ("rtf", "rtf")]

    var body: some View {
        NavigationStack {
            Form {
                Picker("Format", selection: $format) { ForEach(formats, id: \.0) { Text($0.0.uppercased()).tag($0.0) } }
                Text(state).font(.caption).foregroundStyle(Exprsn.muted)
            }
            .formStyle(.grouped)
            .navigationTitle("Export conversation")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Export") { Task { await run() } } }
            }
            .fileExporter(isPresented: $saving, document: document, contentType: UTType(filenameExtension: ext) ?? .data, defaultFilename: "\(title).\(ext)") { _ in dismiss() }
        }.frame(minWidth: 400, minHeight: 200)
    }

    private func run() async {
        guard let client = session.client else { return }
        do {
            state = "Requested…"
            let r = try await client.post("conversations/\(conversationId)/exports", json(["format": .string(format)]))
            let id = r["id"].text
            for _ in 0..<60 {
                let e = try await client.get("conversation-exports/\(id)")
                let s = e["state"].string ?? ""
                state = "Export \(s)."
                if s == "ready" {
                    let (data, _, _) = try await client.download("conversation-exports/\(id)/download")
                    ext = formats.first { $0.0 == format }?.1 ?? "bin"
                    document = BundleDocument(data: data); saving = true; return
                }
                if s == "failed" { state = "Export failed: \(e["error"].text)"; return }
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
        } catch { state = error.asProblem.errorDescription ?? "Failed" }
    }
}
