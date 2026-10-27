import SwiftUI

// MARK: Declarative resource screens
//
// The console has 70-odd admin screens over 1,600 routes. The app draws the busiest ones by hand and the rest
// from these specs: a tab per collection route, columns to show, a detail route and the actions a row takes.

enum ColumnKind { case text, pill, label, date, bytes, count, bool, mono }

struct Column: Identifiable {
    var title: String
    var key: String
    var kind: ColumnKind = .text
    var id: String { key }
    init(_ title: String, _ key: String, _ kind: ColumnKind = .text) { self.title = title; self.key = key; self.kind = kind }
}

enum FieldKind: Equatable { case text, secure, number, bool, multiline, select([String]), json, label }

struct FormField: Identifiable {
    var key: String
    var title: String
    var kind: FieldKind = .text
    var required: Bool = false
    var defaultValue: String = ""
    var help: String? = nil
    var id: String { key }
    init(_ key: String, _ title: String, _ kind: FieldKind = .text, required: Bool = false, defaultValue: String = "", help: String? = nil) {
        self.key = key; self.title = title; self.kind = kind; self.required = required; self.defaultValue = defaultValue; self.help = help
    }
}

struct RowAction: Identifiable {
    var id = UUID()
    var title: String
    var method: HTTPMethod = .post
    var path: (JSONValue) -> String
    var fields: [FormField] = []
    var destructive = false
    var confirm: String? = nil
    var permission: String? = nil
    /// Fixed body fields merged under the form's (e.g. `{"decision": "approve"}`).
    var fixed: [String: JSONValue] = [:]
    var systemImage: String? = nil
}

struct CreateSpec { var title: String; var path: String; var fields: [FormField]; var method: HTTPMethod = .post }

struct ResourceTab: Identifiable {
    var title: String
    var path: String
    var query: [String: String?] = [:]
    /// The key holding the rows when the answer is an object (`items`, `books`…); nil for a top-level array.
    var itemsKey: String? = nil
    var columns: [Column] = []
    var detailPath: ((JSONValue) -> String)? = nil
    var actions: [RowAction] = []
    var create: CreateSpec? = nil
    /// When the route answers one object (a settings page), show it as a detail instead of rows.
    var single = false
    var permission: String? = nil
    var note: String? = nil
    var id: String { title }
}

struct ResourceSpec {
    var title: String
    var subtitle: String? = nil
    var tabs: [ResourceTab]
}

struct ResourceRow: Identifiable, Hashable {
    let id: String
    let value: JSONValue
    static func == (a: ResourceRow, b: ResourceRow) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

extension JSONValue {
    /// The rows of a collection answer, whatever key they sit under.
    func rows(itemsKey: String?) -> [JSONValue] {
        if case .array(let a) = self { return a }
        if let k = itemsKey, case .array(let a) = self[k] { return a }
        for k in ["items", "rows", "data", "results", "list"] { if case .array(let a) = self[k] { return a } }
        if case .object(let o) = self, let first = o.values.first(where: { if case .array = $0 { return true }; return false }), case .array(let a) = first { return a }
        return []
    }
    var rowId: String { ["id", "ref", "name", "key", "slug", "month", "type", "version"].compactMap { self[$0].isNull ? nil : self[$0].text }.first ?? prettyPrinted.hashValue.description }
}

func humanKey(_ k: String) -> String {
    var out = ""
    for (i, ch) in k.enumerated() {
        if ch.isUppercase && i > 0 { out += " " }
        out.append(i == 0 ? Character(ch.uppercased()) : ch)
    }
    return out.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "At", with: "at", options: [], range: out.range(of: "At", options: .backwards))
}

/// A cell drawn as its column asks.
struct CellView: View {
    var value: JSONValue
    var kind: ColumnKind
    var body: some View {
        switch kind {
        case .pill: if value.text.isEmpty { Text("—").foregroundStyle(Exprsn.muted) } else { Pill(value.text) }
        case .label: LabelBadge(value.string, small: true)
        case .date: Text(Fmt.when(value)).foregroundStyle(Exprsn.fg2)
        case .bytes: Text(Fmt.bytes(value.double)).monospacedDigit()
        case .count: Text(Fmt.count(value.double)).monospacedDigit()
        case .bool: Image(systemName: value.bool == true ? "checkmark.circle.fill" : "circle").foregroundStyle(value.bool == true ? Exprsn.okFg : Exprsn.faint)
        case .mono: Text(value.text).font(.exprsnMonoSmall).lineLimit(1)
        case .text: Text(value.text).lineLimit(1)
        }
    }
}

/// Lists rows of a tab; a Table where there is room, a List on a phone.
struct ResourceScreen: View {
    @Environment(AppSession.self) private var session
    var spec: ResourceSpec
    @State private var tab: String = ""
    @State private var rows: Loadable<[ResourceRow]> = .idle
    @State private var single: JSONValue?
    @State private var selection: ResourceRow.ID?
    @State private var query = ""
    @State private var creating = false
    @State private var problem: APIProblem?

