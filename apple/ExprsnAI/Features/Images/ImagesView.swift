import SwiftUI

/// Images: generate with a backend, watch the queue, open, vary, attach to chat, verify provenance.
struct ImagesScreen: View {
    @Environment(AppSession.self) private var session
    @State private var images: Loadable<[JSONValue]> = .idle
    @State private var backends: JSONValue = .null
    @State private var quota: JSONValue = .null
    @State private var prompt = ""
    @State private var backend = ""
    @State private var size = ""
    @State private var count = 1
    @State private var problem: APIProblem?
    @State private var selected: JSONValue?
    @State private var pictures: [String: Data] = [:]

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .bottom) {
                    TextField("Describe the picture", text: $prompt, axis: .vertical).lineLimit(1...4).textFieldStyle(.roundedBorder)
                    Button("Generate") { Task { await generate() } }.buttonStyle(.borderedProminent).disabled(prompt.isEmpty || backend.isEmpty)
                }
                HStack {
                    Picker("Backend", selection: $backend) { ForEach(backends["backends"].array, id: \.self) { b in Text("\(b["label"].text) (\(b["model"].text))").tag(b["id"].text) } }.fixedSize()
                    Picker("Size", selection: $size) { ForEach(sizes, id: \.self) { Text($0).tag($0) } }.fixedSize()
                    Stepper("\(count) picture\(count == 1 ? "" : "s")", value: $count, in: 1...8)
                    Spacer()
                    if !quota.isNull { Text("GPU seconds this month: \(quota["used"].text) of \(quota["limit"].isNull ? "unlimited" : quota["limit"].text)").font(.caption).foregroundStyle(Exprsn.muted) }
                }
                if let problem { Notice(.danger, problem.title, problem.detail) }
            }.padding(12).background(Exprsn.nav)
            Divider()
            LoadableView(state: images, retry: load) { list in
                if list.isEmpty { EmptyState(title: "No pictures yet", text: "Prompts pass the image guardrail; unsafe outputs are withheld.", systemImage: "photo") }
                else {
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 10)], spacing: 10) {
                            ForEach(list, id: \.self) { img in
                                VStack(alignment: .leading, spacing: 4) {
                                    ZStack {
                                        RoundedRectangle(cornerRadius: 8).fill(Exprsn.panel2).aspectRatio(1, contentMode: .fit)
                                        if let d = pictures[img["id"].text], let ui = PlatformImage.from(d) { ui.resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 8)) }
                                        else if img["state"].string == "succeeded" { ProgressView().task { await fetch(img) } }
                                        else { VStack { Pill(img["state"].text); if let st = img["stage"].string { Text(st).font(.caption2).foregroundStyle(Exprsn.muted) } } }
                                    }
                                    Text(img["prompt"].text).font(.caption).lineLimit(2).foregroundStyle(Exprsn.fg2)
                                }
                                .onTapGesture { selected = img }
                                .contextMenu {
                                    Button("Variation") { Task { _ = try? await session.client?.post("images/\(img["id"].text)/vary"); await load() } }
                                    Button("Attach to chat") { Task { _ = try? await session.client?.post("images/\(img["id"].text)/attach") } }
                                    if ["queued", "running"].contains(img["state"].string ?? "") { Button("Cancel", role: .destructive) { Task { _ = try? await session.client?.post("images/\(img["id"].text)/cancel"); await load() } } }
                                }
                            }
                        }.padding(12)
                    }
                }
            }
        }
        .sheet(item: Binding(get: { selected.map(IdentifiedJSON.init) }, set: { selected = $0?.value })) { s in ImageDetailSheet(image: s.value, data: pictures[s.value["id"].text]) }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") } } }
        .task {
            backends = (try? await session.client?.get("images/backends")) ?? .null
            backend = backends["backends"].array.first?["id"].text ?? ""
            size = sizes.first ?? ""
            quota = (try? await session.client?.get("images/quota")) ?? .null
            await load()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if images.value?.contains(where: { ["queued", "running"].contains($0["state"].string ?? "") }) == true { await load() }
            }
        }
    }

    private var sizes: [String] {
        let b = backends["backends"].array.first { $0["id"].text == backend } ?? backends["backends"].array.first ?? .null
        let s = b["sizes"].array.map { "\($0["width"].text)×\($0["height"].text)" }
        return s.isEmpty ? ["1024×1024"] : s
    }
    private func load() async { images = await loaded { (try await session.client!.get("images")).rows(itemsKey: "items") } }
    private func fetch(_ img: JSONValue) async {
        if let (d, _, _) = try? await session.client?.download("images/\(img["id"].text)/image") { pictures[img["id"].text] = d }
    }
    private func generate() async {
        problem = nil
        let parts = size.split(separator: "×").compactMap { Double($0) }
        do {
            _ = try await session.client!.post("images", json(["prompt": .string(prompt), "backend": .string(backend), "width": .number(parts.first ?? 1024), "height": .number(parts.last ?? 1024), "count": .number(Double(count))]))
            await load()
        } catch { problem = error.asProblem }
    }
}

struct ImageDetailSheet: View {
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    var image: JSONValue
    var data: Data?
    @State private var provenance: JSONValue = .null
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let data, let img = PlatformImage.from(data) { img.resizable().scaledToFit().frame(maxHeight: 520).clipShape(RoundedRectangle(cornerRadius: 8)) }
                    Text(image["prompt"].text).textSelection(.enabled)
                    HStack { Pill(image["state"].text); LabelBadge(image["label"].string, small: true); Text("seed \(image["seed"].text) · \(image["gpuSeconds"].text) GPU s · \(image["backend"].text)").font(.caption).foregroundStyle(Exprsn.muted) }
                    if !provenance.isNull {
                        Notice(provenance["verified"].bool == true ? .ok : .warn, provenance["verified"].bool == true ? "Provenance verified" : "Provenance not verified", "signature \(provenance["signature"].text.prefix(16))… · bytes match: \(provenance["bytesMatch"].text)")
                    }
                    Button("Verify provenance") { Task { provenance = (try? await session.client?.get("images/\(image["id"].text)/provenance")) ?? .null } }
                }.padding(16)
            }
            .navigationTitle("Picture")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.frame(minWidth: 560, minHeight: 500)
    }
}

enum PlatformImage {
    static func from(_ data: Data) -> Image? {
        #if os(macOS)
        return NSImage(data: data).map { Image(nsImage: $0) }
        #else
        return UIImage(data: data).map { Image(uiImage: $0) }
        #endif
    }
}
