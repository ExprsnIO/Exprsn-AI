import { Ajv, type ValidateFunction } from 'ajv';
import { canonicalJson, sha256 } from '../crypto/index.js';

/**
 * JSON Schema handling for tool inputs and outputs: validity of a schema itself (checked at submission), argument and
 * result validation at call time, and the hash approvals record. One Ajv instance; compiled validators are cached by
 * the schema's canonical form, so a changed schema is compiled afresh.
 */
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const cache = new Map<string, ValidateFunction>();

export type JsonSchema = Record<string, unknown>;

function compile(schema: JsonSchema): ValidateFunction {
  const key = canonicalJson(schema);
  let v = cache.get(key);
  if (!v) {
    v = ajv.compile(schema);
    if (cache.size > 500) cache.clear();
    cache.set(key, v);
  }
  return v;
}

/** Problems with a schema as a JSON Schema document, or an empty list. `root` names what the schema describes. */
export function schemaProblems(schema: unknown, root: 'input' | 'output'): string[] {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) return [`The ${root} schema must be a JSON object.`];
  const s = schema as JsonSchema;
  const out: string[] = [];
  if (root === 'input' && s.type !== 'object') out.push('The input schema must describe an object ("type": "object"), as tool arguments are named.');
  if (s.properties !== undefined && (typeof s.properties !== 'object' || Array.isArray(s.properties))) out.push(`The ${root} schema's "properties" must be an object.`);
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string')) out.push(`The ${root} schema's "required" must be a list of property names.`);
    else {
      const props = Object.keys((s.properties as object | undefined) ?? {});
      for (const r of s.required as string[]) if (!props.includes(r)) out.push(`"${r}" is required but not described in the ${root} schema's properties.`);
    }
  }
  if (!ajv.validateSchema(s)) out.push(...(ajv.errors ?? []).map((e) => `${root} schema${e.instancePath || ''}: ${e.message ?? 'invalid'}`));
  else {
    try {
      compile(s);
    } catch (err) {
      out.push(`The ${root} schema does not compile: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Validates a value against a schema; returns readable errors, or an empty list when it matches. */
export function validateAgainst(schema: JsonSchema | null | undefined, value: unknown): string[] {
  if (!schema) return [];
  let v: ValidateFunction;
  try {
    v = compile(schema);
  } catch (err) {
    return [`The schema does not compile: ${(err as Error).message}`];
  }
  if (v(value)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`.trim());
}

/** The hash an approval records: everything a model or a caller relies on, in canonical JSON. */
export function schemaHash(parts: { name: string; description?: string | null; inputSchema?: unknown; outputSchema?: unknown; sideEffect?: string | null; annotations?: unknown }): string {
  return sha256(canonicalJson({ name: parts.name, description: parts.description ?? null, inputSchema: parts.inputSchema ?? null, outputSchema: parts.outputSchema ?? null, sideEffect: parts.sideEffect ?? null, annotations: parts.annotations ?? null }));
}

/** Ollama function names allow letters, digits, `_` and `-`; registry names may also carry dots and colons. */
export const functionName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
