import SwiftUI

/// Every screen of the console (1.9.9 and earlier), with the permission that shows it, as `web/js/app.js` lists them.
enum Screen: String, CaseIterable, Identifiable, Hashable, Codable {
    // Workspace
    case chat, compare, runs, knowledge, memory, workflows, decisions, scripts, media, images, prompts, files, apps, groups, messages, feed, search, calendar
    // Account
    case settings, servers, mcpClient, platformChat
    // Admin
    case overview, models, imports, profiles, pools, registry, mcpServers, guardrails, flags, classifiers, moderation, channels, social, connections, training, tenants, users, roles, directories, identity, certificates, vault, plugins, atproto, zones, usageAudit, analytics, billing, storage, configuration, jobs, platform, compliance, redteam, inventory, featureFlags, push, sla

    var id: String { rawValue }

    enum Section: String, CaseIterable, Identifiable { case workspace = "Workspace", account = "Account", admin = "Admin"; var id: String { rawValue } }

    var section: Section {
        switch self {
        case .chat, .compare, .runs, .knowledge, .memory, .workflows, .decisions, .scripts, .media, .images, .prompts, .files, .apps, .groups, .messages, .feed, .search, .calendar: return .workspace
        case .settings, .servers, .mcpClient, .platformChat: return .account
        default: return .admin
        }
    }

    var title: String {
        switch self {
        case .chat: return "Chat"
        case .compare: return "Compare"
        case .runs: return "Runs"
        case .knowledge: return "Knowledge"
        case .memory: return "Memory"
        case .workflows: return "Workflows"
        case .decisions: return "Decision tables"
        case .scripts: return "Scripts"
        case .media: return "Media"
        case .images: return "Images"
        case .prompts: return "Prompts"
        case .files: return "Files"
        case .apps: return "Apps"
        case .groups: return "Groups and events"
        case .messages: return "Messages"
        case .feed: return "Feed"
        case .search: return "Search"
        case .calendar: return "Calendar"
        case .settings: return "Settings"
        case .servers: return "Servers and keys"
        case .mcpClient: return "MCP connections"
        case .platformChat: return "Platform chat"
        case .overview: return "Overview"
        case .models: return "Models"
        case .imports: return "Import"
        case .profiles: return "Profiles"
        case .pools: return "Pools"
        case .registry: return "Registry"
        case .mcpServers: return "MCP servers"
        case .guardrails: return "Guardrails"
        case .flags: return "Flags"
        case .classifiers: return "Classifiers"
        case .moderation: return "Moderation"
        case .channels: return "Channels"
        case .social: return "Social and messaging"
        case .connections: return "Connections"
        case .training: return "Training"
        case .tenants: return "Tenants"
        case .users: return "Users"
        case .roles: return "Roles and access"
        case .directories: return "User stores"
        case .identity: return "Identity"
        case .certificates: return "Certificates"
        case .vault: return "Vault"
        case .plugins: return "Plugins and events"
        case .atproto: return "AT-Protocol"
        case .zones: return "Zones"
        case .usageAudit: return "Usage and audit"
        case .analytics: return "Analytics"
        case .billing: return "Billing"
        case .storage: return "Storage"
        case .configuration: return "Configuration"
        case .jobs: return "Jobs and queues"
        case .platform: return "Platform"
        case .compliance: return "Compliance"
        case .redteam: return "Red team"
        case .inventory: return "AI inventory"
        case .featureFlags: return "Feature flags"
        case .push: return "Push and notifications"
        case .sla: return "SLA routing"
        }
    }

