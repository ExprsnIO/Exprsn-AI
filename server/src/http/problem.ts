/**
 * RFC 9457 problem details. Every error the API returns is one of these, carrying the request's trace id
 * so the UI can show it (UI.problem) and support can find the request in logs and the audit chain.
 */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  trace_id?: string;
  [ext: string]: unknown;
}

export class HttpProblem extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly extensions: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    title: string,
    detail?: string,
    opts: { type?: string; extensions?: Record<string, unknown>; headers?: Record<string, string> } = {}
  ) {
    super(detail ?? title);
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.type = opts.type ?? `https://exprsn.ai/problems/${slug(title)}`;
    this.extensions = opts.extensions ?? {};
    this.headers = opts.headers ?? {};
  }

  toBody(traceId?: string, instance?: string): ProblemBody {
    return {
      ...this.extensions,
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(instance ? { instance } : {}),
      ...(traceId ? { trace_id: traceId } : {})
    };
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const badRequest = (detail: string, ext?: Record<string, unknown>) =>
  new HttpProblem(400, 'Invalid request', detail, { extensions: ext ?? {} });
export const unauthorized = (detail = 'Sign in to continue.') => new HttpProblem(401, 'Unauthorized', detail);
export const forbidden = (detail: string, ext?: Record<string, unknown>) =>
  new HttpProblem(403, 'Forbidden', detail, { extensions: ext ?? {} });
export const notFound = (what = 'Resource') => new HttpProblem(404, 'Not found', `${what} not found.`);
export const conflict = (detail: string) => new HttpProblem(409, 'Conflict', detail);
export const tooManyRequests = (detail: string, retryAfterSeconds: number) =>
  new HttpProblem(429, 'Too many requests', detail, {
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    extensions: { retry_after: Math.max(1, Math.ceil(retryAfterSeconds)) }
  });
