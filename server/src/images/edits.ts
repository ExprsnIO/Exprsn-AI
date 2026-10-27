import { z } from 'zod';
import { IMAGE_BLURS, IMAGE_EFFECTS, IMAGE_STYLES } from '../registry/builtin/image-catalog.js';
import type { EditOp } from './backends.js';

/*
 * 1.7.0: the operations of an edit, checked before a job is queued (the editor, services/image-worker/edits.py,
 * checks them again). The shapes are the editor's; the names of effects, styles and blurs come from
 * `registry/builtin/image-catalog.ts`, which the tools' input schemas also use.
 */

const px = z.number().int().min(0).max(16384);
const side = z.number().int().min(1).max(16384);
const region = z.object({ x: px, y: px, width: side, height: side }).strict();
const strength = z.number().min(0).max(1).optional();

const opSchema = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('crop'), x: px.optional(), y: px.optional(), width: side.optional(), height: side.optional(), aspect: z.string().regex(/^\d{1,2}:\d{1,2}$/).optional(), anchor: z.enum(['center', 'top', 'bottom', 'left', 'right']).optional() })
    .strict()
    .refine((o) => o.aspect != null || [o.x, o.y, o.width, o.height].every((v) => v != null), 'crop needs x, y, width and height, or an aspect such as 16:9'),
  z
    .object({ op: z.literal('resize'), width: z.number().int().min(1).max(4096).optional(), height: z.number().int().min(1).max(4096).optional(), scale: z.number().min(1).max(800).optional(), fit: z.enum(['contain', 'cover', 'stretch']).optional() })
    .strict()
    .refine((o) => o.width != null || o.height != null || o.scale != null, 'resize needs width, height or scale'),
  z.object({ op: z.literal('rotate'), degrees: z.number().min(-360).max(360), expand: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('flip'), direction: z.enum(['horizontal', 'vertical']) }).strict(),
  z.object({ op: z.literal('blur'), radius: z.number().min(0.5).max(100).optional(), kind: z.enum(IMAGE_BLURS).optional(), angle: z.number().min(-360).max(360).optional(), region: region.optional(), outside: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('sharpen'), amount: z.number().min(0).max(5).optional() }).strict(),
  z
    .object({ op: z.literal('adjust'), brightness: z.number().min(0).max(5).optional(), contrast: z.number().min(0).max(5).optional(), saturation: z.number().min(0).max(5).optional(), sharpness: z.number().min(0).max(5).optional(), gamma: z.number().min(0.1).max(5).optional(), temperature: z.number().min(-100).max(100).optional(), hue: z.number().min(-180).max(180).optional() })
    .strict()
    .refine((o) => Object.keys(o).length > 1, 'adjust needs at least one of brightness, contrast, saturation, sharpness, gamma, temperature or hue'),
  z.object({ op: z.literal('effect'), name: z.enum(IMAGE_EFFECTS), strength }).strict(),
  z.object({ op: z.literal('style'), name: z.enum(IMAGE_STYLES), strength }).strict(),
  z.object({ op: z.literal('border'), width: z.number().int().min(1).max(400).optional(), color: z.string().max(40).regex(/^(#[0-9a-fA-F]{3,8}|[a-z]{3,20})$/).optional() }).strict()
]);

export const opsSchema = z.array(opSchema).min(1).max(12);

export class EditRefused extends Error {}

/** The operations, checked; a refusal names the operation and what was wrong, for a model to correct its call. */
export function parseOps(raw: unknown): EditOp[] {
  const r = opsSchema.safeParse(raw);
  if (r.success) return r.data as EditOp[];
  const i = r.error.issues[0]!;
  const at = i.path.length ? `operation ${Number(i.path[0]) + 1}${i.path.length > 1 ? ` (${i.path.slice(1).join('.')})` : ''}` : 'ops';
  throw new EditRefused(`${at}: ${i.message}`);
}

/** One line a person reads: "crop 16:9, style vintage (0.6)". */
export function describeOps(ops: EditOp[]): string {
  return ops
    .map((o) => {
      switch (o.op) {
        case 'crop':
          return o.aspect ? `crop ${String(o.aspect)}` : `crop ${String(o.width)} x ${String(o.height)} at ${String(o.x)},${String(o.y)}`;
        case 'resize':
          return o.scale != null ? `resize ${String(o.scale)}%` : `resize to ${String(o.width ?? 'auto')} x ${String(o.height ?? 'auto')}`;
        case 'rotate':
          return `rotate ${String(o.degrees)}°`;
        case 'flip':
          return `flip ${String(o.direction)}`;
        case 'blur':
          return `${String(o.kind ?? 'gaussian')} blur ${String(o.radius ?? 6)}${o.region ? (o.outside ? ' around a region' : ' of a region') : ''}`;
        case 'effect':
        case 'style':
          return `${o.op} ${String(o.name)}${o.strength != null && o.strength !== 1 ? ` (${String(o.strength)})` : ''}`;
        default:
          return o.op;
      }
    })
    .join(', ');
}

/** Width and height read from PNG, JPEG or WebP bytes; null when the format is not one of those. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = b.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') {
      const v = b.readUInt32LE(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}
