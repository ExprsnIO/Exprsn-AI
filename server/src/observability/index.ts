import { randomBytes } from 'node:crypto';
import pino, { type Logger } from 'pino';
import client from 'prom-client';

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    base: { service: 'exprsn-ai' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["proxy-authorization"]',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.bindPassword',
        '*.secret',
        '*.token',
        '*.code'
      ],
      censor: '[redacted]'
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } } : {})
  });
}

/** Query parameters that carry credentials or one-time codes in protocol flows (OAuth, SAML, device, upstream). */
const SECRET_PARAMS = new Set(['code', 'state', 'token', 'access_token', 'id_token', 'refresh_token', 'client_secret', 'code_verifier', 'user_code', 'device_code', 'samlrequest', 'samlresponse', 'relaystate', 'h', 'password', 'key', 'signature']);

/** A request URL for the logs: the values of credential-bearing query parameters are replaced. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  if (q < 0) return url;
  const parts = url.slice(q + 1).split('&').map((kv) => {
    const eq = kv.indexOf('=');
    const name = eq < 0 ? kv : kv.slice(0, eq);
    let key = name;
    try {
      key = decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      /* keep the raw name */
    }
    return eq >= 0 && SECRET_PARAMS.has(key.toLowerCase()) ? `${name}=[redacted]` : kv;
  });
  return `${url.slice(0, q)}?${parts.join('&')}`;
}

/** The pino-http request serializer's output with credential-bearing query values removed from url and query. */
export function redactRequest<T extends { url?: string; query?: Record<string, unknown> }>(req: T): T {
  req.url = redactUrl(req.url);
  if (req.query && typeof req.query === 'object') {
    const q: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.query)) q[k] = SECRET_PARAMS.has(k.toLowerCase()) ? '[redacted]' : v;
    req.query = q;
  }
  return req;
}

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;

/** Uses the W3C traceparent trace id when a caller sends one, otherwise starts a new trace. */
export function traceIdFrom(traceparent: string | undefined): string {
  const m = traceparent ? TRACEPARENT.exec(traceparent.trim()) : null;
  if (m?.[1] && !/^0+$/.test(m[1])) return m[1];
  return randomBytes(16).toString('hex');
}

export class Metrics {
  readonly registry = new client.Registry();
  readonly httpDuration: client.Histogram<'method' | 'route' | 'status'>;
  readonly logins: client.Counter<'result' | 'kind'>;
  readonly socketConnections: client.Gauge;

  constructor() {
    client.collectDefaultMetrics({ register: this.registry, prefix: 'exprsn_' });
    this.httpDuration = new client.Histogram({
      name: 'exprsn_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry]
    });
    this.logins = new client.Counter({ name: 'exprsn_logins_total', help: 'Sign-in attempts by result', labelNames: ['result', 'kind'], registers: [this.registry] });
    this.socketConnections = new client.Gauge({ name: 'exprsn_socket_connections', help: 'Open Socket.io connections', registers: [this.registry] });
  }
}
