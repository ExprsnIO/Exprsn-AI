import { Readable } from 'node:stream';
import { createHttpHeaders, type HttpClient, type PipelineRequest, type PipelineResponse } from '@azure/core-rest-pipeline';
import type { HttpHandlerOptions, HttpRequest as SmithyRequest, HttpResponse as SmithyResponse } from '@smithy/types';
import type { CloudTransport } from './transport.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101): the SDKs' way into `CloudTransport`. The AWS SDK v3 takes `smithyHandler` as
 * every client's `requestHandler`, the Azure clients take `azureHttpClient` as their `httpClient`; neither SDK builds
 * its own HTTP client, so no SDK request bypasses the egress guard or the rate limiter.
 */

/**
 * A request handler for the AWS SDK v3 (`requestHandler` on every client): the SDK builds and signs the request, and
 * this sends it through `CloudTransport.send`, so no SDK call bypasses the egress guard or the rate limiter.
 */
export function smithyHandler(t: CloudTransport, accountId: string) {
  return {
    metadata: { handlerProtocol: 'http/1.1' },
    destroy(): void {},
    updateHttpClientConfig(): void {},
    httpHandlerConfigs(): Record<string, never> {
      return {};
    },
    async handle(request: SmithyRequest, options?: HttpHandlerOptions): Promise<{ response: SmithyResponse }> {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(request.query ?? {})) {
        if (v == null) parts.push(rfc3986(k));
        else for (const one of Array.isArray(v) ? v : [v]) parts.push(`${rfc3986(k)}=${rfc3986(one)}`);
      }
      const query = parts.join('&');
      const host = request.hostname.includes(':') && !request.hostname.startsWith('[') ? `[${request.hostname}]` : request.hostname;
      const url = new URL(`${request.protocol}//${host}${request.port ? `:${request.port}` : ''}${request.path}${query ? `?${query}` : ''}`);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers)) if (k.toLowerCase() !== 'expect' && k.toLowerCase() !== 'content-length') headers[k.toLowerCase()] = v;
      const body = await bodyBytes(request.body);
      const signal = options?.abortSignal as AbortSignal | undefined;
      const res = await t.send({ method: request.method, url, headers, ...(body ? { body } : {}), accountId, ...(signal && 'addEventListener' in signal ? { signal } : {}) });
      return { response: { statusCode: res.status, reason: '', headers: res.headers, body: Readable.from([res.body]) } };
    }
  };
}

const rfc3986 = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function bodyBytes(body: unknown): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string') return body.length ? Buffer.from(body) : undefined;
  if (body instanceof Uint8Array) return body.length ? Buffer.from(body) : undefined;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }
  throw new Error('This request body type is not sent through the cloud transport.');
}

/**
 * An `httpClient` for the Azure SDK clients: the pipeline (token, headers, its redirect policy) runs as usual, and
 * every request it makes goes through `CloudTransport.send`.
 */
export function azureHttpClient(t: CloudTransport, accountId: string): HttpClient {
  return {
    async sendRequest(request: PipelineRequest): Promise<PipelineResponse> {
      const headers: Record<string, string> = {};
      for (const [k, v] of request.headers) if (k.toLowerCase() !== 'content-length') headers[k.toLowerCase()] = v;
      const body = await azureBody(request.body);
      const signal = request.abortSignal as AbortSignal | undefined;
      const res = await t.send({ method: request.method, url: request.url, headers, ...(body ? { body } : {}), accountId, ...(signal ? { signal } : {}) });
      return { request, status: res.status, headers: createHttpHeaders(res.headers), bodyAsText: res.body.toString('utf8') };
    }
  };
}

async function azureBody(body: PipelineRequest['body']): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'function') return bodyBytes((body as () => unknown)());
  return bodyBytes(body);
}
