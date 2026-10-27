import SwiftUI
import SwiftData

@main
struct ExprsnAIApp: App {
    @State private var session = AppSession()
    private let container = AppSchema.container()
    init() { debugLog("app started") }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .tint(Exprsn.accent)
        }
        .modelContainer(container)
        #if os(macOS)
        .defaultSize(width: 1180, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New conversation") { NotificationCenter.default.post(name: .newConversation, object: nil) }.keyboardShortcut("n")
            }
            CommandMenu("Go") {
                ForEach([Screen.chat, .compare, .runs, .knowledge, .files, .messages, .search, .settings], id: \.self) { s in
                    Button(s.title) { NotificationCenter.default.post(name: .navigate, object: s) }
                }
            }
            CommandGroup(after: .importExport) {
                Button("Export app data…") { NotificationCenter.default.post(name: .exportBundle, object: nil) }
                Button("Import app data…") { NotificationCenter.default.post(name: .importBundle, object: nil) }
            }
        }
        #endif

        #if os(macOS)
        Settings {
            MacPreferencesView().environment(session)
        }
        .modelContainer(container)
        #endif
    }
}

extension Notification.Name {
    static let newConversation = Notification.Name("exprsn.newConversation")
    static let navigate = Notification.Name("exprsn.navigate")
    static let exportBundle = Notification.Name("exprsn.exportBundle")
    static let importBundle = Notification.Name("exprsn.importBundle")
    /// The smoke run asks Chat to send a prompt (object: the text).
    static let harnessSendChat = Notification.Name("exprsn.harnessSendChat")
}
