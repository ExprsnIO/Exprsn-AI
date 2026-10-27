/*
 * Form layouts in the browser (follow-up 2 of docs/decisions/lowcode-port.md): sections, wizard steps and the
 * `visibleIf` / `requiredIf` condition trees of an app form. This is a line-by-line mirror of
 * server/src/apps/form-layout.ts (`conditionMatches`, `layoutOf`, `planForm`), loaded by the console (index.html),
 * the public form page (/form) and the embed page (/embed/<id>). It only decides what to show and what to ask for;
 * the server evaluates the same conditions on every submission, drops hidden fields and enforces required ones.
 *
 * `spec` is the shape POST /api/public/forms/open returns: { fields: [{ name, required, visibleIf, requiredIf }],
 * layout: { mode, review, sections: [{ id, fields, visibleIf, requiredIf }], steps: [...] } }. `fromDefinition`
 * turns a stored form definition (the console's draft) into that shape.
 */
(function (global) {
  'use strict';
  const normText = (s) => s.normalize('NFC').toLowerCase();
  const norm = (x) => (typeof x === 'string' ? normText(x) : x);
  const isSet = (v) => v !== undefined && v !== null && v !== '';
  const truthy = (v) => v != null && v !== '' && v !== false && v !== 0;
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function leafMet(l, values) {
    const v = values[l.field];
    const want = l.value;
    switch (l.op) {
      case 'truthy': return truthy(v);
      case 'falsy': return !truthy(v);
      case 'exists': return isSet(v);
      case 'not_exists': return !isSet(v);
      case 'eq': return norm(v) === norm(want);
      case 'ne': return norm(v) !== norm(want);
      case 'in': return Array.isArray(want) && want.map(norm).indexOf(norm(v)) >= 0;
      case 'not_in': return Array.isArray(want) && want.map(norm).indexOf(norm(v)) < 0;
      case 'contains':
      case 'not_contains': {
        const w = norm(want);
        const hit = Array.isArray(v) ? v.some((x) => norm(x) === w) : isSet(v) && isSet(want) && String(norm(v)).indexOf(String(w)) >= 0;
        return l.op === 'contains' ? hit : !hit;
      }
      case 'gt': case 'gte': case 'lt': case 'lte': {
        const a = num(v); const b = num(want);
        if (!isFinite(a) || !isFinite(b)) return false;
        return l.op === 'gt' ? a > b : l.op === 'gte' ? a >= b : l.op === 'lt' ? a < b : a <= b;
      }
      default: return false;
    }
  }

  /** Does a condition match the answers so far? No condition matches. */
  function matches(c, values) {
    if (!c) return true;
    if (Array.isArray(c.all)) return c.all.every((x) => matches(x, values));
    if (Array.isArray(c.any)) return c.any.some((x) => matches(x, values));
    if (Array.isArray(c.none)) return !c.none.some((x) => matches(x, values));
    return leafMet(c, values);
  }

  /** The layout a form is shown with: its own, or one untitled section `main` with every field. */
  function layoutOf(spec) {
    const l = spec.layout;
    if (!l || !l.sections || !l.sections.length) return { mode: 'sections', review: false, sections: [{ id: 'main', title: null, fields: spec.fields.map((f) => f.name) }], steps: [] };
    const wizard = l.mode === 'wizard';
    return { mode: wizard ? 'wizard' : 'sections', review: wizard && !!l.review, sections: l.sections, steps: wizard ? (l.steps || []) : [] };
  }
  function stepsOf(l) { return l.mode === 'wizard' ? l.steps : [{ id: '_page', title: 'Form', sections: l.sections.map((s) => s.id) }]; }

  /**
   * One pass in layout order: per field its step, section, visibility and whether it is required; the answers a
   * submission keeps (visible fields only); the visible steps; the required fields still without an answer.
   */
  function plan(spec, input) {
    const l = layoutOf(spec);
    const byName = {}; spec.fields.forEach((f) => { byName[f.name] = f; });
    const secs = {}; l.sections.forEach((s) => { secs[s.id] = s; });
    const values = {}; const fields = []; const steps = [];
    stepsOf(l).forEach((step) => {
      const stepShown = matches(step.visibleIf, values);
      const stepRequired = !!step.requiredIf && stepShown && matches(step.requiredIf, values);
      if (stepShown) steps.push(step.id);
      step.sections.forEach((sid) => {
        const sec = secs[sid]; if (!sec) return;
        const secShown = stepShown && matches(sec.visibleIf, values);
        const secRequired = !!sec.requiredIf && secShown && matches(sec.requiredIf, values);
        sec.fields.forEach((name) => {
          const ff = byName[name]; if (!ff) return;
          const visible = secShown && matches(ff.visibleIf, values);
          const required = visible && (!!ff.required || stepRequired || secRequired || (!!ff.requiredIf && matches(ff.requiredIf, values)));
          fields.push({ field: name, step: step.id, section: sec.id, visible, required });
          if (visible && has(input, name)) values[name] = input[name];
        });
      });
    });
    const missing = fields.filter((f) => f.required && (values[f.field] == null || values[f.field] === ''));
    return { values, fields, steps, missing, visible: fields.filter((f) => f.visible).map((f) => f.field), layout: l };
  }

  /** A stored definition (fields with `field`) as the open/describe shape (fields with `name`). */
  function fromDefinition(def) {
    return { fields: (def.fields || []).map((f) => ({ name: f.field, required: !!f.required, visibleIf: f.visibleIf || null, requiredIf: f.requiredIf || null })), layout: def.layout || null };
  }

  const OPS = [
    { value: 'eq', label: 'equals' }, { value: 'ne', label: 'does not equal' }, { value: 'gt', label: 'greater than' }, { value: 'gte', label: 'at least' },
    { value: 'lt', label: 'less than' }, { value: 'lte', label: 'at most' }, { value: 'contains', label: 'contains' }, { value: 'not_contains', label: 'does not contain' },
    { value: 'exists', label: 'is set' }, { value: 'not_exists', label: 'is not set' }, { value: 'truthy', label: 'is true' }, { value: 'falsy', label: 'is false' },
    { value: 'in', label: 'is one of' }, { value: 'not_in', label: 'is none of' }
  ];
  const opLabel = (o) => { const x = OPS.filter((y) => y.value === o)[0]; return x ? x.label : o; };
  /** A condition in words, for summaries and the review step. */
  function text(c) {
    if (!c) return 'always';
    const g = Array.isArray(c.all) ? 'all' : Array.isArray(c.any) ? 'any' : Array.isArray(c.none) ? 'none' : null;
    if (g) return (g === 'all' ? 'all of' : g === 'any' ? 'any of' : 'none of') + ' (' + c[g].map(text).join('; ') + ')';
    return c.field + ' ' + opLabel(c.op) + (c.value === undefined || c.value === null ? '' : ' ' + (Array.isArray(c.value) ? c.value.join(', ') : String(c.value)));
  }

  global.ExprsnFormLayout = { matches, layoutOf, plan, fromDefinition, text, OPS, NO_VALUE: ['exists', 'not_exists', 'truthy', 'falsy'], LIST_VALUE: ['in', 'not_in'] };
})(typeof window !== 'undefined' ? window : this);
