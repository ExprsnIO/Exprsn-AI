import SwiftUI
import SwiftData

/// Sign-in for the current server: password (then the second factor), or an API key.
struct SignInView: View {
    @Environment(AppSession.self) private var session
    @State private var username = ""
    @State private var password = ""
    @State private var tenant = ""
    @State private var apiKey = ""
    @State private var code = ""
    @State private var rememberDevice = false
    @State private var method = "totp"
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var showingServers = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    header
                    VStack(spacing: 14) {
                        switch session.state {
                        case .mfa(let methods, let days): mfaForm(methods: methods, trustedDays: days)
                        case .enroll: enrollNotice
                        case .passwordChange: passwordForm
                        default: credentialsForm
                        }
                        if let p = session.lastProblem {
                            Notice(.danger, p.title, p.detail.map { d in (p.extensions["attempts_remaining"]?.int).map { "\(d) \($0) attempts remaining." } ?? d })
                        }
                    }
                    .panel(padding: 20)
                    .frame(maxWidth: 440)
                    Button { showingServers = true } label: { Label("Choose another server", systemImage: "server.rack") }.buttonStyle(.borderless).foregroundStyle(Exprsn.fg2)
                }
                .padding(32)
                .frame(maxWidth: .infinity)
            }
            .background(Exprsn.bg)
            .sheet(isPresented: $showingServers) { NavigationStack { ServersScreen() }.frame(minWidth: 520, minHeight: 420) }
            .onAppear { username = session.server?.username ?? ""; tenant = session.server?.tenant ?? "" }
        }
    }

    private var header: some View {
        VStack(spacing: 6) {
            Image(systemName: "sparkle").font(.system(size: 36)).foregroundStyle(Exprsn.accent)
            Text(session.server?.name ?? "Sign in").font(.title.weight(.semibold))
            Text(session.server?.baseURL ?? "").font(.caption).foregroundStyle(Exprsn.muted)
        }
    }

    @ViewBuilder private var credentialsForm: some View {
        if session.server?.kind == .openAICompatible || session.server?.authMode == .apiKey {
            Text(session.server?.kind == .openAICompatible ? "This platform takes an API key." : "This server is set to use an API key (`exai_k1_…`), created in Settings of the console or this app from a signed-in session.")
                .font(.subheadline).foregroundStyle(Exprsn.fg2)
            SecureField("API key", text: $apiKey).textFieldStyle(.roundedBorder)
            Button("Use this key") { Task { await session.useAPIKey(apiKey.trimmingCharacters(in: .whitespaces)) } }
                .buttonStyle(.borderedProminent).disabled(apiKey.isEmpty || session.busy)
        } else {
            TextField("Username or email", text: $username).textContentType(.username).textFieldStyle(.roundedBorder)
                #if os(iOS)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                #endif
            SecureField("Password", text: $password).textContentType(.password).textFieldStyle(.roundedBorder).onSubmit(submit)
            TextField("Tenant (optional)", text: $tenant).textFieldStyle(.roundedBorder)
                #if os(iOS)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                #endif
            Button(action: submit) { if session.busy { ProgressView().controlSize(.small) } else { Text("Sign in").frame(maxWidth: .infinity) } }
                .buttonStyle(.borderedProminent).controlSize(.large).disabled(username.isEmpty || password.isEmpty || session.busy)
        }
    }

    private func submit() { Task { await session.signIn(username: username, password: password, tenant: tenant) } }

    @ViewBuilder private func mfaForm(methods: [String], trustedDays: Int) -> some View {
        Text("Second factor").font(.headline)
        if methods.count > 1 {
            Picker("Method", selection: $method) {
                ForEach(methods.filter { $0 != "webauthn" }, id: \.self) { Text(label(for: $0)).tag($0) }
                Text("Recovery code").tag("recovery")
            }.pickerStyle(.segmented)
        }
        if method == "email" { Button("Send a code by email") { Task { await session.sendEmailCode() } }.buttonStyle(.bordered) }
        TextField(method == "recovery" ? "Recovery code" : "Code", text: $code).textContentType(.oneTimeCode).textFieldStyle(.roundedBorder).onSubmit(verify)
        if trustedDays > 0 { Toggle("Trust this device for \(trustedDays) days", isOn: $rememberDevice) }
        Button(action: verify) { Text("Verify").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).controlSize(.large).disabled(code.isEmpty || session.busy)
        Button("Start over") { Task { await session.signOut() } }.buttonStyle(.borderless)
        .onAppear { method = methods.first(where: { $0 != "webauthn" }) ?? "totp" }
    }

    private func verify() { Task { await session.completeMFA(method: method, code: code.trimmingCharacters(in: .whitespaces), rememberDevice: rememberDevice) } }
    private func label(for m: String) -> String { m == "totp" ? "Authenticator" : m == "email" ? "Email" : m.capitalized }

    private var enrollNotice: some View {
        VStack(alignment: .leading, spacing: 10) {
            Notice(.warn, "A second factor is required", "Your roles require one and none is set up. Enrol an authenticator in the web console, then sign in again here.")
            Button("Start over") { Task { await session.signOut() } }
        }
    }

    @ViewBuilder private var passwordForm: some View {
        Text("Choose your own password").font(.headline)
        Text("An admin set or reset this password. Pick a new one before anything else.").font(.subheadline).foregroundStyle(Exprsn.fg2)
        SecureField("Current password", text: $currentPassword).textFieldStyle(.roundedBorder)
        SecureField("New password", text: $newPassword).textContentType(.newPassword).textFieldStyle(.roundedBorder)
        Button("Change password") { Task { await session.changePassword(current: currentPassword, new: newPassword) } }
            .buttonStyle(.borderedProminent).disabled(currentPassword.isEmpty || newPassword.count < 8 || session.busy)
    }
}

