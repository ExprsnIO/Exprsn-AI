import SwiftUI

/// Flags: the review queue for reviewers and moderators, with decide, escalate, reassign and the eval-set link.
struct FlagsScreen: View {
    @Environment(AppSession.self) private var session
    @State private var queue: Loadable<JSONValue> = .idle
    @State private var selected: String?
    @State private var filter = "open"

    var body: some View {
        LoadableView(state: queue, retry: load) { q in
            let items = q["items"].array.filter { filter == "all" || $0["state"].string == filter }
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    HStack(spacing: 12) {
                        StatTile(value: q["open"].text, label: "Open").frame(maxWidth: 120)
                        StatTile(value: q["overdue"].text, label: "Overdue", tone: (q["overdue"].int ?? 0) > 0 ? .danger : .neutral).frame(maxWidth: 120)
                        if let o = q["otherWorkspaces"].int, o > 0 { Text("\(o) in other workspaces").font(.caption).foregroundStyle(Exprsn.muted) }
                        Spacer()
                        Picker("State", selection: $filter) { Text("Open").tag("open"); Text("Confirmed").tag("confirmed"); Text("Dismissed").tag("dismissed"); Text("All").tag("all") }.pickerStyle(.segmented).frame(maxWidth: 320)
                    }.padding(12)
                    List(items, id: \.self, selection: Binding(get: { selected.flatMap { s in items.first { $0["ref"].text == s } } }, set: { selected = $0?["ref"].text })) { f in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack { Text(f["ref"].text).font(.exprsnMonoSmall); Pill(f["severity"].text, tone: f["severity"].string == "high" ? .danger : f["severity"].string == "medium" ? .warn : .neutral); Pill(f["kind"].text, tone: .info); Spacer(); LabelBadge(f["label"].string, small: true) }
                            Text(f["restricted"].bool == true ? "Redacted: above your clearance" : (f["rule"].string ?? f["checkpoint"].text)).font(.body).lineLimit(1)
                            HStack { Text("\(f["checkpoint"].text) · \(f["action"].text)").font(.caption).foregroundStyle(Exprsn.muted); Spacer(); if let d = f["dueAt"].date { Text(d < Date() ? "overdue" : "due \(Fmt.when(d))").font(.caption).foregroundStyle(d < Date() ? Exprsn.dangerFg : Exprsn.muted) } }
                        }
                    }.listStyle(.plain)
                }.frame(minWidth: 320, idealWidth: 400)
                Divider()
                if let ref = selected { FlagDetail(ref: ref, reload: load) } else { EmptyState(title: "Choose a flag", text: "Decide, escalate or reassign it; a confirmation becomes an eval case of the rule.", systemImage: "flag") }
            }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") } } }
        .task { await load() }
    }
    private func load() async { queue = await loaded { try await session.client!.get("flags") } }
}

struct FlagDetail: View {
    @Environment(AppSession.self) private var session
    var ref: String
    var reload: () async -> Void
    @State private var flag: Loadable<JSONValue> = .idle
    @State private var reason = ""
    @State private var problem: APIProblem?
    @State private var reviewers: [JSONValue] = []
    @State private var escalateTo = "tenant"
    @State private var evalSet = ""

