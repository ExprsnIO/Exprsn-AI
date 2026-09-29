import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { Config } from './config/index.js';
import { SecretBox } from './crypto/index.js';
import type { Db } from './db/knex.js';
import { AuditLog } from './audit/chain.js';
import { IdentityChain } from './identity/chain.js';
import { SessionService } from './identity/sessions.js';
import { ApiKeyService } from './identity/apikeys.js';
import { MfaService } from './identity/mfa.js';
import { LoginThrottle } from './identity/lockout.js';
import { ProviderRepo } from './repos/providers.js';
import { TenantRepo } from './repos/tenants.js';
import { UserRepo } from './repos/users.js';
import { Metrics } from './observability/index.js';

export interface Services {
  cfg: Config;
  db: Db;
  log: Logger;
  metrics: Metrics;
  events: EventEmitter;
  audit: AuditLog;
  tenants: TenantRepo;
  users: UserRepo;
  providers: ProviderRepo;
  chain: IdentityChain;
  sessions: SessionService;
  apiKeys: ApiKeyService;
  mfa: MfaService;
  throttle: LoginThrottle;
}

/** Events other components react to (the realtime layer disconnects sockets of revoked sessions). */
export const EVENTS = { sessionsRevoked: 'sessions.revoked', usersChanged: 'users.changed' } as const;

export function createServices(cfg: Config, db: Db, log: Logger, metrics = new Metrics()): Services {
  const events = new EventEmitter();
  const providers = new ProviderRepo(db);
  return {
    cfg,
    db,
    log,
    metrics,
    events,
    audit: new AuditLog(db),
    tenants: new TenantRepo(db),
    users: new UserRepo(db),
    providers,
    chain: new IdentityChain(db, providers, log, cfg.NODE_ENV === 'production'),
    sessions: new SessionService(
      db,
      { secret: cfg.SESSION_SECRET, idleMinutes: cfg.SESSION_IDLE_MINUTES, absoluteHours: cfg.SESSION_ABSOLUTE_HOURS, pendingMinutes: cfg.MFA_PENDING_MINUTES },
      (ids) => events.emit(EVENTS.sessionsRevoked, ids)
    ),
    apiKeys: new ApiKeyService(db, cfg.SESSION_SECRET),
    mfa: new MfaService(db, new SecretBox(cfg.DATA_KEY), { issuer: 'Exprsn-AI', rpId: cfg.WEBAUTHN_RP_ID, rpName: cfg.WEBAUTHN_RP_NAME, origin: cfg.ORIGIN, secret: cfg.SESSION_SECRET }),
    throttle: new LoginThrottle(db, { maxAttempts: cfg.LOCKOUT_MAX_ATTEMPTS, windowMinutes: cfg.LOCKOUT_WINDOW_MINUTES, durationMinutes: cfg.LOCKOUT_DURATION_MINUTES })
  };
}
