import type { FileFormat } from './types.js';

/*
 * B-3803: format and pickle checks. Only GGUF and safetensors weights cross the import path; a pickle checkpoint
 * (`.bin`, `.pt`, `.pth`, `.pkl`, `.ckpt`, or anything whose bytes are a pickle stream or a zip archive, which is how
 * torch saves them) is refused by name in the wizard and again by its bytes at staging.
 */

const PICKLE_EXT = /\.(bin|pt|pth|pkl|pickle|ckpt|joblib|npy|npz|h5|msgpack)$/i;
const METADATA_EXT = /(^|\/)(config\.json|generation_config\.json|tokenizer\.json|tokenizer_config\.json|special_tokens_map\.json|vocab\.json|vocab\.txt|merges\.txt|added_tokens\.json|preprocessor_config\.json|chat_template\.jinja|tokenizer\.model|spm\.model|sentencepiece\.bpe\.model|model\.safetensors\.index\.json|README\.md|LICENSE(\.md|\.txt)?|USE_POLICY\.md|NOTICE(\.md|\.txt)?|\.gitattributes)$/i;

/** What a file is, by its name (a hub) or its OCI media type (a registry). */
export function formatOf(name: string, mediaType?: string | null): FileFormat {
  if (mediaType) {
    if (mediaType === 'application/vnd.ollama.image.model' || mediaType === 'application/vnd.ollama.image.projector' || mediaType === 'application/vnd.ollama.image.adapter') return 'gguf';
    if (mediaType.startsWith('application/vnd.ollama.image.') || mediaType === 'application/vnd.docker.container.image.v1+json') return 'metadata';
    return 'other';
  }
  if (/\.gguf$/i.test(name)) return 'gguf';
  if (/\.safetensors$/i.test(name)) return 'safetensors';
  if (/\.onnx(_data)?$/i.test(name)) return 'onnx';
  if (PICKLE_EXT.test(name)) return 'pickle';
  if (METADATA_EXT.test(name) || /\.(json|txt|md|jinja|model|py)$/i.test(name)) return name.endsWith('.py') ? 'other' : 'metadata';
  return 'other';
}

export const isWeights = (f: FileFormat) => f === 'gguf' || f === 'safetensors' || f === 'pickle' || f === 'onnx';

/**
 * What the first bytes of a file say it is. A safetensors file starts with an 8-byte little-endian header length and
 * a JSON object; a GGUF file with `GGUF`; a pickle stream with 0x80 and a protocol number; a torch checkpoint is a zip.
 */
export function sniff(head: Buffer): 'gguf' | 'safetensors' | 'pickle' | 'zip' | 'json' | 'text' | 'unknown' {
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'GGUF') return 'gguf';
  if (head.length >= 2 && head[0] === 0x80 && head[1]! >= 1 && head[1]! <= 5) return 'pickle';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) return 'zip';
  if (head.length >= 9) {
    const n = head.readBigUInt64LE(0);
    if (n > 1n && n < 100_000_000n && head[8] === 0x7b) return 'safetensors';
  }
  const t = head.subarray(0, 64).toString('utf8').trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  // Printable text (tokenizer vocabularies, merges, templates, licences).
  if (head.length && head.subarray(0, Math.min(head.length, 512)).every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127) || b >= 0x80)) return 'text';
  return 'unknown';
}

/** Why the bytes of a file do not match what it claims to be, or null when they do. */
export function contentProblem(name: string, format: FileFormat, head: Buffer): string | null {
  const s = sniff(head);
  if (s === 'pickle' || s === 'zip') return `${name} is a pickle checkpoint by its contents (${s === 'zip' ? 'a torch zip archive' : 'a pickle stream'}). Pickle is never imported.`;
  if (format === 'gguf' && s !== 'gguf') return `${name} does not start with the GGUF magic.`;
  if (format === 'safetensors' && s !== 'safetensors') return `${name} is not a safetensors file (no JSON header).`;
  if (format === 'pickle') return `${name} is a pickle checkpoint. Pickle is never imported.`;
  return null;
}

/** A quantization from a tag or file name: q4_K_M, Q8_0, f16, IQ3_XS… */
export function quantizationOf(name: string): string | null {
  const m = /(?:^|[-_.:])((?:i?q\d(?:_[a-z0-9]+)*)|f16|f32|bf16|fp16)(?=$|[-_.])/i.exec(name.replace(/\.gguf$/i, ''));
  return m ? m[1]! : null;
}

