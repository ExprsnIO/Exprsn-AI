/**
 * The server the end-to-end suite drives: the real application (services, routes, Socket.io, job workers, the
 * gateway poller and the static console from web/) on a temporary SQLite file, with the test fakes from server/test
 * standing in for Ollama, the MCP server, the script sandbox, ffmpeg, the image workers, the safety classifier, the
 * GPU trainer and the ACME directory; an in-process signer holds the keys. Nothing here changes server code; it only
 * wires what the unit tests use.
 *
 *   npx tsx e2e/server.ts [--port 0] [--state e2e/.state/server.json]
 *
 * When it is listening it writes the state file (base URL, accounts, the pre-enrolled TOTP secret) and prints
 * `E2E_READY <url>`. SIGTERM or SIGINT stops it and removes the temporary directory.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../server/src/config/index.js';
import { createDb, migrate } from '../server/src/db/knex.js';
import { createApp } from '../server/src/http/app.js';
import { createLogger, Metrics } from '../server/src/observability/index.js';
import { createServices } from '../server/src/services.js';
import { bootstrap } from '../server/src/bootstrap.js';
import { attachRealtime } from '../server/src/realtime/socket.js';
import { InstanceRegistry } from '../server/src/ops/instances.js';
import { hashPassword } from '../server/src/identity/passwords.js';
import type { Label } from '../server/src/authz/labels.js';
import type { ProfileRow } from '../server/src/gateway/repo.js';
import { FakeOllama, TEMPLATE_SYSTEM, templateModel, fakeRuleDraft, isRuleDraftPrompt } from '../server/test/fake-ollama.js';
import { FakeOpenAIServer } from '../server/test/fake-openai-server.js';
import { FakeMcp } from '../server/test/fake-mcp.js';
import { FakeRunner } from '../server/test/fake-runner.js';
import { FakeImageBackend, FakeMediaRunner, FakeSafety } from '../server/test/sprint8-fakes.js';
import { SqliteTableDriver } from '../server/test/sprint39c-helpers.js';
import { createDrivers } from '../server/src/connections/drivers.js';
import { parseAllowList } from '../server/src/mcp/hosts.js';
import Database from 'better-sqlite3';
import { FakeTrainer } from '../server/test/fake-trainer.js';
import { startFakeDataHub, startFakePortal } from '../server/test/sprint40b-fakes.js';
import { loadPrincipal } from '../server/src/http/middleware.js';
import { startFakeAcme } from '../server/test/fake-acme.js';
import { FakePlcDirectory } from '../server/test/sprint25b-fakes.js';
import { startSigner } from '../server/src/signer/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: opt } = parseArgs({ options: { port: { type: 'string', default: process.env.E2E_PORT ?? '0' }, state: { type: 'string', default: path.join(here, '.state', 'server.json') } } });

export const PASSWORD = 'correct horse battery staple';
const GB = 1_000_000_000;

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function main() {
  const port = Number(opt.port) || (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-e2e-'));
  for (const d of ['blobs', 'media', 'drills']) mkdirSync(path.join(dir, d));

  // ---- fakes that the configuration has to name ----
  // B-43: Apple's fm serve on a Unix socket (the on-device model, and Private Cloud Compute listed but refused), for
  // the Models screen's model servers. Nothing is registered on it: the Models spec does that through the console.
  const fm = new FakeOpenAIServer();
  fm.add({ id: 'system', ownedBy: 'Apple' }).add({ id: 'pcc', ownedBy: 'Apple', available: false, reason: 'PCC inference is not available in this context.' });
  await fm.start({ socketPath: path.join(tmpdir(), `exprsn-e2e-fm-${process.pid}.sock`) });
  const ollama = await new FakeOllama().start();
  ollama.chatDelayMs = 15;
  // An agent whose system prompt holds "E2E-CALL <function> [json arguments]" makes that tool call first (the runs
  // chain spec builds a three-level chain of delegating agents this way), then answers with what the tool returned.
  ollama.reply = (messages) => {
    const system = messages[0]?.role === 'system' ? messages[0].content : '';
    const call = /E2E-CALL (\S+)(?: (\{.*\}))?/.exec(system);
    const last = messages[messages.length - 1];
    if (call && last?.role !== 'tool') return { content: '', toolCall: { name: call[1]!, arguments: call[2] ? (JSON.parse(call[2]) as Record<string, unknown>) : { task: 'Carry on with the September close.' } } };
    if (call && last?.role === 'tool') return { content: `Done: ${String(last.content).slice(0, 160)}` };
    // 1.6.0 (B-8001): a question that asks for an "html page" answers with a fenced index.html (and a helper script), so
    // the Chat spec can open the artifact; a later turn with a different greeting makes a second version.
    const page = /html page/i.exec(String(last?.content ?? ''));
    if (page) {
      const greeting = /goodbye/i.test(String(last?.content ?? '')) ? 'Goodbye' : 'Hello';
      return { content: `Here is the page.\n\n\`\`\`html index.html\n<!doctype html>\n<html><body><h1 data-greeting>${greeting} from the artifact</h1><script>document.body.dataset.ran = 'yes';</script></body></html>\n\`\`\`\n\nAnd the helper:\n\n\`\`\`js\nexport function greet(name) {\n  return 'Welcome, ' + name;\n}\nexport const helper = true;\n\`\`\`` };
    }
    // 1.7.0 (B-9601): a guardrail rule drafted from a description on the Guardrails screen.
    if (isRuleDraftPrompt(messages)) return { content: fakeRuleDraft(messages) };
    // 1.6.0 (B-8301): a data model draft for the Apps screen: a leave-request model with an approval state machine.
    if (/data model of a low-code app/.test(system)) return { content: JSON.stringify({ entities: [{ name: 'employee', title: 'Employee', definition: { fields: [{ name: 'name', type: 'string', required: true, indexed: true, maxLength: 200 }] } }, { name: 'request', title: 'Leave request', definition: { fields: [{ name: 'employee', type: 'reference', entity: 'employee', required: true }, { name: 'from_day', type: 'date', required: true, indexed: true }, { name: 'to_day', type: 'date', required: true }, { name: 'days', type: 'formula', expression: 'days_between(from_day, to_day) + 1' }], states: { initial: 'submitted', states: [{ name: 'submitted' }, { name: 'approved' }, { name: 'rejected' }], transitions: [{ from: ['submitted'], to: 'approved' }, { from: ['submitted'], to: 'rejected' }] } } }], triggers: [{ entity: 'request', events: ['created'], workflow: 'notify-manager' }] }) };
    return { thinking: 'Reading the question first. ', content: `Fake answer to: ${last?.content ?? ''}` };
  };
  // 1.6.0 (B-8501): an outside PostgreSQL table for the Apps screen, as a SQLite stand-in behind the real connection
  // flow (register, schema, allow-list, attach, pull, write through).
  const outside = new Database(':memory:');
  outside.exec("create table customers (id integer primary key, name text not null, tier text, balance real); insert into customers (name, tier, balance) values ('Contoso', 'gold', 120.5), ('Fabrikam', 'silver', 0)");
  const mcp = await new FakeMcp().start();
  mcp.tools = [
    { name: 'lookup_invoice', description: 'Looks up an invoice by number.', inputSchema: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] }, annotations: { readOnlyHint: true }, run: (a) => ({ invoice: a.number, total: 1200 }) },
    { name: 'send_reminder', description: 'Sends a payment reminder.', inputSchema: { type: 'object', properties: { to: { type: 'string' } } }, annotations: { destructiveHint: true }, run: () => ({ sent: true }) }
  ];
  // The signer process (Sprint 20) in-process: it holds the key-encryption key and the certificate authority's issuer
  // keys, so the Certificates screen can create issuers and issue (without it key-making routes answer 409 custody).
  const signerToken = randomBytes(24).toString('base64url') + 'e2e-signer';
  const signer = await startSigner({ socketPath: path.join(dir, 'signer', 's.sock'), key: randomBytes(32).toString('base64'), token: signerToken });
  // A PLC directory (Sprint 25): did:plc identities and the PDS accounts' DIDs (Sprint 31) are registered here.
  const plc = new FakePlcDirectory();
  await plc.start();
  let baseUrl = url;
  // 1.7.0 (B-3804 to B-3807): an open-data portal (CKAN with a datastore, SDMX) and a hub with dataset repositories
  // for the Import screen; both are proposed and confirmed below.
  const [portal, dataHub] = await Promise.all([startFakePortal(), startFakeDataHub()]);
  const acme = await startFakeAcme(async (_domain, token) => {
    const r = await fetch(`${baseUrl}/.well-known/acme-challenge/${token}`);
    return r.status === 200 ? r.text() : null;
  });

  const cfg = loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
    // The suite opens every screen and design state several times as one admin; keep it clear of the per-user limit.
    API_RATE_PER_MINUTE: '6000',
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_URL: url,
    DB_CLIENT: 'sqlite',
    SQLITE_FILENAME: path.join(dir, 'exprsn.sqlite'),
    SESSION_SECRET: randomBytes(32).toString('hex'),
    SIGNER_SOCKET: signer.socketPath,
    SIGNER_TOKEN: signerToken,
    BLOB_DIR: path.join(dir, 'blobs'),
    MEDIA_WORK_DIR: path.join(dir, 'media'),
    PLATFORM_DRILL_DIR: path.join(dir, 'drills'),
    WEB_ROOT: path.join(here, '..', 'web'),
    JOB_QUEUE: 'db',
    JOB_POLL_MS: '200',
    OLLAMA_POLL_MS: '2000',
    MCP_ALLOWED_HOSTS: '127.0.0.1',
    // 1.6.0 (B-8902): HTTP tools reach internal hosts only as SERVICE_ALLOWED_HOSTS names them; the registry-http spec
    // serves its outside API on loopback.
    SERVICE_ALLOWED_HOSTS: '127.0.0.1',
    WORKFLOW_HTTP_ALLOW_LOOPBACK: 'true',
    ACME_DIRECTORY_URL: acme.directory,
    ACME_POLL_MS: '20',
    ACME_CONTACT: 'pki@example.internal',
    // AT-Protocol (Sprints 25 and 31): the PLC directory double, and a handle domain for the PDS (the AT-Protocol screen).
    ATPROTO_PLC_URL: plc.url,
    PDS_HANDLE_DOMAIN: 'pds.example.test',
    // 1.7.0 (B-3807): imports reach the fakes on loopback; harvests run when a repository is confirmed, not on a tick.
    IMPORT_ALLOWED_HOSTS: '127.0.0.1',
    IMPORT_HARVEST_TICK_MINUTES: '0',
    IMPORT_BUNDLE_POLL_MINUTES: '0',
    // Every browser test signs in from 127.0.0.1; the per-address limiter must not throttle the suite.
    LOCKOUT_MAX_ATTEMPTS: '50',
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('E2E_ENV_')).map(([k, v]) => [k.slice(8), v]))
  } as NodeJS.ProcessEnv);

  const db = createDb(cfg);
  await migrate(db);
  const runner = new FakeRunner();
  runner.handler = (req) => ({ stdout: req.stdin ? `echo: ${req.stdin}` : 'hello from the fake sandbox\n', exitCode: 0 });
  // Worker contract 2 (Sprint 18): the fake fetches run keys and stores checkpoints through the app.
  const trainer = new FakeTrainer();
  const s = createServices(cfg, db, createLogger(cfg.LOG_LEVEL, false), new Metrics(), {
    mediaRunner: new FakeMediaRunner(),
    imageBackends: [new FakeImageBackend()],
    imageSafety: new FakeSafety(),
    trainer,
    // 1.6.0 (B-8501): the outside table the Apps spec attaches lives at crm.internal; every other PostgreSQL connection
    // keeps the real driver, so the Connections and Refusals specs still see the outbound address guard.
    drivers: { postgres: (spec) => (/^crm\.internal(:\d+)?$/.test(spec.endpoint) ? new SqliteTableDriver(outside, spec) : createDrivers(parseAllowList(''))
      .postgres(spec)) }
  });
  s.scripts.runner = runner;
  // The deployment stays air-gapped for the other screens; only the PDS may treat its zone as having egress, so the
  // AT-Protocol screen can switch hosting on (in production the zone's egress decides, docs/pds.md).
  s.pds.zoneProblem = async () => null;
  await bootstrap(s);
  const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
  const tenantId = tenant.id;
  const workspace = await s.tenants.createWorkspace(tenantId, 'Finance Ops', 'confidential');

  // ---- accounts ----
  const local = (await s.providers.list(tenantId)).find((p) => p.kind === 'local')!;
  async function account(username: string, displayName: string, roles: string[], clearance: Label) {
    const user = await s.users.create(tenantId, { username, displayName, clearance });
    await s.users.update(tenantId, user.id, { clearance_direct: clearance });
    await db('local_credentials').insert({ user_id: user.id, password_hash: await hashPassword(PASSWORD), updated_at: Date.now() });
    await s.users.upsertIdentity(user.id, local.id, user.id, []);
    await s.users.setRoles(user.id, 'direct', roles);
    await s.tenants.addMember(workspace.id, user.id);
    return user;
  }
  const root = await account('root', 'Mara Okafor', ['system-admin'], 'restricted');
  await account('root2', 'Jon Lee', ['system-admin'], 'restricted');
  const ops = await account('ops', 'Ines Duarte', ['system-admin'], 'restricted');
  await account('mladmin', 'Asha Patel', ['ml-admin', 'member'], 'confidential');
  await account('member', 'Sam Rivera', ['member'], 'internal');
  await account('enrol', 'Noor Haddad', ['model-admin', 'member'], 'confidential');

  // root and ops have an authenticator already, so their sign-in goes through the second-factor step with a known
  // secret; root2 enrols one through the sign-in screen.
  const totp: Record<string, string> = {};
  for (const [u, name] of [[root, 'root'], [ops, 'ops']] as const) {
    const factor = await s.mfa.beginTotp(u.id, name, 'Authenticator app');
    await db('mfa_factors').where({ id: factor.id }).update({ confirmed_at: Date.now() });
    totp[name] = factor.secret;
  }

  // A flag in the review queue, as an enforced "flag" rule on the user-input checkpoint would raise it.
  const flagText = 'Please wire 4,000 EUR to IBAN DE89 3704 0044 0532 0130 00 before Friday.';
  const span: [number, number] = [flagText.indexOf('DE89'), flagText.indexOf(' before')];
  await s.guard.flags.create({ tenantId, workspaceId: workspace.id, kind: 'rule', checkpoint: 'user-input', ruleId: 'iban-flag', ruleName: 'IBAN in a prompt', setName: 'Finance baseline', setVersion: 1, stage: 'enforce', action: 'flag', severity: 'medium', label: 'internal', text: flagText, span, note: 'Matched: iban.', actor: { user: null, name: 'Sam Rivera', via: 'chat' } });

  // A JSON Lines file in the training staging area, as an ingestion pipeline would leave it (one row has PII).
  const rows = [
    { prompt: 'What is the refund window?', completion: 'Thirty days. Contact billing@northwind.example for exceptions.' },
    { prompt: 'Who approves travel above the cap?', completion: 'The finance controller approves it.' },
    { messages: [{ role: 'user', content: 'Close the quarter' }, { role: 'assistant', content: 'Done, the ledger is closed.' }] }
  ];
  await s.blobs.put(`training/staging/${tenantId}/finance-qa/2026-09-20/rows.jsonl`, Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'));

  // ---- gateway: a pool on the fake Ollama, approved models, published profiles ----
  const repo = s.gateway.repo;
  const models: Record<string, string> = {};
  const pool = await repo.createPool({ name: 'gpu-a', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
  await repo.createInstance({ poolId: pool.id, name: 'gpu-a-1', url: ollama.url, deploy: 'docker', settings: { parallel: 4 } });
  for (const [name, caps, size] of [
    ['llama3.1:8b', ['completion', 'tools'], 5 * GB],
    ['qwen2.5:7b', ['completion', 'tools'], 4 * GB],
    ['nomic-embed-text', ['embedding'], 1 * GB],
    ['llama-guard3:1b', ['completion'], 1 * GB]
  ] as const) {
    ollama.addAvailable({ name, size, capabilities: [...caps] });
    ollama.registry.set(name, { name, size, capabilities: [...caps] });
    const m = await repo.createModel({ name, source: 'Ollama library', expectedDigest: null, license: { name: 'Llama 3.1 Community' }, label: 'confidential', notes: null, requestedBy: 'e2e', requestedTenant: tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: [...caps], size_bytes: size });
    await repo.place(m.id, pool.id, 'warm', 'e2e');
    models[name] = m.id;
  }
  // B-11707: a Magistral-like model, recorded as a template model (its default system prompt asks for <think> blocks).
  {
    const tm = templateModel('magistral:24b', 14 * GB);
    ollama.addAvailable(tm);
    ollama.registry.set(tm.name, tm);
    const m = await repo.createModel({ name: tm.name, source: 'Ollama library', expectedDigest: null, license: { name: 'Apache 2.0' }, label: 'confidential', notes: null, requestedBy: 'e2e', requestedTenant: tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'tools', 'thinking'], size_bytes: 14 * GB, thinking: 'template', thinking_template: TEMPLATE_SYSTEM });
    await repo.place(m.id, pool.id, 'warm', 'e2e');
    models[tm.name] = m.id;
  }
  // A model in the registry that nobody has requested yet, for the "request a model" flow.
  ollama.registry.set('mistral:7b', { name: 'mistral:7b', size: 4 * GB, capabilities: ['completion'] });
  const t = Date.now();
  const profile = (id: string, name: string, display: string, model: string): ProfileRow => ({ id, tenant_id: tenantId, name, display_name: display, description: `${display} profile for the end-to-end suite`, alias_of: null, model_id: models[model]!, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: 'Be brief.', fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t });
  await repo.createProfile(profile('GENERAL'.padEnd(26, '0'), 'general', 'General', 'llama3.1:8b'));
  await repo.createProfile(profile('ANALYST'.padEnd(26, '0'), 'analyst', 'Analyst', 'qwen2.5:7b'));
  // 1.6.0 (B-8801 to B-8804): a model that reads images behind the profile `vision` (the fake answers image prompts
  // from the picture's text chunks), and a published vision classifier for the knowledge-images spec.
  ollama.addAvailable({ name: 'llava:7b', size: 4 * GB, capabilities: ['completion', 'vision'] });
  const vision = await repo.createModel({ name: 'llava:7b', source: 'Ollama library', expectedDigest: null, license: { name: 'Llama 2 Community' }, label: 'confidential', notes: null, requestedBy: 'e2e', requestedTenant: tenantId });
  await repo.updateModel(vision.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'vision'], size_bytes: 4 * GB });
  await repo.place(vision.id, pool.id, 'cold', 'e2e');
  models['llava:7b'] = vision.id;
  await repo.createProfile(profile('VISION'.padEnd(26, '0'), 'vision', 'Vision', 'llava:7b'));
  const imageKinds = await s.guard.classifiers.create(tenantId, { name: 'Image kinds', engine: 'vision', labels: ['receipt', 'screenshot'], profile: 'vision', description: 'Whether an image is a receipt or a screenshot, scored by the vision profile.' }, { userId: root.id, name: 'Mara Okafor' });
  await s.db('classifiers').where({ id: imageKinds.id }).update({ status: 'published' });
  await s.gateway.pollAll();

  // ---- import repositories (1.7.0, B-3807): proposed by root, confirmed by root2, harvested by the job queue ----
  {
    const proposer = (await loadPrincipal(s, tenantId, root.id, {}))!;
    const confirmer = (await loadPrincipal(s, tenantId, (await s.users.byUsername(tenantId, 'root2'))!.id, {}))!;
    for (const body of [
      { name: 'Open data portal', type: 'ckan' as const, baseUrl: `${portal.url}/api/3`, region: 'US', harvestMinutes: null },
      { name: 'Eurostat (SDMX)', type: 'sdmx' as const, baseUrl: `${portal.url}/sdmx`, region: 'EU', options: { licence: 'cc-by-4.0' }, harvestMinutes: null },
      { name: 'Hub with datasets', type: 'hf' as const, baseUrl: dataHub.url, region: 'Global', kinds: ['model', 'dataset'] as ('model' | 'dataset')[], harvestMinutes: null }
    ]) {
      const r = await s.imports.repositories.propose(proposer, body);
      await s.imports.repositories.confirm(confirmer, r.id, null);
    }
  }

  // ---- HTTP ----
  const app = createApp(s);
  trainer.useApp(app);
  const server: Server = createServer(app);
  const realtime = attachRealtime(server, s);
  s.jobs.start();
  s.gateway.start();
  // 1.6.0 (B-4202): this server's heartbeat for the Overview, and a second instance beside it (a registry of its own
  // in this process, with its own row), so the Overview spec can drain an instance without stopping this one's jobs.
  s.instances.start();
  const peer = new InstanceRegistry(() => s, s.bus, { heartbeatMs: 30_000, id: 'e2e-peer:2' });
  peer.start();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  baseUrl = url;

  const state = {
    url,
    password: PASSWORD,
    tenant: cfg.DEFAULT_TENANT,
    workspace: { id: workspace.id, name: workspace.name },
    totp,
    fakes: { ollama: ollama.url, mcp: mcp.url, acme: acme.directory, fmSocket: fm.socketPath },
    users: ['root', 'root2', 'ops', 'mladmin', 'member', 'enrol'],
    // 1.6.0 (B-4204): the Storage spec leaves an old object here for the integrity check to find as an orphan.
    blobDir: cfg.BLOB_DIR
  };
  mkdirSync(path.dirname(opt.state!), { recursive: true });
  writeFileSync(opt.state!, JSON.stringify(state, null, 2));
  process.stdout.write(`E2E_READY ${url}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    try {
      server.closeAllConnections();
      await realtime.close();
      await peer.stop();
      await s.close();
      await db.destroy();
      await ollama.stop();
      await fm.stop();
      await mcp.stop();
      await acme.close();
      await signer.close();
      await plc.stop();
    } catch {
      /* best effort */
    }
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  process.on('unhandledRejection', (err) => process.stderr.write(`[e2e server] unhandled rejection: ${String((err as Error)?.stack ?? err)}\n`));
}

main().catch((err: Error) => {
  process.stderr.write(`e2e server failed to start: ${err.stack ?? err.message}\n`);
  process.exit(2);
});
