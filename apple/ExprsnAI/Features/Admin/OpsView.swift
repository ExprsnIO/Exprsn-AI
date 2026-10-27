import SwiftUI

/// Overview: alerts, counters, instances and capacity (`GET /admin/overview`).
struct OverviewScreen: View {
    @Environment(AppSession.self) private var session
    @State private var data: Loadable<JSONValue> = .idle
    @State private var window = "24h"
    @State private var problem: APIProblem?

    var body: some View {
        LoadableView(state: data, retry: load) { o in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack { Text("Scope: \(o["scope"].text)").font(.caption).foregroundStyle(Exprsn.muted); Spacer(); Picker("Window", selection: $window) { Text("1 h").tag("1h"); Text("24 h").tag("24h"); Text("7 d").tag("7d") }.pickerStyle(.segmented).frame(maxWidth: 200).onChange(of: window) { _, _ in Task { await load() } } }
                    if !o["alerts"].array.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Eyebrow("Alerts")
                            ForEach(o["alerts"].array, id: \.self) { a in
                                Notice(Tone(rawValue: a["tone"].text) ?? .warn, a["title"].text, a["text"].text, actionLabel: "Acknowledge") { Task { _ = try? await session.client?.post("admin/overview/alerts/acknowledge", json(["keys": .array([.string(a["key"].text)])])); await load() } }
                            }
                        }
                    }
                    let c = o["counters"]
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 140))], spacing: 10) {
                        StatTile(value: c["queued"].text, label: "Queued jobs", detail: c["oldestQueuedAt"].isNull ? nil : "oldest \(Fmt.when(c["oldestQueuedAt"]))")
                        StatTile(value: c["running"].text, label: "Running")
                        StatTile(value: c["failed"].text, label: "Failed", tone: (c["failed"].int ?? 0) > 0 ? .danger : .neutral)
                        StatTile(value: c["flags"]["open"].text, label: "Open flags", detail: "\(c["flags"]["overdue"].text) overdue", tone: (c["flags"]["overdue"].int ?? 0) > 0 ? .warn : .neutral)
                        StatTile(value: c["heldReplies"].text, label: "Held replies")
                        StatTile(value: c["signins"].text, label: "Sign-ins", detail: "\(c["refusedBySanction"].text) refused by sanction")
                        StatTile(value: c["workspaces"].text, label: "Workspaces")
                        if !c["sockets"].isNull { StatTile(value: c["sockets"]["total"].text, label: "Sockets", detail: "on \(c["sockets"]["instances"].text) instances") }
                    }
                    if !o["instances"].isNull {
                        Eyebrow("Instances")
                        ForEach(o["instances"].array, id: \.self) { i in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack { Text(i["node"].text).font(.body.weight(.medium)); Pill(i["state"].text); if i["self"].bool == true { Pill("answering", tone: .accent) } }
                                    Text("pid \(i["pid"].text) · v\(i["version"].text) · \(i["jobsClaimed"].text) jobs · \(i["sockets"].text) sockets · schema \(i["schema"]["state"].text) · beat \(Fmt.when(i["heartbeatAt"]))").font(.caption).foregroundStyle(Exprsn.muted)
                                }
                                Spacer()
                                if i["drain"].bool != true && session.has("platform:manage") { Button("Drain", role: .destructive) { Task { await drain(i["id"].text) } }.controlSize(.small) }
                            }.panel()
                        }
                    }
                    if !o["capacity"].isNull {
                        Eyebrow("Capacity")
                        HStack(spacing: 10) {
                            StatTile(value: Fmt.bytes(o["capacity"]["database"]["bytes"].double), label: "Database (\(o["capacity"]["database"]["client"].text))", detail: "pool \(o["capacity"]["database"]["pool"]["used"].text)/\(o["capacity"]["database"]["pool"]["max"].text)")
                            StatTile(value: Fmt.count(o["capacity"]["vectors"]["count"].double), label: "Vectors", detail: o["capacity"]["vectors"]["store"].text)
                            StatTile(value: o["capacity"]["blobs"]["ok"].bool == true ? "OK" : "Check", label: "Blobs (\(o["capacity"]["blobs"]["kind"].text))", tone: o["capacity"]["blobs"]["ok"].bool == true ? .ok : .danger)
                        }
                    }
                    if !o["schedules"]["items"].array.isEmpty {
                        Eyebrow("Schedules (\(o["schedules"]["total"].text))")
                        ForEach(o["schedules"]["items"].array.prefix(12), id: \.self) { s in HStack { Text(s["name"].text).font(.callout); Spacer(); if s["paused"].bool == true { Pill("paused", tone: .warn) }; Text("next \(Fmt.when(s["nextAt"]))").font(.caption).foregroundStyle(Exprsn.muted) } }
                    }
                    if !o["audit"].isNull {
                        Eyebrow("Recent audit")
                        ForEach(o["audit"].array, id: \.self) { a in HStack { Text(Fmt.when(a["ts"])).font(.caption).foregroundStyle(Exprsn.muted).frame(width: 90, alignment: .leading); Text(a["action"].text).font(.exprsnMonoSmall); Text(a["actor"].text).font(.caption); Spacer(); if a["redacted"].bool == true { Pill("redacted", tone: .warn) } } }
                    }
                    if let problem { Notice(.danger, problem.title, problem.detail) }
                }.padding(16)
            }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") } } }
        .task { await load() }
    }
    private func load() async { data = await loaded { try await session.client!.get("admin/overview", query: ["window": window]) } }
    private func drain(_ id: String) async { do { _ = try await session.client!.post("admin/overview/instances/\(id)/drain"); await load() } catch { problem = error.asProblem; session.note(error) } }
}

