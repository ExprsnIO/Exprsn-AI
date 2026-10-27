import SwiftUI
import SwiftData

/// The shell: a sidebar of screens on macOS and iPad, a tab bar with a More sidebar on iPhone.
struct MainShell: View {
    @Environment(AppSession.self) private var session
    @AppStorage("exprsn.lastScreen") private var lastScreenRaw: String = Screen.chat.rawValue
    @State private var selection: Screen? = .chat
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showingExport = false
    @State private var showingImport = false

    private var visible: [Screen] {
        Screen.sidebar.filter { screen in
            if !session.isExprsn { return [.platformChat, .servers, .mcpClient, .settings].contains(screen) }
            return session.has(any: screen.permissions)
        }
    }

    var body: some View {
        Group {
            #if os(iOS)
            if UIDevice.current.userInterfaceIdiom == .phone { phoneShell } else { splitShell }
            #else
            splitShell
            #endif
        }
        .onAppear {
            if let s = Screen(rawValue: lastScreenRaw), visible.contains(s) { selection = s } else { selection = visible.first }
        }
        #if os(macOS)
        .task {
            guard Snapshots.directory != nil else { return }
            debugLog("harness: shell appeared with \(visible.count) screens")
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await Snapshots.run(screens: visible) { NSApp.terminate(nil) }
        }
        #endif
        .onChange(of: selection) { _, new in if let new { lastScreenRaw = new.rawValue } }
        .onReceive(NotificationCenter.default.publisher(for: .navigate)) { n in if let s = n.object as? Screen, visible.contains(s) { selection = s } }
        .onReceive(NotificationCenter.default.publisher(for: .exportBundle)) { _ in showingExport = true }
        .onReceive(NotificationCenter.default.publisher(for: .importBundle)) { _ in showingImport = true }
        .sheet(isPresented: $showingExport) { ExportSheet() }
        .sheet(isPresented: $showingImport) { ImportSheet() }
        .sheet(isPresented: Binding(get: { session.stepUpNeeded }, set: { session.stepUpNeeded = $0 })) { StepUpSheet() }
    }

    private var splitShell: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView(selection: $selection, screens: visible)
                .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 300)
        } detail: {
            NavigationStack { ScreenView(screen: selection ?? .chat) }
        }
        .navigationSplitViewStyle(.balanced)
    }

    #if os(iOS)
    private var phoneShell: some View {
        TabView(selection: Binding(get: { selection ?? .chat }, set: { selection = $0 })) {
            ForEach(Screen.phoneTabs.filter { visible.contains($0) }) { s in
                Tab(s.title, systemImage: s.systemImage, value: s) { NavigationStack { ScreenView(screen: s) } }
            }
            Tab("More", systemImage: "ellipsis.circle", value: Screen.servers) {
                NavigationStack {
                    List {
                        ForEach(Screen.Section.allCases) { section in
                            let items = visible.filter { $0.section == section && !Screen.phoneTabs.contains($0) }
                            if !items.isEmpty {
                                Section(section.rawValue) {
                                    ForEach(items) { s in NavigationLink(value: s) { Label(s.title, systemImage: s.systemImage) } }
                                }
                            }
                        }
                    }
                    .navigationTitle("More")
                    .navigationDestination(for: Screen.self) { ScreenView(screen: $0) }
                }
            }
        }
    }
    #endif
}

struct SidebarView: View {
    @Environment(AppSession.self) private var session
    @Binding var selection: Screen?
    var screens: [Screen]
    @State private var filter = ""

