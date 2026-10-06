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
import { identityAdminRoutes } from '../routes/admin/identity.js';
import { userAdminRoutes } from '../routes/admin/users.js';
import { auditAdminRoutes } from '../routes/admin/audit.js';
import { tenantAdminRoutes } from '../routes/admin/tenants.js';
import { usageAdminRoutes } from '../routes/admin/usage.js';
import { gatewayAdminRoutes } from '../routes/admin/gateway.js';
import { chatRoutes } from '../routes/chat.js';
import { guardrailRoutes } from '../routes/guardrails.js';
import { registryAdminRoutes } from '../routes/admin/registry.js';
import { mcpAdminRoutes } from '../routes/admin/mcp.js';
import { agentRoutes } from '../routes/agents.js';
import { chainRoutes } from '../routes/chains.js';
import { scriptRoutes } from '../routes/scripts.js';
import { workflowRoutes } from '../routes/workflows.js';
import { workflowOperationRoutes } from '../routes/workflow-operations.js';
import { mediaRoutes } from '../routes/media.js';
import { imageRoutes } from '../routes/images.js';
import { knowledgeRoutes } from '../routes/knowledge.js';
import { memoryRoutes } from '../routes/memory.js';
import { connectionAdminRoutes } from '../routes/admin/connections.js';
import { trainingRoutes } from '../routes/training.js';
import { zoneAdminRoutes } from '../routes/admin/zones.js';
import { acmeChallengeRoutes, platformAdminRoutes } from '../routes/admin/platform.js';
import { federationAdminRoutes } from '../routes/admin/federation.js';
import { federationPublicRoutes } from '../routes/federation-public.js';
import { integrationPublicRoutes } from '../routes/integrations-public.js';
import { trainerWorkerRoutes } from '../routes/trainer-worker.js';
import { openAiRoutes } from '../openai/routes.js';
import { sharingRoutes } from '../routes/sharing.js';
import { promptRoutes } from '../routes/prompts.js';
import { integrationAdminRoutes } from '../routes/admin/integrations.js';
import { billingAdminRoutes } from '../routes/admin/billing.js';
import { vaultRoutes } from '../routes/vault.js';
import { vaultLeaseRoutes } from '../routes/vault-leases.js';
import { pkiRoutes } from '../routes/pki.js';
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
import { calendarPublicRoutes, groupRoutes } from '../routes/groups.js';
import { socialRoutes } from '../routes/social.js';
import { messagingRoutes } from '../routes/messaging.js';
import { feedRoutes } from '../routes/feed.js';
import type { Services } from '../services.js';
import { Limiter } from '../platform/ratelimit.js';
import { publicSharingRoutes } from '../routes/sharing-public.js';
import { mediaHostGuard, mediaOriginRoutes } from '../media/origin.js';
import { sendBytes } from '../routes/media.js';
import { authenticate, csrfProtection, noStore } from './middleware.js';
import { eventRoutes } from '../routes/events.js';
import { pluginAdminRoutes } from '../routes/admin/plugins.js';
import { pluginBrokerRoutes } from '../routes/plugin-broker.js';
import { fileRoutes, publicFileRoutes } from '../routes/files.js';
import { appRoutes } from '../routes/apps.js';
import { publicAppRoutes } from '../routes/apps-public.js';
import { channelRoutes } from '../routes/channels.js';
import { publicChannelRoutes } from '../routes/channels-public.js';
import { authzRoutes } from '../routes/authz.js';
import { davRoutes } from '../dav/handler.js';
import { appPasswordRoutes } from '../dav/routes.js';
import { importRoutes } from '../routes/imports.js';
import { badRequest, HttpProblem, notFound, tooManyRequests } from './problem.js';

export interface AppState {
  shuttingDown: boolean;
}

