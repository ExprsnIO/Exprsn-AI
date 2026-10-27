import SwiftUI
import SwiftData

/// Chat with an OpenAI-compatible platform through `/v1/chat/completions` (streamed over server-sent events).
/// Conversations live on the device, since such platforms keep none. Works against Exprsn-AI's own `/v1` too.
struct PlatformChatScreen: View {
    @Environment(AppSession.self) private var session
    @Environment(\.modelContext) private var context
    @Query(sort: \PlatformConversation.updatedAt, order: .reverse) private var all: [PlatformConversation]
    @State private var models: [String] = []
    @State private var model = ""
    @State private var selected: PlatformConversation?
    @State private var draft = ""
    @State private var streaming = ""
    @State private var busy = false
    @State private var problem: APIProblem?
    @State private var system = ""

    private var conversations: [PlatformConversation] { all.filter { $0.serverId == session.server?.id } }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                HStack { Text("Conversations").font(.headline); Spacer(); Button { selected = nil } label: { Image(systemName: "square.and.pencil") }.buttonStyle(.borderless) }.padding(10)
                List(conversations, selection: Binding(get: { selected?.id }, set: { id in selected = conversations.first { $0.id == id } })) { c in
                    VStack(alignment: .leading) { Text(c.title).lineLimit(1); Text("\(c.model) · \(Fmt.when(c.updatedAt))").font(.caption2).foregroundStyle(Exprsn.muted) }.tag(c.id)
                        .contextMenu { Button("Delete", role: .destructive) { context.delete(c); if selected?.id == c.id { selected = nil } } }
                }.listStyle(.plain)
            }.frame(width: 260).background(Exprsn.nav)
            Divider()
            VStack(spacing: 0) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if let c = selected {
                            ForEach(c.messages.sorted { $0.order < $1.order }, id: \.order) { m in bubble(m.role, m.content) }
                        }
                        if !streaming.isEmpty { bubble("assistant", streaming) }
                        if selected == nil && streaming.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Chat with \(session.server?.name ?? "this platform")").font(.title2.weight(.semibold))
                                Text("Messages go to /v1/chat/completions with your key. Nothing is kept on the platform by this app; the thread is stored on this device.").foregroundStyle(Exprsn.fg2)
                                TextField("System prompt (optional)", text: $system, axis: .vertical).textFieldStyle(.roundedBorder)
                            }.padding(.top, 30)
                        }
                    }.padding(16).frame(maxWidth: 860).frame(maxWidth: .infinity)
                }
                Divider()
                VStack(spacing: 8) {
                    if let problem { Notice(.danger, problem.title, problem.detail, actionLabel: "Dismiss") { self.problem = nil } }
                    HStack(alignment: .bottom) {
                        TextField("Message", text: $draft, axis: .vertical).lineLimit(1...8).textFieldStyle(.roundedBorder).onSubmit { Task { await send() } }
                        Button { Task { await send() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }.buttonStyle(.borderless).disabled(draft.isEmpty || busy || model.isEmpty)
                    }
                    HStack {
                        Picker("Model", selection: $model) { ForEach(models, id: \.self) { Text($0).tag($0) } }.fixedSize()
                        if busy { ProgressView().controlSize(.small) }
                        Spacer()
                    }
                }.padding(12).background(Exprsn.nav)
            }
        }
        .task(id: session.server?.id) {
            guard let client = session.client else { return }
            let r = try? await client.get("/v1/models")
            models = r?["data"].array.map { $0["id"].text } ?? []
            model = session.server?.defaultModel ?? models.first ?? ""
            if !models.contains(model), let f = models.first { model = f }
        }
    }

    private func bubble(_ role: String, _ text: String) -> some View {
        VStack(alignment: role == "user" ? .trailing : .leading, spacing: 4) {
            Text(role == "user" ? "You" : model).font(.caption.weight(.semibold)).foregroundStyle(Exprsn.fg2)
            MarkdownText(text).padding(12).background(role == "user" ? Exprsn.bubble : Exprsn.panel, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(role == "user" ? .clear : Exprsn.line))
        }.frame(maxWidth: .infinity, alignment: role == "user" ? .trailing : .leading)
    }

    private func send() async {
        guard let client = session.client, let sid = session.server?.id else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines); guard !text.isEmpty else { return }
        busy = true; defer { busy = false }
        problem = nil
        let conv = selected ?? { let c = PlatformConversation(serverId: sid, title: String(text.prefix(60)), model: model); context.insert(c); selected = c; return c }()
        if conv.messages.isEmpty, !system.isEmpty { conv.messages.append(PlatformMessage(role: "system", content: system, order: 0)) }
        conv.messages.append(PlatformMessage(role: "user", content: text, order: conv.messages.count))
        draft = ""
        let msgs: [JSONValue] = conv.messages.sorted { $0.order < $1.order }.map { ["role": .string($0.role), "content": .string($0.content)] }
        do {
            let (bytes, _) = try await client.lines(.post, "/v1/chat/completions", body: ["model": .string(model), "messages": .array(msgs), "stream": true])
            streaming = ""
            for try await ev in SSE.events(bytes) {
                guard let d = ev.data(using: .utf8), let v = try? JSONDecoder().decode(JSONValue.self, from: d) else { continue }
                if let err = v["error"].object["message"]?.string { throw APIProblem(status: 0, title: "Platform error", detail: err) }
                if let delta = v["choices"][0]["delta"]["content"].string { streaming += delta }
            }
            conv.messages.append(PlatformMessage(role: "assistant", content: streaming, order: conv.messages.count))
            conv.updatedAt = Date()
            streaming = ""
            try? context.save()
        } catch { problem = error.asProblem; streaming = "" }
    }
}
