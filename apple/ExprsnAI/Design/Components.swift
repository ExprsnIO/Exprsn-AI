import SwiftUI

// MARK: Pills, labels and badges

struct Pill: View {
    var text: String
    var tone: Tone?
    init(_ text: String, tone: Tone? = nil) { self.text = text; self.tone = tone }
    var body: some View {
        let t = tone ?? Tone.infer(text)
        Text(text)
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(t.bg, in: Capsule())
            .foregroundStyle(t.fg)
            .accessibilityLabel("Status: \(text)")
    }
}

/// The classification badge with bars, coloured only on restricted, as the console draws it.
struct LabelBadge: View {
    var label: String
    var small = false
    init(_ label: String?, small: Bool = false) { self.label = label ?? "internal"; self.small = small }
    var body: some View {
        let lvl = DataLabel(rawValue: label) ?? .internal
        HStack(spacing: 4) {
            HStack(spacing: 1.5) {
                ForEach(0..<4, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1)
                        .fill(i <= lvl.rank ? (lvl == .restricted ? Exprsn.dangerFg : Exprsn.fg2) : Exprsn.faint)
                        .frame(width: small ? 3 : 4, height: small ? 8 : 10)
                }
            }
            Text(lvl.title).font(small ? .caption2 : .caption).foregroundStyle(lvl == .restricted ? Exprsn.dangerFg : Exprsn.fg2)
        }
        .accessibilityLabel("Label \(lvl.title)")
    }
}

/// A short status notice in one of the tones.
struct Notice: View {
    var tone: Tone
    var title: String
    var text: String?
    var action: (() -> Void)?
    var actionLabel: String?

    init(_ tone: Tone, _ title: String, _ text: String? = nil, actionLabel: String? = nil, action: (() -> Void)? = nil) {
        self.tone = tone; self.title = title; self.text = text; self.actionLabel = actionLabel; self.action = action
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(tone.fg).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Exprsn.fg)
                if let text { Text(text).font(.subheadline).foregroundStyle(Exprsn.fg2).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 0)
            if let action, let actionLabel { Button(actionLabel, action: action).buttonStyle(.bordered).controlSize(.small) }
        }
        .padding(12)
        .background(tone.bg, in: RoundedRectangle(cornerRadius: 8))
    }
    private var icon: String {
        switch tone {
        case .danger: return "exclamationmark.octagon"
        case .warn: return "exclamationmark.triangle"
        case .ok: return "checkmark.circle"
        case .info: return "info.circle"
        default: return "circle"
        }
    }
}

/// The console's problem panel: title, text and the trace id.
struct ProblemView: View {
    var problem: APIProblem
    var retry: (() async -> Void)?
    var body: some View {
        ContentUnavailableView {
            Label(problem.title, systemImage: problem.status == 403 ? "lock" : problem.status == 0 ? "wifi.exclamationmark" : "exclamationmark.triangle")
        } description: {
            VStack(spacing: 6) {
                if let d = problem.detail { Text(d) }
                if let t = problem.traceId { Text("Trace \(t)").font(.exprsnMonoSmall).foregroundStyle(Exprsn.muted).textSelection(.enabled) }
            }
        } actions: {
            if let retry { Button("Try again") { Task { await retry() } }.buttonStyle(.borderedProminent) }
        }
    }
}

struct EmptyState: View {
    var title: String
    var text: String?
    var systemImage: String = "tray"
    var body: some View {
        ContentUnavailableView { Label(title, systemImage: systemImage) } description: { if let text { Text(text) } }
    }
}

/// Shows a loadable's state around its content.
struct LoadableView<T, Content: View>: View {
    var state: Loadable<T>
    var retry: (() async -> Void)?
    @ViewBuilder var content: (T) -> Content

    var body: some View {
        switch state {
        case .idle, .loading:
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let p):
            ProblemView(problem: p, retry: retry)
        case .loaded(let v):
            content(v)
        }
    }
}

// MARK: Key-value and stats

struct KeyValueRow: View {
    var key: String
    var value: String
    var mono = false
    var body: some View {
        LabeledContent(key) {
            Text(value.isEmpty ? "—" : value)
                .font(mono ? .exprsnMonoSmall : .body)
                .foregroundStyle(value.isEmpty ? Exprsn.muted : Exprsn.fg)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }
}

struct StatTile: View {
    var value: String
    var label: String
    var detail: String?
    var tone: Tone = .neutral
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value).font(.system(.title, design: .rounded, weight: .semibold)).foregroundStyle(tone == .neutral ? Exprsn.fg : tone.fg).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(Exprsn.muted)
            if let detail { Text(detail).font(.caption2).foregroundStyle(Exprsn.muted).lineLimit(2) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Exprsn.panel, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Exprsn.line))
        .accessibilityElement(children: .combine)
    }
}

struct Meter: View {
    var label: String
    var valueText: String
    var fraction: Double
    var tone: Tone = .neutral
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { Text(label).font(.caption).foregroundStyle(Exprsn.fg2); Spacer(); Text(valueText).font(.caption.monospacedDigit()).foregroundStyle(Exprsn.muted) }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Exprsn.line2)
                    Capsule().fill(tone == .neutral ? Exprsn.meter : tone.fg).frame(width: max(0, min(1, fraction)) * g.size.width)
                }
            }.frame(height: 6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(valueText)
    }
}

/// A small section heading in the console's eyebrow style.
struct Eyebrow: View {
    var text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text.uppercased()).font(.eyebrow).foregroundStyle(Exprsn.muted).kerning(0.6) }
}

// MARK: Formatting helpers

enum Fmt {
    static let relative: RelativeDateTimeFormatter = { let f = RelativeDateTimeFormatter(); f.unitsStyle = .short; return f }()
    static func when(_ d: Date?) -> String {
        guard let d else { return "" }
        if abs(d.timeIntervalSinceNow) < 86400 * 2 { return relative.localizedString(for: d, relativeTo: Date()) }
        return d.formatted(date: .abbreviated, time: .shortened)
    }
    static func when(_ v: JSONValue) -> String { when(v.date) }
    static func bytes(_ n: Double?) -> String {
        guard let n else { return "" }
        return ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }
    static func count(_ n: Double?) -> String {
        guard let n else { return "0" }
        return n.formatted(.number.notation(.compactName))
    }
    static func ms(_ n: Double?) -> String {
        guard let n else { return "" }
        return n >= 1000 ? String(format: "%.1f s", n / 1000) : "\(Int(n)) ms"
    }
}

extension View {
    /// The console's panel: white (or dark) card with a hairline.
    func panel(padding: CGFloat = 12) -> some View {
        self.padding(padding)
            .background(Exprsn.panel, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Exprsn.line))
    }

    /// Hides a view unless the caller holds one of the permissions.
    func requires(_ session: AppSession, _ permissions: String...) -> some View {
        self.opacity(session.has(any: permissions) ? 1 : 0).disabled(!session.has(any: permissions))
    }
}

/// A `Codable` wrapper for a confirm dialog with a reason.
struct ReasonPrompt: Identifiable { var id = UUID(); var title: String; var action: (String) async -> Void }