    var body: some View {
        List(selection: $selection) {
            ForEach(Screen.Section.allCases) { section in
                let items = screens.filter { $0.section == section && (filter.isEmpty || $0.title.localizedCaseInsensitiveContains(filter)) }
                if !items.isEmpty {
                    Section(section.rawValue) {
                        ForEach(items) { s in
                            Label(s.title, systemImage: s.systemImage).tag(s)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $filter, placement: .sidebar, prompt: "Screens")
        .navigationTitle(session.server?.name ?? "Exprsn-AI")
        .safeAreaInset(edge: .bottom) { AccountFooter() }
    }
}

/// Who is signed in, the workspace switcher and sign-out, at the foot of the sidebar.
struct AccountFooter: View {
    @Environment(AppSession.self) private var session
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            if let me = session.me {
                HStack {
                    Image(systemName: "person.crop.circle.fill").font(.title2).foregroundStyle(Exprsn.accent)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(me.user.displayName ?? me.user.username).font(.subheadline.weight(.medium)).lineLimit(1)
                        Text(me.roles.map(\.name).joined(separator: ", ")).font(.caption2).foregroundStyle(Exprsn.muted).lineLimit(1)
                    }
                    Spacer()
                }
                if me.workspaces.count > 1 {
                    Picker("Workspace", selection: Binding(get: { me.workspace ?? "" }, set: { id in Task { await session.switchWorkspace(id) } })) {
                        ForEach(me.workspaces) { w in Text(w.name).tag(w.id) }
                    }.labelsHidden().controlSize(.small)
                } else if let w = session.currentWorkspace {
                    Text(w.name).font(.caption).foregroundStyle(Exprsn.muted)
                }
            } else if let s = session.server {
                Text(s.name).font(.subheadline.weight(.medium))
                Text(s.baseURL).font(.caption2).foregroundStyle(Exprsn.muted).lineLimit(1)
            }
            HStack {
                Button { NotificationCenter.default.post(name: .navigate, object: Screen.servers) } label: { Label("Servers", systemImage: "server.rack") }.labelStyle(.iconOnly).help("Servers and keys")
                Spacer()
                Button { Task { await session.signOut() } } label: { Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right") }.labelStyle(.iconOnly).help("Sign out")
            }.buttonStyle(.borderless).foregroundStyle(Exprsn.fg2)
        }
        .padding(10)
        .background(Exprsn.nav)
    }
}

/// Routes a screen id to its view.
struct ScreenView: View {
    @Environment(AppSession.self) private var session
    var screen: Screen

    var body: some View {
        Group {
            if !session.has(any: screen.permissions) && session.isExprsn {
                ForbiddenView(screen: screen)
            } else {
                content.id(screen)
            }
        }
        .navigationTitle(screen.title)
    }

    @ViewBuilder private var content: some View {
        switch screen {
        case .chat: ChatScreen()
        case .compare: CompareScreen()
        case .runs: RunsScreen()
        case .knowledge: KnowledgeScreen()
        case .memory: MemoryScreen()
        case .workflows: WorkflowsScreen()
        case .prompts: PromptsScreen()
        case .images: ImagesScreen()
        case .files: FilesScreen()
        case .messages: MessagesScreen()
        case .feed: FeedScreen()
        case .groups: GroupsScreen()
        case .calendar: CalendarScreen()
        case .search: SearchScreen()
        case .settings: SettingsScreen()
        case .servers: ServersScreen()
        case .mcpClient: MCPClientScreen()
        case .platformChat: PlatformChatScreen()
        case .overview: OverviewScreen()
        case .jobs: JobsScreen()
        case .users: UsersScreen()
        case .tenants: TenantsScreen()
        case .flags: FlagsScreen()
        case .moderation: ModerationScreen()
        case .mcpServers: MCPServersAdminScreen()
        case .models: ModelsScreen()
        case .profiles: ProfilesScreen()
        case .pools: PoolsScreen()
        case .registry: RegistryScreen()
        case .usageAudit: UsageAuditScreen()
        default: ResourceScreen(spec: AdminCatalog.spec(for: screen))
        }
    }
}

struct ForbiddenView: View {
    var screen: Screen
    var body: some View {
        ContentUnavailableView {
            Label("You do not have access to \(screen.title)", systemImage: "lock")
        } description: {
            Text("It needs the \(screen.permissions.joined(separator: " or ")) permission, which none of your roles grant. An identity admin can map your directory group to a role that does.")
        }
    }
}

/// Asked for by routes that answer `401 Step-up required`.
struct StepUpSheet: View {
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var code = ""
    @State private var useCode = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Confirm it is you. Creating API keys, removing a factor and regenerating recovery codes need a recent check.").font(.subheadline).foregroundStyle(Exprsn.fg2)
                }
                if useCode {
                    TextField("Code from your authenticator", text: $code).textContentType(.oneTimeCode)
                } else {
                    SecureField("Your password", text: $password).textContentType(.password)
                }
                Toggle("Use a one-time code instead", isOn: $useCode)
                if let p = session.lastProblem { Notice(.danger, p.title, p.detail) }
            }
            .formStyle(.grouped)
            .navigationTitle("Step-up")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { session.stepUpNeeded = false; dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Confirm") { Task { if await session.stepUp(password: useCode ? nil : password, code: useCode ? code : nil) { dismiss() } } }
                        .disabled(useCode ? code.isEmpty : password.isEmpty)
                }
            }
        }
        .frame(minWidth: 380, minHeight: 240)
    }
}

#if os(macOS)
struct MacPreferencesView: View {
    @AppStorage("exprsn.pollMs") private var pollMs = 350
    @AppStorage("exprsn.cacheConversations") private var cacheConversations = true
    var body: some View {
        Form {
            Stepper("Stream catch-up every \(pollMs) ms", value: $pollMs, in: 150...2000, step: 50)
            Toggle("Keep a copy of opened conversations on this Mac", isOn: $cacheConversations)
        }
        .padding(20)
        .frame(width: 420)
    }
}
#endif
