// Workflows, Sprint 46 (Automation): the webhook trigger panel of the trigger step's inspector (B-130,
// /api/workflows/:id/hook) and the Retention tab (B-135, /api/workflows/:id/retention, /api/workflow-retention).
// `workflows.js` calls App.wfHookPanel(ctx, wf, deps) for the inspector markup, App.wfRetentionTab(ctx, wf, deps) for
// the tab, and App.wfOpsBind(ctx, wf, deps) once per render for their handlers; the state lives in
// ctx.state.hooks[wf.id] and ctx.state.retention[wf.id]. deps.later() re-renders when a fetch lands.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');
  const CSS = '.wfops-url{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere;word-break:break-all}.wfops-sub{font-size:12px;color:var(--muted)}.wfops-secret{font-family:var(--mono);font-size:13px;overflow-wrap:anywhere;word-break:break-all;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2)}';
  const problem = (m, err) => { const p = err.problem || {}; const at = m.querySelector('[data-wfops-err]'); if (at) at.innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc((p.detail) || err.message), 'danger'); };

  function loadHook(ctx, wf, deps) {
    const st = ctx.state; st.hooks = st.hooks || {};
    st.hooks[wf.id] = Object.assign({}, st.hooks[wf.id], { loading: true });
    App.get('/api/workflows/' + enc(wf.id) + '/hook')
      .then((d) => { st.hooks[wf.id] = { data: d, at: Date.now() }; deps.later(); })
      .catch((err) => { st.hooks[wf.id] = { error: err }; deps.later(); });
  }
  function loadRetention(ctx, wf, deps) {
    const st = ctx.state; st.retention = st.retention || {};
    st.retention[wf.id] = Object.assign({}, st.retention[wf.id], { loading: true });
    Promise.all([App.get('/api/workflows/' + enc(wf.id) + '/retention'), App.get('/api/workflow-retention')])
      .then((r) => { st.retention[wf.id] = { wf: r[0], tenant: r[1], at: Date.now() }; deps.later(); })
      .catch((err) => { st.retention[wf.id] = { error: err }; deps.later(); });
  }

  /** The inspector panel of a trigger step whose source is webhook. */
  App.wfHookPanel = function (ctx, wf, deps) {
    let html = '<style>' + CSS + '</style><div class="eyebrow">Webhook</div>';
    if (!App.can('workflows:manage')) return html + '<div class="wfops-sub">A signed POST starts the published version. A workflow admin makes its secret and turns it on.</div>';
    const st = ctx.state; st.hooks = st.hooks || {};
    const h = st.hooks[wf.id];
    if (!h) { loadHook(ctx, wf, deps); return html + UI.notice('Loading the webhook…', 'info'); }
    if (h.loading && !h.data) return html + UI.notice('Loading the webhook…', 'info');
    if (h.error) return html + UI.problem('The webhook could not be loaded', h.error.message, h.error.problem && h.error.problem.trace_id);
    const d = h.data;
    const state = d.live ? UI.pill('on, taking requests', 'ok') : d.enabled ? UI.pill('on, not live', 'warn') : UI.pill('off', 'outline');
    html += (d.trigger.published !== 'webhook' ? UI.notice(d.trigger.published ? 'The published version starts from a ' + esc(d.trigger.published) + ' trigger. Publish this draft for the webhook to start runs.' : 'Publish the workflow for the webhook to start runs.', 'warn') : '')
      + UI.kv([
        ['State', state],
        ['URL', '<span class="wfops-url" data-wfhook-url>' + esc(d.url) + '</span>'],
        ['Secret', d.secretSet ? 'made ' + esc(when(d.secretSetAt)) : 'not made yet'],
        ['Runs as', d.owner ? esc(d.ownerName || d.owner) + ', checked again on every request' : 'whoever turns it on'],
        ['Received', esc(String(d.received)) + ' accepted, ' + esc(String(d.refused)) + ' refused'],
        ['Last received', esc(when(d.lastReceivedAt))]
      ], 1)
      + '<div class="hstack wrap gap6" role="group" aria-label="Webhook actions">'
      + UI.btn(d.enabled ? 'Turn off' : 'Enable', { size: 'sm', kind: d.enabled ? '' : 'primary', attrs: 'data-wfhook-toggle', disabled: !d.enabled && !d.secretSet, title: !d.enabled && !d.secretSet ? 'Make the secret first' : '' })
      + UI.btn(d.secretSet ? 'Rotate secret' : 'Make secret', { size: 'sm', icon: 'key', attrs: 'data-wfhook-rotate' })
      + UI.btn('Copy URL', { size: 'sm', kind: 'ghost', icon: 'copy', attrs: 'data-wfhook-copy' })
      + '</div>'
      + '<details class="vstack gap6"><summary style="cursor:pointer;font-size:13px">How to sign a request</summary>'
      + '<div class="wfops-sub">POST a JSON object, at most ' + Math.round(d.maxBytes / 1024) + ' KB, with <span class="mono">Content-Type: application/json</span>, <span class="mono">' + esc(d.timestamp) + '</span> and <span class="mono">' + esc(d.signature) + '</span>. Each signature is accepted once; at most ' + esc(String(d.ratePerMinute)) + ' requests a minute. The object passes the content rules, must match the trigger\'s output schema and becomes the run input, at the workflow\'s label.</div>'
      + UI.code(d.example, 'sh')
      + '</details>'
      + '<div class="eyebrow">Recent deliveries</div>'
      + (d.deliveries.length
        ? UI.table(['When', 'Result', 'Detail'], d.deliveries.slice(0, 8).map((x) => [esc(when(x.at)), UI.pill(x.outcome === 'accepted' ? 'accepted' : 'refused ' + x.status, x.outcome === 'accepted' ? 'ok' : 'danger'), x.runId ? '<a href="#" data-openrun="' + esc(x.runId) + '" class="mono">run ' + esc(x.runId.slice(-4).toLowerCase()) + '</a>' : esc(x.reason || '')]), { clickable: false, cls: 'bare', minWidth: '0' })
        : '<div class="wfops-sub">Nothing received yet.</div>')
      + UI.btn('Refresh', { size: 'xs', kind: 'ghost', icon: 'refresh', attrs: 'data-wfhook-refresh' });
    return html;
  };

  /** The Retention tab: this workflow's override, the tenant's policy and prune now. */
  App.wfRetentionTab = function (ctx, wf, deps) {
    const st = ctx.state; st.retention = st.retention || {};
    const r = st.retention[wf.id];
    if (!r) { loadRetention(ctx, wf, deps); return UI.notice('Loading the retention policy…', 'info'); }
    if (r.loading && !r.wf) return UI.notice('Loading the retention policy…', 'info');
    if (r.error) return UI.problem('The retention policy could not be loaded', r.error.message, r.error.problem && r.error.problem.trace_id);
    const o = r.wf.override, t = r.tenant, e = r.wf.effective;
    const num = (attr, val, ph, label) => UI.field(label, UI.input(val == null ? '' : String(val), { type: 'number', placeholder: ph, attrs: attr + ' min="1"' }));
    return '<style>' + CSS + '</style>'
      + UI.notice('Finished runs are pruned with their steps, items, approvals and outputs: after ' + esc(String(e.runDays)) + ' days, failed runs after ' + esc(String(e.failedDays)) + ', and beyond the newest ' + esc(String(e.maxRuns)) + ' of this workflow. Runs that are waiting, have an open dead letter, finished in the last ' + esc(String(t.graceHours)) + ' hours, or are under a legal hold are kept; held ones are recorded. The sweep runs every ' + esc(String(t.sweepHours)) + ' hours.', 'info')
      + '<div class="grid2" style="gap:12px">'
      + UI.panel('This workflow', '<div class="wfops-sub">Empty fields follow the tenant\'s policy.</div><div class="grid3" style="gap:8px">'
        + num('data-wfret-wf="runDays"', o.runDays, String(t.policy.runDays), 'Keep runs (days)') + num('data-wfret-wf="failedDays"', o.failedDays, String(t.policy.failedDays), 'Keep failed runs (days)') + num('data-wfret-wf="maxRuns"', o.maxRuns, String(t.policy.maxRuns), 'At most (runs)') + '</div>'
        + '<div class="hstack wrap gap6">' + UI.btn('Save override', { size: 'sm', kind: 'primary', attrs: 'data-wfret-savewf' }) + UI.btn('Count what a prune removes', { size: 'sm', attrs: 'data-wfret-dry="wf"' }) + UI.btn('Prune now', { size: 'sm', kind: 'danger', attrs: 'data-wfret-prune="wf"' }) + '</div>')
      + UI.panel('Tenant policy', '<div class="wfops-sub">For every workflow without an override. Empty fields use the defaults (' + esc(String(t.defaults.runDays)) + ' days, ' + esc(String(t.defaults.failedDays)) + ' days, ' + esc(String(t.defaults.maxRuns)) + ' runs). Last prune: ' + esc(when(t.lastRunAt)) + (t.lastRunAt ? ', ' + esc(String(t.lastPruned || 0)) + ' runs' : '') + '.</div><div class="grid3" style="gap:8px">'
        + num('data-wfret-t="runDays"', t.set.runDays, String(t.defaults.runDays), 'Keep runs (days)') + num('data-wfret-t="failedDays"', t.set.failedDays, String(t.defaults.failedDays), 'Keep failed runs (days)') + num('data-wfret-t="maxRuns"', t.set.maxRuns, String(t.defaults.maxRuns), 'At most (runs)') + '</div>'
        + '<div class="hstack wrap gap6">' + UI.btn('Save tenant policy', { size: 'sm', kind: 'primary', attrs: 'data-wfret-savet' }) + UI.btn('Count across the tenant', { size: 'sm', attrs: 'data-wfret-dry="tenant"' }) + UI.btn('Prune all now', { size: 'sm', kind: 'danger', attrs: 'data-wfret-prune="tenant"' }) + '</div>')
      + '</div>'
      + (r.last ? '<div data-wfret-result>' + UI.notice(r.last, 'ok') + '</div>' : '');
  };

  const counts = (x) => (x.dryRun ? 'A prune would remove ' : 'Pruned ') + x.runs + ' run' + (x.runs === 1 ? '' : 's') + ' (' + x.steps + ' steps, ' + x.items + ' items, ' + x.approvals + ' approvals). Kept: ' + x.kept.active + ' still going, ' + x.kept.deadLetter + ' with an open dead letter, ' + x.kept.legalHold + ' under a legal hold, ' + x.kept.evidence + ' as evidence, ' + x.kept.recent + ' finished in the last day.';

  App.wfOpsBind = function (ctx, wf, deps) {
    const st = ctx.state;
    const hookBase = '/api/workflows/' + enc(wf.id) + '/hook';
    ctx.on('click', '[data-wfhook-refresh]', () => loadHook(ctx, wf, deps));
    ctx.on('click', '[data-wfhook-copy]', () => {
      const d = st.hooks && st.hooks[wf.id] && st.hooks[wf.id].data; if (!d) return;
      const done = () => App.toast('Webhook URL copied.', 'ok');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(d.url).then(done, () => App.toast('Copy the URL from the inspector: the browser refused the clipboard.', 'warn'));
      else App.toast('Copy the URL from the inspector: the browser refused the clipboard.', 'warn');
    });
    ctx.on('click', '[data-wfhook-toggle]', async () => {
      const d = st.hooks && st.hooks[wf.id] && st.hooks[wf.id].data; if (!d) return;
      const on = !d.enabled;
      const ok = await ctx.confirm({ title: on ? 'Turn the webhook on?' : 'Turn the webhook off?', tone: on ? '' : 'danger', body: on ? 'Signed requests start runs of the published version as you, with what you may do at that moment. Anyone holding the secret can start runs.' : 'Requests are refused with 404 until it is turned on again. The secret stays.', kv: [['Workflow', esc(wf.name)], ['URL', '<span class="wfops-url">' + esc(d.url) + '</span>']], ok: on ? 'Enable' : 'Turn off' });
      if (!ok) return;
      try { await App.put(hookBase, { enabled: on }); App.toast(on ? 'Webhook on. Runs start as you.' : 'Webhook off. Requests are refused.', on ? 'ok' : 'warn'); loadHook(ctx, wf, deps); }
      catch (err) { App.fail(err, 'Could not change the webhook'); }
    });
    ctx.on('click', '[data-wfhook-rotate]', async () => {
      const d = st.hooks && st.hooks[wf.id] && st.hooks[wf.id].data; if (!d) return;
      if (d.secretSet) {
        const ok = await ctx.confirm({ title: 'Rotate the webhook secret?', tone: 'danger', body: 'The current secret stops working at once: senders must switch to the new one. There is no grace period.', kv: [['Workflow', esc(wf.name)], ['Secret made', esc(when(d.secretSetAt))]], ok: 'Rotate secret' });
        if (!ok) return;
      }
      let out;
      try { out = await App.post(hookBase + '/secret', {}); }
      catch (err) { App.fail(err, 'Could not make the secret'); return; }
      ctx.modal({
        title: 'Webhook secret',
        body: UI.notice('Copy it now: it is shown only this once and stored sealed. ' + (d.secretSet ? 'The old secret no longer works.' : '') + (out.enabled ? '' : ' Turn the webhook on when the sender is ready.'), 'warn')
          + UI.field('Secret', '<div class="wfops-secret" data-wfhook-secret tabindex="0" role="textbox" aria-readonly="true" aria-label="Webhook secret">' + esc(out.secret) + '</div>')
          + '<div class="wfops-sub">Keep it in the sender\'s secret store, for example as EXPRSN_HOOK_SECRET for the curl example. URL: <span class="wfops-url">' + esc(out.url) + '</span></div><div data-wfops-err></div>',
        actions: UI.btn('Copy secret', { size: 'sm', icon: 'copy', attrs: 'data-copysecret' }) + UI.btn('Done', { size: 'sm', kind: 'primary', attrs: 'data-close' }),
        onMount(m) {
          const b = m.querySelector('[data-copysecret]');
          if (b) b.addEventListener('click', () => { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(out.secret).then(() => App.toast('Secret copied.', 'ok'), () => problem(m, new Error('The browser refused the clipboard; select the secret and copy it.'))); });
        },
        onClose() { out = null; loadHook(ctx, wf, deps); }
      });
    });

    // ---- retention ----
    const read = (sel) => {
      const o = {};
      ctx.$$(sel).forEach((el) => { const k = el.getAttribute(sel.slice(1, -1)); const v = String(el.value || '').trim(); o[k] = v === '' ? null : Number(v); });
      return o;
    };
    const valid = (o) => Object.keys(o).every((k) => o[k] == null || (Number.isInteger(o[k]) && o[k] >= 1));
    ctx.on('click', '[data-wfret-savewf]', async () => {
      const body = read('[data-wfret-wf]');
      if (!valid(body)) { App.toast('Each value is a whole number of at least 1, or empty.', 'warn'); return; }
      try { await App.put('/api/workflows/' + enc(wf.id) + '/retention', body); App.toast('Retention override saved for ' + esc(wf.name) + '.', 'ok'); loadRetention(ctx, wf, deps); }
      catch (err) { App.fail(err, 'Could not save the override'); }
    });
    ctx.on('click', '[data-wfret-savet]', async () => {
      const body = read('[data-wfret-t]');
      if (!valid(body)) { App.toast('Each value is a whole number of at least 1, or empty.', 'warn'); return; }
      const ok = await ctx.confirm({ title: 'Save the tenant policy?', body: 'Every workflow without an override follows it at the next sweep.', kv: [['Keep runs', body.runDays == null ? 'default' : body.runDays + ' days'], ['Keep failed runs', body.failedDays == null ? 'default' : body.failedDays + ' days'], ['At most', body.maxRuns == null ? 'default' : body.maxRuns + ' runs per workflow']], ok: 'Save' });
      if (!ok) return;
      try { await App.put('/api/workflow-retention', body); App.toast('Tenant retention policy saved.', 'ok'); loadRetention(ctx, wf, deps); }
      catch (err) { App.fail(err, 'Could not save the policy'); }
    });
    const prune = async (scope, dryRun) => {
      const body = scope === 'wf' ? { dryRun, workflow: wf.id } : { dryRun };
      if (!dryRun) {
        let count;
        try { count = await App.post('/api/workflow-retention/prune', Object.assign({}, body, { dryRun: true })); }
        catch (err) { App.fail(err, 'Could not count'); return; }
        const ok = await ctx.confirm({ title: scope === 'wf' ? 'Prune runs of ' + esc(wf.name) + '?' : 'Prune runs of every workflow?', tone: 'danger', body: 'Removed runs cannot be brought back. ' + esc(counts(count)), kv: [['Runs', esc(String(count.runs))]], ok: 'Prune now' });
        if (!ok) return;
      }
      try {
        const out = await App.post('/api/workflow-retention/prune', body);
        st.retention[wf.id] = Object.assign({}, st.retention[wf.id], { last: esc(counts(out)) });
        App.toast(esc(counts(out)), 'ok', 7000);
        if (!dryRun) loadRetention(ctx, wf, deps); else deps.later();
      } catch (err) { App.fail(err, 'Could not prune'); }
    };
    ctx.on('click', '[data-wfret-dry]', (e, t) => prune(t.dataset.wfretDry, true));
    ctx.on('click', '[data-wfret-prune]', (e, t) => prune(t.dataset.wfretPrune, false));
  };
})();
