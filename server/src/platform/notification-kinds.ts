/*
 * 1.9.0, Sprint 49 (B-153): the catalogue of notification kinds a person sets preferences for.
 *
 * `Notifications.notify` takes a free `kind` string (`security`, `workflow`, `group.member`, `platform.backup.failed`,
 * …). Preferences are kept per catalogue entry, not per raw kind: `kindOf` maps a raw kind to the entry with the same
 * id, else to the longest entry id it starts with followed by a dot (`group.member` → `group`, `platform.cert.failed`
 * → `platform`, `security.scan.exception` → `security.scan`), else to `other`. So a new kind a feature starts sending
 * is covered by its family, or by `other`, without a migration; give it an entry here when people should tell it apart.
 *
 * `locked` kinds are mandatory everywhere: no tenant may make them optional and no person may turn them off or delay
 * them (security alerts: password, factors, keys, sessions, connected applications, sign-in from a new device or
 * network; and account changes an administrator made, which are sent as security alerts too).
 * `push` says whether push and WebSocket delivery are on by default for the kind (people's own matters are; admin
 * queues and platform notices are not); in-app is on for every kind, and email follows what the sender asks for.
 */

export const CHANNELS = ['in_app', 'email', 'push', 'websocket'] as const;
export type Channel = (typeof CHANNELS)[number];

export const TIMINGS = ['instant', 'hourly', 'daily', 'weekly'] as const;
export type Timing = (typeof TIMINGS)[number];
export type DigestPeriod = Exclude<Timing, 'instant'>;

