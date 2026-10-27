import SwiftUI

/// Groups and events: the groups of your workspaces, membership, posts and events.
struct GroupsScreen: View {
    @Environment(AppSession.self) private var session
    var body: some View {
        ResourceScreen(spec: ResourceSpec(title: "Groups and events", subtitle: "Join, post, RSVP; moderators handle requests and cases", tabs: [
            ResourceTab(title: "Groups", path: "groups", columns: [Column("Name", "name"), Column("Visibility", "visibility", .pill), Column("Join", "joinMode", .pill), Column("Label", "label", .label), Column("Members", "members", .count), Column("Your role", "role", .pill)], detailPath: { "groups/\($0["id"].text)" }, actions: [
                RowAction(title: "Join", path: { "groups/\($0["id"].text)/join" }, systemImage: "person.badge.plus"),
                RowAction(title: "Leave", method: .delete, path: { "groups/\($0["id"].text)/members/\(session.me?.user.id ?? "")" }, destructive: true, confirm: "Leave this group?"),
                RowAction(title: "Post", path: { "groups/\($0["id"].text)/posts" }, fields: [FormField("body", "Post", .multiline, required: true)]),
                RowAction(title: "New event", path: { "groups/\($0["id"].text)/events" }, fields: [FormField("title", "Title", required: true), FormField("start", "Start (ISO 8601)", required: true, defaultValue: ISO8601DateFormatter.plain.string(from: Date().addingTimeInterval(86400))), FormField("durationMinutes", "Duration (minutes)", .number, defaultValue: "60"), FormField("timeZone", "Time zone", required: true, defaultValue: TimeZone.current.identifier), FormField("location", "Location"), FormField("description", "Description", .multiline)]),
                RowAction(title: "Members", method: .get, path: { "groups/\($0["id"].text)/members" }),
                RowAction(title: "Requests", method: .get, path: { "groups/\($0["id"].text)/requests" }),
                RowAction(title: "Events", method: .get, path: { "groups/\($0["id"].text)/events" }),
                RowAction(title: "Invite", path: { "groups/\($0["id"].text)/invites" }, fields: [FormField("userId", "User id", required: true)])],
                create: CreateSpec(title: "New group", path: "groups", fields: [FormField("name", "Name", required: true), FormField("description", "Description", .multiline), FormField("visibility", "Visibility", .select(["public", "private", "hidden"]), defaultValue: "private"), FormField("joinMode", "Join mode", .select(["open", "request", "invite"]), defaultValue: "request"), FormField("label", "Label", .label, defaultValue: "internal")]), permission: "groups:read"),
            ResourceTab(title: "Mine", path: "groups", query: ["mine": "true"], columns: [Column("Name", "name"), Column("Your role", "role", .pill), Column("Members", "members", .count)], detailPath: { "groups/\($0["id"].text)" }),
            ResourceTab(title: "Requests and invitations", path: "group-requests", columns: [Column("Group", "groupName"), Column("Kind", "kind", .pill), Column("Role", "role"), Column("State", "state", .pill), Column("Expires", "expiresAt", .date)], actions: [
                RowAction(title: "Accept", path: { "group-requests/\($0["id"].text)/accept" }), RowAction(title: "Decline", path: { "group-requests/\($0["id"].text)/decline" }, destructive: true)]),
            ResourceTab(title: "Proposals", path: "group-proposals", itemsKey: "items", actions: [RowAction(title: "Vote yes", path: { "group-proposals/\($0["id"].text)/vote" }, fixed: ["choice": "yes"]), RowAction(title: "Vote no", path: { "group-proposals/\($0["id"].text)/vote" }, fixed: ["choice": "no"])]),
            ResourceTab(title: "Calendar feeds", path: "calendar/feeds", columns: [Column("Kind", "kind", .pill), Column("Name", "name"), Column("URL", "url", .mono), Column("Last used", "lastUsedAt", .date)], actions: [RowAction(title: "Revoke", method: .delete, path: { "calendar/feeds/\($0["id"].text)" }, destructive: true)], create: CreateSpec(title: "Subscribe my calendar", path: "calendar/feeds", fields: [FormField("kind", "Kind", .select(["user", "group", "event"]), defaultValue: "user"), FormField("targetId", "Group or event id")]))
        ]))
    }
}

/// Calendar: the events of your groups and the ones you answered, two months around today.
struct CalendarScreen: View {
    @Environment(AppSession.self) private var session
    @State private var events: Loadable<[JSONValue]> = .idle
    @State private var problem: APIProblem?

    var body: some View {
        LoadableView(state: events, retry: load) { list in
            if list.isEmpty { EmptyState(title: "No events", text: "Events of your groups and your RSVPs appear here.", systemImage: "calendar") }
            else {
                List {
                    if let problem { Notice(.danger, problem.title, problem.detail) }
                    let grouped = Dictionary(grouping: list) { Calendar.current.startOfDay(for: $0["startsAt"].date ?? Date()) }
                    ForEach(grouped.keys.sorted(), id: \.self) { day in
                        Section(day.formatted(date: .complete, time: .omitted)) {
                            ForEach(grouped[day]!, id: \.self) { e in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack { Text(e["title"].text).font(.body.weight(.medium)); if e["state"].string == "cancelled" { Pill("cancelled", tone: .danger) }; if e["allDay"].bool == true { Pill("all day", tone: .neutral) } }
                                        Text("\(e["allDay"].bool == true ? "" : (e["startsAt"].date?.formatted(date: .omitted, time: .shortened) ?? "")) \(e["location"].string.map { "· \($0)" } ?? "") · \(e["attendance"]["going"].text) going").font(.caption).foregroundStyle(Exprsn.muted)
                                    }
                                    Spacer()
                                    Picker("RSVP", selection: Binding(get: { e["myRsvp"].string ?? e["myRsvp"]["response"].string ?? "" }, set: { r in Task { await rsvp(e, r) } })) { Text("—").tag(""); Text("Going").tag("going"); Text("Maybe").tag("maybe"); Text("Declined").tag("declined") }.fixedSize().labelsHidden()
                                }
                            }
                        }
                    }
                }
            }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") } } }
        .task { await load() }
    }
    private func load() async {
        let from = Date().addingTimeInterval(-30 * 86400), to = Date().addingTimeInterval(60 * 86400)
        events = await loaded { (try await session.client!.get("calendar/events", query: ["from": String(Int(from.timeIntervalSince1970 * 1000)), "to": String(Int(to.timeIntervalSince1970 * 1000))])).rows(itemsKey: "items") }
    }
    private func rsvp(_ e: JSONValue, _ r: String) async {
        guard !r.isEmpty else { return }
        do { _ = try await session.client!.post("calendar/events/\(e["id"].text)/rsvp", json(["response": .string(r)])); await load() } catch { problem = error.asProblem }
    }
}
