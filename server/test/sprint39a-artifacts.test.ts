/*
 * 1.6.0, Sprint 39a (B-8001): versioned artifacts. Fenced blocks in finished answers become artifacts named from the
 * fence; a later turn that changes one adds a version and the earlier version stays readable; the same content adds
 * none. Share readers and link readers get the artifacts of the shown messages with sandboxed render links; the
 * public render route serves one version under its own CSP and refuses a wrong or stale token; an artifact above
 * the reader's clearance is not listed.
 */
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractArtifacts } from '../src/chat/artifacts.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

const PAGE = (greeting: string) => `<!doctype html>\n<html><body><h1>${greeting}</h1><script>document.title = '${greeting}';</script></body></html>`;
const SCRIPT = `export function add(a, b) {\n  return a + b;\n}\nexport function sub(a, b) {\n  return a - b;\n}\n`;

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('B-8001: fenced blocks become artifacts', () => {
  it('names them from the fence, numbers unnamed ones per language, skips short blocks and classifies kinds', () => {
    const text = [
      'Here is the page:',
      '```html index.html',
      PAGE('Hello'),
      '```',
      'and a helper:',
      '```js',
      SCRIPT,
      '```',
      'a note:',
      '~~~markdown title="notes.md"',
      '# Notes\n\nSome notes that are long enough to count as a document artifact for the test.',
      '~~~',
      '```sh',
      'ls',
      '```',
      '```js',
      SCRIPT + '// second unnamed script block\n',
      '```'
    ].join('\n');
    const found = extractArtifacts(text, 20, 100_000);
    expect(found.map((a) => [a.key, a.kind, a.language, a.title])).toEqual([
      ['index.html', 'html', 'html', 'index.html'],
      ['js-1', 'code', 'js', 'js block 1'],
      ['notes.md', 'document', 'markdown', 'notes.md'],
      ['js-2', 'code', 'js', 'js block 2']
    ]);
    expect(found[0]!.content).toBe(PAGE('Hello'));
    expect(extractArtifacts(text, 20, 10)).toEqual([]); // every block is over the byte cap
    expect(extractArtifacts('no fences here', 1, 1000)).toEqual([]);
  });
});

