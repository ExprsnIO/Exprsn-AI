import { graphVaultRefs, type WfGraph } from './graph.js';

/*
 * 1.8.0, Sprint 47 (B-136): the built-in workflow templates and what a template needs.
 *
 * Each starter is a Workflows 2 graph made only of existing step kinds, publishable once its references are bound in
 * the workspace that uses it. The references are names a person maps to their own objects in the "use template"
 * dialog: profiles, registry tools, apps, decision tables and roles (bundles re-bind the first four, `bundles.ts`),
 * plus two kinds only templates re-bind, because a step names them inside a tool's arguments: saved connection
 * queries (`connections.query`) and knowledge bases (`knowledge_*` tools' `kbId`). Inserted by migration 094 and kept
 * current by `WorkflowTemplates.syncBuiltins` when a starter's `version` changes here.
 */

export interface TemplateNeeds {
  tools: string[];
  profiles: string[];
  apps: string[];
  decisions: string[];
  roles: string[];
  connections: string[];
  knowledge: string[];
  vault: string[];
}

export const NEED_KINDS = ['tools', 'profiles', 'apps', 'decisions', 'roles', 'connections', 'knowledge', 'vault'] as const;
export type NeedKind = (typeof NEED_KINDS)[number];

export interface BuiltinTemplate {
  id: string;
  name: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  icon: string;
  version: string;
  label: 'public' | 'internal' | 'confidential' | 'restricted';
  graph: WfGraph;
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].sort();
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const KB_TOOLS = /^knowledge_/;

