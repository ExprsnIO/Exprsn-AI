import { formatNumber, type ChartData } from './charts.js';

/*
 * 1.8.0, Sprint 44 (B-120, B-121): a chart as a static drawing, for the dashboard snapshot (`AppDashboards.render`).
 * One layout (`scene`) of rectangles, polygons, markers, lines and text is written out two ways: as SVG for the HTML
 * snapshot (colours as the theme's CSS variables, each series also told apart by a pattern or a marker shape) and as
 * PDF path operators for the PDF snapshot (`toPdfDrawing`, drawn by `chat/export-pdf.ts`). The console draws its own,
 * interactive charts in `web/js/screens/apps-charts.js`; this one has no focus, motion or hover.
 */

export const SCENE_W = 640;
export const SCENE_H = 300;
const PAD = { l: 56, r: 16, t: 16, b: 52 };

type Tone = 'fg' | 'muted' | 'axis' | 'grid';
export type Shape =
  | { t: 'rect'; x: number; y: number; w: number; h: number; s: number }
  | { t: 'poly'; pts: [number, number][]; s: number; fill: boolean; dash?: boolean }
  | { t: 'mark'; x: number; y: number; s: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; tone: Tone }
  | { t: 'text'; x: number; y: number; text: string; size: number; anchor: 'start' | 'middle' | 'end'; tone: Tone; bold?: boolean };

export interface Scene {
  w: number;
  h: number;
  shapes: Shape[];
  /** The legend: series names in colour order. */
  legend: string[];
}

/** Round tick steps (1, 2, 5 times a power of ten) from 0 or the minimum to the maximum. */
export function ticks(min: number, max: number, n = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) max = min + 1;
  const raw = (max - min) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function axes(shapes: Shape[], lo: number, hi: number, horizontal: boolean, w: number, h: number): { scale: (v: number) => number; min: number; max: number } {
  const t = ticks(lo, hi);
  const min = t[0]!;
  const max = t[t.length - 1]!;
  const plotW = w - PAD.l - PAD.r;
  const plotH = h - PAD.t - PAD.b;
  const scale = horizontal ? (v: number) => PAD.l + ((v - min) / (max - min)) * plotW : (v: number) => PAD.t + plotH - ((v - min) / (max - min)) * plotH;
  for (const v of t) {
    const at = scale(v);
    if (horizontal) {
      shapes.push({ t: 'line', x1: at, y1: PAD.t, x2: at, y2: PAD.t + plotH, tone: 'grid' });
      shapes.push({ t: 'text', x: at, y: PAD.t + plotH + 14, text: formatNumber(v), size: 10, anchor: 'middle', tone: 'muted' });
    } else {
      shapes.push({ t: 'line', x1: PAD.l, y1: at, x2: PAD.l + plotW, y2: at, tone: 'grid' });
      shapes.push({ t: 'text', x: PAD.l - 6, y: at + 3, text: formatNumber(v), size: 10, anchor: 'end', tone: 'muted' });
    }
  }
  shapes.push({ t: 'line', x1: PAD.l, y1: PAD.t + plotH, x2: PAD.l + plotW, y2: PAD.t + plotH, tone: 'axis' });
  shapes.push({ t: 'line', x1: PAD.l, y1: PAD.t, x2: PAD.l, y2: PAD.t + plotH, tone: 'axis' });
  return { scale, min, max };
}

