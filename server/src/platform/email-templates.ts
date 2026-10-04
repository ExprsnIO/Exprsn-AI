/**
 * Email templates: a plain-text and a minimal HTML body for each message the server sends. Values are substituted
 * into `{{name}}` placeholders and every substitution is escaped for its context: HTML-escaped in the HTML body,
 * control characters removed in the text body, and folded to one line in the subject (no header injection). There is
 * no way to insert a raw value, so a template cannot be made to carry markup from its data. SMTP stays the transport.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Vars = Record<string, string | number | null | undefined>;

interface Template {
  subject: string;
  /** Paragraphs; a paragraph that is exactly `{{link}}` renders as a link in HTML and on its own line in text. */
  body: string[];
  /** Placeholders that must be present (a missing value is an error, never an empty string in a sentence). */
  required: string[];
}

const TEMPLATES = {
  'password-reset': {
    subject: 'Reset your {{product}} password',
    body: [
      'Hello {{name}},',
      'Someone asked to reset the password for the account {{username}} on {{product}}. If it was you, open this link within {{minutes}} minutes and choose a new password:',
      '{{link}}',
      'The link works once. If you did not ask for this, ignore this message: your password has not changed. Resetting the password signs out every session of the account.'
    ],
    required: ['name', 'username', 'product', 'minutes', 'link']
  },
  'password-set': {
    subject: 'Set a new password for {{product}}',
    body: [
      'Hello {{name}},',
      'An administrator ({{actor}}) reset the password for your account {{username}} on {{product}}. Open this link within {{minutes}} minutes and choose a new password:',
      '{{link}}',
      'The link works once. Your previous password no longer works.'
    ],
    required: ['name', 'username', 'product', 'minutes', 'link', 'actor']
  },
  invite: {
    subject: 'You have an account on {{product}}',
    body: [
      'Hello {{name}},',
      '{{actor}} created the account {{username}} for you on {{product}} ({{tenant}}). Open this link within {{hours}} hours and choose your password:',
      '{{link}}',
      'The link works once. If you were not expecting this, ignore this message.'
    ],
    required: ['name', 'username', 'product', 'hours', 'link', 'actor', 'tenant']
  },
  'security-alert': {
    subject: '{{product}} security notice: {{event}}',
    body: [
      'Hello {{name}},',
      '{{event}} on your account {{username}} at {{time}}{{from}}.',
      '{{detail}}',
      'If this was you, there is nothing to do. If it was not, change your password, review your sessions, API keys and second factors in Settings, and tell an identity admin.',
      '{{link}}'
    ],
    required: ['name', 'username', 'product', 'event', 'time', 'link']
  },
  notification: {
    subject: '{{title}}',
    body: ['{{title}}', 'Open the console:', '{{link}}'],
    required: ['title', 'link']
  },
  // Sprint 26a (B-1802): email verification, in the same shape as the reset link.
  'verify-email': {
    subject: 'Confirm your email address for {{product}}',
    body: [
      'Hello {{name}},',
      'Confirm that {{email}} is the address of the account {{username}} on {{product}} ({{tenant}}). Open this link within {{hours}} hours:',
      '{{link}}',
      'The link works once. If you did not sign up, ignore this message: the account stays unconfirmed.'
    ],
    required: ['name', 'username', 'product', 'email', 'tenant', 'hours', 'link']
  },
  // Sprint 26a (B-1801): an invitation by a workspace admin, with roles; the invitee chooses the username and password.
  'workspace-invite': {
    subject: '{{actor}} invited you to {{product}}',
    body: [
      'Hello,',
      '{{actor}} invited {{email}} to {{tenant}} on {{product}}{{workspace}}. Open this link within {{days}} days to accept: you choose your username and password there, or accept as the account you already have.',
      '{{link}}',
      'The link works once. If you were not expecting this, ignore this message.'
    ],
    required: ['product', 'actor', 'email', 'tenant', 'days', 'link']
  }
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;' };

export const escapeHtml = (v: string): string => v.replace(/[&<>"'`=]/g, (c) => HTML_ESCAPES[c]!);

/** Removes control characters except newline and tab (text bodies). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const cleanText = (v: string): string => v.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '');

/** One line, no control characters (subjects and other header values). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const headerSafe = (v: string): string => v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/** Only http(s) links are rendered as links. */
const safeLink = (v: string): string => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
};

function fill(template: string, vars: Vars, esc: (v: string) => string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => esc(String(vars[name] ?? '')));
}

export function renderEmail(name: TemplateName, vars: Vars): RenderedEmail {
  const t: Template = TEMPLATES[name];
  for (const k of t.required) if (vars[k] == null || vars[k] === '') throw new Error(`Email template ${name} needs ${k}`);
  const link = vars.link == null ? '' : safeLink(String(vars.link));
  const all = { ...vars, link };
  const subject = headerSafe(fill(t.subject, all, headerSafe));
  const paragraphs = t.body.map((p) => (p === '{{link}}' ? { link: true, p } : { link: false, p })).filter((x) => x.link ? !!link : fill(x.p, all, (v) => v).trim() !== '');
  const text = paragraphs.map((x) => (x.link ? link : fill(x.p, all, cleanText))).join('\n\n') + '\n';
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(subject) + '</title></head><body>' +
    paragraphs.map((x) => (x.link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : `<p>${fill(x.p, all, escapeHtml)}</p>`)).join('') +
    '</body></html>';
  return { subject, text, html };
}
