import { createSocket, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { DnsProvider } from '../src/ops/dns.js';

/**
 * A tiny authoritative DNS server on 127.0.0.1 (UDP) that answers TXT queries from a map, for the ACME server's
 * dns-01 validation (the real `node:dns` resolver is pointed at it with PKI_ACME_DNS_SERVERS). Unknown names get
 * NXDOMAIN. `provider` is a DnsProvider that writes into the same map, as an operator's DNS hook would.
 */
export interface FakeDns {
  address: string;
  txt: Map<string, string[]>;
  queries: string[];
  provider: DnsProvider;
  close(): Promise<void>;
}

function readName(msg: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let p = offset;
  while (msg[p]! !== 0) {
    const len = msg[p]!;
    labels.push(msg.subarray(p + 1, p + 1 + len).toString('ascii'));
    p += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), next: p + 1 };
}

export async function startFakeDns(): Promise<FakeDns> {
  const txt = new Map<string, string[]>();
  const queries: string[] = [];
  const socket: Socket = createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    if (msg.length < 12) return;
    const id = msg.readUInt16BE(0);
    const { name, next } = readName(msg, 12);
    const qtype = msg.readUInt16BE(next);
    const question = msg.subarray(12, next + 4);
    queries.push(`${name}/${qtype}`);
    const records = qtype === 16 ? (txt.get(name) ?? []) : [];
    const known = txt.has(name);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x8400 | 0x0100 | (known ? 0 : 3), 2); // response, authoritative, RD echoed, NXDOMAIN when unknown
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(records.length, 6);
    const answers = records.map((value) => {
      const data = Buffer.from(value, 'utf8');
      const rdata = Buffer.concat([Buffer.from([data.length]), data]);
      const rr = Buffer.alloc(12);
      rr.writeUInt16BE(0xc00c, 0); // pointer to the question name
      rr.writeUInt16BE(16, 2);
      rr.writeUInt16BE(1, 4);
      rr.writeUInt32BE(30, 6);
      rr.writeUInt16BE(rdata.length, 10);
      return Buffer.concat([rr, rdata]);
    });
    socket.send(Buffer.concat([header, question, ...answers]), rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const port = (socket.address() as AddressInfo).port;
  const fqdn = (domain: string) => `_acme-challenge.${domain.replace(/^\*\./, '')}`.toLowerCase();
  return {
    address: `127.0.0.1:${port}`,
    txt,
    queries,
    provider: {
      name: 'fake DNS',
      present: async (domain, value) => void txt.set(fqdn(domain), [...(txt.get(fqdn(domain)) ?? []), value]),
      cleanup: async (domain, value) => {
        const left = (txt.get(fqdn(domain)) ?? []).filter((v) => v !== value);
        if (left.length) txt.set(fqdn(domain), left);
        else txt.delete(fqdn(domain));
      }
    },
    close: () => new Promise((resolve) => socket.close(() => resolve()))
  };
}
