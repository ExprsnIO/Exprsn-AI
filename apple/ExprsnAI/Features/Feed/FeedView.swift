import SwiftUI

/// Feed: home, workspace, trending and bookmarks; post, react, comment, bookmark, report.
struct FeedScreen: View {
    @Environment(AppSession.self) private var session
    @State private var tab = "home"
    @State private var posts: Loadable<[JSONValue]> = .idle
    @State private var trending: JSONValue = .null
    @State private var draft = ""
    @State private var problem: APIProblem?
    @State private var commentsFor: String?
    @State private var comments: [JSONValue] = []
    @State private var comment = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("", selection: $tab) { Text("Home").tag("home"); Text("Workspace").tag("workspace"); Text("Bookmarks").tag("bookmarks") }.pickerStyle(.segmented).frame(maxWidth: 320).onChange(of: tab) { _, _ in Task { await load() } }
                Spacer()
                if !trending["tags"].array.isEmpty { HStack { ForEach(trending["tags"].array.prefix(5), id: \.self) { t in Pill("#\(t["tag"].text) \(t["posts"].text)", tone: .neutral) } } }
            }.padding(12)
            if session.has("feed:write") {
                HStack(alignment: .bottom) {
                    TextField("Share something with the workspace", text: $draft, axis: .vertical).lineLimit(1...5).textFieldStyle(.roundedBorder)
                    Button("Post") { Task { await post() } }.buttonStyle(.borderedProminent).disabled(draft.isEmpty)
                }.padding(.horizontal, 12).padding(.bottom, 8)
            }
            if let problem { Notice(.danger, problem.title, problem.detail).padding(.horizontal, 12) }
            LoadableView(state: posts, retry: load) { list in
                if list.isEmpty { EmptyState(title: "Nothing here yet", systemImage: "newspaper") }
                else {
                    ScrollView {
                        LazyVStack(spacing: 10) {
                            ForEach(list, id: \.self) { p in postCard(p) }
                        }.padding(12).frame(maxWidth: 760).frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .task { await load(); trending = (try? await session.client?.get("feed/trending")) ?? .null }
    }

    private func postCard(_ p: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Text(p["author"]["displayName"].string ?? p["authorName"].string ?? p["author"].text).font(.body.weight(.semibold)); Text(Fmt.when(p["createdAt"])).font(.caption).foregroundStyle(Exprsn.muted); Spacer(); if p["state"].string == "held" { Pill("held for review", tone: .warn) }; LabelBadge(p["label"].string, small: true) }
            if let rp = p["repostOf"].object["body"]?.string { Text(rp).padding(8).background(Exprsn.panel2, in: RoundedRectangle(cornerRadius: 6)).font(.callout) }
            Text(p["body"].text).textSelection(.enabled)
            HStack(spacing: 14) {
                ForEach(["like", "celebrate", "support", "insightful", "funny"], id: \.self) { k in
                    let n = p["reactions"][k].int ?? p["reactions"].array.first { $0["kind"].string == k }?["count"].int ?? 0
                    let mine = p["myReactions"].array.map(\.text).contains(k) || p["reactions"].array.first { $0["kind"].string == k }?["mine"].bool == true
                    Button { Task { await react(p, k, remove: mine) } } label: { Label(n > 0 ? "\(n)" : "", systemImage: icon(k)) }.buttonStyle(.borderless).foregroundStyle(mine ? Exprsn.accent : Exprsn.muted).font(.caption)
                }
                Button { Task { await toggleComments(p) } } label: { Label("\(p["comments"].int ?? p["commentCount"].int ?? 0)", systemImage: "bubble.right") }.buttonStyle(.borderless).foregroundStyle(Exprsn.muted).font(.caption)
                Button { Task { _ = try? await session.client?.put("feed/posts/\(p["id"].text)/bookmark"); await load() } } label: { Image(systemName: p["bookmarked"].bool == true ? "bookmark.fill" : "bookmark") }.buttonStyle(.borderless).foregroundStyle(Exprsn.muted).font(.caption)
                Button { Task { _ = try? await session.client?.post("feed/posts/\(p["id"].text)/repost", json([:])); await load() } } label: { Image(systemName: "arrow.2.squarepath") }.buttonStyle(.borderless).foregroundStyle(Exprsn.muted).font(.caption)
                Spacer()
                Menu {
                    Button("Report") { Task { _ = try? await session.client?.post("moderation/reports", json(["type": "feed-post", "id": .string(p["id"].text), "reason": "report"])) } }
                    if p["authorId"].string == session.me?.user.id || session.has("feed:manage") { Button("Delete", role: .destructive) { Task { _ = try? await session.client?.delete("feed/posts/\(p["id"].text)"); await load() } } }
                } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().foregroundStyle(Exprsn.muted)
            }
            if commentsFor == p["id"].text {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(comments, id: \.self) { c in HStack(alignment: .top) { Text(c["author"]["displayName"].string ?? c["authorName"].string ?? c["author"].text).font(.caption.weight(.semibold)); Text(c["body"].text).font(.callout) } }
                    HStack { TextField("Comment", text: $comment).textFieldStyle(.roundedBorder); Button("Send") { Task { _ = try? await session.client?.post("feed/posts/\(p["id"].text)/comments", json(["body": .string(comment)])); comment = ""; await toggleComments(p, keep: true) } }.disabled(comment.isEmpty) }
                }.padding(.top, 4)
            }
        }.panel()
    }

    private func icon(_ k: String) -> String { ["like": "hand.thumbsup", "celebrate": "party.popper", "support": "heart", "insightful": "lightbulb", "funny": "face.smiling"][k] ?? "hand.thumbsup" }
    private func load() async {
        posts = await loaded {
            let path = tab == "home" ? "feed/home" : tab == "bookmarks" ? "feed/bookmarks" : "feed/workspaces/\(session.me?.workspace ?? "")"
            return (try await session.client!.get(path)).rows(itemsKey: "items")
        }
    }
    private func post() async {
        problem = nil
        do { _ = try await session.client!.post("feed/posts", json(["body": .string(draft)])); draft = ""; await load() } catch { problem = error.asProblem }
    }
    private func react(_ p: JSONValue, _ kind: String, remove: Bool) async {
        if remove { _ = try? await session.client?.delete("feed/posts/\(p["id"].text)/reactions/\(kind)") } else { _ = try? await session.client?.put("feed/posts/\(p["id"].text)/reactions/\(kind)") }
        await load()
    }
    private func toggleComments(_ p: JSONValue, keep: Bool = false) async {
        if commentsFor == p["id"].text && !keep { commentsFor = nil; return }
        commentsFor = p["id"].text
        comments = (try? await session.client?.get("feed/posts/\(p["id"].text)/comments"))?.rows(itemsKey: "items") ?? []
    }
}
