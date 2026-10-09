import { matches, parsePatchPath, ScimFilterError, type Filter } from './filter.js';
import { canonical, definitionsFor, type AttrDef } from './schemas.js';

/*
 * The writable document of a SCIM resource and the PATCH operations on it (RFC 7644 section 3.5.2).
 *
 * `normalise` keeps the attributes the schemas define, with their canonical spelling (names are case-insensitive),
 * coerces "True" and "False" for boolean attributes (Entra ID sends them as strings), drops read-only and write-only
 * ones and nulls (null means unassigned), and keeps one primary value per multi-valued attribute. `applyPatch` runs the
 * operations in order on a copy: add, replace and remove (case-insensitive, as Entra ID writes them), with or without
 * a path, with value filters (`emails[type eq "work"].value`, `members[value eq "…"]`). One lenience, for Entra ID: a
 * replace or add through a value filter that matches nothing adds an element built from the filter's `eq` terms.
 */

export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly scimType: string | null,
    message: string
  ) {
    super(message);
  }
}

export type Doc = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface SchemaSet {
  core: string;
  extensions: string[];
}

const defsFor = (set: SchemaSet, urn: string | null): AttrDef[] | null => {
  if (!urn) return definitionsFor(set.core);
  return set.extensions.find((e) => e.toLowerCase() === urn.toLowerCase()) ? definitionsFor(urn) : null;
};

function coerce(def: AttrDef, v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (def.type === 'boolean') {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
    throw new ScimError(400, 'invalidValue', `${def.name} is a boolean.`);
  }
  if (def.type === 'complex') {
    if (!isObj(v)) throw new ScimError(400, 'invalidValue', `${def.name} is a complex attribute (an object).`);
    const out: Doc = {};
    for (const [k, x] of Object.entries(v)) {
      const sd = canonical(def.subAttributes ?? [], k);
      if (!sd || sd.mutability === 'readOnly') continue;
      const c = coerce(sd, x);
      if (c !== undefined) out[sd.name] = c;
    }
    return out;
  }
  if (def.type === 'integer' || def.type === 'decimal') {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isNaN(n)) throw new ScimError(400, 'invalidValue', `${def.name} is a number.`);
    return n;
  }
  if (typeof v === 'object') throw new ScimError(400, 'invalidValue', `${def.name} is a single value, not an object or a list.`);
  return String(v).slice(0, 4096);
}

/** One attribute's value as stored: multi-valued ones are arrays with at most one primary. */
function value(def: AttrDef, v: unknown): unknown {
  if (def.multiValued) {
    if (v === null || v === undefined) return undefined;
    const list = (Array.isArray(v) ? v : [v]).map((x) => coerce(def, x)).filter((x) => x !== undefined) as unknown[];
    let primarySeen = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (isObj(it) && it.primary === true) {
        if (primarySeen) it.primary = false;
        primarySeen = true;
      }
    }
    return list.slice(0, 1000);
  }
  return coerce(def, v);
}