/** The parameter-count bucket the browse facet uses. */
export function parameterBucket(params: number | string | null | undefined): string | null {
  if (params == null || params === '') return null;
  let n: number;
  if (typeof params === 'number') n = params;
  else {
    const m = /([\d.]+)\s*([kmbt])?/i.exec(params);
    if (!m) return null;
    n = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] ?? '').toLowerCase() as 'k'] ?? 1);
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e9 ? 'under 1B' : n < 1e10 ? '1 to 10B' : n < 4e10 ? '10 to 40B' : n < 1e11 ? '40 to 100B' : 'over 100B';
}

/** A row-count bucket for datasets. */
export function rowBucket(rows: number | null | undefined): string | null {
  if (rows == null || !Number.isFinite(rows) || rows < 0) return null;
  return rows < 1e4 ? 'under 10k rows' : rows < 1e6 ? '10k to 1M rows' : rows < 1e8 ? '1M to 100M rows' : 'over 100M rows';
}

/**
 * A licence id from what the source states (an SPDX id, a CKAN or DCAT licence id or URL, a licence text). Lower
 * case; unknown when nothing is stated, `other` when something is stated that is not recognised.
 */
export function normaliseLicence(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  let v = String(raw).trim();
  if (!v) return 'unknown';
  const url = /^https?:\/\//i.test(v);
  if (url) {
    const u = v.toLowerCase();
    const cc = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/([\d.]+)/.exec(u);
    if (cc) return cc[1] === 'publicdomain' ? (cc[2] === 'zero' ? 'cc0-1.0' : 'public-domain') : `cc-${cc[2]}-${cc[3]}`;
    if (u.includes('opendatacommons.org/licenses/by')) return 'odc-by';
    if (u.includes('opendatacommons.org/licenses/odbl')) return 'odbl-1.0';
    if (u.includes('apache.org/licenses/license-2.0')) return 'apache-2.0';
    if (u.includes('opensource.org/licenses/mit')) return 'mit';
    if (/publications\.europa\.eu\/resource\/authority\/licence\/([a-z0-9_]+)/.test(u)) return /licence\/([a-z0-9_]+)/.exec(u)![1]!.replace(/_/g, '-');
    v = u.split('/').filter(Boolean).pop() ?? u;
  }
  const head = v.slice(0, 400).toLowerCase();
  if (head.length > 60 || /\s/.test(head.trim())) {
    // A licence text (an Ollama license layer, a LICENSE file): recognise the common ones by their first lines.
    if (/apache license[\s,]*version 2\.0/.test(head)) return 'apache-2.0';
    if (/^\s*mit license|permission is hereby granted, free of charge/.test(head)) return 'mit';
    if (/llama 3\.3 community license/.test(head)) return 'llama3.3';
    if (/llama 3\.2 community license/.test(head)) return 'llama3.2';
    if (/llama 3\.1 community license/.test(head)) return 'llama3.1';
    if (/meta llama 3 community license/.test(head)) return 'llama3';
    if (/llama 2 community license/.test(head)) return 'llama2';
    if (/gemma terms of use/.test(head)) return 'gemma';
    if (/creative commons attribution 4\.0/.test(head)) return 'cc-by-4.0';
    if (/creative commons attribution-noncommercial/.test(head)) return 'cc-by-nc-4.0';
    if (/bsd 3-clause/.test(head)) return 'bsd-3-clause';
    if (/gnu general public license/.test(head)) return 'gpl-3.0';
    if (/us public domain|public domain/.test(head) && head.length < 80) return 'public-domain';
    if (head.length > 60) return 'other';
  }
  const id = head.trim().replace(/^license:/, '').replace(/[\s_]+/g, '-');
  const aliases: Record<string, string> = {
    'cc-by': 'cc-by-4.0',
    'cc-by-4': 'cc-by-4.0',
    'cc-by-40': 'cc-by-4.0',
    'cc-zero': 'cc0-1.0',
    cc0: 'cc0-1.0',
    'odc-odbl': 'odbl-1.0',
    odbl: 'odbl-1.0',
    'odc-by': 'odc-by',
    'other-pd': 'public-domain',
    'notspecified': 'unknown',
    'not-specified': 'unknown',
    'other-at': 'other',
    'other-open': 'other',
    'other-nc': 'other',
    'other-closed': 'other',
    'us-pd': 'us-pd',
    'apache2': 'apache-2.0',
    'apache-2': 'apache-2.0'
  };
  return aliases[id] ?? id.slice(0, 120);
}

/** The licences a new tenant accepts without an exception (the board's allow-list). */
export const DEFAULT_ALLOWED_LICENCES = ['apache-2.0', 'mit', 'bsd-3-clause', 'llama3.1', 'llama3.2', 'llama3.3', 'gemma', 'us-pd', 'public-domain', 'cc0-1.0', 'cc-by-4.0', 'cc-by-sa-3.0', 'cc-by-sa-4.0', 'odc-by', 'odbl-1.0', 'sg-odl', 'jp-standard-terms', 'in-godl'];
