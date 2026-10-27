import Foundation

/// The declarative screens: every admin area the app does not draw by hand, from `docs/api.md` (1.0 to 1.9.9).
enum AdminCatalog {
    static func spec(for screen: Screen) -> ResourceSpec {
        switch screen {
        case .imports:
            return ResourceSpec(title: "Import", subtitle: "Repositories, catalogue harvests, model and dataset imports", tabs: [
                ResourceTab(title: "Imports", path: "imports", itemsKey: "imports", columns: [Column("Ref", "ref", .mono), Column("Item", "itemName"), Column("Kind", "kind", .pill), Column("State", "state", .pill), Column("Stage", "stage"), Column("Repository", "repository"), Column("Requested", "createdAt", .date)], detailPath: { "imports/\($0["id"].text)" }, actions: [
                    RowAction(title: "Cancel", path: { "imports/\($0["id"].text)/cancel" }, destructive: true, confirm: "Cancel this import?")]),
                ResourceTab(title: "Repositories", path: "imports/repositories", columns: [Column("Name", "name"), Column("Type", "typeName"), Column("Host", "host", .mono), Column("Harvest (min)", "harvestMinutes"), Column("Licence policy", "licencePolicy", .pill)], detailPath: { "imports/repositories/\($0["id"].text)" }, actions: [
                    RowAction(title: "Harvest now", path: { "imports/repositories/\($0["id"].text)/harvest" }, systemImage: "arrow.down.circle")], permission: "imports:repositories"),
                ResourceTab(title: "Bundle requests", path: "imports/bundle-requests", detailPath: { "imports/bundle-requests/\($0["id"].text)" }),
                ResourceTab(title: "Licence exceptions", path: "imports/exceptions", permission: "imports:review"),
                ResourceTab(title: "Quota", path: "imports/quota", single: true),
                ResourceTab(title: "Settings", path: "imports/settings", single: true)
            ])
        case .guardrails:
            return ResourceSpec(title: "Guardrails", subtitle: "Rule sets, term lists, injection defence", tabs: [
                ResourceTab(title: "Rule sets", path: "admin/guardrails/sets", columns: [Column("Name", "name"), Column("Scope", "scope", .pill), Column("Published", "publishedVersion"), Column("Draft", "draft"), Column("Locked", "locked", .bool), Column("Owner", "owner"), Column("Updated", "updatedAt", .date)], detailPath: { "admin/guardrails/sets/\($0["id"].text)" }, actions: [
                    RowAction(title: "Publish", path: { "admin/guardrails/sets/\($0["id"].text)/publish" }, fields: [FormField("note", "Note", .multiline)], systemImage: "checkmark.seal"),
                    RowAction(title: "Run tests", path: { "admin/guardrails/sets/\($0["id"].text)/tests/run" }, systemImage: "play"),
                    RowAction(title: "Draft from a description", path: { "admin/guardrails/sets/\($0["id"].text)/draft" }, fields: [FormField("description", "Describe the rule", .multiline, required: true)], systemImage: "wand.and.stars")
                ], create: CreateSpec(title: "New rule set", path: "admin/guardrails/sets", fields: [FormField("name", "Name", required: true), FormField("scope", "Scope", .select(["tenant", "workspace"]), defaultValue: "tenant"), FormField("description", "Description", .multiline)])),
                ResourceTab(title: "Term lists", path: "admin/guardrails/term-lists", detailPath: { "admin/guardrails/term-lists/\($0["id"].text)" }, create: CreateSpec(title: "New term list", path: "admin/guardrails/term-lists", fields: [FormField("name", "Name", required: true), FormField("terms", "Terms, one per line", .multiline)])),
                ResourceTab(title: "Injection", path: "admin/guardrails/injection", single: true),
                ResourceTab(title: "Status", path: "admin/guardrails/status", single: true)
            ])
        case .classifiers:
            return ResourceSpec(title: "Classifiers", subtitle: "Linear, model and vision classifiers and their eval sets", tabs: [
                ResourceTab(title: "Classifiers", path: "admin/classifiers", columns: [Column("Name", "name"), Column("Engine", "engine", .pill), Column("Status", "status", .pill), Column("Version", "version"), Column("Labels", "labels"), Column("Model", "model")], detailPath: { "admin/classifiers/\($0["id"].text)" }, actions: [
                    RowAction(title: "Evaluate", path: { "admin/classifiers/\($0["id"].text)/evaluate" }, systemImage: "play"),
                    RowAction(title: "Promote", path: { "admin/classifiers/\($0["id"].text)/promote" }, confirm: "Promote this classifier to enforce?"),
                    RowAction(title: "Retire", path: { "admin/classifiers/\($0["id"].text)/retire" }, destructive: true, confirm: "Retire this classifier?")
                ]),
                ResourceTab(title: "Eval sets", path: "eval-sets")
            ])
        case .channels:
            return ResourceSpec(title: "Channels", subtitle: "Customer-service channels, sessions and held replies", tabs: [
                ResourceTab(title: "Channels", path: "channels", columns: [Column("Name", "name"), Column("Kind", "kind", .pill), Column("State", "state", .pill), Column("Agent", "agent"), Column("Sessions", "sessions", .count)], detailPath: { "channels/\($0["id"].text)" }, actions: [
                    RowAction(title: "Sessions", method: .get, path: { "channels/\($0["id"].text)/sessions" }, systemImage: "list.bullet")], permission: "channels:review"),
                ResourceTab(title: "Held replies", path: "channels/held", itemsKey: "items", columns: [Column("Channel", "channel"), Column("Session", "sessionId", .mono), Column("Reason", "reason"), Column("Held", "createdAt", .date)], actions: [
                    RowAction(title: "Release", path: { "channels/held/\($0["id"].text)/release" }, systemImage: "paperplane"),
                    RowAction(title: "Discard", path: { "channels/held/\($0["id"].text)/discard" }, destructive: true, confirm: "Discard this reply?")])
            ])
        case .social:
            return ResourceSpec(title: "Social and messaging", subtitle: "Workspace policies for the feed, groups, messaging and relations", tabs: [
                ResourceTab(title: "Feed", path: "admin/social/feed", single: true),
                ResourceTab(title: "Groups", path: "admin/social/groups", single: true),
                ResourceTab(title: "Messaging", path: "admin/social/messaging", single: true),
                ResourceTab(title: "Relations", path: "admin/social/relations", single: true),
                ResourceTab(title: "People", path: "admin/social/people", columns: [Column("Name", "displayName"), Column("Username", "username"), Column("Presence", "presence", .pill)]),
                ResourceTab(title: "Realtime", path: "admin/social/realtime", single: true),
                ResourceTab(title: "Conversations", path: "admin/social/conversations", itemsKey: "items")
            ])
        case .connections:
            return ResourceSpec(title: "Connections", subtitle: "Data connections, their credentials and schema allow-lists", tabs: [
                ResourceTab(title: "Connections", path: "admin/connections", columns: [Column("Name", "name"), Column("Engine", "engineTitle"), Column("Family", "family", .pill), Column("State", "state", .pill), Column("Label", "label", .label), Column("Zone", "zone")], detailPath: { "admin/connections/\($0["id"].text)" }, actions: [
                    RowAction(title: "Test", path: { "admin/connections/\($0["id"].text)/test" }, systemImage: "bolt"),
                    RowAction(title: "Refresh schema", path: { "admin/connections/\($0["id"].text)/schema/refresh" }, systemImage: "arrow.clockwise"),
                    RowAction(title: "Disable", method: .patch, path: { "admin/connections/\($0["id"].text)" }, destructive: true, confirm: "Disable this connection?", fixed: ["state": "disabled"]),
                    RowAction(title: "Delete", method: .delete, path: { "admin/connections/\($0["id"].text)" }, destructive: true, confirm: "Delete this connection?")
                ], create: CreateSpec(title: "Register connection", path: "admin/connections", fields: [FormField("name", "Name", required: true), FormField("engine", "Engine id", required: true, help: "One of the engines listed under Engines, such as postgres, mysql, mongodb, opensearch."), FormField("host", "Host", required: true), FormField("port", "Port", .number), FormField("database", "Database"), FormField("username", "Username"), FormField("secret", "Password or token", .secure), FormField("label", "Label", .label, defaultValue: "internal"), FormField("zone", "Zone")])),
                ResourceTab(title: "Engines", path: "admin/connections/engines", columns: [Column("Engine", "title"), Column("Id", "id", .mono), Column("Family", "family", .pill), Column("Default port", "defaultPort")]),
                ResourceTab(title: "REST connections", path: "admin/rest-connections", detailPath: { "admin/rest-connections/\($0["id"].text)" }),
                ResourceTab(title: "Query log", path: "admin/connection-queries", itemsKey: "items")
            ])
        case .training:
            return ResourceSpec(title: "Training", subtitle: "Datasets, jobs, windows, evaluations and schedules", tabs: [
                ResourceTab(title: "Summary", path: "training/summary", single: true),
                ResourceTab(title: "Jobs", path: "training/jobs", columns: [Column("Name", "name"), Column("Base model", "baseModel"), Column("State", "state", .pill), Column("Label", "label", .label), Column("Submitted", "createdAt", .date)], detailPath: { "training/jobs/\($0["id"].text)" }, actions: [
                    RowAction(title: "Approve", path: { "training/jobs/\($0["id"].text)/approve" }, systemImage: "checkmark"),
                    RowAction(title: "Cancel", path: { "training/jobs/\($0["id"].text)/cancel" }, destructive: true, confirm: "Cancel this training job?")]),
                ResourceTab(title: "Datasets", path: "training/datasets", columns: [Column("Name", "name"), Column("Rows", "rows", .count), Column("Label", "label", .label), Column("State", "state", .pill)], detailPath: { "training/datasets/\($0["id"].text)" }),
                ResourceTab(title: "Base models", path: "training/base-models"),
                ResourceTab(title: "Windows", path: "training/windows"),
                ResourceTab(title: "Evaluations", path: "training/evals"),
                ResourceTab(title: "Schedules", path: "training/schedules"),
                ResourceTab(title: "Settings", path: "training/settings", single: true)
            ])
        case .roles:
            return ResourceSpec(title: "Roles and access", subtitle: "Built-in and custom roles, the permission matrix, effective access and access reviews", tabs: [
                ResourceTab(title: "Built-in roles", path: "authz/roles", itemsKey: "builtIn", columns: [Column("Role", "name"), Column("Id", "id", .mono), Column("Requires MFA", "requiresMfa", .bool), Column("Permissions", "permissions", .count)], detailPath: { "authz/roles/\($0["id"].text)" }),
                ResourceTab(title: "Custom roles", path: "authz/roles", itemsKey: "custom", columns: [Column("Role", "name"), Column("Id", "id", .mono), Column("Version", "version"), Column("Permissions", "permissions", .count)], detailPath: { "authz/roles/\($0["id"].text)" }, create: CreateSpec(title: "New custom role", path: "authz/roles", fields: [FormField("name", "Name", required: true), FormField("description", "Description"), FormField("permissions", "Permissions (JSON array)", .json, defaultValue: "[\"chat:read\"]")])),
                ResourceTab(title: "Matrix", path: "authz/matrix", single: true),
                ResourceTab(title: "Access reviews", path: "authz/reviews", itemsKey: "items", detailPath: { "authz/reviews/\($0["id"].text)" }, create: CreateSpec(title: "Start review", path: "authz/reviews", fields: [FormField("name", "Name", required: true), FormField("scope", "Scope", .select(["tenant", "workspace"]), defaultValue: "tenant")])),
                ResourceTab(title: "Who can", path: "authz/who-can", query: ["action": "chat:write"], note: "Who holds chat:write; change the action in the console for other permissions.")
            ])
        case .directories:
            return ResourceSpec(title: "User stores", subtitle: "The per-tenant store chain: local, LDAP, SQL, SCIM, upstream providers", tabs: [
                ResourceTab(title: "Stores", path: "admin/identity-providers", columns: [Column("Name", "name"), Column("Kind", "kind", .pill), Column("Position", "position"), Column("Enabled", "enabled", .bool), Column("State", "state", .pill), Column("Managed by", "managedBy")], detailPath: { "admin/identity-providers/\($0["id"].text)" }, actions: [
                    RowAction(title: "Test connection", path: { "admin/identity-providers/\($0["id"].text)/test" }, systemImage: "bolt"),
                    RowAction(title: "Sync now", path: { "admin/identity-providers/\($0["id"].text)/sync" }, systemImage: "arrow.triangle.2.circlepath"),
                    RowAction(title: "Archive", path: { "admin/identity-providers/\($0["id"].text)/archive" }, destructive: true, confirm: "Archive this store? Its users keep their accounts but cannot sign in through it.")]),
                ResourceTab(title: "Group mappings", path: "admin/group-mappings", columns: [Column("Group", "group_name"), Column("Role", "role"), Column("Clearance", "clearance", .label), Column("Store", "provider_id", .mono), Column("Workspace", "workspace_id", .mono)], create: CreateSpec(title: "New mapping", path: "admin/group-mappings", fields: [FormField("group", "Group DN or name", required: true), FormField("role", "Role id", required: true, defaultValue: "member"), FormField("clearance", "Clearance", .label, defaultValue: "internal"), FormField("providerId", "Store id (optional)"), FormField("workspaceId", "Workspace id (optional)")])),
                ResourceTab(title: "Store kinds", path: "admin/identity-store-kinds"),
                ResourceTab(title: "Backups", path: "admin/identity-store-backups"),
                ResourceTab(title: "Proposals", path: "admin/identity-store-proposals"),
                ResourceTab(title: "Test a login", path: "admin/test-login", single: true, note: "The console runs the chain for a username and password; this view shows the route's description only.")
            ])
        case .identity:
            return ResourceSpec(title: "Identity", subtitle: "OIDC and SAML federation, clients, keys, sessions, sign-in policy", tabs: [
                ResourceTab(title: "Overview", path: "admin/federation", single: true),
                ResourceTab(title: "OIDC clients", path: "admin/federation/oidc/clients", columns: [Column("Name", "name"), Column("Client id", "clientId", .mono), Column("Type", "type", .pill), Column("Status", "status", .pill), Column("Last used", "lastUsedAt", .date)], detailPath: { "admin/federation/oidc/clients/\($0["id"].text)" }, actions: [
                    RowAction(title: "Rotate secret", path: { "admin/federation/oidc/clients/\($0["id"].text)/rotate" }, confirm: "Rotate this client's secret? The old secret stops working."),
                    RowAction(title: "Disable", method: .patch, path: { "admin/federation/oidc/clients/\($0["id"].text)" }, destructive: true, confirm: "Disable this client?", fixed: ["status": "disabled"])],
                    create: CreateSpec(title: "New client", path: "admin/federation/oidc/clients", fields: [FormField("name", "Name", required: true), FormField("type", "Type", .select(["confidential", "public"]), defaultValue: "confidential"), FormField("redirectUris", "Redirect URIs (JSON array)", .json, defaultValue: "[]"), FormField("scopes", "Scopes (JSON array)", .json, defaultValue: "[\"openid\", \"profile\"]")])),
                ResourceTab(title: "SAML providers", path: "admin/federation/saml/sps", detailPath: { "admin/federation/saml/sps/\($0["id"].text)" }),
                ResourceTab(title: "Upstream", path: "admin/federation/upstream", detailPath: { "admin/federation/upstream/\($0["id"].text)" }),
                ResourceTab(title: "Keys", path: "admin/federation/keys", columns: [Column("Kid", "kid", .mono), Column("Algorithm", "alg"), Column("State", "state", .pill), Column("Created", "createdAt", .date)]),
                ResourceTab(title: "Scopes", path: "admin/federation/scopes"),
                ResourceTab(title: "Sessions and grants", path: "admin/federation/sessions", itemsKey: "items"),
                ResourceTab(title: "Proposals", path: "admin/federation/proposals", itemsKey: "items", actions: [
                    RowAction(title: "Approve", path: { "admin/federation/proposals/\($0["id"].text)/approve" }), RowAction(title: "Reject", path: { "admin/federation/proposals/\($0["id"].text)/reject" }, destructive: true)]),
                ResourceTab(title: "Sign-in policy", path: "admin/signin-policy", single: true),
                ResourceTab(title: "Leaked passwords", path: "admin/leaked-passwords/lists"),
                ResourceTab(title: "SCIM tokens", path: "admin/identity/scim/tokens", itemsKey: "items"),
                ResourceTab(title: "MCP server", path: "admin/mcp-server", single: true),
                ResourceTab(title: "Settings", path: "admin/federation/settings", single: true)
            ])
        case .certificates:
            return ResourceSpec(title: "Certificates", subtitle: "The tenant certificate authority, issuers, profiles, ACME and tokens", tabs: [
                ResourceTab(title: "Summary", path: "pki", single: true),
                ResourceTab(title: "Issuers", path: "pki/issuers", itemsKey: "issuers", columns: [Column("Name", "name"), Column("Kind", "kind", .pill), Column("Organization", "organization"), Column("Key", "keyType"), Column("Custody", "custody"), Column("State", "state", .pill), Column("Expires", "notAfter", .date)], detailPath: { "pki/issuers/\($0["id"].text)" }),
                ResourceTab(title: "Certificates", path: "pki/certificates", itemsKey: "certificates", columns: [Column("Common name", "commonName"), Column("Serial", "serial", .mono), Column("Key", "keyType"), Column("State", "state", .pill), Column("Expires", "notAfter", .date)], detailPath: { "pki/certificates/\($0["id"].text)" }, actions: [
                    RowAction(title: "Revoke", path: { "pki/certificates/\($0["id"].text)/revoke" }, fields: [FormField("reason", "Reason", .select(["unspecified", "keyCompromise", "superseded", "cessationOfOperation"]), defaultValue: "unspecified")], destructive: true)]),
                ResourceTab(title: "Profiles", path: "pki/profiles"),
                ResourceTab(title: "Members", path: "pki/members"),
                ResourceTab(title: "ACME accounts", path: "pki/acme/accounts"),
                ResourceTab(title: "ACME orders", path: "pki/acme/orders"),
                ResourceTab(title: "Tokens", path: "pki/tokens", permission: "pki:tokens"),
                ResourceTab(title: "Settings", path: "pki/settings", single: true)
            ])
        case .vault:
            return ResourceSpec(title: "Vault", subtitle: "Secrets, transit keys, policies, leases and signing keys", tabs: [
                ResourceTab(title: "Secrets", path: "vault/kv", itemsKey: "items", columns: [Column("Path", "path", .mono), Column("Version", "version"), Column("Updated", "updatedAt", .date)], note: "Values are never listed; open a secret to reveal one version (audited)."),
                ResourceTab(title: "Transit keys", path: "vault/transit/keys", itemsKey: "items", actions: [RowAction(title: "Rotate", path: { "vault/transit/keys/\($0["name"].text)/rotate" }, confirm: "Rotate this key?")]),
                ResourceTab(title: "Policies", path: "vault/policies", itemsKey: "items", detailPath: { "vault/policies/\($0["name"].text)" }),
                ResourceTab(title: "Database engines", path: "vault/database/engines", itemsKey: "items"),
                ResourceTab(title: "Database leases", path: "vault/database/leases", itemsKey: "items", actions: [RowAction(title: "Revoke", path: { "vault/database/leases/\($0["id"].text)/revoke" }, destructive: true)]),
                ResourceTab(title: "API-key leases", path: "vault/apikey/leases", itemsKey: "items"),
                ResourceTab(title: "Signing keys", path: "vault/signing-keys", itemsKey: "items"),
                ResourceTab(title: "Shared with me", path: "vault/shared-with-me", itemsKey: "items"),
                ResourceTab(title: "Reveal flags", path: "vault/reveal-flags", itemsKey: "items"),
                ResourceTab(title: "Reference owners", path: "vault/reference-owners", itemsKey: "items")
            ])
        case .plugins:
            return ResourceSpec(title: "Plugins and events", subtitle: "Installed plugins, the event catalogue, webhooks and allowed hosts", tabs: [
                ResourceTab(title: "Plugins", path: "admin/plugins", itemsKey: "plugins", columns: [Column("Name", "name"), Column("Key", "key", .mono), Column("Version", "version"), Column("Kind", "kind", .pill), Column("State", "state", .pill), Column("Publisher", "publisher"), Column("Max label", "maxLabel", .label)], detailPath: { "admin/plugins/\($0["id"].text)" }, actions: [
                    RowAction(title: "Enable", path: { "admin/plugins/\($0["id"].text)/enable" }), RowAction(title: "Disable", path: { "admin/plugins/\($0["id"].text)/disable" }, destructive: true, confirm: "Disable this plugin?")]),
                ResourceTab(title: "Available", path: "admin/plugins/available"),
                ResourceTab(title: "Event catalogue", path: "events/catalogue", itemsKey: "types"),
                ResourceTab(title: "Event groups", path: "events/catalogue", itemsKey: "groups", columns: [Column("Pattern", "pattern", .mono), Column("Description", "description")]),
                ResourceTab(title: "Webhooks", path: "admin/webhooks", itemsKey: "webhooks", columns: [Column("URL", "url", .mono), Column("Events", "events"), Column("State", "state", .pill), Column("Failures", "failures", .count)], detailPath: { "admin/webhooks/\($0["id"].text)" }, actions: [
                    RowAction(title: "Deliveries", method: .get, path: { "admin/webhooks/\($0["id"].text)/deliveries" }), RowAction(title: "Rotate secret", path: { "admin/webhooks/\($0["id"].text)/rotate" }, confirm: "Rotate this webhook's secret?"), RowAction(title: "Delete", method: .delete, path: { "admin/webhooks/\($0["id"].text)" }, destructive: true, confirm: "Delete this webhook?")],
                    create: CreateSpec(title: "New webhook", path: "admin/webhooks", fields: [FormField("url", "URL", required: true), FormField("events", "Events (JSON array)", .json, defaultValue: "[\"chat.completed\"]"), FormField("secret", "Secret", .secure)]), permission: "webhooks:manage"),
                ResourceTab(title: "Allowed hosts", path: "admin/integrations/hosts", itemsKey: "items", permission: "tenant:manage"),
                ResourceTab(title: "Plugin drafts", path: "admin/plugin-drafts", itemsKey: "items")
            ])
        case .atproto:
            return ResourceSpec(title: "AT-Protocol", subtitle: "Identities and keys, labels, trusted labelers, the firehose and the PDS", tabs: [
                ResourceTab(title: "Summary", path: "atproto", single: true),
                ResourceTab(title: "Identity", path: "atproto/identity", single: true),
                ResourceTab(title: "Labels", path: "atproto/labels", itemsKey: "labels", permission: "labels:manage"),
                ResourceTab(title: "Labelers", path: "atproto/labelers", itemsKey: "items", permission: "labels:manage"),
                ResourceTab(title: "Firehose", path: "atproto/firehose", itemsKey: "items", permission: "firehose:manage"),
                ResourceTab(title: "Feeds", path: "atproto/feeds", itemsKey: "items"),
                ResourceTab(title: "PDS", path: "admin/pds", single: true, permission: "pds:manage"),
                ResourceTab(title: "PDS accounts", path: "admin/pds/accounts", itemsKey: "items", permission: "pds:manage")
            ])
        case .zones:
            return ResourceSpec(title: "Zones", subtitle: "Versioned zone specs, ceilings, peers and what is misplaced", tabs: [
                ResourceTab(title: "Zones", path: "admin/zones", itemsKey: "zones", columns: [Column("Name", "name"), Column("Ceiling", "labelCeiling", .label), Column("Version", "version"), Column("Pools", "pools", .count), Column("State", "state", .pill)], detailPath: { "admin/zones/\($0["id"].text)" }, actions: [
                    RowAction(title: "Apply", path: { "admin/zones/\($0["id"].text)/apply" }, confirm: "Apply this zone's network policy?"), RowAction(title: "Check drift", path: { "admin/zones/\($0["id"].text)/drift" })]),
                ResourceTab(title: "Misplaced", path: "admin/zones/misplaced", itemsKey: "items"),
                ResourceTab(title: "Cluster", path: "admin/zones-cluster", single: true)
            ])
        case .analytics:
            return ResourceSpec(title: "Analytics", subtitle: "Usage and cost by dimension, prices and chargeback", tabs: [
                ResourceTab(title: "Summary", path: "admin/analytics/summary", query: ["by": "model", "days": "30"], itemsKey: "rows", columns: [Column("Key", "name"), Column("Prompt", "prompt", .count), Column("Output", "output", .count), Column("Requests", "requests", .count), Column("Cost", "cost")], note: "By model, last 30 days."),
                ResourceTab(title: "By workspace", path: "admin/analytics/summary", query: ["by": "workspace", "days": "30"], itemsKey: "rows"),
                ResourceTab(title: "By person", path: "admin/analytics/summary", query: ["by": "user", "days": "30"], itemsKey: "rows"),
                ResourceTab(title: "Daily", path: "admin/analytics/daily", query: ["days": "30"], itemsKey: "days"),
                ResourceTab(title: "Prices", path: "admin/analytics/prices", single: true),
                ResourceTab(title: "Chargeback", path: "admin/analytics/chargeback", query: ["days": "30"], single: true)
            ])
        case .billing:
            return ResourceSpec(title: "Billing", subtitle: "Price books, plans, subscriptions, statements and discounts", tabs: [
                ResourceTab(title: "Statements", path: "admin/billing/statements", itemsKey: "statements", columns: [Column("Month", "month"), Column("State", "state", .pill), Column("Total", "total"), Column("Lines", "lineCount", .count)], detailPath: { "admin/billing/statements/\($0["month"].text)" }, actions: [
                    RowAction(title: "Compute", path: { "admin/billing/statements/\($0["month"].text)/compute" }, permission: "billing:manage"), RowAction(title: "Push to Stripe", path: { "admin/billing/statements/\($0["month"].text)/push" }, confirm: "Push this statement as an invoice?", permission: "billing:manage")]),
                ResourceTab(title: "Price books", path: "admin/billing/price-books", itemsKey: "books", columns: [Column("Name", "name"), Column("Currency", "currency"), Column("Default", "isDefault", .bool), Column("State", "state", .pill), Column("Items", "items", .count)]),
                ResourceTab(title: "Plans", path: "admin/billing/plans", itemsKey: "items"),
                ResourceTab(title: "Subscription", path: "admin/billing/subscription", single: true),
                ResourceTab(title: "Discounts", path: "admin/billing/discounts", itemsKey: "items"),
                ResourceTab(title: "Promo codes", path: "admin/billing/promo-codes", itemsKey: "items"),
                ResourceTab(title: "Settings", path: "admin/billing/settings", single: true)
            ])
        case .storage:
            return ResourceSpec(title: "Storage", subtitle: "Blob stores, usage, quarantine, purges and integrity", tabs: [
                ResourceTab(title: "Stores", path: "admin/storage/stores", itemsKey: "stores", columns: [Column("Name", "name"), Column("Kind", "kind", .pill), Column("Location", "location", .mono), Column("Used", "usedBytes", .bytes), Column("Free", "freeBytes", .bytes), Column("Objects", "objects", .count), Column("Health", "health", .pill)]),
                ResourceTab(title: "Usage", path: "admin/storage/usage", single: true),
                ResourceTab(title: "Quarantine", path: "admin/storage/quarantine", itemsKey: "items"),
                ResourceTab(title: "Purges", path: "admin/storage/purges", itemsKey: "items"),
                ResourceTab(title: "Migrations", path: "admin/storage/migrations", itemsKey: "items"),
                ResourceTab(title: "Integrity", path: "admin/storage/integrity", single: true),
                ResourceTab(title: "Local roots", path: "admin/storage/local-roots", itemsKey: "items")
            ])
        case .configuration:
            return ResourceSpec(title: "Configuration", subtitle: "The running settings and their sources", tabs: [
                ResourceTab(title: "Settings", path: "admin/platform/settings", single: true),
                ResourceTab(title: "Feature flags", path: "admin/feature-flags", itemsKey: "flags"),
                ResourceTab(title: "Notification defaults", path: "admin/notification-defaults", single: true),
                ResourceTab(title: "Notification templates", path: "admin/notification-templates", itemsKey: "items"),
                ResourceTab(title: "Overview cards", path: "admin/overview-cards", itemsKey: "items")
            ])
        case .platform:
            return ResourceSpec(title: "Platform", subtitle: "Signers, bundles, mirrors, certificates, keys, backups and push targets", tabs: [
                ResourceTab(title: "Summary", path: "admin/platform/summary", single: true),
                ResourceTab(title: "Backups", path: "admin/platform/backups", itemsKey: "backups", columns: [Column("Id", "id", .mono), Column("State", "state", .pill), Column("Size", "bytes", .bytes), Column("Created", "createdAt", .date)], actions: [RowAction(title: "Restore drill", path: { "admin/platform/backups/\($0["id"].text)/drill" }, confirm: "Run a restore drill from this backup?")], create: CreateSpec(title: "Back up now", path: "admin/platform/backups", fields: [])),
                ResourceTab(title: "Certificates", path: "admin/platform/certificates", itemsKey: "items", actions: [RowAction(title: "Renew", path: { "admin/platform/certificates/\($0["id"].text)/renew" })]),
                ResourceTab(title: "Bundles", path: "admin/platform/bundles", itemsKey: "items"),
                ResourceTab(title: "Mirrors", path: "admin/platform/mirrors", itemsKey: "items"),
                ResourceTab(title: "Signers", path: "admin/platform/signers", itemsKey: "items"),
                ResourceTab(title: "Data keys", path: "admin/platform/keys", single: true),
                ResourceTab(title: "Push targets", path: "admin/platform/push-targets", itemsKey: "items"),
                ResourceTab(title: "Security scans", path: "admin/security/scans", itemsKey: "items"),
                ResourceTab(title: "Search index", path: "admin/search", single: true, permission: "tenant:manage")
            ])
        case .compliance:
            return ResourceSpec(title: "Compliance", subtitle: "DLP rules, legal holds and compliance exports", tabs: [
                ResourceTab(title: "DLP", path: "compliance/dlp", itemsKey: "items"),
                ResourceTab(title: "Legal holds", path: "compliance/holds", itemsKey: "holds", actions: [RowAction(title: "Release", path: { "compliance/holds/\($0["id"].text)/release" }, destructive: true, confirm: "Release this hold?")], create: CreateSpec(title: "New hold", path: "compliance/holds", fields: [FormField("name", "Name", required: true), FormField("reason", "Reason", .multiline, required: true), FormField("scope", "Scope (JSON)", .json, defaultValue: "{}")])),
                ResourceTab(title: "Exports", path: "compliance/exports", itemsKey: "items", permission: "compliance:export")
            ])
        case .redteam:
            return ResourceSpec(title: "Red team", subtitle: "The attack catalogue; suites are listed per target (profile, agent or workflow) in the console", tabs: [
                ResourceTab(title: "Attack catalogue", path: "admin/red-team/attacks", itemsKey: "items"),
                ResourceTab(title: "Suites", path: "admin/red-team", query: ["targetKind": "profile", "targetId": "-"], itemsKey: "items", actions: [RowAction(title: "Run", path: { "admin/red-team/\($0["id"].text)/run" }, systemImage: "play")], note: "Suites belong to one target: this list asks for profile targets without an id and shows what the route answers.")
            ])
        case .inventory:
            return ResourceSpec(title: "AI inventory", subtitle: "Every AI system in use, its owner and its register", tabs: [
                ResourceTab(title: "Systems", path: "admin/inventory", itemsKey: "items", columns: [Column("Name", "name"), Column("Kind", "kind", .pill), Column("Version", "version"), Column("Status", "status", .pill), Column("Label", "label", .label), Column("Owner", "ownerName"), Column("Complete", "complete", .bool)], detailPath: { "admin/inventory/\($0["id"].text)" }),
                ResourceTab(title: "Settings", path: "admin/inventory/settings", single: true)
            ])
        case .featureFlags:
            return ResourceSpec(title: "Feature flags", subtitle: "Flags, targeting and rollout", tabs: [
                ResourceTab(title: "Flags", path: "admin/feature-flags", itemsKey: "flags", columns: [Column("Key", "key", .mono), Column("State", "state", .pill), Column("Rollout", "rollout"), Column("Updated", "updatedAt", .date)], detailPath: { "admin/feature-flags/\($0["key"].text)" }),
                ResourceTab(title: "Proposals", path: "admin/feature-flags/proposals", itemsKey: "items")
            ])
        case .push:
            return ResourceSpec(title: "Push and notifications", subtitle: "Push providers, the delivery log and notification templates", tabs: [
                ResourceTab(title: "Providers", path: "admin/push/providers", itemsKey: "providers", actions: [RowAction(title: "Test", path: { "admin/push/providers/\($0["id"].text)/test" })]),
                ResourceTab(title: "Deliveries", path: "admin/push/deliveries", itemsKey: "items"),
                ResourceTab(title: "Templates", path: "admin/notification-templates", itemsKey: "items"),
                ResourceTab(title: "Defaults", path: "admin/notification-defaults", single: true)
            ])
        case .sla:
            return ResourceSpec(title: "SLA routing", subtitle: "Policies, skills, routing and the queue", tabs: [
                ResourceTab(title: "Flags in SLA", path: "sla/items", query: ["type": "flag"], itemsKey: "items"),
                ResourceTab(title: "Channel sessions in SLA", path: "sla/items", query: ["type": "channel-session"], itemsKey: "items"),
                ResourceTab(title: "Policies", path: "sla/policies", itemsKey: "items"),
                ResourceTab(title: "Skills", path: "sla/skills", itemsKey: "items"),
                ResourceTab(title: "Routing", path: "sla/routing", single: true),
                ResourceTab(title: "Stats", path: "sla/stats", single: true)
            ])
        case .decisions:
            return ResourceSpec(title: "Decision tables", subtitle: "Tables a workflow or an agent evaluates", tabs: [
                ResourceTab(title: "Tables", path: "decision-tables", columns: [Column("Name", "title"), Column("Id", "name", .mono), Column("Published", "publishedVersion"), Column("Draft", "draftRev"), Column("Hit policy", "hitPolicy", .pill), Column("Label", "label", .label), Column("Updated", "updatedAt", .date)], detailPath: { "decision-tables/\($0["id"].text)" }, actions: [
                    RowAction(title: "Evaluate", path: { "decision-tables/\($0["id"].text)/evaluate" }, fields: [FormField("input", "Input (JSON)", .json, defaultValue: "{}")], systemImage: "play"),
                    RowAction(title: "Publish", path: { "decision-tables/\($0["id"].text)/publish" })])
            ])
        case .scripts:
            return ResourceSpec(title: "Scripts", subtitle: "Sandboxed Python and JavaScript scripts of this workspace", tabs: [
                ResourceTab(title: "Scripts", path: "scripts", columns: [Column("Name", "name"), Column("Language", "language", .pill), Column("Status", "status", .pill), Column("Label", "label", .label), Column("Version", "version")], detailPath: { "scripts/\($0["id"].text)" }, actions: [
                    RowAction(title: "Run", path: { "scripts/\($0["id"].text)/run" }, fields: [FormField("stdin", "Standard input", .multiline)], systemImage: "play"),
                    RowAction(title: "Re-run checks", path: { "scripts/\($0["id"].text)/checks" }),
                    RowAction(title: "Runs", method: .get, path: { "scripts/\($0["id"].text)/runs" })],
                    create: CreateSpec(title: "New script", path: "scripts", fields: [FormField("name", "Name", required: true), FormField("language", "Language", .select(["python", "javascript"]), defaultValue: "python"), FormField("source", "Source", .multiline, required: true, defaultValue: "print('hello')"), FormField("label", "Label", .label, defaultValue: "internal")])),
                ResourceTab(title: "Runtime", path: "scripts/runtime", single: true)
            ])
        case .media:
            return ResourceSpec(title: "Media", subtitle: "Uploaded media and the ffmpeg presets", tabs: [
                ResourceTab(title: "Assets", path: "media/assets", columns: [Column("Name", "name"), Column("Kind", "kind", .pill), Column("Format", "format"), Column("Size", "size", .bytes), Column("State", "state", .pill), Column("Label", "label", .label)], detailPath: { "media/assets/\($0["id"].text)" }, actions: [RowAction(title: "Run preset", path: { "media/assets/\($0["id"].text)/jobs" }, fields: [FormField("preset", "Preset", required: true)])]),
                ResourceTab(title: "Capabilities", path: "media/caps", single: true)
            ])
        case .apps:
            return ResourceSpec(title: "Apps", subtitle: "Low-code data apps of your workspaces", tabs: [
                ResourceTab(title: "Apps", path: "apps", itemsKey: "apps", columns: [Column("Name", "title"), Column("Id", "name", .mono), Column("Scope", "scope", .pill), Column("Label", "label", .label), Column("Updated", "updatedAt", .date)], detailPath: { "apps/\($0["id"].text)" }),
                ResourceTab(title: "Subscriptions", path: "apps/subscriptions", itemsKey: "items"),
                ResourceTab(title: "Held submissions", path: "apps/held", itemsKey: "items"),
                ResourceTab(title: "Pipelines", path: "apps/pipelines", itemsKey: "items", permission: "apps:design")
            ])
        default:
            return ResourceSpec(title: screen.title, tabs: [ResourceTab(title: screen.title, path: "me", single: true, note: "This screen has no native view yet.")])
        }
    }
}