/** A tool step's arguments as an object (a JSON template string is read as JSON when it is one). */
function argsOf(c: Record<string, unknown>): { obj: Record<string, unknown> | null; json: boolean } {
  const a = c.args;
  if (a && typeof a === 'object' && !Array.isArray(a)) return { obj: a as Record<string, unknown>, json: false };
  if (typeof a === 'string' && /^\s*\{/.test(a)) {
    try {
      const v = JSON.parse(a) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return { obj: v as Record<string, unknown>, json: true };
    } catch {
      /* a template that is not plain JSON: nothing to read */
    }
  }
  return { obj: null, json: false };
}

/** Every reference a graph makes, by kind, as the steps name them. */
export function templateNeeds(g: WfGraph): TemplateNeeds {
  const out: Record<NeedKind, string[]> = { tools: [], profiles: [], apps: [], decisions: [], roles: [], connections: [], knowledge: [], vault: graphVaultRefs(g) };
  for (const n of g.nodes) {
    const c = n.config as Record<string, unknown>;
    if (n.kind === 'tool') {
      const tool = str(c.tool).trim();
      out.tools.push(tool);
      const { obj } = argsOf(c);
      if (tool === 'connections.query' && obj) out.connections.push(str(obj.query) || str(obj.connection));
      if (KB_TOOLS.test(tool) && obj && typeof obj.kbId === 'string' && !obj.kbId.includes('{{')) out.knowledge.push(obj.kbId);
      if (c.approverRole) out.roles.push(str(c.approverRole));
    }
    if (n.kind === 'model') {
      out.profiles.push(str(c.profile));
      if (c.approverRole) out.roles.push(str(c.approverRole));
    }
    if ((n.kind === 'map' || n.kind === 'loop') && typeof c.profile === 'string') out.profiles.push(c.profile);
    if (n.kind === 'record') out.apps.push(str(c.app));
    if (n.kind === 'decision') out.decisions.push(str(c.table));
    if (n.kind === 'approval') {
      out.roles.push(str(c.role));
      const breach = c.onBreach as { role?: unknown } | undefined;
      if (breach && typeof breach.role === 'string') out.roles.push(breach.role);
      const form = c.form as { app?: unknown } | undefined;
      if (form && typeof form.app === 'string') out.apps.push(form.app);
    }
    if (n.kind === 'guardrail' && c.approverRole) out.roles.push(str(c.approverRole));
    if (n.kind === 'notify' && Array.isArray(c.roles)) out.roles.push(...c.roles.map(str));
  }
  return Object.fromEntries(NEED_KINDS.map((k) => [k, uniq(out[k])])) as unknown as TemplateNeeds;
}

/** The graph with roles, saved queries and knowledge bases renamed (bundles re-bind tools, profiles, apps, tables, vault). */
export function rebindExtras(g: WfGraph, b: { roles?: Record<string, string>; connections?: Record<string, string>; knowledge?: Record<string, string> }): WfGraph {
  const out = JSON.parse(JSON.stringify(g)) as WfGraph;
  const role = (r: unknown) => (typeof r === 'string' ? (b.roles?.[r] ?? r) : r);
  for (const n of out.nodes) {
    const c = n.config as Record<string, unknown>;
    if ((n.kind === 'tool' || n.kind === 'model' || n.kind === 'guardrail') && c.approverRole) c.approverRole = role(c.approverRole);
    if (n.kind === 'approval') {
      c.role = role(c.role);
      const ob = c.onBreach as Record<string, unknown> | undefined;
      if (ob && typeof ob === 'object' && typeof ob.role === 'string') ob.role = role(ob.role);
    }
    if (n.kind === 'notify' && Array.isArray(c.roles)) c.roles = c.roles.map(role);
    if (n.kind === 'tool') {
      const tool = str(c.tool).trim();
      const { obj, json } = argsOf(c);
      if (!obj) continue;
      let changed = false;
      if (tool === 'connections.query') {
        for (const k of ['query', 'connection']) {
          const v = str(obj[k]);
          if (v && b.connections?.[v]) {
            obj[k] = b.connections[v];
            changed = true;
          }
        }
      }
      if (KB_TOOLS.test(tool) && typeof obj.kbId === 'string' && b.knowledge?.[obj.kbId]) {
        obj.kbId = b.knowledge[obj.kbId];
        changed = true;
      }
      if (changed) c.args = json ? JSON.stringify(obj) : obj;
    }
  }
  return out;
}

// ---------- the starters ----------

const id = (key: string) => `TPL0${key.toUpperCase().replace(/[^A-Z0-9]/g, '0')}`.padEnd(26, '0').slice(0, 26);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const obj = (props: Record<string, 'string' | 'number' | 'object' | 'boolean'>, required = Object.keys(props)) => ({ type: 'object' as const, properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])), required });

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: id('leadfollowup'),
    name: 'lead-follow-up',
    title: 'Lead follow-up',
    summary: 'When a lead record is created, a decision table scores it; hot leads go to the team at once with a reminder two days later, the rest wait for the weekly review.',
    category: 'Sales',
    tags: ['crm', 'leads', 'decision table', 'reminder'],
    icon: 'messages',
    version: '1.0.0',
    label: 'internal',
    graph: {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger: record', x: 20, y: 24, config: { source: 'record' }, output: { type: 'object', properties: { event: { type: 'string' }, app: { type: 'string' }, entity: { type: 'string' }, record: { type: 'object' } }, required: ['record'] } },
        { id: 'score', kind: 'decision', title: 'Score the lead', x: 260, y: 24, config: { table: 'lead-routing', inputs: { source: '{{input.record.values.source}}', size: '{{input.record.values.size}}' }, outputs: { priority: 'priority' } } },
        { id: 'hot', kind: 'branch', title: 'Hot lead?', x: 500, y: 24, config: { left: '{{steps.score.priority}}', op: 'eq', right: 'hot' } },
        { id: 'tell', kind: 'notify', title: 'Tell the sales team', x: 740, y: 24, config: { roles: ['member'], users: [], title: 'Hot lead: {{input.record.values.name}}', body: 'Scored {{steps.score.priority}}. Follow up today.', email: true } },
        { id: 'pause', kind: 'wait', title: 'Wait two days', x: 980, y: 24, config: { ms: 2 * DAY } },
        { id: 'remind', kind: 'notify', title: 'Remind the team', x: 1220, y: 24, config: { roles: ['member'], users: [], title: 'Reminder: follow up {{input.record.values.name}}', body: 'Two days ago this lead was scored hot. Record what happened on the record.', email: false } },
        { id: 'later', kind: 'notify', title: 'Queue for the weekly review', x: 740, y: 164, config: { roles: ['member'], users: [], title: 'New lead for the weekly review: {{input.record.values.name}}', body: 'Scored {{steps.score.priority}}.', email: false } }
      ],
      edges: [
        { from: 'trigger', to: 'score' },
        { from: 'score', to: 'hot' },
        { from: 'hot', to: 'tell', branch: 'true' },
        { from: 'tell', to: 'pause' },
        { from: 'pause', to: 'remind' },
        { from: 'hot', to: 'later', branch: 'false' }
      ],
      limits: {}
    }
  },
  {
    id: id('invoiceapproval'),
    name: 'invoice-approval',
    title: 'Invoice approval by amount',
    summary: 'Routes an invoice by its amount: small ones to one approver, mid-sized ones to two of the finance approvers, large ones to two of the leadership, each with a deadline, reminders and escalation; the requester hears the outcome.',
    category: 'Finance',
    tags: ['approvals', 'quorum', 'deadline', 'switch'],
    icon: 'calc',
    version: '1.0.0',
    label: 'internal',
    graph: {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger: api', x: 20, y: 164, config: { source: 'api' }, output: obj({ invoice: 'string', vendor: 'string', amount: 'number', requester: 'string' }) },
        { id: 'route', kind: 'switch', title: 'Route by amount', x: 260, y: 164, config: { value: '{{input.amount}}', cases: [{ label: 'small', match: 'range', max: 1000 }, { label: 'medium', match: 'range', min: 1000, max: 10000 }] } },
        { id: 'one', kind: 'approval', title: 'One approver', x: 500, y: 24, config: { role: 'workflow-admin', timeoutMs: 3 * DAY, show: 'Invoice {{input.invoice}} from {{input.vendor}}: {{input.amount}}', due: { afterMs: DAY }, reminders: [4 * HOUR], onBreach: { action: 'escalate', role: 'tenant-admin' } } },
        { id: 'finance', kind: 'approval', title: 'Two finance approvers', x: 500, y: 164, config: { role: 'workflow-admin', timeoutMs: 5 * DAY, show: 'Invoice {{input.invoice}} from {{input.vendor}}: {{input.amount}}', due: { afterMs: 2 * DAY }, reminders: [DAY], onBreach: { action: 'escalate', role: 'tenant-admin' }, quorum: { mode: 'count', count: 2, rejects: 'final' } } },
        { id: 'leaders', kind: 'approval', title: 'Two of the leadership', x: 500, y: 304, config: { role: 'tenant-admin', timeoutMs: 7 * DAY, show: 'Large invoice {{input.invoice}} from {{input.vendor}}: {{input.amount}}', due: { afterMs: 3 * DAY }, reminders: [DAY, 2 * DAY], onBreach: { action: 'notify' }, quorum: { mode: 'count', count: 2, rejects: 'final' } } },
        { id: 'tell', kind: 'notify', title: 'Tell the requester', x: 740, y: 164, config: { users: ['{{input.requester}}'], roles: [], title: 'Invoice {{input.invoice}} approved', body: 'Approved for payment: {{input.vendor}}, {{input.amount}}.', email: true } }
      ],
      edges: [
        { from: 'trigger', to: 'route' },
        { from: 'route', to: 'one', case: 'small' },
        { from: 'route', to: 'finance', case: 'medium' },
        { from: 'route', to: 'leaders', case: 'default' },
        { from: 'one', to: 'tell' },
        { from: 'finance', to: 'tell' },
        { from: 'leaders', to: 'tell' }
      ],
      limits: {}
    }
  },
  {
    id: id('weeklyreport'),
    name: 'weekly-report',
    title: 'Weekly report',
    summary: "Every Monday at 08:00 reads the week's figures from a saved connection query, has a model summarise them and sends the summary to the team.",
    category: 'Reporting',
    tags: ['schedule', 'summary', 'connections', 'model'],
    icon: 'clock',
    version: '1.0.0',
    label: 'internal',
    graph: {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger: schedule', x: 20, y: 24, config: { source: 'schedule', cron: '0 8 * * 1' } },
        { id: 'figures', kind: 'tool', title: "Read the week's figures", x: 260, y: 24, config: { tool: 'connections.query', args: { query: 'weekly-figures', limit: '200' }, approverRole: 'workflow-admin', approvalTimeoutMs: DAY } },
        { id: 'summary', kind: 'model', title: 'Summarise', x: 500, y: 24, config: { profile: 'report-writer', prompt: "Summarise this week's figures for the team in at most six short bullet points, with the biggest change first. Figures (JSON rows): {{steps.figures.rows}}", format: 'text' } },
        { id: 'send', kind: 'notify', title: 'Send to the team', x: 740, y: 24, config: { roles: ['member'], users: [], title: 'Weekly report', body: '{{steps.summary.text}}', email: true } }
      ],
      edges: [
        { from: 'trigger', to: 'figures' },
        { from: 'figures', to: 'summary' },
        { from: 'summary', to: 'send' }
      ],
      limits: {}
    }
  },
  {
    id: id('onboarding'),
    name: 'new-starter-onboarding',
    title: 'New starter onboarding',
    summary: "Creates the new starter's set-up tasks in an app, asks their manager to approve the equipment, then creates the equipment task and welcomes the starter.",
    category: 'People',
    tags: ['onboarding', 'tasks', 'approvals'],
    icon: 'roles',
    version: '1.0.0',
    label: 'internal',
    graph: {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger: api', x: 20, y: 94, config: { source: 'api' }, output: obj({ name: 'string', username: 'string', startDate: 'string', equipment: 'string' }) },
        { id: 'accounts', kind: 'record', title: 'Task: set up accounts', x: 260, y: 24, config: { action: 'create', app: 'onboarding', entity: 'task', values: { title: 'Set up accounts for {{input.name}}', due: '{{input.startDate}}' } } },
        { id: 'tellit', kind: 'notify', title: 'Tell IT', x: 260, y: 164, config: { roles: ['tenant-admin'], users: [], title: '{{input.name}} starts on {{input.startDate}}', body: 'Accounts and equipment: {{input.equipment}}.', email: true } },
        { id: 'approve', kind: 'approval', title: 'Manager approves equipment', x: 500, y: 24, config: { role: 'workflow-admin', timeoutMs: 3 * DAY, show: 'Equipment for {{input.name}}: {{input.equipment}}', due: { afterMs: DAY }, reminders: [4 * HOUR] } },
        { id: 'equipment', kind: 'record', title: 'Task: order equipment', x: 740, y: 24, config: { action: 'create', app: 'onboarding', entity: 'task', values: { title: 'Order {{input.equipment}} for {{input.name}}', due: '{{input.startDate}}' } } },
        { id: 'welcome', kind: 'notify', title: 'Welcome the starter', x: 980, y: 24, config: { users: ['{{input.username}}'], roles: [], title: 'Welcome, {{input.name}}', body: 'Your accounts and equipment are being set up for {{input.startDate}}.', email: true } }
      ],
      edges: [
        { from: 'trigger', to: 'accounts' },
        { from: 'trigger', to: 'tellit' },
        { from: 'accounts', to: 'approve' },
        { from: 'approve', to: 'equipment' },
        { from: 'equipment', to: 'welcome' }
      ],
      limits: {}
    }
  },
  {
    id: id('webhookrecord'),
    name: 'webhook-to-record',
    title: 'Inbound webhook to a record',
    summary: 'A signed POST from another system (a web form, a shop) becomes a record in an app, and the team is told. The webhook arrives switched off: make its secret and turn it on after publishing.',
    category: 'Integration',
    tags: ['webhook', 'records', 'crm'],
    icon: 'link',
    version: '1.0.0',
    label: 'internal',
    graph: {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger: webhook', x: 20, y: 24, config: { source: 'webhook' }, output: obj({ name: 'string', email: 'string', message: 'string' }, ['name', 'email']) },
        { id: 'shape', kind: 'transform', title: 'Shape the record', x: 260, y: 24, config: { fields: { name: '{{input.name}}', email: '{{input.email}}', note: '{{input.message}}' } } },
        { id: 'save', kind: 'record', title: 'Create the contact', x: 500, y: 24, config: { action: 'create', app: 'crm', entity: 'contact', values: { name: '{{steps.shape.name}}', email: '{{steps.shape.email}}', note: '{{steps.shape.note}}' } } },
        { id: 'tell', kind: 'notify', title: 'Tell the team', x: 740, y: 24, config: { roles: ['member'], users: [], title: 'New contact: {{input.name}}', body: '{{input.email}} wrote: {{input.message}}', email: false } }
      ],
      edges: [
        { from: 'trigger', to: 'shape' },
        { from: 'shape', to: 'save' },
        { from: 'save', to: 'tell' }
      ],
      limits: {}
    }
  },
  {
    id: id('documentintake'),
    name: 'document-intake',
    title: 'Document intake',
    summary: 'When a file is uploaded, reads it, asks a curator to approve adding it, files it in a knowledge base and tells the team.',
    category: 'Knowledge',
    tags: ['files', 'knowledge', 'approvals', 'event'],
    icon: 'files',
    version: '1.0.0',
    label: 'internal',
    graph: {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger: event', x: 20, y: 24, config: { source: 'event', event: 'file.uploaded' } },
        { id: 'read', kind: 'tool', title: 'Read the file', x: 260, y: 24, config: { tool: 'files.read', args: { fileId: '{{input.event.data.file}}', maxChars: '4000' }, approverRole: 'workflow-admin', approvalTimeoutMs: DAY } },
        { id: 'approve', kind: 'approval', title: 'Curator approves', x: 500, y: 24, config: { role: 'knowledge-curator', timeoutMs: 3 * DAY, show: '{{steps.read.title}}: {{steps.read.content}}', due: { afterMs: DAY } } },
        { id: 'file', kind: 'tool', title: 'Add to knowledge', x: 740, y: 24, config: { tool: 'knowledge_add', args: '{"kbId":"intake","fileId":"{{input.event.data.file}}","categories":["inbox"]}', approverRole: 'knowledge-curator', approvalTimeoutMs: DAY } },
        { id: 'tell', kind: 'notify', title: 'Tell the team', x: 980, y: 24, config: { roles: ['member'], users: [], title: 'Added to knowledge: {{steps.read.title}}', body: 'Filed under inbox.', email: false } }
      ],
      edges: [
        { from: 'trigger', to: 'read' },
        { from: 'read', to: 'approve' },
        { from: 'approve', to: 'file' },
        { from: 'file', to: 'tell' }
      ],
      limits: {}
    }
  }
];
