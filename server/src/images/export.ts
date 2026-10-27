import { createHash } from 'node:crypto';
import { z } from 'zod';
import { highest, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { forbidden, HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * Exports of generated images (2026-10-16): one image, or several made into one animation (or one page each in a PDF),
 * as WebP, GIF, JPEG XL, JPEG, PNG or PDF, downloaded or saved into Files.
 *
 * - The images are read as the caller (`ImageService.image`: their own, or what their workspace shares); the export
 *   carries the highest label among them, into Files and into the audit.
 * - Converting runs in the sandboxed converter: the published read-only MCP tool exprsn-imgconv.image_convert (one
 *   throwaway container per call, no network), called directly with the bytes, so a model never sees them. Without
 *   it this answers 503. Tests and the e2e server set `converter` instead.
 * - JPEG XL takes transparency, 8 to 16 bits per channel, lossless, animation, HDR (PQ or HLG), a region of interest
 *   decoded first and a tile size (imgconv.py `encode_jxl`). Only a PNG keeps the C2PA manifest of the original; the
 *   audit records the SHA-256 of every source image and of the export.
 */

export const EXPORT_FORMATS = ['webp', 'gif', 'jxl', 'jpg', 'png', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Formats that hold several images: an animation, or (pdf) one page each. */
const MANY: readonly ExportFormat[] = ['webp', 'gif', 'jxl', 'png', 'pdf'];
const MEDIA: Record<ExportFormat, string> = { webp: 'image/webp', gif: 'image/gif', jxl: 'image/jxl', jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
const MAX_IMAGES = 60;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const TOOL = 'exprsn-imgconv.image_convert';

const id = z.string().trim().min(1).max(40);
export const exportOptionsSchema = z
  .object({
    quality: z.number().int().min(1).max(100).optional(),
    lossless: z.boolean().optional(),
    effort: z.number().int().min(1).max(9).optional(),
    max_side: z.number().int().min(16).max(16384).optional(),
    background: z.string().regex(/^(#[0-9a-fA-F]{6}|white|black)$/, '#rrggbb, white or black').optional(),
    colors: z.number().int().min(2).max(256).optional(),
    progressive: z.boolean().optional(),
    // JPEG XL
    distance: z.number().min(0.1).max(25).optional(),
    bit_depth: z.union([z.literal(8), z.literal(10), z.literal(12), z.literal(16)]).optional(),
    hdr: z.enum(['none', 'pq', 'hlg']).optional(),
    sdr_white: z.number().int().min(80).max(1000).optional(),
    intensity_target: z.number().int().min(100).max(10000).optional(),
    roi: z.object({ x: z.number().min(0), y: z.number().min(0) }).strict().optional(),
    tile_size: z.union([z.literal(128), z.literal(256), z.literal(512), z.literal(1024)]).optional(),
    // several images
    frame_ms: z.number().int().min(10).max(60000).optional(),
    loop: z.number().int().min(0).max(65535).optional()
  })
  .strict();
export const exportSchema = z
  .object({
    ids: z.array(id).min(1).max(MAX_IMAGES),
    format: z.enum(EXPORT_FORMATS),
    options: exportOptionsSchema.default({}),
    to: z.enum(['download', 'files']).default('download'),
    workspaceId: z.string().trim().max(40).nullable().optional(),
    folderId: z.string().trim().max(40).nullable().optional(),
    name: z.string().trim().min(1).max(200).regex(/^[^/\\\0]+$/, 'A file name, without folders').optional()
  })
  .strict();
export type ExportInput = z.infer<typeof exportSchema>;

/** What the converter answers (image_convert's result). */
export interface ConvertResult {
  name?: string;
  mediaType: string;
  content: string;
  encoding?: string;
  width: number;
  height: number;
  frames: number;
  notes?: string[];
  warnings?: string[];
}
export type ImageConverter = (p: Principal, args: Record<string, unknown>) => Promise<ConvertResult>;

export interface ImageExport {
  data: Buffer;
  mediaType: string;
  filename: string;
  label: Label;
  width: number;
  height: number;
  frames: number;
  notes: string[];
  warnings: string[];
  sources: { id: string; sha256: string }[];
  sha256: string;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export class ImageExports {
  /** Set by tests and the e2e server in place of the MCP converter. */
  converter: ImageConverter | null = null;

  constructor(private readonly s: () => Services) {}

  /** Whether exports can run here (the converter is published in the tenant, or one is set). */
  async available(tenantId: string): Promise<boolean> {
    return !!this.converter || !!(await this.entry(tenantId));
  }

  private entry(tenantId: string) {
    return this.s().db('registry_entries').where({ tenant_id: tenantId, kind: 'tool', name: TOOL, impl: 'mcp', status: 'published' }).orderBy('created_at', 'desc').first('id');
  }

  private async convert(p: Principal, args: Record<string, unknown>): Promise<ConvertResult> {
    if (this.converter) return this.converter(p, args);
    const s = this.s();
    const row = (await this.entry(p.tenantId)) as { id: string } | undefined;
    if (!row) throw new HttpProblem(503, 'Image conversion is not set up', `${TOOL} is not published in this tenant. An administrator sets it up with node scripts/exprsn-imgconv-suite.mjs.`);
    const tool = await s.registry.mustGet(p.tenantId, row.id);
    if ((tool.side_effect ?? 'read') !== 'read') throw new HttpProblem(503, 'Image conversion is not set up', `${TOOL} is not a read-only tool here.`);
    const r = await s.mcp.call(p, String(tool.definition.serverId), String(tool.definition.tool), args);
    const text = (r.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    if (r.isError) throw new HttpProblem(422, 'Not exported', (text || 'The converter reported an error.').slice(0, 1000));
    const out = (r.structuredContent ?? (text ? JSON.parse(text) : null)) as ConvertResult | null;
    if (!out || typeof out.content !== 'string') throw new HttpProblem(502, 'Not exported', 'The converter gave no image back.');
    return out;
  }

  /** The export's bytes, read and converted as the caller. */
  async render(p: Principal, input: ExportInput): Promise<ImageExport> {
    const ids = [...new Set(input.ids)];
    if (ids.length > 1 && !MANY.includes(input.format)) throw new HttpProblem(422, 'Not exported', `${input.format.toUpperCase()} holds one image; choose one, or WebP, GIF, JPEG XL, PNG (animations) or PDF (a page each).`);
    const images: Awaited<ReturnType<Services['images']['image']>>[] = [];
    let total = 0;
    for (const one of ids) {
      const im = await this.s().images.image(p, one);
      total += im.data.length;
      if (total > MAX_SOURCE_BYTES) throw new HttpProblem(413, 'Not exported', `The images are more than ${MAX_SOURCE_BYTES / 1024 / 1024} MB together; export fewer at a time.`);
      images.push(im);
    }
    const label = images.reduce<Label>((l, im) => highest(l, im.row.label), 'public');
    const stem = input.name?.replace(/\.[a-z0-9]{2,5}$/i, '') ?? (ids.length === 1 ? `image-${ids[0]!.toLowerCase()}` : `images-${ids.length}`);
    const named = (i: number) => `image-${ids[i]!.toLowerCase()}.${images[i]!.type === 'image/png' ? 'png' : 'jpg'}`;
    const args: Record<string, unknown> = {
      to: input.format,
      name: `${stem}.png`,
      metadata: 'strip',
      ...input.options,
      ...(images.length === 1 ? { base64: images[0]!.data.toString('base64') } : { frames: images.map((im, i) => ({ base64: im.data.toString('base64'), name: named(i) })) })
    };
    const out = await this.convert(p, args);
    const data = Buffer.from(out.content, out.encoding === 'text' ? 'utf8' : 'base64');
    if (!data.length) throw new HttpProblem(502, 'Not exported', 'The converter gave an empty file back.');
    const ext = input.format === 'jpg' ? 'jpg' : input.format;
    const notes = [...(out.notes ?? [])];
    if (input.format !== 'png') notes.push('The content credentials (C2PA manifest) travel only in PNG; this export records its source images in the audit instead.');
    return {
      data,
      mediaType: out.mediaType || MEDIA[input.format],
      filename: `${stem}.${ext}`,
      label,
      width: out.width,
      height: out.height,
      frames: out.frames,
      notes,
      warnings: out.warnings ?? [],
      sources: images.map((im) => ({ id: im.row.id, sha256: sha(im.data) })),
      sha256: sha(data)
    };
  }

  /** The export saved into Files (a workspace, or a folder in one), at the images' label. Needs files:write. */
  async toFiles(p: Principal, input: ExportInput) {
    if (!authorize(p, 'files:write', {}).allow) throw forbidden('Saving into Files needs the files:write permission.', { step: 'permission' });
    const x = await this.render(p, input);
    const saved = await this.s().files.upload(p, { workspaceId: input.workspaceId ?? null, folderId: input.folderId ?? null, name: x.filename, label: x.label, declaredType: x.mediaType, declaredBytes: x.data.length }, (async function* () {
      yield x.data;
    })());
    return { export: x, ...saved };
  }
}
