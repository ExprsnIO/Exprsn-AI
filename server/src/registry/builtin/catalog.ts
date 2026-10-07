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
  },
  {
    // Sprint 36c (B-8803), seeded by migration 038c: the knowledge step of agents and workflows.
    id: id26('knowledgesearch'),
    name: 'knowledge_search',
    builtin: 'knowledge_search',
    description: 'Searches published knowledge bases the caller may read, at most at the label of the conversation or run it is called from. Takes label filters for image documents (labels.any, labels.all, labels.minScore); an image hit carries its caption, an excerpt of its text, its labels with their scores and a thumbnail URL.',
    sideEffect: 'read',
    label: 'restricted',
    inputSchema: {
      type: 'object',
      properties: {
        kbIds: { type: 'array', items: ULID, minItems: 1, maxItems: 20, description: 'The knowledge bases to search' },
        query: str('What to look for', 2000),
        k: { type: 'integer', minimum: 1, maximum: 20, description: 'How many hits (8 when left out)' },
        labels: {
          type: 'object',
          description: 'Image labels a hit must carry',
          properties: {
            any: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 20, description: 'At least one of these labels' },
            all: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 20, description: 'Every one of these labels' },
            minScore: { type: 'number', minimum: 0, maximum: 1, description: "The lowest score that counts (each classifier's own threshold when left out)" }
          },
          additionalProperties: false
        }
      },
      required: ['kbIds', 'query'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { hits: { type: 'array', items: { type: 'object' } }, ceiling: { type: 'string' } }, required: ['hits'] }
  },
  // Sprint 37b (B-7101), seeded by migration 039b: the records of low-code apps, as NocoDB's MCP server offers its
  // tables (list, query, count, aggregate, create, update, delete). Each acts as the caller through the apps service.
  ...recordTools()
];

export const BUILTIN_NAMES = BUILTIN_TOOLS.map((t) => t.name);

function recordTools(): BuiltinSpec[] {
  const ref = (what: string) => ({ type: 'string', minLength: 1, maxLength: 63, description: what });
  const where = { app: ref('The app, by name or id'), entity: ref('The entity (table), by name or id') };
  const filter = { type: 'object', description: 'A filter: {field, op, value}, or {and: [...]}, {or: [...]}, {not: {...}}; op is eq, ne, gt, gte, lt, lte, in, contains, startsWith or exists' };
  const q = str('Full-text search over the searchable fields', 200);
  const values = { type: 'object', description: 'Field values by field name', maxProperties: 200 };
  const record = { type: 'object', properties: { id: { type: 'string' }, values: { type: 'object' }, label: { type: 'string' }, version: { type: 'integer' } }, required: ['id'] };
  const spec = (key: string, description: string, sideEffect: BuiltinSpec['sideEffect'], properties: Record<string, unknown>, required: string[], outputSchema: Record<string, unknown>): BuiltinSpec => ({
    id: id26(`records${key}`),
    name: `records.${key}`,
    builtin: `records.${key}`,
    description,
    sideEffect,
    label: 'restricted',
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema
  });
  return [
    spec('entities', 'Lists the apps the caller can see, with each entity (table), its fields and their types, and its states.', 'read', { app: ref('Only this app') }, [], { type: 'object', properties: { apps: { type: 'array', items: { type: 'object' } } }, required: ['apps'] }),
    spec('query', 'Reads records of an entity the caller may read, at most at the label of the call: filter, sort, search and a page (with a cursor for the next one).', 'read', { ...where, filter, sort: { type: 'array', maxItems: 3, items: { type: 'object', properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['field'] } }, q, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: str('The cursor of the next page', 16_000) }, ['app', 'entity'], { type: 'object', properties: { total: { type: ['integer', 'null'] }, nextCursor: { type: ['string', 'null'] }, records: { type: 'array', items: record } }, required: ['records'] }),
    spec('count', 'Counts the records of an entity that match a filter or search, at most at the label of the call.', 'read', { ...where, filter, q }, ['app', 'entity'], { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }),
    spec('aggregate', 'Groups and summarises records: count, sum, avg, min and max, optionally grouped by a field or the state.', 'read', { ...where, filter, q, groupBy: ref('A field, or state'), metrics: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { op: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] }, field: { type: 'string' } }, required: ['op'] } } }, ['app', 'entity', 'metrics'], { type: 'object', properties: { groups: { type: 'array', items: { type: 'object' } } } }),
    spec('create', 'Creates a record as the caller, at the label of the call or the entity, whichever is higher. Values are validated against the entity.', 'write', { ...where, values }, ['app', 'entity', 'values'], record),
    spec('update', 'Changes fields of a record the caller may read and write; give version to refuse a change made since it was read.', 'write', { ...where, id: { ...ULID, description: 'The record' }, values, version: { type: 'integer', minimum: 1 } }, ['app', 'entity', 'id', 'values'], record),
    spec('delete', 'Deletes a record the caller may read and write.', 'destructive', { ...where, id: { ...ULID, description: 'The record' } }, ['app', 'entity', 'id'], { type: 'object', properties: { deleted: { type: 'string' } }, required: ['deleted'] })
  ];
}