    private var current: ResourceTab { spec.tabs.first { $0.id == tab } ?? spec.tabs[0] }
    private var visibleTabs: [ResourceTab] { spec.tabs.filter { $0.permission == nil || session.has($0.permission!) } }

    var body: some View {
        VStack(spacing: 0) {
            if visibleTabs.count > 1 {
                Group {
                    if visibleTabs.count > 5 { Picker("Section", selection: $tab) { ForEach(visibleTabs) { Text($0.title).tag($0.id) } }.pickerStyle(.menu) }
                    else { Picker("Section", selection: $tab) { ForEach(visibleTabs) { Text($0.title).tag($0.id) } }.pickerStyle(.segmented) }
                }.labelsHidden().padding([.horizontal, .top], 12).padding(.bottom, 6).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let note = current.note { Text(note).font(.caption).foregroundStyle(Exprsn.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.bottom, 6) }
            if let problem { Notice(.danger, problem.title, problem.detail).padding(.horizontal, 12) }
            if current.single {
                if let single { ScrollView { ResourceDetail(row: ResourceRow(id: "single", value: single), tab: current, reload: reload).padding(12) } } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            } else {
                LoadableView(state: rows, retry: reload) { list in
                    let shown = list.filter { query.isEmpty || $0.value.prettyPrinted.localizedCaseInsensitiveContains(query) }
                    if shown.isEmpty { EmptyState(title: "Nothing here", text: query.isEmpty ? "No \(current.title.lowercased()) yet." : "No rows match \"\(query)\".") }
                    else {
                        // A Table's column list must not change in place (TableColumnForEach aborts in AttributeGraph when it does), so the
                        // table is recreated whenever the derived columns change.
                        let cols = columns(for: list)
                        ResourceTable(rows: shown, columns: cols, selection: $selection).id(cols.map(\.key).joined(separator: "|"))
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "Filter")
        .navigationTitle(spec.title)
        #if os(macOS)
        .navigationSubtitle(spec.subtitle ?? "")
        #endif
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let c = current.create { Button { creating = true } label: { Label(c.title, systemImage: "plus") } }
                Button { Task { await reload() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.keyboardShortcut("r")
            }
        }
        .inspector(isPresented: Binding(get: { selection != nil }, set: { if !$0 { selection = nil } })) {
            if let id = selection, let row = rows.value?.first(where: { $0.id == id }) {
                ScrollView { ResourceDetail(row: row, tab: current, reload: reload).padding(12) }
                    .inspectorColumnWidth(min: 300, ideal: 380, max: 560)
            }
        }
        .sheet(isPresented: $creating) {
            if let c = current.create {
                FormSheet(title: c.title, fields: c.fields) { body in
                    _ = try await session.client!.json(c.method, c.path, body: body); await reload()
                }
            }
        }
        .task(id: tab) {
            debugLog("resource \(spec.title): task tab='\(tab)' of \(visibleTabs.count)")
            if tab.isEmpty { tab = visibleTabs.first?.id ?? "" } else { await reload() }
        }
    }

    private func columns(for list: [ResourceRow]) -> [Column] {
        if !current.columns.isEmpty {
            // Keep the columns the rows actually carry (route shapes drift between releases).
            let kept = list.isEmpty ? current.columns : current.columns.filter { c in c.key.isEmpty || list.prefix(50).contains { !$0.value.at(c.key).isNull } }
            if !kept.isEmpty { return kept }
        }
        guard let first = list.first?.value.object else { return [Column("Value", "")] }
        let preferred = ["name", "displayName", "title", "username", "id", "ref", "kind", "type", "state", "status", "health", "label", "updatedAt", "createdAt"]
        var keys = preferred.filter { first[$0] != nil }
        for k in first.keys.sorted() where !keys.contains(k) && !(first[k]?.isContainer ?? true) && keys.count < 7 { keys.append(k) }
        return keys.map { k in
            let kind: ColumnKind = k == "label" ? .label : ["state", "status", "health", "stage"].contains(k) ? .pill : k.hasSuffix("At") ? .date : k == "id" ? .mono : .text
            return Column(humanKey(k), k, kind)
        }
    }

    func reload() async {
        guard let client = session.client else { return }
        problem = nil
        if current.single {
            single = nil
            do { single = try await client.get(current.path, query: current.query); debugLog("resource \(spec.title)/\(current.title): single loaded") } catch { problem = error.asProblem; debugLog("resource \(spec.title)/\(current.title): \(error.asProblem.title)") }
            return
        }
        rows = .loading
        rows = await loaded {
            let v = try await client.get(current.path, query: current.query)
            var seen = Set<String>()
            return v.rows(itemsKey: current.itemsKey).enumerated().map { i, r in
                var id = r.rowId
                if seen.contains(id) { id += "#\(i)" }
                seen.insert(id)
                return ResourceRow(id: id, value: r)
            }
        }
    }
}

struct ResourceTable: View {
    var rows: [ResourceRow]
    var columns: [Column]
    @Binding var selection: ResourceRow.ID?
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    var body: some View {
        #if os(iOS)
        if sizeClass == .compact { list } else { table }
        #else
        table
        #endif
    }

    private var table: some View {
        Table(rows, selection: $selection) {
            TableColumnForEach(columns) { col in
                TableColumn(col.title) { (row: ResourceRow) in CellView(value: col.key.isEmpty ? row.value : row.value.at(col.key), kind: col.kind) }
            }
        }
    }

    private var list: some View {
        List(rows, selection: $selection) { row in
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(columns.first.map { $0.key.isEmpty ? row.value.text : row.value.at($0.key).text } ?? row.id).font(.body.weight(.medium)).lineLimit(1)
                    Spacer()
                    if let c = columns.first(where: { $0.kind == .pill }) { Pill(row.value.at(c.key).text) }
                }
                let rest = columns.dropFirst().filter { $0.kind != .pill }.map { "\($0.title): \(row.value.at($0.key).text)" }.filter { !$0.hasSuffix(": ") }
                if !rest.isEmpty { Text(rest.joined(separator: " · ")).font(.caption).foregroundStyle(Exprsn.muted).lineLimit(2) }
            }.tag(row.id)
        }
    }
}

/// One row: the detail route (if any), the JSON as an outline, and its actions.
struct ResourceDetail: View {
    @Environment(AppSession.self) private var session
    var row: ResourceRow
    var tab: ResourceTab
    var reload: () async -> Void
    @State private var detail: Loadable<JSONValue> = .idle
    @State private var action: RowAction?
    @State private var confirming: RowAction?
    @State private var problem: APIProblem?
    @State private var done: String?

    private var value: JSONValue { detail.value ?? row.value }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(value.text.isEmpty ? row.id : value.text).font(.title3.weight(.semibold))
                    if !value["id"].isNull { Text(value["id"].text).font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted).textSelection(.enabled) }
                }
                Spacer()
                if let s = value["state"].string ?? value["status"].string ?? value["health"].string { Pill(s) }
                if let l = value["label"].string { LabelBadge(l, small: true) }
            }
            let acts = tab.actions.filter { $0.permission == nil || session.has($0.permission!) }
            if !acts.isEmpty {
                HStack { ForEach(acts) { a in
                    Button(role: a.destructive ? .destructive : nil) { if a.fields.isEmpty { confirming = a } else { action = a } } label: { if let i = a.systemImage { Label(a.title, systemImage: i) } else { Text(a.title) } }
                        .buttonStyle(.bordered).controlSize(.small)
                } }.flexibleWrap()
            }
            if let problem { Notice(.danger, problem.title, problem.detail) }
            if let done { Notice(.ok, done) }
            if detail.isLoading { ProgressView().controlSize(.small) }
            JSONTree(value: value)
        }
        .task(id: row.id) {
            guard let p = tab.detailPath, let client = session.client else { detail = .idle; return }
            detail = .loading
            detail = await loaded { try await client.get(p(row.value)) }
        }
        .sheet(item: $action) { a in
            FormSheet(title: a.title, fields: a.fields) { body in try await run(a, body: body) }
        }
        .confirmationDialog(confirming?.confirm ?? "\(confirming?.title ?? "")?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let a = confirming { Button(a.title, role: a.destructive ? .destructive : nil) { Task { try? await run(a, body: .object([:])) } } }
        }
    }

    private func run(_ a: RowAction, body: JSONValue) async throws {
        guard let client = session.client else { return }
        problem = nil; done = nil
        var merged = body.object
        for (k, v) in a.fixed { merged[k] = v }
        do {
            _ = try await client.json(a.method, a.path(value), body: merged.isEmpty ? nil : .object(merged))
            done = "\(a.title): done."
            if let p = tab.detailPath { detail = await loaded { try await client.get(p(row.value)) } }
            await reload()
        } catch { problem = error.asProblem; session.note(error); throw error }
    }
}