/// Jobs and queues: the queue per type, jobs, schedules, dead letters and the cache.
struct JobsScreen: View {
    var body: some View {
        ResourceScreen(spec: ResourceSpec(title: "Jobs and queues", subtitle: "Pause a type, retry failures, run a schedule now, redrive dead letters", tabs: [
            ResourceTab(title: "Jobs", path: "admin/jobs", query: ["window": "24h", "limit": "300"], itemsKey: "items", columns: [Column("Type", "type", .mono), Column("State", "state", .pill), Column("Tenant", "tenantName"), Column("Node", "node"), Column("Created", "createdAt", .date), Column("Duration", "durationMs", .count), Column("Error", "error")], detailPath: { "admin/jobs/\($0["id"].text)" }, actions: [
                RowAction(title: "Retry", path: { "admin/jobs/\($0["id"].text)/retry" }, systemImage: "arrow.clockwise"),
                RowAction(title: "Cancel", path: { "admin/jobs/\($0["id"].text)/cancel" }, fields: [FormField("reason", "Reason")], destructive: true)]),
            ResourceTab(title: "Queues", path: "admin/queues", itemsKey: "items", columns: [Column("Type", "type", .mono), Column("Domain", "domain"), Column("Queued", "queued", .count), Column("Running", "running", .count), Column("Failed 24h", "failed24h", .count), Column("p95", "p95Ms", .count), Column("Paused", "paused", .bool)], actions: [
                RowAction(title: "Pause", path: { "admin/queues/\($0["type"].text)/pause" }, fields: [FormField("reason", "Reason")], permission: "platform:manage"),
                RowAction(title: "Resume", path: { "admin/queues/\($0["type"].text)/resume" }, permission: "platform:manage"),
                RowAction(title: "Retry failed (24h)", path: { _ in "admin/jobs/retry-failed" }, fixed: ["window": "24h"])]),
            ResourceTab(title: "Schedules", path: "admin/schedules", itemsKey: "items", columns: [Column("Name", "name", .mono), Column("Every", "setting"), Column("Targets", "targets"), Column("Next", "nextAt", .date), Column("Paused", "paused", .bool)], actions: [
                RowAction(title: "Run now", path: { "admin/schedules/\($0["name"].text)/run" }, permission: "platform:manage", systemImage: "play"),
                RowAction(title: "Pause", path: { "admin/schedules/\($0["name"].text)/pause" }, fields: [FormField("reason", "Reason")], permission: "platform:manage"),
                RowAction(title: "Resume", path: { "admin/schedules/\($0["name"].text)/resume" }, permission: "platform:manage")]),
            ResourceTab(title: "Dead letters", path: "admin/dead-letters", itemsKey: "items", columns: [Column("Source", "source", .pill), Column("Item", "item"), Column("Reason", "reason"), Column("Attempts", "attempts"), Column("Last failed", "lastFailedAt", .date)], actions: [
                RowAction(title: "Redrive", path: { "admin/dead-letters/\($0["source"].text)/\($0["id"].text)/redrive" }),
                RowAction(title: "Discard", path: { "admin/dead-letters/\($0["source"].text)/\($0["id"].text)/discard" }, fields: [FormField("reason", "Reason", required: true)], destructive: true)]),
            ResourceTab(title: "Cache", path: "admin/cache", itemsKey: "items", columns: [Column("Namespace", "ns", .mono), Column("Tier", "tier"), Column("Requests", "requests", .count), Column("Hits", "hits", .count), Column("Entries", "entries", .count)], actions: [RowAction(title: "Invalidate", path: { "admin/cache/\($0["ns"].text)/invalidate" }, destructive: true)])
        ]))
    }
}

