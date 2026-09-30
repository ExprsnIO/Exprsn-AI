import { schemaProblems } from './schema.js';

/** One automated check's outcome, as the Registry screen lists them. */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Patterns for credentials that must never sit in an entry, a schema, instructions or a script. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['a private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY( BLOCK)?-----/],
  ['an AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['an API secret key', /\bsk-(?:live-|proj-|ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['an Exprsn-AI API key', /\bexai_k1_[A-Za-z0-9_-]{16,}/],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['a password or secret assigned in the text', /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/i]
];

/** Findings of the secrets scan over some text: what was found and on which line. */
export function scanSecrets(text: string): { what: string; line: number }[] {
  const out: { what: string; line: number }[] = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    for (const [what, re] of SECRET_PATTERNS) if (re.test(l)) out.push({ what, line: i + 1 });
  });
  return out;
}

const PLACEHOLDER = /\b(todo|tbd|fixme|lorem ipsum|placeholder|description here)\b/i;
const WRITE_WORDS = /(^|[._-])(create|update|set|send|post|put|write|add|insert|upload|move|rename|assign|transition|approve|merge|publish|submit)([._-]|$)/i;
const DESTRUCTIVE_WORDS = /(^|[._-])(delete|remove|drop|purge|destroy|truncate|wipe|erase|revoke|kill)([._-]|$)/i;

/** A description a model and a reviewer can act on: long enough, in words, not the name, no placeholders. */
export function descriptionProblem(name: string, description: string | null | undefined): string | null {
  const d = (description ?? '').trim();
  if (!d) return 'No description. Say what it does, when to use it and what it returns.';
  if (d.length < 40 || d.split(/\s+/).length < 6) return 'The description is too short to tell a model when to use it (at least 40 characters, six words).';
  if (d.toLowerCase() === name.toLowerCase()) return 'The description only repeats the name.';
  if (PLACEHOLDER.test(d)) return 'The description still has placeholder text.';
  return null;
}

/** The side-effect class a tool name suggests, used to catch an under-declared class. */
export function suggestedSideEffect(name: string): 'destructive' | 'write' | null {
  const last = name.split(/[.:/]/).pop() ?? name;
  if (DESTRUCTIVE_WORDS.test(last)) return 'destructive';
  if (WRITE_WORDS.test(last)) return 'write';
  return null;
}

const rank = { read: 0, write: 1, destructive: 2 } as const;

export interface CheckInput {
  kind: 'tool' | 'skill' | 'agent';
  name: string;
  version: string;
  description: string | null;
  sideEffect: 'read' | 'write' | 'destructive' | null;
  inputSchema: unknown;
  outputSchema: unknown;
  definition: Record<string, unknown>;
  /** Tools the entry references (agents and skills), with their status in the registry. */
  references?: { name: string; status: string | null }[];
  /** Limits that apply in the workspace (agents). */
  maxBudgets?: { steps: number; tokens: number; wallSeconds: number };
}

/**
 * The automated checks run on submission (and on demand): schema validity, required fields, description quality,
 * a declared side-effect class consistent with the name, a secrets scan over everything submitted, and for agents
 * and skills that every referenced tool is published and the limits are within policy.
 */
export function runChecks(e: CheckInput): CheckResult[] {
  const out: CheckResult[] = [];
  const missing: string[] = [];
  if (!e.name) missing.push('name');
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(e.version)) missing.push('a semantic version');
  if (e.kind === 'tool' && e.inputSchema == null) missing.push('an input schema');
  if (e.kind === 'agent') {
    if (!e.definition.profile) missing.push('a model profile');
    if (!e.definition.budgets) missing.push('budgets');
  }
  if (e.kind === 'skill' && !String(e.definition.instructions ?? '').trim()) missing.push('instructions');
  out.push({ name: 'Required fields', ok: !missing.length, detail: missing.length ? `Missing ${missing.join(', ')}.` : 'Name, version and the fields for its kind are present.' });

  if (e.kind === 'tool') {
    const problems = [...schemaProblems(e.inputSchema, 'input'), ...(e.outputSchema == null ? [] : schemaProblems(e.outputSchema, 'output'))];
    out.push({ name: 'Schema valid', ok: !problems.length, detail: problems.length ? problems.slice(0, 5).join(' ') : `Input${e.outputSchema == null ? '' : ' and output'} schema compile as JSON Schema.` });
  }

  const dp = descriptionProblem(e.name, e.description);
  out.push({ name: 'Description quality', ok: !dp, detail: dp ?? 'Specific enough for a model to choose the tool and for a reviewer to judge it.' });

  if (e.kind === 'tool') {
    const suggested = suggestedSideEffect(e.name);
    const declared = e.sideEffect;
    const ok = !!declared && (!suggested || rank[declared] >= rank[suggested]);
    out.push({
      name: 'Side effect declared',
      ok,
      detail: !declared ? 'Declare the side-effect class: read, write or destructive.' : ok ? `Declared ${declared}.` : `Declared ${declared}, but the name suggests ${suggested}. Declare ${suggested} or rename the operation.`
    });
  }

  const everything = [e.name, e.description ?? '', JSON.stringify(e.inputSchema ?? null, null, 1), JSON.stringify(e.outputSchema ?? null, null, 1), JSON.stringify(e.definition, null, 1)].join('\n');
  const secrets = scanSecrets(everything);
  out.push({ name: 'Secrets scan', ok: !secrets.length, detail: secrets.length ? `Found ${[...new Set(secrets.map((x) => x.what))].join(', ')}. Use a secret reference, never a value.` : 'No credentials found.' });

  if (e.references) {
    const bad = e.references.filter((r) => r.status !== 'published' && r.status !== 'deprecated');
    out.push({ name: 'Referenced tools published', ok: !bad.length, detail: bad.length ? bad.map((r) => `${r.name} is ${r.status ? r.status.replace('_', ' ') : 'not in the registry'}`).join('; ') + '. Publish them first or remove them.' : e.references.length ? 'Every referenced tool is published.' : 'No tools referenced.' });
  }
  if (e.kind === 'agent' && e.maxBudgets) {
    const b = (e.definition.budgets ?? {}) as { steps?: number; tokens?: number; wallSeconds?: number };
    const over = (['steps', 'tokens', 'wallSeconds'] as const).filter((k) => typeof b[k] !== 'number' || b[k]! > e.maxBudgets![k]);
    out.push({ name: 'Limits within workspace policy', ok: !over.length, detail: over.length ? `Over the policy for ${over.join(', ')} (at most ${e.maxBudgets.steps} steps, ${e.maxBudgets.tokens} tokens, ${e.maxBudgets.wallSeconds} s).` : 'Steps, tokens and wall time are within policy.' });
  }
  return out;
}
