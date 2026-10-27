import { existsSync } from 'node:fs';
import { scrubSecrets } from '../platform/diagnostics.js';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { redactRequest, traceIdFrom } from '../observability/index.js';
import { SpanKind } from '../observability/tracing.js';
import { zoneClusterRoutes } from '../routes/admin/zones-cluster.js';
import { authRoutes } from '../routes/auth.js';
import { meRoutes } from '../routes/me.js';
import { healthRoutes } from '../routes/health.js';
import { sealedGate, vaultSealPublicRoutes } from '../routes/vault-seal-public.js';
import { vaultSealAdminRoutes } from '../routes/admin/vault-seal.js';
import { securityScanRoutes } from '../routes/admin/security-scans.js';
import { pushRoutes } from '../routes/push.js';
import { identityAdminRoutes } from '../routes/admin/identity.js';
import { userAdminRoutes } from '../routes/admin/users.js';
import { auditAdminRoutes } from '../routes/admin/audit.js';
import { tenantAdminRoutes } from '../routes/admin/tenants.js';
import { socialAdminRoutes } from '../routes/admin/social.js';
import { usageAdminRoutes } from '../routes/admin/usage.js';
import { analyticsAdminRoutes } from '../routes/admin/analytics.js';
import { inventoryAdminRoutes } from '../routes/admin/inventory.js';
import { gatewayAdminRoutes } from '../routes/admin/gateway.js';
import { chatRoutes } from '../routes/chat.js';
import { chatCapabilityRoutes } from '../routes/chat-capabilities.js';
import { guardrailRoutes } from '../routes/guardrails.js';
import { guardrailTestRoutes } from '../routes/guardrail-tests.js';
import { guardrailTermRoutes } from '../routes/guardrail-terms.js';
import { registryAdminRoutes } from '../routes/admin/registry.js';
import { redTeamRoutes } from '../routes/admin/redteam.js';
import { agentIdentityRoutes } from '../routes/admin/agent-identities.js';
import { mcpAdminRoutes } from '../routes/admin/mcp.js';
import { agentRoutes } from '../routes/agents.js';
import { chainRoutes } from '../routes/chains.js';
import { scriptRoutes } from '../routes/scripts.js';
import { workflowRoutes } from '../routes/workflows.js';
import { workflowTagRoutes } from '../routes/workflow-tags.js';
import { designLockRoutes } from '../routes/design-locks.js';
import { decisionRoutes } from '../routes/decisions.js';
import { workflowOperationRoutes } from '../routes/workflow-operations.js';
import { workflowAutomationRoutes } from '../routes/workflow-automation.js';
import { workflowBuilderRoutes } from '../routes/workflow-builders.js';
import { workflowHookPublicRoutes } from '../routes/workflow-hooks-public.js';
import { mediaRoutes } from '../routes/media.js';
import { imageRoutes } from '../routes/images.js';
import { knowledgeRoutes } from '../routes/knowledge.js';
import { docsRoutes } from '../routes/docs.js';
import { knowledgeRevisionRoutes } from '../routes/knowledge-revisions.js';
import { memoryRoutes } from '../routes/memory.js';
import { connectionAdminRoutes } from '../routes/admin/connections.js';
import { connectionSourceAdminRoutes, connectionSourceRoutes } from '../routes/admin/connection-sources.js';
import { trainingRoutes } from '../routes/training.js';
import { zoneAdminRoutes } from '../routes/admin/zones.js';
import { cloudAdminRoutes } from '../routes/admin/cloud.js';
import { cloudFederationRoutes } from '../routes/admin/cloud-federation.js';
import { cloudDeploymentRoutes } from '../routes/admin/cloud-deployments.js';
import { cloudDeploymentSpecRoutes } from '../routes/admin/cloud-deployment-specs.js';
import { cloudLifecycleRoutes } from '../routes/admin/cloud-lifecycle.js';
import { cloudReleaseRoutes } from '../routes/admin/cloud-releases.js';
import { cloudDbMoveRoutes } from '../routes/admin/cloud-db-moves.js';
import { cloudBudgetRoutes } from '../routes/admin/cloud-budgets.js';
import { cloudEdgeRoutes } from '../routes/admin/cloud-edge.js';
import { cloudDatabaseRoutes } from '../routes/admin/cloud-databases.js';
import { cloudDataRoutes } from '../routes/admin/cloud-data.js';
import { cloudModelRoutes } from '../routes/admin/cloud-models.js';
import { cloudAiGatewayRoutes } from '../routes/admin/cloud-ai-gateway.js';
import { cloudCostRoutes } from '../routes/admin/cloud-costs.js';
import { cloudShowbackRoutes } from '../routes/admin/cloud-showback.js';
import { cloudAnomalyRoutes } from '../routes/admin/cloud-anomalies.js';
import { cloudModelImportRoutes } from '../routes/admin/cloud-model-import.js';
import { cloudModelGovernanceRoutes } from '../routes/admin/cloud-model-governance.js';
import { cloudIssuerPublicRoutes } from '../routes/cloud-issuer-public.js';
import { cloudGpuEnrolRoutes, cloudGpuPoolRoutes } from '../routes/admin/cloud-gpu-pools.js';
import { acmeChallengeRoutes, platformAdminRoutes } from '../routes/admin/platform.js';
import { leakedPasswordRoutes } from '../routes/admin/leaked-passwords.js';
import { operationsAdminRoutes } from '../routes/admin/operations.js';
import { platformVaultRoutes } from '../routes/admin/platform-vault.js';
import { platformSettingsRoutes } from '../routes/admin/platform-settings.js';
import { storageAdminRoutes } from '../routes/admin/storage.js';
import { federationAdminRoutes } from '../routes/admin/federation.js';
import { signinPolicyRoutes } from '../routes/admin/signin-policy.js';
import { mcpServerPublicRoutes } from '../routes/mcp-server-public.js';
import { mcpAccessRoutes } from '../routes/mcp-access.js';
import { federationPublicRoutes } from '../routes/federation-public.js';
import { integrationPublicRoutes } from '../routes/integrations-public.js';
import { appFlowHookPublicRoutes } from '../routes/apps-flow-hooks-public.js';
import { trainerWorkerRoutes } from '../routes/trainer-worker.js';
import { cloudAutoscaleRoutes, cloudNodeRoutes } from '../routes/admin/cloud-autoscale.js';
import { openAiRoutes } from '../openai/routes.js';
import { sharingRoutes } from '../routes/sharing.js';
import { promptRoutes } from '../routes/prompts.js';
import { integrationAdminRoutes } from '../routes/admin/integrations.js';
import { billingAdminRoutes } from '../routes/admin/billing.js';
import { billingPlanRoutes } from '../routes/admin/billing-plans.js';
import { featureFlagRoutes } from '../routes/admin/feature-flags.js';
import { vaultRoutes } from '../routes/vault.js';
import { complianceRoutes } from '../routes/compliance.js';
import { vaultLeaseRoutes } from '../routes/vault-leases.js';
import { vaultApiKeyRoutes } from '../routes/vault-apikeys.js';
import { pkiRoutes } from '../routes/pki.js';
import { pkiSettingsRoutes } from '../routes/pki-settings.js';
import { caTokenRoutes } from '../routes/ca-tokens.js';
import { certificateSignInRoutes, memberCertRoutes } from '../routes/member-certs.js';
import { pkiPublicRoutes } from '../routes/pki-public.js';
import { atprotoRoutes } from '../routes/atproto.js';
import { firehoseRoutes } from '../routes/firehose.js';
import { atprotoFeedRoutes } from '../routes/atproto-feeds.js';
import { atprotoFeedPublicRoutes } from '../routes/atproto-feeds-public.js';
import { identityPolicyRoutes, signupPublicRoutes } from '../routes/signup.js';
import { atprotoPublicRoutes } from '../routes/atproto-public.js';
import { pdsXrpcRoutes } from '../routes/pds-xrpc.js';
import { pdsRoutes } from '../routes/pds.js';
import { atprotoAccountRoutes } from '../routes/atproto-accounts.js';
import { moderationRoutes } from '../routes/moderation.js';
import { moderationSpamRoutes } from '../routes/moderation-spam.js';
import { calendarPublicRoutes, groupRoutes } from '../routes/groups.js';
import { groupGovernanceRoutes } from '../routes/group-governance.js';
import { socialRoutes } from '../routes/social.js';
import { peopleRoutes } from '../routes/people.js';
import { messagingRoutes } from '../routes/messaging.js';
import { feedRoutes } from '../routes/feed.js';
import { searchRoutes } from '../routes/search.js';
import type { Services } from '../services.js';
import { Limiter } from '../platform/ratelimit.js';
import { scimAdminRoutes, scimPublicRoutes } from '../routes/scim.js';
import { publicSharingRoutes } from '../routes/sharing-public.js';
import { mediaHostGuard, mediaOriginRoutes } from '../media/origin.js';
import { sendBytes } from '../routes/media.js';
import { authenticate, csrfProtection, noStore } from './middleware.js';
import { eventRoutes } from '../routes/events.js';
import { pluginAdminRoutes } from '../routes/admin/plugins.js';
import { pluginDraftRoutes } from '../routes/admin/plugin-drafts.js';
import { overviewCardRoutes } from '../routes/admin/overview-cards.js';
import { pushDeviceRoutes } from '../routes/push-devices.js';
import { notificationPrefRoutes } from '../routes/notification-prefs.js';
import { knowledgeFeedbackRoutes } from '../routes/knowledge-feedback.js';
import { pluginSurfaceRoutes } from '../routes/plugin-surfaces.js';
import { pluginBrokerRoutes } from '../routes/plugin-broker.js';
import { fileRoutes, publicFileRoutes } from '../routes/files.js';
import { albumRoutes } from '../routes/albums.js';
import { publicAlbumRoutes } from '../routes/albums-public.js';
import { fileDocumentRoutes } from '../routes/files-documents.js';
import { fileQueryRoutes } from '../routes/file-queries.js';
import { fileLocationRoutes } from '../routes/files-locations.js';
import { fileImportRoutes } from '../routes/files-imports.js';
import { fileReportRoutes } from '../routes/file-reports.js';
import { appRoutes } from '../routes/apps.js';
import { publicAppRoutes } from '../routes/apps-public.js';
import { appSubscriptionPublicRoutes } from '../routes/apps-subscriptions-public.js';
import { appEntityApiRoutes } from '../routes/apps-entity-api.js';
import { appEmbedPublicRoutes } from '../routes/apps-embed-public.js';
import { channelRoutes } from '../routes/channels.js';
import { slaRoutes } from '../routes/sla.js';
import { publicChannelRoutes } from '../routes/channels-public.js';
import { authzRoutes } from '../routes/authz.js';
import { davRoutes } from '../dav/handler.js';
import { appPasswordRoutes } from '../dav/routes.js';
import { importRoutes } from '../routes/imports.js';
import { badRequest, HttpProblem, notFound, tooManyRequests } from './problem.js';
import { applyTrustProxy } from './client-address.js';
import { cloudflareAccessGuard } from './cloudflare-access.js';

