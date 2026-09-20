(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  const ZONES = [
    { id: 'edge', name: 'edge', contents: 'ingress, TLS, WAF', accepts: 'corporate network only', egress: 'app', max: 'restricted', renders: 'NetworkPolicy, Compose network', version: 'v9', trust: 'private', cidrs: ['10.10.0.0/24'], peers: [{ zone: 'app', transport: 'vpc-peering', mtls: 'required' }], endpoints: [['ingress-1', 'healthy'], ['ingress-2', 'healthy'], ['waf', 'healthy']], box: { x: 30, y: 28, w: 160, h: 64 } },
    { id: 'app', name: 'app', contents: 'web, api, identity, gw, workers, Temporal', accepts: 'edge', egress: 'data, directory, inference, sandbox', max: 'restricted', renders: 'NetworkPolicy, Compose network', version: 'v9', trust: 'private', cidrs: ['10.20.0.0/22'], peers: [{ zone: 'data', transport: 'vpc-peering', mtls: 'required' }, { zone: 'directory', transport: 'vpc-peering', mtls: 'required' }, { zone: 'inference', transport: 'wireguard', mtls: 'required' }, { zone: 'sandbox', transport: 'vpc-peering', mtls: 'required' }], endpoints: [['web', 'healthy'], ['api', 'healthy'], ['identity', 'healthy'], ['inference-gw', 'healthy'], ['worker', 'healthy'], ['temporal', 'healthy']], box: { x: 245, y: 28, w: 200, h: 64 } },
    { id: 'data', name: 'data', contents: 'Postgres, Redis, RabbitMQ, MinIO', accepts: 'app, training', egress: 'none', max: 'restricted', renders: 'NetworkPolicy, Compose network', version: 'v9', trust: 'private', cidrs: ['10.30.0.0/24'], peers: [], endpoints: [['postgres-1', 'healthy'], ['redis', 'healthy'], ['rabbitmq', 'healthy'], ['minio', 'healthy']], box: { x: 560, y: 8, w: 190, h: 64 } },
    { id: 'directory', name: 'directory', contents: 'OpenLDAP, Kerberos KDC', accepts: 'identity and services binding via GSSAPI', egress: 'none', max: 'restricted', renders: 'NetworkPolicy, OpenTofu vars', version: 'v9', trust: 'private', cidrs: ['10.31.0.0/24'], peers: [], endpoints: [['ldap-1', 'healthy'], ['ldap-2', 'healthy'], ['kdc', 'healthy']], box: { x: 560, y: 96, w: 190, h: 64 } },
    { id: 'inference', name: 'inference', contents: 'Ollama pools, image workers', accepts: 'inference-gw only', egress: 'internal weight mirror only', max: 'confidential', renders: 'NetworkPolicy, OpenTofu vars', version: 'v9', trust: 'private', cidrs: ['10.40.0.0/16'], peers: [{ zone: 'app', transport: 'wireguard', mtls: 'required' }], pools: [['gpu-large', 'confidential', '3 nodes'], ['gpu-small', 'internal', '2 nodes'], ['cpu-pool', 'internal', '1 node']], endpoints: [['gpu-large-1', 'healthy'], ['gpu-large-2', 'healthy'], ['gpu-large-3', 'healthy'], ['gpu-small-1', 'healthy'], ['gpu-small-2', 'healthy'], ['cpu-1', 'healthy'], ['image-worker', 'healthy']], box: { x: 560, y: 184, w: 190, h: 64 } },
    { id: 'sandbox', name: 'sandbox', contents: 'tool runners, MCP, scripts, media', accepts: 'api', egress: 'allow-listed internal, via egress proxy', max: 'confidential', renders: 'NetworkPolicy, Compose network', version: 'v11', draft: true, trust: 'private', cidrs: ['10.50.0.0/24'], peers: [{ zone: 'app', transport: 'vpc-peering', mtls: 'required' }], endpoints: [['egress-proxy', 'healthy'], ['mcp-jira-internal', 'healthy'], ['mcp-ledger', 'healthy'], ['script-runner', 'healthy'], ['media-worker', 'healthy']], box: { x: 60, y: 184, w: 190, h: 64 } },
    { id: 'training', name: 'training', contents: 'GPU trainers', accepts: 'worker (via RabbitMQ)', egress: 'data (MinIO, Postgres)', max: 'confidential', renders: 'NetworkPolicy, OpenTofu vars', version: 'v9', trust: 'private', cidrs: ['10.60.0.0/24'], peers: [{ zone: 'data', transport: 'wireguard', mtls: 'required' }], endpoints: [['trainer-1', 'healthy']], box: { x: 870, y: 204, w: 170, h: 64 } },
    { id: 'external', name: 'external', contents: 'empty in an air-gapped site', accepts: 'nothing', egress: 'none', max: 'internal', renders: 'schema only', version: 'v9', trust: 'external', cidrs: [], peers: [], endpoints: [], external: true, box: { x: 870, y: 28, w: 170, h: 64 } }
  ];
  const EDGES = [
    ['edge', 'app', 'M190 60 H245'], ['app', 'data', 'M445 60 H520 V40 H560'], ['app', 'directory', 'M445 70 H500 V128 H560'], ['app', 'inference', 'M445 80 H480 V216 H560'], ['app', 'sandbox', 'M345 92 V216 H250'], ['training', 'data', 'M870 236 H820 V72 H750']
  ];
  const PLACED = [
    { model: 'qwen2.5:32b-q4_K_M', label: 'confidential', pool: 'gpu-large', profile: 'analyst' },
    { model: 'qwen2.5-coder:32b-q4_K_M', label: 'internal', pool: 'gpu-large', profile: 'coder' },
    { model: 'llama3.1:8b-q5_K_M', label: 'confidential', pool: 'gpu-small', profile: 'chat-default' }
  ];

  const yaml = (z) => 'apiVersion: exprsn.ai/v1\nkind: NetworkZone\nmetadata:\n  name: ' + z.id + '\n  version: ' + z.version + (z.draft ? ' (draft)' : '') + '\nspec:\n  cidrs: [' + z.cidrs.join(', ') + ']\n  trust: ' + z.trust + '\n  maxLabel: ' + z.max + '\n  egress: ' + (z.egress === 'none' ? 'deny' : 'allow-list') + '\n  peers:' + (z.peers.length ? z.peers.map((p) => '\n    - zone: ' + p.zone + '\n      transport: ' + p.transport + '\n      mtls: ' + p.mtls).join('') : ' []') + (z.pools ? '\n  inferencePools: [' + z.pools.map((p) => p[0]).join(', ') + ']' : '');

  App.register({
    id: 'zones', title: 'Zones', section: 'admin', summary: 'Zone map, ceilings, peers, endpoint health, rendered NetworkPolicy, Compose and OpenTofu diff',
    commands: [{ label: 'Propose a zone change', sub: 'Zones', run(app) { app.stateFor('zones').openPropose = true; app.render(); } }],
    states: [
      { title: 'Ceiling too low', tone: 'danger', text: 'Lowering inference to internal is refused while confidential models are placed there. Lists what must move first.', apply(ctx) { ctx.state.sel = 'inference'; ctx.state.ceilingRefused = 'internal'; ctx.rerender(); } },
      { title: 'Rendered diff', tone: 'neutral', text: 'Shows the NetworkPolicy, Compose and OpenTofu changes side by side before approval.', apply(ctx) { ctx.state.sel = 'sandbox'; ctx.state.openDiff = true; ctx.rerender(); } },
      { title: 'External zone', tone: 'info', text: 'Explains that the zone exists in the schema and stays empty because no zone has internet egress.', apply(ctx) { ctx.state.sel = 'external'; ctx.rerender(); } },
      { title: 'Endpoint unhealthy', tone: 'warn', text: 'A zone member failing health checks is marked on the diagram and in the table.', apply(ctx) { ctx.state.sel = 'inference'; ctx.state.unhealthy = 'gpu-small-2'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.sel = st.sel || 'inference'; st.versions = st.versions || {}; st.q = st.q || '';
      if (ctx.params.zone) st.sel = ctx.params.zone;
      const zone = ZONES.find((z) => z.id === st.sel) || ZONES[4];
      const health = (z) => z.endpoints.map((e) => [e[0], st.unhealthy === e[0] ? 'unhealthy' : e[1]]);
      const unhealthyZone = ZONES.find((z) => z.endpoints.some((e) => e[0] === st.unhealthy));

      // ----- svg map -----
      const box = (z) => {
        const b = z.box, sel = z.id === zone.id, bad = unhealthyZone && unhealthyZone.id === z.id;
        return '<g class="zn-box' + (sel ? ' sel' : '') + '" data-zone="' + z.id + '" tabindex="0" role="button" aria-label="Zone ' + z.name + ', max ' + z.max + '">'
          + '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="6" fill="' + (z.external ? 'none' : sel ? 'var(--accent-tint)' : 'var(--panel)') + '" stroke="' + (sel ? 'var(--accent)' : bad ? 'var(--warn-fg)' : z.external ? 'var(--faint)' : 'var(--meter)') + '" stroke-width="' + (sel || bad ? 1.5 : 1) + '"' + (z.external ? ' stroke-dasharray="4 4"' : '') + '></rect>'
          + '<text x="' + (b.x + 12) + '" y="' + (b.y + 22) + '" font-size="13" font-weight="700" fill="' + (z.external ? 'var(--muted)' : 'var(--fg)') + '">' + esc(z.name) + (z.draft ? ' · v11 draft' : '') + '</text>'
          + '<text x="' + (b.x + 12) + '" y="' + (b.y + 40) + '" font-size="11" fill="var(--muted)">' + esc(z.contents) + '</text>'
          + '<text x="' + (b.x + 12) + '" y="' + (b.y + 55) + '" font-size="11" fill="var(--fg2)">' + (z.external ? 'max internal, no egress' : 'max ' + esc(z.max)) + '</text>'
          + (bad ? '<circle cx="' + (b.x + b.w - 12) + '" cy="' + (b.y + 12) + '" r="5" fill="var(--warn-fg)"><title>' + esc(st.unhealthy) + ' failing health checks</title></circle>' : '')
          + '</g>';
      };
      const svg = '<svg viewBox="0 0 1180 300" role="img" aria-label="Zone diagram: edge to app, app to data, directory, inference and sandbox, training to data" style="display:block;width:100%;height:auto;font-family:var(--sans)">'
        + '<g fill="none" stroke-width="1.5">' + EDGES.map((e) => '<path d="' + e[2] + '" stroke="' + (e[0] === zone.id || e[1] === zone.id ? 'var(--accent)' : 'var(--meter)') + '"' + (e[0] === zone.id || e[1] === zone.id ? ' stroke-width="2"' : '') + '><title>' + e[0] + ' to ' + e[1] + ', mTLS required</title></path>').join('') + '</g>'
        + ZONES.map(box).join('')
        + '<text x="30" y="20" font-size="11" fill="var(--muted)">corporate network only</text>'
        + '<text x="870" y="290" font-size="11" fill="var(--muted)">edges: allowed peers, all mTLS</text>'
        + '</svg>';

      // ----- table -----
      const rows = ZONES.filter((z) => !st.q || (z.name + ' ' + z.accepts + ' ' + z.egress + ' ' + z.max).toLowerCase().includes(st.q.toLowerCase()));
      const table = UI.table(['Zone', 'Accepts from', 'Egress', 'Max label', 'Renders into', 'Version'], rows.map((z) => ({
        cells: ['<b>' + esc(z.name) + '</b>' + (unhealthyZone && unhealthyZone.id === z.id ? ' ' + UI.pill('1 unhealthy', 'warn') : ''), esc(z.accepts), esc(z.egress), z.external ? UI.label('internal', { sm: true }) + ' <span class="muted">cap</span>' : UI.label(z.max, { sm: true }), esc(z.renders), '<span class="mono">' + esc(st.versions[z.id] || z.version) + '</span>' + (z.draft && !st.versions[z.id] ? ' ' + UI.pill('draft', 'info') : '')],
        attrs: 'data-zone="' + z.id + '"', selected: z.id === zone.id
      })), { minWidth: '760px', emptyTitle: 'No zones match', emptyText: 'Clear the search.' });

      // ----- inspector -----
      const refused = st.ceilingRefused && zone.id === 'inference';
      const blockers = PLACED.filter((p) => ({ public: 1, internal: 2, confidential: 3, restricted: 4 })[p.label] > 2);
      const insp = '<div class="hstack" style="justify-content:space-between"><div><div class="eyebrow">Zone</div><div style="font-size:15px;font-weight:600">' + esc(zone.name) + ' <span class="mono muted" style="font-size:12px">' + esc(st.versions[zone.id] || zone.version) + '</span>' + (zone.draft ? ' ' + UI.pill('draft', 'info') : '') + '</div></div>' + (zone.external ? '' : UI.label(zone.max, { sm: true })) + '</div>'
        + (zone.external ? UI.notice('<b>External zone.</b> It exists in the schema, capped at internal, for cloud-hosted OpenAI-compatible endpoints. In this air-gapped deployment no zone has internet egress, so it stays empty and no pool or connection can be placed in it.', 'info') : '')
        + UI.kv([['Trust', esc(zone.trust)], ['CIDRs', zone.cidrs.length ? '<span class="mono">' + esc(zone.cidrs.join(', ')) + '</span>' : '<span class="muted">none</span>'], ['Accepts from', esc(zone.accepts)], ['Egress', esc(zone.egress)], ['Renders into', esc(zone.renders)], ['Members', zone.endpoints.length + (zone.pools ? ', ' + zone.pools.length + ' pools' : '')]], 2)
        + (zone.external ? '' : UI.field('Label ceiling', UI.select(['public', 'internal', 'confidential', 'restricted'], refused ? st.ceilingRefused : zone.max, 'data-ceiling'), 'Requests above the ceiling are never routed here. Lowering it is refused while placed models exceed it.'))
        + (refused ? UI.notice('<b>Ceiling too low.</b> Lowering inference to internal is refused: ' + blockers.length + ' confidential models are placed here. Move or deprecate them first.', 'danger') + UI.table(['Model', 'Label', 'Pool', 'Profile'], blockers.map((b) => ['<a href="#" data-gomodels class="mono">' + esc(b.model) + '</a>', UI.label(b.label, { sm: true }), '<a href="#" data-gopools>' + esc(b.pool) + '</a>', '<a href="#" data-goprofile="' + esc(b.profile) + '">' + esc(b.profile) + '</a>']), { clickable: false, minWidth: '0', cls: 'bare' }) + '<div>' + UI.btn('Keep confidential', { size: 'sm', attrs: 'data-keepceiling' }) + '</div>' : '')
        + '<div class="field"><span class="fl">Peers</span>' + (zone.peers.length ? UI.table(['Zone', 'Transport', 'mTLS'], zone.peers.map((p) => ['<a href="#" data-zone="' + p.zone + '">' + esc(p.zone) + '</a>', '<span class="mono">' + esc(p.transport) + '</span>', esc(p.mtls)]), { clickable: false, minWidth: '0', cls: 'bare' }) : '<div class="muted" style="font-size:12px">No outbound peers. Egress is denied.</div>') + '</div>'
        + (zone.pools ? '<div class="field"><span class="fl">Inference pools</span>' + UI.table(['Pool', 'Ceiling', 'Nodes'], zone.pools.map((p) => ['<a href="#" data-gopools>' + esc(p[0]) + '</a>', UI.label(p[1], { sm: true }), esc(p[2])]), { clickable: false, minWidth: '0', cls: 'bare' }) + '<div class="muted" style="font-size:12px">A pool ceiling can be lower than its zone: gpu-small is capped at internal.</div></div>' : '')
        + '<div class="field"><span class="fl">Endpoint health</span><div class="vstack gap4">' + (zone.endpoints.length ? health(zone).map((e) => '<div class="hstack" style="justify-content:space-between;font-size:12px"><span class="mono">' + esc(e[0]) + '</span>' + UI.pill(e[1], e[1] === 'healthy' ? 'ok' : 'warn') + (e[1] === 'unhealthy' ? UI.btn('Drain', { size: 'xs', attrs: 'data-drain="' + esc(e[0]) + '"' }) : '') + '</div>').join('') : '<div class="muted" style="font-size:12px">No members.</div>') + '</div>'
        + (st.unhealthy && unhealthyZone && unhealthyZone.id === zone.id ? UI.notice('<b>' + esc(st.unhealthy) + '</b> failed 3 of 3 health checks since 13:52. The gateway routes around it; llama3.1:8b stays served by gpu-small-1.', 'warn') : '') + '</div>'
        + UI.panel('Definition', UI.code(yaml(zone), 'yaml'), { actions: UI.btn('Copy', { size: 'xs', kind: 'ghost', attrs: 'data-copy="NetworkZone ' + zone.id + '"' }) })
        + '<div class="vstack gap6">' + UI.btn('View rendered diff', { size: 'sm', attrs: 'data-diff' }) + UI.btn('Propose change', { size: 'sm', kind: 'primary', attrs: 'data-propose' }) + '</div>';

      root.innerHTML = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}.zn-box{cursor:pointer}.zn-box:hover rect{stroke:var(--accent)}.zn-box:focus{outline:none}.zn-box:focus rect{stroke:var(--accent);stroke-width:2}</style>'
        + '<div class="page">' + UI.pagehead('Network zones', 'One definition drives gateway routing, Kubernetes NetworkPolicies, Compose networks and OpenTofu variables', UI.btn('View rendered diff', { attrs: 'data-diff' }) + UI.btn('Propose change', { kind: 'primary', attrs: 'data-propose' }))
        + UI.panel(null, svg, { cls: 'pad0', attrs: 'style="padding:8px"' })
        + '<div class="hstack wrap">' + UI.search('Search zones', 'data-q', st.q) + '<span class="muted" style="font-size:12px">Every pool, tool egress rule and external provider belongs to exactly one zone.</span></div>'
        + table
        + UI.notice('CI exposure check passed 19 Sep 13:40: no Ollama port answers from outside the inference zone.', 'ok', UI.btn('Audit event', { size: 'sm', kind: 'ghost', attrs: 'data-audit="13fd77b0"' }))
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
        + '<aside class="inspector w360">' + insp + '</aside>';

      // ----- modals -----
      function diffModal() {
        const z = zone;
        const np = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: ' + z.id + '-default\n  namespace: ' + z.id + '\nspec:\n  podSelector: {}\n  policyTypes: [Ingress, Egress]\n  ingress:\n-   - from: [{namespaceSelector: {matchLabels: {zone: app}}}]\n+   - from: [{namespaceSelector: {matchLabels: {zone: app}}, podSelector: {matchLabels: {app: api}}}]\n  egress:\n    - to: [{namespaceSelector: {matchLabels: {zone: app}}, podSelector: {matchLabels: {app: egress-proxy}}}]\n+   - to: [{ipBlock: {cidr: 10.30.0.0/24}}]\n+     ports: [{port: 9000}]';
        const compose = 'networks:\n  ' + z.id + ':\n    internal: true\n    driver: bridge\n    ipam:\n      config:\n        - subnet: 10.50.0.0/24\nservices:\n  egress-proxy:\n    networks: [' + z.id + ', app]\n+   extra_hosts:\n+     - "minio.data.internal:10.30.0.14"\n  script-runner:\n    networks: [' + z.id + ']\n-   read_only: false\n+   read_only: true';
        const tofu = 'zones = {\n  ' + z.id + ' = {\n    cidr      = "10.50.0.0/24"\n    trust     = "private"\n    max_label = "confidential"\n    egress    = "allow-list"\n-   version   = 10\n+   version   = 11\n    peers = [\n      { zone = "app", transport = "vpc-peering", mtls = true },\n+     { zone = "data", transport = "vpc-peering", mtls = true, ports = [9000] },\n    ]\n  }\n}';
        ctx.modal({ title: 'Rendered diff, ' + esc(z.name) + ' ' + esc(st.versions[z.id] || z.version) + (z.draft ? ' ' + UI.pill('draft', 'info') : ''), cls: 'wide',
          body: '<div class="fg2" style="font-size:12px">The same zone definition rendered three ways. Approving applies all three in one change; CI deploys both Compose and Helm on every merge.</div>' + UI.tabs([{ id: 'np', label: 'NetworkPolicy' }, { id: 'compose', label: 'Compose' }, { id: 'tofu', label: 'OpenTofu' }], 'np', 'id="zn-difftabs"') + '<div id="zn-diff">' + UI.code(np, 'yaml') + '</div>',
          actions: UI.btn('Close', { attrs: 'data-close' }) + (z.draft ? UI.btn('Reject draft', { kind: 'danger', attrs: 'data-reject' }) + UI.btn('Approve and apply', { kind: 'primary', attrs: 'data-approve' }) : ''),
          onMount(m) {
            const views = { np: np, compose: compose, tofu: tofu };
            App.on(m, 'click', '#zn-difftabs [data-tab]', (e, t) => { m.querySelectorAll('#zn-difftabs [data-tab]').forEach((b) => b.classList.toggle('active', b === t)); m.querySelector('#zn-diff').innerHTML = UI.code(views[t.dataset.tab], t.dataset.tab === 'tofu' ? 'hcl' : 'yaml'); });
            const a = m.querySelector('[data-approve]'); if (a) a.addEventListener('click', () => { App.closeOverlay(); st.versions[z.id] = 'v11'; z.draft = false; ctx.rerender(); ctx.toast('sandbox v11 applied: NetworkPolicy, Compose network and OpenTofu vars rendered. Audit event written.', 'ok', 5000); });
            const r = m.querySelector('[data-reject]'); if (r) r.addEventListener('click', () => { App.closeOverlay(); st.versions[z.id] = 'v10'; z.draft = false; ctx.rerender(); ctx.toast('Draft rejected. sandbox stays at v10.', 'warn'); });
          }
        });
      }
      function proposeModal() {
        ctx.modal({ title: 'Propose change',
          body: '<div class="formgrid">' + UI.field('Zone', UI.select(ZONES.filter((z) => !z.external).map((z) => z.id), zone.external ? 'app' : zone.id, 'data-pz')) + UI.field('Field', UI.select(['maxLabel', 'egress', 'peers', 'cidrs', 'inferencePools'], 'peers', 'data-pf')) + UI.field('Change', UI.input('add peer data, transport vpc-peering, mtls required, port 9000', { attrs: 'data-pv' })) + UI.field('Reason', UI.input('', { placeholder: 'Ticket or one line' })) + '</div>' + UI.notice('A proposal creates a draft version. The rendered diff is reviewed by a system admin before anything applies.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-pgo' }),
          onMount(m) { m.querySelector('[data-pgo]').addEventListener('click', () => { const id = m.querySelector('[data-pz]').value; const z = ZONES.find((x) => x.id === id); App.closeOverlay(); const n = parseInt((st.versions[id] || z.version).slice(1), 10) + 1; st.versions[id] = 'v' + n; z.draft = true; st.sel = id; ctx.rerender(); ctx.toast('Draft ' + esc(id) + ' v' + n + ' created. Open the rendered diff to review it.', 'ok', 5000); }); }
        });
      }
      if (st.openDiff) { st.openDiff = false; setTimeout(diffModal, 50); }
      if (st.openPropose) { st.openPropose = false; setTimeout(proposeModal, 50); }

      // ----- handlers -----
      ctx.on('click', '[data-zone]', (e, t) => { e.preventDefault(); st.sel = t.dataset.zone; st.ceilingRefused = null; ctx.rerender(); });
      ctx.on('keydown', '.zn-box', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = t.dataset.zone; ctx.rerender(); } });
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-q]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('change', '[data-ceiling]', (e, t) => {
        const order = { public: 1, internal: 2, confidential: 3, restricted: 4 };
        if (zone.id === 'inference' && order[t.value] < 3) { st.ceilingRefused = t.value; ctx.rerender(); ctx.toast('<b>Refused.</b> ' + blockers.length + ' confidential models are placed in inference.', 'danger'); return; }
        ctx.confirm({ title: 'Change ceiling of ' + esc(zone.name), tag: 'creates draft', tone: 'info', body: '<p class="fg2" style="margin:0">Creates a draft version with maxLabel ' + esc(t.value) + '. Routing changes only after the diff is approved.</p>', kv: [['From', esc(zone.max)], ['To', esc(t.value)]], ok: 'Create draft' }).then((ok) => { if (!ok) { ctx.rerender(); return; } const n = parseInt((st.versions[zone.id] || zone.version).slice(1), 10) + 1; st.versions[zone.id] = 'v' + n; zone.draft = true; ctx.rerender(); ctx.toast('Draft ' + esc(zone.name) + ' v' + n + ' created.', 'ok'); });
      });
      ctx.on('click', '[data-keepceiling]', () => { st.ceilingRefused = null; ctx.rerender(); });
      ctx.on('click', '[data-drain]', (e, t) => ctx.confirm({ title: 'Drain ' + esc(t.dataset.drain), tone: 'info', body: '<p class="fg2" style="margin:0">Stops new placements on this node and lets in-flight requests finish. The pool keeps serving from its other nodes.</p>', ok: 'Drain' }).then((ok) => { if (!ok) return; st.unhealthy = null; ctx.rerender(); ctx.toast(esc(t.dataset.drain) + ' draining. Node state is visible in Pools.', 'ok', 4000); }));
      ctx.on('click', '[data-diff]', diffModal);
      ctx.on('click', '[data-propose]', proposeModal);
      ctx.on('click', '[data-gomodels]', (e) => { e.preventDefault(); ctx.navigate('models'); });
      ctx.on('click', '[data-gopools]', (e) => { e.preventDefault(); ctx.navigate('pools'); });
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', '[data-audit]', (e, t) => ctx.navigate('usage-audit', { event: t.dataset.audit }));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
