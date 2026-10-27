import SwiftUI
import SwiftData

/// One search box across chats, posts, files, knowledge, groups and people (`GET /api/search`).
struct SearchScreen: View {
    @Environment(AppSession.self) private var session
    @Environment(\.modelContext) private var context
    @Query(sort: \RecentSearch.at, order: .reverse) private var recents: [RecentSearch]
    @State private var query = ""
    @State private var result: Loadable<JSONValue> = .idle
    @State private var sources: Set<String> = []
    private let allSources = ["chats", "posts", "files", "knowledge", "groups", "people", "apps"]

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    TextField("Search everything", text: $query).textFieldStyle(.roundedBorder).onSubmit { Task { await run() } }
                    Button("Search") { Task { await run() } }.buttonStyle(.borderedProminent).disabled(query.isEmpty)
                }
                HStack { ForEach(allSources, id: \.self) { s in Toggle(s.capitalized, isOn: Binding(get: { sources.isEmpty || sources.contains(s) }, set: { on in if on { sources.insert(s) } else { if sources.isEmpty { sources = Set(allSources) }; sources.remove(s) } })).toggleStyle(.button).controlSize(.small) } }.flexibleWrap()
                Text("Words must all match; \"quoted phrases\" and word* prefixes work. Queries are never stored on the server.").font(.caption).foregroundStyle(Exprsn.muted)
            }.padding(12).background(Exprsn.nav)
            Divider()
            switch result {
            case .idle:
                List {
                    if !recents.isEmpty { Section("Recent") { ForEach(recents.filter { $0.serverId == session.server?.id }.prefix(12)) { r in Button(r.query) { query = r.query; Task { await run() } }.buttonStyle(.plain) } } }
                }
            case .loading: ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let p): ProblemView(problem: p)
            case .loaded(let v):
                List {
                    if v["groups"].array.allSatisfy({ $0["items"].array.isEmpty }) { Text("No results.").foregroundStyle(Exprsn.muted) }
                    ForEach(v["groups"].array, id: \.self) { g in
                        if !g["items"].array.isEmpty {
                            Section("\(g["title"].text) · \(g["source"].text)") {
                                ForEach(g["items"].array, id: \.self) { it in
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(it["title"].text).font(.body.weight(.medium))
                                        if let s = it["sub"].string { Text(s).font(.caption).foregroundStyle(Exprsn.muted) }
                                        if let sn = it["snippet"].string { Text(sn).font(.callout).foregroundStyle(Exprsn.fg2).lineLimit(3) }
                                    }
                                }
                            }
                        }
                    }
                    Section { Text("Engine: \(v["engine"].text)\(v["partial"].bool == true ? " (partial)" : "")").font(.caption).foregroundStyle(Exprsn.muted) }
                }
            }
        }
    }
    private func run() async {
        guard let client = session.client, let sid = session.server?.id, !query.isEmpty else { return }
        result = .loading
        let srcs = sources.isEmpty ? nil : sources.sorted().joined(separator: ",")
        result = await loaded { try await client.get("search", query: ["q": query, "sources": srcs, "limit": "10"]) }
        if !recents.contains(where: { $0.query == query && $0.serverId == sid }) { context.insert(RecentSearch(query: query, serverId: sid)) }
    }
}
