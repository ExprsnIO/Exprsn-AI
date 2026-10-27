import SwiftUI

/// Messages: person-to-person and group conversations, with sending, reactions, read marks and search.
struct MessagesScreen: View {
    @Environment(AppSession.self) private var session
    @State private var conversations: Loadable<[JSONValue]> = .idle
    @State private var selected: String?
    @State private var starting = false
    @State private var people: [JSONValue] = []

    var body: some View {
        LoadableView(state: conversations, retry: load) { list in
            HStack(spacing: 0) {
                List(list, id: \.self, selection: Binding(get: { selected.flatMap { s in list.first { $0["id"].text == s } } }, set: { selected = $0?["id"].text })) { c in
                    HStack {
                        Image(systemName: c["kind"].string == "direct" ? "person" : "person.2").foregroundStyle(Exprsn.fg2)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack { Text(c["title"].string ?? c["with"]["displayName"].string ?? c["with"]["username"].string ?? "Conversation").font(.body.weight((c["unread"].int ?? 0) > 0 ? .semibold : .regular)).lineLimit(1); Spacer(); if let u = c["unread"].int, u > 0 { Text("\(u)").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 1).background(Exprsn.accent, in: Capsule()).foregroundStyle(Exprsn.accentFg) } }
                            Text("\(c["members"].text) members · \(Fmt.when(c["lastMessageAt"]))\(c["muted"].bool == true ? " · muted" : "")").font(.caption).foregroundStyle(Exprsn.muted)
                        }
                    }
                }.listStyle(.plain).frame(minWidth: 260, idealWidth: 320)
                Divider()
                if let id = selected, let c = list.first(where: { $0["id"].text == id }) { ConversationThread(conversation: c) } else { EmptyState(title: "Choose a conversation", text: "Or start one with a person or a group.", systemImage: "envelope") }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { starting = true } label: { Label("New", systemImage: "square.and.pencil") }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
        }
        .sheet(isPresented: $starting) {
            FormSheet(title: "New conversation", fields: [FormField("kind", "Kind", .select(["direct", "group"]), defaultValue: "direct"), FormField("userId", "Person's user id (direct)"), FormField("title", "Title (group)"), FormField("memberIds", "Member ids (group, JSON array)", .json, defaultValue: "[]")]) { body in
                let r = try await session.client!.post("messaging/conversations", body); selected = r["id"].string; await load()
            }
        }
        .task { await load() }
    }
    private func load() async { conversations = await loaded { (try await session.client!.get("messaging/conversations")).rows(itemsKey: "items") } }
}

