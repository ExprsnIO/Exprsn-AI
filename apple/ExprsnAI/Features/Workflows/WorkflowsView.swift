import SwiftUI

/// Workflows: the list, runs, approvals, templates and operations; the graph is read, not drawn (the editor
/// stays in the console).
struct WorkflowsScreen: View {
    @Environment(AppSession.self) private var session
    var body: some View {
        ResourceScreen(spec: ResourceSpec(title: "Workflows", subtitle: "Runs, approvals, schedules and dead letters; edit graphs in the web console", tabs: [
            ResourceTab(title: "Workflows", path: "workflows", columns: [Column("Name", "name"), Column("Label", "label", .label), Column("Published", "publishedVersion"), Column("Draft rev", "draftRev"), Column("Waiting", "waiting", .count), Column("Updated", "updatedAt", .date)], detailPath: { "workflows/\($0["id"].text)" }, actions: [
                RowAction(title: "Run", path: { "workflows/\($0["id"].text)/runs" }, fields: [FormField("input", "Input (JSON)", .json, required: true, defaultValue: "{}")], systemImage: "play"),
                RowAction(title: "Dry run", path: { "workflows/\($0["id"].text)/dry-run" }, fields: [FormField("input", "Input (JSON)", .json, required: true, defaultValue: "{}")], permission: "workflows:manage"),
                RowAction(title: "Validate draft", path: { "workflows/\($0["id"].text)/validate" }, permission: "workflows:manage"),
                RowAction(title: "Publish", path: { "workflows/\($0["id"].text)/publish" }, fields: [FormField("note", "Note")], permission: "workflows:manage"),
                RowAction(title: "Publish as tool", path: { "workflows/\($0["id"].text)/tool" }, fields: [FormField("name", "Tool name", required: true), FormField("description", "Description", required: true), FormField("sideEffect", "Side effect", .select(["read", "write", "destructive"]), defaultValue: "read")], permission: "workflows:manage"),
                RowAction(title: "Run history", method: .get, path: { "workflows/\($0["id"].text)/runs" }),
                RowAction(title: "Delete", method: .delete, path: { "workflows/\($0["id"].text)" }, destructive: true, confirm: "Delete this workflow?", permission: "workflows:manage")],
                create: CreateSpec(title: "New workflow", path: "workflows", fields: [FormField("name", "Name", required: true), FormField("description", "Description"), FormField("label", "Label", .label, defaultValue: "internal")])),
            ResourceTab(title: "Approvals", path: "workflow-approvals", columns: [Column("Workflow", "workflow"), Column("Step", "step"), Column("Role", "role"), Column("State", "state", .pill), Column("Due", "dueAt", .date), Column("Can decide", "canDecide", .bool)], actions: [
                RowAction(title: "Approve", path: { "workflow-approvals/\($0["id"].text)" }, fields: [FormField("reason", "Reason")], fixed: ["decision": "approve"]),
                RowAction(title: "Reject", path: { "workflow-approvals/\($0["id"].text)" }, fields: [FormField("reason", "Reason", required: true)], destructive: true, fixed: ["decision": "reject"])]),
            ResourceTab(title: "Runs", path: "workflow-activity", itemsKey: "items", detailPath: { "workflow-runs/\($0["id"].text)" }, actions: [
                RowAction(title: "Cancel", path: { "workflow-runs/\($0["id"].text)/cancel" }, destructive: true),
                RowAction(title: "Replay", path: { "workflow-runs/\($0["id"].text)/replay" }, fields: [FormField("from", "From step (node id)", required: true)])]),
            ResourceTab(title: "Schedules", path: "workflow-schedules", itemsKey: "items"),
            ResourceTab(title: "Dead letters", path: "workflow-dead-letters", itemsKey: "items", actions: [RowAction(title: "Redrive", path: { "workflow-dead-letters/\($0["id"].text)/redrive" })], permission: "workflows:manage"),
            ResourceTab(title: "Templates", path: "workflow-templates", itemsKey: "items", actions: [RowAction(title: "Use template", path: { "workflow-templates/\($0["id"].text)/instantiate" }, fields: [FormField("name", "Name", required: true)])]),
            ResourceTab(title: "Tool palette", path: "workflow-tools", columns: [Column("Tool", "name"), Column("Impl", "impl", .pill), Column("Side effect", "sideEffect", .pill), Column("Label", "label", .label), Column("Status", "status", .pill)]),
            ResourceTab(title: "Analytics", path: "workflow-analytics", single: true)
        ]))
    }
}