export function createApp(s: Services, state: AppState = { shuttingDown: false }): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', s.cfg.TRUST_PROXY === 'true' ? true : s.cfg.TRUST_PROXY === 'false' ? false : s.cfg.TRUST_PROXY);
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

  app.use(healthRoutes(s, state));
  app.use(mediaOriginRoutes(s, sendBytes));
  // OIDC, SAML and device-flow protocol endpoints: public paths with their own parsing and checks.
  app.use(federationPublicRoutes(s));
  // ACME http-01: the internal CA fetches the key authorization for orders in flight (public, text/plain).
  app.use(acmeChallengeRoutes(s));
  // Sprint 19: published webhook signing keys and the Stripe webhook (public; signatures are the authentication).
  app.use(integrationPublicRoutes(s));
  // Sprint 18 (B-905): the training worker's callbacks (run keys, artefacts), grant tokens only.
  app.use(trainerWorkerRoutes(s));
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

  // API: JSON only, small bodies, authenticated per request, CSRF-checked for cookie sessions.
  const api = express.Router();
  // API answers carry per-user data: never stored by the browser or an intermediary (routes may override).
  api.use(noStore);
  const json = express.json({ limit: '256kb', strict: true });
  // Attachment uploads carry the raw file (of any type, JSON included) and are parsed by their route.
  api.use((req, res, next) => (req.method === 'PUT' && (req.path === '/attachments' || req.path === '/media/assets' || /^\/knowledge\/bases\/[^/]+\/uploads$/.test(req.path) || /^\/admin\/platform\/bundles\/[^/]+\/transfer$/.test(req.path) || /^\/files\/(uploads|[^/]+\/content)$/.test(req.path)) ? next() : json(req, res, next)));
  api.use(authenticate(s));
  api.use(csrfProtection(s));

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
  api.use(generalLimit);
  api.use('/me', meRoutes(s));
  // 1.5.0, Sprint 30 (B-3101): app passwords for DAV clients.
  api.use('/me', appPasswordRoutes(s));
  api.use('/admin', identityAdminRoutes(s));
  api.use('/admin', userAdminRoutes(s));
  api.use('/admin', auditAdminRoutes(s));
  api.use('/admin', tenantAdminRoutes(s));
  api.use('/admin', usageAdminRoutes(s));
  api.use('/admin', gatewayAdminRoutes(s));
  api.use(chatRoutes(s));
  api.use(guardrailRoutes(s));
  api.use('/admin', registryAdminRoutes(s));
  api.use('/admin', mcpAdminRoutes(s));
  api.use(agentRoutes(s));
  api.use(chainRoutes(s));
  api.use(scriptRoutes(s));
  api.use(workflowOperationRoutes(s)); // 1.5.0, Sprint 32b: triggers, dead letters, bundles (before :id routes)
  api.use(workflowRoutes(s));
  api.use(mediaRoutes(s));
  api.use(imageRoutes(s));
  api.use('/admin', connectionAdminRoutes(s));
  api.use(knowledgeRoutes(s));
  api.use(memoryRoutes(s));
  api.use(trainingRoutes(s));
  api.use('/admin', zoneAdminRoutes(s));
  api.use('/admin', platformAdminRoutes(s));
  api.use('/admin', federationAdminRoutes(s));
  // Sprint 13: integrations.
  api.use(sharingRoutes(s));
  api.use(promptRoutes(s));
  api.use('/admin', integrationAdminRoutes(s));
  api.use('/admin', billingAdminRoutes(s));
  // Sprint 22 (B-1405): zone NetworkPolicies applied in-cluster.
  api.use('/admin', zoneClusterRoutes(s));
  // Sprint 24 (B-1701 to B-1703): the secrets vault.
  api.use(vaultRoutes(s));
  // Sprint 24 (B-1601 to B-1603): the certificate authority.
  api.use(pkiRoutes(s));
  // 1.4.0, Sprint 24c: the event catalogue (B-2001) and plugins (B-2002).
  api.use(eventRoutes(s));
  api.use('/admin', pluginAdminRoutes(s));
  // 1.4.0, Sprint 25c (B-1704): database leases from the built-in engines.
  api.use(vaultLeaseRoutes(s));
  // Sprint 25 (B-1608 to B-1611): AT-Protocol identities, keys, labels and trusted labelers.
  api.use(atprotoRoutes(s));
  // Sprint 26 (B-1807, B-1808): users' AT-Protocol DIDs and handles.
  api.use(atprotoAccountRoutes(s));
  // 1.4.0, Sprint 26d (B-2401 to B-2405): the file store.
  api.use(fileRoutes(s));
  // Sprint 26 (B-1901 to B-1907): moderation checks, reports, actions, appeals, sanctions, queues and providers.
  api.use(moderationRoutes(s));
  // 1.4.0, Sprint 27: low-code apps (B-2201 to B-2208)
  api.use(appRoutes(s));
  // Sprint 26a (B-1801 to B-1803, B-1805): invitations, trusted devices, signup and MFA policies, CSV imports.
  api.use(identityPolicyRoutes(s));
  // Sprint 27 (B-1908): AT-Protocol firehose subscriptions.
  api.use(firehoseRoutes(s));
  // 1.5.0, Sprint 31 (B-3001 to B-3003): custom feed generators over the firehose.
  api.use(atprotoFeedRoutes(s));
  // Sprint 27c (B-2501 to B-2505): groups, posts, events, RSVPs, reminders and calendar feeds.
  api.use(groupRoutes(s));
  // Sprint 28a (B-2301 to B-2304): customer-service channels, sessions, held replies, exports.
  api.use(channelRoutes(s));
  // Sprint 28b (B-2606 with B-2702): blocks, mutes, follows, lists and contact rules.
  api.use(socialRoutes(s));
  // Sprint 28b (B-2601 to B-2605): person-to-person messaging.
  api.use(messagingRoutes(s));
  // Sprint 28c (B-2701 to B-2705): the workspace feed.
  api.use(feedRoutes(s));
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
