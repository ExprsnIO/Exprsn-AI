import Foundation
import Observation
import SwiftData

/// The chat screen's state for one server: the conversation list, the open conversation and its streaming answers.
/// Streaming reads the catch-up endpoint (`GET …/stream?after=`) on a short interval instead of the console's
/// socket, which keeps the app free of a Socket.IO dependency and makes resumption trivial.
@MainActor
@Observable
final class ChatStore {
    let client: APIClient
    let serverId: UUID
    var profiles: [ChatProfile] = []
    var conversations: Loadable<[ConversationSummary]> = .idle
    var folders: [ChatFolder] = []
    var selectedFolder: String? = nil     // nil: all, "none": no folder, else a folder id
    var showArchived = false
    var query = ""
    var detail: Loadable<ConversationDetail> = .idle
    var selectedId: String?
    var selectedProfileId: String?
    var think: ThinkLevel = .off
    var draft = ""
    var sending = false
    var problem: APIProblem?
    var pendingAttachments: [JSONValue] = []
    private var streamTasks: [String: Task<Void, Never>] = [:]

    init(client: APIClient, serverId: UUID) { self.client = client; self.serverId = serverId }

    var selectedProfile: ChatProfile? { profiles.first { $0.id == selectedProfileId } }
    /// What the request carries: nothing when the profile cannot think, else the level.
    private var thinkValue: JSONValue? { (selectedProfile?.thinkCeiling ?? .off) == .off ? nil : .string(think.rawValue) }

    var filteredConversations: [ConversationSummary] {
        let list = conversations.value ?? []
        return list.filter { c in
            (query.isEmpty || (c.title ?? "").localizedCaseInsensitiveContains(query))
        }
    }

    // MARK: Loading

    func loadAll() async {
        async let p: [ChatProfile] = (try? client.decode(.get, "chat/profiles")) ?? []
        async let f: [ChatFolder] = (try? client.decode(.get, "chat/folders")) ?? []
        profiles = await p
        folders = await f
        profiles = profiles.filter { $0.hidden != true }
        if selectedProfileId == nil || !profiles.contains(where: { $0.id == selectedProfileId }) {
            selectedProfileId = profiles.first(where: { $0.default == true })?.id ?? profiles.first(where: { $0.deprecated != true })?.id ?? profiles.first?.id
            think = selectedProfile?.thinkDefault ?? .off
        }
        await loadConversations()
    }

    func loadConversations() async {
        conversations = .loading
        var q: [String: String?] = ["kind": "chat"]
        if showArchived { q["archived"] = "true" }
        if let f = selectedFolder { q["folder"] = f }
        conversations = await loaded { try await client.decode(.get, "conversations", query: q) as [ConversationSummary] }
    }

    func open(_ id: String, context: ModelContext?) async {
        selectedId = id
        detail = .loading
        detail = await loaded { ConversationDetail(try await client.get("conversations/\(id)")) }
        if let d = detail.value {
            for m in d.messages where m.isGenerating { follow(messageId: m.id, in: d.id) }
            cache(d, context: context)
        }
    }

    func refreshDetail() async {
        guard let id = selectedId else { return }
        if let d = try? await client.get("conversations/\(id)") { detail = .loaded(ConversationDetail(d)) }
    }

    // MARK: Sending

