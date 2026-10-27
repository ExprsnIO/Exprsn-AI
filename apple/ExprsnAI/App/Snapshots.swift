import SwiftUI

#if os(macOS)
/// A smoke run for the UI, like the console's `npm run smoke`: with `EXPRSN_SNAPSHOT_DIR` set, the app walks every
/// screen it may show, waits for data, and writes a PNG of the window per screen (and for light and dark
/// appearance). It renders in-process through AppKit, so it needs no screen-recording permission.
@MainActor
enum Snapshots {
    /// The directory asked for, or, when the sandbox refuses it, `snapshots` under the app's own Documents.
    static var directory: String? { snapshotDirectory() }

    static func run(screens: [Screen], finish: @escaping () -> Void) async {
        guard let dir = directory else { return }
        debugLog("harness: \(NSApp.windows.count) windows, visible \(NSApp.windows.filter(\.isVisible).count)")
        guard let window = NSApp.windows.first(where: { $0.isVisible }) ?? NSApp.windows.first else { debugLog("harness: no window"); return }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        window.setContentSize(NSSize(width: 1280, height: 800))
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        describeTables(window.contentView, depth: 0)
        var report: [String] = []
        let only = ProcessInfo.processInfo.environment["EXPRSN_SNAPSHOT_SCREENS"]?.split(separator: ",").map(String.init)
        let screens = only.map { names in screens.filter { names.contains($0.rawValue) } } ?? screens
        let appearances = ProcessInfo.processInfo.environment["EXPRSN_SNAPSHOT_APPEARANCES"]?.split(separator: ",").map(String.init) ?? ["light", "dark"]
        for appearance in appearances {
            NSApp.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua)
            for s in screens {
                NotificationCenter.default.post(name: .navigate, object: s)
                let waitMs = UInt64(ProcessInfo.processInfo.environment["EXPRSN_SNAPSHOT_WAIT_MS"].flatMap(Int.init) ?? 2500)
                try? await Task.sleep(nanoseconds: waitMs * 1_000_000)
                let ok = snapshot(window, to: "\(dir)/\(appearance)-\(s.rawValue).png") ?? false
                report.append("\(appearance)/\(s.rawValue): \(ok ? "ok" : "failed")")
                debugLog("harness: \(appearance)/\(s.rawValue) \(ok ? "ok" : "failed")")
            }
        }
        if let prompt = ProcessInfo.processInfo.environment["EXPRSN_SNAPSHOT_CHAT_PROMPT"], screens.contains(.chat) {
            NSApp.appearance = NSAppearance(named: .aqua)
            NotificationCenter.default.post(name: .navigate, object: Screen.chat)
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            NotificationCenter.default.post(name: .harnessSendChat, object: prompt)
            for step in [6, 20, 45] {
                try? await Task.sleep(nanoseconds: UInt64(step) * 1_000_000_000)
                let ok = snapshot(window, to: "\(dir)/chat-answer-\(step)s.png") ?? false
                report.append("chat-answer-\(step)s: \(ok ? "ok" : "failed")"); debugLog("harness: chat answer after \(step)s \(ok ? "ok" : "failed")")
            }
        }
        try? report.joined(separator: "\n").write(toFile: "\(dir)/report.txt", atomically: true, encoding: .utf8)
        finish()
    }

    /// Logs every table or outline view with its row count, to tell an empty list from one the capture missed.
    static func describeTables(_ view: NSView?, depth: Int) {
        guard let view, depth < 40 else { return }
        if let t = view as? NSTableView { debugLog("harness: \(type(of: t)) rows=\(t.numberOfRows) frame=\(Int(t.frame.width))x\(Int(t.frame.height)) hidden=\(t.isHiddenOrHasHiddenAncestor)") }
        for sub in view.subviews { describeTables(sub, depth: depth + 1) }
    }

    /// Renders the window's layer tree (Core Animation), which never waits on AppKit's display cycle.
    static func snapshot(_ window: NSWindow, to path: String) -> Bool? {
        guard let view = window.contentView, let layer = view.layer else { return false }
        let scale = window.backingScaleFactor
        let w = Int(view.bounds.width * scale), h = Int(view.bounds.height * scale)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) else { return false }
        ctx.scaleBy(x: scale, y: scale)
        if view.isFlipped { ctx.translateBy(x: 0, y: view.bounds.height); ctx.scaleBy(x: 1, y: -1) }
        layer.render(in: ctx)
        guard let image = ctx.makeImage() else { return false }
        let rep = NSBitmapImageRep(cgImage: image)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        do { try png.write(to: URL(fileURLWithPath: path)); return true } catch { return false }
    }
}
#endif