/** The writable document from a request body (POST or PUT). */
export function normalise(body: Doc, set: SchemaSet): Doc {
  const out: Doc = {};
  const core = definitionsFor(set.core);
  for (const [k, v] of Object.entries(body)) {
    const ext = set.extensions.find((e) => e.toLowerCase() === k.toLowerCase());
    if (ext) {
      if (!isObj(v)) continue;
      const box: Doc = {};
      for (const [ek, ev] of Object.entries(v)) {
        const d = canonical(definitionsFor(ext), ek);
        if (!d || d.mutability === 'readOnly' || d.mutability === 'writeOnly') continue;
        const x = value(d, ev);
        if (x !== undefined) box[d.name] = x;
      }
      if (Object.keys(box).length) out[ext] = box;
      continue;
    }
    const d = canonical(core, k);
    if (!d || d.mutability === 'readOnly' || d.mutability === 'writeOnly') continue;
    const x = value(d, v);
    if (x !== undefined) out[d.name] = x;
  }
  return out;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The element a value filter's `eq` terms describe, for an add through a filter that matched nothing. */
function fromFilter(f: Filter): Doc | null {
  if (f.kind === 'cmp' && f.op === 'eq' && !f.path.sub && !f.path.urn) return { [f.path.attr]: f.value };
  if (f.kind === 'and') {
    const l = fromFilter(f.left);
    const r = fromFilter(f.right);
    return l && r ? { ...l, ...r } : null;
  }
  return null;
}

const sameValue = (a: unknown, b: unknown): boolean => isObj(a) && isObj(b) && a.value !== undefined && String(a.value) === String(b.value);

interface Op {
  op: string;
  path?: string;
  value?: unknown;
}

function target(doc: Doc, set: SchemaSet, urn: string | null, create: boolean): { box: Doc | null; defs: AttrDef[] } {
  const defs = defsFor(set, urn);
  if (!defs) throw new ScimError(400, 'invalidPath', `${urn} is not a schema of this resource.`);
  if (!urn) return { box: doc, defs };
  const ext = set.extensions.find((e) => e.toLowerCase() === urn.toLowerCase())!;
  if (!isObj(doc[ext])) {
    if (!create) return { box: null, defs };
    doc[ext] = {};
  }
  return { box: doc[ext] as Doc, defs };
}

function addValue(box: Doc, d: AttrDef, v: unknown, mode: 'add' | 'replace'): void {
  const x = value(d, v);
  if (x === undefined) {
    if (mode === 'replace') delete box[d.name];
    return;
  }
  if (d.multiValued) {
    const incoming = x as unknown[];
    if (mode === 'replace') box[d.name] = incoming;
    else {
      const cur = Array.isArray(box[d.name]) ? (box[d.name] as unknown[]) : [];
      for (const it of incoming) if (!cur.some((c) => sameValue(c, it) || JSON.stringify(c) === JSON.stringify(it))) cur.push(it);
      box[d.name] = value(d, cur);
    }
  } else if (d.type === 'complex' && isObj(box[d.name])) box[d.name] = { ...(box[d.name] as Doc), ...(x as Doc) };
  else box[d.name] = x;
}

/** Applies one PATCH request's operations to a copy of `doc`. */
export function applyPatch(doc: Doc, ops: unknown, set: SchemaSet): Doc {
  if (!Array.isArray(ops) || !ops.length) throw new ScimError(400, 'invalidSyntax', 'A PATCH request carries Operations: a list of add, replace and remove.');
  const out = clone(doc);
  for (const raw of ops.slice(0, 1000) as Op[]) {
    if (!isObj(raw) || typeof raw.op !== 'string') throw new ScimError(400, 'invalidSyntax', 'Each operation has an op.');
    const op = raw.op.toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw new ScimError(400, 'invalidSyntax', `"${raw.op.slice(0, 20)}" is not add, replace or remove.`);
    const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : null;
    if (!path) {
      if (op === 'remove') throw new ScimError(400, 'noTarget', 'A remove names a path.');
      if (!isObj(raw.value)) throw new ScimError(400, 'invalidValue', `An ${op} without a path carries an object of attributes.`);
      for (const [k, v] of Object.entries(raw.value)) {
        // Okta echoes the id (and some providers schemas and meta) in the value: set by the server, ignored here.
        if (['id', 'meta', 'schemas'].includes(k.toLowerCase())) continue;
        // Some providers write a path as the key (`name.givenName`, or an extension URN with its attributes).
        const ext = set.extensions.find((e) => e.toLowerCase() === k.toLowerCase());
        if (ext && isObj(v)) {
          for (const [ek, ev] of Object.entries(v)) applyPath(out, set, op, `${ext}:${ek}`, ev);
        } else applyPath(out, set, op, k, v);
      }
      continue;
    }
    applyPath(out, set, op, path, raw.value);
  }
  return out;
}

function applyPath(doc: Doc, set: SchemaSet, op: 'add' | 'replace' | 'remove', path: string, v: unknown): void {
  let pp;
  try {
    pp = parsePatchPath(path);
  } catch (err) {
    if (err instanceof ScimFilterError) throw new ScimError(400, 'invalidPath', err.message);
    throw err;
  }
  const lname = pp.path.attr.toLowerCase();
  if (!pp.path.urn && (lname === 'id' || lname === 'meta' || lname === 'schemas')) {
    if (lname === 'schemas') return; // providers echo it; nothing to change
    throw new ScimError(400, 'mutability', `${pp.path.attr} is set by the server.`);
  }
  const { box, defs } = target(doc, set, pp.path.urn, op !== 'remove');
  const d = canonical(defs, pp.path.attr);
  if (!d) {
    if (op === 'remove') return;
    throw new ScimError(400, 'invalidPath', `${path.slice(0, 200)} is not an attribute of this resource.`);
  }
  if (d.mutability === 'readOnly') throw new ScimError(400, 'mutability', `${d.name} is read only.`);
  if (d.mutability === 'writeOnly') return; // password: not kept
  if (!box) return;
  const sub = pp.path.sub ? canonical(d.subAttributes ?? [], pp.path.sub) : null;
  if (pp.path.sub && !sub) throw new ScimError(400, 'invalidPath', `${pp.path.sub} is not a sub-attribute of ${d.name}.`);
  if (sub?.mutability === 'readOnly') throw new ScimError(400, 'mutability', `${d.name}.${sub.name} is read only.`);

  if (pp.filter) {
    if (!d.multiValued) throw new ScimError(400, 'invalidPath', `${d.name} is not multi-valued; a value filter does not apply.`);
    const list = Array.isArray(box[d.name]) ? (box[d.name] as Doc[]) : [];
    const hit = list.filter((el) => isObj(el) && matches(el, pp.filter!));
    if (op === 'remove') {
      if (sub) for (const el of hit) delete el[sub.name];
      else box[d.name] = list.filter((el) => !hit.includes(el));
      if (Array.isArray(box[d.name]) && !(box[d.name] as unknown[]).length) delete box[d.name];
      return;
    }
    if (!hit.length) {
      const base = fromFilter(pp.filter);
      if (!base) throw new ScimError(400, 'noTarget', `No value of ${d.name} matches the filter.`);
      const el = sub ? { ...base, [sub.name]: v } : { ...base, ...(isObj(v) ? v : {}) };
      box[d.name] = value(d, [...list, el]);
      return;
    }
    for (const el of hit) {
      if (sub) {
        const x = coerce(sub, v);
        if (x === undefined) delete el[sub.name];
        else el[sub.name] = x;
      } else if (isObj(v)) Object.assign(el, coerce(d, v) as Doc);
      else throw new ScimError(400, 'invalidValue', `Replacing a value of ${d.name} takes an object.`);
    }
    box[d.name] = value(d, list);
    return;
  }

  if (sub) {
    if (d.multiValued) throw new ScimError(400, 'invalidPath', `Name the value of ${d.name} with a filter, such as ${d.name}[type eq "work"].${sub.name}.`);
    const cur = isObj(box[d.name]) ? (box[d.name] as Doc) : {};
    if (op === 'remove') delete cur[sub.name];
    else {
      const x = coerce(sub, v);
      if (x === undefined) delete cur[sub.name];
      else cur[sub.name] = x;
    }
    if (Object.keys(cur).length) box[d.name] = cur;
    else delete box[d.name];
    return;
  }

  if (op === 'remove') {
    // Entra ID removes members by sending them as the value of a remove on `members`.
    if (d.multiValued && v !== undefined && v !== null) {
      const drop = (Array.isArray(v) ? v : [v]).filter(isObj);
      const list = Array.isArray(box[d.name]) ? (box[d.name] as unknown[]) : [];
      box[d.name] = list.filter((el) => !drop.some((x) => sameValue(el, x)));
      if (!(box[d.name] as unknown[]).length) delete box[d.name];
    } else delete box[d.name];
    return;
  }
  addValue(box, d, v, op);
}