export interface AppState {
  shuttingDown: boolean;
}

export function createApp(s: Services, state: AppState = { shuttingDown: false }): Express {
  const app = express();
  app.disable('x-powered-by');
  // 1.9.99-final, Sprint 61 (B-10901): TRUST_PROXY as before; with `cloudflare` in it, Cloudflare's ranges and the
  // tunnel connector are trusted too and CF-Connecting-IP is the client only from them (`http/client-address.ts`).
  const edge = applyTrustProxy(app, s.cfg);
  if (edge) app.use(edge.middleware);
  app.set('etag', false);

  app.use((req, res, next) => {
    req.traceId = traceIdFrom(req.header('traceparent'));
    res.setHeader('X-Trace-Id', req.traceId);
    const end = s.metrics.httpDuration.startTimer({ method: req.method });
    res.on('finish', () => end({ route: req.route?.path ? req.baseUrl + String(req.route.path) : 'unmatched', status: String(res.statusCode) }));
    next();
  });

  // Sprint 22 (B-1401): a server span per request, in the request's W3C trace. The route template names it (the
  // URL, which can carry identifiers and query strings, is not recorded).
  app.use((req, res, next) => {
    const span = s.tracer.startRoot(`${req.method}`, SpanKind.SERVER, { traceparent: req.header('traceparent') ?? null, traceId: req.traceId, attributes: { 'http.request.method': req.method, 'url.scheme': req.protocol } });
    if (!span) return next();
    const done = () => {
      const route = req.route?.path ? req.baseUrl + String(req.route.path) : null;
      span.name = route ? `${req.method} ${route}` : req.method;
      span.setAttributes({ 'http.route': route, 'http.response.status_code': res.statusCode });
      if (res.statusCode >= 500) span.fail('HttpServerError');
      else span.ok();
      span.end();
    };
    res.once('finish', done);
    res.once('close', done);
    s.tracer.run(span, next);
  });

  app.use(
    pinoHttp({
      logger: s.log,
      genReqId: (req) => (req as express.Request).traceId,
      // Authorization codes, SAML messages, device codes and similar never reach the logs.
      serializers: { req: redactRequest },
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info')
    })
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // The console sets element style attributes for layout; no inline <style> or script is needed.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', ...(s.cfg.MEDIA_ORIGIN ? [new URL(s.cfg.MEDIA_ORIGIN).origin] : [])],
          mediaSrc: ["'self'", ...(s.cfg.MEDIA_ORIGIN ? [new URL(s.cfg.MEDIA_ORIGIN).origin] : [])],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(s.cfg.COOKIE_SECURE ? { upgradeInsecureRequests: [] } : {})
        }
      },
      strictTransportSecurity: s.cfg.COOKIE_SECURE ? { maxAge: 31536000, includeSubDomains: true } : false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' }
    })
  );
  app.use(compression());
  // Sprint 15: the separate media origin (MEDIA_ORIGIN) serves signed media reads and nothing else.
  app.use(mediaHostGuard(s));
  // 1.9.99-final, Sprint 61 (B-10904): with CLOUDFLARE_ACCESS_AUD, a protected path also needs a valid Access token
  // (never instead of the session); off otherwise.
  app.use(cloudflareAccessGuard(s));

  app.use(healthRoutes(s, state));
  // 1.8.0 (B-145): the unseal API, then the seal gate: while the vault is sealed only health, the console's static
  // files, the session probe and the unseal API answer; everything else is 503 "Vault sealed".
  app.use(vaultSealPublicRoutes(s));
  app.use(sealedGate(s));
  app.use(mediaOriginRoutes(s, sendBytes));
  // OIDC, SAML and device-flow protocol endpoints: public paths with their own parsing and checks.
  app.use(federationPublicRoutes(s));
  // 1.9.99-final, Sprint 56 (B-10005): the cloud federation issuer's discovery document and JWKS, when the console serves them.
  app.use(cloudIssuerPublicRoutes(s));
  // 1.6.0, Sprint 37b (B-7101, B-7102): each workspace's MCP server and its protected resource metadata.
  app.use(mcpServerPublicRoutes(s));
  // ACME http-01: the internal CA fetches the key authorization for orders in flight (public, text/plain).
  app.use(acmeChallengeRoutes(s));
  // Sprint 19: published webhook signing keys and the Stripe webhook (public; signatures are the authentication).
  app.use(integrationPublicRoutes(s));
  // 1.7.0: app flows' incoming webhooks (public; the HMAC signature over timestamp and body is the authentication).
  app.use(appFlowHookPublicRoutes(s));
  // 1.8.0, Sprint 46 (B-130): every workflow's webhook trigger (public; the same signed hook as app flows').
  app.use(workflowHookPublicRoutes(s));
  // Sprint 18 (B-905): the training worker's callbacks (run keys, artefacts), grant tokens only.
  app.use(trainerWorkerRoutes(s));
  // 1.9.99-final, Sprint 60 (B-10403): GPU nodes' spot interruption notices, by the node's CA certificate only.
  app.use(cloudNodeRoutes(s));
  // 1.9.99-final, Sprint 60 (B-10401): GPU nodes' enrolment, by a single-use token only.
  app.use(cloudGpuEnrolRoutes(s));
  // Sprint 24 (B-1603, B-1604): the CA's CRLs, issuer certificates and OCSP responder (public, rate-limited).
  app.use(pkiPublicRoutes(s));
  // Sprint 25 (B-2004): the plugin broker, for handler runs' scoped tokens only.
  app.use(pluginBrokerRoutes(s));
  // 1.5.0, Sprint 31 (B-3001, B-3003): the feed generator's XRPC (public, rate-limited; service JWTs verified). Before
  // the routes below, so /atproto/<key>/xrpc/app.bsky.feed.* is counted once against the per-address limit.
  app.use(atprotoFeedPublicRoutes(s));
  // Sprint 25 (B-1609, B-1610): DID documents, handle resolution and queryLabels (public, rate-limited).
  app.use(atprotoPublicRoutes(s));
  // 1.5.0, Sprint 31 (B-2901 to B-2905): the PDS's XRPC endpoints (public reads; writes with the PDS's own tokens).
  app.use(pdsXrpcRoutes(s));
  // Sprint 27c (B-2504): signed iCalendar feeds (public; the URL's signature is the credential, rate-limited).
  app.use(calendarPublicRoutes(s));
  // 1.5.0, Sprint 30 (B-3101 to B-3103): CalDAV and CardDAV at /dav, with /.well-known discovery. App passwords over
  // HTTP Basic only (never sessions), XML bodies read raw and parsed strictly, its own rate limit.
  app.use(davRoutes(s));
  // Sprint 13: the OpenAI-compatible API. Bearer credentials only, OpenAI-shaped errors, its own JSON limit.
  app.use('/v1', openAiRoutes(s));
  // 1.6.0, Sprint 37c (B-7201): SCIM 2.0 at /scim/v2. SCIM tokens only, SCIM-shaped errors, its own rate limit.
  app.use(scimPublicRoutes(s));

  // API: JSON only, small bodies, authenticated per request, CSRF-checked for cookie sessions.
  const api = express.Router();
  // API answers carry per-user data: never stored by the browser or an intermediary (routes may override).
  api.use(noStore);
  const json = express.json({ limit: '256kb', strict: true });
  // 2.0.0: edited documents (a spreadsheet's cells, a long Markdown file) are larger than other API bodies.
  const docJson = express.json({ limit: '32mb', strict: true });
  const isDocBody = (path: string) => /^\/files\/([^/]+\/document|documents|document-convert|table\/(normalize|infer))$/.test(path);
  // Attachment uploads carry the raw file (of any type, JSON included) and are parsed by their route.
  api.use((req, res, next) => (req.method === 'PUT' && (req.path === '/attachments' || req.path === '/media/assets' || /^\/knowledge\/bases\/[^/]+\/uploads$/.test(req.path) || /^\/admin\/platform\/bundles\/[^/]+\/transfer$/.test(req.path) || /^\/files\/(uploads|[^/]+\/content)$/.test(req.path) || req.path === '/people/me/avatar' || /^\/groups\/[^/]+\/(avatar|banner)$/.test(req.path) || /^\/admin\/classifiers\/[^/]+\/samples\/image$/.test(req.path) || req.path === '/admin/security/scans/upload' || req.path === '/admin/identity-store-backups/upload' || /^\/admin\/leaked-passwords\/lists\/[^/]+\/upload$/.test(req.path)) ? next() : isDocBody(req.path) ? docJson(req, res, next) : json(req, res, next)));
  api.use(authenticate(s));
  api.use(csrfProtection(s));
  // 1.9.99-final (B-10302): while a database move holds its read-only window, changes answer 503 read_only_window.
  api.use(s.cloud.dbMoves.window.middleware());

  // Counted in the shared counter store: one limit across every instance when REDIS_URL is set.
  const general = new Limiter(s.counters, 'api', s.cfg.API_RATE_PER_MINUTE, 60_000);
  const authLimiter = new Limiter(s.counters, 'auth', 30, 60_000);
  const limit = (limiter: Limiter): express.RequestHandler => async (req, _res, next) => {
    const r = await limiter.consume(req.principal?.userId ?? req.ip ?? 'unknown');
    if (!r.allowed) throw tooManyRequests('Slow down: too many requests.', r.resetMs / 1000);
    next();
  };

  // Credential attempts share the strict limiter; reads (the session check every page load makes) the general one.
  const authLimit = limit(authLimiter);
  const generalLimit = limit(general);
  api.use('/auth', (req, res, next) => (req.method === 'GET' ? generalLimit(req, res, next) : authLimit(req, res, next)), authRoutes(s));
  // Sprint 26a (B-1801, B-1802): sign-up, verification and invitation links, behind the same limiter as sign-in.
  api.use('/auth', signupPublicRoutes(s));
  // 1.9.0, Sprint 55 (B-189): sign-in with a member certificate forwarded by a trusted TLS proxy (same limiter).
  api.use('/auth', certificateSignInRoutes(s));
  api.use(generalLimit);
  api.use('/me', meRoutes(s));
  // 1.5.0, Sprint 30 (B-3101): app passwords for DAV clients.
  api.use('/me', appPasswordRoutes(s));
  api.use(pushDeviceRoutes(s)); // 1.9.0, Sprint 49 (B-150): /me/devices and an admin's view of a person's devices
  api.use(notificationPrefRoutes(s)); // 1.9.0, Sprint 49 (B-153): /me/notification-preferences, /admin/notification-defaults
  api.use('/admin', identityAdminRoutes(s));
  api.use('/admin', scimAdminRoutes(s)); // 1.6.0, Sprint 37c (B-7201): SCIM tokens and status
  api.use('/admin', userAdminRoutes(s));
  api.use('/admin', auditAdminRoutes(s));
  api.use('/admin', tenantAdminRoutes(s));
  api.use('/admin', usageAdminRoutes(s));
  api.use('/admin', analyticsAdminRoutes(s)); // 1.6.0, Sprint 38a (B-7401, B-7402)
  api.use('/admin', inventoryAdminRoutes(s)); // 1.6.0, Sprint 38a (B-7301, B-7302)
  api.use('/admin', gatewayAdminRoutes(s));
  api.use(chatRoutes(s));
  api.use(chatCapabilityRoutes(s));
  api.use(guardrailRoutes(s));
  api.use(guardrailTestRoutes(s)); // 1.9.0, Sprint 50 (B-155): rule-set tests
  api.use(guardrailTermRoutes(s)); // 1.9.0, Sprint 50 (B-156): named term lists
  api.use('/admin', registryAdminRoutes(s));
  // 1.6.0 Sprint 38b: red-team suites (B-7001) and agent identities (B-7701).
  api.use('/admin', redTeamRoutes(s));
  api.use('/admin', agentIdentityRoutes(s));
  api.use('/admin', mcpAdminRoutes(s));
  api.use(mcpAccessRoutes(s)); // 1.6.0, Sprint 37b (B-7101 to B-7103): MCP server admin, held calls, client OAuth
  api.use(agentRoutes(s));
  api.use(chainRoutes(s));
  api.use(scriptRoutes(s));
  api.use(workflowOperationRoutes(s)); // 1.5.0, Sprint 32b: triggers, dead letters, bundles (before :id routes)
  api.use(workflowAutomationRoutes(s)); // 1.8.0, Sprint 46 (B-130, B-135): webhook triggers, run retention
  api.use(workflowBuilderRoutes(s)); // 1.8.0, Sprint 47 (B-136, B-138, B-139): templates, schedule previews, analytics
  api.use(workflowTagRoutes(s)); // 1.8.0, Sprint 47 (B-137): tags and favourites
  api.use(designLockRoutes(s)); // 1.8.0, Sprint 47 (B-140): presence and edit locks in the designers
  api.use(workflowRoutes(s));
  api.use(decisionRoutes(s)); // Sprint 46 (B-131): decision tables
  api.use(mediaRoutes(s));
  api.use(imageRoutes(s));
  api.use('/admin', connectionAdminRoutes(s));
  api.use('/admin', connectionSourceAdminRoutes(s)); // 1.8.0, Sprint 45 (B-125, B-126): saved queries, REST connections
  api.use(connectionSourceRoutes(s)); // 1.8.0, Sprint 45: their read API (connections:query)
  api.use(knowledgeRoutes(s));
  api.use(docsRoutes(s)); // 2.0.x: the Docs portal (documentation sites over knowledge bases)
  api.use(knowledgeRevisionRoutes(s));
  api.use(knowledgeFeedbackRoutes(s)); // 1.8.0, Sprint 48 (B-149): knowledge feedback and the reference tree
  api.use(memoryRoutes(s));
  api.use(trainingRoutes(s));
  api.use('/admin', zoneAdminRoutes(s));
  api.use('/admin', cloudAdminRoutes(s)); // 1.9.99-final, Sprint 56 (B-10002, B-10007 to B-10009): cloud accounts
  api.use('/admin', cloudFederationRoutes(s)); // 1.9.99-final, Sprint 56 (B-10003 to B-10006): federation issuer and credentials
  api.use('/admin', cloudDeploymentRoutes(s)); // 1.9.99-final, Sprint 57 (B-10102 to B-10105): deployments, plans, journal, verify
  api.use('/admin', cloudDeploymentSpecRoutes(s)); // 1.9.99-final, Sprint 57 (B-10201, B-10202, B-10601): deployment specs, network, estimates
  api.use('/admin', cloudLifecycleRoutes(s)); // 1.9.99-final, Sprint 57 (B-10106, B-10107): drift, destroy, rollback, orphans
  api.use('/admin', cloudDbMoveRoutes(s)); // 1.9.99-final, Sprint 59 (B-10302): moving this install's database, under dual control
  api.use('/admin', cloudReleaseRoutes(s)); // 1.9.99-final, Sprint 58 (B-10203, B-10207): releases, upgrades, snapshots and restores
  api.use('/admin', cloudBudgetRoutes(s)); // 1.9.99-final, Sprint 58 (B-10602): budgets, alerts, the hard stop and overrides
  api.use('/admin', cloudEdgeRoutes(s)); // 1.9.99-final, Sprint 61 (B-10901 to B-10904): the Cloudflare front door
  api.use('/admin', cloudDatabaseRoutes(s)); // 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): managed databases, extensions, snapshots, restores
  api.use('/admin', cloudDataRoutes(s)); // 1.9.99-final, Sprint 59 (B-10306): discovered databases and stores as data connections
  api.use('/admin', cloudGpuPoolRoutes(s)); // 1.9.99-final, Sprint 60 (B-10401, B-10404): GPU pools of cloud deployments, enrolment tokens, boot timings
  api.use('/admin', cloudModelRoutes(s)); // 1.9.99-final, Sprint 60 (B-10503): DigitalOcean GenAI agents as registry tools
  api.use('/admin', cloudAiGatewayRoutes(s)); // 1.9.99-final, Sprint 61 (B-10908): Cloudflare AI Gateway in front of cloud model instances
  api.use('/admin', cloudAutoscaleRoutes(s)); // 1.9.99-final, Sprint 60 (B-10402, B-10403, B-10406, B-10605): Pools' cloud card, scaling, GPU savings
  api.use('/admin', cloudCostRoutes(s)); // 1.9.99-final, Sprint 59 (B-10603): ingested cloud costs, estimate against actual, fetch now
  api.use('/admin', cloudShowbackRoutes(s)); // 1.9.99-final, Sprint 61 (B-10604): showback per workspace and tenant, rules, CSV, statement setting
  api.use('/admin', cloudAnomalyRoutes(s)); // 1.9.99-final, Sprint 62 (B-10606, B-10607): spend anomalies and the Cloud spend overview
  api.use('/admin', cloudModelImportRoutes(s)); // 1.9.99-final, Sprint 60 (B-10504): the cloud catalogue import and cloud model entries
  api.use('/admin', cloudModelGovernanceRoutes(s)); // 1.9.99-final, Sprint 61 (B-10505 to B-10508): model prices, attestations, the Bedrock Guardrail, model cards
  api.use('/admin', platformAdminRoutes(s));
  api.use('/admin', leakedPasswordRoutes(s)); // 1.9.0, Sprint 55 (B-192 to B-195): Platform › Leaked passwords
  api.use('/admin', operationsAdminRoutes(s)); // 1.6.0 (B-4202, B-4203): Overview, Jobs and queues
  api.use('/admin', overviewCardRoutes(s)); // 1.8.0, Sprint 48 (B-148): each admin's Overview cards
  api.use('/admin', platformVaultRoutes(s)); // 1.7.0 (B-9201, B-9205): the vault's platform scope
  api.use('/admin', vaultSealAdminRoutes(s)); // 1.8.0 (B-145): the emergency seal under dual control
  api.use('/admin', securityScanRoutes(s)); // 1.8.0 (B-144): security scan results, the gate's policy and exceptions
  api.use(pushRoutes(s)); // 1.9.0 (B-151 to B-154): push providers, test sends, the delivery log, the Web Push key
  api.use('/admin', platformSettingsRoutes(s)); // 1.6.0, Sprint 35c (B-4205): Configuration
  api.use('/admin', storageAdminRoutes(s)); // 1.6.0, Sprint 35c (B-4204): Storage
  api.use('/admin', federationAdminRoutes(s));
  api.use('/admin', signinPolicyRoutes(s)); // 1.9.0 (B-190, B-191): Identity › Sign-in policy, OAuth client settings
  // Sprint 13: integrations.
  api.use(sharingRoutes(s));
  api.use(promptRoutes(s));
  api.use('/admin', integrationAdminRoutes(s));
  api.use('/admin', billingPlanRoutes(s)); // 1.9.0, Sprint 51 (B-162, B-166): plans, subscriptions, statement PDF (before /statements/:month)
  api.use(featureFlagRoutes(s)); // 1.9.0, Sprint 52 (B-167 to B-169): /admin/feature-flags and /me/flags
  api.use('/admin', billingAdminRoutes(s));
  // Sprint 22 (B-1405): zone NetworkPolicies applied in-cluster.
  api.use('/admin', zoneClusterRoutes(s));
  // Sprint 24 (B-1701 to B-1703): the secrets vault.
  api.use(vaultRoutes(s));
  api.use(complianceRoutes(s)); // 1.6.0, Sprint 38c (B-7601 to B-7603): DLP, legal holds, compliance exports
  // Sprint 24 (B-1601 to B-1603): the certificate authority.
  // 1.9.0, Sprint 55 (B-187 to B-189): CA settings, CA tokens and member certificates, before the CA's router (its
  // /pki prefix asks for pki:manage, and token validation needs only pki:tokens).
  api.use(pkiSettingsRoutes(s));
  api.use(caTokenRoutes(s));
  api.use(memberCertRoutes(s));
  api.use(pkiRoutes(s));
  // 1.4.0, Sprint 24c: the event catalogue (B-2001) and plugins (B-2002).
  api.use(eventRoutes(s));
  api.use('/admin', pluginAdminRoutes(s));
  api.use('/admin', pluginDraftRoutes(s)); // 1.8.0, Sprint 48 (B-147): the plugin creator's drafts
  api.use(pluginSurfaceRoutes(s)); // 1.7.0 (B-11202): plugin UI surfaces and their bridge
  // 1.6.0 (B-4206): Social and messaging: workspace policies, digests, legal-hold exports, realtime counts.
  api.use('/admin', socialAdminRoutes(s));
  // 1.4.0, Sprint 25c (B-1704): database leases from the built-in engines.
  api.use(vaultLeaseRoutes(s));
  api.use(vaultApiKeyRoutes(s)); // 1.7.0 (B-9301, B-9302): dynamic API-key leases
  // Sprint 25 (B-1608 to B-1611): AT-Protocol identities, keys, labels and trusted labelers.
  api.use(atprotoRoutes(s));
  // Sprint 26 (B-1807, B-1808): users' AT-Protocol DIDs and handles.
  api.use(atprotoAccountRoutes(s));
  // 1.4.0, Sprint 26d (B-2401 to B-2405): the file store.
  // 2.0.0: editable documents, copies, knowledge links and CIDs, then reports and dashboards, ahead of `/files/:id`.
  api.use(fileDocumentRoutes(s));
  // Files: the table builder (Power Query style queries over spreadsheets, CSV and JSON).
  api.use(fileQueryRoutes(s));
  api.use(fileLocationRoutes(s));
  api.use(fileImportRoutes(s));
  api.use(fileReportRoutes(s));
  api.use(fileRoutes(s));
  api.use(albumRoutes(s)); // 1.9.0, Sprint 53 (B-177 to B-179): albums, their links, and a group's albums
  // Sprint 26 (B-1901 to B-1907): moderation checks, reports, actions, appeals, sanctions, queues and providers.
  api.use(moderationSpamRoutes(s)); // 1.9.0, Sprint 50 (B-158 to B-161): spam and flood, moderation metrics
  api.use(moderationRoutes(s));
  // 1.4.0, Sprint 27: low-code apps (B-2201 to B-2208)
  api.use(appRoutes(s));
  api.use(appEntityApiRoutes(s)); // 1.6.0, Sprint 39d (B-8601 to B-8603, B-8701, B-8702): after the app's own routes
  // Sprint 26a (B-1801 to B-1803, B-1805): invitations, trusted devices, signup and MFA policies, CSV imports.
  api.use(identityPolicyRoutes(s));
  // Sprint 27 (B-1908): AT-Protocol firehose subscriptions.
  api.use(firehoseRoutes(s));
  // 1.5.0, Sprint 31 (B-3001 to B-3003): custom feed generators over the firehose.
  api.use(atprotoFeedRoutes(s));
  // Sprint 27c (B-2501 to B-2505): groups, posts, events, RSVPs, reminders and calendar feeds.
  api.use(groupRoutes(s));
  api.use(groupGovernanceRoutes(s)); // 1.9.0, Sprint 53 (B-174 to B-176): proposals, voting, decisions, budget
  // Sprint 28a (B-2301 to B-2304): customer-service channels, sessions, held replies, exports.
  api.use(channelRoutes(s));
  api.use(slaRoutes(s)); // Sprint 46 (B-134): SLA policies, routing, skills, item state and statistics
  // Sprint 28b (B-2606 with B-2702): blocks, mutes, follows, lists and contact rules.
  api.use(socialRoutes(s));
  // 1.5.0, Sprint 34c (B-5801, B-5802): profiles and presence.
  api.use(peopleRoutes(s));
  // Sprint 28b (B-2601 to B-2605): person-to-person messaging.
  api.use(messagingRoutes(s));
  // Sprint 28c (B-2701 to B-2705): the workspace feed.
  api.use(feedRoutes(s));
  // 1.9.0, Sprint 52 (B-170 to B-173): search across chats, posts and every source; the index's administration.
  api.use(searchRoutes(s));
  // 1.5.0, Sprint 29 (B-3301 to B-3305): role and effective-access matrices, custom roles and access reviews.
  api.use(authzRoutes(s));
  // 1.5.0, Sprint 31 (B-2901 to B-2905, B-3004): PDS hosting, accounts, invites, app passwords and feed records.
  api.use(pdsRoutes(s));
  // 1.5.0, Sprint 30 (B-3801 to B-3803): import repositories, catalogue browse and model import
  api.use(importRoutes(s));
  api.use(() => {
    throw notFound('API route');
  });
  // Sprint 16: anonymous share links, signed-out and sessionless, ahead of the authenticated API.
  // Sprint 26d (B-2402): anonymous file links, on the same rules.
  // Sprint 28a (B-2301, B-2303): customer sessions and mail webhooks (first: the webhooks read their raw body).
  app.use('/api/public', publicChannelRoutes(s));
  app.use('/api/public', publicFileRoutes(s));
  app.use('/api/public', publicAppRoutes(s));
  // 1.8.0, Sprint 44 (B-124): the signed unsubscribe link of delivery emails (the signature is the credential).
  app.use('/api/public', appSubscriptionPublicRoutes(s));
  // 1.6.0, Sprint 39d (B-8701, B-8702): embed pages and their public endpoints (/embed/..., /api/public/embeds/...).
  app.use(appEmbedPublicRoutes(s));
  // 1.9.0, Sprint 53 (B-178): album share links and upload links (before the catch-all of the sharing routes).
  app.use('/api/public', publicAlbumRoutes(s));
  app.use('/api/public', publicSharingRoutes(s));
  app.use('/api', api);

  // Console: static files, and the single page for everything else.
  const webRoot = path.resolve(s.cfg.WEB_ROOT);
  if (existsSync(path.join(webRoot, 'index.html'))) {
    app.use(express.static(webRoot, { index: 'index.html', maxAge: s.cfg.NODE_ENV === 'production' ? '1h' : 0, fallthrough: true }));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));
  }

  app.use(errorHandler(s));
  return app;
}

