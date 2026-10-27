import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An external moderation provider double (B-1906) speaking the `json` wire format: it flags any input containing
 * `EXTERNALBAD`, records what it was sent (and the Authorization header), and fails with 500 while `failing` is set.
 * Listens on 127.0.0.1.
 */
export class FakeModerationProvider {
  readonly calls: { input: string; type: string | null; auth: string | null }[] = [];
  failing = false;
  private server: Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (this.failing) {
          res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"down"}');
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { input?: string; type?: string };
        const input = String(body.input ?? '');
        this.calls.push({ input, type: body.type ?? null, auth: req.headers.authorization ?? null });
        const flagged = input.includes('EXTERNALBAD');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ flagged, score: flagged ? 0.97 : 0.02, categories: flagged ? ['harassment'] : [] }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/moderate`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