    func send(context: ModelContext?) async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let profile = selectedProfile else { return }
        sending = true; defer { sending = false }
        problem = nil
        let attachments: JSONValue? = pendingAttachments.isEmpty ? nil : .array(pendingAttachments.map { .string($0["id"].text) })
        do {
            if let id = selectedId, detail.value != nil {
                let r = try await client.post("conversations/\(id)/messages", json(["content": .string(text), "profile": .string(profile.name), "think": thinkValue, "attachments": attachments]))
                draft = ""; pendingAttachments = []
                await refreshDetail()
                follow(messageId: r["messageId"].text, in: id)
            } else {
                let r = try await client.post("chat", json(["content": .string(text), "profile": .string(profile.name), "think": thinkValue, "attachments": attachments]))
                draft = ""; pendingAttachments = []
                let id = r["conversationId"].text
                await loadConversations()
                await open(id, context: context)
                follow(messageId: r["messageId"].text, in: id)
            }
        } catch { problem = error.asProblem }
    }

    func regenerate(_ m: ChatMessage) async {
        guard let id = selectedId else { return }
        do {
            let r = try await client.post("conversations/\(id)/messages/\(m.id)/regenerate", json(["profile": selectedProfile.map { .string($0.name) }, "think": thinkValue]))
            await refreshDetail()
            follow(messageId: r["messageId"].text, in: id)
        } catch { problem = error.asProblem }
    }

    func edit(_ m: ChatMessage, content: String) async {
        guard let id = selectedId else { return }
        do {
            let r = try await client.post("conversations/\(id)/messages/\(m.id)/edit", json(["content": .string(content), "profile": selectedProfile.map { .string($0.name) }, "think": thinkValue]))
            await refreshDetail()
            follow(messageId: r["messageId"].text, in: id)
        } catch { problem = error.asProblem }
    }

    func stop(_ m: ChatMessage) async {
        guard let id = selectedId else { return }
        _ = try? await client.post("conversations/\(id)/messages/\(m.id)/stop")
        await refreshDetail()
    }

    func `continue`(_ m: ChatMessage) async {
        guard let id = selectedId else { return }
        do {
            _ = try await client.post("conversations/\(id)/messages/\(m.id)/continue")
            await refreshDetail()
            follow(messageId: m.id, in: id)
        } catch { problem = error.asProblem }
    }

    func setHead(_ m: ChatMessage) async {
        guard let id = selectedId else { return }
        _ = try? await client.patch("conversations/\(id)", json(["headId": .string(m.id)]))
        await refreshDetail()
    }

    func report(_ m: ChatMessage, reason: String, note: String) async {
        guard let id = selectedId else { return }
        do { _ = try await client.post("flags/report", json(["conversationId": .string(id), "messageId": .string(m.id), "reason": .string(reason), "note": note.isEmpty ? nil : .string(note)])) }
        catch { problem = error.asProblem }
    }

    // MARK: Streaming by catch-up

    private func follow(messageId: String, in conversationId: String) {
        streamTasks[messageId]?.cancel()
        let interval = UInt64(max(150, UserDefaults.standard.integer(forKey: "exprsn.pollMs") == 0 ? 350 : UserDefaults.standard.integer(forKey: "exprsn.pollMs"))) * 1_000_000
        streamTasks[messageId] = Task { [weak self] in
            guard let self else { return }
            var after = 0
            var content = "", thinking = ""
            while !Task.isCancelled {
                guard let r = try? await client.get("conversations/\(conversationId)/messages/\(messageId)/stream", query: ["after": String(after)]) else {
                    try? await Task.sleep(nanoseconds: interval * 3); continue
                }
                let state = r["state"].string ?? "complete"
                if let chunks = r["chunks"].array as [JSONValue]?, !chunks.isEmpty {
                    for c in chunks {
                        if let d = c["delta"].string { content += d }
                        if let t = c["thinking"].string { thinking += t }
                        after = max(after, c["seq"].int ?? after)
                    }
                    self.patch(messageId: messageId, content: content, thinking: thinking, state: "streaming")
                } else if let seq = r["seq"].int { after = max(after, seq) }
                if state != "streaming" && state != "queued" && state != "loading" {
                    // The stored answer (the output check may have replaced the streamed text).
                    if let stored = r["content"].string { content = stored }
                    if let t = r["thinking"].string { thinking = t }
                    self.patch(messageId: messageId, content: content, thinking: thinking, state: state)
                    await self.refreshDetail()
                    streamTasks[messageId] = nil
                    return
                }
                try? await Task.sleep(nanoseconds: interval)
            }
        }
    }

    private func patch(messageId: String, content: String, thinking: String, state: String) {
        guard var d = detail.value, let i = d.messages.firstIndex(where: { $0.id == messageId }) else { return }
        d.messages[i].content = content
        d.messages[i].thinking = thinking.isEmpty ? d.messages[i].thinking : thinking
        d.messages[i].state = state
        detail = .loaded(d)
    }

    // MARK: Conversation management

    func rename(_ c: ConversationSummary, to title: String) async {
        _ = try? await client.patch("conversations/\(c.id)", json(["title": .string(title)]))
        await loadConversations(); if selectedId == c.id { await refreshDetail() }
    }
    func archive(_ c: ConversationSummary, _ archived: Bool) async {
        _ = try? await client.patch("conversations/\(c.id)", json(["archived": .bool(archived)]))
        await loadConversations()
    }
    func delete(_ c: ConversationSummary) async {
        _ = try? await client.delete("conversations/\(c.id)")
        if selectedId == c.id { selectedId = nil; detail = .idle }
        await loadConversations()
    }
    func file(_ c: ConversationSummary, in folder: String?) async {
        _ = try? await client.put("conversations/\(c.id)/folder", json(["folderId": folder.map { .string($0) } ?? .null]))
        await loadConversations()
    }
    func createFolder(_ name: String) async {
        _ = try? await client.post("chat/folders", json(["name": .string(name)]))
        folders = (try? await client.decode(.get, "chat/folders")) ?? folders
    }
    func deleteFolder(_ f: ChatFolder) async {
        _ = try? await client.delete("chat/folders/\(f.id)")
        if selectedFolder == f.id { selectedFolder = nil }
        folders = (try? await client.decode(.get, "chat/folders")) ?? folders
        await loadConversations()
    }

    func newConversation() { selectedId = nil; detail = .idle; draft = ""; pendingAttachments = [] }

    /// Uploads a file to quarantine and waits for it to be ready.
    func attach(data: Data, name: String, type: String, label: String) async {
        do {
            var a = try await client.upload("attachments", data: data, contentType: type, query: ["name": name, "label": label])
            let id = a["id"].text
            for _ in 0..<40 {
                let state = a["state"].string ?? ""
                if state == "ready" || state == "rejected" { break }
                try await Task.sleep(nanoseconds: 700_000_000)
                a = try await client.get("attachments/\(id)")
            }
            if a["state"].string == "rejected" { problem = APIProblem(status: 409, title: "Attachment rejected", detail: a["reason"].string) }
            else { pendingAttachments.append(a) }
        } catch { problem = error.asProblem }
    }

    /// Keeps a copy of the active branch on the device.
    private func cache(_ d: ConversationDetail, context: ModelContext?) {
        guard let context, UserDefaults.standard.object(forKey: "exprsn.cacheConversations") as? Bool ?? true else { return }
        let key = "\(serverId.uuidString):\(d.id)"
        let existing = (try? context.fetch(FetchDescriptor<CachedConversation>(predicate: #Predicate { $0.key == key })))?.first
        let row = existing ?? { let n = CachedConversation(serverId: serverId, conversationId: d.id, title: d.title, label: d.label, kind: d.kind, profile: nil, updatedAt: Date()); context.insert(n); return n }()
        row.title = d.title; row.updatedAt = Date(); row.cachedAt = Date()
        row.messages.forEach { context.delete($0) }
        row.messages = d.activeBranch.filter { !$0.isGenerating }.map { CachedMessage(messageId: $0.id, role: $0.role, content: $0.content, thinking: $0.thinking, model: $0.model, state: $0.state, createdAt: $0.createdAt ?? Date()) }
        try? context.save()
    }
}