    var body: some View {
        LoadableView(state: flag, retry: load) { f in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack { Text(f["ref"].text).font(.title2.weight(.semibold)); Pill(f["state"].text); Pill(f["severity"].text); Spacer(); LabelBadge(f["label"].string) }
                    if f["restricted"].bool == true { Notice(.warn, "Redacted", "This flag is labelled above your clearance. You can only reassign it.") }
                    if let ex = f["excerpt"].object["span"]?.string {
                        VStack(alignment: .leading, spacing: 2) {
                            Eyebrow("Flagged text")
                            (Text(f["excerpt"]["before"].text).foregroundStyle(Exprsn.muted) + Text(ex).foregroundStyle(Exprsn.dangerFg).bold() + Text(f["excerpt"]["after"].text).foregroundStyle(Exprsn.muted)).font(.callout).textSelection(.enabled)
                        }.panel()
                    }
                    Grid(alignment: .leading, verticalSpacing: 6) {
                        GridRow { Text("Rule").foregroundStyle(Exprsn.muted); Text("\(f["rule"].text) (\(f["setName"].text) v\(f["setVersion"].text))") }
                        GridRow { Text("Checkpoint").foregroundStyle(Exprsn.muted); Text("\(f["checkpoint"].text) → \(f["action"].text)") }
                        GridRow { Text("Actor").foregroundStyle(Exprsn.muted); Text(f["actor"].text) }
                        GridRow { Text("Assignee").foregroundStyle(Exprsn.muted); Text(f["assignee"].text.isEmpty ? "unassigned" : f["assignee"].text) }
                        GridRow { Text("Prior").foregroundStyle(Exprsn.muted); Text("\(f["prior"]["confirmed"].text) confirmed, \(f["prior"]["dismissed"].text) dismissed on this rule") }
                        GridRow { Text("Due").foregroundStyle(Exprsn.muted); Text(Fmt.when(f["dueAt"])) }
                        if let n = f["note"].string { GridRow { Text("Note").foregroundStyle(Exprsn.muted); Text(n) } }
                    }.font(.callout)
                    if f["state"].string == "open" && f["restricted"].bool != true {
                        VStack(alignment: .leading, spacing: 8) {
                            Eyebrow("Decide")
                            TextField("Reason (optional)", text: $reason).textFieldStyle(.roundedBorder)
                            HStack {
                                Button("Confirm") { Task { await act("flags/\(ref)/decide", json(["decision": "confirmed", "reason": reason.isEmpty ? nil : .string(reason)])) } }.buttonStyle(.borderedProminent)
                                Button("Dismiss") { Task { await act("flags/\(ref)/decide", json(["decision": "dismissed", "reason": reason.isEmpty ? nil : .string(reason)])) } }
                                if session.has("moderation:review") && !f["conversationId"].isNull {
                                    Button("Hide object", role: .destructive) { Task { await act("moderation/flags/\(ref)/action", json(["action": "hide", "reason": .string(reason.isEmpty ? "Hidden by reviewer" : reason)])) } }
                                }
                            }
                        }.panel()
                        VStack(alignment: .leading, spacing: 8) {
                            Eyebrow("Escalate or reassign")
                            HStack {
                                Picker("To", selection: $escalateTo) { Text("Workspace").tag("workspace"); Text("Tenant").tag("tenant"); Text("Platform").tag("platform") }.fixedSize()
                                Button("Escalate") { Task { await act("flags/\(ref)/escalate", json(["to": .string(escalateTo), "note": reason.isEmpty ? nil : .string(reason)])) } }
                            }
                            if reviewers.isEmpty { Button("Load reviewers") { Task { reviewers = (try? await session.client?.get("flags/\(ref)/reviewers"))?.array ?? [] } } }
                            ForEach(reviewers, id: \.self) { r in HStack { Text(r["name"].text); Text(r["roles"].text).font(.caption).foregroundStyle(Exprsn.muted); Spacer(); Button("Assign") { Task { await act("flags/\(ref)/reassign", json(["userId": .string(r["id"].text)])) } }.controlSize(.small) } }
                        }.panel()
                        if session.has("guardrails:manage") {
                            VStack(alignment: .leading, spacing: 8) {
                                Eyebrow("Teach the rule")
                                HStack { TextField("Eval set name", text: $evalSet).textFieldStyle(.roundedBorder); Button("Add as positive case") { Task { await act("flags/\(ref)/eval", json(["evalSet": .string(evalSet), "expected": "positive"])) } }.disabled(evalSet.isEmpty) }
                                Button("Draft a shadow rule from this span") { Task { await act("flags/\(ref)/rule", json(["setId": .string(f["setId"].text)])) } }.disabled(f["setId"].isNull)
                            }.panel()
                        }
                    }
                    if let problem { Notice(.danger, problem.title, problem.detail) }
                    if !f["history"].array.isEmpty {
                        Eyebrow("History")
                        ForEach(f["history"].array, id: \.self) { h in HStack { Text(Fmt.when(h["at"])).font(.caption).foregroundStyle(Exprsn.muted).frame(width: 90, alignment: .leading); Text(h["action"].string ?? h["text"].text).font(.callout); Text(h["by"].text).font(.caption).foregroundStyle(Exprsn.muted) } }
                    }
                }.padding(16)
            }
        }
        .task(id: ref) { await load() }
    }
    private func load() async { flag = await loaded { try await session.client!.get("flags/\(ref)") }; reviewers = [] }
    private func act(_ path: String, _ body: JSONValue) async {
        problem = nil
        do { _ = try await session.client?.post(path, body); await load(); await reload() } catch { problem = error.asProblem }
    }
}

