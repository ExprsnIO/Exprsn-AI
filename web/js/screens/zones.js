(function () {
  const { UI, esc } = App;

  // ---------- formatting ----------
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l) + 1;
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
  const overlayOpen = () => !!document.getElementById('overlay');
  const FORMATS = [{ id: 'networkpolicy', label: 'NetworkPolicy', lang: 'yaml' }, { id: 'compose', label: 'Compose', lang: 'yaml' }, { id: 'nftables', label: 'nftables', lang: 'nft' }];
  const FIELDS = ['maxLabel', 'egress', 'peers', 'cidrs', 'accepts', 'inferencePools', 'services', 'contents'];
  const TRANSPORTS = ['vpc-peering', 'wireguard', 'ipsec', 'direct'];

  // Map positions of the default zones, from the board. Other zones are laid out in rows underneath.
  const BOX = { edge: { x: 30, y: 28, w: 160, h: 64 }, app: { x: 245, y: 28, w: 200, h: 64 }, data: { x: 560, y: 8, w: 190, h: 64 }, directory: { x: 560, y: 96, w: 190, h: 64 }, inference: { x: 560, y: 184, w: 190, h: 64 }, sandbox: { x: 60, y: 184, w: 190, h: 64 }, training: { x: 870, y: 204, w: 170, h: 64 }, external: { x: 870, y: 28, w: 170, h: 64 } };
  const PATHS = { 'edge|app': 'M190 60 H245', 'app|data': 'M445 60 H520 V40 H560', 'app|directory': 'M445 70 H500 V128 H560', 'app|inference': 'M445 80 H480 V216 H560', 'app|sandbox': 'M345 92 V216 H250', 'training|data': 'M870 236 H820 V72 H750' };

  const targetText = (t) => (t.kind === 'zone' ? t.zone : t.kind === 'cidr' ? t.cidr : 'corporate') + (t.ports && t.ports.length ? ' ' + t.ports.join(' ') : '');
  const acceptsText = (s) => s.acceptsNote || (s.accepts.length ? s.accepts.map((t) => (t.kind === 'zone' ? t.zone : t.kind === 'cidr' ? t.cidr : 'corporate network')).join(', ') : 'nothing');
  const egressText = (s) => (s.egress.mode === 'deny' ? 'none' : s.egress.note || s.egress.allow.map((t) => (t.kind === 'zone' ? t.zone : t.kind === 'cidr' ? t.cidr : 'corporate network')).join(', '));
  const rendersText = (z) => (z.external ? 'schema only' : 'NetworkPolicy, Compose network, nftables');

  // "app 11434, corporate 443, 10.1.0.0/16" <-> targets.
  const parseTargets = (text) => text.split(',').map((x) => x.trim()).filter(Boolean).map((part) => {
    const bits = part.split(/\s+/); const head = bits[0]; const ports = bits.slice(1).map((p) => parseInt(p, 10)).filter((p) => p > 0);
    if (bits.slice(1).some((p) => !/^\d+$/.test(p))) throw new Error('Ports are numbers after the destination: "' + part + '"');
    if (head === 'corporate') return { kind: 'corporate', ports };
    if (/\//.test(head)) return { kind: 'cidr', cidr: head, ports };
    return { kind: 'zone', zone: head, ports };
  });
  const list = (text) => text.split(',').map((x) => x.trim()).filter(Boolean);
  const fieldValue = (f, s) => {
    if (!s) return '';
    if (f === 'maxLabel') return s.maxLabel;
    if (f === 'egress') return s.egress.mode === 'deny' ? 'deny' : 'allow-list: ' + s.egress.allow.map(targetText).join(', ');
    if (f === 'peers') return s.peers.map((p) => p.zone + ' ' + p.transport + ' ' + p.mtls).join(', ');
    if (f === 'cidrs') return s.cidrs.join(', ');
    if (f === 'accepts') return s.accepts.map(targetText).join(', ');
    if (f === 'services') return s.services.join(', ');
    if (f === 'contents') return s.contents;
    return '';
  };
  const FIELD_HINT = {
    maxLabel: 'public, internal, confidential or restricted',
    egress: '"deny", or "allow-list: data 5432 9000, 10.0.5.0/24 443"',
    peers: 'zone transport mtls, comma separated: "app wireguard required". Transports: ' + TRANSPORTS.join(', '),
    cidrs: 'Comma separated, for example 10.50.0.0/24',
    accepts: 'Sources with optional ports: "app 11434, corporate 443, 10.1.0.0/16"',
    inferencePools: 'Pool names to move into this zone when the draft is approved',
    services: 'Compose services that run in this zone',
    contents: 'A few words shown on the map'
  };
  const buildPatch = (f, v) => {
    if (f === 'maxLabel') { if (LABELS.indexOf(v.trim()) < 0) throw new Error('Use one of ' + LABELS.join(', ') + '.'); return { patch: { maxLabel: v.trim() } }; }
    if (f === 'egress') { const t = v.trim(); if (t === 'deny') return { patch: { egress: { mode: 'deny', allow: [] } } }; const m = /^allow-list:\s*(.*)$/.exec(t); if (!m) throw new Error('Write "deny" or "allow-list: …".'); return { patch: { egress: { mode: 'allow-list', allow: parseTargets(m[1]) } } }; }
    if (f === 'peers') return { patch: { peers: list(v).map((x) => { const b = x.split(/\s+/); if (b.length !== 3) throw new Error('Each peer is "zone transport mtls": "' + x + '"'); return { zone: b[0], transport: b[1], mtls: b[2] }; }) } };
    if (f === 'cidrs') return { patch: { cidrs: list(v) } };
    if (f === 'accepts') return { patch: { accepts: parseTargets(v) } };
    if (f === 'services') return { patch: { services: list(v) } };
    if (f === 'contents') return { patch: { contents: v.trim() } };
    return { patch: {}, movePools: list(v) };
  };
  const yaml = (id, version, s, draft) => 'apiVersion: exprsn.ai/v1\nkind: NetworkZone\nmetadata:\n  name: ' + id + '\n  version: v' + version + (draft ? ' (draft)' : '') + '\nspec:\n  cidrs: [' + s.cidrs.join(', ') + ']\n  trust: ' + s.trust + '\n  maxLabel: ' + s.maxLabel
    + '\n  accepts:' + (s.accepts.length ? s.accepts.map((t) => '\n    - ' + targetText(t)).join('') : ' []')
    + '\n  egress: ' + s.egress.mode + (s.egress.mode === 'allow-list' ? s.egress.allow.map((t) => '\n    - ' + targetText(t)).join('') : '')
    + '\n  peers:' + (s.peers.length ? s.peers.map((p) => '\n    - zone: ' + p.zone + '\n      transport: ' + p.transport + '\n      mtls: ' + p.mtls).join('') : ' []')
    + (s.services.length ? '\n  services: [' + s.services.join(', ') + ']' : '');

  const download = (href) => { const a = document.createElement('a'); a.href = href; a.download = ''; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); };

  // ---------- live updates ----------
  // pools.state (instance health from the poller) and zones.state (definitions, drafts, endpoint checks) refresh the screen.
  const live = { sock: null, on: null, timer: null, last: 0, refresh: null };
  const detach = () => {
    if (live.sock) { live.sock.off('pools.state', live.on); live.sock.off('zones.state', live.on); }
    live.sock = null; live.on = null;
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  };
  const attach = () => {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.on = () => {
      if (App.state.route !== 'zones') { detach(); return; }
      if (live.timer) return;
      live.timer = setTimeout(() => { live.timer = null; if (live.refresh) live.refresh(); }, Math.max(0, 2000 - (Date.now() - live.last)));
    };
    live.sock.on('pools.state', live.on);
    live.sock.on('zones.state', live.on);
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'zones') detach(); });

  App.register({
    id: 'zones', title: 'Zones', live: true, section: 'admin', summary: 'Zone map, ceilings, peers, endpoint health, rendered NetworkPolicy, Compose and nftables diff',
    commands: [{ label: 'Propose a zone change', sub: 'Zones', run(app) { app.stateFor('zones').openPropose = true; app.render(); } }],
    states: [
      { title: 'Ceiling too low', tone: 'danger', text: 'Lowering a zone ceiling is refused while models, profiles or pools above it are placed there. Lists what must move first.',
        async apply(ctx) {
          const st = ctx.state; const zones = ((st.data && st.data.zones) || []).filter((z) => z.spec && !z.external && z.pools.length);
          for (const z of zones) {
            for (let r = rank(z.spec.maxLabel) - 1; r >= 1; r--) {
              let out; try { out = await App.get('/api/admin/zones/' + enc(z.id) + '/blockers?ceiling=' + LABELS[r - 1]); } catch (err) { App.fail(err); return; }
              if (out.blockers.length) { st.sel = z.id; st.refused = { zone: z.id, ceiling: LABELS[r - 1], blockers: out.blockers }; ctx.rerender(); return; }
            }
          }
          ctx.toast('No zone holds anything above a lower ceiling right now, so no lowering would be refused.', 'warn', 5000);
        } },
      { title: 'Rendered diff', tone: 'neutral', text: 'Shows the NetworkPolicy, Compose and nftables changes side by side before approval.',
        apply(ctx) { const st = ctx.state; const d = ((st.data && st.data.zones) || []).find((z) => z.draft); if (d) st.sel = d.id; st.openDiff = true; ctx.rerender(); } },
      { title: 'External zone', tone: 'info', text: 'Explains that the zone exists in the schema and stays empty because no zone has internet egress.',
        apply(ctx) { const st = ctx.state; const z = ((st.data && st.data.zones) || []).find((x) => x.external); if (!z) { ctx.toast('No external zone is defined. Seed the default zones to add it.', 'warn'); return; } st.sel = z.id; ctx.rerender(); } },
      { title: 'Endpoint unhealthy', tone: 'warn', text: 'A zone member failing health checks is marked on the diagram and in the table.',
        apply(ctx) { const st = ctx.state; const z = ((st.data && st.data.zones) || []).find((x) => x.members.some((m) => m.health === 'unhealthy')); if (!z) { ctx.toast('Every zone member is passing its health checks right now.', 'ok'); return; } st.sel = z.id; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.q = st.q || '';

      // ---------- loading ----------
      const refresh = () => {
        if (App.state.route !== 'zones') return;
        if (overlayOpen()) { st.dirty = true; return; }
        const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0;
        ctx.rerender();
        const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top;
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        App.get('/api/admin/zones')
          .then((data) => { Object.assign(st, { data, loaded: true, loadError: null }); live.last = Date.now(); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; refresh(); });
      };
      const quiet = () => { live.last = Date.now(); return App.get('/api/admin/zones').then((data) => { st.data = data; refresh(); }).catch((err) => App.fail(err, 'Could not refresh zones')); };
      live.refresh = quiet;
      attach();
      if (!st.loaded && !st.loadError) load();

      const style = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}.zn-box{cursor:pointer}.zn-box:hover rect{stroke:var(--accent)}.zn-box:focus{outline:none}.zn-box:focus rect{stroke:var(--accent);stroke-width:2}.zn-ep{display:flex;gap:6px;align-items:center;justify-content:space-between;font-size:12px}.zn-ep .grow{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style>';
      const head = (actions) => UI.pagehead('Network zones', 'One definition drives gateway routing, Kubernetes NetworkPolicies, Compose networks and host nftables rules', actions);
      if (st.loadError) { root.innerHTML = style + '<div class="page">' + head('') + UI.problem('Zones could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div></div>'; ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); }); return; }
      if (!st.loaded) { root.innerHTML = style + '<div class="page">' + head('') + UI.notice('Loading…', 'info') + '</div>'; return; }

      const data = st.data;
      const ZONES = data.zones;
      const seed = () => ctx.confirm({ title: 'Seed default zones', tag: 'platform-wide', tone: 'info', body: '<p class="fg2" style="margin:0">Creates ' + esc(data.defaults.join(', ')) + ' as approved version 1. A default ceiling is raised to what a zone already holds, so no request that works now is refused afterwards. Later changes need a second system admin.</p>', ok: 'Seed zones' }).then(async (ok) => {
        if (!ok) return;
        try {
          const out = await App.post('/api/admin/zones/seed');
          ctx.toast('Created ' + esc(out.created.join(', ') || 'nothing') + '.' + (out.adjusted.length ? ' Raised ' + out.adjusted.map((a) => esc(a.zone + ' to ' + a.to)).join(', ') + ' to fit what they hold.' : '') + ' Audit event written.', 'ok', 6000);
          st.sel = null; quiet();
        } catch (err) { App.fail(err); }
      });
      if (!ZONES.length) {
        root.innerHTML = style + '<div class="page">' + head('') + UI.empty('No zones defined', 'Until zones are defined, no zone ceiling applies to routing and nothing is rendered. Seed the default set (edge, app, data, directory, inference, sandbox, training and external) and change it from there.', UI.btn('Seed default zones', { kind: 'primary', attrs: 'data-seed' }))
          + (data.undefinedRefs.length ? UI.notice('Pools and services already name zones: ' + esc(data.undefinedRefs.map((u) => u.zone).join(', ')) + '. Seeding creates the default ones; others need a proposal.', 'info') : '') + '</div>';
        ctx.on('click', '[data-seed]', seed);
        return;
      }
      if (ctx.params.zone && !st.paramApplied) { st.sel = ctx.params.zone; st.paramApplied = true; }
      const zone = ZONES.find((z) => z.id === st.sel) || ZONES.find((z) => z.id === 'inference') || ZONES[0];
      st.sel = zone.id;
      const spec = zone.spec || zone.draft.spec;
      const unhealthyOf = (z) => z.members.filter((m) => m.health === 'unhealthy');
      const verText = (z) => (z.version ? 'v' + z.version : 'new');

      // ----- svg map -----
      let extra = 0;
      const boxes = {};
      ZONES.forEach((z) => { boxes[z.id] = BOX[z.id] || { x: 30 + (extra % 5) * 230, y: 300 + Math.floor(extra++ / 5) * 90, w: 190, h: 64 }; });
      const height = 300 + Math.ceil(extra / 5) * 90;
      const box = (z) => {
        const b = boxes[z.id], sel = z.id === zone.id, bad = unhealthyOf(z).length > 0, s = z.spec || z.draft.spec;
        return '<g class="zn-box' + (sel ? ' sel' : '') + '" data-zone="' + esc(z.id) + '" tabindex="0" role="button" aria-label="Zone ' + esc(z.id) + ', max ' + esc(s.maxLabel) + '">'
          + '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="6" fill="' + (z.external ? 'none' : sel ? 'var(--accent-tint)' : 'var(--panel)') + '" stroke="' + (sel ? 'var(--accent)' : bad ? 'var(--warn-fg)' : z.external ? 'var(--faint)' : 'var(--meter)') + '" stroke-width="' + (sel || bad ? 1.5 : 1) + '"' + (z.external || !z.spec ? ' stroke-dasharray="4 4"' : '') + '></rect>'
          + '<text x="' + (b.x + 12) + '" y="' + (b.y + 22) + '" font-size="13" font-weight="700" fill="' + (z.external ? 'var(--muted)' : 'var(--fg)') + '">' + esc(z.id) + (z.draft ? ' · v' + z.draft.version + ' draft' : '') + '</text>'
          + '<text x="' + (b.x + 12) + '" y="' + (b.y + 40) + '" font-size="11" fill="var(--muted)">' + esc((s.contents || '').length > Math.floor((b.w - 20) / 5.6) ? (s.contents || '').slice(0, Math.floor((b.w - 20) / 5.6) - 1) + '…' : (s.contents || '')) + '</text>'
          + '<text x="' + (b.x + 12) + '" y="' + (b.y + 55) + '" font-size="11" fill="var(--fg2)">' + (z.external ? 'max ' + esc(s.maxLabel) + ', no egress' : 'max ' + esc(s.maxLabel)) + '</text>'
          + (bad ? '<circle cx="' + (b.x + b.w - 12) + '" cy="' + (b.y + 12) + '" r="5" fill="var(--warn-fg)"><title>' + esc(unhealthyOf(z).map((m) => m.name).join(', ')) + ' failing health checks</title></circle>' : '')
          + '</g>';
      };
      const pairs = [];
      ZONES.forEach((z) => (z.spec ? z.spec.peers : []).forEach((p) => { if (!boxes[p.zone]) return; const k = [z.id, p.zone]; if (!pairs.some((x) => (x[0] === k[0] && x[1] === k[1]) || (x[0] === k[1] && x[1] === k[0]))) pairs.push(k.concat([p.transport, p.mtls])); }));
      const pathFor = (a, b) => {
        if (BOX[a] === boxes[a] && BOX[b] === boxes[b]) { if (PATHS[a + '|' + b]) return PATHS[a + '|' + b]; if (PATHS[b + '|' + a]) return PATHS[b + '|' + a]; }
        let p = boxes[a], q = boxes[b]; if (q.x < p.x) { const t = p; p = q; q = t; }
        if (q.x > p.x + p.w) { const mid = Math.round((p.x + p.w + q.x) / 2); return 'M' + (p.x + p.w) + ' ' + (p.y + p.h / 2) + ' H' + mid + ' V' + (q.y + q.h / 2) + ' H' + q.x; }
        const top = p.y < q.y ? p : q, bot = p.y < q.y ? q : p;
        return 'M' + (top.x + top.w / 2) + ' ' + (top.y + top.h) + ' V' + bot.y;
      };
      const svg = '<svg viewBox="0 0 1180 ' + height + '" role="img" aria-label="Zone diagram: ' + esc(pairs.map((p) => p[0] + ' to ' + p[1]).join(', ') || 'no peers') + '" style="display:block;width:100%;height:auto;font-family:var(--sans)">'
        + '<g fill="none" stroke-width="1.5">' + pairs.map((e) => { const on = e[0] === zone.id || e[1] === zone.id; return '<path d="' + pathFor(e[0], e[1]) + '" stroke="' + (on ? 'var(--accent)' : 'var(--meter)') + '"' + (on ? ' stroke-width="2"' : '') + (e[3] !== 'required' ? ' stroke-dasharray="3 3"' : '') + '><title>' + esc(e[0] + ' to ' + e[1] + ', ' + e[2] + ', mTLS ' + e[3]) + '</title></path>'; }).join('') + '</g>'
        + ZONES.map(box).join('')
        + (boxes.edge === BOX.edge ? '<text x="30" y="20" font-size="11" fill="var(--muted)">' + esc(ZONES.find((z) => z.id === 'edge') && ZONES.find((z) => z.id === 'edge').spec ? acceptsText(ZONES.find((z) => z.id === 'edge').spec) : '') + '</text>' : '')
        + '<text x="870" y="290" font-size="11" fill="var(--muted)">edges: allowed peers' + (pairs.every((p) => p[3] === 'required') ? ', all mTLS' : '; dashed: mTLS optional') + '</text>'
        + '</svg>';

      // ----- table -----
      const rows = ZONES.filter((z) => { const s = z.spec || z.draft.spec; return !st.q || (z.id + ' ' + acceptsText(s) + ' ' + egressText(s) + ' ' + s.maxLabel + ' ' + s.contents).toLowerCase().indexOf(st.q.toLowerCase()) >= 0; });
      const table = UI.table(['Zone', 'Accepts from', 'Egress', 'Max label', 'Renders into', 'Version'], rows.map((z) => {
        const s = z.spec || z.draft.spec; const bad = unhealthyOf(z).length;
        return {
          cells: ['<b>' + esc(z.id) + '</b>' + (bad ? ' ' + UI.pill(bad + ' unhealthy', 'warn') : ''), esc(acceptsText(s)), esc(egressText(s)), z.external ? UI.label(s.maxLabel, { sm: true }) + ' <span class="muted">cap</span>' : UI.label(s.maxLabel, { sm: true }), esc(rendersText(z)), '<span class="mono">' + esc(verText(z)) + '</span>' + (z.draft ? ' ' + UI.pill('v' + z.draft.version + ' draft', 'info') : '')],
          attrs: 'data-zone="' + esc(z.id) + '"', selected: z.id === zone.id
        };
      }), { minWidth: '760px', emptyTitle: 'No zones match', emptyText: 'Clear the search.' });

      // ----- inspector -----
      const refused = st.refused && st.refused.zone === zone.id ? st.refused : null;
      const blockerRows = refused ? refused.blockers.map((b) => [
        b.model ? '<a href="#" data-gomodels class="mono">' + esc(b.model) + '</a>' : b.connection ? 'connection <span class="mono">' + esc(b.connection) + '</span>' : '<span class="muted">pool ceiling</span>',
        UI.label(b.label, { sm: true }),
        b.pool ? '<a href="#" data-gopools>' + esc(b.pool) + '</a>' : '<span class="muted">none</span>',
        b.profile ? '<a href="#" data-goprofile="' + esc(b.profile) + '">' + esc(b.profile) + '</a>' + (b.tenant ? ' <span class="muted">' + esc(b.tenant) + '</span>' : '') : b.tenant ? '<span class="muted">' + esc(b.tenant) + '</span>' : '<span class="muted">none</span>'
      ]) : [];
      const bad = unhealthyOf(zone);
      const healthKind = (h) => ({ healthy: 'ok', degraded: 'warn', unhealthy: 'danger', unknown: 'outline' }[h] || '');
      const memberRow = (m) => {
        const drained = m.state === 'draining' || m.state === 'drained';
        const label = m.kind === 'instance' ? 'Ollama instance in ' + m.pool : m.kind === 'endpoint' ? 'endpoint ' + (m.address || '') : m.kind === 'mcp' ? 'MCP server' + (m.tenant ? ', ' + m.tenant : '') : 'connection' + (m.tenant ? ', ' + m.tenant : '');
        return '<div class="zn-ep"><span class="mono grow" title="' + esc(label + (m.detail ? ': ' + m.detail : '')) + '">' + esc(m.name) + '</span>'
          + UI.pill(drained ? m.state : m.health, drained ? 'warn' : healthKind(m.health))
          + (m.drainable && !drained && (m.health === 'unhealthy' || m.health === 'degraded') ? UI.btn('Drain', { size: 'xs', attrs: 'data-drain="' + esc(m.ref) + '" data-name="' + esc(m.name) + '"' }) : '')
          + (m.drainable && drained ? UI.btn('Undrain', { size: 'xs', kind: 'ghost', attrs: 'data-undrain="' + esc(m.ref) + '" data-name="' + esc(m.name) + '"' }) : '')
          + (m.kind === 'endpoint' ? UI.iconbtn('x', 'Remove ' + m.name, { cls: 'sm ghost', attrs: 'data-rmep="' + esc(m.ref.split(':')[1]) + '" data-name="' + esc(m.name) + '"' }) : '')
          + '</div>';
      };
      const lowerPool = zone.pools.find((p) => rank(p.labelCeiling) < rank(spec.maxLabel));
      const insp = '<div class="hstack" style="justify-content:space-between"><div><div class="eyebrow">Zone</div><div style="font-size:15px;font-weight:600">' + esc(zone.id) + ' <span class="mono muted" style="font-size:12px">' + esc(verText(zone)) + '</span>' + (zone.draft ? ' ' + UI.pill('v' + zone.draft.version + ' draft', 'info') : '') + '</div></div>' + (zone.external ? '' : UI.label(spec.maxLabel, { sm: true })) + '</div>'
        + (zone.external ? UI.notice('<b>External zone.</b> It exists in the schema, capped at ' + esc(spec.maxLabel) + ', for cloud-hosted OpenAI-compatible endpoints. ' + (data.airGapped ? 'In this air-gapped deployment no zone has internet egress, so it stays empty and no pool, connection or endpoint can be placed in it.' : 'It stays empty: no pool, connection or endpoint can be placed in it yet.'), 'info') : '')
        + (zone.draft ? UI.notice('<b>v' + zone.draft.version + ' draft</b> proposed by ' + esc(zone.draft.proposedByName || 'someone') + ' ' + esc(when(zone.draft.proposedAt)) + (zone.draft.reason ? ': ' + esc(zone.draft.reason) : '') + '. ' + (zone.draft.mine ? 'Another system admin must approve it.' : 'Review the rendered diff to approve or reject it.'), 'info', UI.btn('Review', { size: 'sm', attrs: 'data-diff' })) : '')
        + UI.kv([['Trust', esc(spec.trust)], ['CIDRs', spec.cidrs.length ? '<span class="mono">' + esc(spec.cidrs.join(', ')) + '</span>' : '<span class="muted">none</span>'], ['Accepts from', esc(acceptsText(spec))], ['Egress', esc(egressText(spec))], ['Renders into', esc(rendersText(zone))], ['Members', zone.members.length + (zone.pools.length ? ', ' + zone.pools.length + ' pools' : '')]], 2)
        + (zone.external || !zone.spec ? '' : UI.field('Label ceiling', UI.select(LABELS, refused ? refused.ceiling : spec.maxLabel, 'data-ceiling' + (zone.draft ? ' disabled title="A draft is waiting for review"' : '')), 'Requests above the ceiling are never routed here. Lowering it is refused while placed models exceed it.'))
        + (refused ? UI.notice('<b>Ceiling too low.</b> Lowering ' + esc(zone.id) + ' to ' + esc(refused.ceiling) + ' is refused: ' + refused.blockers.length + ' ' + (refused.blockers.length === 1 ? 'item is' : 'items are') + ' above ' + esc(refused.ceiling) + ' here. Move or deprecate them first.', 'danger') + '<div>' + UI.table(['Model', 'Label', 'Pool', 'Profile'], blockerRows, { clickable: false, minWidth: '0', cls: 'bare' }) + '</div><div>' + UI.btn('Keep ' + esc(spec.maxLabel), { size: 'sm', attrs: 'data-keepceiling' }) + '</div>' : '')
        + '<div class="field"><span class="fl">Peers</span>' + (spec.peers.length ? UI.table(['Zone', 'Transport', 'mTLS'], spec.peers.map((p) => ['<a href="#" data-zone="' + esc(p.zone) + '">' + esc(p.zone) + '</a>', '<span class="mono">' + esc(p.transport) + '</span>', esc(p.mtls)]), { clickable: false, minWidth: '0', cls: 'bare' }) : '<div class="muted" style="font-size:12px">No outbound peers.' + (spec.egress.mode === 'deny' ? ' Egress is denied.' : '') + '</div>') + '</div>'
        + (zone.pools.length ? '<div class="field"><span class="fl">Inference pools</span>' + UI.table(['Pool', 'Ceiling', 'Nodes'], zone.pools.map((p) => ['<a href="#" data-gopools>' + esc(p.name) + '</a>', UI.label(p.effectiveCeiling, { sm: true }) + (p.effectiveCeiling !== p.labelCeiling ? ' <span class="muted" title="The pool is cleared higher; the zone ceiling applies">zone cap</span>' : ''), esc(p.instances + (p.instances === 1 ? ' node' : ' nodes'))]), { clickable: false, minWidth: '0', cls: 'bare' }) + (lowerPool ? '<div class="muted" style="font-size:12px">A pool ceiling can be lower than its zone: ' + esc(lowerPool.name) + ' is capped at ' + esc(lowerPool.labelCeiling) + '.</div>' : '') + '</div>' : '')
        + '<div class="field"><div class="hstack" style="justify-content:space-between"><span class="fl">Endpoint health</span><span class="hstack gap4">' + UI.btn('Check now', { size: 'xs', kind: 'ghost', attrs: 'data-check' }) + (zone.external || !zone.spec ? '' : UI.btn('Register', { size: 'xs', kind: 'ghost', icon: 'plus', attrs: 'data-addep' })) + '</span></div><div class="vstack gap4">' + (zone.members.length ? zone.members.map(memberRow).join('') : '<div class="muted" style="font-size:12px">No members.</div>') + '</div>'
        + bad.map((m) => UI.notice('<b>' + esc(m.name) + '</b> ' + (m.kind === 'endpoint' ? 'failed ' + m.checks + ' of ' + m.checks + ' health checks since ' + esc(clock(m.since)) + '.' : m.kind === 'instance' ? 'is not answering the gateway poller' + (m.since ? ' (last seen ' + esc(when(m.since)) + ')' : '') + '. The gateway routes around it' + (zone.members.some((x) => x.kind === 'instance' && x.pool === m.pool && x.health === 'healthy') ? '; ' + esc(m.pool) + ' keeps serving from its other nodes.' : '.') : 'is failing its health checks.') + (m.detail ? ' <span class="muted">' + esc(m.detail) + '</span>' : ''), 'warn')).join('') + '</div>'
        + UI.panel('Definition', UI.code(yaml(zone.id, zone.version || zone.draft.version, spec, !zone.spec), 'yaml'), { actions: UI.btn('Copy', { size: 'xs', kind: 'ghost', attrs: 'data-copy' }) })
        + '<div class="vstack gap6">' + UI.btn('View rendered diff', { size: 'sm', attrs: 'data-diff' }) + UI.btn('Propose change', { size: 'sm', kind: 'primary', attrs: 'data-propose' }) + '</div>';

      // Sprint 18 (B-908): connections and MCP servers registered before zones were defined, outside what their zone admits.
      function misplacedPanel() {
        const list = data.misplaced || [];
        if (!list.length) return '';
        const rows = list.map((m) => [
          esc(m.kind === 'mcp' ? 'MCP server' : 'Connection'),
          '<b>' + esc(m.name) + '</b>' + (m.tenant ? ' <span class="muted">' + esc(m.tenant) + '</span>' : ''),
          '<span class="mono">' + esc(m.zone) + '</span>',
          esc(m.reason),
          m.pending ? '<span class="muted">Draft pending in ' + esc(m.pending) + '</span>'
            : m.suggestion ? UI.btn('Propose move to ' + esc(m.suggestion), { size: 'xs', attrs: 'data-movemember="' + esc(m.kind + ':' + m.id) + '" data-target="' + esc(m.suggestion) + '" data-name="' + esc(m.name) + '"' })
            : '<span class="muted">No defined zone admits it</span>'
        ]);
        return UI.notice('<b>' + list.length + (list.length === 1 ? ' member is' : ' members are') + ' outside their zone.</b> They were registered before zones were defined. Each move is a proposal another system admin approves.', 'warn')
          + '<div>' + UI.table(['Kind', 'Name', 'Zone', 'Why', 'Move'], rows, { clickable: false, minWidth: '0', cls: 'bare' }) + '</div>';
      }

      const notices = (data.problems.length ? UI.notice('<b>The current zone set has ' + data.problems.length + (data.problems.length === 1 ? ' problem' : ' problems') + '.</b> ' + data.problems.map((p) => esc(p.message)).join(' '), 'warn') : '')
        + (data.undefinedRefs.length ? UI.notice('Members name zones that are not defined: ' + data.undefinedRefs.map((u) => '<b>' + esc(u.zone) + '</b> (' + esc(u.pools.map((x) => 'pool ' + x).concat(u.members).join(', ')) + ')').join('; ') + '. No zone ceiling applies to them until the zone is defined.', 'warn') : '')
        + misplacedPanel()
        + (data.lastChange ? UI.notice('Last zone change ' + esc(when(data.lastChange.ts)) + ': ' + esc(data.lastChange.action.replace(/^zone\./, '').replace(/\./g, ' ')) + ' ' + esc([data.lastChange.target.zone, data.lastChange.target.version ? 'v' + data.lastChange.target.version : ''].concat(data.lastChange.target.zones || []).filter(Boolean).join(' ')) + '.', 'ok', UI.btn('Audit event', { size: 'sm', kind: 'ghost', attrs: 'data-audit="' + esc(data.lastChange.id) + '"' })) : '');

      root.innerHTML = style
        + '<div class="page">' + head(UI.btn('Download', { icon: 'download', attrs: 'data-download' }) + UI.btn('View rendered diff', { attrs: 'data-diff' }) + UI.btn('Propose change', { kind: 'primary', attrs: 'data-propose' }))
        + UI.panel(null, svg, { cls: 'pad0', attrs: 'style="padding:8px"' })
        + '<div class="hstack wrap">' + UI.search('Search zones', 'data-q', st.q) + '<span class="muted" style="font-size:12px">Every pool, tool egress rule and external provider belongs to exactly one zone.</span>' + (data.defaults.length && data.defaults.length < 8 ? UI.btn('Add missing default zones', { size: 'sm', kind: 'ghost', attrs: 'data-seed' }) : '') + '</div>'
        + table
        + notices
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
        + '<aside class="inspector w360">' + insp + '</aside>';

      // ----- modals -----
      const onClose = () => { if (st.dirty) { st.dirty = false; refresh(); } };
      async function diffModal() {
        const z = zone;
        let d;
        try { d = await App.get('/api/admin/zones/' + enc(z.id) + '/diff'); } catch (err) { App.fail(err, 'Could not render the diff'); return; }
        const isDraft = d.to.status === 'draft';
        const view = (f) => UI.code(d.renders[f].text, FORMATS.find((x) => x.id === f).lang);
        const stats = (f) => '<span class="muted" style="font-size:12px">' + (d.from ? 'v' + d.from.version + ' to v' + d.to.version : 'new, v' + d.to.version) + ': ' + d.renders[f].added + ' added, ' + d.renders[f].removed + ' removed</span>';
        let tab = 'networkpolicy';
        ctx.modal({ title: 'Rendered diff, ' + esc(z.id) + ' v' + d.to.version + (isDraft ? ' ' + UI.pill('draft', 'info') : ''), cls: 'wide',
          body: '<div class="fg2" style="font-size:12px">The same zone definition rendered three ways. Approving applies all three in one change and routing follows at once; deploy the downloaded files with Compose, Helm or nft.' + (d.to.reason ? ' Reason: ' + esc(d.to.reason) + '.' : '') + (d.to.movePools && d.to.movePools.length ? ' Moves pools ' + esc(d.to.movePools.join(', ')) + ' into ' + esc(z.id) + '.' : '') + (z.draft && z.draft.moveMembers && z.draft.moveMembers.length ? ' Moves ' + esc(z.draft.moveMembers.map((m) => m.name).join(', ')) + ' into ' + esc(z.id) + '.' : '') + '</div>'
            + UI.tabs(FORMATS.map((f) => ({ id: f.id, label: f.label })), tab, 'id="zn-difftabs"') + '<div id="zn-stats">' + stats(tab) + '</div><div id="zn-diff">' + view(tab) + '</div>',
          actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Download', { icon: 'download', kind: 'ghost', attrs: 'data-dl' })
            + (isDraft ? (z.draft && z.draft.mine ? UI.btn('Withdraw draft', { kind: 'danger', attrs: 'data-withdraw' }) : UI.btn('Reject draft', { kind: 'danger', attrs: 'data-reject' }) + UI.btn('Approve and apply', { kind: 'primary', attrs: 'data-approve' })) : ''),
          onClose,
          onMount(m) {
            App.on(m, 'click', '#zn-difftabs [data-tab]', (e, t) => { tab = t.dataset.tab; m.querySelectorAll('#zn-difftabs [data-tab]').forEach((b) => { b.classList.toggle('active', b === t); b.setAttribute('aria-selected', b === t ? 'true' : 'false'); b.setAttribute('tabindex', b === t ? '0' : '-1'); }); m.querySelector('#zn-diff').innerHTML = view(tab); m.querySelector('#zn-stats').innerHTML = stats(tab); });
            m.querySelector('[data-dl]').addEventListener('click', () => download('/api/admin/zones/' + enc(z.id) + '/rendered/' + tab + '?version=' + d.to.version));
            const act = async (path, body, msg, kind) => {
              try { await App.post('/api/admin/zones/' + enc(z.id) + '/draft/' + path, body); App.closeOverlay(); st.refused = null; ctx.toast(msg, kind, 5000); quiet(); } catch (err) { App.fail(err); }
            };
            const a = m.querySelector('[data-approve]'); if (a) a.addEventListener('click', () => act('approve', {}, esc(z.id) + ' v' + d.to.version + ' applied: routing uses it now, and the NetworkPolicy, Compose network and nftables rules are rendered. Audit event written.', 'ok'));
            const r = m.querySelector('[data-reject]'); if (r) r.addEventListener('click', () => act('reject', {}, 'Draft rejected. ' + esc(z.id) + ' stays at ' + esc(verText(z)) + '.', 'warn'));
            const w = m.querySelector('[data-withdraw]'); if (w) w.addEventListener('click', () => act('withdraw', {}, 'Draft withdrawn. ' + esc(z.id) + ' stays at ' + esc(verText(z)) + '.', 'warn'));
          }
        });
      }
      const showRefusal = (err, zid) => {
        const p = err && err.problem;
        if (p && p.title === 'Ceiling too low') { st.sel = zid; st.refused = { zone: zid, ceiling: p.ceiling, blockers: p.blockers || [] }; ctx.rerender(); ctx.toast('<b>Refused.</b> ' + esc(p.detail), 'danger', 7000); return true; }
        return false;
      };
      const propose = async (zid, body, okMsg) => {
        try {
          const out = await App.post('/api/admin/zones/' + enc(zid) + '/proposals', body);
          App.closeOverlay(); st.sel = zid; st.refused = null;
          ctx.toast('Draft ' + esc(zid) + ' v' + out.version + ' created' + (okMsg || '') + '. ' + (out.notified ? out.notified + ' other system ' + (out.notified === 1 ? 'admin was' : 'admins were') + ' asked to review it.' : 'Another system admin must approve it.'), 'ok', 6000);
          quiet();
        } catch (err) { App.closeOverlay(); if (!showRefusal(err, zid)) App.fail(err, 'Proposal refused'); }
      };
      function proposeModal() {
        const choices = ZONES.filter((z) => !z.external && z.spec).map((z) => z.id);
        const start = choices.indexOf(zone.id) >= 0 ? zone.id : choices[0];
        const startZone = ZONES.find((z) => z.id === start);
        ctx.modal({ title: 'Propose change',
          body: '<div class="formgrid">' + UI.field('Zone', UI.select(choices.concat(['new zone']), start, 'data-pz')) + '<div data-newid style="display:none" class="vstack gap6">' + UI.field('Zone id', UI.input('', { attrs: 'data-pid maxlength="31"', placeholder: 'lab' }), 'Lower case letters, digits and dashes') + UI.field('Label ceiling', UI.select(LABELS, 'internal', 'data-pmax')) + UI.field('CIDRs', UI.input('', { attrs: 'data-pcidr', placeholder: '10.70.0.0/24' }), FIELD_HINT.cidrs) + UI.field('Peers', UI.input('', { attrs: 'data-ppeers', placeholder: 'app wireguard required' }), FIELD_HINT.peers) + '<div class="muted" style="font-size:12px">Egress starts as deny. Change the rest in later proposals.</div></div>'
            + '<div data-fieldwrap class="vstack gap6">' + UI.field('Field', UI.select(FIELDS, 'peers', 'data-pf')) + UI.field('Change', UI.input(fieldValue('peers', startZone && startZone.spec), { attrs: 'data-pv' }), '<span data-phint>' + esc(FIELD_HINT.peers) + '</span>') + '</div>' + UI.field('Reason', UI.input('', { placeholder: 'Ticket or one line', attrs: 'data-preason maxlength="500"' })) + '</div>' + UI.notice('A proposal creates a draft version. The rendered diff is reviewed by another system admin before anything applies.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-pgo' }),
          onClose,
          onMount(m) {
            const $ = (s) => m.querySelector(s);
            const sync = () => {
              const isNew = $('[data-pz]').value === 'new zone';
              $('[data-newid]').style.display = isNew ? '' : 'none';
              $('[data-fieldwrap]').style.display = isNew ? 'none' : '';
              if (isNew) return;
              const f = $('[data-pf]').value;
              const z = ZONES.find((x) => x.id === $('[data-pz]').value);
              $('[data-pv]').value = fieldValue(f, z && z.spec);
              $('[data-phint]').textContent = FIELD_HINT[f];
            };
            $('[data-pz]').addEventListener('change', sync);
            $('[data-pf]').addEventListener('change', sync);
            $('[data-pgo]').addEventListener('click', async () => {
              const zid = $('[data-pz]').value; const reason = $('[data-preason]').value.trim() || null; const v = $('[data-pv]').value;
              if (zid === 'new zone') {
                const id = $('[data-pid]').value.trim();
                try {
                  const newSpec = { maxLabel: $('[data-pmax]').value, cidrs: list($('[data-pcidr]').value), peers: buildPatch('peers', $('[data-ppeers]').value).patch.peers };
                  const out = await App.post('/api/admin/zones', { id, spec: newSpec, reason });
                  App.closeOverlay(); st.sel = id; ctx.toast('Zone ' + esc(id) + ' proposed as draft v' + out.version + '. Another system admin must approve it.', 'ok', 6000); quiet();
                } catch (err) { if (err.problem) App.fail(err, 'Proposal refused'); else ctx.toast(esc(err.message), 'danger'); }
                return;
              }
              let body;
              try { body = buildPatch($('[data-pf]').value, v); } catch (err) { ctx.toast(esc(err.message), 'danger'); return; }
              body.reason = reason;
              propose(zid, body);
            });
          }
        });
      }
      function endpointModal() {
        ctx.modal({ title: 'Register endpoint in ' + esc(zone.id),
          body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-en maxlength="100"', placeholder: 'postgres-1' })) + UI.field('Address', UI.input('', { attrs: 'data-ea maxlength="300"', placeholder: 'http://10.30.0.14:9000/minio/health/live or 10.30.0.10:5432' }), 'An http(s) URL is checked with GET; host:port with a TCP connect') + UI.field('Kind', UI.input('service', { attrs: 'data-ek maxlength="40"' })) + '</div>' + UI.notice('The platform checks registered endpoints every few minutes. Pool instances are checked by the gateway poller and appear on their own.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Register', { kind: 'primary', attrs: 'data-ego' }),
          onClose,
          onMount(m) {
            m.querySelector('[data-ego]').addEventListener('click', async () => {
              try {
                const e = await App.post('/api/admin/zones/' + enc(zone.id) + '/endpoints', { name: m.querySelector('[data-en]').value.trim(), address: m.querySelector('[data-ea]').value.trim(), kind: m.querySelector('[data-ek]').value.trim() || 'service' });
                App.closeOverlay(); ctx.toast(esc(e.name) + ' registered: ' + esc(e.health) + (e.health_detail ? ' (' + esc(e.health_detail) + ')' : '') + '. Audit event written.', e.health === 'healthy' ? 'ok' : 'warn', 5000); quiet();
              } catch (err) { App.fail(err, 'Could not register the endpoint'); }
            });
          }
        });
      }
      function downloadModal() {
        ctx.modal({ title: 'Download rendered configuration',
          body: '<div class="fg2" style="font-size:12px">Every current zone in one file per format. Drafts are not included until they are approved.</div><div class="vstack gap6" style="margin-top:10px">'
            + FORMATS.map((f) => UI.btn(f.label + (f.id === 'networkpolicy' ? ' (Kubernetes, Helm)' : f.id === 'compose' ? ' (networks for compose.yml)' : ' (bare-metal hosts)'), { icon: 'download', attrs: 'data-dlf="' + f.id + '"' })).join('') + '</div>'
            + UI.notice('Selected zone only: ' + esc(zone.id) + (zone.version ? ' v' + zone.version : '') + '.', 'info', zone.version ? FORMATS.map((f) => UI.btn(f.label, { size: 'sm', kind: 'ghost', attrs: 'data-dlz="' + f.id + '"' })).join(' ') : ''),
          actions: UI.btn('Close', { attrs: 'data-close' }),
          onClose,
          onMount(m) {
            App.on(m, 'click', '[data-dlf]', (e, t) => download('/api/admin/zones/rendered/' + t.dataset.dlf));
            App.on(m, 'click', '[data-dlz]', (e, t) => download('/api/admin/zones/' + enc(zone.id) + '/rendered/' + t.dataset.dlz));
          }
        });
      }
      if (st.openDiff) { st.openDiff = false; setTimeout(diffModal, 50); }
      if (st.openPropose) { st.openPropose = false; setTimeout(proposeModal, 50); }

      // ----- handlers -----
      ctx.on('click', '[data-zone]', (e, t) => { e.preventDefault(); st.sel = t.dataset.zone; st.refused = null; ctx.rerender(); });
      ctx.on('keydown', '.zn-box', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = t.dataset.zone; st.refused = null; ctx.rerender(); } });
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-q]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('change', '[data-ceiling]', async (e, t) => {
        const to = t.value;
        if (to === spec.maxLabel) { st.refused = null; ctx.rerender(); return; }
        if (rank(to) < rank(spec.maxLabel)) {
          let out; try { out = await App.get('/api/admin/zones/' + enc(zone.id) + '/blockers?ceiling=' + to); } catch (err) { App.fail(err); ctx.rerender(); return; }
          if (out.blockers.length) { st.refused = { zone: zone.id, ceiling: to, blockers: out.blockers }; ctx.rerender(); ctx.toast('<b>Refused.</b> ' + out.blockers.length + ' ' + (out.blockers.length === 1 ? 'item' : 'items') + ' above ' + esc(to) + ' ' + (out.blockers.length === 1 ? 'is' : 'are') + ' in ' + esc(zone.id) + '.', 'danger'); return; }
        }
        ctx.confirm({ title: 'Change ceiling of ' + esc(zone.id), tag: 'creates draft', tone: 'info', body: '<p class="fg2" style="margin:0">Creates a draft version with maxLabel ' + esc(to) + '. Routing changes only after another system admin approves the diff.</p>', kv: [['From', esc(spec.maxLabel)], ['To', esc(to)]], ok: 'Create draft' }).then((ok) => { if (!ok) { ctx.rerender(); return; } propose(zone.id, { patch: { maxLabel: to }, reason: 'Ceiling ' + spec.maxLabel + ' to ' + to }); });
      });
      ctx.on('click', '[data-keepceiling]', () => { st.refused = null; ctx.rerender(); });
      ctx.on('click', '[data-drain]', (e, t) => ctx.confirm({ title: 'Drain ' + esc(t.dataset.name), tone: 'info', body: '<p class="fg2" style="margin:0">' + (/^instance:/.test(t.dataset.drain) ? 'Stops new requests on this node, lets in-flight requests finish, then unloads its models. The pool keeps serving from its other nodes.' : 'Stops health checks and alerts for this endpoint until it is undrained.') + '</p>', ok: 'Drain' }).then(async (ok) => {
        if (!ok) return;
        try { await App.post('/api/admin/zones/' + enc(zone.id) + '/members/drain', { ref: t.dataset.drain }); ctx.toast(esc(t.dataset.name) + ' draining. Node state is visible in Pools.', 'ok', 4000); quiet(); } catch (err) { App.fail(err); }
      }));
      ctx.on('click', '[data-undrain]', async (e, t) => { try { await App.post('/api/admin/zones/' + enc(zone.id) + '/members/undrain', { ref: t.dataset.undrain }); ctx.toast(esc(t.dataset.name) + ' is back in service.', 'ok'); quiet(); } catch (err) { App.fail(err); } });
      ctx.on('click', '[data-rmep]', (e, t) => ctx.confirm({ title: 'Remove ' + esc(t.dataset.name), tone: 'danger', body: '<p class="fg2" style="margin:0">The endpoint is no longer checked or listed in ' + esc(zone.id) + '.</p>', ok: 'Remove' }).then(async (ok) => {
        if (!ok) return;
        try { await App.del('/api/admin/zones/' + enc(zone.id) + '/endpoints/' + enc(t.dataset.rmep)); ctx.toast(esc(t.dataset.name) + ' removed. Audit event written.', 'ok'); quiet(); } catch (err) { App.fail(err); }
      }));
      ctx.on('click', '[data-check]', async () => { try { const out = await App.post('/api/admin/zones/' + enc(zone.id) + '/endpoints/check'); ctx.toast(out.length ? out.length + ' registered ' + (out.length === 1 ? 'endpoint' : 'endpoints') + ' checked: ' + out.filter((x) => x.health === 'healthy').length + ' healthy.' : 'No registered endpoints to check. Pool instances are checked by the gateway poller.', 'ok'); quiet(); } catch (err) { App.fail(err); } });
      ctx.on('click', '[data-addep]', endpointModal);
      ctx.on('click', '[data-movemember]', (e, t) => {
        const [kind, id] = t.dataset.movemember.split(':');
        const target = t.dataset.target;
        ctx.confirm({ title: 'Move ' + esc(t.dataset.name) + ' to ' + esc(target), tone: 'info', body: '<p class="fg2" style="margin:0">Creates a draft of the ' + esc(target) + ' zone that moves ' + esc(t.dataset.name) + ' into it. Another system admin approves it before anything changes.</p>', ok: 'Propose move' }).then((ok) => {
          if (ok) propose(target, { moveMembers: [{ kind, id }], reason: 'Registered before zones were defined' }, ' to move ' + esc(t.dataset.name));
        });
      });
      ctx.on('click', '[data-copy]', () => { const text = yaml(zone.id, zone.version || zone.draft.version, spec, !zone.spec); (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'))).then(() => ctx.toast('NetworkZone ' + esc(zone.id) + ' copied.', 'ok'), () => ctx.toast('The clipboard is not available here.', 'warn')); });
      ctx.on('click', '[data-diff]', diffModal);
      ctx.on('click', '[data-propose]', proposeModal);
      ctx.on('click', '[data-download]', downloadModal);
      ctx.on('click', '[data-seed]', seed);
      ctx.on('click', '[data-gomodels]', (e) => { e.preventDefault(); ctx.navigate('models'); });
      ctx.on('click', '[data-gopools]', (e) => { e.preventDefault(); ctx.navigate('pools'); });
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', '[data-audit]', (e, t) => ctx.navigate('usage-audit', { event: t.dataset.audit }));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