    var systemImage: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right"
        case .compare: return "rectangle.split.2x1"
        case .runs: return "play.circle"
        case .knowledge: return "books.vertical"
        case .memory: return "brain"
        case .workflows: return "arrow.triangle.branch"
        case .decisions: return "tablecells"
        case .scripts: return "chevron.left.forwardslash.chevron.right"
        case .media: return "film"
        case .images: return "photo"
        case .prompts: return "text.quote"
        case .files: return "folder"
        case .apps: return "square.grid.2x2"
        case .groups: return "person.3"
        case .messages: return "envelope"
        case .feed: return "newspaper"
        case .search: return "magnifyingglass"
        case .calendar: return "calendar"
        case .settings: return "gearshape"
        case .servers: return "server.rack"
        case .mcpClient: return "point.3.connected.trianglepath.dotted"
        case .platformChat: return "sparkles"
        case .overview: return "gauge.with.dots.needle.33percent"
        case .models: return "cube"
        case .imports: return "square.and.arrow.down"
        case .profiles: return "slider.horizontal.3"
        case .pools: return "cpu"
        case .registry: return "wrench.and.screwdriver"
        case .mcpServers: return "point.3.filled.connected.trianglepath.dotted"
        case .guardrails: return "shield.lefthalf.filled"
        case .flags: return "flag"
        case .classifiers: return "tag"
        case .moderation: return "hand.raised"
        case .channels: return "headset"
        case .social: return "person.2.wave.2"
        case .connections: return "cylinder.split.1x2"
        case .training: return "graduationcap"
        case .tenants: return "building.2"
        case .users: return "person.crop.circle"
        case .roles: return "person.badge.key"
        case .directories: return "person.text.rectangle"
        case .identity: return "key"
        case .certificates: return "checkmark.seal"
        case .vault: return "lock.shield"
        case .plugins: return "puzzlepiece.extension"
        case .atproto: return "at"
        case .zones: return "map"
        case .usageAudit: return "doc.text.magnifyingglass"
        case .analytics: return "chart.bar"
        case .billing: return "creditcard"
        case .storage: return "internaldrive"
        case .configuration: return "slider.horizontal.below.rectangle"
        case .jobs: return "list.bullet.clipboard"
        case .platform: return "building.columns"
        case .compliance: return "checklist"
        case .redteam: return "target"
        case .inventory: return "list.bullet.rectangle"
        case .featureFlags: return "switch.2"
        case .push: return "bell.badge"
        case .sla: return "clock.badge.checkmark"
        }
    }

    /// Any of these permissions shows the screen (an empty list: everyone signed in).
    var permissions: [String] {
        switch self {
        case .chat: return ["chat:read"]
        case .compare: return ["inference:invoke"]
        case .runs: return ["agents:run"]
        case .knowledge: return ["knowledge:read"]
        case .memory: return ["memory:write"]
        case .workflows, .decisions: return ["agents:run"]
        case .scripts: return ["scripts:run"]
        case .media: return ["chat:write"]
        case .images: return ["images:generate"]
        case .prompts: return ["chat:read"]
        case .files: return ["files:read"]
        case .apps: return ["records:read"]
        case .groups, .calendar: return ["groups:read"]
        case .messages: return ["messages:read"]
        case .feed: return ["feed:read"]
        case .search: return ["chat:read", "messages:read", "feed:read", "files:read", "knowledge:read", "groups:read"]
        case .settings, .servers, .mcpClient, .platformChat: return []
        case .overview, .jobs: return ["platform:manage", "tenant:manage"]
        case .models: return ["models:manage"]
        case .imports: return ["imports:run"]
        case .profiles: return ["profiles:manage"]
        case .pools: return ["pools:manage"]
        case .registry: return ["tools:manage"]
        case .mcpServers: return ["mcp:manage"]
        case .guardrails: return ["guardrails:manage"]
        case .flags: return ["flags:review"]
        case .classifiers: return ["classifiers:manage"]
        case .moderation: return ["moderation:review", "moderation:manage"]
        case .channels: return ["channels:review"]
        case .social: return ["social:manage"]
        case .connections: return ["connections:manage"]
        case .training: return ["training:manage"]
        case .tenants: return ["tenant:manage"]
        case .users: return ["users:manage"]
        case .roles: return ["roles:manage"]
        case .directories, .identity: return ["identity:manage"]
        case .certificates: return ["pki:manage"]
        case .vault: return ["secrets:admin"]
        case .plugins: return ["plugins:manage"]
        case .atproto: return ["pki:manage", "labels:manage", "firehose:manage", "identity:manage", "pds:manage"]
        case .zones: return ["zones:manage"]
        case .usageAudit: return ["audit:read"]
        case .analytics: return ["usage:read"]
        case .billing: return ["billing:read"]
        case .storage, .configuration, .platform: return ["platform:manage"]
        case .compliance: return ["compliance:manage"]
        case .redteam: return ["guardrails:manage"]
        case .inventory: return ["tools:manage", "models:manage"]
        case .featureFlags: return ["tenant:manage"]
        case .push: return ["tenant:manage"]
        case .sla: return ["channels:manage"]
        }
    }

    /// The sidebar order inside each section.
    static let sidebar: [Screen] = [
        .chat, .compare, .runs, .knowledge, .memory, .workflows, .decisions, .scripts, .media, .images, .prompts, .files, .apps, .groups, .calendar, .messages, .feed, .search,
        .settings, .servers, .mcpClient, .platformChat,
        .overview, .models, .imports, .profiles, .pools, .registry, .mcpServers, .guardrails, .flags, .classifiers, .moderation, .channels, .social, .connections, .training, .tenants, .users, .roles, .directories, .identity, .certificates, .vault, .plugins, .atproto, .zones, .usageAudit, .analytics, .billing, .featureFlags, .push, .sla, .compliance, .redteam, .inventory, .storage, .configuration, .jobs, .platform
    ]

    /// Screens the compact (iPhone) tab bar shows first; the rest sit under More.
    static let phoneTabs: [Screen] = [.chat, .messages, .search, .settings]
}
