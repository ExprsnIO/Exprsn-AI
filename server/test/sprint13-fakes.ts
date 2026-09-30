import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A webhook endpoint that records what it receives and answers with `status`. */
export class FakeReceiver {
  status = 200;
  got: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  url = '';
  private readonly server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      this.got.push({ path: req.url ?? '/', headers: req.headers, body });
      res.writeHead(this.status, { 'content-type': 'text/plain' });
      res.end(this.status < 300 ? 'ok' : 'no');
    });
  });

  async start(): Promise<this> {
    this.url = await listen(this.server);
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}

/**
 * Enough of Stripe's REST API for the invoice push: `POST /v1/invoiceitems` and `POST /v1/invoices`, form-encoded,
 * with bearer auth. Repeated idempotency keys return the first answer, as Stripe does.
 */
export class FakeStripe {
  key = 'sk_test_fake';
  items: Record<string, string>[] = [];
  invoices: Record<string, string>[] = [];
  requests: { path: string; idempotencyKey: string | undefined; form: Record<string, string> }[] = [];
  failInvoices = false;
  url = '';
  private readonly seen = new Map<string, unknown>();
  private readonly server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(raw));
      const key = req.headers['idempotency-key'] as string | undefined;
      this.requests.push({ path: req.url ?? '', idempotencyKey: key, form });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${this.key}`) return send(401, { error: { message: 'Invalid API Key provided' } });
      if (key && this.seen.has(key)) return send(200, this.seen.get(key));
      let out: unknown;
      if (req.method === 'POST' && req.url === '/v1/invoiceitems') {
        this.items.push(form);
        out = { id: `ii_${this.items.length}`, object: 'invoiceitem', ...form };
      } else if (req.method === 'POST' && req.url === '/v1/invoices') {
        if (this.failInvoices) return send(402, { error: { message: 'The customer has no payment method.' } });
        this.invoices.push(form);
        out = { id: `in_${this.invoices.length}`, object: 'invoice', status: 'draft' };
      } else return send(404, { error: { message: 'Unrecognized request URL' } });
      if (key) this.seen.set(key, out);
      send(200, out);
    });
  });

  async start(): Promise<this> {
    this.url = await listen(this.server);
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}