/// Moderation: queues, appeals, sanctions, actions, providers and dead letters.
struct ModerationScreen: View {
    @Environment(AppSession.self) private var session
    var body: some View {
        ResourceScreen(spec: ResourceSpec(title: "Moderation", subtitle: "Queues, appeals, sanctions and external providers", tabs: [
            ResourceTab(title: "Queues", path: "moderation/queues", itemsKey: "items", columns: [Column("Queue", "name"), Column("Priority", "priority"), Column("SLA (min)", "slaMinutes"), Column("Escalates to", "escalateTo", .pill), Column("Enabled", "enabled", .bool)], detailPath: { "moderation/queues/\($0["id"].text)/flags" }, actions: [
                RowAction(title: "Disable", method: .patch, path: { "moderation/queues/\($0["id"].text)" }, destructive: true, confirm: "Disable this queue?", permission: "moderation:manage", fixed: ["enabled": false]),
                RowAction(title: "Enable", method: .patch, path: { "moderation/queues/\($0["id"].text)" }, permission: "moderation:manage", fixed: ["enabled": true]),
                RowAction(title: "Delete", method: .delete, path: { "moderation/queues/\($0["id"].text)" }, destructive: true, confirm: "Delete this queue? Its flags become unrouted.", permission: "moderation:manage")],
                create: CreateSpec(title: "New queue", path: "moderation/queues", fields: [FormField("name", "Name", required: true), FormField("slaMinutes", "SLA minutes", .number, required: true, defaultValue: "240"), FormField("escalateTo", "Escalate to", .select(["workspace", "tenant", "platform"]), defaultValue: "tenant"), FormField("priority", "Priority", .number, defaultValue: "100"), FormField("kinds", "Kinds (JSON array)", .json, defaultValue: "[]")]), permission: "moderation:review"),
            ResourceTab(title: "Appeals", path: "moderation/appeals", itemsKey: "items", columns: [Column("Ref", "ref", .mono), Column("Kind", "kind", .pill), Column("State", "state", .pill), Column("Label", "label", .label), Column("Submitted", "createdAt", .date)], detailPath: { "moderation/appeals/\($0["ref"].text)" }, actions: [
                RowAction(title: "Review", path: { "moderation/appeals/\($0["ref"].text)/review" }, systemImage: "eye"),
                RowAction(title: "Uphold", path: { "moderation/appeals/\($0["ref"].text)/decide" }, fields: [FormField("note", "Note", .multiline)], fixed: ["decision": "upheld"]),
                RowAction(title: "Deny", path: { "moderation/appeals/\($0["ref"].text)/decide" }, fields: [FormField("note", "Note", .multiline)], destructive: true, fixed: ["decision": "denied"])], permission: "moderation:review"),
            ResourceTab(title: "Sanctions", path: "moderation/sanctions", itemsKey: "items", columns: [Column("User", "userId", .mono), Column("Kind", "kind", .pill), Column("State", "state", .pill), Column("Reason", "reason"), Column("Ends", "endsAt", .date)], actions: [
                RowAction(title: "Lift", path: { "moderation/sanctions/\($0["id"].text)/lift" }, fields: [FormField("reason", "Reason")], permission: "moderation:sanction")],
                create: CreateSpec(title: "New sanction", path: "moderation/sanctions", fields: [FormField("userId", "User id", required: true), FormField("kind", "Kind", .select(["warn", "suspend", "ban"]), defaultValue: "warn"), FormField("durationMinutes", "Duration (minutes)", .number), FormField("reason", "Reason", .multiline, required: true)]), permission: "moderation:sanction", note: "Sanctions need a browser session with a recent sign-in; use the step-up prompt when asked."),
            ResourceTab(title: "Actions", path: "moderation/actions", itemsKey: "items", columns: [Column("Object", "objectType", .pill), Column("Id", "objectId", .mono), Column("Action", "action", .pill), Column("State", "state", .pill), Column("Source", "source"), Column("When", "createdAt", .date)], permission: "moderation:review"),
            ResourceTab(title: "Providers", path: "moderation/providers", itemsKey: "items", columns: [Column("Name", "name"), Column("Kind", "kind", .pill), Column("Mode", "mode", .pill), Column("Enabled", "enabled", .bool), Column("Zone", "zone")], detailPath: { "moderation/providers/\($0["id"].text)/verdicts" }, permission: "moderation:manage"),
            ResourceTab(title: "Dead letters", path: "moderation/dead-letters", itemsKey: "items", actions: [RowAction(title: "Redrive", path: { "moderation/dead-letters/\($0["id"].text)/redrive" })], permission: "moderation:manage"),
            ResourceTab(title: "Types", path: "moderation/types", itemsKey: "items", columns: [Column("Type", "type", .mono), Column("Description", "description"), Column("Hideable", "hide", .bool)]),
            ResourceTab(title: "Mine", path: "moderation/mine", single: true, note: "Your own sanctions, actions on your content and appeals.")
        ]))
    }
}
