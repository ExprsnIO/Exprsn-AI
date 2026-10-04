import express, { Router, type RequestHandler } from 'express';
import { notFound, tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import { fromPem, pem } from '../pki/asn1.js';
import { ocspError, OCSP_STATUS } from '../pki/ocsp.js';
import type { Services } from '../services.js';
import { acmePublicRoutes } from './acme-public.js';

/*
 * The certificate authority's public endpoints (Sprint 24), mounted at the root outside /api: no session, no CSRF,
 * no bearer tokens (the platform's CA bearer tokens and open /ca sockets are not carried over). Everything served
 * is signed, so the responses are their own authentication. Each address is rate-limited (PKI_PUBLIC_RATE_PER_MINUTE).
 *
 *   GET  /pki/crl/<issuer>.crl | .pem    the issuer's current CRL (B-1603)
 *   GET  /pki/ca/<issuer>.crt | .pem     the issuer's certificate (the caIssuers URL in issued certificates)
 *   POST /pki/ocsp                       OCSP (RFC 6960), application/ocsp-request (B-1604)
 *   GET  /pki/ocsp/<base64 request>      OCSP by GET (RFC 6960 A.1), cacheable when the request has no nonce
 *   /pki/acme/<tenant>/...               the ACME server (Sprint 25, B-1605; `acme-public.ts`)
 */

const FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.(crl|crt|pem)$/;
const MAX_OCSP_BYTES = 16 * 1024;

export function pkiPublicRoutes(s: Services): Router {
  const r = Router();
  const limiter = new Limiter(s.counters, 'pki-public', s.cfg.PKI_PUBLIC_RATE_PER_MINUTE, 60_000);
  const limit: RequestHandler = async (req, _res, next) => {
    const l = await limiter.consume(req.ip ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many requests to the certificate authority from this address.', l.resetMs / 1000);
    next();
  };
  r.use('/pki', limit);
  // Sprint 25 (B-1605): the ACME server, behind the same per-address limit.
  r.use(acmePublicRoutes(s));

  r.get('/pki/crl/:file', async (req, res) => {
    const m = FILE_RE.exec(String(req.params.file));
    if (!m || m[2] === 'crt') throw notFound('CRL');
    const crl = await s.pki.currentCrl(m[1]!);
    if (!crl) throw notFound('CRL');
    const der = Buffer.from(crl.der, 'base64');
    res.setHeader('Cache-Control', `public, max-age=${Math.max(0, Math.min(3600, Math.floor((crl.next_update - Date.now()) / 1000)))}`);
    res.setHeader('Last-Modified', new Date(crl.this_update).toUTCString());
    if (m[2] === 'pem') res.type('application/x-pem-file').send(pem(der, 'X509 CRL'));
    else res.type('application/pkix-crl').send(der);
  });

  r.get('/pki/ca/:file', async (req, res) => {
    const m = FILE_RE.exec(String(req.params.file));
    if (!m || m[2] === 'crl') throw notFound('Certificate');
    const issuer = await s.pki.issuer(m[1]!);
    if (!issuer) throw notFound('Certificate');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (m[2] === 'pem') res.type('application/x-pem-file').send(issuer.certificate_pem);
    else res.type('application/pkix-cert').send(fromPem(issuer.certificate_pem, 'CERTIFICATE'));
  });

  const answer = async (der: Buffer, res: express.Response, viaGet: boolean) => {
    const out = await s.pki.ocsp(der);
    res.setHeader('Cache-Control', viaGet && out.cacheable && out.maxAge > 0 ? `public, max-age=${out.maxAge}, no-transform, must-revalidate` : 'no-store');
    res.type('application/ocsp-response').send(out.body);
  };

  r.post('/pki/ocsp', express.raw({ type: () => true, limit: MAX_OCSP_BYTES }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) {
      res.type('application/ocsp-response').send(ocspError(OCSP_STATUS.malformedRequest));
      return;
    }
    await answer(body, res, false);
  });

  // RFC 6960 A.1: GET {url}/{url-encoding of base-64 encoding of the DER encoding of the OCSPRequest}. The base64
  // can hold '/', so the request is everything after /pki/ocsp/.
  r.get('/pki/ocsp/*request', async (req, res) => {
    const parts = (req.params as { request?: string[] | string }).request;
    const b64 = (Array.isArray(parts) ? parts.join('/') : String(parts ?? '')).replace(/ /g, '+');
    if (!b64 || b64.length > (MAX_OCSP_BYTES * 4) / 3 + 4 || !/^[A-Za-z0-9+/=_-]+$/.test(b64)) {
      res.type('application/ocsp-response').send(ocspError(OCSP_STATUS.malformedRequest));
      return;
    }
    await answer(Buffer.from(b64, b64.includes('-') || b64.includes('_') ? 'base64url' : 'base64'), res, true);
  });

  return r;
}
