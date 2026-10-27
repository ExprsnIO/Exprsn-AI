/*
 * 1.9.99-final, Sprint 60 (B-10401, B-10404): a cloud GPU node's first boot, played in-process. It is never a real
 * node: it does what the rendered bootstrap (`cloud/gpu-node.ts`) does, against the test server and a fake Ollama.
 *
 *   1. reads its token file (a VM: the user data the adapter sent; a node group: its key of the `exprsn-enrol`
 *      Secret the reconcile job wrote);
 *   2. makes its own P-256 key and a CSR (the key never leaves this object) and enrols with the token;
 *   3. serves the fake Ollama behind an mTLS proxy on 127.0.0.1: its new server certificate, client certificates
 *      only from the CA chain it was given and only with the gateway's SHA-1 fingerprint (as nginx pins it);
 *   4. warms up: each listed model is pulled only when its reference is on the mirror (`mirrorRefProblem`, the rule the
 *      script applies); every other reference is refused and recorded, never pulled.
 */
import { generateKeyPairSync, type KeyObject, X509Certificate } from 'node:crypto';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import request from 'supertest';
import type { Express } from 'express';
import { buildCsr, toPem } from '../src/ops/der.js';
import { ENROL_PATH, mirrorHost, mirrorRefProblem, type EnrolPayload } from '../src/cloud/gpu-node.js';
import type { EnrolResponse } from '../src/cloud/gpu-enrol.js';
import type { FakeOllama } from './fake-ollama.js';

/** The token file content a VM's user data carries (the adapter replaced the placeholder with it). */
export function tokenFromUserData(userData: string): EnrolPayload | null {
  const m = /path: \/run\/exprsn-bootstrap\/enrol\n\s+permissions: '0600'\n\s+content: '(.*)'/.exec(userData);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]!.replace(/''/g, "'")) as Partial<EnrolPayload>;
    return v.token ? (v as EnrolPayload) : null;
  } catch {
    return null;
  }
}

export class FakeGpuNode {
  readonly key: KeyObject;
  server: Server | null = null;
  port = 0;
  enrolled: EnrolResponse | null = null;
  /** References pulled from the mirror, and references refused by the egress guard. */
  readonly pulled: string[] = [];
  readonly refused: string[] = [];
  /** Client certificates the proxy saw (SHA-256), and connections it refused. */
  readonly clients: string[] = [];
  rejected = 0;

  constructor(
    readonly name: string,
    readonly ollama: FakeOllama,
    readonly address = '127.0.0.1'
  ) {
    this.key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  }

  /** Starts the mTLS listener first (its port is part of the enrolment), with a placeholder until enrolled. */
  async listen(): Promise<this> {
    // The port is reserved by a plain listener; the TLS server takes it over once the certificate exists.
    const probe = createHttpsServer();
    await new Promise<void>((r) => probe.listen(0, this.address, r));
    this.port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    return this;
  }

  /** Enrols with the token payload; answers the HTTP status and body (the node does nothing else on a refusal). */
  async enrol(app: Express, payload: Pick<EnrolPayload, 'token'> & Partial<EnrolPayload>, o: { node?: string; bootedAt?: number; address?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const csr = toPem(buildCsr(['gpu-node.invalid'], this.key), 'CERTIFICATE REQUEST');
    const res = await request(app).post(ENROL_PATH).send({ token: payload.token, csr, address: o.address ?? this.address, port: this.port, ...(o.node ?? this.name ? { node: o.node ?? this.name } : {}), ...(o.bootedAt ? { bootedAt: o.bootedAt } : {}) });
    if (res.status === 201) {
      this.enrolled = res.body as EnrolResponse;
      await this.serve();
      this.warmup(payload.mirror ?? this.enrolled.warmup.mirror);
    }
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  private async serve(): Promise<void> {
    const e = this.enrolled!;
    const pin = e.gateway.clientSha1;
    const target = new URL(this.ollama.url);
    this.server = createHttpsServer({ key: this.key.export({ type: 'pkcs8', format: 'pem' }), cert: e.certificate + e.chain.join(''), ca: e.gateway.caChain, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
      const peer = (req.socket as TLSSocket).getPeerCertificate();
      const sha1 = String(peer?.fingerprint ?? '').replace(/:/g, '').toLowerCase();
      if (sha1 !== pin) {
        this.rejected++;
        res.writeHead(403).end();
        return;
      }
      this.clients.push(new X509Certificate(peer.raw).fingerprint256);
      const up = httpRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      req.pipe(up);
    });
    this.server.on('tlsClientError', () => this.rejected++);
    await new Promise<void>((r) => this.server!.listen(this.port, this.address, r));
  }

  /** The bootstrap's warm-up loop: pull from the mirror only. */
  private warmup(mirror: string | null | undefined): void {
    const host = mirror ? (mirror.includes('://') ? mirrorHost(mirror) : mirror.toLowerCase()) : null;
    for (const m of this.enrolled!.warmup.models) {
      if (mirrorRefProblem(host, m.ref)) {
        this.refused.push(m.ref);
        continue;
      }
      this.pulled.push(m.ref);
      this.ollama.addAvailable({ name: m.name, size: 4_000_000_000, ...(m.digest ? { digest: m.digest } : {}) });
    }
  }

  /** What the gateway pulls through this node outside the bootstrap (the fake Ollama's pull requests). */
  pullsSeen(): string[] {
    return this.ollama.requests.filter((r) => r.path === '/api/pull').map((r) => String(r.body.model ?? r.body.name ?? ''));
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise((r) => this.server!.close(r));
    }
  }
}
