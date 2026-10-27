import SwiftUI

/// Compare: one prompt, two to four profiles side by side.
struct CompareScreen: View {
    @Environment(AppSession.self) private var session
    @State private var profiles: [ChatProfile] = []
    @State private var chosen: [String] = []
    @State private var prompt = ""
    @State private var think: ThinkLevel = .off
    @State private var columns: [JSONValue] = []
    @State private var texts: [String: String] = [:]
    @State private var states: [String: String] = [:]
    @State private var conversationId: String?
    @State private var problem: APIProblem?
    @State private var running = false

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Choose 2 to 4 profiles").font(.caption).foregroundStyle(Exprsn.muted)
                HStack { ForEach(profiles) { p in
                    Toggle(p.title, isOn: Binding(get: { chosen.contains(p.id) }, set: { on in if on { if chosen.count < 4 { chosen.append(p.id) } } else { chosen.removeAll { $0 == p.id } } }))
                        .toggleStyle(.button).controlSize(.small)
                } }.flexibleWrap()
                HStack(alignment: .bottom) {
                    TextField("Prompt", text: $prompt, axis: .vertical).lineLimit(2...6).textFieldStyle(.roundedBorder)
                    Picker("Thinking", selection: $think) { ForEach(ThinkLevel.allCases) { Text($0.title).tag($0) } }.fixedSize()
                    Button("Run") { Task { await run() } }.buttonStyle(.borderedProminent).disabled(chosen.count < 2 || prompt.isEmpty || running)
                }
                if let problem { Notice(.danger, problem.title, problem.detail) }
            }
            .padding(12).background(Exprsn.nav)
            Divider()
            if columns.isEmpty {
                EmptyState(title: "Nothing compared yet", text: "Each column streams and is metered separately.", systemImage: "rectangle.split.2x1")
            } else {
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(Array(columns.enumerated()), id: \.offset) { _, c in
                            let id = c["messageId"].text
                            VStack(alignment: .leading, spacing: 6) {
                                HStack { Text(c["profile"].text).font(.headline); Spacer(); Pill(states[id] ?? "queued") }
                                Text(c["model"].text).font(.caption).foregroundStyle(Exprsn.muted)
                                if c["canary"].bool == true { Pill("canary", tone: .info) }
                                Divider()
                                ScrollView { MarkdownText(texts[id] ?? "").frame(maxWidth: .infinity, alignment: .leading) }
                            }
                            .padding(12).frame(width: 360, alignment: .top).frame(maxHeight: .infinity, alignment: .top)
                            .background(Exprsn.panel, in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Exprsn.line))
                        }
                    }.padding(12)
                }
            }
        }
        .task { profiles = (try? await session.client?.decode(.get, "chat/profiles")) ?? [] }
    }

    private func run() async {
        guard let client = session.client else { return }
        running = true; defer { running = false }
        problem = nil; texts = [:]; states = [:]
        do {
            let names = chosen.compactMap { id in profiles.first { $0.id == id }?.name }
            let r = try await client.post("compare", json(["prompt": .string(prompt), "profiles": .array(names.map { .string($0) }), "think": think == .off ? nil : .string(think.rawValue)]))
            conversationId = r["conversationId"].string
            columns = r["columns"].array
            await withTaskGroup(of: Void.self) { group in
                for c in columns { group.addTask { await follow(conversation: r["conversationId"].text, message: c["messageId"].text) } }
            }
        } catch { problem = error.asProblem }
    }

    private func follow(conversation: String, message: String) async {
        guard let client = session.client else { return }
        var after = 0; var content = ""
        for _ in 0..<2000 {
            guard let r = try? await client.get("conversations/\(conversation)/messages/\(message)/stream", query: ["after": String(after)]) else { try? await Task.sleep(nanoseconds: 800_000_000); continue }
            for c in r["chunks"].array { if let d = c["delta"].string { content += d }; after = max(after, c["seq"].int ?? after) }
            if let s = r["seq"].int { after = max(after, s) }
            let st = r["state"].string ?? "complete"
            if let stored = r["content"].string, st != "streaming" { content = stored }
            await MainActor.run { texts[message] = content; states[message] = st }
            if st != "streaming" && st != "queued" && st != "loading" { return }
            try? await Task.sleep(nanoseconds: 350_000_000)
        }
    }
}
