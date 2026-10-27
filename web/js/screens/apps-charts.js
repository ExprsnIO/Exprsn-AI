// Apps, charts (1.8.0, Sprint 44, B-120): the console's chart renderer and the chart builder.
//
// App.appsChart.render(data, opts) draws the series the server computed (POST .../charts/:id/data or /preview) as
// inline SVG, in plain JS with no library. Accessibility:
//  - the drawing is an <svg role="img"> named by the server's text summary;
//  - every data point (bar, slice, point) is a keyboard stop in a labelled group over the drawing: Tab reaches the
//    first, the arrow keys move along a series (Left, Right) and between series (Up, Down), Home and End jump, and each
//    point's name is its category, series and value, also shown beside it while it has focus;
//  - "View as table" opens the same numbers as a table, for every chart (a number tile's table has its comparison);
//  - series differ by pattern (bars, slices, areas) or marker shape and dash (lines, points) as well as colour;
//  - colours are the theme's CSS variables only (--accent, --info-fg, --ok-fg, --warn-fg, --danger-fg, --fg2), which
//    meet AA and, in Enhanced mode, AAA against the panels in light and dark; text uses --fg, --fg2 and --muted;
//  - the only motion (bars growing in) is off for prefers-reduced-motion and in Enhanced mode;
//  - the SVG is redrawn at its box's width (App.appsChart.fit, on resize), so text keeps its size at 320 and 640 px.
// App.appsChartBuilder(ctx, app, deps, chart, onSaved) opens the builder: source, type, dimension and bucket, split,
// measures, sort, limit, colours, labels, sharing, with a live preview computed by the server as the builder.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const COLOR_VAR = { accent: 'var(--accent)', info: 'var(--info-fg)', ok: 'var(--ok-fg)', warn: 'var(--warn-fg)', danger: 'var(--danger-fg)', fg2: 'var(--fg2)' };
  const ORDER = ['accent', 'info', 'ok', 'warn', 'danger', 'fg2'];
  const COLOR_NAMES = { accent: 'Accent', info: 'Blue', ok: 'Green', warn: 'Amber', danger: 'Red', fg2: 'Grey' };
  const TYPES = [
    { value: 'bar', label: 'Bar' }, { value: 'line', label: 'Line' }, { value: 'area', label: 'Area' }, { value: 'pie', label: 'Pie' }, { value: 'donut', label: 'Donut' },
    { value: 'scatter', label: 'Scatter' }, { value: 'number', label: 'Number tile' }, { value: 'table', label: 'Table' }
  ];
  const BUCKETS = [{ value: '', label: 'No bucket' }, { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' }, { value: 'year', label: 'Year' }];
  const OPS = [{ value: 'count', label: 'Count' }, { value: 'sum', label: 'Sum' }, { value: 'avg', label: 'Average' }, { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' }];
  const CSS = '#main .ach,#overlay .ach{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}'
    + '.ach .ach-plot{position:relative;min-width:0;width:100%}.ach .ach-plot svg{display:block;width:100%;height:auto;overflow:visible}.ach .ach-hit{position:absolute;inset:0;height:100%}'
    + '.ach text{font-family:var(--sans);fill:var(--fg2)}.ach .ach-cat{fill:var(--fg)}.ach .ach-ax{stroke:var(--fg2)}.ach .ach-grid{stroke:var(--line)}.ach .ach-val{fill:var(--fg);font-weight:600}'
    + '.ach .ach-pt{outline:none;cursor:pointer}.ach .ach-pt .ach-hitshape{fill:transparent;stroke:none}.ach .ach-pt:focus .ach-hitshape,.ach .ach-pt:hover .ach-hitshape{stroke:var(--focus);stroke-width:3}'
    + '.ach .ach-tip{display:none;pointer-events:none}.ach .ach-pt:focus .ach-tip,.ach .ach-pt:hover .ach-tip{display:inline}.ach .ach-tip rect{fill:var(--panel);stroke:var(--fg2)}.ach .ach-tip text{fill:var(--fg);font-weight:600}'
    + '.ach .ach-legend{display:flex;flex-wrap:wrap;gap:4px 14px;list-style:none;margin:0;padding:0;font-size:12px;color:var(--fg)}.ach .ach-legend li{display:flex;align-items:center;gap:6px;min-width:0;overflow-wrap:anywhere}.ach .ach-legend svg{flex:0 0 14px}'
    + '.ach .ach-foot{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.ach .ach-note{font-size:12px;color:var(--muted)}.ach .ach-table caption{text-align:left;font-size:12px;color:var(--muted);padding:4px 0}'
    + '.ach .ach-tile{display:flex;flex-direction:column;gap:2px}.ach .ach-big{font-size:34px;font-weight:700;line-height:1.1;color:var(--fg);overflow-wrap:anywhere}.ach .ach-cmp{font-size:13px;color:var(--fg2)}'
    + '@media (prefers-reduced-motion:no-preference){:root:not([data-a11y="aaa"]) .ach .ach-bar{animation:ach-in .35s ease-out both;transform-box:fill-box;transform-origin:bottom}:root:not([data-a11y="aaa"]) .ach.h .ach-bar{transform-origin:left}}'
    + '@keyframes ach-in{from{transform:scale(1,0)}to{transform:none}}.ach.h .ach-bar{animation-name:ach-inh}@keyframes ach-inh{from{transform:scale(0,1)}to{transform:none}}'
    + '#overlay .acb-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px}#overlay .acb-grid .span2{grid-column:1/-1}#overlay .acb-m{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end}#overlay .acb-m > *{min-width:0}'
    + '#overlay .acb-preview{border:1px dashed var(--line2);border-radius:8px;padding:10px;min-height:120px;min-width:0}@media (max-width:640px){#overlay .acb-grid{grid-template-columns:minmax(0,1fr)}}';

  const store = new Map(); // figure uid -> { data, width, opts }
  const openTables = new Set();
  let seq = 0;

  const fmt = (n) => (n == null || isNaN(n) ? 'no value' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const r1 = (v) => Math.round(v * 10) / 10;
  const short = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
  function ticks(min, max, n) {
    n = n || 5;
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) max = min + 1;
    const raw = (max - min) / n;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
    if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
    return out;
  }
  function palette(d, n) {
    const names = (d.colors && d.colors.length ? d.colors : ORDER).map((c) => COLOR_VAR[c] || COLOR_VAR.accent);
    const out = [];
    for (let i = 0; i < Math.max(1, n); i++) out.push(names[i % names.length]);
    return out;
  }
  // Six fills: solid, diagonal, dots, horizontal, cross-hatch, vertical; drawn in the panel colour over the series colour.
  const MARKS = ['', '<path d="M0 8L8 0M-2 2L2 -2M6 10L10 6" stroke="var(--panel)" stroke-width="1.6"/>', '<circle cx="4" cy="4" r="1.5" fill="var(--panel)"/>', '<path d="M0 4H8" stroke="var(--panel)" stroke-width="1.6"/>', '<path d="M0 0L8 8M8 0L0 8" stroke="var(--panel)" stroke-width="1.1"/>', '<path d="M4 0V8" stroke="var(--panel)" stroke-width="1.6"/>'];
  const markOf = (i) => (i + Math.floor(i / 6)) % 6;
  function defs(uid, colors) {
    return '<defs>' + colors.map((c, i) => '<pattern id="' + uid + '-p' + i + '" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="' + c + '"/>' + MARKS[markOf(i)] + '</pattern>').join('') + '</defs>';
  }
  function marker(x, y, s, color) {
    const k = s % 6;
    const a = 'fill="' + color + '" stroke="var(--panel)" stroke-width="1.2"';
    if (k === 0) return '<circle cx="' + r1(x) + '" cy="' + r1(y) + '" r="4.5" ' + a + '/>';
    if (k === 1) return '<rect x="' + r1(x - 4) + '" y="' + r1(y - 4) + '" width="8" height="8" ' + a + '/>';
    if (k === 2) return '<polygon points="' + r1(x) + ',' + r1(y - 5.5) + ' ' + r1(x + 5) + ',' + r1(y + 4) + ' ' + r1(x - 5) + ',' + r1(y + 4) + '" ' + a + '/>';
    if (k === 3) return '<polygon points="' + r1(x) + ',' + r1(y - 5.5) + ' ' + r1(x + 5.5) + ',' + r1(y) + ' ' + r1(x) + ',' + r1(y + 5.5) + ' ' + r1(x - 5.5) + ',' + r1(y) + '" ' + a + '/>';
    if (k === 4) return '<path d="M' + r1(x - 4) + ' ' + r1(y - 4) + 'L' + r1(x + 4) + ' ' + r1(y + 4) + 'M' + r1(x + 4) + ' ' + r1(y - 4) + 'L' + r1(x - 4) + ' ' + r1(y + 4) + '" stroke="' + color + '" stroke-width="2.6"/>';
    return '<rect x="' + r1(x - 2) + '" y="' + r1(y - 5.5) + '" width="4" height="11" ' + a + '/>';
  }
  const DASH = ['', '6 3', '2 3', '8 3 2 3', '1 2', '10 4'];

  /** The tip shown beside a focused point: its value on a panel-coloured box. */
  function tip(x, y, text, W) {
    const w = Math.min(W - 8, text.length * 6.6 + 12);
    const tx = Math.max(4, Math.min(W - w - 4, x - w / 2));
    const ty = Math.max(2, y - 30);
    return '<g class="ach-tip" aria-hidden="true"><rect x="' + r1(tx) + '" y="' + r1(ty) + '" width="' + r1(w) + '" height="22" rx="4"/><text x="' + r1(tx + w / 2) + '" y="' + r1(ty + 15) + '" text-anchor="middle" font-size="12">' + esc(short(text, Math.floor((w - 8) / 6.6))) + '</text></g>';
  }

  /** The chart's numbers as rows: the categories (or points) and a column per series. */
  function tableOf(d) {
    if (d.type === 'number') return { head: [(d.series[0] && d.series[0].name) || 'Value'].concat(d.compare ? [d.compare.label, 'Change'] : []), rows: [[fmt(d.value)].concat(d.compare ? [fmt(d.compare.value), d.compare.delta == null ? '' : (d.compare.delta >= 0 ? '+' : '-') + fmt(Math.abs(d.compare.delta))] : [])] };
    if (d.type === 'scatter') return { head: [(d.dimension && d.dimension.label) || 'Point', d.axes.x, d.axes.y], rows: (d.points || []).map((p) => [p.label, fmt(p.x), fmt(p.y)]) };
    return { head: [(d.dimension && d.dimension.label) || 'Category'].concat(d.series.map((s) => s.name)), rows: d.categories.map((c, i) => [c.label].concat(d.series.map((s) => fmt(s.values[i])))) };
  }
  function tableHtml(d, id, hidden) {
    const t = tableOf(d);
    return '<div class="ach-table" id="' + id + '"' + (hidden ? ' hidden' : '') + '><div class="tablewrap"><table class="dt"><caption>' + esc('The data of ' + d.title) + '</caption><thead><tr>' + t.head.map((h) => '<th scope="col">' + esc(h) + '</th>').join('') + '</tr></thead><tbody>'
      + (t.rows.length ? t.rows.map((r) => '<tr>' + r.map((v, i) => (i === 0 ? '<th scope="row">' + esc(v) + '</th>' : '<td class="r">' + esc(v) + '</td>')).join('') + '</tr>').join('') : '<tr><td colspan="' + t.head.length + '">No data</td></tr>')
      + '</tbody></table></div></div>';
  }

  /** The drawing and its keyboard points, at `W` pixels wide. */
  function drawing(d, uid, W) {
    const narrow = W < 480;
    const H = narrow ? 260 : 300;
    const PAD = { l: narrow ? 44 : 56, r: 14, t: 18, b: 48 };
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const body = [];
    const hits = [];
    const n = d.categories.length;
    const ns = d.series.length;
    const colors = palette(d, Math.max(ns, d.type === 'pie' || d.type === 'donut' ? n : 0));
    const fill = (i) => 'url(#' + uid + '-p' + (i % colors.length) + ')';
    const color = (i) => colors[i % colors.length];
    const pointName = (cat, s, v, pos) => cat + (ns > 1 || d.type === 'scatter' ? ', ' + s : '') + ': ' + v + ' (' + pos + ')';
    const yAxis = (lo, hi) => {
      const t = ticks(lo, hi);
      const min = t[0], max = t[t.length - 1];
      const sc = (v) => PAD.t + plotH - ((v - min) / (max - min || 1)) * plotH;
      t.forEach((v) => { body.push('<line class="ach-grid" x1="' + PAD.l + '" x2="' + (PAD.l + plotW) + '" y1="' + r1(sc(v)) + '" y2="' + r1(sc(v)) + '"/><text x="' + (PAD.l - 6) + '" y="' + r1(sc(v) + 4) + '" text-anchor="end" font-size="11">' + esc(fmt(v)) + '</text>'); });
      return sc;
    };
    const xAxisNum = (lo, hi) => {
      const t = ticks(lo, hi);
      const min = t[0], max = t[t.length - 1];
      const sc = (v) => PAD.l + ((v - min) / (max - min || 1)) * plotW;
      t.forEach((v, i) => { if (narrow && i % 2) return; body.push('<line class="ach-grid" y1="' + PAD.t + '" y2="' + (PAD.t + plotH) + '" x1="' + r1(sc(v)) + '" x2="' + r1(sc(v)) + '"/><text x="' + r1(sc(v)) + '" y="' + (PAD.t + plotH + 16) + '" text-anchor="middle" font-size="11">' + esc(fmt(v)) + '</text>'); });
      return sc;
    };
    const frame = () => body.push('<line class="ach-ax" x1="' + PAD.l + '" x2="' + (PAD.l + plotW) + '" y1="' + (PAD.t + plotH) + '" y2="' + (PAD.t + plotH) + '"/><line class="ach-ax" x1="' + PAD.l + '" x2="' + PAD.l + '" y1="' + PAD.t + '" y2="' + (PAD.t + plotH) + '"/>');
    const axisTitles = () => {
      if (d.axes && d.axes.x) body.push('<text x="' + r1(PAD.l + plotW / 2) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="12" class="ach-cat">' + esc(short(d.axes.x, Math.floor(plotW / 7))) + '</text>');
    };

    if (d.type === 'pie' || d.type === 'donut') {
      const total = d.categories.reduce((a, c, i) => a + Math.max(0, d.series[0].values[i] || 0), 0);
      const R = Math.min(H / 2 - 16, W / 2 - 16);
      const cx = W / 2, cy = H / 2;
      const r0 = d.type === 'donut' ? R * 0.55 : 0;
      let a0 = -Math.PI / 2;
      const pt = (r, a) => r1(cx + r * Math.cos(a)) + ' ' + r1(cy + r * Math.sin(a));
      d.categories.forEach((c, i) => {
        const v = Math.max(0, d.series[0].values[i] || 0);
        if (!total || !v) return;
        let a1 = a0 + (v / total) * Math.PI * 2;
        if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
        const big = a1 - a0 > Math.PI ? 1 : 0;
        const path = r0 ? 'M' + pt(R, a0) + ' A' + R + ' ' + R + ' 0 ' + big + ' 1 ' + pt(R, a1) + ' L' + pt(r0, a1) + ' A' + r0 + ' ' + r0 + ' 0 ' + big + ' 0 ' + pt(r0, a0) + ' Z' : 'M' + cx + ' ' + cy + ' L' + pt(R, a0) + ' A' + R + ' ' + R + ' 0 ' + big + ' 1 ' + pt(R, a1) + ' Z';
        body.push('<path d="' + path + '" fill="' + fill(i) + '" stroke="var(--panel)" stroke-width="1.5"/>');
        const mid = (a0 + a1) / 2;
        const pct = fmt((v / total) * 100) + ' %';
        hits.push({ shape: '<path class="ach-hitshape" d="' + path + '"/>', name: c.label + ': ' + fmt(v) + ', ' + pct + ' (' + (i + 1) + ' of ' + n + ')', tip: c.label + ': ' + fmt(v) + ' (' + pct + ')', x: cx + (R * 0.7) * Math.cos(mid), y: cy + (R * 0.7) * Math.sin(mid), s: 0, i });
        a0 = a1;
      });
      return { W, H, svg: body.join(''), hits, colors, legend: d.categories.map((c, i) => ({ name: c.label + ': ' + fmt(d.series[0].values[i]), i, kind: 'fill' })) };
    }

    if (d.type === 'scatter') {
      const pts = d.points || [];
      const sy = yAxis(Math.min.apply(null, [0].concat(pts.map((p) => p.y))), Math.max.apply(null, [1].concat(pts.map((p) => p.y))));
      const sx = xAxisNum(Math.min.apply(null, [0].concat(pts.map((p) => p.x))), Math.max.apply(null, [1].concat(pts.map((p) => p.x))));
      frame();
      pts.forEach((p, i) => {
        body.push(marker(sx(p.x), sy(p.y), 0, color(0)));
        hits.push({ shape: '<circle class="ach-hitshape" cx="' + r1(sx(p.x)) + '" cy="' + r1(sy(p.y)) + '" r="9"/>', name: p.label + ': ' + d.axes.x + ' ' + fmt(p.x) + ', ' + d.axes.y + ' ' + fmt(p.y) + ' (' + (i + 1) + ' of ' + pts.length + ')', tip: p.label + ': ' + fmt(p.x) + ', ' + fmt(p.y), x: sx(p.x), y: sy(p.y), s: 0, i });
      });
      axisTitles();
      return { W, H, svg: body.join(''), hits, colors, legend: [] };
    }

    // bar, line, area
    const vals = (i) => d.series.map((s) => s.values[i] || 0);
    const stacked = ns > 1 && (d.stacking === 'stacked' || d.type === 'area');
    const highs = d.categories.map((c, i) => (stacked ? vals(i).reduce((a, v) => a + Math.max(0, v), 0) : Math.max.apply(null, [0].concat(vals(i)))));
    const lows = d.categories.map((c, i) => Math.min.apply(null, [0].concat(vals(i))));
    const hi = Math.max.apply(null, [1].concat(highs));
    const lo = Math.min.apply(null, [0].concat(lows));
    const horiz = d.type === 'bar' && d.orientation === 'horizontal';
    const band = (horiz ? plotH : plotW) / Math.max(1, n);
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((horiz ? plotH / 16 : plotW / 54)))));
    let sc;
    if (horiz) {
      sc = xAxisNum(lo, hi);
      d.categories.forEach((c, i) => { if (i % every) return; body.push('<text class="ach-cat" x="' + (PAD.l - 6) + '" y="' + r1(PAD.t + band * (i + 0.5) + 4) + '" text-anchor="end" font-size="11">' + esc(short(c.label, Math.floor((PAD.l - 8) / 6))) + '</text>'); });
    } else {
      sc = yAxis(lo, hi);
      d.categories.forEach((c, i) => { if (i % every) return; body.push('<text class="ach-cat" x="' + r1(PAD.l + band * (i + 0.5)) + '" y="' + (PAD.t + plotH + 16) + '" text-anchor="middle" font-size="11">' + esc(short(c.label, Math.max(3, Math.floor((band * every) / 6.6)))) + '</text>'); });
    }
    frame();
    if (d.type === 'bar') {
      const zero = sc(0);
      d.categories.forEach((c, i) => {
        const start = (horiz ? PAD.t : PAD.l) + band * i + band * 0.14;
        const room = band * 0.72;
        let acc = 0;
        d.series.forEach((s, si) => {
          const raw = s.values[i];
          const v = raw || 0;
          let x, y, w, h;
          if (stacked) {
            const a = sc(acc), b = sc(acc + Math.max(0, v));
            acc += Math.max(0, v);
            if (horiz) { x = a; y = start; w = b - a; h = room; } else { x = start; y = b; w = room; h = a - b; }
          } else {
            const bw = room / ns;
            const at = sc(v);
            if (horiz) { x = Math.min(zero, at); y = start + bw * si; w = Math.abs(at - zero); h = bw; } else { x = start + bw * si; y = Math.min(zero, at); w = bw; h = Math.abs(zero - at); }
          }
          body.push('<rect class="ach-bar" x="' + r1(x) + '" y="' + r1(y) + '" width="' + r1(Math.max(0, w)) + '" height="' + r1(Math.max(0, h)) + '" fill="' + fill(si) + '" stroke="var(--panel)" stroke-width="1"/>');
          if (d.showValues && raw != null && !stacked) body.push(horiz ? '<text class="ach-val" x="' + r1(x + w + 4) + '" y="' + r1(y + h / 2 + 4) + '" font-size="11">' + esc(fmt(raw)) + '</text>' : '<text class="ach-val" x="' + r1(x + w / 2) + '" y="' + r1(y - 4) + '" text-anchor="middle" font-size="11">' + esc(fmt(raw)) + '</text>');
          // a hit area at least 8 px across, so a zero or tiny bar can still be reached and seen focused
          const hx = horiz ? x : x, hy = horiz ? y : Math.min(y, zero - 8), hw = horiz ? Math.max(8, w) : w, hh = horiz ? h : Math.max(8, h);
          hits.push({ shape: '<rect class="ach-hitshape" x="' + r1(hx) + '" y="' + r1(hy) + '" width="' + r1(Math.max(1, hw)) + '" height="' + r1(Math.max(1, hh)) + '"/>', name: pointName(c.label, s.name, fmt(raw), (i + 1) + ' of ' + n), tip: (ns > 1 ? s.name + ', ' : '') + c.label + ': ' + fmt(raw), x: horiz ? x + w : x + w / 2, y: horiz ? y : y, s: si, i });
        });
      });
    } else {
      const xOf = (i) => PAD.l + band * (i + 0.5);
      const cum = d.categories.map(() => 0);
      const lines = d.series.map((s) => d.categories.map((c, i) => {
        const v = s.values[i];
        const base = stacked ? cum[i] : 0;
        if (stacked) cum[i] = base + Math.max(0, v || 0);
        return { x: xOf(i), y: sc(stacked ? base + Math.max(0, v || 0) : v || 0), base: sc(base), v };
      }));
      if (d.type === 'area') lines.forEach((pts, si) => { body.push('<polygon points="' + pts.map((p) => r1(p.x) + ',' + r1(p.y)).concat(pts.slice().reverse().map((p) => r1(p.x) + ',' + r1(p.base))).join(' ') + '" fill="' + fill(si) + '" fill-opacity="0.55" stroke="none"/>'); });
      lines.forEach((pts, si) => {
        body.push('<polyline points="' + pts.map((p) => r1(p.x) + ',' + r1(p.y)).join(' ') + '" fill="none" stroke="' + color(si) + '" stroke-width="2.4"' + (DASH[si % 6] ? ' stroke-dasharray="' + DASH[si % 6] + '"' : '') + '/>');
        pts.forEach((p, i) => {
          body.push(marker(p.x, p.y, si, color(si)));
          if (d.showValues && p.v != null) body.push('<text class="ach-val" x="' + r1(p.x) + '" y="' + r1(p.y - 9) + '" text-anchor="middle" font-size="11">' + esc(fmt(p.v)) + '</text>');
          hits.push({ shape: '<circle class="ach-hitshape" cx="' + r1(p.x) + '" cy="' + r1(p.y) + '" r="9"/>', name: pointName(d.categories[i].label, d.series[si].name, fmt(p.v), (i + 1) + ' of ' + n), tip: (ns > 1 ? d.series[si].name + ', ' : '') + d.categories[i].label + ': ' + fmt(p.v), x: p.x, y: p.y, s: si, i });
        });
      });
    }
    axisTitles();
    return { W, H, svg: body.join(''), hits, colors, legend: ns > 1 ? d.series.map((s, i) => ({ name: s.name, i, kind: d.type === 'bar' || d.type === 'area' ? 'fill' : 'line' })) : [] };
  }

  /**
   * A chart as markup. `opts.uid` keeps it the same element across re-renders (the table stays open), `opts.width`
   * the drawing's width in px (App.appsChart.fit redraws it at its box's width once it is in the page).
   */
  function render(d, opts) {
    opts = opts || {};
    const uid = opts.uid ? String(opts.uid).replace(/[^A-Za-z0-9_-]/g, '_') : 'ach' + (++seq);
    const W = Math.max(260, Math.min(1400, Math.round(opts.width || 600)));
    store.set(uid, { data: d, width: W, opts });
    if (store.size > 300) store.delete(store.keys().next().value);
    const tid = uid + '-table';
    const open = openTables.has(uid) || d.type === 'table';
    const notes = (d.truncated ? '<span class="ach-note">' + esc(d.type === 'scatter' ? 'Not every point is shown.' : 'Showing ' + d.categories.length + ' of ' + d.groups + (d.rowsRead != null ? '; read the first ' + fmt(d.rowsRead) + ' rows' : '') + '.') + '</span>' : '')
      + (d.cached ? '<span class="ach-note">Computed ' + esc(new Date(d.computedAt).toLocaleTimeString()) + '.</span>' : '');
    if (d.type === 'table') return '<figure class="ach" data-ach="' + uid + '">' + tableHtml(d, tid, false).replace('<caption>', '<caption>' + esc(d.summary) + ' ') + (notes ? '<div class="ach-foot">' + notes + '</div>' : '') + '</figure>';
    const toggle = UI.btn(open ? 'Hide table' : 'View as table', { size: 'xs', attrs: 'data-ach-table="' + uid + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="' + tid + '"' });
    if (d.type === 'number') {
      const c = d.compare;
      const dir = c && c.delta != null ? (c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : 'level') : null;
      const cmp = c ? '<div class="ach-cmp">' + (dir ? '<span aria-hidden="true">' + (dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■') + '</span> ' + esc((dir === 'level' ? 'Level' : dir === 'up' ? 'Up ' + fmt(Math.abs(c.delta)) : 'Down ' + fmt(Math.abs(c.delta))) + (c.pct != null ? ' (' + fmt(Math.abs(c.pct)) + ' %)' : '')) + ' ' : '') + esc('against the ' + c.label + ', ' + fmt(c.value)) + '</div>' : '';
      return '<figure class="ach" data-ach="' + uid + '"><div class="ach-tile" role="img" aria-label="' + esc(d.summary) + '"><div class="ach-big" aria-hidden="true">' + esc(fmt(d.value)) + '</div><div aria-hidden="true">' + cmp + '</div></div><div class="ach-foot">' + toggle + notes + '</div>' + tableHtml(d, tid, !open) + '</figure>';
    }
    const g = drawing(d, uid, W);
    const empty = !g.hits.length;
    const pts = g.hits.map((h, k) => '<g class="ach-pt" tabindex="' + (k === 0 ? '0' : '-1') + '" role="img" aria-label="' + esc(h.name) + '" data-s="' + h.s + '" data-i="' + h.i + '" data-k="' + k + '">' + h.shape + tip(h.x, h.y, h.tip, g.W) + '</g>').join('');
    const legend = g.legend.length ? '<ul class="ach-legend" aria-label="Legend">' + g.legend.map((l) => '<li><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">' + (l.kind === 'line' ? '<line x1="0" x2="14" y1="7" y2="7" stroke="' + g.colors[l.i % g.colors.length] + '" stroke-width="2.4"' + (DASH[l.i % 6] ? ' stroke-dasharray="' + DASH[l.i % 6] + '"' : '') + '/>' + marker(7, 7, l.i, g.colors[l.i % g.colors.length]) : '<rect width="14" height="14" fill="url(#' + uid + '-p' + (l.i % g.colors.length) + ')" stroke="var(--fg2)" stroke-width="1"/>') + '</svg><span>' + esc(l.name) + '</span></li>').join('') + '</ul>' : '';
    return '<figure class="ach' + (d.type === 'bar' && d.orientation === 'horizontal' ? ' h' : '') + '" data-ach="' + uid + '">'
      + '<div class="ach-plot"><svg class="ach-svg" viewBox="0 0 ' + g.W + ' ' + g.H + '" role="img" aria-label="' + esc(d.summary) + '" focusable="false">' + defs(uid, g.colors) + g.svg + (empty ? '<text x="' + g.W / 2 + '" y="' + g.H / 2 + '" text-anchor="middle" font-size="13" class="ach-cat">No data</text>' : '') + '</svg>'
      + (empty ? '' : '<svg class="ach-hit" viewBox="0 0 ' + g.W + ' ' + g.H + '" role="group" aria-label="' + esc('Data points of ' + d.title + ', ' + g.hits.length + '. Arrow keys move between them.') + '">' + pts + '</svg>') + '</div>'
      + (d.legend === false ? '' : legend)
      + '<div class="ach-foot">' + toggle + notes + '</div>' + tableHtml(d, tid, !open) + '</figure>';
  }

  /** Redraws every chart on the page at its box's width (text stays its size when the box shrinks or grows). */
  function fit(root) {
    const scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll('figure.ach[data-ach]'), (fig) => {
      const uid = fig.getAttribute('data-ach');
      const s = store.get(uid);
      const plot = fig.querySelector('.ach-plot');
      if (!s || !plot) return;
      const w = Math.round(plot.clientWidth);
      if (!w || Math.abs(w - s.width) < 24) return;
      if (fig.contains(document.activeElement)) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = render(s.data, Object.assign({}, s.opts, { uid, width: w }));
      fig.replaceWith(tmp.firstChild);
    });
  }
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => fit(document), 150); });

  // Keyboard along the points: Left and Right in a series, Up and Down across series, Home and End.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains('ach-pt')) return;
    const fig = t.closest('figure.ach');
    const all = Array.prototype.slice.call(fig.querySelectorAll('.ach-pt'));
    const s = +t.getAttribute('data-s'), i = +t.getAttribute('data-i'), k = +t.getAttribute('data-k');
    const find = (fn) => all.find(fn);
    const same = all.filter((p) => +p.getAttribute('data-s') === s).sort((a, b) => +a.getAttribute('data-i') - +b.getAttribute('data-i'));
    const at = same.indexOf(t);
    let next = null;
    if (e.key === 'ArrowRight') next = same[at + 1] || null;
    else if (e.key === 'ArrowLeft') next = at > 0 ? same[at - 1] : null;
    else if (e.key === 'ArrowDown') next = find((p) => +p.getAttribute('data-i') === i && +p.getAttribute('data-s') === s + 1) || all[k + 1] || null;
    else if (e.key === 'ArrowUp') next = find((p) => +p.getAttribute('data-i') === i && +p.getAttribute('data-s') === s - 1) || (k > 0 ? all[k - 1] : null);
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else return;
    e.preventDefault();
    if (!next) return;
    all.forEach((p) => p.setAttribute('tabindex', '-1'));
    next.setAttribute('tabindex', '0');
    next.focus();
  });
  document.addEventListener('click', (e) => {
    const pt = e.target && e.target.closest ? e.target.closest('.ach-pt') : null;
    if (pt) { const fig = pt.closest('figure.ach'); fig.querySelectorAll('.ach-pt').forEach((p) => p.setAttribute('tabindex', '-1')); pt.setAttribute('tabindex', '0'); pt.focus(); return; }
    const b = e.target && e.target.closest ? e.target.closest('[data-ach-table]') : null;
    if (!b) return;
    const uid = b.getAttribute('data-ach-table');
    const box = document.getElementById(uid + '-table');
    if (!box) return;
    const show = box.hasAttribute('hidden');
    if (show) { box.removeAttribute('hidden'); openTables.add(uid); } else { box.setAttribute('hidden', ''); openTables.delete(uid); }
    b.setAttribute('aria-expanded', show ? 'true' : 'false');
    b.textContent = show ? 'Hide table' : 'View as table';
  });

  App.appsChart = { render, fit, css: () => '<style>' + CSS + '</style>', tableOf };

  // ---------- the builder ----------

  function blank(ent) {
    return { type: 'bar', source: { kind: 'entity', entity: ent ? ent.name : '', view: null }, dimension: null, split: null, measures: [{ op: 'count', label: null }], orientation: 'vertical', stacking: 'grouped', compare: null, sort: { by: 'key', dir: 'asc' }, limit: 50, colors: [], labels: { title: null, x: null, y: null, values: false, legend: true } };
  }
  const indexed = (f) => f.indexed || f.unique;
  function dimensionOptions(ent) {
    const out = [{ value: '', label: 'None' }];
    if (!ent) return out;
    if (ent.definition.states) out.push({ value: 'state', label: 'State' });
    (ent.definition.fields || []).forEach((f) => { if (indexed(f) && f.type !== 'json' && f.type !== 'relation') out.push({ value: f.name, label: (f.title || f.name) + (f.type === 'date' ? ' (date)' : '') }); });
    out.push({ value: 'createdAt', label: 'Created (date)' }, { value: 'updatedAt', label: 'Updated (date)' });
    return out;
  }
  const isDate = (ent, n) => n === 'createdAt' || n === 'updatedAt' || !!(ent && (ent.definition.fields || []).some((f) => f.name === n && f.type === 'date'));
  function measureFields(ent) { return ent ? (ent.definition.fields || []).filter((f) => indexed(f) && ['number', 'date', 'boolean', 'formula'].indexOf(f.type) >= 0).map((f) => ({ value: f.name, label: f.title || f.name })) : []; }

  App.appsChartBuilder = function (ctx, app, deps, chart, onSaved) {
    const canQuery = App.can('connections:query');
    const def = chart && chart.definition ? JSON.parse(JSON.stringify(chart.definition)) : blank(app.entities[0]);
    const meta = { name: chart ? chart.name : '', shared: chart ? chart.shared : false, canShare: !!deps.canShare };
    const views = {};
    let timer = null, seqNo = 0;
    const entOf = () => (def.source.kind === 'entity' ? app.entities.find((e) => e.name === def.source.entity || e.id === def.source.entity) || null : null);
    const loadViews = (ent) => {
      if (!ent || views[ent.id]) return Promise.resolve();
      views[ent.id] = [];
      return App.get('/api/apps/' + enc(app.id) + '/entities/' + enc(ent.id) + '/views').then((r) => { views[ent.id] = r.views || []; }).catch(() => { views[ent.id] = []; });
    };
    const g = (label, ctl, hint, cls) => '<div class="' + (cls || '') + '">' + UI.field(label, ctl, hint) + '</div>';
    function form() {
      const ent = entOf();
      const src = def.source;
      const kinds = [{ value: 'entity', label: 'Records of an entity' }].concat(canQuery || src.kind !== 'entity' ? [{ value: 'query', label: 'A saved query' }, { value: 'rest', label: 'A REST endpoint' }] : []);
      let h = '<div class="acb-grid">'
        + g('Name', UI.input(meta.name, { attrs: 'data-acb="name" maxlength="100"' }), 'Shown on dashboards; the chart title when Title is empty.')
        + g('Type', UI.select(TYPES, def.type, 'data-acb="type"'))
        + g('Source', UI.select(kinds, src.kind, 'data-acb="kind"'), src.kind === 'entity' ? 'Counted and summed as each reader may read the records.' : 'Read as each reader, who needs connections:query.');
      if (src.kind === 'entity') {
        h += g('Entity', UI.select(app.entities.map((e) => ({ value: e.name, label: e.title || e.name })), src.entity, 'data-acb="entity"'));
        const vs = (ent && views[ent.id]) || [];
        h += g('Saved view', UI.select([{ value: '', label: 'All records' }].concat(vs.map((v) => ({ value: v.id, label: v.name + (v.shared ? ' (shared)' : ' (private)') }))), src.view || '', 'data-acb="view"'), 'Its filters apply; readers who cannot see the view see the chart as not available.');
      } else if (src.kind === 'query') {
        h += g('Saved query', UI.input(src.query || '', { attrs: 'data-acb="query" maxlength="63"', placeholder: 'name or id' })) + g('Parameters (JSON)', UI.textarea(JSON.stringify(src.params || {}), { rows: 1, attrs: 'data-acb="params" spellcheck="false"' }));
      } else {
        h += g('REST connection', UI.input(src.connection || '', { attrs: 'data-acb="connection" maxlength="63"' })) + g('Endpoint', UI.input(src.endpoint || '', { attrs: 'data-acb="endpoint" maxlength="63"' })) + '<div class="span2">' + UI.field('Parameters (JSON)', UI.textarea(JSON.stringify(src.params || {}), { rows: 1, attrs: 'data-acb="params" spellcheck="false"' })) + '</div>';
      }
      if (def.type !== 'number') {
        const dimCtl = ent ? UI.select(dimensionOptions(ent), def.dimension ? def.dimension.field : '', 'data-acb="dim"') : UI.input(def.dimension ? def.dimension.field : '', { attrs: 'data-acb="dimtext" maxlength="70"', placeholder: 'column' });
        h += g(def.type === 'scatter' ? 'X (dimension)' : 'Group by', dimCtl, ent ? 'Indexed fields; a date groups by a bucket.' : 'A column of the result.');
        h += g('Date bucket', UI.select(BUCKETS, def.dimension && def.dimension.bucket ? def.dimension.bucket : '', 'data-acb="bucket"' + (def.dimension && (isDate(ent, def.dimension.field) || !ent) ? '' : ' disabled')), 'Day, ISO week, month, quarter or year, in UTC.');
        if (['bar', 'line', 'area', 'table'].indexOf(def.type) >= 0) h += g('Split into series by', ent ? UI.select([{ value: '', label: 'No split' }].concat(dimensionOptions(ent).filter((o) => o.value && !isDate(ent, o.value))), def.split ? def.split.field : '', 'data-acb="split"') : UI.input(def.split ? def.split.field : '', { attrs: 'data-acb="splittext" maxlength="70"', placeholder: 'column, optional' }), 'At most 8 series; one measure.');
      }
      if (def.type === 'bar') h += g('Bars', UI.seg([{ id: 'vertical', label: 'Vertical' }, { id: 'horizontal', label: 'Horizontal' }], def.orientation, 'data-acb-seg="orientation" aria-label="Bars"')) + g('Series', UI.seg([{ id: 'grouped', label: 'Grouped' }, { id: 'stacked', label: 'Stacked' }], def.stacking, 'data-acb-seg="stacking" aria-label="Series"'));
      // measures
      const mf = measureFields(ent);
      const maxM = def.type === 'number' || def.type === 'pie' || def.type === 'donut' || def.split ? 1 : def.type === 'scatter' ? 2 : 5;
      h += '<div class="span2"><fieldset class="vstack gap6" style="border:0;padding:0;margin:0"><legend class="fl">Measures</legend>' + def.measures.map((m, i) => '<div class="acb-m">'
        + UI.field('Measure ' + (i + 1), UI.select(OPS, m.op, 'data-acb-op="' + i + '"'))
        + (m.op === 'count' ? '' : UI.field('Of', ent ? UI.select(mf.length ? mf : [{ value: '', label: 'No indexed number field' }], m.field || (mf[0] ? mf[0].value : ''), 'data-acb-mf="' + i + '"') : UI.input(m.field || '', { attrs: 'data-acb-mt="' + i + '" maxlength="70"', placeholder: 'column' })))
        + UI.field('Label', UI.input(m.label || '', { attrs: 'data-acb-ml="' + i + '" maxlength="80"', placeholder: 'optional' }))
        + (def.measures.length > 1 ? UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-acb-mdel="' + i + '" aria-label="Remove measure ' + (i + 1) + '"' }) : '') + '</div>').join('')
        + (def.measures.length < maxM ? '<div>' + UI.btn('Add measure', { size: 'xs', icon: 'plus', attrs: 'data-acb-madd' }) + '</div>' : '') + '</fieldset></div>';
      if (def.type === 'number') {
        const c = def.compare;
        h += g('Compare with', UI.select([{ value: '', label: 'Nothing' }, { value: 'target', label: 'A target' }, { value: 'previous', label: 'The previous period' }], c ? c.kind : '', 'data-acb="cmp"'));
        if (c && c.kind === 'target') h += g('Target', UI.input(String(c.value), { type: 'number', attrs: 'data-acb="target" step="any"' }));
        if (c && c.kind === 'previous') h += g('Date', ent ? UI.select(dimensionOptions(ent).filter((o) => o.value && isDate(ent, o.value)), c.field, 'data-acb="cmpfield"') : UI.input(c.field || '', { attrs: 'data-acb="cmpfieldtext" maxlength="70"' })) + g('Period', UI.select(BUCKETS.slice(1), c.period, 'data-acb="period"'), 'This period so far against the whole previous one.');
      } else {
        h += g('Sort by', UI.select([{ value: 'key', label: 'Category' }, { value: 'value', label: 'Value' }], def.sort.by, 'data-acb="sortby"')) + g('Order', UI.select([{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], def.sort.dir, 'data-acb="sortdir"'))
          + g('At most', UI.input(String(def.limit), { type: 'number', attrs: 'data-acb="limit" min="1" max="200"' }), '1 to 200 categories.')
          + g('First colour', UI.select(ORDER.map((c) => ({ value: c, label: COLOR_NAMES[c] })), def.colors && def.colors[0] ? def.colors[0] : 'accent', 'data-acb="color"'), 'Theme colours, each series also patterned.');
      }
      h += g('Title', UI.input(def.labels.title || '', { attrs: 'data-acb="title" maxlength="200"', placeholder: 'the name' }));
      if (def.type !== 'number' && def.type !== 'pie' && def.type !== 'donut') h += g('X axis label', UI.input(def.labels.x || '', { attrs: 'data-acb="xl" maxlength="80"' })) + g('Y axis label', UI.input(def.labels.y || '', { attrs: 'data-acb="yl" maxlength="80"' }));
      h += '<div class="span2 hstack wrap gap10">' + UI.check('Show values', !!def.labels.values, 'data-acb="values"') + UI.check('Legend', def.labels.legend !== false, 'data-acb="legend"') + (meta.canShare ? UI.check("Share with the app's readers", meta.shared, 'data-acb="shared"') : '') + '</div>';
      return h + '</div>';
    }
    let modalEl = null;
    const rerender = (focusSel) => {
      if (!modalEl) return;
      modalEl.querySelector('[data-acb-form]').innerHTML = form();
      if (focusSel) { const el = modalEl.querySelector(focusSel); if (el) el.focus(); }
      schedule();
    };
    const tidy = () => {
      // keep the definition within what the server accepts for its type
      if (def.type === 'number') { def.dimension = null; def.split = null; def.measures = def.measures.slice(0, 1); }
      else { def.compare = null; }
      if (def.type === 'pie' || def.type === 'donut') { def.split = null; def.measures = def.measures.slice(0, 1); }
      if (def.type === 'scatter') { def.split = null; def.measures = def.measures.slice(0, 2); }
      if (['bar', 'line', 'area', 'table'].indexOf(def.type) < 0) def.split = null;
      if (def.split) def.measures = def.measures.slice(0, 1);
      def.colors = def.colors && def.colors[0] ? ORDER.slice(ORDER.indexOf(def.colors[0])).concat(ORDER.slice(0, ORDER.indexOf(def.colors[0]))) : [];
      def.measures.forEach((m) => { if (m.op !== 'count' && !m.field) { const mf = measureFields(entOf()); m.field = mf[0] ? mf[0].value : ''; } if (m.op === 'count') delete m.field; });
    };
    const body = () => { tidy(); return JSON.parse(JSON.stringify(def)); };
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(preview, 350);
    }
    function preview() {
      if (!modalEl) return;
      const box = modalEl.querySelector('[data-acb-preview]');
      const status = modalEl.querySelector('[data-acb-status]');
      const mine = ++seqNo;
      if (def.type !== 'number' && def.type !== 'table' && !def.dimension) { box.innerHTML = '<p class="muted" style="margin:0">Choose what to group by to see a preview.</p>'; return; }
      App.post('/api/apps/' + enc(app.id) + '/charts/preview', { name: meta.name || 'Preview', definition: body() })
        .then((r) => { if (mine !== seqNo || !modalEl) return; box.innerHTML = render(r.data, { uid: 'acb-preview', width: box.clientWidth - 20 }); status.textContent = 'Preview updated. ' + r.data.summary; })
        .catch((err) => { if (mine !== seqNo || !modalEl) return; box.innerHTML = UI.problem('No preview', deps.detailOf(err), false); status.textContent = 'No preview: ' + deps.detailOf(err); });
    }
    const parseParams = (raw) => { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; } };
    deps.modal({
      title: chart ? 'Edit chart ' + esc(chart.name) : 'New chart',
      cls: 'wide',
      body: '<div data-acb-form>' + form() + '</div><div class="eyebrow" style="margin-top:12px">Live preview, computed as you</div><div class="acb-preview" data-acb-preview><p class="muted" style="margin:0">Loading…</p></div><div class="sr" role="status" aria-live="polite" data-acb-status></div><div data-acb-err role="alert"></div>' + App.appsChart.css(),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(chart ? 'Save chart' : 'Create chart', { kind: 'primary', attrs: 'data-acb-ok' }),
      onMount(m) {
        modalEl = m;
        const ent = entOf();
        loadViews(ent).then(() => rerender());
        const on = (type, fn) => m.addEventListener(type, fn);
        on('change', (e) => {
          const t = e.target;
          const k = t.getAttribute('data-acb');
          const i = t.getAttribute('data-acb-op') || t.getAttribute('data-acb-mf');
          if (t.hasAttribute('data-acb-op')) { def.measures[+t.getAttribute('data-acb-op')].op = t.value; tidy(); return rerender('[data-acb-op="' + t.getAttribute('data-acb-op') + '"]'); }
          if (t.hasAttribute('data-acb-mf')) { def.measures[+t.getAttribute('data-acb-mf')].field = t.value; return schedule(); }
          if (i != null) return;
          switch (k) {
            case 'type': def.type = t.value; if (def.type === 'number') def.measures = def.measures.slice(0, 1); tidy(); return rerender('[data-acb="type"]');
            case 'kind': def.source = t.value === 'entity' ? { kind: 'entity', entity: app.entities[0] ? app.entities[0].name : '', view: null } : t.value === 'query' ? { kind: 'query', query: '', params: {} } : { kind: 'rest', connection: '', endpoint: '', params: {} }; def.dimension = null; def.split = null; def.measures = [{ op: 'count', label: null }]; def.compare = null; loadViews(entOf()).then(() => rerender('[data-acb="kind"]')); return;
            case 'entity': def.source.entity = t.value; def.source.view = null; def.dimension = null; def.split = null; def.measures = [{ op: 'count', label: null }]; loadViews(entOf()).then(() => rerender('[data-acb="entity"]')); return;
            case 'view': def.source.view = t.value || null; return schedule();
            case 'dim': def.dimension = t.value ? { field: t.value } : null; if (def.dimension && (t.value === 'createdAt' || t.value === 'updatedAt')) def.dimension.bucket = 'month'; return rerender('[data-acb="dim"]');
            case 'bucket': if (def.dimension) { if (t.value) def.dimension.bucket = t.value; else delete def.dimension.bucket; } return schedule();
            case 'split': def.split = t.value ? { field: t.value } : null; tidy(); return rerender('[data-acb="split"]');
            case 'cmp': def.compare = t.value === 'target' ? { kind: 'target', value: 0 } : t.value === 'previous' ? { kind: 'previous', field: 'createdAt', period: 'month' } : null; return rerender('[data-acb="cmp"]');
            case 'cmpfield': def.compare.field = t.value; return schedule();
            case 'period': def.compare.period = t.value; return schedule();
            case 'sortby': def.sort.by = t.value; return schedule();
            case 'sortdir': def.sort.dir = t.value; return schedule();
            case 'color': def.colors = [t.value]; return schedule();
            case 'values': def.labels.values = t.checked; return schedule();
            case 'legend': def.labels.legend = t.checked; return schedule();
            case 'shared': meta.shared = t.checked; return;
          }
          schedule();
        });
        on('input', (e) => {
          const t = e.target;
          const k = t.getAttribute('data-acb');
          if (t.hasAttribute('data-acb-ml')) { def.measures[+t.getAttribute('data-acb-ml')].label = t.value.trim() || null; return schedule(); }
          if (t.hasAttribute('data-acb-mt')) { def.measures[+t.getAttribute('data-acb-mt')].field = t.value.trim(); return schedule(); }
          switch (k) {
            case 'name': meta.name = t.value; return;
            case 'query': def.source.query = t.value.trim(); return schedule();
            case 'connection': def.source.connection = t.value.trim(); return schedule();
            case 'endpoint': def.source.endpoint = t.value.trim(); return schedule();
            case 'params': { const p = parseParams(t.value); if (p) { def.source.params = p; schedule(); } return; }
            case 'dimtext': def.dimension = t.value.trim() ? Object.assign({}, def.dimension || {}, { field: t.value.trim() }) : null; return schedule();
            case 'splittext': def.split = t.value.trim() ? { field: t.value.trim() } : null; return schedule();
            case 'cmpfieldtext': def.compare.field = t.value.trim(); return schedule();
            case 'target': def.compare.value = Number(t.value) || 0; return schedule();
            case 'limit': def.limit = Math.max(1, Math.min(200, parseInt(t.value, 10) || 50)); return schedule();
            case 'title': def.labels.title = t.value.trim() || null; return schedule();
            case 'xl': def.labels.x = t.value.trim() || null; return schedule();
            case 'yl': def.labels.y = t.value.trim() || null; return schedule();
          }
        });
        on('click', (e) => {
          const t = e.target.closest('button');
          if (!t) return;
          if (t.hasAttribute('data-acb-madd')) { def.measures.push({ op: 'count', label: null }); return rerender('[data-acb-op="' + (def.measures.length - 1) + '"]'); }
          if (t.hasAttribute('data-acb-mdel')) { def.measures.splice(+t.getAttribute('data-acb-mdel'), 1); return rerender('[data-acb-madd],[data-acb-op="0"]'); }
          if (t.hasAttribute('data-acb-seg') || (t.parentNode && t.parentNode.hasAttribute && t.parentNode.hasAttribute('data-acb-seg'))) {
            const key = t.parentNode.getAttribute('data-acb-seg');
            if (key && t.hasAttribute('data-seg')) { def[key] = t.getAttribute('data-seg'); rerender('[data-acb-seg="' + key + '"] [data-seg="' + def[key] + '"]'); }
            return;
          }
          if (t.hasAttribute('data-acb-ok')) {
            const err = m.querySelector('[data-acb-err]');
            err.innerHTML = '';
            if (!meta.name.trim()) { err.innerHTML = UI.notice('A chart needs a name.', 'warn'); m.querySelector('[data-acb="name"]').focus(); return; }
            const payload = chart ? { rev: chart.rev, name: meta.name.trim(), definition: body() } : { name: meta.name.trim(), shared: meta.shared, definition: body() };
            if (chart && meta.shared !== chart.shared) payload.shared = meta.shared;
            const req = chart ? App.patch('/api/apps/' + enc(app.id) + '/charts/' + enc(chart.id), payload) : App.post('/api/apps/' + enc(app.id) + '/charts', payload);
            t.disabled = true;
            req.then((saved) => { modalEl = null; App.closeOverlay(); ctx.toast((chart ? 'Saved the chart ' : 'Created the chart ') + esc(saved.name) + '. Audited app.chart.' + (chart ? 'updated' : 'created') + '.', 'ok'); if (onSaved) onSaved(saved); })
              .catch((ex) => { t.disabled = false; err.innerHTML = UI.problem(chart ? 'The chart was not saved' : 'The chart was not created', deps.detailOf(ex), deps.traceOf(ex)); });
          }
        });
        setTimeout(() => { const n = m.querySelector('[data-acb="name"]'); if (n) n.focus(); }, 0);
      },
      onClose() { modalEl = null; clearTimeout(timer); }
    });
  };
})();
