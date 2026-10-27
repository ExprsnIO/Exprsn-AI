import SwiftUI
import SwiftData

/// Picks the first screen: no server yet, a sign-in, or the shell.
struct RootView: View {
    @Environment(AppSession.self) private var session
    @Environment(\.modelContext) private var context
    @Query(sort: \ServerProfile.sortOrder) private var servers: [ServerProfile]
    @State private var booted = false

    var body: some View {
        Group {
            switch session.state {
            case .noServer:
                ServerPickerView()
            case .signedOut, .mfa, .enroll, .passwordChange:
                SignInView()
            case .signedIn:
                MainShell()
            }
        }
        .background(Exprsn.bg)
        .onAppear { debugLog("root onAppear state \(session.state)") }
        .task {
            guard !booted else { return }
            booted = true
            debugLog("root appeared; \(servers.count) servers")
            if let boot = Bootstrap.run(context: context) { await session.use(boot); return }
            if let def = servers.first(where: \.isDefault) ?? servers.first { await session.use(def) }
        }
    }
}

/// The very first screen: add a server, or choose one.
struct ServerPickerView: View {
    @Environment(AppSession.self) private var session
    @Query(sort: \ServerProfile.sortOrder) private var servers: [ServerProfile]
    @State private var adding = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Image(systemName: "sparkle").font(.system(size: 44)).foregroundStyle(Exprsn.accent)
                    Text("Exprsn-AI").font(.largeTitle.weight(.semibold))
                    Text("Chat, knowledge, agents and administration for your Exprsn-AI installs, and any OpenAI-compatible platform or MCP server.")
                        .font(.body).foregroundStyle(Exprsn.fg2).multilineTextAlignment(.center).frame(maxWidth: 420)
                }
                if servers.isEmpty {
                    Button { adding = true } label: { Label("Add a server", systemImage: "plus") }.buttonStyle(.borderedProminent).controlSize(.large)
                } else {
                    VStack(spacing: 8) {
                        ForEach(servers) { s in
                            Button { Task { await session.use(s) } } label: {
                                HStack {
                                    Image(systemName: s.kind == .exprsn ? "server.rack" : "sparkles")
                                    VStack(alignment: .leading) { Text(s.name).font(.headline); Text(s.baseURL).font(.caption).foregroundStyle(Exprsn.muted) }
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(Exprsn.muted)
                                }.padding(12).background(Exprsn.panel, in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Exprsn.line))
                            }.buttonStyle(.plain)
                        }
                        Button { adding = true } label: { Label("Add another server", systemImage: "plus") }.buttonStyle(.bordered)
                    }.frame(maxWidth: 440)
                }
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Exprsn.bg)
            .sheet(isPresented: $adding) { ServerEditor(profile: nil) }
        }
    }
}
