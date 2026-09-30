import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MailTransport } from '../src/platform/notifications.js';
import { sha1Hex } from '../src/identity/breached.js';

export interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Records email instead of sending it. `next(to)` waits for the next message to an address. */
export class FakeMail implements MailTransport {
  readonly sent: SentMail[] = [];

  async sendMail(msg: SentMail): Promise<unknown> {
    this.sent.push(msg);
    return { messageId: String(this.sent.length) };
  }

  to(address: string): SentMail[] {
    return this.sent.filter((m) => m.to === address);
  }

  async next(address: string, after = 0, timeoutMs = 2000): Promise<SentMail> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const list = this.to(address);
      if (list.length > after) return list[after]!;
      if (Date.now() > end) throw new Error(`no email to ${address}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/** Pulls the reset token out of a reset, admin or invite email (the link's fragment). */
export const tokenFrom = (mail: SentMail): string => {
  const m = /[#&?]reset=([A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!m) throw new Error('no reset link in the email');
  return m[1]!;
};

/**
 * A stand-in for the Have I Been Pwned range API: GET /range/<5 hex> answers SUFFIX:COUNT lines for the breached
 * passwords it was given, plus padding lines with a zero count. Records every requested path.
 */
export async function fakeHibp(breached: string[]): Promise<{ url: string; paths: string[]; headers: Record<string, string | string[] | undefined>[]; close(): Promise<void> }> {
  const hashes = breached.map(sha1Hex);
  const paths: string[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? '');
    headers.push(req.headers);
    const m = /^\/range\/([0-9A-F]{5})$/.exec(req.url ?? '');
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const lines = hashes.filter((h) => h.startsWith(m[1]!)).map((h) => `${h.slice(5)}:42`);
    // Padding entries (count 0) must never count as breached.
    lines.push('0000000000000000000000000000000000A:0', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0');
    res.writeHead(200, { 'content-type': 'text/plain' }).end(lines.join('\r\n'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, paths, headers, close: () => new Promise((r) => server.close(() => r())) };
}