/// Add or edit a server profile.
struct ServerEditor: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSession.self) private var session
    var profile: ServerProfile?

    @State private var name = ""
    @State private var baseURL = "https://"
    @State private var kind: ServerProfile.Kind = .exprsn
    @State private var authMode: ServerProfile.AuthMode = .session
    @State private var tenant = ""
    @State private var username = ""
    @State private var secret = ""
    @State private var defaultModel = ""
    @State private var dataLabel = "internal"
    @State private var makeDefault = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Name", text: $name)
                    TextField("Address", text: $baseURL, prompt: Text("https://ai.exprsn.local"))
                        #if os(iOS)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        #endif
                    Picker("Kind", selection: $kind) { ForEach(ServerProfile.Kind.allCases) { Text($0.title).tag($0) } }
                }
                if kind == .exprsn {
                    Section("Sign-in") {
                        Picker("Method", selection: $authMode) { ForEach(ServerProfile.AuthMode.allCases) { Text($0.title).tag($0) } }
                        TextField("Tenant slug (optional)", text: $tenant)
                        if authMode == .session { TextField("Username", text: $username) }
                        if authMode == .apiKey { SecureField("API key (exai_k1_…)", text: $secret) }
                    }
                } else {
                    Section("Platform") {
                        SecureField("API key", text: $secret)
                        TextField("Default model", text: $defaultModel, prompt: Text("gpt-4o, llama3…"))
                        Text("Any service with `/v1/models` and `/v1/chat/completions`: Exprsn-AI's own `/v1`, Ollama, OpenAI, vLLM and the like. The address is the origin, without `/v1`.").font(.caption).foregroundStyle(Exprsn.muted)
                    }
                }
                if kind == .exprsn {
                    Section("Requests") {
                        Picker("Data label for /v1 calls", selection: $dataLabel) { ForEach(DataLabel.allCases) { Text($0.title).tag($0.rawValue) } }
                    }
                }
                Section { Toggle("Open this server at launch", isOn: $makeDefault) }
            }
            .formStyle(.grouped)
            .navigationTitle(profile == nil ? "Add server" : "Edit server")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).disabled(name.isEmpty || URL(string: baseURL)?.host == nil) }
            }
            .onAppear(perform: fill)
        }
        .frame(minWidth: 460, minHeight: 420)
    }

    private func fill() {
        guard let p = profile else { return }
        name = p.name; baseURL = p.baseURL; kind = p.kind; authMode = p.authMode; tenant = p.tenant ?? ""; username = p.username ?? ""
        defaultModel = p.defaultModel ?? ""; dataLabel = p.dataLabel ?? "internal"; makeDefault = p.isDefault
    }

    private func save() {
        let p = profile ?? ServerProfile(name: name, baseURL: baseURL)
        p.name = name; p.baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines); p.kind = kind; p.authMode = kind == .exprsn ? authMode : .apiKey
        p.tenant = tenant.isEmpty ? nil : tenant; p.username = username.isEmpty ? nil : username
        p.defaultModel = defaultModel.isEmpty ? nil : defaultModel; p.dataLabel = dataLabel
        if makeDefault {
            let all = (try? context.fetch(FetchDescriptor<ServerProfile>())) ?? []
            all.forEach { $0.isDefault = false }
        }
        p.isDefault = makeDefault
        if profile == nil { context.insert(p) }
        if !secret.isEmpty { Keychain.set(secret.trimmingCharacters(in: .whitespacesAndNewlines), for: p.secretKey) }
        try? context.save()
        dismiss()
        if profile == nil || session.server?.id == p.id { Task { await session.use(p) } }
    }
}