/** The drawing of a chart, or null for a table (which is only a table). */
export function scene(d: ChartData): Scene | null {
  const W = SCENE_W;
  const H = SCENE_H;
  const shapes: Shape[] = [];
  const legend = d.series.map((s) => s.name);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const n = d.categories.length;
  const vals = (i: number) => d.series.map((s) => s.values[i] ?? 0);

  if (d.type === 'table') return null;
  if (d.type === 'number') {
    shapes.push({ t: 'text', x: 16, y: 56, text: formatNumber(d.value ?? null), size: 40, anchor: 'start', tone: 'fg', bold: true });
    if (d.compare) {
      const c = d.compare;
      const dir = c.delta == null ? '' : c.delta > 0 ? 'Up ' : c.delta < 0 ? 'Down ' : 'Level, ';
      shapes.push({ t: 'text', x: 16, y: 86, text: `${dir}${c.delta == null ? '' : formatNumber(Math.abs(c.delta))}${c.pct != null ? ` (${formatNumber(Math.abs(c.pct))} %)` : ''} against the ${c.label}, ${formatNumber(c.value)}`, size: 12, anchor: 'start', tone: 'muted' });
    }
    return { w: W, h: 104, shapes, legend: [] };
  }
  if (d.type === 'pie' || d.type === 'donut') {
    const total = d.categories.reduce((a, _, i) => a + Math.max(0, d.series[0]?.values[i] ?? 0), 0);
    const cx = 150;
    const cy = H / 2;
    const r = 120;
    const r0 = d.type === 'donut' ? 64 : 0;
    let a0 = -Math.PI / 2;
    d.categories.forEach((c, i) => {
      const v = Math.max(0, d.series[0]?.values[i] ?? 0);
      if (!total || !v) return;
      const a1 = a0 + (v / total) * Math.PI * 2;
      const pts: [number, number][] = [];
      const steps = Math.max(2, Math.ceil(((a1 - a0) * 180) / Math.PI / 3));
      for (let k = 0; k <= steps; k++) {
        const a = a0 + ((a1 - a0) * k) / steps;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      if (r0) for (let k = steps; k >= 0; k--) {
        const a = a0 + ((a1 - a0) * k) / steps;
        pts.push([cx + r0 * Math.cos(a), cy + r0 * Math.sin(a)]);
      }
      else pts.push([cx, cy]);
      shapes.push({ t: 'poly', pts, s: i, fill: true });
      a0 = a1;
    });
    d.categories.slice(0, 12).forEach((c, i) => {
      const v = Math.max(0, d.series[0]?.values[i] ?? 0);
      const y = 40 + i * 20;
      shapes.push({ t: 'rect', x: 310, y: y - 10, w: 12, h: 12, s: i });
      shapes.push({ t: 'text', x: 330, y, text: `${short(c.label, 30)}: ${formatNumber(v)}${total ? ` (${formatNumber((v / total) * 100)} %)` : ''}`, size: 11, anchor: 'start', tone: 'fg' });
    });
    return { w: W, h: H, shapes, legend: [] };
  }
  if (d.type === 'scatter') {
    const pts = d.points ?? [];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const ya = axes(shapes, Math.min(0, ...ys), Math.max(0, ...ys), false, W, H);
    const xt = ticks(Math.min(...xs, 0), Math.max(...xs, 1));
    const xmin = xt[0]!;
    const xmax = xt[xt.length - 1]!;
    const sx = (v: number) => PAD.l + ((v - xmin) / (xmax - xmin || 1)) * plotW;
    for (const v of xt) shapes.push({ t: 'text', x: sx(v), y: PAD.t + plotH + 14, text: formatNumber(v), size: 10, anchor: 'middle', tone: 'muted' });
    for (const p of pts) shapes.push({ t: 'mark', x: sx(p.x), y: ya.scale(p.y), s: 0 });
    shapes.push({ t: 'text', x: PAD.l + plotW / 2, y: H - 8, text: short(d.axes.x, 60), size: 11, anchor: 'middle', tone: 'fg' });
    return { w: W, h: H, shapes, legend: [] };
  }

  // bar, line, area
  const stacked = d.series.length > 1 && (d.stacking === 'stacked' || d.type === 'area');
  const totals = d.categories.map((_, i) => (stacked ? vals(i).reduce((a, v) => a + Math.max(0, v), 0) : Math.max(0, ...vals(i))));
  const lows = d.categories.map((_, i) => Math.min(0, ...vals(i)));
  const horizontal = d.type === 'bar' && d.orientation === 'horizontal';
  const ax = axes(shapes, Math.min(0, ...lows), Math.max(1, ...totals), horizontal, W, H);
  const band = (horizontal ? plotH : plotW) / Math.max(1, n);
  const every = Math.max(1, Math.ceil(n / (horizontal ? 14 : 12)));
  d.categories.forEach((c, i) => {
    if (i % every) return;
    const mid = (horizontal ? PAD.t : PAD.l) + band * (i + 0.5);
    if (horizontal) shapes.push({ t: 'text', x: PAD.l - 6, y: mid + 3, text: short(c.label, 9), size: 10, anchor: 'end', tone: 'fg' });
    else shapes.push({ t: 'text', x: mid, y: PAD.t + plotH + 28, text: short(c.label, Math.max(4, Math.floor((band * every) / 6))), size: 10, anchor: 'middle', tone: 'fg' });
  });
  if (d.type === 'bar') {
    const zero = ax.scale(0);
    d.categories.forEach((_, i) => {
      const start = (horizontal ? PAD.t : PAD.l) + band * i + band * 0.15;
      const room = band * 0.7;
      let acc = 0;
      d.series.forEach((s, si) => {
        const v = s.values[i] ?? 0;
        if (stacked) {
          const a = ax.scale(acc);
          const b = ax.scale(acc + Math.max(0, v));
          acc += Math.max(0, v);
          if (horizontal) shapes.push({ t: 'rect', x: a, y: start, w: b - a, h: room, s: si });
          else shapes.push({ t: 'rect', x: start, y: b, w: room, h: a - b, s: si });
        } else {
          const bw = room / d.series.length;
          const at = ax.scale(v);
          if (horizontal) shapes.push({ t: 'rect', x: Math.min(zero, at), y: start + bw * si, w: Math.abs(at - zero), h: bw, s: si });
          else shapes.push({ t: 'rect', x: start + bw * si, y: Math.min(zero, at), w: bw, h: Math.abs(zero - at), s: si });
        }
      });
    });
  } else {
    const xOf = (i: number) => PAD.l + band * (i + 0.5);
    const cum = d.categories.map(() => 0);
    const lines = d.series.map((s) =>
      d.categories.map((_, i) => {
        const v = s.values[i] ?? 0;
        const base = stacked ? cum[i]! : 0;
        if (stacked) cum[i] = base + Math.max(0, v);
        return { x: xOf(i), y: ax.scale(stacked ? base + Math.max(0, v) : v), base: ax.scale(base) };
      })
    );
    if (d.type === 'area')
      lines.forEach((pts, si) => {
        shapes.push({ t: 'poly', pts: [...pts.map((p) => [p.x, p.y] as [number, number]), ...pts.map((p) => [p.x, p.base] as [number, number]).reverse()], s: si, fill: true });
      });
    lines.forEach((pts, si) => {
      shapes.push({ t: 'poly', pts: pts.map((p) => [p.x, p.y]), s: si, fill: false, dash: si % 2 === 1 });
      for (const p of pts) shapes.push({ t: 'mark', x: p.x, y: p.y, s: si });
    });
  }
  if (d.axes.x) shapes.push({ t: 'text', x: PAD.l + plotW / 2, y: H - 6, text: short(d.axes.x, 60), size: 11, anchor: 'middle', tone: 'fg' });
  return { w: W, h: H, shapes, legend };
}

// ---------- SVG ----------

const SVG_COLORS = ['var(--accent)', 'var(--info-fg)', 'var(--ok-fg)', 'var(--warn-fg)', 'var(--danger-fg)', 'var(--fg2)'];
const COLOR_VAR: Record<string, string> = { accent: 'var(--accent)', info: 'var(--info-fg)', ok: 'var(--ok-fg)', warn: 'var(--warn-fg)', danger: 'var(--danger-fg)', fg2: 'var(--fg2)' };
const TONE: Record<Tone, string> = { fg: 'var(--fg)', muted: 'var(--muted)', axis: 'var(--fg2)', grid: 'var(--line)' };
const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (v: number) => Math.round(v * 10) / 10;

/** A marker per series: circle, square, triangle, diamond, cross, bar. */
function markerSvg(cx: number, cy: number, s: number, fill: string): string {
  const k = s % 6;
  const a = `fill="${fill}" stroke="var(--panel)" stroke-width="1"`;
  if (k === 0) return `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="4" ${a}/>`;
  if (k === 1) return `<rect x="${r1(cx - 4)}" y="${r1(cy - 4)}" width="8" height="8" ${a}/>`;
  if (k === 2) return `<polygon points="${r1(cx)},${r1(cy - 5)} ${r1(cx + 5)},${r1(cy + 4)} ${r1(cx - 5)},${r1(cy + 4)}" ${a}/>`;
  if (k === 3) return `<polygon points="${r1(cx)},${r1(cy - 5)} ${r1(cx + 5)},${r1(cy)} ${r1(cx)},${r1(cy + 5)} ${r1(cx - 5)},${r1(cy)}" ${a}/>`;
  if (k === 4) return `<path d="M${r1(cx - 4)} ${r1(cy - 4)}L${r1(cx + 4)} ${r1(cy + 4)}M${r1(cx + 4)} ${r1(cy - 4)}L${r1(cx - 4)} ${r1(cy + 4)}" stroke="${fill}" stroke-width="2.5"/>`;
  return `<rect x="${r1(cx - 2)}" y="${r1(cy - 5)}" width="4" height="10" ${a}/>`;
}

/** Fills with a pattern on top of the colour, so series differ by more than colour. */
function patterns(id: string, colors: string[]): string {
  const marks = [
    '',
    '<path d="M0 8L8 0" stroke="var(--panel)" stroke-width="1.5"/>',
    '<circle cx="4" cy="4" r="1.4" fill="var(--panel)"/>',
    '<path d="M0 4H8" stroke="var(--panel)" stroke-width="1.5"/>',
    '<path d="M0 0L8 8M8 0L0 8" stroke="var(--panel)" stroke-width="1"/>',
    '<path d="M4 0V8" stroke="var(--panel)" stroke-width="1.5"/>'
  ];
  return `<defs>${colors.map((c, i) => `<pattern id="${id}-p${i}" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="${c}"/>${marks[i % marks.length]}</pattern>`).join('')}</defs>`;
}

/** A chart as SVG (`role="img"` named by its summary). `id` keeps pattern ids apart on one page. */
export function chartSvg(d: ChartData, id: string): string {
  const sc = scene(d);
  if (!sc) return '';
  const palette = (d.colors.length ? d.colors.map((c) => COLOR_VAR[c] ?? SVG_COLORS[0]!) : SVG_COLORS).slice();
  const many = Math.max(d.series.length, d.type === 'pie' || d.type === 'donut' ? d.categories.length : 0, 1);
  while (palette.length < many) palette.push(...palette.slice(0, many - palette.length));
  const fill = (s: number) => `url(#${id}-p${s % palette.length})`;
  const color = (s: number) => palette[s % palette.length]!;
  const body = sc.shapes
    .map((s) => {
      switch (s.t) {
        case 'rect':
          return `<rect x="${r1(s.x)}" y="${r1(s.y)}" width="${r1(Math.max(0, s.w))}" height="${r1(Math.max(0, s.h))}" fill="${fill(s.s)}" stroke="var(--panel)" stroke-width="1"/>`;
        case 'poly':
          return s.fill ? `<polygon points="${s.pts.map((p) => `${r1(p[0])},${r1(p[1])}`).join(' ')}" fill="${fill(s.s)}" stroke="var(--panel)" stroke-width="1"/>` : `<polyline points="${s.pts.map((p) => `${r1(p[0])},${r1(p[1])}`).join(' ')}" fill="none" stroke="${color(s.s)}" stroke-width="2"${s.dash ? ' stroke-dasharray="6 3"' : ''}/>`;
        case 'mark':
          return markerSvg(s.x, s.y, s.s, color(s.s));
        case 'line':
          return `<line x1="${r1(s.x1)}" y1="${r1(s.y1)}" x2="${r1(s.x2)}" y2="${r1(s.y2)}" stroke="${TONE[s.tone]}" stroke-width="1"/>`;
        case 'text':
          return `<text x="${r1(s.x)}" y="${r1(s.y)}" font-size="${s.size}" text-anchor="${s.anchor}" fill="${TONE[s.tone]}"${s.bold ? ' font-weight="700"' : ''}>${x(s.text)}</text>`;
      }
    })
    .join('');
  const legend = sc.legend.length > 1 ? `<ul class="legend">${sc.legend.map((n, i) => `<li><svg width="14" height="14" aria-hidden="true"><rect width="14" height="14" fill="${fill(i)}"/></svg>${x(n)}</li>`).join('')}</ul>` : '';
  return `<svg viewBox="0 0 ${sc.w} ${sc.h}" width="100%" role="img" aria-label="${x(d.summary)}" font-family="system-ui, sans-serif">${patterns(id, palette)}${body}</svg>${legend}`;
}

// ---------- PDF ----------

/** RGB per theme colour for print (the light theme's AA values). */
const PDF_RGB: Record<string, [number, number, number]> = { accent: [0.18, 0.36, 0.83], info: [0.11, 0.3, 0.55], ok: [0.11, 0.42, 0.22], warn: [0.48, 0.32, 0], danger: [0.63, 0.12, 0.09], fg2: [0.33, 0.33, 0.36] };
const PDF_TONE: Record<Tone, number> = { fg: 0, muted: 0.37, axis: 0.35, grid: 0.85 };

export interface PdfDrawing {
  width: number;
  height: number;
  /** Path operators with the origin at the drawing's bottom left, in points. */
  ops: string;
  texts: { x: number; y: number; text: string; size: number; anchor: 'start' | 'middle' | 'end'; gray: number; bold?: boolean }[];
}

const p2 = (v: number) => (Math.round(v * 100) / 100).toString();

/** A chart as a vector drawing for the PDF writer, scaled to `width` points. */
export function toPdfDrawing(d: ChartData, width: number): PdfDrawing | null {
  const sc = scene(d);
  if (!sc) return null;
  const k = width / sc.w;
  const height = sc.h * k;
  const X = (v: number) => p2(v * k);
  const Y = (v: number) => p2(height - v * k);
  const names = d.colors.length ? d.colors : Object.keys(PDF_RGB);
  const rgb = (s: number) => {
    const c = PDF_RGB[names[s % names.length]!] ?? PDF_RGB.accent!;
    // Series past the palette are lighter, so they still differ.
    const t = Math.floor(s / names.length) * 0.35;
    return c.map((v) => p2(v + (1 - v) * Math.min(0.7, t))).join(' ');
  };
  const ops: string[] = [];
  const texts: PdfDrawing['texts'] = [];
  for (const s of sc.shapes) {
    switch (s.t) {
      case 'rect':
        if (s.w > 0 && s.h > 0) ops.push(`${rgb(s.s)} rg 1 1 1 RG 0.6 w ${X(s.x)} ${Y(s.y + s.h)} ${X(s.w)} ${p2(s.h * k)} re B`);
        break;
      case 'poly':
        if (s.pts.length < 2) break;
        if (s.fill) ops.push(`${rgb(s.s)} rg 1 1 1 RG 0.6 w ${s.pts.map((p, i) => `${X(p[0])} ${Y(p[1])} ${i ? 'l' : 'm'}`).join(' ')} h B`);
        else ops.push(`${rgb(s.s)} RG 1.5 w ${s.dash ? '[4 2] 0 d ' : ''}${s.pts.map((p, i) => `${X(p[0])} ${Y(p[1])} ${i ? 'l' : 'm'}`).join(' ')} S [] 0 d`);
        break;
      case 'mark': {
        const r = 3 * k + 1;
        const sh = s.s % 4;
        const cx = s.x * k;
        const cy = height - s.y * k;
        if (sh === 1) ops.push(`${rgb(s.s)} rg ${p2(cx - r)} ${p2(cy - r)} ${p2(2 * r)} ${p2(2 * r)} re f`);
        else if (sh === 2) ops.push(`${rgb(s.s)} rg ${p2(cx)} ${p2(cy + r)} m ${p2(cx + r)} ${p2(cy - r)} l ${p2(cx - r)} ${p2(cy - r)} l h f`);
        else if (sh === 3) ops.push(`${rgb(s.s)} rg ${p2(cx)} ${p2(cy + r)} m ${p2(cx + r)} ${p2(cy)} l ${p2(cx)} ${p2(cy - r)} l ${p2(cx - r)} ${p2(cy)} l h f`);
        else {
          // A circle from four Bézier curves.
          const c = r * 0.5523;
          ops.push(`${rgb(s.s)} rg ${p2(cx + r)} ${p2(cy)} m ${p2(cx + r)} ${p2(cy + c)} ${p2(cx + c)} ${p2(cy + r)} ${p2(cx)} ${p2(cy + r)} c ${p2(cx - c)} ${p2(cy + r)} ${p2(cx - r)} ${p2(cy + c)} ${p2(cx - r)} ${p2(cy)} c ${p2(cx - r)} ${p2(cy - c)} ${p2(cx - c)} ${p2(cy - r)} ${p2(cx)} ${p2(cy - r)} c ${p2(cx + c)} ${p2(cy - r)} ${p2(cx + r)} ${p2(cy - c)} ${p2(cx + r)} ${p2(cy)} c f`);
        }
        break;
      }
      case 'line':
        ops.push(`${PDF_TONE[s.tone]} G 0.5 w ${X(s.x1)} ${Y(s.y1)} m ${X(s.x2)} ${Y(s.y2)} l S`);
        break;
      case 'text':
        texts.push({ x: s.x * k, y: height - s.y * k, text: s.text, size: Math.max(6, s.size * k), anchor: s.anchor, gray: PDF_TONE[s.tone], ...(s.bold ? { bold: true } : {}) });
        break;
    }
  }
  ops.push('0 g 0 G');
  return { width, height, ops: ops.join('\n'), texts };
}