/// A recursive outline of a JSON value.
struct JSONTree: View {
    var value: JSONValue
    var depth = 0

    var body: some View {
        switch value {
        case .object(let o):
            let keys = o.keys.sorted { a, b in (o[a]!.isContainer ? 1 : 0, a) < (o[b]!.isContainer ? 1 : 0, b) }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(keys, id: \.self) { k in
                    let v = o[k]!
                    if v.isContainer && !(v.array.isEmpty && v.object.isEmpty) {
                        DisclosureGroup { JSONTree(value: v, depth: depth + 1).padding(.leading, 8) } label: {
                            HStack { Text(humanKey(k)).font(.subheadline.weight(.medium)); Spacer(); Text(v.text).font(.caption).foregroundStyle(Exprsn.muted) }
                        }
                    } else if k == "label", let l = v.string {
                        LabeledContent(humanKey(k)) { LabelBadge(l, small: true) }
                    } else if ["state", "status", "health", "stage", "decision", "action", "result"].contains(k), let s = v.string {
                        LabeledContent(humanKey(k)) { Pill(s) }
                    } else if k.hasSuffix("At") || k.hasSuffix("_at") || k == "ts" {
                        KeyValueRow(key: humanKey(k), value: v.date.map { Fmt.when($0) } ?? v.text)
                    } else if k == "id" || k.hasSuffix("Id") || k == "hash" || k == "digest" || k == "url" {
                        KeyValueRow(key: humanKey(k), value: v.text, mono: true)
                    } else {
                        KeyValueRow(key: humanKey(k), value: v.text)
                    }
                }
            }
        case .array(let a):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(a.enumerated()), id: \.offset) { i, item in
                    if item.isContainer {
                        DisclosureGroup(item.text.isEmpty ? "Item \(i + 1)" : item.text) { JSONTree(value: item, depth: depth + 1).padding(.leading, 8) }
                    } else { Text(item.text).font(.callout) }
                }
            }
        default:
            Text(value.text).font(.callout).textSelection(.enabled)
        }
    }
}

