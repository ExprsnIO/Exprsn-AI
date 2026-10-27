// Models, the cloud parts (1.9.99-final, Sprint 61, B-10505 to B-10508): the provider of each row and its filter, the
// cloud catalogue import (Sprint 60's /api/admin/cloud/accounts/:id/model-import), and on a cloud model's card its
// price, region, residency (with the data-terms attestation under dual control), the provider guardrail layer and
// AI Gateway. `models.js` calls App.modelsCloud(ctx, deps) on every render; the state lives in ctx.state.cloud.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const PROVIDER = { aws: 'Bedrock', azure: 'Azure AI Foundry', digitalocean: 'DigitalOcean GenAI', cloudflare: 'Workers AI' };
  const SOURCE = { 'aws-price-list': 'AWS Price List', 'azure-retail-prices': 'Azure Retail Prices', 'price-sheet': 'price sheet', manual: 'recorded by hand' };
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const money = (n) => (n == null ? '' : '$' + (n < 0.01 ? String(+n.toPrecision(3)) : n.toFixed(n < 1 ? 3 : 2)).replace(/(\.\d*?[1-9])0+$/, '$1'));
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const problem = (m, err) => { const p = err.problem || {}; m.querySelector('[data-err]').innerHTML = UI.problem(p.title || 'Refused', p.detail || err.message, p.trace_id); };
  const CSS = '.mdc-sub{font-size:12px;color:var(--muted)}.mdc-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}.mdc-list .mono{overflow-wrap:anywhere}';

  App.modelsCloud = function (ctx, deps) {
    const st = ctx.state;
    st.cloud = st.cloud || {};
    st.provider = st.provider || 'all';
    const c = st.cloud;
    const canRead = App.can('cloud:read'), canManage = App.can('models:manage');
    const canAdmin = App.can('cloud:admin'), canFinops = App.can('finops:manage');
    const meId = App.me && App.me.user ? App.me.user.id : null;

    const load = () => {
      if (c.loading || !canRead || !canManage) return;
      c.loading = true;
      Promise.all([App.get('/api/admin/cloud/model-cards'), App.get('/api/admin/cloud/accounts').catch(() => ({ accounts: [] }))])
        .then((r) => { c.cards = {}; (r[0].cards || []).forEach((x) => { c.cards[x.modelId] = x; }); c.accounts = (r[1].accounts || []).filter((a) => a.state === 'active' || a.state === 'attention'); c.error = null; })
        .catch((err) => { c.error = err; c.cards = c.cards || {}; })
        .finally(() => { c.loading = false; c.loaded = true; deps.refresh(); });
    };
    if (!c.loaded && !c.loading) load();
    const reload = () => { c.loaded = false; load(); };

    const cardOf = (m) => (c.cards && m ? c.cards[m.id] : null) || null;
    const providerOf = (m) => { const k = cardOf(m); return k ? PROVIDER[k.provider] || k.provider : m.held ? 'Model server' : 'Ollama'; };
    const providers = ['all', 'Ollama', 'Model server', 'Bedrock', 'Azure AI Foundry', 'DigitalOcean GenAI', 'Workers AI'];
    const matches = (m) => st.provider === 'all' || providerOf(m) === st.provider;

    // ---------- the card ----------
    const priceText = (p, embedding) => {
      if (!p) return '';
      if (p.basis === 'neurons') return num(p.neuronsInput) + ' in, ' + num(p.neuronsOutput) + ' out neurons per 1M tokens, ' + money(p.neuronPrice) + ' per 1,000 neurons';
      if (embedding || !p.outputPerMillion) return money(p.inputPerMillion) + ' per 1M tokens';
      return money(p.inputPerMillion) + ' in, ' + money(p.outputPerMillion) + ' out' + (p.cachedPerMillion != null ? ', ' + money(p.cachedPerMillion) + ' cached' : '') + ' per 1M tokens';
    };
    const kvRows = (m) => {
      const k = cardOf(m);
      if (!k) return [];
      const embedding = (m.capabilities || []).indexOf('embedding') >= 0;
      const p = k.price && k.price.current;
      const price = p
        ? esc(priceText(p, embedding)) + ' ' + (p.currency !== 'USD' ? esc(p.currency) + ' ' : '') + (p.unverified ? UI.pill('unverified', 'warn') : '') + '<div class="mdc-sub">' + esc(SOURCE[p.source] || p.source) + ', effective ' + esc(p.effectiveFrom) + (p.unverified ? '; shown, not used for metering until confirmed' : '; priced into usage records at metering') + '</div>'
        : '<span class="fg2">no price recorded</span><div class="mdc-sub">Usage is metered without a cost until a price is recorded.</div>';
      const priceActs = (canFinops && (k.provider === 'aws' || k.provider === 'azure') ? UI.btn('Refresh prices', { size: 'xs', attrs: 'data-mdc-refresh' }) : '') + (canFinops ? UI.btn('Record a price', { size: 'xs', attrs: 'data-mdc-price' }) : '');
      const r = k.residency || {};
      const regions = (r.regions || []).map((x) => x.region === '*' ? 'any region' : x.region + (x.allowed ? '' : ' (not allowed)')).join(', ');
      const scope = r.scope === 'regional' ? 'Runs in ' + (regions || k.region || 'its region') + ' only.' : r.scope === 'cross-region' ? 'Cross-region: may run in ' + regions + '. Refused above internal.' : 'Global: may run outside any one region. Refused above internal.';
      const att = r.attestation;
      const pending = (r.pending || [])[0] || null;
      let attest = '';
      if (att) attest = '<div class="mdc-sub">Data terms attested: no training, ' + (att.terms.retentionDays ? 'kept ' + att.terms.retentionDays + ' days' : 'not kept') + ', abuse monitoring ' + esc(att.terms.abuseMonitoring) + '.</div>' + (canAdmin ? '<div class="mdc-acts">' + UI.btn('Revoke attestation', { size: 'xs', kind: 'ghost', attrs: 'data-mdc-revoke="' + esc(att.id) + '"' }) + '</div>' : '');
      else if (pending) attest = '<div class="mdc-sub">An attestation of the data terms waits for a second cloud admin.</div>' + (canAdmin ? '<div class="mdc-acts">' + (pending.proposedBy !== meId ? UI.btn('Approve attestation', { size: 'xs', attrs: 'data-mdc-approve="' + esc(pending.id) + '"' }) : '') + UI.btn(pending.proposedBy === meId ? 'Withdraw' : 'Reject', { size: 'xs', kind: 'ghost', attrs: 'data-mdc-reject="' + esc(pending.id) + '"' }) + '</div>' : '');
      else if (r.scope === 'regional' && k.entry) attest = '<div class="mdc-sub">Not attested: the ceiling stays internal.</div>' + (canAdmin ? '<div class="mdc-acts">' + UI.btn('Attest data terms', { size: 'xs', attrs: 'data-mdc-attest' }) + '</div>' : '');
      const residency = esc(scope) + (r.ceiling ? ' Ceiling ' + UI.label(r.ceiling, { sm: true }) : '') + attest;
      const g = k.guardrail || {};
      let guard;
      if (k.provider === 'aws') {
        const l = g.layer;
        guard = embedding ? '<span class="fg2">not applicable to embeddings</span>' : l && l.enabled ? 'Bedrock Guardrail <span class="mono">' + esc(l.id) + '</span> version ' + esc(l.version) + ', ' + (l.mode === 'apply' ? 'ApplyGuardrail on the prompt and the answer' : 'attached to Converse') : l ? 'Bedrock Guardrail <span class="mono">' + esc(l.id) + '</span> set but off' : '<span class="fg2">none on the provider side</span>';
        if (canAdmin && k.instance && !embedding) guard += '<div class="mdc-acts">' + UI.btn(l ? 'Change guardrail' : 'Set guardrail', { size: 'xs', attrs: 'data-mdc-guard' }) + '</div>';
      } else guard = k.provider === 'azure' ? 'Azure content filter, recorded as guardrail decisions' : '<span class="fg2">none on the provider side</span>';
      guard += '<div class="mdc-sub">An extra layer: Exprsn-AI\'s own checkpoints run before and after it, whatever it decides.</div>';
      const gw = k.aiGateway;
      const gateway = gw ? 'On, gateway <span class="mono">' + esc(gw.gatewayId) + '</span><div class="mdc-sub">Cache ' + (gw.cache ? 'on' : 'off') + ', logs ' + (gw.logs ? 'on' : 'off') + ' up to internal; above internal off' + (gw.confidential.cache || gw.confidential.logs ? ' unless turned on for confidential' : '') + '.</div>' : '<span class="fg2">off</span>';
      return [
        ['Provider', esc(PROVIDER[k.provider] || k.provider) + ', account <a href="#" data-go="cloud" class="mono">' + esc(k.account.name) + '</a>' + (k.instance ? ' <span class="mdc-sub">on ' + esc(k.instance.name) + '</span>' : '')],
        ['Region', esc(k.region || 'not pinned') + ((k.routesTo || []).length > 1 ? ' <span class="mdc-sub">routes to ' + esc(k.routesTo.join(', ')) + '</span>' : '')],
        ['Price', price + (priceActs ? '<div class="mdc-acts">' + priceActs + '</div>' : '')],
        ['Residency', residency],
        ['Provider guardrail', guard],
        ['AI Gateway', gateway]
      ];
    };

    // ---------- the cloud catalogue ----------
    const importModal = (account, row) => deps.formModal({
      title: 'Import ' + esc(row.id) + ' as a draft',
      ok: 'Import draft',
      body: UI.kv([['Provider', esc(PROVIDER[account.provider] || account.provider)], ['Account', '<span class="mono">' + esc(account.name) + '</span>'], ['Region', esc(row.region || 'not pinned')], ['Ceiling', row.ceiling ? UI.label(row.ceiling, { sm: true }) : '-']], 2)
        + '<p class="fg2" style="margin:0">A draft catalogue entry with the provider\'s terms recorded. Evaluation, the licence and a second approver apply as for any model.</p>'
        + UI.field('Max label', UI.select(LABELS.filter((l) => LABELS.indexOf(l) <= LABELS.indexOf(row.ceiling || 'internal')), row.ceiling || 'internal', 'data-f="label"'), 'Capped at the entry\'s ceiling.'),
      read: (m) => { const b = { ids: [row.id], label: m.querySelector('[data-f="label"]').value }; if (row.region) b.region = row.region; return b; },
      submit: (body) => App.post('/api/admin/cloud/accounts/' + enc(account.id) + '/model-import', body),
      done: (r) => {
        const x = (r.results || [])[0] || {};
        if (x.outcome === 'registered' || x.outcome === 'updated' || x.outcome === 'unchanged') deps.say('<b>' + esc(row.id) + '</b> registered as a draft from ' + esc(account.name) + '. Audit entry cloud.models.imported written.', 'ok', 6000);
        else deps.say('<b>' + esc(row.id) + '</b> not imported: ' + esc(x.reason || x.outcome), 'warn', 7000);
        if (x.modelId) st.selected = x.modelId;
        st.provider = 'all'; st.lifecycle = 'all';
        deps.reloadModels(); reload();
      }
    });
    const catalogueModal = () => {
      const accounts = c.accounts || [];
      const opts = accounts.map((a) => ({ value: a.id, label: a.name + ' (' + (PROVIDER[a.provider] || a.provider) + ')' }));
      let listed = null;
      ctx.modal({
        title: 'Cloud catalogue', cls: 'wide', onClose: deps.onClose,
        body: '<p class="fg2" style="margin:0">Models the connected cloud accounts offer. Importing registers a draft catalogue entry; approval, licence and evaluation work as for any model.</p>'
          + (accounts.length ? '<div class="formgrid">' + UI.field('Account', UI.select(opts, opts[0].value, 'data-f="account"')) + UI.field('Region', UI.select([], '', 'data-f="region"')) + '</div><div>' + UI.btn('List models', { attrs: 'data-mdc-list' }) + '</div>' : UI.notice('No active cloud account. Connect one under Cloud first.', 'info'))
          + '<div data-mdc-out class="mdc-list"></div><div data-err></div>',
        actions: UI.btn('Close', { attrs: 'data-close' }),
        onMount(m) {
          const acct = () => accounts.find((a) => a.id === m.querySelector('[data-f="account"]').value);
          const regions = () => {
            const a = acct(); const sel = m.querySelector('[data-f="region"]'); if (!a || !sel) return;
            sel.innerHTML = [{ value: '', label: 'every allowed region' }].concat((a.regions || []).map((r) => ({ value: r.region, label: r.region }))).map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('');
          };
          regions();
          const acSel = m.querySelector('[data-f="account"]'); if (acSel) acSel.addEventListener('change', regions);
          const out = m.querySelector('[data-mdc-out]');
          const show = () => {
            if (!listed) return;
            const rows = listed.models.filter((x) => x.kind === 'chat' || x.kind === 'embedding');
            out.innerHTML = UI.table(['Model', 'Kind', 'Region', 'Access', 'Ceiling', ''], rows.map((x) => [
              '<span class="mono">' + esc(x.id) + '</span>' + (x.routesTo && x.routesTo.length > 1 ? ' ' + UI.pill('cross-region', 'warn') : ''),
              esc(x.kind), esc(x.region || '-'), esc(String(x.accessState || '').replace('_', ' ')), x.ceiling ? UI.label(x.ceiling, { sm: true }) : '<span class="fg2">-</span>',
              x.catalogued ? UI.pill('imported', 'ok') : x.available && x.ceiling ? UI.btn('Import', { size: 'xs', attrs: 'data-mdc-imp="' + esc(x.id) + '" aria-label="Import ' + esc(x.id) + '"' }) : '<span class="mdc-sub">' + esc(x.reason || 'not available') + '</span>'
            ]), { clickable: false, minWidth: '0', emptyTitle: 'Nothing to import', emptyText: 'The account offers no chat or embedding model in that region.' });
          };
          m.addEventListener('click', (e) => {
            if (e.target.closest('[data-mdc-list]')) {
              const a = acct(); if (!a) return;
              const region = m.querySelector('[data-f="region"]').value;
              out.innerHTML = UI.notice('Asking ' + esc(a.name) + '…', 'info');
              App.get('/api/admin/cloud/accounts/' + enc(a.id) + '/model-import' + (region ? '?region=' + enc(region) : ''))
                .then((r) => { listed = r; show(); }).catch((err) => { out.innerHTML = ''; problem(m, err); });
              return;
            }
            const b = e.target.closest('[data-mdc-imp]');
            if (!b || !listed) return;
            const row = listed.models.find((x) => x.id === b.dataset.mdcImp);
            const a = acct();
            App.closeOverlay();
            setTimeout(() => importModal(a, row), 30);
          });
        }
      });
    };

    // ---------- handlers (registered on every render) ----------
    const bind = (sel) => {
      ctx.on('click', '[data-catalogue]', () => catalogueModal());
      const k = cardOf(sel);
      if (!k) return;
      ctx.on('click', '[data-mdc-refresh]', () => {
        App.post('/api/admin/cloud/accounts/' + enc(k.account.id) + '/model-prices/refresh').then((r) => { deps.say(r.skipped ? esc(r.skipped) : 'Prices refreshed from the ' + (k.provider === 'aws' ? 'AWS Price List API' : 'Azure Retail Prices API') + ': ' + r.fetched + ' new, ' + r.known + ' unchanged' + (r.failed.length ? ', ' + r.failed.length + ' failed' : '') + '. Audited cloud.model-prices.refreshed.', r.failed.length ? 'warn' : 'ok', 6000); reload(); }).catch((err) => App.fail(err, 'Prices not refreshed'));
      });
      ctx.on('click', '[data-mdc-price]', () => {
        const today = new Date().toISOString().slice(0, 10);
        const neurons = k.provider === 'cloudflare';
        deps.formModal({
          title: 'Record a price for ' + esc(sel.name), ok: 'Record price',
          body: '<p class="fg2" style="margin:0">A price version prices usage records from its effective date on; earlier records keep their price.</p><div class="formgrid">'
            + (neurons ? UI.field('Neurons per 1M input tokens', UI.input('', { type: 'number', attrs: 'data-f="ni" min="0"' })) + UI.field('Neurons per 1M output tokens', UI.input('', { type: 'number', attrs: 'data-f="no" min="0"' })) + UI.field('USD per 1,000 neurons', UI.input('0.011', { type: 'number', attrs: 'data-f="np" min="0" step="any"' }))
              : UI.field('Input, USD per 1M tokens', UI.input('', { type: 'number', attrs: 'data-f="in" min="0" step="any"' })) + UI.field('Output, USD per 1M tokens', UI.input('', { type: 'number', attrs: 'data-f="out" min="0" step="any"' })) + UI.field('Cached input, USD per 1M tokens', UI.input('', { type: 'number', attrs: 'data-f="cached" min="0" step="any"', placeholder: 'the input price' })))
            + UI.field('Effective from', UI.input(today, { type: 'date', attrs: 'data-f="from"' })) + UI.field('Source', UI.input('', { attrs: 'data-f="src"', placeholder: 'https://… the price page' })) + '</div>',
          read: (m) => {
            const v = (f) => { const el = m.querySelector('[data-f="' + f + '"]'); return el ? el.value.trim() : ''; };
            const n = (f) => (v(f) === '' ? null : Number(v(f)));
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v('from'))) throw new Error('Give the date the price takes effect.');
            const base = { provider: k.provider, model: k.price.pricedAs || sel.name, region: k.region && k.region !== 'global' ? k.region : '*', effectiveFrom: v('from'), source: v('src') || null };
            return neurons ? Object.assign(base, { basis: 'neurons', neuronsInput: n('ni'), neuronsOutput: n('no'), neuronPrice: n('np') }) : Object.assign(base, { inputPerMillion: n('in'), outputPerMillion: n('out'), cachedPerMillion: n('cached') });
          },
          submit: (body) => App.api('PUT', '/api/admin/cloud/model-prices', body),
          done: (r) => { deps.say('Price recorded for <b>' + esc(r.model) + '</b> from ' + esc(r.effectiveFrom) + '. Audited cloud.model-price.set.', 'ok', 6000); reload(); }
        });
      });
      ctx.on('click', '[data-mdc-attest]', () => deps.formModal({
        title: 'Attest the data terms of ' + esc(sel.name), ok: 'Propose attestation',
        body: '<p class="fg2" style="margin:0">States what ' + esc(k.account.name) + '\'s terms say for this model. A second cloud admin approves it; then the entry\'s ceiling rises to confidential (never restricted).</p><div class="formgrid">'
          + UI.field('Retention, days', UI.input('0', { type: 'number', attrs: 'data-f="ret" min="0" max="3650"' }), '0: prompts and outputs are not stored.')
          + UI.field('Abuse monitoring', UI.select([{ value: 'off', label: 'Off (an approved exemption)' }, { value: 'standard', label: 'Standard (the provider may review flagged content)' }], 'off', 'data-f="abuse"'))
          + UI.field('Where the terms are stated', UI.input(k.entry && k.entry.terms && k.entry.terms.url ? k.entry.terms.url : '', { attrs: 'data-f="ref"', placeholder: 'https://…' }))
          + UI.field('Note', UI.input('', { attrs: 'data-f="note"' })) + '</div>'
          + '<label class="hstack gap6"><input type="checkbox" data-f="notrain"> The provider does not train on prompts or outputs</label>',
        read: (m) => {
          const v = (f) => m.querySelector('[data-f="' + f + '"]');
          if (!v('notrain').checked) throw new Error('An attestation states that the provider does not train on prompts or outputs.');
          return { noTraining: true, retentionDays: Number(v('ret').value || 0), abuseMonitoring: v('abuse').value, reference: v('ref').value.trim(), note: v('note').value.trim() || null };
        },
        submit: (body) => App.post('/api/admin/cloud/model-entries/' + enc(sel.id) + '/attestations', body),
        done: () => { deps.say('Attestation proposed. A second cloud admin approves it. Audited cloud.model.attestation.proposed.', 'ok', 6000); reload(); }
      }));
      ctx.on('click', '[data-mdc-approve]', async (e, t) => {
        const ok = await ctx.confirm({ title: 'Approve the data terms of ' + sel.name, tag: 'confidential', tone: 'ok', ok: 'Approve', body: '<p style="margin:0" class="fg2">The entry\'s ceiling rises to confidential, bounded by its region\'s ceiling. Requests above it stay refused.</p>' });
        if (!ok) return;
        App.post('/api/admin/cloud/attestations/' + enc(t.dataset.mdcApprove) + '/approve').then((r) => { deps.say('Attestation approved: the ceiling is ' + esc(r.ceiling) + '. Audited cloud.model.attestation.approved.', 'ok', 6000); reload(); }).catch((err) => App.fail(err, 'Not approved'));
      });
      ctx.on('click', '[data-mdc-reject]', (e, t) => App.post('/api/admin/cloud/attestations/' + enc(t.dataset.mdcReject) + '/reject', {}).then(() => { deps.say('Attestation set aside. Audited cloud.model.attestation.rejected.', 'ok'); reload(); }).catch((err) => App.fail(err, 'Not changed')));
      ctx.on('click', '[data-mdc-revoke]', async (e, t) => {
        const ok = await ctx.confirm({ title: 'Revoke the attestation of ' + sel.name, tone: 'danger', ok: 'Revoke', body: '<p style="margin:0" class="fg2">The ceiling drops back to internal and the model\'s label with it. Confidential requests are refused from now on.</p>' });
        if (!ok) return;
        App.post('/api/admin/cloud/attestations/' + enc(t.dataset.mdcRevoke) + '/revoke').then(() => { deps.say('Attestation revoked; the ceiling is internal. Audited cloud.model.attestation.revoked.', 'ok', 6000); deps.reloadModels(); reload(); }).catch((err) => App.fail(err, 'Not revoked'));
      });
      ctx.on('click', '[data-mdc-guard]', () => {
        const l = (k.guardrail || {}).layer || null;
        deps.formModal({
          title: 'Bedrock Guardrail on ' + esc(k.instance.name), ok: 'Save guardrail',
          body: '<p class="fg2" style="margin:0">An extra layer in front of the model. Exprsn-AI\'s own checkpoints run before and after it, and turning it off turns none of them off.</p><div class="formgrid">'
            + UI.field('Guardrail id', UI.input(l ? l.id : '', { attrs: 'data-f="gid"', placeholder: 'the id from the Bedrock console' }))
            + UI.field('Version', UI.input(l ? l.version : '1', { attrs: 'data-f="gver"' }), 'A version number, or DRAFT.')
            + UI.field('How it is applied', UI.select([{ value: 'converse', label: 'Attached to Converse (guardrailConfig)' }, { value: 'apply', label: 'ApplyGuardrail on the prompt and the answer' }], l ? l.mode : 'converse', 'data-f="gmode"'))
            + UI.field('State', UI.select([{ value: 'on', label: 'On' }, { value: 'off', label: 'Off (kept, not applied)' }, { value: 'remove', label: 'Remove' }], l && !l.enabled ? 'off' : 'on', 'data-f="gstate"')) + '</div>',
          read: (m) => {
            const v = (f) => m.querySelector('[data-f="' + f + '"]').value.trim();
            if (v('gstate') === 'remove') return { guardrail: null };
            if (!v('gid')) throw new Error('Give the guardrail\'s id.');
            return { guardrail: { id: v('gid'), version: v('gver') || '1', mode: v('gmode'), enabled: v('gstate') === 'on' } };
          },
          submit: (body) => App.api('PUT', '/api/admin/cloud/model-servers/' + enc(k.instance.id) + '/guardrail', body),
          done: (r) => { deps.say(r.guardrail ? 'Bedrock Guardrail ' + esc(r.guardrail.id) + ' ' + (r.guardrail.enabled ? 'on' : 'off') + '. Audited cloud.model-server.guardrail.set.' : 'Bedrock Guardrail removed. Audited cloud.model-server.guardrail.set.', 'ok', 6000); reload(); }
        });
      });
    };

    return {
      css: CSS,
      loaded: !!c.loaded,
      providers,
      providerOf,
      matches,
      cardOf,
      kvRows,
      bind,
      reload,
      canImport: canRead && canManage
    };
  };
})();