export interface NotificationKind {
  id: string;
  title: string;
  description: string;
  group: 'Account and security' | 'Your work' | 'People and groups' | 'Administration' | 'Platform';
  /** Mandatory in every tenant; cannot be made optional. */
  locked?: boolean;
  /** Why it is locked, shown next to the lock in Settings. */
  lockedReason?: string;
  /** Push and WebSocket on by default. */
  push?: boolean;
}

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  { id: 'security', group: 'Account and security', locked: true, push: true, title: 'Security alerts', description: 'Password, second factor, API key, app password and session changes, applications given or denied access, sign-in from a new device or network, and account changes an administrator made.', lockedReason: 'Security alerts always reach you, so a change you did not make is seen at once. Nobody can turn them off.' },
  { id: 'spam', group: 'Account and security', push: true, title: 'Posting limits', description: 'Slow mode, a hold for review or a temporary posting limit the spam and flood checks put on your account, how to appeal it, and when it ends.' },
  { id: 'signup', group: 'Administration', title: 'Sign-ups waiting for approval', description: 'Someone signed up and waits for an administrator to approve the account.' },
  { id: 'directory.sync', group: 'Administration', title: 'Directory sync', description: 'A user store sync failed or disabled accounts.' },
  { id: 'authz.review', group: 'Administration', title: 'Access reviews', description: 'An access review campaign opened or is overdue.' },
  { id: 'authz.role', group: 'Administration', title: 'Role changes proposed', description: 'A custom role change waits for a second administrator.' },
  { id: 'federation.proposal', group: 'Administration', title: 'Identity changes proposed', description: 'A single sign-on or identity change waits for a second administrator.' },
  { id: 'cloud.proposal', group: 'Administration', title: 'Cloud changes proposed', description: 'A cloud account, credential or region change waits for a second administrator.' },
  { id: 'cloud.destroy', group: 'Administration', push: true, title: 'Cloud destroys waiting', description: 'Destroying a deployment stopped at a protected resource and waits for a second administrator.' },
  { id: 'cloud.drift', group: 'Administration', title: 'Cloud drift', description: 'A deployment\'s resources no longer match what was applied.' },
  { id: 'cloud.orphan', group: 'Administration', title: 'Untracked cloud resources', description: 'Resources tagged as managed that no deployment knows about.' },
  { id: 'cloud.budget', group: 'Administration', title: 'Cloud budgets', description: 'An account reached 50, 80 or 100 % of its monthly budget (spent or forecast), and budget overrides waiting for a second administrator or decided.' },
  { id: 'cloud.anomaly', group: 'Administration', title: 'Cloud spend anomalies', description: 'A cloud account\'s daily spend on a service rose well above its 14-day baseline; the notice names the deployment, region and tags behind it.' },
  { id: 'chat', group: 'Your work', push: true, title: 'Chat', description: 'A held question was approved or rejected, and other news about your conversations.' },
  { id: 'agent', group: 'Your work', push: true, title: 'Agent runs', description: 'An agent run needs an approval, finished or failed.' },
  { id: 'workflow', group: 'Your work', push: true, title: 'Workflows', description: 'Approvals waiting for you, notify steps, and runs that failed.' },
  { id: 'api', group: 'Your work', title: 'API and evaluations', description: 'Held API requests and evaluation results.' },
  { id: 'training', group: 'Your work', title: 'Training', description: 'Training jobs waiting for approval, finished, failed or registered as a draft model.' },
  { id: 'model', group: 'Your work', title: 'Models and imports', description: 'Model imports and model changes.' },
  { id: 'media', group: 'Your work', title: 'Media', description: 'Media jobs that finished or failed.' },
  { id: 'knowledge', group: 'Your work', title: 'Knowledge', description: 'Revisions to review, publications and indexing problems.' },
  { id: 'import.repository', group: 'Your work', title: 'Import repositories', description: 'Harvests and repository changes.' },
  { id: 'app.subscription', group: 'Your work', title: 'App deliveries', description: 'A scheduled report or export delivery was paused.' },
  { id: 'report', group: 'Your work', title: 'Reports', description: 'Red-team, plugin and labeler reports.' },
  { id: 'message', group: 'People and groups', push: true, title: 'Messages', description: 'New direct messages and conversation news.' },
  { id: 'channel', group: 'People and groups', push: true, title: 'Customer channels', description: 'Customer sessions assigned to you or waiting for a reply.' },
  { id: 'feed', group: 'People and groups', push: true, title: 'Feed', description: 'Mentions, replies and the weekly workspace digest.' },
  { id: 'group', group: 'People and groups', push: true, title: 'Groups', description: 'Invitations, join requests, membership and role changes, and cases in groups you moderate.' },
  { id: 'group.governance', group: 'People and groups', push: true, title: 'Group decisions', description: 'Voting opens on a proposal in your group, a reminder before it closes, the result, and decisions carried out or waiting for an owner.' },
  { id: 'event', group: 'People and groups', push: true, title: 'Events', description: 'New, rescheduled and cancelled events, reminders, RSVPs and waitlist places.' },
  { id: 'album', group: 'People and groups', push: true, title: 'Albums', description: 'Photos and videos added to albums you own or contribute to, gathered into one notice at a time.' },
  { id: 'flag', group: 'Administration', title: 'Review queue', description: 'Flags and held answers waiting for review.' },
  { id: 'held-write', group: 'Administration', title: 'Held writes', description: 'Posts and messages held by a guardrail for review.' },
  { id: 'guardrails', group: 'Administration', title: 'Guardrails', description: 'Rule set changes waiting for approval.' },
  { id: 'moderation', group: 'Administration', title: 'Moderation', description: 'Cases, appeals and sanctions.' },
  { id: 'compliance', group: 'Administration', title: 'Compliance', description: 'Legal holds, evidence and compliance exports.' },
  { id: 'messaging.export', group: 'Administration', title: 'Conversation exports', description: 'Legal-hold conversation exports.' },
  { id: 'sla', group: 'Administration', title: 'Service levels', description: 'SLA warnings and breaches.' },
  { id: 'priority', group: 'Administration', title: 'Priority routing', description: 'Work routed to you by priority.' },
  { id: 'notify', group: 'Administration', title: 'Routed notices', description: 'Notices sent by SLA policies and app flows.' },
  { id: 'registry', group: 'Administration', title: 'Registry', description: 'Tools and entries waiting for review.' },
  { id: 'mcp', group: 'Administration', title: 'MCP servers', description: 'MCP server changes and problems.' },
  { id: 'plugin', group: 'Administration', title: 'Plugins', description: 'Plugin changes and problems.' },
  { id: 'webhook', group: 'Administration', title: 'Webhooks', description: 'Webhook deliveries that keep failing.' },
  { id: 'vault', group: 'Administration', title: 'Vault', description: 'Rotations due, shares, leases, unusual reveals and seal proposals.' },
  { id: 'zones', group: 'Administration', title: 'Zones', description: 'Zone changes waiting for approval.' },
  { id: 'pki', group: 'Administration', title: 'Certificates', description: 'Certificates that expire soon.' },
  { id: 'security.scan', group: 'Administration', title: 'Security scan exceptions', description: 'An artefact passed the security gate by exception.' },
  { id: 'audit', group: 'Platform', title: 'Audit chain', description: 'The audit chain failed verification.' },
  { id: 'platform', group: 'Platform', title: 'Platform operations', description: 'Backups, restore drills, certificates, bundles, blob stores, settings and signer proposals.' },
  { id: 'system', group: 'Platform', title: 'System notices', description: 'Other notices from the server about work you started.' },
  { id: 'other', group: 'Platform', title: 'Other', description: 'Anything not listed above.' }
];

export const KIND_IDS: readonly string[] = NOTIFICATION_KINDS.map((k) => k.id);
const BY_ID = new Map(NOTIFICATION_KINDS.map((k) => [k.id, k]));
/** Longest first, so `security.scan` is matched before `security`. */
const PREFIXES = [...KIND_IDS].sort((a, b) => b.length - a.length);

/** The kind the digest sender posts in the inbox; never held for a digest itself. */
export const DIGEST_KIND = 'notification.digest';

/** The catalogue entry for a raw notification kind (see the header). */
export function kindOf(raw: string): NotificationKind {
  const exact = BY_ID.get(raw);
  if (exact) return exact;
  for (const id of PREFIXES) if (raw.startsWith(id + '.')) return BY_ID.get(id)!;
  return BY_ID.get('other')!;
}

export const isKindId = (v: string): boolean => BY_ID.has(v);
export const kindById = (id: string): NotificationKind | undefined => BY_ID.get(id);

export interface ChannelChoice {
  enabled: boolean;
  timing: Timing;
}

/** The built-in default for a kind and channel, before any tenant default or personal choice. */
export function builtInChoice(kind: NotificationKind, channel: Channel): ChannelChoice {
  if (channel === 'in_app' || channel === 'email') return { enabled: true, timing: 'instant' };
  return { enabled: !!kind.push || !!kind.locked, timing: 'instant' };
}