/// A form built from fields; its values go to `submit` as one JSON object.
struct FormSheet: View {
    @Environment(\.dismiss) private var dismiss
    var title: String
    var fields: [FormField]
    var submit: (JSONValue) async throws -> Void
    @State private var values: [String: String] = [:]
    @State private var bools: [String: Bool] = [:]
    @State private var problem: APIProblem?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                ForEach(fields) { f in
                    Section {
                        switch f.kind {
                        case .text: TextField(f.title, text: binding(f))
                        case .secure: SecureField(f.title, text: binding(f))
                        case .number: TextField(f.title, text: binding(f))
                        case .multiline, .json: VStack(alignment: .leading) { Text(f.title).font(.caption).foregroundStyle(Exprsn.muted); TextEditor(text: binding(f)).font(f.kind == .json ? .exprsnMonoSmall : .body).frame(minHeight: 100) }
                        case .bool: Toggle(f.title, isOn: Binding(get: { bools[f.key] ?? (f.defaultValue == "true") }, set: { bools[f.key] = $0 }))
                        case .select(let opts): Picker(f.title, selection: binding(f)) { Text("—").tag(""); ForEach(opts, id: \.self) { Text($0).tag($0) } }
                        case .label: Picker(f.title, selection: binding(f)) { ForEach(DataLabel.allCases) { Text($0.title).tag($0.rawValue) } }
                        }
                    } footer: { if let h = f.help { Text(h) } }
                }
                if let problem { Notice(.danger, problem.title, problem.detail) }
            }
            .formStyle(.grouped)
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(busy ? "Working…" : "Submit") { Task { await go() } }.disabled(busy || !valid) }
            }
            .onAppear { for f in fields { values[f.key] = f.defaultValue } }
        }
        .frame(minWidth: 440, minHeight: 300)
    }

    private var valid: Bool { fields.allSatisfy { !$0.required || !(values[$0.key] ?? "").isEmpty } }
    private func binding(_ f: FormField) -> Binding<String> { Binding(get: { values[f.key] ?? f.defaultValue }, set: { values[f.key] = $0 }) }

    var bodyValue: JSONValue {
        var o: [String: JSONValue] = [:]
        for f in fields {
            let raw = values[f.key] ?? f.defaultValue
            switch f.kind {
            case .bool: o[f.key] = .bool(bools[f.key] ?? (f.defaultValue == "true"))
            case .number: if let n = Double(raw) { o[f.key] = .number(n) }
            case .json: if let d = raw.data(using: .utf8), let v = try? JSONDecoder().decode(JSONValue.self, from: d) { o[f.key] = v }
            default: if !raw.isEmpty { o[f.key] = .string(raw) }
            }
        }
        return .object(o)
    }

    private func go() async {
        busy = true; defer { busy = false }
        problem = nil
        do { try await submit(bodyValue); dismiss() } catch { problem = error.asProblem }
    }
}

/// Wraps buttons onto several lines.
struct FlexibleWrap: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 400
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > width && x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += sz.width + spacing; rowH = max(rowH, sz.height)
        }
        return CGSize(width: width, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > bounds.maxX && x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += sz.width + spacing; rowH = max(rowH, sz.height)
        }
    }
}
extension View { func flexibleWrap() -> some View { FlexibleWrap { self } } }
