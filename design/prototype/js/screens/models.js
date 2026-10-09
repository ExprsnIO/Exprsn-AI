(function () {
  const { UI, esc } = App;

  const STEPS = ['draft', 'evaluated', 'approved', 'deprecated', 'retired'];
  const MODELS = [
    { id: 'qwen2.5:32b-q4_K_M', family: 'Qwen 2.5', size: '32B', caps: ['chat', 'tools'], label: 'confidential', lifecycle: 'approved', digest: 'sha256:41ab9c0e7f5d2b18...e3a7', full: 'sha256:41ab9c0e7f5d2b18c4a6f0d9e2b7c1a8f5e3d2c1b0a9f8e7d6c5b4a3f2e1d0e3a7', ctx: '32,768', source: 'Ollama library, import bundle 2026-35', licence: 'Apache 2.0, recorded', manifest: 'verified', hw: 'cuda passed, rocm passed, cpu passed', conf: '44 of 44 passed', confTone: 'ok', pools: ['gpu-large'], profiles: ['analyst'] },
    { id: 'llama3.1:8b-q5_K_M', family: 'Llama 3.1', size: '8B', caps: ['chat', 'tools'], label: 'confidential', lifecycle: 'approved', digest: 'sha256:7d21e6b03a9f4c55...0b2d', full: 'sha256:7d21e6b03a9f4c55e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a60b2d', ctx: '32,768', source: 'Ollama library, import bundle 2026-35', licence: 'Llama 3.1 Community, recorded', manifest: 'verified', hw: 'cuda passed, cpu passed', conf: '43 of 44 passed', confTone: 'ok', pools: ['gpu-large', 'cpu-helpers'], profiles: ['general-8b', 'chat-default'] },
    { id: 'qwen2.5-coder:32b-q4_K_M', family: 'Qwen 2.5', size: '32B', caps: ['chat', 'tools'], label: 'internal', lifecycle: 'evaluated', digest: 'sha256:9f2c41d07be6a3...c81e', full: 'sha256:9f2c41d07be6a3f1e8d2c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7c81e', ctx: '32,768', source: 'Ollama library, import bundle 2026-37', licence: 'Apache 2.0, recorded', manifest: 'verified', hw: 'cuda passed, cpu passed', conf: '41 of 44 passed', confTone: 'warn', pools: ['gpu-large'], profiles: ['coder-32b', 'code'], warn: 'The tools capability is withheld until the conformance suite passes. Approval is still possible for chat only.' },
    { id: 'nomic-embed-text:v1.5', family: 'Nomic', size: '137M', caps: ['embed'], label: 'restricted', lifecycle: 'approved', digest: 'sha256:0c6e3d4a1f9b2e77...94af', full: 'sha256:0c6e3d4a1f9b2e77d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f494af', ctx: '8,192', source: 'Ollama library, import bundle 2026-31', licence: 'Apache 2.0, recorded', manifest: 'verified', hw: 'cpu passed, cuda passed', conf: 'not applicable, no tools capability', confTone: '', pools: ['cpu-helpers'], profiles: [] },
    { id: 'llama-guard3:8b', family: 'Llama Guard', size: '8B', caps: ['chat'], label: 'restricted', lifecycle: 'approved', digest: 'sha256:b3a8f1c92d0e6547...1e60', full: 'sha256:b3a8f1c92d0e6547a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c41e60', ctx: '8,192', source: 'Ollama library, import bundle 2026-31', licence: 'Llama 3.1 Community, recorded', manifest: 'verified', hw: 'cpu passed, cuda passed', conf: 'not applicable, guard model', confTone: '', pools: ['cpu-helpers'], profiles: [], guard: true },
    { id: 'finance-lora-v3:8b', family: 'Llama 3.1', size: '8B', caps: ['chat'], label: 'confidential', lifecycle: 'draft', digest: 'sha256:e5d09a7c3b2f1486...77c3', full: 'sha256:e5d09a7c3b2f1486b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d377c3', ctx: '32,768', source: 'Internal fine-tune, training job finance-lora-v3', licence: 'Inherits Llama 3.1 Community, recorded', manifest: 'signed, cosign key northwind-ml', hw: 'cuda passed', conf: 'not run', confTone: '', pools: ['none until approved'], profiles: [], evalNote: 'Registration waits on the guardrail red-team suite, which is below its threshold (0.968 against 0.980).' },
    { id: 'system', family: 'Apple Foundation Model', size: 'on-device', caps: ['chat', 'tools'], label: 'internal', lifecycle: 'evaluated', held: true, server: 'mac-studio-1-fm', digest: 'held by the server, no digest', full: 'held by the server, no digest', ctx: 'not reported by the server', source: 'Model server mac-studio-1-fm (fm serve on a Unix socket), model id system', licence: 'Apple Foundation Models terms, recorded', manifest: 'not applicable', hw: 'metal passed', conf: '2 of 2 passed', confTone: 'ok', pools: ['apple-silicon'], profiles: [], reported: { server: 'fm serve', tools: 'work', json: 'works', embeddings: 'not offered: knowledge and memory embed on an Ollama pool' }, heldNote: 'Held by the server: nothing is pulled and there is no digest to verify. The server\'s model id stands in for it; the licence, the conformance run and a second approver still apply.' },
    { id: 'llama3:8b-q4_0', family: 'Llama 3', size: '8B', caps: ['chat'], label: 'internal', lifecycle: 'deprecated', digest: 'sha256:2a7c9e4d0b1f8365...5bd2', full: 'sha256:2a7c9e4d0b1f8365c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e25bd2', ctx: '8,192', source: 'Ollama library, import bundle 2026-12', licence: 'Llama 3 Community, recorded', manifest: 'verified', hw: 'cuda passed, cpu passed', conf: '38 of 44 passed', confTone: 'warn', pools: ['gpu-large'], profiles: [], depNote: 'Deprecated on 2 Sep. New profiles cannot pick it; existing profiles keep routing until 30 Sep, then it retires.' }
  ];
  const CAPS = ['chat', 'tools', 'embed', 'vision', 'thinking'];
  // B-43: Chat Completions servers registered as instances (Apple's fm serve, mlx_lm.server, llama-server).
  const SERVERS = [
    { name: 'mac-studio-1-fm', pool: 'apple-silicon', transport: 'socket', target: '/var/run/exprsn/fm.sock', token: false, health: 'healthy', server: 'fm serve', ctx: 'not reported', tools: 'work', json: 'works', embeddings: 'not offered', models: [{ id: 'system', available: true, catalogued: true }, { id: 'pcc', available: false, reason: 'PCC inference is not available in this context.' }] },
    { name: 'mac-studio-1-llama', pool: 'apple-silicon', transport: 'url', target: 'http://10.20.4.31:8081', token: true, health: 'healthy', server: 'llama.cpp', ctx: '32,768', tools: 'work', json: 'works', embeddings: 'offered', models: [{ id: 'qwen2.5-7b-instruct-q4_k_m.gguf', available: true }] },
    { name: 'mac-mini-2-mlx', pool: 'apple-silicon', transport: 'url', target: 'http://10.20.4.32:8080', token: false, health: 'unreachable', server: 'chat-completions', ctx: 'not reported', tools: 'not probed', json: 'not probed', embeddings: 'not tried', models: [{ id: 'mlx-community/Qwen3-4B-4bit', available: true }] }
  ];

  // ---- 2.0.0 cloud model backends (B-105; every one needs B-43's ModelServer interface and format: server entries) ----
  const PROVIDERS = ['all', 'Ollama', 'Bedrock', 'Azure AI Foundry', 'DigitalOcean GenAI', 'Workers AI'];
  const cloudRow = (o) => Object.assign({ digest: 'held by the provider, no digest', full: 'held by the provider, no digest', source: 'Provider catalogue, account ' + o.cloud.account, licence: 'Provider service terms, recorded on the account', manifest: 'not applicable', hw: 'not applicable, provider-hosted', pools: ['none (provider endpoint)'], conf: 'not run', confTone: '', profiles: [] }, o);
  const CLOUD = [
    cloudRow({ id: 'amazon.nova-pro-v1:0', provider: 'Bedrock', family: 'Amazon Nova', size: 'eu-central-1', caps: ['chat', 'tools'], label: 'confidential', lifecycle: 'approved', ctx: '300,000', conf: '44 of 44 passed', confTone: 'ok', profiles: ['analyst-cloud'], cloud: { account: 'aws-prod', region: 'eu-central-1', regionCeiling: 'confidential', price: '$0.80 in, $3.20 out per 1M tokens', endpoint: 'Bedrock Converse and ConverseStream, SigV4 with the account\'s federated role', residency: 'Single-region model id: runs in eu-central-1 only.', guardrail: 'Bedrock Guardrail gr-example01, an extra layer; Exprsn-AI guardrails run first and last and stay authoritative', gateway: 'off' } }),
    cloudRow({ id: 'eu.amazon.nova-lite-v1:0', provider: 'Bedrock', family: 'Amazon Nova (inference profile)', size: 'eu-* (EU regions only)', caps: ['chat'], label: 'internal', lifecycle: 'evaluated', ctx: '300,000', conf: '41 of 44 passed', confTone: 'warn', cloud: { account: 'aws-prod', region: 'EU cross-region inference profile', regionCeiling: 'internal', price: '$0.06 in, $0.24 out per 1M tokens', endpoint: 'Bedrock Converse through an inference profile', residency: 'A cross-region profile may run in any EU region of the profile. Cross-region profiles are refused above internal by default, so the ceiling is internal.', guardrail: 'none on the provider side; Exprsn-AI guardrails only', gateway: 'off' }, warn: 'The tools capability is withheld until the conformance suite passes. Approval is still possible for chat only.' }),
    cloudRow({ id: 'amazon.titan-embed-text-v2:0', provider: 'Bedrock', family: 'Amazon Titan', size: 'eu-central-1', caps: ['embed'], label: 'confidential', lifecycle: 'approved', ctx: '8,192', conf: 'not applicable, no tools capability', profiles: ['knowledge-embed'], cloud: { account: 'aws-prod', region: 'eu-central-1', regionCeiling: 'confidential', price: '$0.02 per 1M tokens', endpoint: 'Bedrock InvokeModel (embeddings)', residency: 'Single-region model id: runs in eu-central-1 only.', guardrail: 'not applicable to embeddings', gateway: 'off' } }),
    cloudRow({ id: 'nw-gpt-4-1-mini', provider: 'Azure AI Foundry', family: 'gpt-4.1-mini (deployment)', size: 'swedencentral', caps: ['chat', 'tools'], label: 'confidential', lifecycle: 'approved', ctx: '1,047,576', conf: '44 of 44 passed', confTone: 'ok', profiles: ['analyst-cloud'], cloud: { account: 'azure-eu', region: 'swedencentral', regionCeiling: 'confidential', price: '$0.40 in, $1.60 out per 1M tokens', endpoint: 'kind: openai, Azure OpenAI v1 with an Entra token from the federated credential', residency: 'Regional deployment in swedencentral; data stays in the region.', guardrail: 'Azure content filter results mapped to guardrail decisions; Exprsn-AI guardrails stay authoritative', gateway: 'on (Cloudflare AI Gateway; logs off for content above internal)' } }),
    cloudRow({ id: 'nw-embed-3-large', provider: 'Azure AI Foundry', family: 'text-embedding-3-large (deployment)', size: 'swedencentral', caps: ['embed'], label: 'confidential', lifecycle: 'approved', ctx: '8,191', conf: 'not applicable, no tools capability', profiles: ['knowledge-embed'], cloud: { account: 'azure-eu', region: 'swedencentral', regionCeiling: 'confidential', price: '$0.13 per 1M tokens', endpoint: 'kind: openai, /embeddings on the Azure OpenAI v1 endpoint', residency: 'Regional deployment in swedencentral.', guardrail: 'not applicable to embeddings', gateway: 'on (Cloudflare AI Gateway; logs off for content above internal)' } }),
    cloudRow({ id: 'llama3.3-70b-instruct', provider: 'DigitalOcean GenAI', family: 'Llama 3.3', size: 'global endpoint', caps: ['chat'], label: 'internal', lifecycle: 'draft', ctx: '128,000', cloud: { account: 'do-team', region: 'global serverless endpoint', regionCeiling: 'internal', price: '$0.65 in, $0.65 out per 1M tokens', endpoint: 'kind: openai, serverless inference with a model access key from the vault', residency: 'The serverless endpoint does not pin a region, so the ceiling is internal.', guardrail: 'none on the provider side; Exprsn-AI guardrails only', gateway: 'off' }, evalNote: 'Conformance has not run yet. Approval waits on an eval record for this provider endpoint.' }),
    cloudRow({ id: '@cf/meta/llama-3.1-8b-instruct', provider: 'Workers AI', family: 'Llama 3.1', size: 'Cloudflare edge', caps: ['chat'], label: 'internal', lifecycle: 'evaluated', ctx: '128,000', conf: '43 of 44 passed', confTone: 'ok', profiles: ['edge-chat'], cloud: { account: 'cf-edge', region: 'Cloudflare edge', regionCeiling: 'internal', price: 'priced in neurons, example $0.011 per 1,000 neurons', endpoint: 'kind: openai, Workers AI OpenAI-compatible endpoint with a scoped API token', residency: 'Runs at the Cloudflare edge location nearest the gateway; the edge ceiling is internal.', guardrail: 'none on the provider side; Exprsn-AI guardrails only', gateway: 'on (Cloudflare AI Gateway; logs off for content above internal)' } })
  ];
  // Importable provider models per account (the Cloud catalogue modal). Prices are example data.
  const CATALOGUE = [
    { account: 'aws-prod', provider: 'Bedrock', where: 'eu-central-1', rows: [['amazon.nova-pro-v1:0', 'chat, tools', '$0.80 / $3.20'], ['eu.amazon.nova-lite-v1:0', 'chat', '$0.06 / $0.24'], ['amazon.titan-embed-text-v2:0', 'embed', '$0.02'], ['amazon.nova-micro-v1:0', 'chat', '$0.035 / $0.14'], ['us.amazon.nova-pro-v1:0', 'chat, tools', '$0.80 / $3.20', 'US cross-region profile']] },
    { account: 'azure-eu', provider: 'Azure AI Foundry', where: 'swedencentral deployments', rows: [['nw-gpt-4-1-mini', 'chat, tools', '$0.40 / $1.60'], ['nw-embed-3-large', 'embed', '$0.13'], ['nw-gpt-4-1-nano', 'chat, tools', '$0.10 / $0.40']] },
    { account: 'do-team', provider: 'DigitalOcean GenAI', where: 'serverless inference', rows: [['llama3.3-70b-instruct', 'chat', '$0.65 / $0.65'], ['mistral-nemo-instruct-2407', 'chat', '$0.30 / $0.30']] },
    { account: 'cf-edge', provider: 'Workers AI', where: 'Cloudflare edge', rows: [['@cf/meta/llama-3.1-8b-instruct', 'chat', 'neurons'], ['@cf/baai/bge-m3', 'embed', 'neurons']] }
  ];

  function menu(ctx, host, items, cur, onPick) {
    ctx.$$('.dropdown').forEach((d) => d.remove());
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it) + '" class="' + (it === cur ? 'on' : '') + '">' + esc(it) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; d.remove(); onPick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function h(e) { if (!d.contains(e.target)) { d.remove(); document.removeEventListener('click', h); } }), 0);
  }

  App.register({
    id: 'models', title: 'Models', summary: 'Catalog, signed import path, lifecycle approvals, quantization builds', section: 'admin', crumb: ['Admin', 'Models'],
    commands: [{ label: 'Request model import', sub: 'Models', run(app) { app.stateFor('models').openRequest = true; app.render(); } }, { label: 'Register model server', sub: 'Models', run(app) { app.stateFor('models').openServers = true; app.render(); } },
      { label: 'Import from cloud catalogue', sub: 'Models, cloud providers', run(app) { app.stateFor('models').openCatalogue = true; app.render(); } }],
    states: [
      { title: 'Pickle rejected', tone: 'danger', text: 'Import refused: the archive contains a pickle checkpoint. Only GGUF and safetensors are accepted.', apply(ctx) { ctx.state.problem = 'pickle'; ctx.rerender(); } },
      { title: 'Digest mismatch', tone: 'danger', text: 'The blob digest does not match the approved manifest. The gateway refuses the blob and nothing is registered.', apply(ctx) { ctx.state.problem = 'digest'; ctx.rerender(); } },
      { title: 'Licence missing', tone: 'warn', text: 'Approve is disabled until the licence field is completed and reviewed.', apply(ctx) { ctx.state.selected = 'qwen2.5-coder:32b-q4_K_M'; ctx.state.licenceMissing = true; ctx.rerender(); } },
      { title: 'Server model unavailable', tone: 'warn', text: 'The model server lists the model but reports it unavailable (Private Cloud Compute on fm serve). It cannot be registered.', apply(ctx) { ctx.state.openRequest = 'server'; ctx.state.pickUnavailable = true; ctx.rerender(); } },
      { title: 'Cross-region profile refused', tone: 'danger', text: 'Importing us.amazon.nova-pro-v1:0 at confidential is refused: a cross-region inference profile may run outside the account\'s allowed regions and is capped at internal.', apply(ctx) { ctx.state.problem = 'crossregion'; ctx.state.noB43 = false; ctx.rerender(); } },
      { title: 'B-43 not installed', tone: 'warn', text: 'Cloud backends need the model server interface from B-43. Without it the cloud rows are listed as unavailable and the Cloud catalogue is disabled.', apply(ctx) { ctx.state.noB43 = true; ctx.state.provider = 'all'; ctx.state.selected = 'amazon.nova-pro-v1:0'; ctx.rerender(); } },
      { title: 'Agent without an owner', tone: 'warn', text: 'The Inventory tab lists Triage as incomplete: no owner. With the owner requirement on, its review cannot publish it until one is named.', apply(ctx) { ctx.state.view = 'inventory'; ctx.state.invSel = 1; ctx.state.requireOwner = true; ctx.rerender(); } },
      { title: 'Retired', tone: 'neutral', text: 'Retired tags stay resolvable for audit and are removed from routing. Shown read-only.', apply(ctx) { ctx.state.lc = ctx.state.lc || {}; ctx.state.lc['llama3:8b-q4_0'] = 'retired'; ctx.state.selected = 'llama3:8b-q4_0'; ctx.state.lifecycle = 'all'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.selected = st.selected || 'qwen2.5-coder:32b-q4_K_M'; st.query = st.query || ''; st.lifecycle = st.lifecycle || 'all'; st.cap = st.cap || 'all';
      st.lc = st.lc || {}; st.extra = st.extra || []; st.reveal = st.reveal || {}; st.servers = st.servers || SERVERS.slice(); st.provider = st.provider || 'all';
      if (ctx.params.model) { st.selected = ctx.params.model; delete ctx.params.model; }
      if (ctx.params.provider && st.provHash !== location.hash) { st.provHash = location.hash; st.provider = ctx.params.provider; if (st.provider === 'cloud') st.selected = 'amazon.nova-pro-v1:0'; }
      const all = MODELS.concat(CLOUD, st.extra);
      const provOf = (m) => m.provider || 'Ollama';
      const provOk = (m) => st.provider === 'all' || (st.provider === 'cloud' ? provOf(m) !== 'Ollama' : provOf(m) === st.provider);
      const lcOf = (m) => st.lc[m.id] || m.lifecycle;
      const q = st.query.toLowerCase();
      const rows = all.filter((m) => (!q || (m.id + ' ' + m.family + ' ' + m.caps.join(' ')).toLowerCase().includes(q)) && (st.lifecycle === 'all' || lcOf(m) === st.lifecycle) && (st.cap === 'all' || m.caps.includes(st.cap)) && provOk(m));
      const sel = all.find((m) => m.id === st.selected) || all[0];
      const lc = lcOf(sel);
      const licenceMissing = st.licenceMissing && sel.id === 'qwen2.5-coder:32b-q4_K_M';
      const readOnly = lc === 'retired';

      const stepper = '<div class="models-steps">' + STEPS.map((s, i) => '<span class="' + (s === lc ? 'cur' : STEPS.indexOf(lc) > i ? 'done' : '') + '">' + s + '</span>' + (i < STEPS.length - 1 ? '<span class="sep">›</span>' : '')).join('') + '</div>';
      const digest = sel.held ? '<span class="fg2">held by the server, no digest</span>' : st.reveal[sel.id] ? '<span class="mono fg2" style="overflow-wrap:anywhere">' + esc(sel.full) + '</span> <a href="#" data-reveal style="font-size:12px">hide</a>' : '<span class="mono fg2">' + esc(sel.digest) + '</span> <a href="#" data-reveal style="font-size:12px">reveal</a>';
      const kv = [
        ['Digest', digest],
        ['Context length', esc(sel.ctx)],
        ['Source', esc(sel.source) + (/bundle/.test(sel.source) ? ' <a href="#" data-go="platform" style="font-size:12px">bundle</a>' : /training job/.test(sel.source) ? ' <a href="#" data-go="training" style="font-size:12px">open job</a>' : '')],
        ['Licence', licenceMissing ? '<span style="color:var(--warn-fg)">not recorded</span> ' + UI.btn('Record licence', { size: 'xs', attrs: 'data-licence' }) : esc(sel.licence)],
        sel.held ? ['Model server', '<a href="#" data-servers>' + esc(sel.server) + '</a> <span class="muted" style="font-size:12px">model id <span class="mono">' + esc(sel.id) + '</span></span>'] : ['Signed manifest', sel.manifest === 'verified' ? UI.pill('verified', 'ok') : UI.pill(sel.manifest, 'ok')],
        ['Tested hardware', esc(sel.hw)],
        ['Tool-calling conformance', sel.confTone ? UI.pill(sel.conf, sel.confTone) : '<span class="fg2">' + esc(sel.conf) + '</span>'],
        ['Allowed pools', sel.pools.map((p) => /^none/.test(p) ? '<span class="fg2">' + esc(p) + '</span>' : '<a href="#" data-go="pools">' + esc(p) + '</a>').join(', ')],
        ...(sel.held ? [['Reported by the server', esc(sel.reported.server) + '; tools ' + esc(sel.reported.tools) + '; JSON schema output ' + esc(sel.reported.json) + '; embeddings ' + esc(sel.reported.embeddings)]] : []),
        ['Used by profiles', sel.profiles.length ? sel.profiles.map((p) => '<a href="#" data-profile="' + esc(p) + '">' + esc(p) + '</a>').join(', ') : '<span class="fg2">' + (sel.guard ? 'guardrails only' : 'none') + '</span>']
      ];
      const cl = sel.cloud;
      if (cl) {
        kv.splice(0, kv.length,
          ['Weights', '<span class="fg2">held by the provider, no digest</span>'],
          ['Provider', esc(provOf(sel)) + ', account <a href="#" data-goacct="' + esc(cl.account) + '" class="mono">' + esc(cl.account) + '</a>'],
          ['Region', esc(cl.region)],
          ['Endpoint', esc(cl.endpoint) + '<div class="muted" style="font-size:12px">Catalogue entry <span class="mono">format: server</span>; needs the B-43 model server interface</div>'],
          ['Price', esc(cl.price) + ' <span class="muted" style="font-size:12px">example</span><div class="muted" style="font-size:12px">Priced into usage_records at metering</div>'],
          ['Label ceiling', UI.label(sel.label, { sm: true }) + ' <span class="muted" style="font-size:12px">within the region ceiling</span> ' + UI.label(cl.regionCeiling, { sm: true })],
          ['Residency', esc(cl.residency)],
          ['Provider guardrail', esc(cl.guardrail)],
          ['AI Gateway', esc(cl.gateway)],
          ['Context length', esc(sel.ctx)],
          ['Tool-calling conformance', sel.confTone ? UI.pill(sel.conf, sel.confTone) : '<span class="fg2">' + esc(sel.conf) + '</span>'],
          ['Used by profiles', sel.profiles.length ? sel.profiles.map((p) => '<a href="#" data-profile="' + esc(p) + '">' + esc(p) + '</a>').join(', ') : '<span class="fg2">none</span>']);
      }
      let notice = '';
      if (cl && st.noB43) notice = UI.notice('Unavailable: this install has no model server interface (B-43), so provider endpoints cannot be called. The entry is kept and routes again once B-43 is installed.', 'warn');
      else if (readOnly) notice = UI.notice('Retired on ' + (sel.id === 'llama3:8b-q4_0' ? '20 Sep' : 'today') + '. The tag stays resolvable for audit and is removed from routing. Fields are read-only.', 'info');
      else if (licenceMissing) notice = UI.notice('Approve is disabled until the licence field is completed and reviewed.', 'warn');
      else if (sel.warn && lc === 'evaluated') notice = UI.notice(esc(sel.warn), 'warn');
      else if (sel.evalNote && lc === 'draft') notice = UI.notice(esc(sel.evalNote) + ' <a href="#" data-go="training">Open evals</a>', 'warn');
      else if (sel.depNote && lc === 'deprecated') notice = UI.notice(esc(sel.depNote), 'warn');
      else if (sel.held && lc !== 'approved') notice = UI.notice(esc(sel.heldNote), 'info');
      else if (lc === 'approved' && sel.warn) notice = UI.notice('Approved for chat only. Tools stay withheld until the conformance suite passes.', 'info');
      let actions = '';
      if (readOnly) actions = UI.btn('Model card', { attrs: 'data-card' });
      else if (lc === 'draft') actions = UI.btn('Approve', { kind: 'primary', disabled: true, title: 'Needs an eval record and a passing red-team suite' }) + UI.btn('Build quantization', { attrs: 'data-quant' }) + UI.btn('Model card', { attrs: 'data-card' });
      else if (lc === 'evaluated') actions = UI.btn('Approve', { kind: 'primary', attrs: 'data-approve', disabled: licenceMissing, title: licenceMissing ? 'Licence not recorded' : '' }) + (sel.held ? '' : UI.btn('Build quantization', { attrs: 'data-quant' })) + UI.btn('Model card', { attrs: 'data-card' });
      else if (lc === 'approved') actions = UI.btn('Deprecate', { attrs: 'data-deprecate' }) + (sel.held ? '' : UI.btn('Build quantization', { attrs: 'data-quant' })) + UI.btn('Model card', { attrs: 'data-card' });
      else if (lc === 'deprecated') actions = UI.btn('Retire', { kind: 'danger', attrs: 'data-retire' }) + UI.btn('Model card', { attrs: 'data-card' });
      if (cl) actions = actions.replace(UI.btn('Build quantization', { attrs: 'data-quant' }), '') + UI.btn('Cloud spend', { attrs: 'data-spend' });

      const problem = st.problem === 'pickle'
        ? '<div class="vstack gap6">' + UI.problem('Import refused: pickle checkpoint', 'The archive 2026-38-hf-models.tar contains consolidated.00.pth, a pickle checkpoint. Only GGUF and safetensors are accepted. Nothing was written to MinIO and no tag was registered.', '7c1e0b3f9a2d4e6c8b5a7f1e3d9c0b2a') + '<div>' + UI.btn('Dismiss', { size: 'sm', attrs: 'data-dismiss' }) + '</div></div>'
        : st.problem === 'digest'
          ? '<div class="vstack gap6">' + UI.problem('Digest mismatch', 'Blob sha256:c07e2a… does not match the approved manifest for qwen2.5:32b-q4_K_M (expected sha256:41ab9c…). The gateway refused the blob on gpu-large-1/1 and nothing is registered.', '3e9a7c1b5d2f4e8a6c0b9d7f1a3e5c2b') + '<div>' + UI.btn('Dismiss', { size: 'sm', attrs: 'data-dismiss' }) + UI.btn('Open import log', { kind: 'ghost', size: 'sm', attrs: 'data-go="platform"' }) + '</div></div>'
          : st.problem === 'crossregion'
            ? '<div class="vstack gap6">' + UI.problem('Import refused: cross-region profile above internal', 'us.amazon.nova-pro-v1:0 is a US cross-region inference profile in aws-prod. It may run in Regions outside the account\'s allow list (eu-central-1, us-east-1), and cross-region profiles are capped at internal. The request asked for confidential. Nothing was registered.', '2b8e6c0a4f1d3e5a7c9b1d3f5a7c9e0b') + '<div>' + UI.btn('Dismiss', { size: 'sm', attrs: 'data-dismiss' }) + UI.btn('Import at internal instead', { kind: 'ghost', size: 'sm', attrs: 'data-imp="us.amazon.nova-pro-v1:0" data-acct="aws-prod"' }) + '</div></div>'
            : '';
      const b43 = st.noB43 ? UI.notice('<b>Cloud backends unavailable.</b> Bedrock, Azure AI Foundry, DigitalOcean GenAI and Workers AI entries need the model server interface from B-43 (<span class="mono">ModelServer</span>, instance kind <span class="mono">openai</span>, catalogue format <span class="mono">server</span>). Ollama models are not affected.', 'warn') : '';

      // ----- B-7301, B-7302: the AI system inventory (Inventory tab) -----
      st.view = st.view || 'catalogue';
      st.inv = st.inv || [
        { kind: 'agent', name: 'Data analyst', version: '1.4.0', status: 'published', label: 'confidential', owner: 'Mara Okafor', oversight: 'Finance lead reviews weekly samples', provenance: 'Prompts in-house; knowledge base Finance policies (internal)', lineage: 'profile:analyst > model:qwen2.5:32b-q4_K_M > base:Qwen 2.5 32B Q4_K_M', flags: 2, evals: 0, impact: 'Limited risk. Decision support for analysts; a person signs every report.' },
        { kind: 'agent', name: 'Triage', version: '1.0.0', status: 'in review', label: 'internal', owner: null, oversight: null, provenance: null, lineage: 'profile:general > model:llama3.1:8b-q5_K_M > base:Llama 3.1 8B Q5_K_M', flags: 0, evals: 0, impact: null },
        { kind: 'profile', name: 'analyst', version: '7', status: 'published', label: 'confidential', owner: 'Tomasz Wieczorek', oversight: 'Model admin', provenance: 'System prompt in-house', lineage: 'profile:analyst > model:qwen2.5:32b-q4_K_M > base:Qwen 2.5 32B Q4_K_M', flags: 0, evals: 1, impact: 'Minimal risk.' },
        { kind: 'profile', name: 'general', version: '12', status: 'published', label: 'internal', owner: 'Tomasz Wieczorek', oversight: 'Model admin', provenance: 'System prompt in-house', lineage: 'profile:general > model:llama3.1:8b-q5_K_M > base:Llama 3.1 8B Q5_K_M', flags: 0, evals: 0, impact: 'Minimal risk.' },
        { kind: 'model', name: 'qwen2.5:32b-q4_K_M', version: null, status: 'approved', label: 'confidential', owner: 'Tomasz Wieczorek', oversight: 'Model admin', provenance: 'Ollama library, digest verified; licence Apache-2.0', lineage: 'model:qwen2.5:32b-q4_K_M > base:Qwen 2.5 32B Q4_K_M', flags: 0, evals: 0, impact: null },
        { kind: 'model', name: 'llama3.1:8b-q5_K_M', version: null, status: 'approved', label: 'confidential', owner: null, oversight: null, provenance: 'Ollama library, digest verified; Llama 3.1 community licence', lineage: 'model:llama3.1:8b-q5_K_M > base:Llama 3.1 8B Q5_K_M', flags: 0, evals: 0, impact: null },
        { kind: 'workflow', name: 'Monthly close', version: '3', status: 'published', label: 'confidential', owner: 'Mara Okafor', oversight: 'Controller approves step 4', provenance: 'Steps in-house; reads the ERP connection', lineage: '', flags: 1, evals: 0, impact: 'Limited risk; a person approves the posting step.' },
        { kind: 'tool', name: 'jira-internal', version: '2.1.0', status: 'published', label: 'confidential', owner: 'Platform team', oversight: '', provenance: 'MCP server jira-internal', lineage: '', flags: 0, evals: 0, impact: null },
        { kind: 'mcp-server', name: 'jira-internal', version: '2025-06-18', status: 'healthy', label: null, owner: 'Platform team', oversight: '', provenance: 'Self-hosted, zone internal', lineage: '', flags: 0, evals: 0, impact: null },
        { kind: 'dataset', name: 'finance-qa-2026q3', version: '2', status: 'ready', label: 'confidential', owner: null, oversight: null, provenance: 'Conversations opted in, PII scrubbed', lineage: '', flags: 0, evals: 0, impact: null }
      ];
      if (st.requireOwner == null) st.requireOwner = true;
      const invKinds = ['all', 'model', 'profile', 'agent', 'workflow', 'tool', 'mcp-server', 'dataset'];
      st.invKind = st.invKind || 'all'; if (st.invSel == null) st.invSel = 1;
      const invRows = st.inv.filter((x) => st.invKind === 'all' || x.kind === st.invKind);
      const incomplete = st.inv.filter((x) => !x.owner).length;
      const invSel = st.inv[st.invSel] || st.inv[0];
      const missingOf = (x) => [!x.owner ? 'owner' : null, !x.oversight ? 'oversight role' : null, !x.provenance ? 'data provenance' : null].filter(Boolean);
      const invTabs = UI.tabs([{ id: 'catalogue', label: 'Catalogue', count: all.length }, { id: 'inventory', label: 'AI inventory', count: st.inv.length }], st.view);
      const invPage = '<div class="hstack wrap"><div class="eyebrow">Systems</div>' + UI.seg(invKinds.map((k) => ({ id: k, label: k === 'all' ? 'All' : k === 'mcp-server' ? 'MCP servers' : k.charAt(0).toUpperCase() + k.slice(1) + 's' })), st.invKind, 'data-invkind aria-label="Kind"') + '<span class="right hstack gap6">' + UI.btn('Export register, CSV', { size: 'sm', icon: 'download', attrs: 'data-invexport="csv"' }) + UI.btn('JSON', { size: 'sm', icon: 'download', attrs: 'data-invexport="json"' }) + '</span></div>'
        + (incomplete ? UI.notice('<b>' + incomplete + ' systems have no owner.</b> ' + (st.requireOwner ? 'An agent without an owner is not published until one is named.' : 'Publishing does not need an owner in this tenant yet.'), 'warn') : UI.notice('Every system has an owner.', 'ok'))
        + UI.table(['Kind', 'System', 'Status', 'Owner', 'Oversight', 'Lineage', { label: 'Issues', right: true }, 'Register'], invRows.map((x) => ({ cells: [esc(x.kind), '<b>' + esc(x.name) + '</b>' + (x.version ? ' <span class="mono muted">' + esc(x.version) + '</span>' : ''), UI.pill(x.status, x.status === 'published' || x.status === 'approved' || x.status === 'healthy' || x.status === 'ready' ? 'ok' : 'neutral'), x.owner ? esc(x.owner) : '<span class="muted">none</span>', esc(x.oversight || '-'), '<span class="mono muted" style="font-size:11px">' + esc(x.lineage || '-') + '</span>', (x.flags + x.evals) ? UI.pill((x.flags ? x.flags + ' flags' : '') + (x.flags && x.evals ? ', ' : '') + (x.evals ? x.evals + ' failed eval' : ''), 'warn') : '0', missingOf(x).length ? UI.pill('incomplete', 'warn') : UI.pill('complete', 'ok')], attrs: 'data-invsel="' + st.inv.indexOf(x) + '"', selected: invSel === x })), { minWidth: '860px', emptyTitle: 'Nothing of this kind', emptyText: '' })
        + '<div class="hstack wrap" style="margin-top:8px">' + UI.toggle('Publishing an agent needs an owner', st.requireOwner, 'data-invrequire') + '<span class="muted" style="font-size:12px">The register (CSV or JSON) lists every system with its owner, oversight role, provenance, model lineage, known issues and the impact assessment, for ISO/IEC 42001 and EU AI Act deployer records.</span></div>';
      const invInspector = '<aside class="inspector w360"><div class="eyebrow">' + esc(invSel.kind) + '</div><div class="models-name">' + esc(invSel.name) + '</div>'
        + (missingOf(invSel).length ? UI.notice('<b>Incomplete:</b> missing ' + esc(missingOf(invSel).join(', ')) + '.' + (invSel.kind === 'agent' && !invSel.owner && st.requireOwner ? ' It cannot be published.' : ''), 'warn') : UI.notice('Complete.', 'ok'))
        + UI.kv([['Status', esc(invSel.status)], ['Lineage', '<span class="mono" style="font-size:11px;overflow-wrap:anywhere">' + esc(invSel.lineage || 'none') + '</span>'], ['Known issues', (invSel.flags ? invSel.flags + ' open flags' : '') + (invSel.evals ? (invSel.flags ? ', ' : '') + invSel.evals + ' failed evaluation' : '') || 'none']], 1)
        + '<div class="formgrid">' + UI.field('Owner', UI.select(['none', 'Mara Okafor', 'Tomasz Wieczorek', 'Platform team'], invSel.owner || 'none', 'data-f="owner"')) + UI.field('Oversight role', UI.input(invSel.oversight || '', { attrs: 'data-f="oversight"', placeholder: 'Who reviews its output, how often' })) + UI.field('Data provenance', UI.textarea(invSel.provenance || '', { attrs: 'data-f="provenance"', placeholder: 'Where its prompts, weights and data came from' })) + UI.field('Impact assessment', UI.textarea(invSel.impact || '', { attrs: 'data-f="impact"', placeholder: 'Risk level, affected people, human oversight' })) + '</div>'
        + '<div class="hstack wrap gap6">' + UI.btn('Save', { kind: 'primary', size: 'sm', attrs: 'data-invsave' }) + (invSel.flags ? UI.btn('Open flags', { size: 'sm', attrs: 'data-go="flags"' }) : '') + '</div></aside>';

      root.innerHTML = '<style>'
        + '.models-steps{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}.models-steps span{color:var(--muted);font-weight:500}.models-steps .cur{color:var(--fg);font-weight:700}.models-steps .done{color:var(--fg2)}.models-steps .sep{color:var(--faint)}'
        + '.models-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}'
        + '.models-srv{border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}.models-srv .mono{overflow-wrap:anywhere}'
        + '.models-pick{display:flex;flex-direction:column;gap:4px}.models-pick label{display:flex;gap:8px;align-items:flex-start;padding:6px 8px;border:1px solid var(--line);border-radius:6px}.models-pick label.off{color:var(--muted)}'
        + '</style>'
        + '<div class="page">'
        + UI.pagehead('Model catalog', 'Weights enter only through the signed import path', UI.btn('Browse repositories', { icon: 'search', attrs: 'data-browse' }) + UI.btn('Model servers', { icon: 'pools', attrs: 'data-servers' }) + UI.btn('Cloud catalogue', { attrs: 'data-catalogue', disabled: !!st.noB43, title: st.noB43 ? 'Needs the B-43 model server interface' : '' }) + UI.btn('Import safetensors', { attrs: 'data-import' }) + UI.btn('Request import', { kind: 'primary', attrs: 'data-request' }))
        + problem + b43 + invTabs
        + (st.view === 'inventory' ? invPage : '<div class="toolbar">' + UI.search('Filter models', 'data-search', st.query) + '<span class="relative">' + UI.btn('Lifecycle: ' + st.lifecycle, { attrs: 'data-menu="lifecycle"', cls: st.lifecycle !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn('Capability: ' + st.cap, { attrs: 'data-menu="cap"', cls: st.cap !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn('Provider: ' + (st.provider === 'cloud' ? 'any cloud' : st.provider), { attrs: 'data-menu="provider"', cls: st.provider !== 'all' ? 'active' : '' }) + '</span><span class="muted right" style="font-size:12px">' + rows.length + ' of ' + all.length + ' models</span></div>'
        + UI.table(['Model', 'Provider', 'Family', 'Size or region', 'Capabilities', 'Max label', 'Lifecycle'], rows.map((m) => ({ cells: ['<span class="mono">' + esc(m.id) + '</span>', esc(provOf(m)) + (m.cloud && st.noB43 ? ' ' + UI.pill('unavailable', 'warn') : ''), esc(m.family), esc(m.size), esc(m.caps.join(', ')), UI.label(m.label, { sm: true }), UI.pill(lcOf(m))], selected: m.id === sel.id, attrs: 'data-id="' + esc(m.id) + '"' })), { emptyTitle: 'No models match', emptyText: 'Clear the filters or request an import.' })
        + '<span class="muted" style="font-size:12px">Cloud rows are example data; prices are illustrative, not provider quotes.</span>'
        + '</div>')
        + (st.view === 'inventory' ? invInspector : '<aside class="inspector w360"><div class="models-name">' + esc(sel.id) + '</div>' + stepper + UI.kv(kv, 1) + notice + '<div class="hstack wrap gap6">' + actions + '</div></aside>');

      ctx.on('click', 'tr.row', (e, t) => { st.selected = t.dataset.id; ctx.rerender(); });
      ctx.on('click', '[data-tab]', (e, t) => { st.view = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-invkind] [data-seg]', (e, t) => { st.invKind = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', 'tr[data-invsel]', (e, t) => { st.invSel = +t.dataset.invsel; ctx.rerender(); });
      ctx.on('click', '[data-invsave]', () => { const x = st.inv[st.invSel]; const v = (n) => { const el = ctx.$('[data-f="' + n + '"]'); return el ? el.value : ''; }; x.owner = v('owner') === 'none' ? null : v('owner'); x.oversight = v('oversight'); x.provenance = v('provenance'); x.impact = v('impact'); ctx.rerender(); ctx.toast(x.owner ? 'Saved. ' + esc(x.name) + ' is ' + (missingOf(x).length ? 'still incomplete (' + esc(missingOf(x).join(', ')) + ')' : 'complete') + '. Audited inventory.updated.' : 'Saved without an owner: ' + esc(x.name) + ' stays incomplete. Audited inventory.updated.', x.owner ? 'ok' : 'warn'); });
      ctx.on('click', '[data-invexport]', (e, t) => ctx.toast('Downloading ai-inventory-northwind-2026-10-09.' + esc(t.dataset.invexport) + ': ' + st.inv.length + ' systems with lineage and impact assessment. Audited inventory.exported.', 'ok'));
      ctx.on('click', '[data-invrequire]', () => { st.requireOwner = !st.requireOwner; ctx.rerender(); ctx.toast(st.requireOwner ? 'Agents without an owner are no longer published. Audited inventory.settings.updated.' : 'Publishing no longer needs an owner. Audited inventory.settings.updated.'); });
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-menu]', (e, t) => {
        e.stopPropagation();
        if (t.dataset.menu === 'lifecycle') menu(ctx, t.parentElement, ['all'].concat(STEPS), st.lifecycle, (v) => { st.lifecycle = v; ctx.rerender(); });
        else if (t.dataset.menu === 'provider') menu(ctx, t.parentElement, PROVIDERS, st.provider, (v) => { st.provider = v; const first = all.find((m) => provOk(m)); if (first && !provOk(sel)) st.selected = first.id; ctx.rerender(); });
        else menu(ctx, t.parentElement, ['all'].concat(CAPS), st.cap, (v) => { st.cap = v; ctx.rerender(); });
      });
      ctx.on('click', '[data-reveal]', (e) => { e.preventDefault(); st.reveal[sel.id] = !st.reveal[sel.id]; ctx.rerender(); });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-profile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.profile }); });
      ctx.on('click', '[data-dismiss]', () => { st.problem = null; ctx.rerender(); });
      ctx.on('click', '[data-browse]', () => ctx.navigate('import', { kind: 'model', target: 'models' }));

      ctx.on('click', '[data-approve]', async () => {
        const chatOnly = sel.confTone === 'warn';
        const ok = await ctx.confirm({ title: 'Approve ' + sel.id, tag: chatOnly ? 'chat only' : 'approved', tone: 'ok', body: '<p style="margin:0" class="fg2">' + (cl ? 'Approval lets profiles route to this provider model. No weights are mirrored: the provider model id and the version it reports are recorded, and a change re-runs the conformance suite.' : 'Approval mirrors the weights into MinIO by digest and allows placement on the allowed pools. Profiles can pin this version from now on.') + (chatOnly ? ' The tools capability stays withheld until the conformance suite passes.' : '') + '</p>', kv: cl ? [['Provider model', '<span class="mono">' + esc(sel.id) + '</span>'], ['Max label', UI.label(sel.label, { sm: true })], ['Account', esc(cl.account)], ['Region', esc(cl.region)]] : [['Digest', sel.held ? 'held by the server, no digest' : '<span class="mono">' + esc(sel.digest) + '</span>'], ['Max label', UI.label(sel.label, { sm: true })], ['Allowed pools', esc(sel.pools.join(', '))], sel.held ? ['Model server', esc(sel.server)] : ['Signed manifest', UI.pill('verified', 'ok')]], ok: 'Approve' });
        if (!ok) return;
        st.lc[sel.id] = 'approved'; ctx.rerender(); ctx.toast('<b>' + esc(sel.id) + '</b> approved' + (chatOnly ? ' for chat only' : '') + (cl ? '. Provider model id recorded; audit entry written.' : sel.held ? '. Held by ' + esc(sel.server) + '; nothing to mirror. Audit entry written.' : '. Weights mirrored to MinIO; audit entry written.'), 'ok', 5000);
      });
      ctx.on('click', '[data-deprecate]', async () => {
        const ok = await ctx.confirm({ title: 'Deprecate ' + sel.id, tag: 'deprecated', tone: 'warn', body: '<p style="margin:0" class="fg2">New profiles cannot pick a deprecated tag. Profiles that already pin it keep routing until the retirement date you set here.</p>' + UI.field('Retire on', UI.input('2026-10-31', { type: 'date' })) + (sel.profiles.length ? UI.notice('Still pinned by ' + sel.profiles.map((p) => '<b>' + esc(p) + '</b>').join(', ') + '. Repoint them before retirement.', 'warn') : ''), ok: 'Deprecate' });
        if (!ok) return;
        st.lc[sel.id] = 'deprecated'; ctx.rerender(); ctx.toast('<b>' + esc(sel.id) + '</b> deprecated. Retires on 31 Oct unless extended.', 'warn', 5000);
      });
      ctx.on('click', '[data-retire]', async () => {
        const ok = await ctx.confirm({ title: 'Retire ' + sel.id, tag: 'destructive', tone: 'danger', body: '<p style="margin:0" class="fg2">The tag is removed from routing on every pool and unloaded from instances. It stays resolvable for audit and the blob stays in MinIO for the retention period.</p>', kv: [['Loaded on', 'gpu-large-2/0'], ['Requests last 7 days', '0']], ok: 'Retire' });
        if (!ok) return;
        st.lc[sel.id] = 'retired'; ctx.rerender(); ctx.toast('<b>' + esc(sel.id) + '</b> retired and removed from routing.', '', 5000);
      });
      ctx.on('click', '[data-licence]', () => ctx.modal({ title: 'Record licence for ' + esc(sel.id), body: UI.field('Licence', UI.select(['Apache 2.0', 'MIT', 'Llama 3.1 Community', 'Qwen Research', 'Other, attach text'], 'Apache 2.0')) + UI.field('Source of the licence text', UI.input('LICENSE in the Hugging Face repository, import bundle 2026-37')) + UI.check('Reviewed by legal for commercial internal use', false) + UI.notice('The licence is recorded on the manifest and shown on the model card. Approve becomes available once it is saved.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save licence', { kind: 'primary', attrs: 'data-save' }), onMount(m) { m.querySelector('[data-save]').addEventListener('click', () => { App.closeOverlay(); st.licenceMissing = false; ctx.rerender(); ctx.toast('Licence recorded as Apache 2.0. Approve is available.', 'ok'); }); } }));
      ctx.on('click', '[data-quant]', () => ctx.modal({ title: 'Build quantization from ' + esc(sel.id), body: '<div class="formgrid" style="--cols:2">' + UI.field('Target quantization', UI.select(['Q4_K_M', 'Q5_K_M', 'Q8_0'], 'Q8_0')) + UI.field('Evals to run', UI.select(['cuda and cpu', 'cuda only', 'cuda, rocm and cpu'], 'cuda and cpu')) + UI.field('Result tag', UI.input(sel.id.replace(/-q[0-9]_[A-Z0-9_]+$/i, '') + '-q8_0', { readonly: true }), 'Registers as a new draft with its own digest') + UI.field('Priority', UI.select(['low, off-peak', 'normal'], 'low, off-peak')) + '</div>' + UI.notice('Runs llama-quantize on the training pool from the mirrored safetensors. The new tag needs its own eval record per hardware class before approval.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Queue build', { kind: 'primary', attrs: 'data-queue' }), onMount(m) { m.querySelector('[data-queue]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Quantization queued on train-1, off-peak. It appears as a draft tag when packaging finishes. <a href="#/training" style="color:inherit">Track it</a>', '', 6000); }); } }));
      ctx.on('click', '[data-card]', () => ctx.drawer({ title: 'Model card, ' + esc(sel.id), body: '<div class="hstack">' + UI.pill(lc) + UI.label(sel.label, { sm: true }) + '</div>' + UI.kv([['Base digest', sel.held ? 'held by the server, no digest' : '<span class="mono">' + esc(sel.digest) + '</span>'], ['Family, size', esc(sel.family + ', ' + sel.size)], ['Capabilities', esc(sel.caps.join(', '))], ['Context length', esc(sel.ctx)], ['Source', esc(sel.source)], ['Licence', licenceMissing ? 'not recorded' : esc(sel.licence)], ['Tested hardware', esc(sel.hw)], ['Tool-calling conformance', esc(sel.conf)]].concat(sel.held ? [['Server reports', esc('server ' + sel.reported.server + ', tools ' + sel.reported.tools + ', JSON schema output ' + sel.reported.json + ', embeddings ' + sel.reported.embeddings)]] : []).concat(sel.id === 'finance-lora-v3:8b' ? [['Dataset version', 'finance-qa v6, 18,420 rows'], ['Code commit', '<span class="mono">a91f3c2</span>'], ['Container digest', '<span class="mono">sha256:5be0…</span>'], ['Hyperparameters', 'LoRA r=16, alpha=32, lr 2e-4, 3 epochs, seed 1337'], ['Eval scores', 'held-out 0.781, regression 0.974, red-team 0.968 (fail)']] : [['Evals', 'task suite passed per class, red-team 0.991']]), 1) + UI.timeline([{ title: sel.held ? 'Registered from the server' : 'Imported', text: esc(sel.source), meta: sel.held ? 'model id from /v1/models, no pull' : 'signature and digest verified at the diode', tone: 'ok' }, { title: 'Evaluated', text: esc(sel.hw), meta: 'per hardware class', tone: STEPS.indexOf(lc) >= 1 ? 'ok' : '' }, { title: 'Approved', text: STEPS.indexOf(lc) >= 2 ? 'Mara Okafor, model admin' : 'pending', tone: STEPS.indexOf(lc) >= 2 ? 'ok' : '' }]), actions: UI.btn('Download card (JSON)', { icon: 'download', attrs: 'data-dl' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { d.querySelector('[data-dl]').addEventListener('click', () => ctx.toast('Model card exported with the signed manifest attached.')); } }));

      ctx.on('click', '[data-goacct]', (e, t) => { e.preventDefault(); ctx.navigate('cloud', { account: t.dataset.goacct }); });
      ctx.on('click', '[data-spend]', () => ctx.navigate('finops', { tab: 'tokens' }));
      const importCloud = (id, account) => {
        const grp = CATALOGUE.find((g) => g.account === account); const row = grp && grp.rows.find((r) => r[0] === id); if (!row) return;
        const cross = !!row[3];
        ctx.modal({ title: 'Import ' + esc(id) + ' as draft', body: UI.kv([['Provider', esc(grp.provider)], ['Account', '<span class="mono">' + esc(account) + '</span>'], ['Where', esc(cross ? row[3] : grp.where)], ['Price per 1M tokens', esc(row[2]) + ' <span class="muted">example</span>']], 2)
          + UI.field('Requested max label', UI.select(['public', 'internal', 'confidential'], cross ? 'confidential' : 'internal', 'data-f="lbl"'), 'Capped at the region ceiling; cross-region and global endpoints at internal')
          + (cross ? UI.notice('This is a cross-region inference profile. It may run in Regions outside the account\'s allow list, so it is refused above internal.', 'warn') : '')
          + UI.notice('The entry registers as a draft with format server and no digest. Licence terms, a conformance run and dual-control approval still apply (B-10504).', 'info'),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Import as draft', { kind: 'primary', attrs: 'data-do' }),
        onMount(m) { m.querySelector('[data-do]').addEventListener('click', () => {
          const lbl = m.querySelector('[data-f="lbl"]').value; App.closeOverlay();
          if (cross && lbl === 'confidential') { st.problem = 'crossregion'; ctx.rerender(); return; }
          if (!all.some((x) => x.id === id)) st.extra.push(cloudRow({ id, provider: grp.provider, family: grp.provider + ' model', size: cross ? row[3] : grp.where, caps: row[1].split(', '), label: lbl, lifecycle: 'draft', ctx: 'reported by the provider', cloud: { account, region: cross ? row[3] : grp.where, regionCeiling: cross ? 'internal' : 'confidential', price: row[2] === 'neurons' ? 'priced in neurons' : row[2] + ' per 1M tokens', endpoint: grp.provider === 'Bedrock' ? 'Bedrock Converse' : 'kind: openai', residency: cross ? 'Cross-region profile, capped at internal.' : 'As the account\'s region.', guardrail: 'none yet', gateway: 'off' }, evalNote: 'Imported from the cloud catalogue. Run the conformance suite before approval.' }));
          st.problem = null; st.selected = id; st.lifecycle = 'all'; st.provider = 'all'; ctx.rerender(); ctx.toast('<b>' + esc(id) + '</b> registered as a draft from ' + esc(account) + '. Audit entry models.import.cloud written.', 'ok', 5000);
        }); } });
      };
      const catalogueModal = () => ctx.modal({ title: 'Cloud catalogue', cls: 'wide', body: '<p class="fg2" style="margin:0">Models the connected cloud accounts offer. Importing registers a draft catalogue entry; approval, licence and evaluation work as for any model.</p>'
        + CATALOGUE.map((g) => '<div class="vstack gap6"><div class="hstack"><span class="eyebrow grow">' + esc(g.provider) + ', ' + esc(g.where) + '</span><span class="mono muted" style="font-size:12px">' + esc(g.account) + '</span></div>'
          + UI.table(['Model', 'Capabilities', 'Price per 1M in / out', ''], g.rows.map((r) => { const have = all.some((x) => x.id === r[0]); return ['<span class="mono">' + esc(r[0]) + '</span>' + (r[3] ? ' ' + UI.pill(r[3], 'warn') : ''), esc(r[1]), esc(r[2]), have ? UI.pill('imported', 'ok') : UI.btn('Import as draft', { size: 'xs', attrs: 'data-imp="' + esc(r[0]) + '" data-acct="' + esc(g.account) + '"' })]; }), { clickable: false, minWidth: '0' }) + '</div>').join('')
        + '<span class="muted" style="font-size:12px">Example data. Prices are illustrative, not provider quotes.</span>',
        actions: UI.btn('Close', { attrs: 'data-close' }),
        onMount(m) { m.addEventListener('click', (e) => { const b = e.target.closest('[data-imp]'); if (!b) return; const id = b.dataset.imp, acct = b.dataset.acct; App.closeOverlay(); setTimeout(() => importCloud(id, acct), 30); }); } });
      ctx.on('click', '[data-catalogue]', catalogueModal);
      ctx.on('click', '[data-imp]', (e, t) => importCloud(t.dataset.imp, t.dataset.acct));
      if (st.openCatalogue) { st.openCatalogue = false; if (!st.noB43) setTimeout(catalogueModal, 30); }
      // The import picker: pull from a library, or register a model a server holds (B-43, no pull and no digest).
      const libraryBody = '<div class="formgrid" style="--cols:2">' + UI.field('Source', UI.select(['Ollama library mirror', 'Hugging Face, safetensors only', 'Internal fine-tune'], 'Ollama library mirror')) + UI.field('Model and tag', UI.input('', { placeholder: 'mistral-small:24b-instruct-q4_K_M', attrs: 'data-f="name"' })) + UI.field('Licence', UI.input('', { placeholder: 'As published by the source; legal reviews before approval' })) + UI.field('Requested max label', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal')) + UI.field('Capabilities expected', UI.input('chat, tools')) + UI.field('Allowed pools', '<div class="hstack wrap gap12" style="height:30px">' + UI.check('gpu-large', true) + UI.check('cpu-helpers', false) + UI.check('gpu-amd', false) + '</div>') + '<div class="span2">' + UI.field('Why this model', UI.textarea('', { placeholder: 'Which workload it serves and what the current model lacks', rows: 3 })) + '</div></div>' + UI.notice('Requests join the next weekly bundle. Staging fetches, scans and signs the weights; pickle checkpoints are rejected there, and only GGUF or safetensors cross the diode. The tag appears here as a draft once the digest verifies.', 'info');
      const heldOptions = () => st.servers.reduce((a, s) => a.concat(s.models.map((m) => ({ s, m }))), []);
      const heldBody = () => {
        const opts = heldOptions();
        const first = opts.find((o) => o.m.available && !o.m.catalogued && o.s.health !== 'unreachable');
        return '<div class="models-pick" role="radiogroup" aria-label="Models the servers hold">' + opts.map((o, i) => {
          const off = !o.m.available || o.m.catalogued || o.s.health === 'unreachable';
          const why = !o.m.available ? 'unavailable: ' + o.m.reason : o.m.catalogued ? 'in the catalogue' : o.s.health === 'unreachable' ? 'server not answering' : 'available';
          return '<label class="' + (off ? 'off' : '') + '"><input type="radio" name="models-held" value="' + i + '"' + (off ? ' disabled' : '') + (o === first ? ' checked' : '') + '><span class="vstack" style="gap:2px"><span class="mono">' + esc(o.m.id) + '</span><span class="muted" style="font-size:12px">' + esc(o.s.name) + ', ' + esc(o.s.server) + ', ' + esc(why) + '</span></span></label>';
        }).join('') + '</div>'
          + (st.pickUnavailable ? UI.notice('<b>pcc is unavailable.</b> fm serve lists Private Cloud Compute but refuses it outside Apple\'s own clients, and it would leave the network. It cannot be registered.', 'warn') : '')
          + '<div class="formgrid" style="--cols:2">' + UI.field('Licence', UI.input('', { placeholder: 'Required before approval', attrs: 'data-f="hlic"' })) + UI.field('Requested max label', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal')) + '</div>'
          + UI.notice('Nothing is pulled and there is no digest: the server holds the weights and its model id stands in for the digest. The model is placed warm on the server\'s pool, and the conformance run, the licence and a second approver still apply.', 'info');
      };
      const requestModal = (mode) => {
        mode = mode === 'server' ? 'server' : 'library';
        ctx.modal({ title: 'Request model import', cls: 'wide', body: UI.seg([{ id: 'library', label: 'Pull from a library' }, { id: 'server', label: 'Held by a model server' }], mode, 'data-src') + '<div data-srcbody>' + (mode === 'server' ? heldBody() : libraryBody) + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(mode === 'server' ? 'Register model' : 'Send request', { kind: 'primary', attrs: 'data-send' }), onMount(m) {
          // The source switch swaps the form in place; the dialog and its focus stay where they are.
          m.querySelectorAll('[data-src] [data-seg]').forEach((b) => b.addEventListener('click', () => {
            if (b.dataset.seg === mode) return;
            mode = b.dataset.seg;
            m.querySelectorAll('[data-src] [data-seg]').forEach((x) => x.classList.toggle('active', x.dataset.seg === mode));
            m.querySelector('[data-srcbody]').innerHTML = mode === 'server' ? heldBody() : libraryBody;
            m.querySelector('[data-send]').textContent = mode === 'server' ? 'Register model' : 'Send request';
          }));
          m.querySelector('[data-send]').addEventListener('click', () => {
            if (mode === 'server') {
              const pick = m.querySelector('input[name="models-held"]:checked');
              if (!pick) { ctx.toast('Choose an available model a server holds.', 'warn'); return; }
              const o = heldOptions()[Number(pick.value)];
              App.closeOverlay(); st.pickUnavailable = false;
              o.m.catalogued = true;
              st.extra.push({ id: o.m.id, family: o.s.server === 'llama.cpp' ? 'Qwen 2.5' : 'pending', size: 'held by the server', caps: ['chat'], label: 'internal', lifecycle: 'draft', held: true, server: o.s.name, digest: 'held by the server, no digest', full: 'held by the server, no digest', ctx: o.s.ctx, source: 'Model server ' + o.s.name + ', model id ' + o.m.id, licence: (m.querySelector('[data-f="hlic"]').value || 'to be recorded').trim(), manifest: 'not applicable', hw: 'not yet tested', conf: 'not run', confTone: '', pools: [o.s.pool], profiles: [], reported: { server: o.s.server, tools: o.s.tools, json: o.s.json, embeddings: o.s.embeddings }, heldNote: 'Held by the server: nothing is pulled and there is no digest to verify. Run the conformance run on ' + o.s.name + ', record the licence, and have a second administrator approve it.' });
              st.selected = o.m.id; st.lifecycle = 'all'; ctx.rerender();
              ctx.toast('<b>' + esc(o.m.id) + '</b> registered from ' + esc(o.s.name) + ' as a draft, placed warm on ' + esc(o.s.pool) + '. Nothing was pulled.', 'ok', 6000);
              return;
            }
            const name = (m.querySelector('[data-f="name"]').value || 'mistral-small:24b-instruct-q4_K_M').trim(); App.closeOverlay(); st.extra.push({ id: name, family: 'pending', size: 'pending', caps: ['chat', 'tools'], label: 'internal', lifecycle: 'draft', digest: 'not yet imported', full: 'not yet imported', ctx: 'pending', source: 'Import request IMP-2026-41, next weekly bundle', licence: 'to be recorded at staging', manifest: 'pending', hw: 'not yet tested', conf: 'not run', confTone: '', pools: ['none until approved'], profiles: [] }); st.selected = name; st.lifecycle = 'all'; ctx.rerender(); ctx.toast('Import request IMP-2026-41 sent to the model admin queue. Bundled with import 2026-39.', 'ok', 5000); 
          });
        } });
      };
      // ----- model servers (B-43): Chat Completions servers as instances -----
      const yesNo = (v) => esc(v);
      const serverCard = (sv) => '<div class="models-srv"><div class="hstack"><b class="mono grow">' + esc(sv.name) + '</b>' + UI.pill(sv.health, sv.health === 'healthy' ? 'ok' : 'danger') + '</div>'
        + UI.kv([['Pool', esc(sv.pool)], [sv.transport === 'socket' ? 'Unix socket' : 'URL', '<span class="mono">' + esc(sv.target) + '</span>'], ['Bearer token', sv.token ? 'in the vault' : 'none'], ['Server', esc(sv.server)], ['Context length', esc(sv.ctx)], ['Tools', yesNo(sv.tools)], ['JSON schema output', yesNo(sv.json)], ['Embeddings', yesNo(sv.embeddings)], ['Models listed', sv.models.map((m) => '<span class="mono">' + esc(m.id) + '</span>' + (m.available ? '' : ' <span class="muted">(unavailable)</span>')).join(', ')]], 1)
        + (sv.health === 'unreachable' ? UI.notice('Not answering on /health or /v1/models. Requests route to other instances in the pool.', 'danger') : '')
        + '<div class="hstack wrap gap6">' + UI.btn('Probe again', { size: 'sm', attrs: 'data-probe="' + esc(sv.name) + '"', disabled: sv.health === 'unreachable', title: sv.health === 'unreachable' ? 'The server is not answering' : '' }) + UI.btn('Import a model', { size: 'sm', attrs: 'data-heldimport' }) + '</div></div>';
      const serversDrawer = () => ctx.drawer({ title: 'Model servers', body: '<p class="fg2" style="margin:0">Chat Completions servers that join a pool like an Ollama node: Apple\'s fm serve, mlx_lm.server, llama.cpp\'s llama-server. They hold their own models, so load, unload and pull are skipped and recorded as not available; health comes from /health or /v1/models.</p>' + st.servers.map(serverCard).join(''),
        actions: UI.btn('Register model server', { kind: 'primary', icon: 'plus', attrs: 'data-register' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
        onMount(d) {
          d.querySelector('[data-register]').addEventListener('click', () => { App.closeOverlay(); setTimeout(registerModal, 0); });
          d.querySelectorAll('[data-heldimport]').forEach((b) => b.addEventListener('click', () => { App.closeOverlay(); setTimeout(() => requestModal('server'), 0); }));
          d.querySelectorAll('[data-probe]').forEach((b) => b.addEventListener('click', () => { ctx.toast('Probing ' + esc(b.dataset.probe) + ': a tool call and JSON schema output on its first model. The answers appear here when the job finishes.', '', 5000); b.disabled = true; }));
        } });
      const registerModal = () => ctx.modal({ title: 'Register model server', cls: 'wide', body: '<div class="formgrid" style="--cols:2">'
          + UI.field('Pool', UI.select(['apple-silicon', 'gpu-large', 'cpu-helpers'], 'apple-silicon', 'data-f="pool"'), 'An Apple silicon pool is accelerator metal')
          + UI.field('Name', UI.input('', { placeholder: 'mac-studio-2-fm', attrs: 'data-f="name"' }))
          + UI.field('Kind', UI.select([{ value: 'openai', label: 'Chat Completions server (fm serve, mlx_lm.server, llama-server)' }, { value: 'ollama', label: 'Ollama' }], 'openai', 'data-f="kind"'))
          + UI.field('Transport', UI.select([{ value: 'socket', label: 'Unix socket on this host' }, { value: 'url', label: 'URL' }], 'socket', 'data-f="transport"'), 'fm serve --socket listens on a socket')
          + '<div data-w="socket">' + UI.field('Socket path', UI.input('', { placeholder: '/var/run/exprsn/fm.sock', attrs: 'data-f="socket"' }), 'An absolute path; no TLS on a socket') + '</div>'
          + '<div data-w="url" hidden>' + UI.field('URL', UI.input('', { placeholder: 'http://10.20.4.31:8081', attrs: 'data-f="url"' }), 'Checked against the egress policy') + '</div>'
          + '<div data-w="token">' + UI.field('Bearer token', UI.input('', { type: 'password', placeholder: 'Optional', attrs: 'data-f="token" autocomplete="off"' }), 'Stored in the vault and never shown again') + '</div>'
          + UI.field('Deploy', UI.select(['baremetal', 'docker'], 'baremetal')) + '</div>'
          + UI.notice('After registering, a probe asks the server for a tool call and for JSON schema output, and records what it reports. Its models then appear in the import picker.', 'info'),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Register', { kind: 'primary', attrs: 'data-save' }),
        onMount(m) {
          const f = (k) => m.querySelector('[data-f="' + k + '"]');
          const sync = () => { const ollama = f('kind').value === 'ollama'; if (ollama) f('transport').value = 'url'; f('transport').disabled = ollama; const sock = f('transport').value === 'socket'; m.querySelector('[data-w="socket"]').hidden = !sock; m.querySelector('[data-w="url"]').hidden = sock; m.querySelector('[data-w="token"]').hidden = ollama; };
          f('kind').addEventListener('change', sync); f('transport').addEventListener('change', sync);
          m.querySelector('[data-save]').addEventListener('click', () => {
            const name = (f('name').value || 'mac-studio-2-fm').trim();
            const kind = f('kind').value, sock = f('transport').value === 'socket';
            const target = (sock ? f('socket').value || '/var/run/exprsn/fm.sock' : f('url').value || 'http://10.20.4.33:8081').trim();
            if (sock && target.charAt(0) !== '/') { ctx.toast('A socket path is absolute, such as /var/run/exprsn/fm.sock.', 'warn'); return; }
            App.closeOverlay();
            if (kind === 'ollama') { ctx.toast(esc(name) + ' registered as an Ollama instance on ' + esc(f('pool').value) + '. It is managed on the Pools screen.', 'ok', 5000); return; }
            st.servers.push({ name, pool: f('pool').value, transport: sock ? 'socket' : 'url', target, token: !!f('token').value, health: 'healthy', server: sock ? 'fm serve' : 'chat-completions', ctx: 'not reported', tools: 'work', json: 'works', embeddings: 'not tried', models: [{ id: sock ? 'system' : 'mlx-community/Qwen3-8B-4bit', available: true, catalogued: sock && st.servers.some((x) => x.models.some((y) => y.id === 'system' && y.catalogued)) }] });
            ctx.toast(esc(name) + ' registered and healthy. Probe queued; its models are in the import picker.' + (f('token').value ? ' The token is in the vault.' : ''), 'ok', 6000);
            setTimeout(serversDrawer, 0);
          });
        } });
      ctx.on('click', '[data-servers]', (e) => { e.preventDefault(); serversDrawer(); });
      ctx.on('click', '[data-request]', () => requestModal());
      if (st.openRequest) { const mode = st.openRequest; st.openRequest = false; setTimeout(() => requestModal(mode), 30); }
      if (st.openServers) { st.openServers = false; setTimeout(serversDrawer, 30); }
      ctx.on('click', '[data-import]', () => ctx.modal({ title: 'Import safetensors bundle', cls: 'wide', body: UI.field('Bundle on the import share', UI.select(['2026-38-hf-models.tar, 47.2 GB, received 19 Sep 06:10', '2026-37-ollama-mirror.tar, imported'], '2026-38-hf-models.tar, 47.2 GB, received 19 Sep 06:10')) + UI.table(['Entry', 'Format', 'Size', 'Signature', 'Digest', 'Licence'], [['<span class="mono">mistral-small:24b-instruct</span>', 'safetensors', '47.1 GB', UI.pill('verified', 'ok'), UI.pill('matches manifest', 'ok'), 'Apache 2.0'], ['<span class="mono">tokenizer, config</span>', 'json', '4 MB', UI.pill('verified', 'ok'), UI.pill('matches manifest', 'ok'), '']], { clickable: false, minWidth: '0' }) + UI.notice('Import converts to GGUF on the training pool, records the licence and registers the tag as a draft. Pickle checkpoints in a bundle stop the whole import.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Verify and import', { kind: 'primary', attrs: 'data-do' }), onMount(m) { m.querySelector('[data-do]').addEventListener('click', () => { App.closeOverlay(); st.extra.push({ id: 'mistral-small:24b-instruct-q4_K_M', family: 'Mistral Small', size: '24B', caps: ['chat', 'tools'], label: 'internal', lifecycle: 'draft', digest: 'sha256:6b1d0e8f2a9c4735...a204', full: 'sha256:6b1d0e8f2a9c4735e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2a204', ctx: '32,768', source: 'Hugging Face safetensors, import bundle 2026-38', licence: 'Apache 2.0, recorded', manifest: 'verified', hw: 'not yet tested', conf: 'not run', confTone: '', pools: ['none until approved'], profiles: [], evalNote: 'Converted to GGUF Q4_K_M. Evals have not run yet; queue them under Training before approval.' }); st.selected = 'mistral-small:24b-instruct-q4_K_M'; st.lifecycle = 'all'; ctx.rerender(); ctx.toast('Bundle verified. mistral-small:24b-instruct registered as a draft; GGUF conversion queued.', 'ok', 5000); }); } }));
    }
  });
})();