struct ConversationThread: View {
    @Environment(AppSession.self) private var session
    var conversation: JSONValue
    @State private var messages: [JSONValue] = []
    @State private var draft = ""
    @State private var problem: APIProblem?
    @State private var query = ""
    @State private var summary: String?
    private var id: String { conversation["id"].text }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(conversation["title"].string ?? conversation["with"]["displayName"].string ?? "Conversation").font(.headline); LabelBadge(conversation["label"].string, small: true); Pill(conversation["role"].text, tone: .neutral)
                Spacer()
                TextField("Search", text: $query).textFieldStyle(.roundedBorder).frame(width: 180).onSubmit { Task { await search() } }
                Menu {
                    Button("Summarise recent") { Task { summary = (try? await session.client?.post("messaging/conversations/\(id)/summary", json([:])))?["summary"].string } }
                    Button("Catch-up digest") { Task { summary = (try? await session.client?.post("messaging/conversations/\(id)/digest", json([:])))?["summary"].string ?? "Nothing new." } }
                    Button(conversation["muted"].bool == true ? "Unmute" : "Mute") { Task { _ = try? await session.client?.put("messaging/conversations/\(id)/settings", json(["muted": .bool(conversation["muted"].bool != true)])) } }
                    Button("Leave", role: .destructive) { Task { _ = try? await session.client?.delete("messaging/conversations/\(id)/members/\(session.me?.user.id ?? "")") } }
                } label: { Label("More", systemImage: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize()
            }.padding(10)
            Divider()
            if let summary { Notice(.info, "Summary", summary, actionLabel: "Close") { self.summary = nil }.padding(10) }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(messages.reversed(), id: \.self) { m in
                            let mine = m["authorId"].string == session.me?.user.id
                            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                                HStack(spacing: 6) { Text(m["authorName"].text).font(.caption.weight(.semibold)).foregroundStyle(Exprsn.fg2); Text(Fmt.when(m["createdAt"])).font(.caption2).foregroundStyle(Exprsn.muted); if m["edited"].bool == true { Text("edited").font(.caption2).foregroundStyle(Exprsn.muted) }; if m["pinned"].bool == true { Image(systemName: "pin.fill").font(.caption2) } }
                                if m["body"].isNull { Text(m["state"].string == "deleted" ? "Message deleted" : "Hidden by moderation").italic().foregroundStyle(Exprsn.muted) }
                                else { Text(m["body"].text).padding(10).background(mine ? Exprsn.bubble : Exprsn.panel, in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(mine ? .clear : Exprsn.line)).textSelection(.enabled) }
                                if !m["attachments"].array.isEmpty { HStack { ForEach(m["attachments"].array, id: \.self) { a in Label(a["name"].text, systemImage: "paperclip").font(.caption) } } }
                                HStack(spacing: 6) {
                                    ForEach(m["reactions"].array, id: \.self) { r in Button("\(r["emoji"].text) \(r["count"].text)") { Task { await react(m, r["emoji"].text, remove: r["mine"].bool == true) } }.buttonStyle(.bordered).controlSize(.mini).tint(r["mine"].bool == true ? Exprsn.accent : nil) }
                                    Menu { ForEach(["👍", "❤️", "😂", "🎉", "👀"], id: \.self) { e in Button(e) { Task { await react(m, e, remove: false) } } } } label: { Image(systemName: "face.smiling") }.menuStyle(.borderlessButton).fixedSize().font(.caption)
                                    if mine { Button { Task { _ = try? await session.client?.delete("messaging/conversations/\(id)/messages/\(m["id"].text)"); await load() } } label: { Image(systemName: "trash") }.buttonStyle(.borderless).font(.caption) }
                                    Button { Task { _ = try? await session.client?.post("moderation/reports", json(["type": "dm-message", "id": .string(m["id"].text), "reason": "report"])) } } label: { Image(systemName: "flag") }.buttonStyle(.borderless).font(.caption)
                                }.foregroundStyle(Exprsn.muted)
                            }.frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading).id(m["id"].text)
                        }
                    }.padding(12)
                }
                .onChange(of: messages.count) { _, _ in if let f = messages.first { proxy.scrollTo(f["id"].text, anchor: .bottom) } }
            }
            Divider()
            VStack(spacing: 6) {
                if let problem { Notice(.danger, problem.title, problem.detail) }
                HStack {
                    TextField("Message", text: $draft, axis: .vertical).lineLimit(1...6).textFieldStyle(.roundedBorder).onSubmit { Task { await send() } }
                    Button { Task { await send() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }.buttonStyle(.borderless).disabled(draft.isEmpty)
                }
            }.padding(10).background(Exprsn.nav)
        }
        .task(id: id) {
            await load()
            while !Task.isCancelled { try? await Task.sleep(nanoseconds: 5_000_000_000); await load() }
        }
    }
    private func load() async {
        messages = (try? await session.client?.get("messaging/conversations/\(id)/messages"))?.rows(itemsKey: "items") ?? []
        if let newest = messages.first { _ = try? await session.client?.post("messaging/conversations/\(id)/read", json(["messageId": .string(newest["id"].text)])) }
    }
    private func send() async {
        problem = nil
        do { _ = try await session.client!.post("messaging/conversations/\(id)/messages", json(["body": .string(draft)])); draft = ""; await load() } catch { problem = error.asProblem }
    }
    private func react(_ m: JSONValue, _ emoji: String, remove: Bool) async {
        let path = "messaging/conversations/\(id)/messages/\(m["id"].text)/reactions"
        if remove { _ = try? await session.client?.delete(path, json(["emoji": .string(emoji)])) } else { _ = try? await session.client?.post(path, json(["emoji": .string(emoji)])) }
        await load()
    }
    private func search() async {
        guard !query.isEmpty else { await load(); return }
        messages = (try? await session.client?.get("messaging/conversations/\(id)/search", query: ["q": query]))?.rows(itemsKey: "items") ?? []
    }
}
