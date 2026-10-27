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
import { FakeOllama } from '../server/test/fake-ollama.js';
import { FakeOpenAIServer } from '../server/test/fake-openai-server.js';
import { FakeMcp } from '../server/test/fake-mcp.js';
import { FakeRunner } from '../server/test/fake-runner.js';
import { FakeImageBackend, FakeMediaRunner, FakeSafety } from '../server/test/sprint8-fakes.js';
import { SqliteTableDriver } from '../server/test/sprint39c-helpers.js';
import { createDrivers } from '../server/src/connections/drivers.js';
import { parseAllowList } from '../server/src/mcp/hosts.js';
import Database from 'better-sqlite3';
import { FakeTrainer } from '../server/test/fake-trainer.js';
import { startFakeAcme } from '../server/test/fake-acme.js';
import { startFakeCkan, startFakeHub } from '../server/test/sprint30-imports-fakes.js';
import { FakePlcDirectory } from '../server/test/sprint25b-fakes.js';
import { FakeGraph } from '../server/test/fake-cloud-directory.js';
import { FakeAws } from '../server/test/fake-aws.js';
import { seedCloudScreens } from './cloud-seed.js';
import { startSigner } from '../server/src/signer/server.js';
import { escrowKey, recordEscrow } from '../server/src/platform/escrow.js';
// The console suite runs offline for the clouds too (platform/egress.ts refuses real provider hosts).
process.env.EXPRSN_TESTS_OFFLINE = '1';

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
    // 1.6.0 (B-8301): a data model draft for the Apps screen: a leave-request model with an approval state machine.
    if (/data model of a low-code app/.test(system)) return { content: JSON.stringify({ entities: [{ name: 'employee', title: 'Employee', definition: { fields: [{ name: 'name', type: 'string', required: true, indexed: true, maxLength: 200 }] } }, { name: 'request', title: 'Leave request', definition: { fields: [{ name: 'employee', type: 'reference', entity: 'employee', required: true }, { name: 'from_day', type: 'date', required: true, indexed: true }, { name: 'to_day', type: 'date', required: true }, { name: 'days', type: 'formula', expression: 'days_between(from_day, to_day) + 1' }], states: { initial: 'submitted', states: [{ name: 'submitted' }, { name: 'approved' }, { name: 'rejected' }], transitions: [{ from: ['submitted'], to: 'approved' }, { from: ['submitted'], to: 'rejected' }] } } }], triggers: [{ entity: 'request', events: ['created'], workflow: 'notify-manager' }] }) };
    // 1.7.0 (B-9601): a guardrail rule drafted from a description, for the Guardrails screen's "Describe a rule".
    if (/You write one guardrail rule/.test(system)) return { content: JSON.stringify({ name: 'Hold card numbers in answers', checkpoint: 'model-output', mechanism: { kind: 'pii', detectors: ['payment_card'], threshold: 0.8 }, action: 'require-approval', severity: 'high', description: 'Holds an answer that quotes a payment card number.' }) };
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
  const signerKey = randomBytes(32).toString('base64');
  const signer = await startSigner({ socketPath: path.join(dir, 'signer', 's.sock'), key: signerKey, token: signerToken });
  // 1.8.0 (B-145): an escrow of the signer's key (2 of 3), so the seal spec can seal and unseal with its shares.
  const escrow = escrowKey(Buffer.from(signerKey, 'base64'), 2, 3);
  // A PLC directory (Sprint 25): did:plc identities and the PDS accounts' DIDs (Sprint 31) are registered here.
  const plc = new FakePlcDirectory();
  await plc.start();
  // 1.7.0 (B-3807): a CKAN portal and a hub for the Import screen; the Import spec adds them as repositories.
  const [ckan, hub] = await Promise.all([startFakeCkan(), startFakeHub()]);
  // 1.9.9-qa (QA-1): Microsoft Graph for the directory import dialog (User stores); the spec adds the store.
  const graph = await new FakeGraph().start();
  // 1.9.99-final, Sprint 61 (B-10505 to B-10508): Bedrock (control plane, runtime, guardrails) and the AWS Price List
  // API inside the AWS fake, for the Models screen's cloud catalogue and card; the spec registers the instance itself.
  const aws = await new FakeAws().start();
  aws.bedrock.guardrails.set('gre2e01', { id: 'gre2e01', name: 'E2E finance guard', versions: ['1'], topic: /stock tips/i });
  aws.setBedrockPrice('Claude 3 Haiku', 'eu-central-1', { input: '0.00025', output: '0.00125', effectiveDate: '2026-10-01' });
  graph.users.set('e2e-u1', { id: 'e2e-u1', userPrincipalName: 'nia@contoso.test', displayName: 'Nia Contoso', groups: [{ id: 'e2e-g1', displayName: 'E2E Staff', securityEnabled: true }] });
  graph.users.set('e2e-u2', { id: 'e2e-u2', userPrincipalName: 'oli@contoso.test', displayName: 'Oli Contoso', groups: [{ id: 'e2e-g1', displayName: 'E2E Staff', securityEnabled: true }] });
  graph.users.set('e2e-u3', { id: 'e2e-u3', userPrincipalName: 'pax@contoso.test', accountEnabled: false, groups: [{ id: 'e2e-g1', displayName: 'E2E Staff', securityEnabled: true }] });
  let baseUrl = url;
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
    // The suite signs each user in once and runs ~50 minutes; the default 30 idle minutes signed the member out before
    // the last sweep (2026-10-21). The idle timeout itself is tested in the server suite.
    SESSION_IDLE_MINUTES: '240',
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
    // 1.7.0 (B-3807): the import fakes are on loopback, over plain http.
    IMPORT_ALLOWED_HOSTS: '127.0.0.1',
    WORKFLOW_HTTP_ALLOW_LOOPBACK: 'true',
    ACME_DIRECTORY_URL: acme.directory,
    ACME_POLL_MS: '20',
    ACME_CONTACT: 'pki@example.internal',
    // AT-Protocol (Sprints 25 and 31): the PLC directory double, and a handle domain for the PDS (the AT-Protocol screen).
    ATPROTO_PLC_URL: plc.url,
    PDS_HANDLE_DOMAIN: 'pds.example.test',
    // Every browser test signs in from 127.0.0.1; the per-address limiter must not throttle the suite.
    LOCKOUT_MAX_ATTEMPTS: '50',
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('E2E_ENV_')).map(([k, v]) => [k.slice(8), v]))
  } as NodeJS.ProcessEnv);

  const db = createDb(cfg);
  await migrate(db);
  // 1.9.0, Sprint 51 (B-162): the plan and subscription tables, until 124 is registered in migrations/index.ts (each
  // table is created only when missing, so this is a no-op afterwards).
  if (!(await db.schema.hasTable('billing_subscription_events'))) await (await import('../server/src/db/migrations/124_billing_plans_subscriptions.js')).up(db);
  // And Sprint 51's cycle and discount tables (B-163 to B-165), likewise until 125 and 126 are registered.
  if (!(await db.schema.hasColumn('billing_statements', 'charges'))) await (await import('../server/src/db/migrations/125_billing_cycles_tiers.js')).up(db);
  if (!(await db.schema.hasTable('billing_discount_rules'))) await (await import('../server/src/db/migrations/126_billing_discounts.js')).up(db);
  // 1.9.0, Sprint 55 (B-190, B-191): the sign-in policy and OAuth client settings tables, likewise until 129 and 130
  // are registered.
  if (!(await db.schema.hasTable('signin_policies'))) await (await import('../server/src/db/migrations/129_signin_policy.js')).up(db);
  if (!(await db.schema.hasTable('oidc_client_settings'))) await (await import('../server/src/db/migrations/130_oidc_client_settings.js')).up(db);
  // 1.9.0, Sprint 55 (B-192 to B-194): the leaked-password list tables, likewise until 131 is registered.
  if (!(await db.schema.hasTable('leaked_password_lists'))) await (await import('../server/src/db/migrations/131_leaked_password_lists.js')).up(db);
  // 1.9.0: notification templates, likewise until 132 is registered.
  if (!(await db.schema.hasTable('notification_templates'))) await (await import('../server/src/db/migrations/132_notification_templates.js')).up(db);
  // 1.9.0, Sprint 55 (B-187 to B-189): CA settings, CA tokens and member certificates, likewise until 127 and 128 are
  // registered.
  if (!(await db.schema.hasTable('pki_settings'))) await (await import('../server/src/db/migrations/127_pki_settings.js')).up(db);
  if (!(await db.schema.hasTable('pki_tokens'))) await (await import('../server/src/db/migrations/128_ca_tokens.js')).up(db);
  // 1.9.0, Sprint 53 (B-174 to B-176): group proposals, ballots and budgets, likewise until 133 and 134 are registered.
  if (!(await db.schema.hasTable('group_proposals'))) await (await import('../server/src/db/migrations/133_group_proposals.js')).up(db);
  if (!(await db.schema.hasTable('group_ballots'))) await (await import('../server/src/db/migrations/134_group_votes.js')).up(db);
  // 1.9.0, Sprint 53 (B-177 to B-179): albums, and their share and upload links, likewise until 135 and 136 are registered.
  if (!(await db.schema.hasTable('albums'))) await (await import('../server/src/db/migrations/135_albums.js')).up(db);
  if (!(await db.schema.hasTable('album_share_links'))) await (await import('../server/src/db/migrations/136_album_links.js')).up(db);
  // 1.9.0, Sprint 54 (B-181, B-185, B-186): store state and versions, and store backups, likewise until 140 and 141 are
  // registered.
  if (!(await db.schema.hasTable('identity_provider_versions'))) await (await import('../server/src/db/migrations/140_identity_store_state.js')).up(db);
  if (!(await db.schema.hasTable('identity_store_backups'))) await (await import('../server/src/db/migrations/141_identity_store_backups.js')).up(db);
  // QA-1 (Sprint 54 leftovers): store governance (dual control, purge, schedules), likewise until 142 is registered.
  if (!(await db.schema.hasTable('identity_store_proposals'))) await (await import('../server/src/db/migrations/142_identity_store_governance.js')).up(db);
  // 1.9.9-qa (QA-1): directory sync state (Graph delta links) and directory imports, likewise until 143 is registered.
  if (!(await db.schema.hasTable('directory_imports'))) await (await import('../server/src/db/migrations/143_directory_sync_state.js')).up(db);
  // 1.9.0, Sprint 52 (B-167 to B-169): feature flags, likewise until 137 is registered.
  if (!(await db.schema.hasTable('feature_flags'))) await (await import('../server/src/db/migrations/137_feature_flags.js')).up(db);
  // 1.9.0, Sprint 52 (B-170 to B-173): the search index and its keys and state, likewise until 138 and 139 are registered.
  if (!(await db.schema.hasTable('search_postings'))) await (await import('../server/src/db/migrations/138_search_index.js')).up(db);
  if (!(await db.schema.hasTable('search_state'))) await (await import('../server/src/db/migrations/139_search_state.js')).up(db);
  // 1.9.9-qa (B-173): saved searches, likewise until 145 is registered.
  if (!(await db.schema.hasTable('saved_searches'))) await (await import('../server/src/db/migrations/145_saved_searches.js')).up(db);
  // 1.9.9-qa (QA-1): who added a knowledge document (usage attribution of reindexing), likewise until 144 is registered.
  if (!(await db.schema.hasColumn('knowledge_documents', 'created_by'))) await (await import('../server/src/db/migrations/144_knowledge_document_creator.js')).up(db);
  // 1.9.99-final, Sprint 56 (B-10002, B-10008): cloud accounts, regions, credential references and proposals, likewise until 146 is registered.
  if (!(await db.schema.hasTable('cloud_accounts'))) await (await import('../server/src/db/migrations/146_cloud_accounts.js')).up(db);
  // 1.9.99-final, Sprint 56 (B-10003 to B-10006): the federation issuer's keys and publication state, and credential state, likewise until 147 is registered.
  if (!(await db.schema.hasTable('cloud_issuer_keys'))) await (await import('../server/src/db/migrations/147_cloud_federation.js')).up(db);
  // 1.9.99-final, Sprint 57 (B-10102 to B-10105): deployments, the resource graph, plans and the operation journal, likewise until 148 is registered.
  if (!(await db.schema.hasTable('cloud_deployments'))) await (await import('../server/src/db/migrations/148_cloud_journal.js')).up(db);
  // 1.9.99-final, Sprint 57 (B-10106, B-10107): drift findings, destroys and orphans, likewise until 149 is registered.
  if (!(await db.schema.hasTable('cloud_drift_findings'))) await (await import('../server/src/db/migrations/149_cloud_lifecycle.js')).up(db);
  // 1.9.99-final, Sprint 57 (B-10601): the price catalogue's cache, likewise until 150 is registered.
  if (!(await db.schema.hasTable('cloud_prices'))) await (await import('../server/src/db/migrations/150_cloud_prices.js')).up(db);
  // 1.9.99-final, Sprint 58 (B-10203, B-10207): Kubernetes releases, upgrades and pre-upgrade snapshots, likewise until 151 is registered.
  if (!(await db.schema.hasTable('cloud_releases'))) await (await import('../server/src/db/migrations/151_cloud_releases.js')).up(db);
  // 1.9.99-final, Sprint 58 (B-10602, B-10206): budgets, alert state, overrides and the load-balancer hook targets, likewise until 152 is registered.
  if (!(await db.schema.hasTable('cloud_budgets'))) await (await import('../server/src/db/migrations/152_cloud_budgets.js')).up(db);
  // 1.9.99-final, Sprint 59 (B-10307): managed databases' snapshot schedules, likewise until 153 is registered.
  if (!(await db.schema.hasTable('cloud_db_snapshot_schedules'))) await (await import('../server/src/db/migrations/153_cloud_databases.js')).up(db);
  // 1.9.99-final, Sprint 59 (B-10603): ingested cloud costs and their fetch claims, likewise until 155 is registered.
  if (!(await db.schema.hasTable('cloud_costs'))) await (await import('../server/src/db/migrations/155_cloud_costs.js')).up(db);
  // 1.9.99-final, Sprint 59 (B-10306): discovered instances and the links of connections made from a cloud account, likewise until 156 is registered.
  if (!(await db.schema.hasTable('cloud_connection_links'))) await (await import('../server/src/db/migrations/156_cloud_connections.js')).up(db);
  // 1.9.99-final, Sprint 60 (B-10401, B-10404): GPU pool links, enrolment tokens, boot timings (applied by hand until 157 is registered).
  if (!(await db.schema.hasTable('cloud_gpu_pool_links'))) await (await import('../server/src/db/migrations/157_cloud_gpu_pools.js')).up(db);
  // 1.9.99-final, Sprint 60 (B-10501, B-10504): cloud model entries from the catalogue import, likewise until 159 is registered.
  if (!(await db.schema.hasTable('cloud_model_entries'))) await (await import('../server/src/db/migrations/159_cloud_models.js')).up(db);
  // 1.9.99-final, Sprint 60 (B-10402, B-10403, B-10605): scale policies, scale events, interruptions and the savings ledger, likewise until 158 is registered.
  if (!(await db.schema.hasTable('cloud_scale_policies'))) await (await import('../server/src/db/migrations/158_cloud_autoscale.js')).up(db);
  // 1.9.99-final, Sprint 60 (B-10509): neurons and cost on usage records (160, not registered yet).
  if (!(await db.schema.hasColumn('usage_records', 'neurons'))) await (await import('../server/src/db/migrations/160_cloud_model_servers.js')).up(db);
  // 1.9.99-final, Sprint 61 (B-10505, B-10507): versioned model prices, data-terms attestations, cached tokens (163, not registered yet).
  if (!(await db.schema.hasTable('cloud_model_prices'))) await (await import('../server/src/db/migrations/163_cloud_model_prices.js')).up(db);
  // 1.9.99-final, Sprint 61 (B-10901 to B-10904): Cloudflare front doors (161, not registered yet).
  if (!(await db.schema.hasTable('cloud_edge'))) await (await import('../server/src/db/migrations/161_cloud_edge.js')).up(db);
  // 1.9.99-final, Sprint 61 (B-10604): allocation rules, monthly showback rows and the statement setting (164, not registered yet).
  if (!(await db.schema.hasTable('cloud_showback'))) await (await import('../server/src/db/migrations/164_cloud_showback.js')).up(db);
  // 1.9.99-final, Sprint 62 (B-10703): the change trail on drift findings (165, not registered yet).
  if (!(await db.schema.hasTable('cloud_change_trail'))) await (await import('../server/src/db/migrations/165_cloud_change_trail.js')).up(db);
  // 1.9.99-final, Sprint 62 (B-10606): spend anomalies (166, not registered yet).
  if (!(await db.schema.hasTable('cloud_anomalies'))) await (await import('../server/src/db/migrations/166_cloud_anomalies.js')).up(db);
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
  // 2026-10-16: image exports convert in the sandboxed exprsn-imgconv container in production; here a fake gives the
  // first image back under the format asked and says in its notes what it was asked, so the spec sees the options arrive.
  s.imageExports.converter = async (_p, args) => {
    const frames = Array.isArray(args.frames) ? (args.frames as { base64: string }[]) : null;
    const to = String(args.to);
    const asked = ['bit_depth', 'hdr', 'lossless', 'quality', 'effort', 'progressive', 'roi', 'tile_size', 'frame_ms'].filter((k) => args[k] !== undefined).map((k) => `${k} ${JSON.stringify(args[k])}`);
    const media: Record<string, string> = { webp: 'image/webp', gif: 'image/gif', jxl: 'image/jxl', jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
    return { mediaType: media[to] ?? 'application/octet-stream', content: frames ? frames[0]!.base64 : String(args.base64), encoding: 'base64', width: 1024, height: 768, frames: frames ? frames.length : 1, notes: [`${to === 'jxl' ? 'JPEG XL' : to.toUpperCase()}: ${asked.join(', ') || 'defaults'}`], warnings: [] };
  };
  await bootstrap(s);
  await recordEscrow(db, escrow, 'e2e');
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
  // Chat lists only profiles whose model is in memory: the two chat models start loaded.
  for (const [name, size] of [['llama3.1:8b', 5 * GB], ['qwen2.5:7b', 4 * GB]] as const) ollama.loaded.set(name, { size, expires: Date.now() + 24 * 3600_000 });

  // 1.9.99-final, Sprint 60 (B-10406): a cloud GPU pool for the Pools screen's node group card: a DigitalOcean account,
  // a deployment whose GPU node group runs one node, and the pool's scale policy. Its size changes go to a fake scaler
  // (nothing reaches DigitalOcean); the server audits them as it would a real one.
  {
    const now = Date.now();
    // Crockford base32 (no I, L, O or U), so the routes' id checks accept them.
    const cid = (n: number) => `01JE2EC10DG${String(n).padStart(15, '0')}`;
    const cloudPool = await repo.createPool({ name: 'gpu-cloud', description: 'H100 nodes on DigitalOcean, scaled by the gateway', accelerator: 'cuda', zone: 'inference', labelCeiling: 'internal' });
    await db('cloud_accounts').insert({ id: cid(1), name: 'do-gpu', provider: 'digitalocean', scope: 'platform', tenant_id: null, scope_key: 'platform', provider_ids: JSON.stringify({ doTeamId: 'team-e2e' }), credential_mode: 'vaulted', default_region: 'fra1', state: 'active', description: null, validation: null, validated_at: null, created_by: null, created_tenant: tenantId, created_at: now, updated_at: now });
    await db('cloud_account_regions').insert({ account_id: cid(1), region: 'fra1', zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: true, updated_at: now });
    await db('cloud_deployments').insert({ id: cid(2), tenant_id: tenantId, scope: 'platform', account_id: cid(1), provider: 'digitalocean', name: 'gpu-e2e', region: 'fra1', label: 'internal', description: null, state: 'ready', health: 'healthy', spec: null, endpoints: null, observed_version: 1, current_plan_id: null, lease_holder: null, lease_until: null, verify: null, verified_at: null, created_by: null, created_at: now, updated_at: now });
    const group = { key: 'gpu-h100', type: 'node_group', spec: { role: 'gpu', gpu: 'h100', size: 'gpu-h100x1-80gb', min: 0, max: 2, busyHours: 160, scaleToZero: true }, dependsOn: [], protect: false, region: null, tags: { pool: 'gpu-cloud' } };
    await db('cloud_resources').insert({ id: cid(3), deployment_id: cid(2), key: 'gpu-h100', type: 'node_group', region: 'fra1', provider_id: 'doks-e2e/pool-gpu', locator: null, desired: JSON.stringify(group), observed: null, observed_hash: null, observed_at: null, depends_on: '[]', protect: false, tags: '{}', state: 'ready', created_op: null, created_audit: null, last_verified: null, created_at: now, updated_at: now });
    await db('cloud_scale_policies').insert({ pool_id: cloudPool.id, deployment_id: cid(2), resource_key: 'gpu-h100', min: 0, max: 2, desired: 1, idle_minutes: 15, queue_depth: 2, max_cold_wait_ms: 600_000, capacity: 'on_demand', on_demand_fallback: true, capacity_now: 'on_demand', od_nodes: 0, last_lease_at: now, scaled_at: now - 3_600_000, updated_by: null, created_at: now, updated_at: now });
    s.cloud.autoscale.scaler = { setDesired: async () => ({ requestId: 'e2e-scale' }) };
    // 1.9.99-final, Sprint 61 (B-10604): one ingested cost on the first of this month for the showback view (written as
    // billing ingestion writes it; no provider is called).
    const first = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)).toISOString().slice(0, 10);
    await db('cloud_costs').insert({ id: cid(4), account_id: cid(1), provider: 'digitalocean', deployment_id: cid(2), allocation: 'doks-e2e/pool-gpu', service: 'Kubernetes', day: first, amount: '12.5', currency: 'USD', source: 'digitalocean-preview', estimated: true, fetched_at: now });
  }
  // 1.9.99-final, Sprint 62 (B-10606, B-10607): the Cloud spend screen's account. An AWS account billing in EUR (so the
  // showback view's USD total above is unchanged) with 15 days of ingested NAT gateway and EC2 rows, the NAT cost tripled
  // yesterday, a fresh billing fetch, and a 300 EUR budget with the hard stop past 100 %; the anomaly check runs once
  // here (its notice is dropped, so no other spec sees it). No provider is called.
  {
    const now = Date.now();
    const sid = (n: number) => `01JE2ESPEND${String(n).padStart(15, '0')}`;
    const acct = sid(1);
    await db('cloud_accounts').insert({ id: acct, name: 'aws-spend', provider: 'aws', scope: 'platform', tenant_id: null, scope_key: 'platform', provider_ids: JSON.stringify({ awsAccountId: '210987654321' }), credential_mode: 'vaulted', default_region: 'eu-central-1', state: 'active', description: 'Cloud spend example account', validation: JSON.stringify({ at: now, ok: true, identity: { ok: true, principal: 'arn:aws:iam::210987654321:role/exprsn-billing', providerAccount: '210987654321' }, features: [{ feature: 'billing', name: 'Billing', status: 'ok', required: ['ce:GetCostAndUsage'], missing: [], reason: null }] }), validated_at: now, created_by: null, created_tenant: tenantId, created_at: now, updated_at: now });
    await db('cloud_account_regions').insert({ account_id: acct, region: 'eu-central-1', zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: true, updated_at: now });
    const day = (k: number) => new Date(now - k * 86_400_000).toISOString().slice(0, 10);
    const wobble = [0, 2, -1, 3, -2, 1, 0, -3, 2, 1, -1, 0, 2, -2];
    let n = 2;
    const row = (d: string, service: string, amount: number) => db('cloud_costs').insert({ id: sid(n++), account_id: acct, provider: 'aws', deployment_id: null, allocation: 'nw-prod-eu', service, day: d, amount: String(amount), currency: 'EUR', source: 'aws-cost-explorer', estimated: false, fetched_at: now });
    for (let k = 15; k >= 2; k--) { await row(day(k), 'Amazon VPC NAT Gateway', 60 + wobble[15 - k]!); await row(day(k), 'Amazon Elastic Compute Cloud - Compute', 400); }
    await row(day(1), 'Amazon VPC NAT Gateway', 180);
    await row(day(1), 'Amazon Elastic Compute Cloud - Compute', 400);
    await row(day(0), 'Amazon Elastic Compute Cloud - Compute', 400);
    await db('cloud_cost_fetches').insert({ id: sid(100), account_id: acct, provider: 'aws', fetch_key: day(0), manual: false, state: 'ok', attempts: 1, window_from: day(15), window_to: day(0), requests: 1, rows: n - 2, totals: JSON.stringify({ EUR: 0 }), note: null, error: null, requested_by: null, started_at: now, finished_at: now });
    await db('cloud_budgets').insert({ account_id: acct, tenant_id: tenantId, amount: '300', currency: 'EUR', hard_stop: 'actual', updated_by: null, created_at: now, updated_at: now });
    await s.cloud.anomalies.detectAccount(acct, { now });
    await db('notifications').where({ kind: 'cloud.anomaly' }).del();
  }
  // 1.9.99-final, Sprint 61 (B-10508): an AWS account for Bedrock (eu-central-1, ceiling internal) whose read and billing
  // credential is a key of the AWS fake, so the Models screen lists, imports, prices and guards Bedrock models through
  // the real routes; every call goes to the fake (the console suite runs offline for the clouds).
  const bedrockAccount = '01JE2EBEDR0CK0000000000001';
  {
    const now = Date.now();
    await db('cloud_accounts').insert({ id: bedrockAccount, name: 'aws-bedrock', provider: 'aws', scope: 'platform', tenant_id: null, scope_key: 'platform', provider_ids: JSON.stringify({ awsAccountId: aws.account }), credential_mode: 'vaulted', default_region: 'eu-central-1', state: 'active', description: 'Bedrock for the Models screen', validation: null, validated_at: null, created_by: null, created_tenant: tenantId, created_at: now, updated_at: now });
    await db('cloud_account_regions').insert({ account_id: bedrockAccount, region: 'eu-central-1', zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: true, updated_at: now });
    await db('cloud_credentials').insert({ account_id: bedrockAccount, mode: 'vaulted', params: '{}', refs: '{}', updated_by: null, updated_at: now });
    const key = aws.addUser({ userName: 'exprsn-e2e-bedrock' });
    const creds = s.cloud.credentials!;
    const real = creds.for.bind(creds);
    creds.for = async (a, purpose) => (a.id === bedrockAccount ? { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null } : real(a, purpose));
    s.cloud.bedrock.setEndpoints({ bedrock: aws.url, bedrockRuntime: aws.url });
    s.cloud.modelPrices.setEndpoints({ awsPricing: aws.url });
  }
  // 1.9.99-final, Sprint 62 (B-10706): the cloud screens' account, deployments, plan, drift finding and databases,
  // made through the real services against the DigitalOcean fake (e2e/cloud-seed.ts).
  const cloudSeed = await seedCloudScreens(s, { tenantId, rootId: root.id, awsUrl: aws.url });
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
    fakes: { ollama: ollama.url, mcp: mcp.url, acme: acme.directory, fmSocket: fm.socketPath, ckan: ckan.url, hub: hub.url, graph: { url: graph.url, tokenUrl: graph.tokenUrl, clientId: graph.clientId, clientSecret: graph.clientSecret }, bedrock: { url: aws.url, accountId: bedrockAccount, guardrail: 'gre2e01' } },
    users: ['root', 'root2', 'ops', 'mladmin', 'member', 'enrol'],
    // 1.6.0 (B-4204): the Storage spec leaves an old object here for the integrity check to find as an orphan.
    blobDir: cfg.BLOB_DIR,
    // 1.9.0 (B-175): the database file, so the governance spec can end a vote's time instead of waiting for it.
    dbFile: cfg.SQLITE_FILENAME,
    // 1.8.0 (B-145): the escrow shares of the signer's key, for the seal and unseal spec (test data only).
    escrow: { id: escrow.id, threshold: escrow.k, shares: escrow.shares }
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
      await Promise.all([ckan.close(), hub.close()]);
      await signer.close();
      await plc.stop();
      await graph.stop();
      await aws.stop();
      await cloudSeed.stop();
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