describe('B-8001: artifacts across turns, shares and the sandboxed render', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000', CHAT_ARTIFACT_MIN_CHARS: '20' });
    await seedGateway(h, ollama, { label: 'internal' });
    ollama.reply = (messages) => {
      const ask = String(messages.at(-1)?.content ?? '');
      const greeting = /goodbye/i.test(ask) ? 'Goodbye' : 'Hello';
      return { content: `Here you go.\n\n\`\`\`html index.html\n${PAGE(greeting)}\n\`\`\`\n\nAnd the helper:\n\n\`\`\`js\n${SCRIPT}\`\`\`\n\n\`\`\`sh\nls\n\`\`\`` };
    };
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function user(name: string, clearance: 'public' | 'internal' | 'confidential' = 'internal') {
    const u = await localUser(h, name, ['member'], clearance);
    const c = await login(h, name);
    await h.s.db('users').where({ id: u.id }).update({ clearance });
    return { ...u, ...c, post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b) };
  }

  async function converse(o: Awaited<ReturnType<typeof user>>, text: string, conversationId?: string) {
    const sent = conversationId ? await o.post(`/api/conversations/${conversationId}/messages`, { content: text, profile: 'general' }).expect(202) : await o.post('/api/chat', { content: text, profile: 'general' }).expect(202);
    await until(async () => (await h.s.db('messages').where({ id: sent.body.messageId }).first()).completed_at != null);
    // Extraction runs after the answer's listeners fire; wait for the versions to land.
    await until(async () => Number((await h.s.db('chat_artifact_versions').where({ message_id: sent.body.messageId }).count({ n: '*' }).first())?.n ?? 0) > 0, 3000).catch(() => undefined);
    return { conversationId: (conversationId ?? sent.body.conversationId) as string, messageId: sent.body.messageId as string };
  }

  it('versions an artifact a later turn changes, keeps the earlier version, and adds nothing for the same content', async () => {
    const owner = await user('owner');
    const first = await converse(owner, 'Make me a page that says Hello');
    let list = (await owner.agent.get(`/api/conversations/${first.conversationId}/artifacts`).expect(200)).body.artifacts;
    expect(list.map((a: { key: string; kind: string; versions: unknown[] }) => [a.key, a.kind, a.versions.length])).toEqual([
      ['index.html', 'html', 1],
      ['js-1', 'code', 1]
    ]);
    const page = list[0];
    expect(page.versions[0]).toMatchObject({ version: 1, messageId: first.messageId, rawUrl: expect.stringMatching(/^\/api\/public\/artifacts\/[0-9A-Z]{26}\/raw\?t=/) });
    const v1 = (await owner.agent.get(`/api/conversations/${first.conversationId}/artifacts/${page.id}/versions/1`).expect(200)).body;
    expect(v1).toMatchObject({ key: 'index.html', version: 1, content: PAGE('Hello') });
    // Sealed at rest.
    expect((await h.s.db('chat_artifact_versions').where({ id: page.versions[0].id }).first()).content).toMatch(/^v2\./);

    const second = await converse(owner, 'Now make it say Goodbye instead', first.conversationId);
    list = (await owner.agent.get(`/api/conversations/${first.conversationId}/artifacts`).expect(200)).body.artifacts;
    expect(list.find((a: { key: string }) => a.key === 'index.html').versions.map((v: { version: number; messageId: string }) => [v.version, v.messageId])).toEqual([[1, first.messageId], [2, second.messageId]]);
    expect(list.find((a: { key: string }) => a.key === 'js-1').versions).toHaveLength(1); // unchanged helper: no new version
    expect((await owner.agent.get(`/api/conversations/${first.conversationId}/artifacts/${page.id}/versions/2`).expect(200)).body.content).toBe(PAGE('Goodbye'));
    expect((await owner.agent.get(`/api/conversations/${first.conversationId}/artifacts/${page.id}/versions/1`).expect(200)).body.content).toBe(PAGE('Hello'));
    await owner.agent.get(`/api/conversations/${first.conversationId}/artifacts/${page.id}/versions/3`).expect(404);
    await owner.agent.get(`/api/conversations/${first.conversationId}/artifacts/${page.id}/versions/0`).expect(400);

    await converse(owner, 'Say Goodbye again please', first.conversationId);
    list = (await owner.agent.get(`/api/conversations/${first.conversationId}/artifacts`).expect(200)).body.artifacts;
    expect(list.find((a: { key: string }) => a.key === 'index.html').versions).toHaveLength(2);
  });

  it('serves a version to a sandboxed frame by capability, and refuses a wrong or stale token', async () => {
    const owner = await user('owner');
    const c = await converse(owner, 'Make me a page that says Hello');
    const list = (await owner.agent.get(`/api/conversations/${c.conversationId}/artifacts`).expect(200)).body.artifacts;
    const raw = await request(h.app).get(list[0].versions[0].rawUrl).expect(200);
    expect(raw.headers['content-type']).toMatch(/^text\/html/);
    expect(raw.headers['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none'/);
    expect(raw.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(raw.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(raw.text).toBe(PAGE('Hello'));
    const code = await request(h.app).get(list[1].versions[0].rawUrl).expect(200);
    expect(code.headers['content-type']).toMatch(/^text\/plain/);

    const url = new URL(list[0].versions[0].rawUrl, 'http://x');
    const [vid, exp, mac] = String(url.searchParams.get('t')).split('.');
    await request(h.app).get(`/api/public/artifacts/${vid}/raw?t=${encodeURIComponent(`${vid}.${exp}.${mac!.slice(0, -2)}xx`)}`).expect(404);
    await request(h.app).get(`/api/public/artifacts/${vid}/raw?t=${encodeURIComponent(`${vid}.${Number(exp) - 10 * 60_000 - 1}.${mac}`)}`).expect(404);
    const stale = await h.s.chatArtifacts.rawToken(vid!, -1000);
    await request(h.app).get(`/api/public/artifacts/${vid}/raw?t=${encodeURIComponent(stale)}`).expect(404);
    await request(h.app).get(`/api/public/artifacts/${vid}/raw`).expect(404);
  });

  it('shows share readers and link readers the artifacts of the shared path, within their clearance', async () => {
    const owner = await user('owner');
    const reader = await user('reader');
    const c = await converse(owner, 'Make me a page that says Hello');
    await owner.agent.get(`/api/conversations/${c.conversationId}/artifacts`).expect(200);
    await reader.agent.get(`/api/conversations/${c.conversationId}/artifacts`).expect(404);

    await owner.post(`/api/conversations/${c.conversationId}/shares`, { kind: 'user', userId: reader.id }).expect(201);
    const shared = (await reader.agent.get(`/api/shared-conversations/${c.conversationId}`).expect(200)).body;
    expect(shared.artifacts.map((a: { key: string; versions: unknown[] }) => [a.key, a.versions.length])).toEqual([['index.html', 1], ['js-1', 1]]);
    const viaList = (await reader.agent.get(`/api/conversations/${c.conversationId}/artifacts`).expect(200)).body.artifacts;
    expect(viaList).toHaveLength(2);
    const page = viaList[0];
    expect((await reader.agent.get(`/api/conversations/${c.conversationId}/artifacts/${page.id}/versions/1`).expect(200)).body.content).toBe(PAGE('Hello'));

    // A link reader gets the same artifacts in the transcript.
    const link = await owner.post(`/api/conversations/${c.conversationId}/shares`, { kind: 'link', expiresInHours: 2 }).expect(201);
    const opened = await reader.post('/api/shared-links/open', { token: link.body.token }).expect(200);
    expect(opened.body.artifacts.map((a: { key: string }) => a.key)).toEqual(['index.html', 'js-1']);
    expect(await request(h.app).get(opened.body.artifacts[0].versions[0].rawUrl).expect(200)).toBeTruthy();

    // An artifact above the reader's clearance is left out, and its version refused.
    await h.s.db('chat_artifacts').where({ id: page.id }).update({ label: 'confidential' });
    expect((await reader.agent.get(`/api/conversations/${c.conversationId}/artifacts`).expect(200)).body.artifacts.map((a: { key: string }) => a.key)).toEqual(['js-1']);
    await reader.agent.get(`/api/conversations/${c.conversationId}/artifacts/${page.id}/versions/1`).expect(403);
  });
});
