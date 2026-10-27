import { Router } from 'express';
import { z } from 'zod';
import { compileFormula, FormulaError, formulaCatalogue, MAX_FORMULA_LENGTH } from '../apps/formula.js';
import { parseBody, requireAnyPermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const fieldName = z.string().min(1).max(63);

/**
 * 1.8.0 (B-141): the formula library for the entity designer's formula editor. Mounted inside `routes/apps.ts` before
 * `/apps/:app`, behind its `/apps` guards. Both routes read nothing of the tenant: the catalogue is the server's own
 * list, and a check parses an expression against the field names it is given, the same check an entity save makes.
 * Either `apps:design` (the designer) or `records:read` (people reading AI prompts and formulas) may ask.
 */
export function appFormulaRoutes(s: Services): Router {
  const r = Router();
  const may = requireAnyPermission(s, ['apps:design', 'records:read']);

  r.get('/apps/formula-functions', may, (_req, res) => {
    res.json({ functions: formulaCatalogue(), maxLength: MAX_FORMULA_LENGTH });
  });

  r.post('/apps/formula-check', may, (req, res) => {
    const body = parseBody(z.object({ expression: z.string().max(MAX_FORMULA_LENGTH + 1), fields: z.array(fieldName).max(500).default([]) }).strict(), req.body);
    // A check answers 200 either way: a formula that does not parse is the answer, not a failed request.
    try {
      const f = compileFormula(body.expression, new Set(body.fields));
      res.json({ ok: true, refs: f.refs });
    } catch (err) {
      if (err instanceof FormulaError) res.json({ ok: false, message: err.message });
      else throw err;
    }
  });

  return r;
}
