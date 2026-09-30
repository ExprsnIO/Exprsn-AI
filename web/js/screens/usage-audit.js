(function () {
  const { UI, esc } = App;

  // ---------- formatting ----------
  const fmt = (n) => Number(n || 0).toLocaleString();
  const compact = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n)));
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const whenFull = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const whenRow = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dayLabel = (d) => { const p = String(d).split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }); };
  const ymd = (date) => date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const short = (h) => (h ? String(h).slice(0, 12) : '');
  const oneLine = (o) => (o && typeof o === 'object' ? Object.keys(o).map((k) => k + ': ' + (o[k] && typeof o[k] === 'object' ? JSON.stringify(o[k]) : String(o[k]))).join(', ') : '');
  // A "nice" axis maximum: 1, 2, 2.5 or 5 times a power of ten at or above the largest value.
  const niceMax = (v) => { if (!(v > 0)) return 10; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; };

  const KINDS = [['all', 'All'], ['decision', 'Decisions'], ['admin', 'Admin actions'], ['auth', 'Sign-ins'], ['correction', 'Corrections'], ['system', 'System']];
  const PERIODS = [{ value: 'today', label: 'Today' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: 'month', label: 'This month' }];
  const BY_LABEL = { user: 'User or agent', model: 'Model', workspace: 'Workspace', profile: 'Profile', tenant: 'Tenant' };
  const ACTION_RE = /^[a-z0-9._]+$/;
  const isSysAdmin = () => !!(App.me && App.me.roles.some((r) => r.id === 'system-admin'));
  const actorName = (a) => (!a ? '' : a.name || a.username || a.service || (a.ip ? 'anonymous, ' + a.ip : 'system'));
  const mix = (r) => {
    const out = Number(r.output || 0), th = Math.min(out, Number(r.thinking || 0));
    const split = out ? Math.round((th / out) * 100) + '% / ' + (100 - Math.round((th / out) * 100)) + '%' : '- / -';
    return split + ' · ' + fmt(r.calc) + ' calc';
  };

  // One job.progress listener for the whole screen; it removes itself once the screen is left.
  let jobSocket = null, jobHandler = null;
  const stopJobs = () => { if (jobSocket && jobHandler) jobSocket.off('job.progress', jobHandler); jobSocket = null; jobHandler = null; };

  // ---------- chart (inline SVG) ----------
  function chart(st, days) {
    const W = 600, H = 160, L = 44, R = 590, top = 20, base = 130;
    const n = days.length || 1;
    const max = niceMax(Math.max.apply(null, days.map((d) => d.tokens).concat([0])));
    const y = (v) => base - (v / max) * (base - top);
    const slot = (R - L) / n, bw = Math.max(4, Math.min(24, slot * 0.6));
    const cx = (i) => L + slot * i + slot / 2;
    const hov = st.hover != null && st.hover < days.length ? st.hover : null;
    let bars = '';
    days.forEach((d, i) => {
      const x = cx(i) - bw / 2, yy = y(d.tokens), h = base - yy;
      const hi = i === days.length - 1 || hov === i;
      const r = Math.min(4, h / 2, bw / 2);
      const path = h > 0.5 ? 'M' + x + ' ' + base + ' V' + (yy + r) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' -' + r + ' h' + (bw - 2 * r) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + ' V' + base + ' z' : 'M' + x + ' ' + (base - 1) + ' h' + bw + ' v1 h-' + bw + ' z';
      bars += '<g class="ua-bar' + (hov === i ? ' hov' : '') + '" data-bar="' + i + '" tabindex="0" role="listitem" aria-label="' + esc(dayLabel(d.day)) + ', ' + esc(fmt(d.tokens)) + ' tokens">'
        + '<rect x="' + (cx(i) - slot / 2) + '" y="' + top + '" width="' + slot + '" height="' + (base - top) + '" fill="transparent"></rect>'
        + '<path d="' + path + '" fill="' + (hi ? 'var(--accent)' : 'var(--meter)') + '"></path>'
        + '<title>' + esc(dayLabel(d.day)) + ': ' + esc(fmt(d.tokens)) + ' tokens, ' + esc(fmt(d.gpuSeconds)) + ' GPU-seconds</title></g>';
    });
    let tip = '';
    if (hov != null) {
      const d = days[hov], text = dayLabel(d.day) + ', ' + fmt(d.tokens) + ' tokens';
      const tw = Math.max(110, text.length * 6.4 + 16), tx = Math.min(R - tw, Math.max(L, cx(hov) - tw / 2)), ty = Math.max(0, y(d.tokens) - 34);
      tip = '<g pointer-events="none"><rect x="' + tx + '" y="' + ty + '" width="' + tw + '" height="26" rx="4" fill="var(--fg)"></rect><text x="' + (tx + tw / 2) + '" y="' + (ty + 17) + '" text-anchor="middle" font-size="11" font-weight="600" fill="var(--bg)">' + esc(text) + '</text></g>';
    }
    const last = days[days.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="160" role="img" aria-label="Tokens per day, ' + days.length + ' days" style="display:block;font-family:var(--sans)">'
      + '<g stroke="var(--line2)"><line x1="' + L + '" y1="' + top + '" x2="' + R + '" y2="' + top + '"></line><line x1="' + L + '" y1="' + (top + (base - top) / 2) + '" x2="' + R + '" y2="' + (top + (base - top) / 2) + '"></line></g>'
      + '<line x1="' + L + '" y1="' + base + '" x2="' + R + '" y2="' + base + '" stroke="var(--faint)"></line>'
      + '<g role="list">' + bars + '</g>'
      + '<g font-size="11" fill="var(--muted)"><text x="' + (L - 6) + '" y="' + (top + 4) + '" text-anchor="end">' + compact(max) + '</text><text x="' + (L - 6) + '" y="' + (top + (base - top) / 2 + 4) + '" text-anchor="end">' + compact(max / 2) + '</text><text x="' + (L - 6) + '" y="' + (base + 4) + '" text-anchor="end">0</text>'
      + (days.length ? '<text x="' + (cx(0) - bw / 2) + '" y="148">' + esc(dayLabel(days[0].day)) + '</text><text x="' + (cx(days.length - 1) + bw / 2) + '" y="148" text-anchor="end">' + esc(dayLabel(last.day)) + '</text>' : '')
      + (hov == null && last && last.tokens > 0 ? '<text x="' + cx(days.length - 1) + '" y="' + Math.max(12, y(last.tokens) - 6) + '" text-anchor="middle" fill="var(--fg)" font-weight="600">' + compact(last.tokens) + '</text>' : '') + '</g>' + tip + '</svg>';
  }

  // ---------- Sprint 13: statements and price books (billing:read to see, billing:manage to change) ----------
  const METER_LABEL = { prompt_tokens: 'Prompt tokens', output_tokens: 'Output tokens', thinking_tokens: 'Thinking tokens', gpu_seconds: 'GPU-seconds', requests: 'Requests', calc_calls: 'Calculator calls' };
  const money = (micros, cur) => (Number(micros || 0) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 }) + ' ' + (cur || '');
  function billingLoad(st, refresh) {
    const b = st.bill = st.bill || {};
    if (b.loading || b.loaded) return;
    b.loading = true;
    Promise.all([App.get('/api/admin/billing/statements'), App.get('/api/admin/billing/price-books'), App.get('/api/admin/billing/settings')])
      .then(([list, books, settings]) => { Object.assign(b, { list, books, settings, loaded: true, error: null }); if (!b.month || !list.statements.some((x) => x.month === b.month)) b.month = list.statements.length ? list.statements[0].month : list.current; b.detail = null; })
      .catch((err) => { b.error = err; b.loaded = true; })
      .finally(() => { b.loading = false; refresh(); });
  }
  function billingDetail(st, refresh) {
    const b = st.bill; if (!b.month || (b.detail && b.detail.month === b.month) || b.detailLoading === b.month) return;
    b.detailLoading = b.month;
    App.get('/api/admin/billing/statements/' + encodeURIComponent(b.month))
      .then((d) => { if (b.month === d.month) b.detail = d; })
      .catch((err) => { b.detail = { month: b.month, error: err }; })
      .finally(() => { b.detailLoading = null; refresh(); });
  }
  function billingHtml(st, refresh) {
    const b = st.bill || {};
    if (!b.loaded) return UI.notice('Loading…', 'info');
    if (b.error) return UI.problem('Statements could not be loaded', b.error.message, b.error.problem && b.error.problem.trace_id);
    billingDetail(st, refresh);
    const d = b.detail && b.detail.month === b.month ? b.detail : null;
    const manage = App.can('billing:manage');
    const list = b.list.statements;
    const book = b.settings.effectiveBook;
    let h = '<div class="hstack wrap"><div class="eyebrow">Statements from the usage meter</div>'
      + UI.select(list.map((x) => ({ value: x.month, label: x.month + ', ' + x.state + ', ' + money(x.totalMicros, x.currency) })), b.month, 'data-bmonth aria-label="Month" style="width:260px"')
      + '<span class="right hstack gap6">'
      + (d && !d.error ? '<a class="btn ghost sm" href="/api/admin/billing/statements/' + encodeURIComponent(b.month) + '/export?format=csv" download>CSV</a><a class="btn ghost sm" href="/api/admin/billing/statements/' + encodeURIComponent(b.month) + '/export?format=json" download>JSON</a>' : '')
      + (manage && d && !d.error && d.state !== 'pushed' ? UI.btn(d.state === 'preview' ? 'Save statement' : 'Recompute', { size: 'sm', attrs: 'data-bcompute' }) : '')
      + (manage && b.settings.provider && d && !d.error && d.state !== 'pushed' && b.month < b.list.current ? UI.btn('Send to ' + b.settings.provider, { size: 'sm', kind: 'primary', attrs: 'data-bpush' }) : '')
      + '</span></div>';
    if (!book) h += UI.notice('<b>No price book applies to this tenant.</b> Statements list the usage with no amounts until ' + (manage ? 'you set a default price book below.' : 'a system admin sets a default price book.'), 'warn');
    if (!d) h += UI.notice('Loading…', 'info');
    else if (d.error) h += UI.problem('The statement could not be loaded', d.error.message, d.error.problem && d.error.problem.trace_id);
    else {
      const t = d.totals;
      h += (d.state === 'push failed' ? UI.notice('<b>Sending failed.</b> ' + esc(d.pushError || ''), 'danger') : '')
        + (d.state === 'pushed' ? UI.notice('Sent to ' + esc(b.settings.provider || 'the billing provider') + ' as ' + esc(d.providerRef || '') + ' on ' + esc(when(d.pushedAt)) + '. The statement is final.', 'ok') : '')
        + '<div class="grid4">' + UI.stat(esc(money(d.totalMicros, d.currency)), 'Total, ' + d.month, esc(d.state === 'preview' ? 'preview, not saved' : d.state)) + UI.stat(fmt(t.promptTokens + t.outputTokens), 'Tokens', fmt(t.promptTokens) + ' in, ' + fmt(t.outputTokens) + ' out') + UI.stat(fmt(Math.round(t.gpuSeconds)), 'GPU-seconds', '') + UI.stat(fmt(t.requests), 'Requests', d.book ? 'price book ' + esc(d.book.name) : 'no price book') + '</div>'
        + UI.table(['Kind', 'Model', 'Profile', 'Meter', { label: 'Quantity', right: true }, { label: 'Price', right: true }, { label: 'Amount', right: true }], d.lines.map((l) => [esc(l.kind), '<span class="mono">' + esc(l.model || '') + '</span>', esc(l.profile || ''), esc(METER_LABEL[l.meter] || l.meter), fmt(l.quantity), l.priced ? esc(money(l.unitPriceMicros, '')) + ' <span class="muted">per ' + fmt(l.perUnits) + '</span>' : '<span class="muted">not priced</span>', esc(money(l.amountMicros, d.currency))]), { clickable: false, minWidth: '720px', emptyTitle: 'No usage this month', emptyText: 'Lines appear as models are used.' })
        + '<div class="muted" style="font-size:12px">Totals come from the same usage records as the Usage tab, so they match its report for the month. Usage without a price is listed at zero.' + (d.computedAt ? ' Computed ' + esc(when(d.computedAt)) + '.' : '') + '</div>';
    }
    h += '<div class="hstack"><div class="eyebrow grow">Price books</div>' + (manage ? UI.btn('New price book', { size: 'sm', icon: 'plus', attrs: 'data-bnewbook' }) : '') + '</div>'
      + UI.table(['Name', 'Currency', 'Items', 'State', ''], b.books.books.map((x) => ['<b>' + esc(x.name) + '</b>' + (x.isDefault ? ' ' + UI.pill('default', 'accent') : '') + (book && book.id === x.id ? ' <span class="muted">used for this tenant</span>' : ''), esc(x.currency), fmt(x.items.length), UI.pill(x.state, x.state === 'active' ? 'ok' : 'outline'), manage ? UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-beditbook="' + esc(x.id) + '"' }) : '']), { clickable: false, minWidth: '520px', emptyTitle: 'No price books', emptyText: manage ? 'Create one to price the usage meter.' : 'A system admin keeps the price books.' });
    if (manage) h += '<div class="hstack wrap gap6"><span class="muted" style="font-size:12px">This tenant uses</span>' + UI.select([{ value: '', label: 'The default price book' }].concat(b.books.books.filter((x) => x.state === 'active').map((x) => ({ value: x.id, label: x.name }))), b.settings.priceBookId || '', 'data-bbook aria-label="Price book for this tenant" style="width:220px"')
      + (b.settings.provider ? UI.input(b.settings.billingCustomer || '', { attrs: 'data-bcustomer aria-label="Billing customer" style="width:200px"', placeholder: 'Stripe customer, cus_...' }) : '') + UI.btn('Save', { size: 'sm', attrs: 'data-bsettings' }) + '</div>';
    return h;
  }
  function priceBookModal(ctx, st, existing, reload) {
    const meters = Object.keys(METER_LABEL);
    const items = existing ? existing.items.slice() : [{ match: 'any', value: null, usage: '*', meter: 'prompt_tokens', perUnits: 1000000, unitPriceMicros: 0 }];
    const row = (it, i) => '<tr data-bitem="' + i + '"><td>' + UI.select([{ value: 'any', label: 'Anything' }, { value: 'model', label: 'Model' }, { value: 'profile', label: 'Profile' }], it.match, 'data-bf="match" aria-label="Applies to"') + '</td>'
      + '<td>' + UI.input(it.value || '', { attrs: 'data-bf="value" aria-label="Model or profile name"', placeholder: 'name' }) + '</td>'
      + '<td>' + UI.input(it.usage, { attrs: 'data-bf="usage" aria-label="Usage kind" style="width:80px"', placeholder: '*' }) + '</td>'
      + '<td>' + UI.select(meters.map((m) => ({ value: m, label: METER_LABEL[m] })), it.meter, 'data-bf="meter" aria-label="Meter"') + '</td>'
      + '<td>' + UI.input(String(it.unitPriceMicros / 1e6), { attrs: 'data-bf="price" aria-label="Price" style="width:90px"' }) + '</td>'
      + '<td>' + UI.input(String(it.perUnits), { attrs: 'data-bf="per" aria-label="Per units" style="width:100px"' }) + '</td>'
      + '<td>' + UI.iconbtn('x', 'Remove item', { cls: 'sm ghost', attrs: 'data-bdel="' + i + '"' }) + '</td></tr>';
    ctx.modal({
      title: existing ? 'Edit ' + esc(existing.name) : 'New price book', cls: 'wide',
      body: '<div class="formgrid">' + UI.field('Name', UI.input(existing ? existing.name : '', { attrs: 'data-bname maxlength="100"' })) + UI.field('Currency', UI.input(existing ? existing.currency : 'USD', { attrs: 'data-bcur maxlength="3"' }))
        + UI.field('State', UI.select(['active', 'retired'], existing ? existing.state : 'active', 'data-bstate')) + '</div>'
        + UI.check('Default for tenants without their own', existing ? existing.isDefault : false, 'data-bdefault')
        + '<div class="fg2" style="font-size:12px">Each item prices one meter. The most specific item wins: a profile, then a model, then anything; a named usage kind (chat, api, embed, agent, workflow…) beats *.</div>'
        + '<div class="tablewrap"><table class="dt"><thead><tr><th>Applies to</th><th>Name</th><th>Usage</th><th>Meter</th><th>Price</th><th>Per</th><th></th></tr></thead><tbody data-bitems></tbody></table></div>'
        + UI.btn('Add item', { size: 'sm', icon: 'plus', attrs: 'data-badd' }) + '<div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(existing ? 'Save price book' : 'Create price book', { kind: 'primary', attrs: 'data-bsave' }),
      onMount(m) {
        const tbody = m.querySelector('[data-bitems]');
        const read = () => Array.prototype.slice.call(tbody.querySelectorAll('tr')).map((tr) => { const g = (k) => tr.querySelector('[data-bf="' + k + '"]').value.trim(); return { match: g('match'), value: g('match') === 'any' ? null : g('value') || null, usage: g('usage') || '*', meter: g('meter'), perUnits: Number(g('per')), unitPriceMicros: Math.round(Number(g('price')) * 1e6) }; });
        const paint = () => { tbody.innerHTML = items.map(row).join(''); };
        paint();
        m.querySelector('[data-badd]').addEventListener('click', () => { items.splice(0, items.length, ...read()); items.push({ match: 'model', value: '', usage: '*', meter: 'output_tokens', perUnits: 1000000, unitPriceMicros: 0 }); paint(); });
        tbody.addEventListener('click', (e) => { const x = e.target.closest('[data-bdel]'); if (!x) return; items.splice(0, items.length, ...read()); items.splice(+x.dataset.bdel, 1); paint(); });
        m.querySelector('[data-bsave]').addEventListener('click', async (e) => {
          const list = read();
          const bad = list.find((it) => !(it.perUnits >= 1) || !(it.unitPriceMicros >= 0) || (it.match !== 'any' && !it.value));
          const box = m.querySelector('[data-err]'); box.innerHTML = '';
          if (bad) { box.innerHTML = UI.notice('Each item needs a price of zero or more, a per-unit count of one or more, and a name when it applies to a model or profile.', 'warn'); return; }
          const def = m.querySelector('[data-bdefault]');
          const body = { name: m.querySelector('[data-bname]').value.trim(), currency: m.querySelector('[data-bcur]').value.trim().toUpperCase(), isDefault: !!(def && def.checked), items: list };
          if (existing) body.state = m.querySelector('[data-bstate]').value;
          e.target.disabled = true;
          try {
            if (existing) await App.patch('/api/admin/billing/price-books/' + encodeURIComponent(existing.id), body); else await App.post('/api/admin/billing/price-books', body);
            App.closeOverlay(); ctx.toast('Price book saved. Audit entry written.', 'ok'); reload();
          } catch (err) { e.target.disabled = false; const p = err.problem || {}; box.innerHTML = UI.notice('<b>' + esc(p.detail || err.message) + '</b>', 'danger'); }
        });
      }
    });
  }
  function billingWire(st, ctx, refresh) {
    const b = st.bill || {};
    const reload = () => { b.loaded = false; b.detail = null; refresh(); };
    ctx.on('change', '[data-bmonth]', (e, t) => { b.month = t.value; b.detail = null; ctx.rerender(); });
    ctx.on('click', '[data-bcompute]', async () => {
      const ok = await ctx.confirm({ title: 'Save the ' + b.month + ' statement?', body: 'The statement is computed again from the usage meter and stored. A finished month is saved as closed.', ok: 'Save' });
      if (!ok) return;
      try { await App.post('/api/admin/billing/statements/' + encodeURIComponent(b.month) + '/compute', {}); ctx.toast('Statement saved. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not save the statement'); }
    });
    ctx.on('click', '[data-bpush]', async () => {
      const d = b.detail;
      const ok = await ctx.confirm({ title: 'Send ' + b.month + ' to ' + b.settings.provider + '?', tone: 'danger', body: 'An invoice is created for the tenant\'s billing customer with a line per priced item. After that the statement is final.', kv: [['Total', esc(money(d.totalMicros, d.currency))], ['Customer', esc(b.settings.billingCustomer || 'not set')]], ok: 'Send invoice' });
      if (!ok) return;
      try { const r = await App.post('/api/admin/billing/statements/' + encodeURIComponent(b.month) + '/push', {}); ctx.toast('Invoice ' + esc(r.providerRef || '') + ' created. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not send the invoice'); reload(); }
    });
    ctx.on('click', '[data-bnewbook]', () => priceBookModal(ctx, st, null, reload));
    ctx.on('click', '[data-beditbook]', (e, t) => { const x = b.books.books.find((y) => y.id === t.dataset.beditbook); if (x) priceBookModal(ctx, st, x, reload); });
    ctx.on('click', '[data-bsettings]', async () => {
      const sel = ctx.$('[data-bbook]'); const cus = ctx.$('[data-bcustomer]');
      const body = { priceBookId: sel && sel.value ? sel.value : null };
      if (cus) body.billingCustomer = cus.value.trim() || null;
      try { await App.api('PUT', '/api/admin/billing/tenants/' + encodeURIComponent(b.settings.tenantId), body); ctx.toast('Billing settings saved. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not save the billing settings'); }
    });
  }

  App.register({
    id: 'usage-audit', title: 'Usage and audit', section: 'admin', crumb: ['Admin', 'Usage and audit'], live: true,
    summary: 'Metering per tenant, user and model, quotas, hash-chained audit log, exports',
    commands: [
      { label: 'Verify the audit chain', sub: 'Usage and audit', run(app) { app.stateFor('usage-audit').runVerify = true; app.render(); } },
      { label: 'Export audit events as CSV', sub: 'Usage and audit', run(app) { app.stateFor('usage-audit').openExport = 'audit'; app.render(); } }
    ],
    states: [
      { title: 'Verification failed', tone: 'danger', text: 'Runs verification now. When the chain breaks it shows the sequence, the reason, the last good checkpoint and who was notified. Nothing is auto-repaired.', apply(ctx) { ctx.state.tab = 'audit'; ctx.state.runVerify = true; ctx.rerender(); } },
      { title: 'Export blocked', tone: 'warn', text: 'A selection that includes events above your clearance is refused. The export dialog then offers a filtered export at your clearance and below.', apply(ctx) { ctx.state.openExport = 'audit'; ctx.rerender(); } },
      { title: 'Corrections', tone: 'neutral', text: 'A correction is a new row linked to the row it corrects. The original is never edited.', apply(ctx) { ctx.state.tab = 'audit'; ctx.state.kind = 'correction'; ctx.state.q = ''; ctx.state.events = null; ctx.state.selectFirst = true; ctx.rerender(); } },
      { title: 'Bar hover', tone: 'neutral', text: 'Hovering a bar shows the day and exact token count. The table view carries the same values.', apply(ctx) { ctx.state.chartTable = false; ctx.state.hover = Math.max(0, (ctx.state.daily || []).length - 1); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const canUsage = App.can('usage:read');
      st.tab = st.tab || (canUsage ? 'usage' : 'audit'); st.by = st.by || 'user'; st.period = st.period || 'today'; st.kind = st.kind || 'all';
      if (st.q == null) st.q = '';
      st.details = st.details || {};
      if (st.by === 'tenant' && !isSysAdmin()) st.by = 'user';
      if (location.hash !== st.paramsHash) {
        st.paramsHash = location.hash;
        if (ctx.params.event) { st.sel = ctx.params.event; st.inspect = 'event'; st.tab = 'audit'; }
        if (ctx.params.tab) st.tab = ctx.params.tab;
      }
      const tenantName = App.me.tenant ? App.me.tenant.name : 'This tenant';
      const clearance = App.me.user.clearance;

      // ---------- loading ----------
      // Async results re-render only while this screen is showing and no dialog is open (a re-render closes dialogs).
      const refresh = () => {
        if (App.state.route !== 'usage-audit') return;
        if (document.getElementById('overlay')) { st.dirty = true; return; }
        const focused = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute('data-q');
        ctx.rerender();
        if (focused) { const i = document.querySelector('#main [data-q]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
      };
      const onClose = () => { if (st.dirty) { st.dirty = false; refresh(); } };
      const auditQuery = () => {
        const p = [];
        if (st.kind !== 'all') p.push('kind=' + encodeURIComponent(st.kind));
        const q = st.q.trim();
        if (q.charAt(0) === '@') { if (q.length > 1) p.push('actor=' + encodeURIComponent(q.slice(1))); } else if (q) p.push((ACTION_RE.test(q) ? 'action=' : 'actor=') + encodeURIComponent(q));
        return p;
      };
      const usageQuery = () => {
        if (st.period === 'month') { const now = new Date(); return 'from=' + ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))) + '&to=' + ymd(now); }
        return 'days=' + (st.period === 'today' ? 1 : st.period);
      };
      const getEvents = (before) => App.get('/api/admin/audit?' + auditQuery().concat(['limit=100']).concat(before ? ['before=' + before] : []).join('&'));
      const getUsage = () => App.get('/api/admin/usage/summary?by=' + st.by + '&' + usageQuery());
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/admin/audit/summary'), getEvents(), App.get('/api/admin/exports'),
          canUsage ? App.get('/api/admin/usage/daily?days=14') : null, canUsage ? getUsage() : null, canUsage ? App.get('/api/admin/quotas') : null])
          .then(([summary, events, exports, daily, usage, quotas]) => {
            Object.assign(st, { summary, events, eventsEnd: events.length < 100, exports, daily: daily || [], usage, quotas, loaded: true, loadError: null });
            if (st.selectFirst) { st.selectFirst = false; if (events[0]) { st.sel = events[0].id; st.inspect = 'event'; } }
            watchExports();
          })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; refresh(); });
      };
      if (!st.loaded && !st.loadError) load();
      const reload = () => { st.loaded = false; st.loadError = null; ctx.rerender(); };
      const reloadEvents = () => {
        const seq = (st.eventsSeq = (st.eventsSeq || 0) + 1);
        getEvents().then((events) => {
          if (seq !== st.eventsSeq) return;
          st.events = events; st.eventsEnd = events.length < 100;
          if (st.selectFirst) { st.selectFirst = false; if (events[0]) { st.sel = events[0].id; st.inspect = 'event'; } }
          refresh();
        }).catch((err) => App.fail(err, 'Audit events could not be loaded'));
      };
      const reloadSummary = () => App.get('/api/admin/audit/summary').then((s) => { st.summary = s; refresh(); }).catch((err) => App.fail(err));
      const reloadExports = () => App.get('/api/admin/exports').then((x) => { st.exports = x; watchExports(); refresh(); }).catch((err) => App.fail(err));
      const reloadUsage = () => getUsage().then((u) => { st.usage = u; refresh(); }).catch((err) => App.fail(err, 'Usage could not be loaded'));
      const loadDetail = (id) => { st.details[id] = { pending: true }; return App.get('/api/admin/audit/' + encodeURIComponent(id)).then((d) => { st.details[id] = d; refresh(); }).catch((err) => { st.details[id] = { error: err }; refresh(); }); };

      // Exports still being prepared: follow their jobs over the socket, with a polling fallback.
      function watchExports() {
        const pending = (st.exports || []).filter((x) => x.state === 'queued' || x.state === 'running');
        if (!pending.length) { stopJobs(); st.polls = 0; return; }
        if (App.socket && (jobSocket !== App.socket || !jobHandler)) {
          stopJobs();
          jobSocket = App.socket;
          jobHandler = (e) => {
            if (App.state.route !== 'usage-audit') { stopJobs(); return; }
            const x = (st.exports || []).find((r) => r.jobId === e.id); if (!x) return;
            st.progress = st.progress || {}; st.progress[e.id] = e.progress;
            if (e.state === 'succeeded' || e.state === 'failed' || e.state === 'cancelled') reloadExports();
            else { if (e.state === 'running') x.state = 'running'; if (st.tab === 'exports') refresh(); }
          };
          jobSocket.on('job.progress', jobHandler);
        }
        if (!st.pollTimer && (st.polls || 0) < 6) {
          st.polls = (st.polls || 0) + 1;
          st.pollTimer = setTimeout(() => { st.pollTimer = null; if (App.state.route === 'usage-audit') reloadExports(); else stopJobs(); }, 2000 * st.polls);
        }
      }

      // ---------- data for this render ----------
      const summary = st.summary || {};
      const events = st.events || [];
      const daily = st.daily || [];
      const exportsList = st.exports || [];
      const usageRows = (st.usage && st.usage.rows) || [];
      const verify = st.verify || (summary.lastVerification ? { status: summary.lastVerification.status, checked: summary.lastVerification.checked, brokenAt: summary.lastVerification.brokenAt, notified: summary.lastVerification.notified, ts: summary.lastVerification.ts, fromLog: true } : null);
      const broken = verify && verify.status === 'broken' ? verify : null;
      const correctedIds = {}; events.forEach((e) => { if (e.corrects) correctedIds[e.corrects] = true; });

      // ----- top row -----
      const siem = summary.siem || null;
      const siemText = !siem ? '' : !siem.enabled ? '<span class="muted">not configured</span>'
        : UI.pill(siem.state) + ' <span class="mono">' + esc(siem.url || '') + '</span>';
      const pill = st.chain === 'verifying' ? UI.pill('verifying', 'info')
        : broken ? UI.pill('broken at sequence ' + (broken.brokenAt ? broken.brokenAt.seq : '?'), 'danger')
        : verify ? UI.pill('verified', 'ok') : UI.pill('not verified yet', 'outline');
      const cp = summary.checkpoint;
      const lastGood = st.verify && st.verify.lastGoodCheckpoint;
      const chainCard = UI.panel('Audit chain', '<div class="hstack" style="justify-content:space-between;gap:8px"><b>' + esc(tenantName) + ' chain</b>' + pill + '</div>'
        + UI.kv([
          ['Last signed checkpoint', cp ? esc(when(cp.ts)) + ', sequence ' + esc(cp.seq) + (cp.store ? ', ' + esc(cp.store) + ' store' : '') : '<span class="muted">none yet</span>'],
          ['Events today', esc(fmt(summary.eventsToday))],
          ['Head', summary.head ? 'sequence ' + esc(summary.head.seq) + ' <span class="mono">' + esc(short(summary.head.hash)) + '</span>' : '<span class="muted">empty</span>'],
          ['Last verified', verify && verify.ts ? esc(when(verify.ts)) + (verify.checked != null ? ', ' + esc(fmt(verify.checked)) + ' events' : '') : verify && verify.checked != null ? esc(fmt(verify.checked)) + ' events' : '<span class="muted">never</span>'],
          ['Stream', siem ? siemText : '<span class="muted">unknown</span>']
        ], 1)
        + (broken ? UI.notice('<b>Verification failed at sequence ' + esc(broken.brokenAt ? broken.brokenAt.seq : '?') + '.</b> ' + esc(broken.brokenAt ? broken.brokenAt.reason : '')
          + (st.verify ? ' Last good checkpoint: ' + (lastGood ? 'sequence ' + esc(lastGood.seq) + ', ' + esc(when(lastGood.ts)) : 'none') + '.' : '')
          + ' Notified: ' + esc(broken.notified && broken.notified.length ? broken.notified.join(', ') : 'nobody') + '. Nothing is auto-repaired; the store keeps every row.', 'danger',
        broken.brokenAt && broken.brokenAt.id ? UI.btn('Open event', { size: 'sm', attrs: 'data-sel="' + esc(broken.brokenAt.id) + '"' }) : '') : ''),
      { actions: UI.btn('Sign checkpoint', { size: 'sm', kind: 'ghost', attrs: 'data-checkpoint title="Sign the current head now"' }) });

      const chartPanel = !canUsage ? UI.panel('Tokens per day', UI.notice('Usage needs the usage:read permission, which none of your roles grant.', 'info'))
        : UI.panel('Tokens per day, ' + tenantName + ', last ' + daily.length + ' days', st.chartTable
          ? UI.table(['Day', { label: 'Tokens', right: true }, { label: 'GPU-seconds', right: true }], daily.slice().reverse().map((d) => [esc(dayLabel(d.day)), fmt(d.tokens), fmt(d.gpuSeconds)]), { clickable: false, cls: 'bare', minWidth: '0' })
          : '<div class="ua-chart">' + chart(st, daily) + '</div><div class="muted" style="font-size:12px">Prompt and output tokens metered on the final stream chunk. The last bar is today, so far.</div>',
        { actions: UI.btn(st.chartTable ? 'View as chart' : 'View as table', { size: 'sm', kind: 'ghost', attrs: 'data-charttable' }) });

      // ----- tabs -----
      const tabItems = (canUsage ? [{ id: 'usage', label: 'Usage' }, { id: 'quotas', label: 'Quotas' }] : []).concat([{ id: 'audit', label: 'Audit log', count: events.length + (st.eventsEnd ? '' : '+') }, { id: 'exports', label: 'Exports', count: exportsList.length }]).concat(App.can('billing:read') ? [{ id: 'billing', label: 'Statements' }] : []);
      if (!canUsage && (st.tab === 'usage' || st.tab === 'quotas')) st.tab = 'audit';
      if (st.tab === 'billing' && !App.can('billing:read')) st.tab = 'audit';

      let body = '';
      if (st.loadError) body = UI.problem('Usage and audit could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-reload' }) + '</div>';
      else if (!st.loaded) body = UI.notice('Loading…', 'info');
      else if (st.tab === 'usage') {
        const segs = [{ id: 'user', label: 'Per user' }, { id: 'model', label: 'Per model' }, { id: 'workspace', label: 'Per workspace' }, { id: 'profile', label: 'Per profile' }].concat(isSysAdmin() ? [{ id: 'tenant', label: 'Per tenant' }] : []);
        const range = st.usage ? (st.usage.from === st.usage.to ? dayLabel(st.usage.from) : dayLabel(st.usage.from) + ' to ' + dayLabel(st.usage.to)) : '';
        body = '<div class="hstack wrap"><div class="eyebrow">Usage, ' + esc(range) + '</div>' + UI.seg(segs, st.by, 'data-byseg') + '<span class="right">' + UI.select(PERIODS, st.period, 'data-period aria-label="Period" style="width:150px"') + '</span></div>'
          + UI.table([BY_LABEL[st.by], { label: 'Requests', right: true }, { label: 'Prompt tok.', right: true }, { label: 'Output tok.', right: true }, { label: 'GPU-s', right: true }, 'Thinking / doing · calc'],
            usageRows.map((r, i) => ({ cells: ['<b>' + esc(r.name) + '</b>' + (st.by === 'model' || !r.key ? '' : ' <span class="mono muted" style="font-size:11px">' + esc(short(r.key)) + '</span>'), fmt(r.requests), fmt(r.prompt), fmt(r.output), fmt(Math.round(r.gpuMs / 1000)), '<span class="num">' + esc(mix(r)) + '</span>'], attrs: 'data-usage="' + i + '"', selected: st.inspect === 'usage' && st.usageBy === st.by && st.usageSel === i })),
            { minWidth: '640px', emptyTitle: 'No usage in this period', emptyText: 'Usage is recorded when a model answers. Pick a longer period.' })
          + '<div class="muted" style="font-size:12px">Thinking and doing split the output tokens between reasoning and answer text; calc counts calculator and tool calls.</div>';
      } else if (st.tab === 'quotas') {
        const q = st.quotas || { workspaces: [] };
        const meters = (v) => {
          const m = (label, used, max, unit) => UI.meter(label, max == null ? fmt(used) + unit + ', no limit' : fmt(used) + ' of ' + fmt(max) + unit, max ? (used / max) * 100 : 0, max != null && used >= max * 0.9 ? 'danger' : max != null && used >= max * 0.6 ? 'warn' : '');
          return m('Tokens today', v.used.tokensToday, v.tokensPerDay, '') + m('GPU-seconds, month', v.used.gpuSecondsMonth, v.gpuSecondsPerMonth, '') + m('Training GPU-hours, month', v.used.trainingGpuHoursMonth, v.trainingGpuHoursPerMonth, '');
        };
        const hit = (v) => (v.tokensPerDay != null && v.used.tokensToday >= v.tokensPerDay ? 'token' : v.gpuSecondsPerMonth != null && v.used.gpuSecondsMonth >= v.gpuSecondsPerMonth ? 'GPU-second' : null);
        const hits = [];
        if (q.tenant && hit(q.tenant)) hits.push({ name: tenantName + ' tenant', what: hit(q.tenant), v: q.tenant, raise: 'A system admin', tenant: true });
        q.workspaces.forEach((w) => { if (hit(w)) hits.push({ name: w.name, what: hit(w), v: w, raise: 'A tenant admin', id: w.id }); });
        const editBtn = (w) => (w.tenant ? (isSysAdmin() ? UI.btn('Edit limits', { size: 'sm', kind: 'ghost', attrs: 'data-editquota=""' }) : '') : App.can('tenant:manage') ? UI.btn('Edit limits', { size: 'sm', kind: 'ghost', attrs: 'data-editquota="' + esc(w.id) + '"' }) : '');
        body = '<div class="eyebrow">Quotas, ' + esc(tenantName) + ' and its workspaces</div>'
          + hits.map((h) => UI.notice('<b>' + esc(h.name) + ' reached its ' + h.what + ' quota.</b> Requests return 429 with Retry-After until ' + esc(when(h.what === 'token' ? h.v.resets.daily : h.v.resets.monthly)) + '. ' + h.raise + ' can raise the limit.', 'warn', editBtn(h))).join('')
          + '<div class="grid2">'
          + (q.tenant ? UI.panel(tenantName + ' tenant, total', meters(q.tenant) + '<div class="muted" style="font-size:12px">Caps every workspace below. Raised by: a system admin. Daily reset ' + esc(when(q.tenant.resets.daily)) + ', monthly ' + esc(when(q.tenant.resets.monthly)) + '.</div>', { actions: editBtn({ tenant: true }) }) : '')
          + q.workspaces.map((w) => UI.panel(w.name, meters(w) + '<div class="hstack gap6">' + UI.label(w.label, { sm: true }) + '<span class="muted" style="font-size:12px">Raised by: a tenant admin. Over quota returns 429 with a reset time.</span></div>', { actions: editBtn(w) })).join('')
          + '</div>' + (q.workspaces.length ? '' : UI.empty('No workspaces', 'Workspace quotas appear once a tenant admin creates a workspace.'));
      } else if (st.tab === 'audit') {
        body = '<div class="hstack wrap"><div class="eyebrow">Audit events</div>' + UI.search('Action prefix, or @user for an actor', 'data-q', st.q) + '<span class="hstack gap6 wrap">' + KINDS.map((k) => UI.chip(k[1], st.kind === k[0], 'data-kind="' + k[0] + '"')).join('') + '</span></div>'
          + (st.kind === 'correction' ? UI.notice('<b>Corrections.</b> Each row here corrects an earlier row. The original is unchanged and its hash still chains; readers see both.', 'info') : '')
          + UI.table(['Time', 'Actor', 'Action', 'Target', 'Label', 'Hash', ''], events.map((e) => {
            const isBreak = broken && broken.brokenAt && broken.brokenAt.id === e.id;
            return {
              cells: ['<span class="mono ua-nowrap" title="' + esc(whenFull(e.ts)) + '">' + esc(whenRow(e.ts)) + '</span>', e.redacted ? '<span class="muted">withheld</span>' : esc(actorName(e.actor)), '<span class="mono">' + esc(e.action) + '</span>',
                e.corrects ? 'corrects <a href="#" data-sel="' + esc(e.corrects) + '" class="mono">' + esc(e.target && e.target.seq ? 'sequence ' + e.target.seq : short(e.corrects)) + '</a>' : e.redacted ? '<span class="muted">withheld</span>' : '<span class="ua-clip">' + esc(oneLine(e.target)) + '</span>',
                UI.label(e.label, { sm: true }),
                '<span class="mono" style="' + (isBreak ? 'color:var(--danger-fg);font-weight:600' : '') + '">' + esc(e.seq) + ' ' + esc(String(e.hash).slice(0, 8)) + '</span>' + (isBreak ? ' ' + UI.pill('break', 'danger') : '') + (correctedIds[e.id] ? ' ' + UI.pill('corrected', 'outline') : ''),
                UI.btn('JSON', { size: 'xs', kind: 'ghost', attrs: 'data-json="' + esc(e.id) + '"' })],
              attrs: 'data-sel="' + esc(e.id) + '"', selected: st.inspect !== 'usage' && st.sel === e.id
            };
          }), { minWidth: '760px', emptyTitle: 'No events match', emptyText: 'Clear the search or pick another kind.' })
          + (st.eventsEnd ? '' : '<div>' + UI.btn(st.olderBusy ? 'Loading…' : 'Load older', { size: 'sm', attrs: 'data-older' + (st.olderBusy ? ' disabled' : '') }) + '</div>')
          + '<div class="muted" style="font-size:12px">Append-only. Each hash covers the previous row. Corrections are new rows; nothing is edited or deleted. Rows above your ' + esc(clearance) + ' clearance keep their place in the chain but their content is withheld.</div>';
      } else if (st.tab === 'billing') {
        billingLoad(st, refresh);
        body = billingHtml(st, refresh);
      } else {
        const rows = exportsList.map((x) => {
          const prog = (x.state === 'queued' || x.state === 'running') && st.progress && x.jobId && st.progress[x.jobId] != null ? ' ' + st.progress[x.jobId] + '%' : '';
          return ['<span class="mono">' + esc(x.file) + '</span>', esc(x.scope), x.rows == null ? '<span class="muted">-</span>' : fmt(x.rows) + (x.omitted ? ' <span class="muted">(' + fmt(x.omitted) + ' omitted)</span>' : ''), esc(x.createdByName || '') + '<div class="muted" style="font-size:12px">' + esc(when(x.createdAt)) + '</div>', UI.pill(x.state + prog, x.state === 'queued' || x.state === 'running' ? 'info' : ''), x.state === 'ready' ? UI.btn('Download', { size: 'xs', kind: 'ghost', icon: 'download', attrs: 'data-dl="' + esc(x.id) + '"' }) : ''];
        });
        if (siem) rows.push(['<span class="mono">SIEM stream</span>', siem.enabled ? 'Every audit event, continuous, to ' + esc(siem.url || 'the configured endpoint') : 'Not configured. Set SIEM_URL on the server to stream audit events.', siem.enabled ? fmt(siem.delivered) + ' sent' + (siem.pending ? ', ' + fmt(siem.pending) + ' pending' : '') + (siem.dropped ? ', ' + fmt(siem.dropped) + ' dropped' : '') : '<span class="muted">-</span>', 'platform' + (siem.lastDeliveredAt ? '<div class="muted" style="font-size:12px">last ' + esc(when(siem.lastDeliveredAt)) + '</div>' : ''), UI.pill(siem.state) + (siem.lastError ? '<div class="muted" style="font-size:12px">' + esc(siem.lastError) + '</div>' : ''), '']);
        body = '<div class="hstack"><div class="eyebrow">Exports</div><span class="right hstack gap6">' + UI.btn('Refresh', { size: 'sm', kind: 'ghost', icon: 'refresh', attrs: 'data-xrefresh' }) + UI.btn('New export', { size: 'sm', icon: 'download', attrs: 'data-export' }) + '</span></div>'
          + UI.table(['File', 'Scope', { label: 'Rows', right: true }, 'Requested by', 'State', ''], rows, { clickable: false, minWidth: '640px', emptyTitle: 'No exports yet', emptyText: 'Exports you and other admins request appear here.' })
          + UI.notice('Audit exports hold rows up to your clearance, <b>' + esc(clearance) + '</b>. A selection with rows above it is blocked unless you choose a filtered export. Every download is written to the audit chain.', 'info');
      }

      // ----- inspector -----
      let insp = '';
      const ur = st.inspect === 'usage' && st.usageBy === st.by ? usageRows[st.usageSel] : null;
      if (ur) {
        insp = '<div class="eyebrow">' + esc(BY_LABEL[st.by]) + '</div><div style="font-size:15px;font-weight:600;overflow-wrap:anywhere">' + esc(ur.name) + '</div>'
          + UI.kv([['Requests', fmt(ur.requests)], ['Prompt tokens', fmt(ur.prompt)], ['Output tokens', fmt(ur.output)], ['Thinking tokens', fmt(ur.thinking)], ['Calc calls', fmt(ur.calc)], ['GPU-seconds', fmt(Math.round(ur.gpuMs / 1000))], ['Thinking / doing · calc', esc(mix(ur))], ['Period', esc(st.usage.from + ' to ' + st.usage.to)]], 2)
          + '<div class="vstack gap6">' + (st.by === 'user' && ur.key ? UI.btn('Show their audit events', { size: 'sm', attrs: 'data-actor="' + esc(ur.key) + '"' }) : '')
          + (st.by === 'workspace' && ur.key && App.can('tenant:manage') ? UI.btn('Open workspace', { size: 'sm', attrs: 'data-openws="' + esc(ur.key) + '"' }) : '') + '</div>';
      } else if (st.sel) {
        const d = st.details[st.sel];
        const e = d && !d.error && !d.pending ? d : events.find((x) => x.id === st.sel);
        if (!d) loadDetail(st.sel);
        if (d && d.error) insp = UI.problem('Event could not be loaded', d.error.message, d.error.problem && d.error.problem.trace_id);
        else if (!e) insp = UI.notice('Loading event…', 'info');
        else {
          const isBreak = broken && broken.brokenAt && broken.brokenAt.id === e.id;
          const canCorrect = !e.redacted && e.kind !== 'correction' && ((e.actor && e.actor.user === App.me.user.id) || App.can('tenant:manage'));
          const corr = e.kind === 'correction' && e.detail ? e.detail : null;
          insp = '<div class="eyebrow">Event, sequence ' + esc(e.seq) + '</div>'
            + (e.redacted ? UI.notice('Above your ' + esc(clearance) + ' clearance: the actor, target and detail are withheld. Its place in the chain still verifies.', 'warn') : '')
            + UI.kv([['Time', esc(whenFull(e.ts))], ['Action', '<span class="mono">' + esc(e.action) + '</span>'], ['Kind', esc(e.kind)]]
              .concat(e.redacted ? [] : [['Actor', esc(actorName(e.actor)) + (e.actor && e.actor.username && e.actor.name ? ' <span class="mono muted">' + esc(e.actor.username) + '</span>' : '')], ['Target', '<span class="ua-wrap">' + esc(oneLine(e.target) || '-') + '</span>']])
              .concat([['Label', UI.label(e.label, { sm: true })]])
              .concat(!e.redacted && e.decision ? [['Decision', '<span class="ua-wrap">' + esc(oneLine(e.decision)) + '</span>']] : [])
              .concat(corr ? [['Reason', esc(corr.reason || '')], ['Corrected fields', '<span class="ua-wrap mono">' + esc(JSON.stringify(corr.correction || {})) + '</span>']] : [])
              .concat([['Hash', '<span class="mono ua-wrap">' + esc(e.hash) + '</span>'], ['Previous hash', '<span class="mono ua-wrap">' + esc(e.prev_hash) + '</span>']])
              .concat(e.trace_id ? [['Trace', '<span class="mono">' + esc(String(e.trace_id).slice(0, 16)) + '</span> ' + UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-uacopy="' + esc(e.trace_id) + '"' })]] : [])
              .concat(e.corrects ? [['Corrects', '<a href="#" data-sel="' + esc(e.corrects) + '" class="mono">' + esc(e.target && e.target.seq ? 'sequence ' + e.target.seq : short(e.corrects)) + '</a>']] : [])
              .concat(d && d.correctedBy && d.correctedBy.length ? [['Corrected by', d.correctedBy.map((c) => '<a href="#" data-sel="' + esc(c.id) + '" class="mono">sequence ' + esc(c.seq) + '</a> <span class="muted">' + esc(when(c.ts)) + '</span>').join('<br>')]] : []), 1)
            + (isBreak ? UI.notice('Verification stopped at this row: ' + esc(broken.brokenAt.reason) + '.', 'danger') : '')
            + '<div class="vstack gap6">' + UI.btn('Open full event', { size: 'sm', icon: 'eye', attrs: 'data-json="' + esc(e.id) + '"' })
            + (canCorrect ? UI.btn('Correct this event', { size: 'sm', icon: 'edit', attrs: 'data-correct="' + esc(e.id) + '"' }) : '')
            + (!e.redacted && e.actor && e.actor.user ? UI.btn('Show events by this actor', { size: 'sm', kind: 'ghost', attrs: 'data-actor="' + esc(e.actor.username || e.actor.user) + '"' }) : '') + '</div>';
        }
      } else insp = '<div class="eyebrow">Inspector</div><div class="muted" style="font-size:13px">Select an audit event or a usage row to see it here.</div>';
      if (canUsage && st.quotas) {
        const wsId = App.DATA.tenant && App.DATA.tenant.workspaceId;
        const w = st.quotas.workspaces.find((x) => x.id === wsId) || null;
        const v = w || st.quotas.tenant;
        if (v) {
          const m = (label, used, max) => UI.meter(label, max == null ? fmt(used) + ', no limit' : fmt(used) + ' of ' + fmt(max), max ? (used / max) * 100 : 0, max != null && used >= max * 0.9 ? 'warn' : '');
          insp += '<div class="divider"></div><div class="eyebrow">Quota, ' + esc(w ? w.name : tenantName + ' tenant') + '</div>' + m('Tokens today', v.used.tokensToday, v.tokensPerDay) + m('GPU-seconds this month', v.used.gpuSecondsMonth, v.gpuSecondsPerMonth) + m('Training GPU-hours', v.used.trainingGpuHoursMonth, v.trainingGpuHoursPerMonth);
        }
      }

      root.innerHTML = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}'
        + '.ua-chart svg .ua-bar{cursor:pointer}.ua-chart svg .ua-bar:hover path,.ua-chart svg .ua-bar:focus path{fill:var(--accent)}.ua-chart svg .ua-bar:focus{outline:none}'
        + '.ua-top{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px}@media (max-width:1100px){.ua-top{grid-template-columns:1fr}}'
        + '.ua-clip{display:inline-block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}.ua-wrap{overflow-wrap:anywhere}.ua-nowrap{white-space:nowrap}'
        + '</style>'
        + '<div class="page">' + UI.pagehead('Usage and audit', 'Metering per tenant, user, model and workspace; a hash-chained audit log for ' + esc(tenantName), UI.btn('Refresh', { kind: 'ghost', icon: 'refresh', attrs: 'data-reload' }) + UI.btn('Export CSV', { icon: 'download', attrs: 'data-export' }) + UI.btn(st.chain === 'verifying' ? 'Verifying…' : 'Verify chain', { kind: 'primary', attrs: 'data-verify' + (st.chain === 'verifying' ? ' disabled' : '') }))
        + (st.loaded ? '<div class="ua-top">' + chartPanel + chainCard + '</div>' : '')
        + UI.tabs(tabItems, st.tab) + body
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
        + '<aside class="inspector w300">' + insp + '</aside>';

      // ----- actions -----
      function runVerify() {
        const head = summary.head;
        ctx.confirm({ title: 'Verify the ' + tenantName + ' chain', tag: 'read only', tone: 'info', body: '<p style="margin:0" class="fg2">Recomputes every hash from the first event to the head and checks each signed checkpoint. Nothing is changed. If the chain is broken, tenant admins and auditors are notified.</p>',
          kv: [['Events in the chain', head ? fmt(head.seq) : '0'], ['Last checkpoint', cp ? 'sequence ' + esc(cp.seq) + ', ' + esc(when(cp.ts)) : 'none yet']], ok: 'Verify' }).then(async (ok) => {
          if (!ok) return;
          st.chain = 'verifying'; ctx.rerender();
          try {
            const r = await App.post('/api/admin/audit/verify');
            st.verify = Object.assign({ ts: Date.now() }, r);
            if (r.status === 'broken') { st.tab = 'audit'; if (r.brokenAt && r.brokenAt.id) { st.sel = r.brokenAt.id; st.inspect = 'event'; } ctx.toast('<b>Verification failed</b> at sequence ' + esc(r.brokenAt ? r.brokenAt.seq : '?') + '. ' + esc(r.notified.length ? 'Notified ' + r.notified.join(', ') + '.' : ''), 'danger', 8000); }
            else ctx.toast(esc(tenantName) + ' chain verified: ' + esc(fmt(r.checked)) + ' events, ' + esc(fmt(r.checkpoints.checked)) + ' checkpoints, head ' + esc(short(r.head)) + '.', 'ok', 6000);
          } catch (err) { App.fail(err, 'Verification did not run'); }
          st.chain = null; reloadSummary(); reloadEvents();
        });
      }
      function signCheckpoint() {
        const head = summary.head;
        ctx.confirm({ title: 'Sign a checkpoint now', tag: 'write-once', tone: 'info', body: '<p style="margin:0" class="fg2">Signs the current head with the tenant key and stores it in the write-once store. Later verification checks the chain against it.</p>', kv: [['Head', head ? 'sequence ' + esc(head.seq) : 'empty'], ['Previous checkpoint', cp ? 'sequence ' + esc(cp.seq) : 'none']], ok: 'Sign checkpoint' }).then(async (ok) => {
          if (!ok) return;
          try {
            const r = await App.post('/api/admin/audit/checkpoints');
            if (r.skipped) ctx.toast(esc(r.skipped), 'warn'); else ctx.toast('Checkpoint signed at sequence ' + esc(r.seq) + '. Audit entry written.', 'ok');
            reloadSummary(); reloadEvents();
          } catch (err) { App.fail(err, 'Checkpoint not signed'); }
        });
      }
      const dateToMs = (v, end) => { if (!v) return undefined; const t = new Date(v + 'T00:00:00').getTime(); return end ? t + 86400000 : t; };
      function exportModal(content) {
        const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const today = new Date(), monthAgo = new Date(Date.now() - 29 * 86400000);
        const contents = [{ value: 'audit', label: 'Audit events' }].concat(canUsage ? [{ value: 'usage', label: 'Usage per day, user and model' }] : []);
        const wsOpts = [{ value: '', label: 'All workspaces' }].concat(((st.quotas && st.quotas.workspaces) || []).map((w) => ({ value: w.id, label: w.name })));
        ctx.modal({
          title: 'Export CSV', onClose,
          body: '<div class="formgrid">' + UI.field('Content', UI.select(contents, content || (canUsage && (st.tab === 'usage' || st.tab === 'quotas') ? 'usage' : 'audit'), 'data-xcontent'))
            + '<div data-xaudit>' + UI.field('Kind', UI.select([{ value: '', label: 'All kinds' }].concat(KINDS.slice(1).map((k) => ({ value: k[0], label: k[1] }))), st.kind === 'all' ? '' : st.kind, 'data-xkind')) + '</div>'
            + '<div data-xusage>' + UI.field('Scope', UI.select(wsOpts, '', 'data-xws')) + '</div>'
            + UI.field('From', UI.input(iso(monthAgo), { type: 'date', attrs: 'data-xfrom' })) + UI.field('To', UI.input(iso(today), { type: 'date', attrs: 'data-xto' })) + '</div>'
            + '<div data-xmsg>' + UI.notice('Audit exports include rows up to your ' + esc(clearance) + ' clearance. Leave a date empty for no bound. The request is written to the audit chain.', 'info') + '</div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Export', { kind: 'primary', attrs: 'data-xgo' }) + UI.btn('Export ' + clearance + ' and below', { kind: 'primary', attrs: 'data-xfiltered style="display:none"' }),
          onMount(m) {
            const $m = (s) => m.querySelector(s);
            const show = (s, on) => { $m(s).style.display = on ? '' : 'none'; };
            const sync = () => { const a = $m('[data-xcontent]').value === 'audit'; show('[data-xaudit]', a); show('[data-xusage]', !a); show('[data-xfiltered]', false); show('[data-xgo]', true); };
            $m('[data-xcontent]').addEventListener('change', sync); sync();
            const done = (x, extra) => {
              App.closeOverlay(); st.dirty = false; st.tab = 'exports'; st.polls = 0;
              ctx.toast('Export queued: ' + esc(x.scope) + '.' + (extra || '') + ' It appears under Exports when it is ready.', 'ok', 6000);
              reloadExports(); reloadEvents(); ctx.rerender();
            };
            const send = async (filtered) => {
              const from = $m('[data-xfrom]').value, to = $m('[data-xto]').value;
              try {
                if ($m('[data-xcontent]').value === 'usage') {
                  const b = {}; if (from) b.from = +from.replace(/-/g, ''); if (to) b.to = +to.replace(/-/g, ''); if ($m('[data-xws]').value) b.workspaceId = $m('[data-xws]').value;
                  done(await App.post('/api/admin/usage/exports', b));
                } else {
                  const b = { filtered: !!filtered }; if ($m('[data-xkind]').value) b.kind = $m('[data-xkind]').value; if (from) b.from = dateToMs(from); if (to) b.to = dateToMs(to, true);
                  const x = await App.post('/api/admin/audit/exports', b);
                  done(x, x.omitted ? ' ' + fmt(x.omitted) + ' events above your clearance were left out.' : '');
                }
              } catch (err) {
                const p = err.problem || {};
                if (err.status === 403 && p.title === 'Export blocked') {
                  $m('[data-xmsg]').innerHTML = UI.notice('<b>Export blocked.</b> The selection includes ' + esc(fmt(p.above)) + ' of ' + esc(fmt(p.total)) + ' events above your ' + esc(p.clearance) + ' clearance. You can export ' + esc(p.clearance) + ' and below, or ask someone cleared for them. The refusal is written to the audit chain.', 'warn');
                  show('[data-xgo]', false); show('[data-xfiltered]', true); const f = $m('[data-xfiltered]'); f.textContent = 'Export ' + p.clearance + ' and below'; f.focus();
                } else $m('[data-xmsg]').innerHTML = UI.notice('<b>' + esc(p.title || 'Export not queued') + '.</b> ' + esc(p.detail || err.message), 'danger');
              }
            };
            $m('[data-xgo]').addEventListener('click', () => send(false));
            $m('[data-xfiltered]').addEventListener('click', () => send(true));
          }
        });
      }
      function jsonDrawer(id) {
        const show = (e) => {
          const text = JSON.stringify(e, null, 2);
          ctx.drawer({ title: 'Event, sequence ' + esc(e.seq) + ' ' + UI.label(e.label, { sm: true }), onClose,
            body: '<div class="fg2" style="font-size:12px">Stored row from audit_events. The hash covers every field below except correctedBy, including prev_hash.</div>' + (e.redacted ? UI.notice('Content withheld: this row is above your ' + esc(clearance) + ' clearance.', 'warn') : '') + UI.code(text, 'json'),
            actions: UI.btn('Copy JSON', { attrs: 'data-cjson' }) + (e.trace_id ? UI.btn('Copy trace ID', { kind: 'ghost', attrs: 'data-ctrace' }) : '') + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
            onMount(d) {
              d.querySelector('[data-cjson]').addEventListener('click', () => copy(text, 'Event JSON'));
              const t = d.querySelector('[data-ctrace]'); if (t) t.addEventListener('click', () => copy(e.trace_id, 'Trace ID'));
            } });
        };
        App.get('/api/admin/audit/' + encodeURIComponent(id)).then((e) => { st.details[id] = e; show(e); }).catch((err) => App.fail(err, 'Event could not be loaded'));
      }
      function copy(text, what) {
        const ok = () => ctx.toast(esc(what) + ' copied.');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, () => ctx.toast('The browser refused clipboard access.', 'warn'));
        else ctx.toast('The browser refused clipboard access.', 'warn');
      }
      function correctModal(id) {
        const e = st.details[id] && !st.details[id].error && !st.details[id].pending ? st.details[id] : events.find((x) => x.id === id);
        if (!e) return;
        ctx.modal({ title: 'Correct event, sequence ' + esc(e.seq), onClose,
          body: UI.notice('A correction is a new row that references this one. The original is never edited and its hash still chains.', 'info')
            + UI.kv([['Action', '<span class="mono">' + esc(e.action) + '</span>'], ['Time', esc(whenFull(e.ts))], ['Target', '<span class="ua-wrap">' + esc(oneLine(e.target) || '-') + '</span>'], ['Label', UI.label(e.label, { sm: true })]], 2)
            + UI.field('Reason', UI.input('', { attrs: 'data-creason maxlength="500"', placeholder: 'for example Rule version recorded as 3; the saved version is 4' }), 'At least 5 characters. Shown to everyone who reads the log.')
            + UI.field('Corrected fields (JSON)', UI.textarea('{\n  "target": ' + JSON.stringify(e.target || {}) + '\n}', { attrs: 'data-cjson spellcheck="false" style="font-family:var(--mono);font-size:12px"', rows: 6 }), 'A JSON object with the fields as they should read.')
            + '<div data-cerr></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Append correction', { kind: 'primary', attrs: 'data-csave' }),
          onMount(m) {
            m.querySelector('[data-csave]').addEventListener('click', async () => {
              const errBox = m.querySelector('[data-cerr]'); errBox.innerHTML = '';
              const reason = m.querySelector('[data-creason]').value.trim();
              if (reason.length < 5) { errBox.innerHTML = UI.notice('Give a reason of at least 5 characters.', 'danger'); return; }
              let correction; try { correction = JSON.parse(m.querySelector('[data-cjson]').value || '{}'); } catch (x) { errBox.innerHTML = UI.notice('The corrected fields are not valid JSON: ' + esc(x.message), 'danger'); return; }
              if (!correction || typeof correction !== 'object' || Array.isArray(correction)) { errBox.innerHTML = UI.notice('The corrected fields must be a JSON object.', 'danger'); return; }
              try {
                const row = await App.post('/api/admin/audit/' + encodeURIComponent(e.id) + '/corrections', { reason, correction });
                App.closeOverlay(); st.dirty = false;
                delete st.details[e.id]; st.sel = e.id; st.inspect = 'event';
                ctx.toast('Correction appended at sequence ' + esc(row.seq) + '. The original row is unchanged.', 'ok', 6000);
                ctx.rerender(); reloadEvents(); reloadSummary();
              } catch (err) { const p = err.problem || {}; errBox.innerHTML = UI.notice('<b>' + esc(p.title || 'Not saved') + '.</b> ' + esc(p.detail || err.message), 'danger'); }
            });
          } });
      }
      async function download(id) {
        const x = exportsList.find((r) => r.id === id); if (!x) return;
        try {
          const res = await fetch('/api/admin/exports/' + encodeURIComponent(id) + '/download', { credentials: 'same-origin' });
          if (!res.ok) { let p = null; try { p = await res.json(); } catch (e2) { /* not JSON */ } throw new App.ApiError(p || { status: res.status, title: res.statusText }); }
          const url = URL.createObjectURL(await res.blob());
          const a = document.createElement('a'); a.href = url; a.download = x.file; a.style.display = 'none';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          ctx.toast('Downloaded ' + esc(x.file) + '. The download is written to the audit chain.', 'ok');
          reloadSummary(); reloadEvents();
        } catch (err) { App.fail(err, 'Download failed'); }
      }
      const selectEvent = (id) => { st.sel = id; st.inspect = 'event'; if (st.tab !== 'audit') st.tab = 'audit'; delete st.details[id]; ctx.rerender(); };
      const filterActor = (who) => { st.tab = 'audit'; st.kind = 'all'; st.q = '@' + who; st.inspect = 'event'; ctx.rerender(); reloadEvents(); };

      // ----- deferred actions from commands and states -----
      if (st.loaded) {
        if (st.runVerify) { st.runVerify = false; setTimeout(runVerify, 50); }
        if (st.openExport) { const c = st.openExport; st.openExport = null; setTimeout(() => exportModal(c), 50); }
        if (st.events === null) { st.events = []; reloadEvents(); }
      }

      // ----- handlers -----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-reload]', () => { st.details = {}; reload(); });
      ctx.on('click', '[data-byseg] [data-seg]', (e, t) => { if (st.by === t.dataset.seg) return; st.by = t.dataset.seg; st.inspect = 'event'; reloadUsage(); });
      ctx.on('change', '[data-period]', (e, t) => { st.period = t.value; st.inspect = 'event'; reloadUsage(); });
      ctx.on('click', '[data-charttable]', () => { st.chartTable = !st.chartTable; st.hover = null; ctx.rerender(); });
      ctx.on('mouseover', '.ua-bar', (e, t) => { const i = +t.dataset.bar; if (st.hover !== i) { st.hover = i; ctx.rerender(); } });
      ctx.on('mouseout', '.ua-chart', (e, t) => { if (st.hover != null && !(e.relatedTarget && t.contains(e.relatedTarget))) { st.hover = null; ctx.rerender(); } });
      ctx.on('focusin', '.ua-bar', (e, t) => { const i = +t.dataset.bar; if (st.hover !== i) { st.hover = i; ctx.rerender(); const b = ctx.$('.ua-bar[data-bar="' + i + '"]'); if (b) b.focus(); } });
      ctx.on('click', 'tr[data-usage]', (e, t) => { st.inspect = 'usage'; st.usageSel = +t.dataset.usage; st.usageBy = st.by; ctx.rerender(); });
      ctx.on('click', '[data-sel]', (e, t) => { e.preventDefault(); e.stopPropagation(); if (e.target.closest('[data-json]')) return; if (e.target.closest('a[data-sel]') && e.target.closest('a[data-sel]') !== t) return; selectEvent(t.dataset.sel); });
      ctx.on('click', '[data-json]', (e, t) => { e.stopPropagation(); st.sel = t.dataset.json; st.inspect = 'event'; jsonDrawer(t.dataset.json); });
      let qTimer = null;
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; clearTimeout(qTimer); qTimer = setTimeout(reloadEvents, 400); });
      ctx.on('keydown', '[data-q]', (e, t) => { if (e.key === 'Enter') { clearTimeout(qTimer); st.q = t.value; reloadEvents(); } });
      ctx.on('click', '[data-kind]', (e, t) => { st.kind = t.dataset.kind; ctx.rerender(); reloadEvents(); });
      ctx.on('click', '[data-older]', () => {
        const last = events[events.length - 1]; if (!last) return;
        st.olderBusy = true; ctx.rerender();
        getEvents(last.seq).then((more) => { st.events = events.concat(more); st.eventsEnd = more.length < 100; }).catch((err) => App.fail(err, 'Older events could not be loaded')).finally(() => { st.olderBusy = false; refresh(); });
      });
      ctx.on('click', '[data-actor]', (e, t) => filterActor(t.dataset.actor));
      ctx.on('click', '[data-correct]', (e, t) => correctModal(t.dataset.correct));
      ctx.on('click', '[data-uacopy]', (e, t) => copy(t.dataset.uacopy, 'Trace ID'));
      ctx.on('click', '[data-verify]', () => runVerify());
      ctx.on('click', '[data-checkpoint]', () => signCheckpoint());
      ctx.on('click', '[data-export]', () => exportModal());
      ctx.on('click', '[data-xrefresh]', () => { st.polls = 0; reloadExports(); });
      ctx.on('click', '[data-dl]', (e, t) => download(t.dataset.dl));
      ctx.on('click', '[data-openws]', (e, t) => ctx.navigate('tenants', { workspace: t.dataset.openws }));
      ctx.on('click', '[data-editquota]', (e, t) => (t.dataset.editquota ? ctx.navigate('tenants', { workspace: t.dataset.editquota, tab: 'quotas' }) : ctx.navigate('tenants', { tab: 'quotas' })));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      billingWire(st, ctx, refresh);
    }
  });
})();
