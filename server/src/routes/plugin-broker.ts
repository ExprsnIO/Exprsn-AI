import express, { Router } from 'express';
import { z } from 'zod';
import { parseBody } from '../http/middleware.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';

/**
 * The plugin broker over HTTP (B-2004), mounted at the root outside `/api`: no session, only the short-lived scoped
 * token of one handler run (`Authorization: Bearer xpt_…`). A handler in the default sandbox has no network and makes
 * the same calls over its stdin and stdout (`plugins/sandbox.ts`); this route is the same broker for a sandbox that
 * can reach the server. Every call is checked against the plugin's grants: an ungranted one is 403 and audited.
 */
export function pluginBrokerRoutes(s: Services): Router {
  const r = Router();
  r.post('/plugin-broker/v1/calls/:api', express.json({ limit: '256kb', strict: true }), async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const token = /^Bearer\s+(xpt_[A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new HttpProblem(401, 'Unauthorized', 'A plugin token is required (Authorization: Bearer xpt_…).');
    const api = parseBody(z.string().regex(/^[a-z][a-z.]{1,40}$/), req.params.api);
    const args = parseBody(z.record(z.string(), z.unknown()), req.body ?? {});
    const out = await s.pluginRuntime.brokerCall(token, api, args);
    if (out.status >= 400) throw new HttpProblem(out.status, out.status === 403 ? 'Forbidden' : out.status === 401 ? 'Unauthorized' : out.status === 429 ? 'Too many requests' : out.status === 404 ? 'Not found' : 'Refused', out.detail ?? 'Refused.');
    res.json(out.body ?? {});
  });
  return r;
}