export function errorHandler(s: Pick<Services, 'log'>): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let problem: HttpProblem;
    if (err instanceof HttpProblem) problem = err;
    else if (err instanceof ZodError) problem = badRequest('The request did not validate.', { errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    else if ((err as { type?: string }).type === 'entity.parse.failed') problem = badRequest('The body is not valid JSON.');
    else if ((err as { type?: string }).type === 'entity.too.large') problem = new HttpProblem(413, 'Payload too large', 'The request body is too large.');
    else {
      s.log.error({ err, trace_id: req.traceId }, 'unhandled error');
      problem = new HttpProblem(500, 'Internal error', 'Something went wrong on our side. Quote the trace id if you report it.');
    }
    if (res.headersSent) {
      // A streamed response failed part-way: no problem body can follow, so end the connection now rather than
      // leave the client waiting for the request timeout.
      if (err instanceof HttpProblem) s.log.warn({ status: problem.status, detail: problem.detail, trace_id: req.traceId }, 'error after the response started');
      if (!res.writableEnded) res.destroy();
      return;
    }
    for (const [k, v] of Object.entries(problem.headers)) res.setHeader(k, v);
    const body = problem.toBody(req.traceId, req.originalUrl) as { detail?: unknown };
    // Sprint 18 (B-907): credentials in a detail (a URL with a password, password=...) never reach the client.
    if (typeof body.detail === 'string') body.detail = scrubSecrets(body.detail);
    res.status(problem.status).type('application/problem+json').send(JSON.stringify(body));
  };
}