/// Servers and keys: the list of saved servers, their secrets and the app's export and import.
struct ServersScreen: View {
    @Environment(AppSession.self) private var session
    @Environment(\.modelContext) private var context
    @Query(sort: \ServerProfile.sortOrder) private var servers: [ServerProfile]
    @State private var editing: ServerProfile?
    @State private var adding = false
    @State private var exporting = false
    @State private var importing = false
    @State private var confirmDelete: ServerProfile?

    var body: some View {
        List {
            Section {
                ForEach(servers) { s in
                    HStack(spacing: 12) {
                        Image(systemName: s.kind == .exprsn ? "server.rack" : "sparkles").foregroundStyle(session.server?.id == s.id ? Exprsn.accent : Exprsn.fg2).frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack { Text(s.name).font(.headline); if s.isDefault { Pill("Default", tone: .accent) }; if session.server?.id == s.id { Pill("Current", tone: .ok) } }
                            Text(s.baseURL).font(.caption).foregroundStyle(Exprsn.muted)
                            HStack(spacing: 8) {
                                Text(s.kind.title).font(.caption2).foregroundStyle(Exprsn.muted)
                                if s.kind == .exprsn { Text(s.authMode.title).font(.caption2).foregroundStyle(Exprsn.muted) }
                                if s.hasStoredSecret { Label("Key stored", systemImage: "key.fill").font(.caption2).foregroundStyle(Exprsn.okFg) }
                                if s.hasStoredSession { Label("Session stored", systemImage: "person.badge.key").font(.caption2).foregroundStyle(Exprsn.okFg) }
                                if let d = s.lastSignInAt { Text("Signed in \(Fmt.when(d))").font(.caption2).foregroundStyle(Exprsn.muted) }
                            }
                        }
                        Spacer()
                        Button("Open") { Task { await session.use(s) } }.buttonStyle(.bordered).controlSize(.small)
                    }
                    .contextMenu {
                        Button("Edit…") { editing = s }
                        Button("Make default") { servers.forEach { $0.isDefault = false }; s.isDefault = true; try? context.save() }
                        Button("Forget stored key and session") { Keychain.remove(s.secretKey); Keychain.remove(s.cookieKey); Keychain.remove(s.csrfKey) }
                        Divider()
                        Button("Remove…", role: .destructive) { confirmDelete = s }
                    }
                    .swipeActions { Button("Remove", role: .destructive) { confirmDelete = s } }
                }
            } header: { Text("Servers") } footer: {
                Text("Secrets are kept in the Keychain of this device, never in the app's database.").font(.caption)
            }
            Section("App data") {
                Button { exporting = true } label: { Label("Export servers, prompts, MCP connections and cached conversations…", systemImage: "square.and.arrow.up") }
                Button { importing = true } label: { Label("Import an export…", systemImage: "square.and.arrow.down") }
            }
        }
        .navigationTitle("Servers and keys")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Label("Add server", systemImage: "plus") } } }
        .sheet(isPresented: $adding) { ServerEditor(profile: nil) }
        .sheet(item: $editing) { ServerEditor(profile: $0) }
        .sheet(isPresented: $exporting) { ExportSheet() }
        .sheet(isPresented: $importing) { ImportSheet() }
        .confirmationDialog("Remove \(confirmDelete?.name ?? "")?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Remove server and its stored secrets", role: .destructive) {
                if let s = confirmDelete {
                    Keychain.remove(s.secretKey); Keychain.remove(s.cookieKey); Keychain.remove(s.csrfKey)
                    if session.server?.id == s.id { session.clearServer() }
                    context.delete(s); try? context.save()
                }
                confirmDelete = nil
            }
        } message: { Text("Cached conversations of this server stay until you remove them from the export view.") }
    }
}
