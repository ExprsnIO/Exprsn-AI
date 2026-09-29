import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { ZodError } from 'zod';
import { traceIdFrom } from '../observability/index.js';
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
import type { Services } from '../services.js';
import { authenticate, csrfProtection } from './middleware.js';
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

  app.use(
    pinoHttp({
      logger: s.log,
      genReqId: (req) => (req as express.Request).traceId,
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
          imgSrc: ["'self'", 'data:'],
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

  app.use(healthRoutes(s, state));

  // API: JSON only, small bodies, authenticated per request, CSRF-checked for cookie sessions.
  const api = express.Router();
  const json = express.json({ limit: '256kb', strict: true });
  // Attachment uploads carry the raw file (of any type, JSON included) and are parsed by their route.
  api.use((req, res, next) => (req.method === 'PUT' && req.path === '/attachments' ? next() : json(req, res, next)));
  api.use(authenticate(s));
  api.use(csrfProtection(s));

  const general = new RateLimiterMemory({ points: 600, duration: 60 });
  const authLimiter = new RateLimiterMemory({ points: 30, duration: 60 });
  const limit = (limiter: RateLimiterMemory): express.RequestHandler => async (req, _res, next) => {
    try {
      await limiter.consume(req.principal?.userId ?? req.ip ?? 'unknown');
      next();
    } catch (r) {
      const ms = (r as { msBeforeNext?: number }).msBeforeNext ?? 1000;
      throw tooManyRequests('Slow down: too many requests.', ms / 1000);
    }
  };

  api.use('/auth', limit(authLimiter), authRoutes(s));
  api.use(limit(general));
  api.use('/me', meRoutes(s));
  api.use('/admin', identityAdminRoutes(s));
  api.use('/admin', userAdminRoutes(s));
  api.use('/admin', auditAdminRoutes(s));
  api.use('/admin', tenantAdminRoutes(s));
  api.use('/admin', usageAdminRoutes(s));
  api.use('/admin', gatewayAdminRoutes(s));
  api.use(chatRoutes(s));
  api.use(guardrailRoutes(s));
  api.use(() => {
    throw notFound('API route');
  });
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

function errorHandler(s: Services): ErrorRequestHandler {
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
    if (res.headersSent) return;
    for (const [k, v] of Object.entries(problem.headers)) res.setHeader(k, v);
    res.status(problem.status).type('application/problem+json').send(JSON.stringify(problem.toBody(req.traceId, req.originalUrl)));
  };
}
