import type { TLSSocket } from 'node:tls';
import { Router, type Request, type Response } from 'express';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import type { WorkerCaller } from '../training/worker.js';

/**
 * The endpoints the training worker calls back (contract 2, B-905), mounted at the root outside `/api`: they take no
 * session, only the bearer token of a grant (and the worker's client certificate when TRAINER_CLIENT_CERT_SHA256 is
 * set). The certificate is read from this server's TLS socket, or from `X-Client-Cert-SHA256` when the request came
 * through a proxy that TRUST_PROXY trusts (the proxy terminates mTLS and forwards the verified fingerprint).
 */
export function trainerWorkerRoutes(s: Services): Router {
  const r = Router();

  const caller = (req: Request): WorkerCaller => {
    const auth = req.headers.authorization ?? '';
    const token = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(auth)?.[1] ?? null;
    let certSha256: string | null = null;
    const sock = req.socket as TLSSocket;
    if (typeof sock.getPeerCertificate === 'function' && sock.authorized) certSha256 = sock.getPeerCertificate()?.fingerprint256 ?? null;
    if (!certSha256) {
      const trust = req.app.get('trust proxy fn') as ((addr: string | undefined, i: number) => boolean) | undefined;
      const h = req.headers['x-client-cert-sha256'];
      if (trust?.(req.socket.remoteAddress, 0) && typeof h === 'string') certSha256 = h;
    }
    return { token, certSha256, ip: req.ip ?? null };
  };

  const noStore = (_req: Request, res: Response, next: () => void) => {
    res.setHeader('cache-control', 'no-store');
    next();
  };

  r.post('/trainer/v1/keys/:grant', noStore, async (req, res) => {
    res.json(await s.training.worker.releaseKey(String(req.params.grant), caller(req)));
  });

  r.put('/trainer/v1/artifacts/:grant/:name', noStore, async (req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : 'other';
    res.status(201).json(await s.training.worker.putArtifact(String(req.params.grant), String(req.params.name), kind, req as AsyncIterable<Buffer>, caller(req)));
  });

  r.get('/trainer/v1/artifacts/:grant/:name', noStore, async (req, res) => {
    const a = await s.training.worker.getArtifact(String(req.params.grant), String(req.params.name), caller(req));
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(a.bytes));
    res.setHeader('x-artifact-sha256', a.sha256);
    try {
      for await (const c of a.stream) if (!res.write(c)) await new Promise((ok) => res.once('drain', ok));
      await a.done();
      res.end();
    } catch (err) {
      // Headers are out: the worker sees a cut connection, never a complete body that failed authentication.
      if (!res.headersSent) throw err;
      res.destroy(err as Error);
    }
  });

  r.all('/trainer/v1/*path', () => {
    throw new HttpProblem(404, 'Not found', 'No such training worker endpoint.');
  });

  return r;
}
