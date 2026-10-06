/*
 * B-3904 (1.5.0, Sprint 32c): the domain steps as built-in registry tools (`impl: builtin`). They are platform entries
 * (no tenant, published to every tenant, like `calculate`), seeded by migration 034c from this list, and run by
 * `BuiltinTools` through the one dispatcher, so chat, agent runs and workflow tool steps call them the same way:
 * arguments checked against the input schema, the tool's ceiling, the `tool-call` checkpoint, approval for writes.
 * Each one acts as the caller through the domain service's own rules (membership, rights, clearance, label
 * ceilings, guardrails, audit), never around them.
 *
 * Pure data: the migration imports it, so nothing here may import a service.
 */

export interface BuiltinSpec {
  id: string;
  name: string;
  /** `definition.builtin`: the implementation key. */
  builtin: string;
  description: string;
  sideEffect: 'read' | 'write' | 'destructive';
  label: 'public' | 'internal' | 'confidential' | 'restricted';
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

const id26 = (key: string): string => `BUILTIN0${key.toUpperCase().replace(/[^A-Z0-9]/g, '0')}`.padEnd(26, '0').slice(0, 26);
const str = (description: string, maxLength = 200) => ({ type: 'string', description, maxLength });
const ULID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' };

export const BUILTIN_TOOLS: BuiltinSpec[] = [
  {
    id: id26('messagessend'),
    name: 'messages.send',
    builtin: 'messages.send',
    description: 'Sends a message as the caller: into a conversation they belong to, or to one person directly (opening the direct conversation when there is none). Guardrails screen the text; members are notified by their own rules.',
    sideEffect: 'write',
    label: 'restricted',
    inputSchema: {
      type: 'object',
      properties: { conversation: { ...ULID, description: 'A conversation the caller may write in' }, user: { ...ULID, description: 'Or a person to message directly' }, body: str('The message text', 10_000), thread: { ...ULID, description: 'Reply in the thread of this message' } },
      required: ['body'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { conversation: { type: 'string' }, message: { type: 'string' }, label: { type: 'string' } }, required: ['conversation', 'message'] }
  },
  {
    id: id26('feedpost'),
    name: 'feed.post',
    builtin: 'feed.post',
    description: "Posts to a workspace feed (or a group's) as the caller, at the label of the data it is called with. The post records what made it (a workflow run, an agent run, a conversation) as its source.",
    sideEffect: 'write',
    label: 'restricted',
    inputSchema: {
      type: 'object',
      properties: { workspace: { ...ULID, description: "The workspace; the caller's current workspace when left out" }, group: { ...ULID, description: 'Post in this group instead' }, body: str('The post text', 5000) },
      required: ['body'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { post: { type: 'string' }, state: { type: 'string' }, label: { type: 'string' }, workspace: { type: 'string' } }, required: ['post', 'state'] }
  },
  {
    id: id26('fileswriteversion'),
    name: 'files.write_version',
    builtin: 'files.write_version',
    description: 'Writes a new version of a file the caller may change. The content goes through quarantine and the scan like any upload.',
    sideEffect: 'write',
    label: 'restricted',
    inputSchema: {
      type: 'object',
      properties: { file: { ...ULID, description: 'The file' }, content: { type: 'string', maxLength: 1_400_000, description: 'The new content (UTF-8 text, or base64 with encoding base64), up to 1 MB' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, type: str('The media type, such as text/markdown', 100) },
      required: ['file', 'content'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { file: { type: 'string' }, version: { type: 'integer' }, state: { type: 'string' }, size: { type: 'integer' } }, required: ['file', 'version', 'state'] }
  },
  {
    id: id26('groupscreateevent'),
    name: 'groups.create_event',
    builtin: 'groups.create_event',
    description: 'Creates an event in a group where the caller may create events, with its time zone and reminders.',
    sideEffect: 'write',
    label: 'restricted',
    inputSchema: {
      type: 'object',
      properties: {
        group: { ...ULID, description: 'The group' },
        title: str('The title'),
        start: str('Local start, such as 2026-11-03T10:00', 40),
        end: str('Local end (or give durationMinutes)', 40),
        durationMinutes: { type: 'integer', minimum: 5, maximum: 44_640 },
        timeZone: str('An IANA time zone, such as Europe/Berlin', 64),
        description: str('What it is about', 5000),
        location: str('Where', 500),
        reminders: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 40_320 }, maxItems: 5 }
      },
      required: ['group', 'title', 'start', 'timeZone'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { event: { type: 'string' }, group: { type: 'string' }, startsAt: { type: 'string' }, label: { type: 'string' } }, required: ['event', 'group'] }
  },
  {
    id: id26('channelsanswer'),
    name: 'channels.answer',
    builtin: 'channels.answer',
    description: 'Answers a customer in an open channel session as the caller (a reviewer of the channel); the answer is delivered at once, by email for email sessions.',
    sideEffect: 'write',
    label: 'restricted',
    inputSchema: {
      type: 'object',
      properties: { channel: { ...ULID, description: 'The channel' }, session: { ...ULID, description: 'The session' }, text: str('The answer', 8000) },
      required: ['channel', 'session', 'text'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { message: { type: 'string' }, seq: { type: 'integer' } }, required: ['message'] }
  }
];

export const BUILTIN_NAMES = BUILTIN_TOOLS.map((t) => t.name);
