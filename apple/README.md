# Exprsn-AI for Mac, iPhone and iPad

A native SwiftUI client for Exprsn-AI installs (every console feature of 1.0 to 1.9.9), for OpenAI-compatible
platforms, and for MCP servers. One Xcode target builds for macOS 15+, iOS 18+ and iPadOS 18+; the macOS build
follows the macOS Human Interface Guidelines (split view sidebar, inspector, menu bar commands, Settings window),
the iPhone build a tab bar with a More list, the iPad build the split view. Colours are the console's tokens
(`web/css/app.css`): light, dark, and the AA mode's stronger lines and text when the account's accessibility
preference is `aa` or `aaa`.

## Build

```sh
cd Exprsn-AI-current/apple
open ExprsnAI.xcodeproj                                   # Xcode 16 or later; run the ExprsnAI scheme on My Mac or a simulator
xcodebuild -scheme ExprsnAI -destination 'platform=macOS' build
xcodebuild -scheme ExprsnAI -destination 'generic/platform=iOS Simulator' build
```

No dependencies: Foundation networking, SwiftData, SwiftUI. Secrets (API keys, session cookies, MCP tokens) live in
the Keychain; the SwiftData store holds servers, MCP connections, local prompts, cached conversations and recent
searches. The app is sandboxed (network client, user-selected files). `Support/Info.plist` allows local networking,
so `http://localhost:8091` and `exprsn.local` work.

## What it does

**Servers and keys.** Any number of Exprsn-AI installs (password sign-in with TOTP, email and recovery-code second
factors, forced password change, or an `exai_k1_…` API key) and OpenAI-compatible platforms (`/v1/models`,
`/v1/chat/completions`, a bearer key). Export and import the app's data as one `.exprsnai` JSON file (secrets only
when asked).

**Workspace screens.** Chat (conversations, folders, streamed answers with thinking and tool calls, regenerate,
edit, stop and continue, sibling answers, attachments through quarantine, share with a person, a workspace or a
link, export as Markdown, JSON, Word, OpenDocument, PDF, HTML, text or RTF, report an answer), Compare (2 to 4
profiles side by side), Runs (agents, steps and lanes, approvals, resume, replay, schedules), Knowledge (bases,
documents, uploads, sources, search, access), Memory, Workflows (runs, approvals, dead letters, templates, publish
as tool), Decision tables, Scripts, Media, Images (generate, vary, provenance), Prompts (the server library and
local prompts), Files (browse, upload, download, versions, shares, trash), Apps, Groups and events, Calendar,
Messages, Feed, one Search box, and Settings (profile, contrast mode, password, API keys with scopes, sessions,
second factors, app passwords, OAuth grants, push devices, notification preferences, MCP access and held calls,
inbox, jobs).

**Admin and moderator screens**, each shown only to holders of its permission as the console does: Overview, Jobs
and queues, Users, Tenants and workspaces, Flags (decide, escalate, reassign, teach the rule, hide the object),
Moderation (queues, appeals, sanctions, actions, providers, dead letters), MCP servers (register, check, approve
tools, bind to profiles, rotate credentials), Models, Profiles, Pools and instances, Registry, Usage and audit,
and the declarative screens in `Features/Admin/AdminCatalog.swift`: Import, Guardrails, Classifiers, Channels,
Social, Connections, Training, Roles and access, User stores, Identity, Certificates, Vault, Plugins and events,
AT-Protocol, Zones, Analytics, Billing, Storage, Configuration, Platform, Compliance, Red team, AI inventory,
Feature flags, Push, SLA routing.

**MCP.** The MCP connections screen is a native Streamable HTTP client (initialize, tools/list, tools/call,
resources/list) for any MCP server, including the one Exprsn-AI publishes per workspace; the MCP servers admin
screen manages the servers an install registers for its models.

## Streaming

Answers are read from `GET /api/conversations/:id/messages/:mid/stream?after=` on a short interval (Preferences on
macOS), so the app needs no Socket.IO and resumes a stream after any interruption; OpenAI-compatible platforms
stream over server-sent events.

## Smoke run

With `EXPRSN_SNAPSHOT_DIR` set the macOS app signs in, walks every screen it may show in light and dark appearance
and writes a PNG of the window per screen plus `report.txt` and `log.txt` (into the directory, or into the app's
sandbox Documents when the directory is not writable). `EXPRSN_BOOTSTRAP_URL`, `EXPRSN_BOOTSTRAP_NAME`,
`EXPRSN_BOOTSTRAP_USERNAME`, `EXPRSN_BOOTSTRAP_TENANT` and either `EXPRSN_BOOTSTRAP_API_KEY` or
`EXPRSN_BOOTSTRAP_PASSWORD` provision the server on first launch (also handy for managed installs).

```sh
open -n --env EXPRSN_SNAPSHOT_DIR=/tmp/snaps --env EXPRSN_BOOTSTRAP_URL=http://localhost:8091 \
  --env EXPRSN_BOOTSTRAP_API_KEY=exai_k1_… build/ExprsnAI.app
```

## Layout

| Path | What it is |
| --- | --- |
| `ExprsnAI/App` | `ExprsnAIApp` (scenes, commands), `RootView`, `MainShell` (sidebar or tabs), `AppSession` (sign-in, `/me`, permissions, step-up), `Navigation` (the screen catalogue), `Bootstrap`, `Snapshots` |
| `ExprsnAI/Core` | `APIClient` (cookie or bearer auth, CSRF, `X-Workspace`, problem+json), `JSONValue`, `Keychain`, `SSEClient`, `MCPClient`, `Loadable` |
| `ExprsnAI/Data` | SwiftData models and the export bundle |
| `ExprsnAI/Design` | Colour tokens, pills, label badges, notices, meters, stat tiles |
| `ExprsnAI/Features` | One folder per screen family; `Admin/Resource.swift` is the declarative table, detail, form and action engine |
| `Support/Info.plist` | Local networking, Bonjour, the `.exprsnai` document type |