/// Usage and audit: the audit chain, verification, exports and usage reports.
struct UsageAuditScreen: View {
    @Environment(AppSession.self) private var session
    var body: some View {
        ResourceScreen(spec: ResourceSpec(title: "Usage and audit", subtitle: "The per-tenant hash chain, checkpoints, exports and usage", tabs: [
            ResourceTab(title: "Audit", path: "admin/audit", query: ["limit": "200"], columns: [Column("When", "ts", .date), Column("Action", "action", .mono), Column("Actor", "actor.username"), Column("Kind", "kind", .pill), Column("Decision", "decision", .pill), Column("Label", "label", .label), Column("Seq", "seq")], detailPath: { "admin/audit/\($0["id"].text)" }, actions: [
                RowAction(title: "Correct…", path: { "admin/audit/\($0["id"].text)/corrections" }, fields: [FormField("reason", "Reason", required: true), FormField("correction", "Correction", .multiline, required: true)])]),
            ResourceTab(title: "Summary", path: "admin/audit/summary", single: true),
            ResourceTab(title: "Checkpoints", path: "admin/audit/checkpoints", create: CreateSpec(title: "Sign the head", path: "admin/audit/checkpoints", fields: [])),
            ResourceTab(title: "Exports", path: "admin/exports", columns: [Column("Kind", "kind", .pill), Column("State", "state", .pill), Column("Rows", "rows", .count), Column("Omitted", "omitted", .count), Column("By", "createdByName"), Column("Created", "createdAt", .date)], create: CreateSpec(title: "Export audit CSV", path: "admin/audit/exports", fields: [FormField("filtered", "Leave out rows above my clearance", .bool, defaultValue: "true"), FormField("from", "From (epoch ms)", .number), FormField("to", "To (epoch ms)", .number)])),
            ResourceTab(title: "SIEM", path: "admin/audit/stream", single: true),
            ResourceTab(title: "Usage by model", path: "admin/usage/summary", query: ["by": "model", "days": "14"], itemsKey: "rows", columns: [Column("Model", "name"), Column("Prompt", "prompt", .count), Column("Output", "output", .count), Column("Thinking", "thinking", .count), Column("GPU ms", "gpuMs", .count), Column("Requests", "requests", .count)], permission: "usage:read"),
            ResourceTab(title: "Usage by person", path: "admin/usage/summary", query: ["by": "user", "days": "14"], itemsKey: "rows", permission: "usage:read"),
            ResourceTab(title: "Daily", path: "admin/usage/daily", query: ["days": "30"], columns: [Column("Day", "day"), Column("Tokens", "tokens", .count), Column("GPU seconds", "gpuSeconds", .count)], permission: "usage:read"),
            ResourceTab(title: "Quotas", path: "admin/quotas", single: true, permission: "usage:read")
        ]))
    }
}
