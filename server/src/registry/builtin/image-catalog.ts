/*
 * 1.7.0 (2026-10-14): image tools as built-ins: list, generate (the first image worker that is up, in
 * IMAGE_PREFERENCE order), edit on the CPU (crop, resize, rotate and flip, blur, adjust, effects, styles, a list of
 * operations) and AI restyle on a diffusers worker. Every result is a new picture in the caller's gallery; the original
 * is never changed. They are `read` tools by the owner's decision (no confirmation in chat): they act only on the
 * caller's own pictures and only add to the caller's gallery, under the image guardrail, the GPU quota and the
 * safety classifier.
 *
 * Pure data (migration 074 imports it). The names of effects and styles match services/image-worker/edits.py.
 */
import type { BuiltinSpec } from './catalog.js';

export const IMAGE_EFFECTS = ['grayscale', 'sepia', 'invert', 'posterize', 'solarize', 'emboss', 'edges', 'contour', 'pixelate', 'vignette', 'grain', 'autocontrast', 'equalize', 'glow'] as const;
export const IMAGE_STYLES = ['vintage', 'noir', 'polaroid', 'duotone', 'cyanotype', 'warm', 'cool', 'cinematic', 'sketch', 'comic', 'oil-paint', 'watercolor', 'pastel', 'high-key', 'low-key', 'lomo'] as const;
export const IMAGE_BLURS = ['gaussian', 'box', 'motion', 'pixelate'] as const;
export const IMAGE_OPS = ['crop', 'resize', 'rotate', 'flip', 'blur', 'sharpen', 'adjust', 'effect', 'style', 'border'] as const;

const id26 = (key: string): string => `BUILTIN0${key.toUpperCase().replace(/[^A-Z0-9]/g, '0')}`.padEnd(26, '0').slice(0, 26);
const num = (description: string, minimum: number, maximum: number) => ({ type: 'number', minimum, maximum, description });
const int = (description: string, minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum, description });
/** Migration 075: models write "latest" for the newest picture, so the words for it are accepted too. */
export const NEWEST_WORDS = ['latest', 'newest', 'last', 'previous', 'current'] as const;
const IMAGE = { type: 'string', pattern: `^([0-9A-HJKMNP-TV-Z]{26}|${NEWEST_WORDS.join('|')})$`, description: 'The picture: an id from image_list, a gallery image or a picture attached in this chat. Left out (or "latest"): the newest picture in this conversation.' };
const REGION = { type: 'object', description: 'A rectangle in pixels of the picture', properties: { x: int('Left edge', 0, 16384), y: int('Top edge', 0, 16384), width: int('Width', 1, 16384), height: int('Height', 1, 16384) }, required: ['x', 'y', 'width', 'height'], additionalProperties: false };
const STRENGTH = num('How strongly to apply it, 0 to 1 (1 when left out)', 0, 1);
const RESULT = { type: 'object', properties: { image: { type: 'object' }, source: { type: 'object' }, note: { type: 'string' } }, required: ['image'] };
const SAVED = 'The result is a new picture in the gallery, shown in the chat; the original is not changed.';

const spec = (key: string, description: string, properties: Record<string, unknown>, required: string[] = [], outputSchema: Record<string, unknown> = RESULT): BuiltinSpec => ({
  id: id26(key.replace(/_/g, '')),
  name: key,
  builtin: key,
  description,
  sideEffect: 'read',
  label: 'restricted',
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  outputSchema
});

