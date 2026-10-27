import SwiftUI

/// The console's colour tokens (`web/css/app.css`) as dynamic colours: light, dark, and the AA mode's stronger lines
/// and text. Everything on screen uses these, never literal colours, so dark mode and enhanced contrast hold.
enum Exprsn {
    // Surfaces
    static let bg = dyn(light: 0xF3F3F2, dark: 0x121212)
    static let nav = dyn(light: 0xFAFAF9, dark: 0x161615)
    static let panel = dyn(light: 0xFFFFFF, dark: 0x1B1B1A)
    static let panel2 = dyn(light: 0xFAFAF9, dark: 0x1F1F1E)
    static let line = dyn(light: 0xDCDCDA, dark: 0x31312F, aaLight: 0x8A8A84, aaDark: 0x75756F)
    static let line2 = dyn(light: 0xEBEBE9, dark: 0x262625, aaLight: 0xC4C4BF, aaDark: 0x4A4A46)
    static let selection = dyn(light: 0xEBEBE9, dark: 0x262625)
    static let bubble = dyn(light: 0xEBEBE9, dark: 0x31312F)
    // Text
    static let fg = dyn(light: 0x1A1A19, dark: 0xEFEFEC, aaLight: 0x111110, aaDark: 0xF7F7F4)
    static let fg2 = dyn(light: 0x4E4E49, dark: 0xBDBDB7, aaLight: 0x3E3E3A, aaDark: 0xD4D4CE)
    static let muted = dyn(light: 0x66665F, dark: 0x9C9C95, aaLight: 0x4A4A45, aaDark: 0xBDBDB7)
    static let faint = dyn(light: 0xC9C9C5, dark: 0x4A4A47, aaLight: 0x6E6E68, aaDark: 0x8F8F89)
    // Accent (the Exprsn rust)
    static let accent = dyn(light: 0xB4380A, dark: 0xFF8150, aaLight: 0x8A2A07, aaDark: 0xFFA27E)
    static let accentFg = dyn(light: 0xFFFFFF, dark: 0x1A0D06)
    static let accentTint = dyn(light: 0xFBEBE3, dark: 0x3A1E12)
    // Tones
    static let warnBg = dyn(light: 0xFBF1D9, dark: 0x332708)
    static let warnFg = dyn(light: 0x7A5200, dark: 0xE5B95A, aaLight: 0x5F4000, aaDark: 0xEDC66E)
    static let dangerBg = dyn(light: 0xFBE7E5, dark: 0x3A1616)
    static let dangerFg = dyn(light: 0xA01E18, dark: 0xF28B82, aaLight: 0x8E1A14, aaDark: 0xF7A59E)
    static let infoBg = dyn(light: 0xE6EEF8, dark: 0x172A44)
    static let infoFg = dyn(light: 0x1B4C8C, dark: 0x8FB6EE, aaLight: 0x17427A, aaDark: 0x9EC1F2)
    static let okBg = dyn(light: 0xE6F2EA, dark: 0x12301C)
    static let okFg = dyn(light: 0x1C6A38, dark: 0x7FCB98, aaLight: 0x155229, aaDark: 0x8ED6A5)
    static let meter = dyn(light: 0x80807A, dark: 0x8A8A84)

    /// Set from the account's `preferences.a11y` (`system`, `aa`, `aaa`); AA and AAA use the stronger tokens.
    nonisolated(unsafe) static var enhancedContrast = false

    private static func dyn(light: UInt32, dark: UInt32, aaLight: UInt32? = nil, aaDark: UInt32? = nil) -> Color {
        #if os(macOS)
        return Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let hex = isDark ? (enhancedContrast ? (aaDark ?? dark) : dark) : (enhancedContrast ? (aaLight ?? light) : light)
            return NSColor(hex: hex)
        })
        #else
        return Color(uiColor: UIColor { trait in
            let isDark = trait.userInterfaceStyle == .dark
            let hex = isDark ? (enhancedContrast ? (aaDark ?? dark) : dark) : (enhancedContrast ? (aaLight ?? light) : light)
            return UIColor(hex: hex)
        })
        #endif
    }
}

#if os(macOS)
extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
#else
extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
#endif

/// The data labels, ordered: `public < internal < confidential < restricted`.
enum DataLabel: String, CaseIterable, Identifiable, Comparable, Codable {
    case `public`, `internal`, confidential, restricted
    var id: String { rawValue }
    var rank: Int { Self.allCases.firstIndex(of: self)! }
    static func < (a: DataLabel, b: DataLabel) -> Bool { a.rank < b.rank }
    var title: String { rawValue.capitalized }
}

/// Status pill tones, inferred from common words as the console does.
enum Tone: String {
    case neutral, info, ok, warn, danger, accent

    var fg: Color {
        switch self {
        case .neutral: return Exprsn.fg2
        case .info: return Exprsn.infoFg
        case .ok: return Exprsn.okFg
        case .warn: return Exprsn.warnFg
        case .danger: return Exprsn.dangerFg
        case .accent: return Exprsn.accent
        }
    }
    var bg: Color {
        switch self {
        case .neutral: return Exprsn.selection
        case .info: return Exprsn.infoBg
        case .ok: return Exprsn.okBg
        case .warn: return Exprsn.warnBg
        case .danger: return Exprsn.dangerBg
        case .accent: return Exprsn.accentTint
        }
    }

    static func infer(_ word: String) -> Tone {
        let w = word.lowercased()
        if ["approved", "published", "ready", "healthy", "active", "ok", "succeeded", "passed", "complete", "verified", "enabled", "confirmed", "accepted", "upheld", "loaded", "online", "applied"].contains(where: { w.contains($0) }) { return .ok }
        if ["failed", "error", "rejected", "unreachable", "revoked", "blocked", "banned", "retired", "destroyed", "incompatible", "denied", "gone", "not answering", "overdue", "broken", "dead"].contains(where: { w.contains($0) }) { return .danger }
        if ["deprecated", "warn", "degraded", "changed", "pending", "quarantined", "waiting", "held", "draining", "suspended", "budget", "stopped", "expired", "paused", "cold", "shadow", "stale"].contains(where: { w.contains($0) }) { return .warn }
        if ["review", "running", "streaming", "queued", "building", "pulling", "evaluated", "scanning", "draft", "loading", "reviewing", "proposed", "registering", "syncing", "preview", "open"].contains(where: { w.contains($0) }) { return .info }
        return .neutral
    }
}

extension Font {
    static let exprsnTitle = Font.system(.title2, design: .default, weight: .semibold)
    static let exprsnMono = Font.system(.body, design: .monospaced)
    static let exprsnMonoSmall = Font.system(.caption, design: .monospaced)
    static let eyebrow = Font.system(.caption, weight: .semibold)
}
