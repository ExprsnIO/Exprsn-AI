import YAML, { isAlias, isCollection, isPair, isScalar, type Node } from 'yaml';

/*
 * B-907 (ASVS 5.5): YAML from people (guardrail rules) and from operators (the identity file) is parsed with caps on
 * size, nesting depth and aliases, so a "billion laughs" document (aliases that expand exponentially) or a deeply
 * nested one is refused before it is turned into objects.
 */

export interface YamlLimits {
  /** Bytes of text. */
  maxBytes: number;
  /** Nesting depth of maps and sequences. */
  maxDepth: number;
  /** Alias nodes (`*name`) in the document; 0 refuses any. */
  maxAliases: number;
  /** Nodes in the document. */
  maxNodes: number;
}

export const YAML_LIMITS: YamlLimits = { maxBytes: 1024 * 1024, maxDepth: 32, maxAliases: 0, maxNodes: 100_000 };

export class YamlLimitError extends Error {
  constructor(
    message: string,
    readonly line: number | null = null
  ) {
    super(message);
  }
}

/** Parses YAML within the limits; throws YamlLimitError for a cap and the yaml library's error for bad syntax. */
export function parseYamlSafely(text: string, limits: Partial<YamlLimits> = {}): unknown {
  const l = { ...YAML_LIMITS, ...limits };
  if (Buffer.byteLength(text, 'utf8') > l.maxBytes) throw new YamlLimitError(`The YAML is larger than ${l.maxBytes} bytes.`);
  // Flow collections ([ and {) are nested by the parser recursively: refuse deep ones before it sees them.
  let flow = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]!))) while (i < text.length && text[i] !== '\n') i++;
    else if (c === '[' || c === '{') {
      if (++flow > l.maxDepth) throw new YamlLimitError(`The YAML is nested deeper than ${l.maxDepth} levels.`, text.slice(0, i).split('\n').length);
    } else if (c === ']' || c === '}') flow = Math.max(0, flow - 1);
  }
  // Our count of alias nodes comes first; the library's own alias expansion cap applies again in toJS.
  const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length) throw doc.errors[0]!;
  let aliases = 0;
  let nodes = 0;
  // Iterative walk: a deep document cannot overflow the stack here.
  const stack: { node: unknown; depth: number }[] = [{ node: doc.contents, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (node == null) continue;
    if (++nodes > l.maxNodes) throw new YamlLimitError(`The YAML has more than ${l.maxNodes} nodes.`);
    const line = (n: unknown) => {
      const r = (n as Node).range;
      return r ? text.slice(0, r[0]).split('\n').length : null;
    };
    if (isAlias(node)) {
      if (++aliases > l.maxAliases) throw new YamlLimitError(l.maxAliases === 0 ? 'YAML aliases (*name) are not accepted here.' : `The YAML has more than ${l.maxAliases} aliases.`, line(node));
      continue;
    }
    if (isPair(node)) {
      stack.push({ node: node.key, depth }, { node: node.value, depth });
      continue;
    }
    if (isCollection(node)) {
      if (depth + 1 > l.maxDepth) throw new YamlLimitError(`The YAML is nested deeper than ${l.maxDepth} levels.`, line(node));
      for (const item of node.items) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    if (isScalar(node)) continue;
  }
  return doc.toJS({ maxAliasCount: l.maxAliases === 0 ? 0 : Math.max(l.maxAliases, 1) }) as unknown;
}