export function imageTools(): BuiltinSpec[] {
  const ops = {
    type: 'array',
    minItems: 1,
    maxItems: 12,
    description: `Operations applied in order, each {"op": one of ${IMAGE_OPS.join(', ')}, ...its arguments as in the single tools}; border takes width (pixels) and color (CSS).`,
    items: { type: 'object', properties: { op: { type: 'string', enum: [...IMAGE_OPS] } }, required: ['op'] }
  };
  return [
    spec('image_list', 'Lists the pictures this conversation has (attached by the person or made here) and the newest in the caller\'s gallery, newest first, with ids, sizes and states. Use it to find the id of a picture to edit.', { limit: int('How many (12 when left out)', 1, 30) }, [], { type: 'object', properties: { images: { type: 'array', items: { type: 'object' } } }, required: ['images'] }),
    spec('image_generate', `Makes a new picture from a description on the first image model that is available (FLUX.2 klein, then the next one down). Give the description in the person's words with any style, setting or mood they asked for. Returns at once with the queued picture; it appears in the chat when done (FLUX loads for about a minute the first time). ${SAVED}`, { prompt: { type: 'string', minLength: 1, maxLength: 4000, description: 'What to draw' }, width: int('Pixels, a multiple of 8 (1024 when left out)', 256, 2048), height: int('Pixels, a multiple of 8 (1024 when left out)', 256, 2048) }, ['prompt']),
    spec('image_crop', `Crops a picture: to a rectangle (x, y, width, height in pixels) or to an aspect ratio such as "16:9" or "1:1", kept at the center or an edge. ${SAVED}`, { image: IMAGE, x: int('Left edge', 0, 16384), y: int('Top edge', 0, 16384), width: int('Width', 1, 16384), height: int('Height', 1, 16384), aspect: { type: 'string', pattern: '^\\d{1,2}:\\d{1,2}$', description: 'An aspect ratio, such as 16:9, 4:3 or 1:1, instead of a rectangle' }, anchor: { type: 'string', enum: ['center', 'top', 'bottom', 'left', 'right'], description: 'Which part to keep with an aspect ratio' } }),
    spec('image_resize', `Resizes a picture: to a width or height (the other follows the shape), to both (fit "contain" keeps it all, "cover" fills and trims, "stretch" distorts), or by a percentage. At most 4096 pixels a side. ${SAVED}`, { image: IMAGE, width: int('Pixels', 1, 4096), height: int('Pixels', 1, 4096), scale: num('Percent of the current size', 1, 800), fit: { type: 'string', enum: ['contain', 'cover', 'stretch'] } }),
    spec('image_rotate', `Rotates a picture by degrees (clockwise; the canvas grows to fit) and/or flips it. ${SAVED}`, { image: IMAGE, degrees: num('Clockwise degrees, such as 90 or -45', -360, 360), flip: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Mirror the picture' } }),
    spec('image_blur', `Blurs a picture, or only a region of it (to hide a face or a number plate), or everything but a region (outside: true, a background blur). Kinds: ${IMAGE_BLURS.join(', ')} (motion takes an angle). ${SAVED}`, { image: IMAGE, radius: num('How much, 0.5 to 100 (6 when left out); the block size for pixelate', 0.5, 100), kind: { type: 'string', enum: [...IMAGE_BLURS] }, angle: num('Direction of a motion blur in degrees', -360, 360), region: REGION, outside: { type: 'boolean', description: 'Blur everything except the region' } }),
    spec('image_adjust', `Adjusts a picture: brightness, contrast, saturation and sharpness are factors (1 is unchanged, 1.2 is 20% more, 0.8 less); gamma (1 unchanged); temperature -100 (cooler) to 100 (warmer); hue shift in degrees; sharpen 0 to 5 (unsharp mask). ${SAVED}`, { image: IMAGE, brightness: num('Factor', 0, 5), contrast: num('Factor', 0, 5), saturation: num('Factor', 0, 5), sharpness: num('Factor', 0, 5), gamma: num('Gamma', 0.1, 5), temperature: num('-100 to 100', -100, 100), hue: num('Degrees', -180, 180), sharpen: num('Unsharp mask amount', 0, 5) }),
    spec('image_effect', `Applies an effect: ${IMAGE_EFFECTS.join(', ')}. ${SAVED}`, { image: IMAGE, name: { type: 'string', enum: [...IMAGE_EFFECTS] }, strength: STRENGTH }, ['name']),
    spec('image_style', `Gives a picture a look with a filter, in a second: ${IMAGE_STYLES.join(', ')}. For a style a filter cannot make (a painting by an artist, anime, claymation), use image_restyle. ${SAVED}`, { image: IMAGE, name: { type: 'string', enum: [...IMAGE_STYLES] }, strength: STRENGTH }, ['name']),
    spec('image_edit', `Applies several edits in one go, in order (crop, resize, rotate, flip, blur, sharpen, adjust, effect, style, border). ${SAVED}`, { image: IMAGE, ops }, ['ops']),
    spec('image_restyle', `Redraws a picture with the image model (FLUX.2 klein) following an instruction, such as "as a watercolour painting", "in the style of a 1950s travel poster" or "make it night". Keeps the composition; slower (a minute or more) and uses GPU quota. Returns at once; the result appears in the chat when done. ${SAVED}`, { image: IMAGE, prompt: { type: 'string', minLength: 1, maxLength: 2000, description: 'How to redraw it' } }, ['prompt'])
  ];
}
