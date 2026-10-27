// Apps, import from the Exprsn platform (apps/platform-import.ts, docs/decisions/lowcode-port.md "Importing platform
// apps"): pick one of the platform's low-code apps, choose a new or an existing app and its label, read the dry run's
// mapping report (what maps, what changes, what is dropped and why, the records that would fail, the writes to the
// platform), start the import job and follow it. Needs apps:design and platform:manage.
// `apps.js` shows the action when App.appsPlatformImport.available() and calls App.appsPlatformImport(ctx, deps).
(function () {
  const { UI, esc } = App;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l) + 1;
  const BASE = '/api/apps/platform-import';
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Request failed';
  const can = (p) => (typeof App.can === 'function' ? App.can(p) : true);
  const count = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const pillFor = (a) => UI.pill(a, a === 'create' || a === 'created' ? 'ok' : a === 'update' || a === 'updated' ? 'info' : a === 'skip' || a === 'skipped' || a === 'failed' ? 'warn' : 'outline');
  const list = (items, fmt) => (items && items.length ? '<ul class="pi-list">' + items.map((x) => '<li>' + fmt(x) + '</li>').join('') + '</ul>' : '<span class="muted">None</span>');
  const dropped = (d) => '<b>' + esc(d.what) + '</b>: ' + esc(d.why);

  function reportHtml(r) {
    const s = r.records || {};
    const head = UI.kv([
      ['Platform app', '<span class="mono">' + esc(r.source.app.key) + '</span> ' + esc(r.source.app.name) + ' <span class="muted">at ' + esc(r.source.url) + '</span>'],
      ['Into', (r.target.mode === 'new' ? 'a new app ' : r.target.mode === 'linked' ? 'the app it was imported into before, ' : 'the existing app ') + '<span class="mono">' + esc(r.target.name) + '</span> ' + UI.label(r.target.label, { sm: true })],
      ['Records', count(s.total || 0, 'record') + ': ' + (s.create || 0) + ' to create, ' + (s.update || 0) + ' to update, ' + (s.invalid || 0) + ' would fail'],
      ['Writes to the platform', r.platformWrites.length ? list(r.platformWrites, (w) => '<span class="mono">' + esc(w.method + ' ' + w.path) + '</span>: ' + esc(w.purpose)) : 'None']
    ], 1);
    const warn = (r.warnings || []).map((w) => UI.notice(esc(w), 'warn')).join('');
    const ents = UI.table(['Entity', 'Into', 'Action', 'Fields', 'Records'], r.entities.map((e) => ['<span class="mono">' + esc(e.source) + '</span>', '<span class="mono">' + esc(e.name) + '</span>', pillFor(e.action), String(e.fields.length), (e.records.create || 0) + ' new, ' + (e.records.update || 0) + ' to update' + (e.records.invalid ? ', <b>' + e.records.invalid + ' failing</b>' : '') + (e.records.truncated ? ' <span class="muted">(first ' + e.records.read + ' of ' + e.records.total + ')</span>' : '')]), { clickable: false, minWidth: '0' });
    const details = r.entities.map((e) => '<details class="pi-detail"><summary>' + esc(e.source) + ': fields, changes and what is dropped</summary>'
      + UI.table(['Field', 'Into', 'Type', 'Notes'], e.fields.map((f) => ['<span class="mono">' + esc(f.source) + '</span>', '<span class="mono">' + esc(f.name) + '</span>', esc(f.from) + ' to ' + esc(f.to), esc((f.notes || []).join('; '))]), { clickable: false, minWidth: '0' })
      + (e.states ? '<div class="muted pi-small">State machine: ' + esc(e.states.states.join(', ')) + ', starting ' + esc(e.states.initial) + ', ' + count(e.states.transitions, 'transition') + '.</div>' : '')
      + '<div class="eyebrow">Changed</div>' + list(e.changed, esc) + '<div class="eyebrow">Dropped</div>' + list(e.dropped, dropped) + '</details>').join('');
    const forms = r.forms.length ? UI.table(['Form', 'Into', 'Action', 'Notes and what is dropped'], r.forms.map((f) => ['<span class="mono">' + esc(f.sourceKey) + '</span>', '<span class="mono">' + esc(f.name) + '</span> on ' + esc(f.entity), pillFor(f.action), esc(f.reason || '') + ' ' + esc((f.notes || []).join('; ')) + (f.dropped.length ? list(f.dropped, dropped) : '')]), { clickable: false, minWidth: '0' }) : '<span class="muted">No forms</span>';
    const flows = r.flows.length ? UI.table(['Flow', 'Imported', 'Trigger and steps', 'Why, or notes'], r.flows.map((f) => ['<span class="mono">' + esc(f.sourceKey) + '</span>', f.imported ? pillFor(f.action) + (f.enabled === false ? ' ' + UI.pill('off', 'outline') : '') : UI.pill('not imported', 'warn'), f.trigger ? esc(f.trigger.kind + (f.trigger.events ? ' ' + f.trigger.events.join(', ') : f.trigger.cron ? ' ' + f.trigger.cron : '')) + ': ' + esc(f.actions.join(', ')) : '', esc((f.imported ? f.notes : f.reasons).join('; '))]), { clickable: false, minWidth: '0' }) : '<span class="muted">No flows</span>';
    const problems = (s.problems || []).length ? '<details class="pi-detail"><summary>' + count(s.problems.length, 'record') + ' that would fail</summary>' + UI.table(['Entity', 'Platform record', 'Problems'], s.problems.slice(0, 200).map((p) => [esc(p.entity), '<span class="mono">' + esc(p.source) + '</span>', esc(p.problems.join('; '))]), { clickable: false, minWidth: '0' }) + '</details>' : '';
    return head + warn + '<div class="eyebrow">Entities</div>' + ents + details + problems + '<div class="eyebrow">Forms</div>' + forms + '<div class="eyebrow">Flows</div>' + flows + (r.dropped.length ? '<div class="eyebrow">Also dropped</div>' + list(r.dropped, dropped) : '');
  }

  function runHtml(run) {
    const job = run.job || {};
    const done = run.state === 'succeeded' || run.state === 'failed';
    const pct = done ? 100 : Math.max(0, Math.min(100, job.progress || 0));
    let body = UI.meter(run.state === 'failed' ? 'Failed' : done ? 'Imported' : 'Importing', (job.message ? esc(job.message) + ', ' : '') + pct + '%', pct, run.state === 'failed' ? 'danger' : 'accent');
    if (run.error) body += UI.notice(esc(run.error), 'danger');
    const sm = run.summary;
    if (sm) {
      const rc = sm.records || {};
      body += UI.kv([['App', '<span class="mono">' + esc(sm.app) + '</span>'], ['Records', (rc.created || 0) + ' created, ' + (rc.updated || 0) + ' updated, ' + (rc.unchanged || 0) + ' unchanged, ' + (rc.failed || 0) + ' failed' + (rc.stateNotReached ? ', ' + rc.stateNotReached + ' left in another state' : '')], ['Forms', (sm.forms.created || 0) + ' created, ' + (sm.forms.updated || 0) + ' updated, ' + (sm.forms.skipped || 0) + ' skipped'], ['Flows', (sm.flows.created || 0) + ' created, ' + (sm.flows.updated || 0) + ' updated, ' + (sm.flows.skipped || 0) + ' not imported, ' + (sm.flows.failed || 0) + ' failed'], ['Platform writes', sm.platformWrites.length ? esc(sm.platformWrites.join('; ')) : 'None']], 1);
    }
    const failed = (run.report || []).filter((x) => x.result === 'failed' || x.result === 'references');
    if (failed.length) body += '<details class="pi-detail" open><summary>' + count(failed.length, 'item') + ' not written</summary>' + UI.table(['Kind', 'Platform', 'Problems'], failed.slice(0, 300).map((x) => [esc(x.kind + (x.entity ? ' ' + x.entity : '')), '<span class="mono">' + esc(x.source) + '</span>', esc((x.problems || []).join('; '))]), { clickable: false, minWidth: '0' }) + '</details>';
    return body;
  }

  App.appsPlatformImport = function (ctx, deps) {
    const st = { step: 'pick', apps: null, error: null, pick: null, mode: 'new', name: '', existing: '', label: 'internal', records: true, forms: true, flows: true, enableFlows: false, markPlatform: false, plan: null, run: null, busy: false, timer: null };
    const myClearance = (App.me && App.me.user && App.me.user.clearance) || 'internal';
    const labels = LABELS.filter((l) => rank(l) <= rank(myClearance)).map((l) => ({ value: l, label: l }));
    const appsHere = (deps.apps || []).map((a) => ({ value: a.name, label: (a.title || a.name) + ' (' + a.name + ')' }));
    let el = null;
    const draw = () => {
      if (!el) return;
      const body = el.querySelector('[data-pi-body]'); const acts = el.querySelector('[data-pi-acts]');
      let h = ''; let a = UI.btn('Close', { attrs: 'data-close' });
      if (st.error) h += UI.notice('<b>' + esc(st.error.status || '') + '</b> ' + esc(st.error.text), 'danger');
      if (st.step === 'pick') {
        if (!st.apps) h += UI.notice('Reading the platform’s apps…', 'info');
        else if (st.unconfigured) {
          h += UI.notice('<b>Not connected to the Exprsn platform.</b> ' + esc(st.unconfigured) + ' An operator sets it in the server settings; the import script <span class="mono">scripts/exprsn-platform-apps-import.mjs</span> can also read each app as its owner.', 'info');
        } else {
          h += UI.notice('Apps on the Exprsn platform (' + esc(st.url) + ') that the configured platform account can design. An import is first a dry run: nothing is written until you start it.', 'info');
          h += st.apps.length ? UI.table(['', 'Platform app', 'Status', 'Imported as', 'Marked on the platform'], st.apps.map((x) => ['<input type="radio" name="pi-app" value="' + esc(x.id) + '" aria-label="Import ' + esc(x.key) + '"' + (st.pick === x.id ? ' checked' : '') + ' data-pi-pick>', '<span class="mono">' + esc(x.key) + '</span> ' + esc(x.name), esc(x.status || ''), x.imported ? '<span class="mono">' + esc(x.imported.name) + '</span>' : '<span class="muted">Not yet</span>', x.markedOnPlatform.length ? esc(x.markedOnPlatform.map((m) => m.label).join(', ')) : '<span class="muted">No</span>']), { clickable: false, minWidth: '0' }) : UI.empty('No platform apps', 'The platform account designs no low-code apps.');
          const chosen = st.apps.find((x) => x.id === st.pick);
          if (chosen) {
            if (!st.name) st.name = (chosen.key.replace(/[^a-z0-9_]+/g, '_') + '_platform').slice(0, 63);
            h += (chosen.imported ? UI.notice('Imported before as ' + esc(chosen.imported.name) + '; this import updates that app.', 'info') : '')
              + '<div class="formgrid">' + UI.field('Into', UI.seg([{ id: 'new', label: 'A new app' }, { id: 'existing', label: 'An existing app' }], st.mode, 'data-pi-mode aria-label="Into"'))
              + (st.mode === 'new' ? UI.field('Name', UI.input(st.name, { attrs: 'data-pi-name' }), 'lower-case letters, digits and _') + UI.field('Label', UI.select(labels, st.label, 'data-pi-label'), 'Within your clearance; it caps every record.') : UI.field('App', UI.select([{ value: '', label: 'Choose an app' }].concat(appsHere), st.existing, 'data-pi-existing'), 'Its fields win; what it lacks is added.'))
              + '</div><div class="hstack wrap gap6">' + UI.check('Records', st.records, 'data-pi-opt="records"') + UI.check('Forms', st.forms, 'data-pi-opt="forms"') + UI.check('Flows', st.flows, 'data-pi-opt="flows"') + UI.check('Turn imported flows on', st.enableFlows, 'data-pi-opt="enableFlows"') + UI.check('Mark the platform app (writes one lookup there)', st.markPlatform, 'data-pi-opt="markPlatform"') + '</div>';
          }
          a += UI.btn('Dry run', { kind: 'primary', attrs: 'data-pi-plan' + (chosen && !st.busy ? '' : ' disabled') });
        }
      } else if (st.step === 'report') {
        h += UI.notice('Dry run. Nothing was written. Read the report, then start the import; it runs as the job apps.platform-import and writes every record through the record service.', 'info') + reportHtml(st.plan.report);
        a += UI.btn('Back', { attrs: 'data-pi-back' }) + UI.btn('Start import', { kind: 'primary', attrs: 'data-pi-start' + (st.busy ? ' disabled' : '') });
      } else if (st.step === 'run') {
        h += st.run ? runHtml(st.run) : UI.notice('Queued…', 'info');
        if (st.run && st.run.state === 'succeeded') a += UI.btn('Open the app', { kind: 'primary', attrs: 'data-pi-open' });
      }
      body.innerHTML = h; acts.innerHTML = a;
      if (App.a11yPass) App.a11yPass(el);
    };
    const fail = (err) => { st.error = { status: err && err.status, text: detailOf(err) }; st.busy = false; draw(); };
    const poll = () => {
      if (!st.run || !el) return;
      App.get(BASE + '/runs/' + encodeURIComponent(st.run.id)).then((r) => {
        st.run = r; draw();
        if (r.state !== 'succeeded' && r.state !== 'failed') st.timer = setTimeout(poll, 1500);
        else { ctx.toast(r.state === 'succeeded' ? 'Import of ' + esc(r.platformApp.key) + ' finished. Audited app.platform-import.finished.' : 'Import of ' + esc(r.platformApp.key) + ' failed.', r.state === 'succeeded' ? 'ok' : 'danger'); if (deps.reload) deps.reload(); }
      }).catch(fail);
    };
    deps.modal({ title: 'Import from Exprsn platform', cls: 'wide', body: '<style>#overlay .pi-list{margin:4px 0;padding-left:18px}#overlay .pi-detail{margin:6px 0}#overlay .pi-detail summary{cursor:pointer;color:var(--fg2)}#overlay .pi-small{font-size:12px}</style><div class="vstack gap8" data-pi-body aria-live="polite"></div>', actions: '<div class="hstack gap6" data-pi-acts></div>',
      onClose() { el = null; if (st.timer) clearTimeout(st.timer); },
      onMount(m) {
        el = m; draw();
        App.get(BASE + '/apps').then((r) => { st.apps = r.apps; st.url = r.url; st.unconfigured = r.configured === false ? (r.reason || 'The platform connection is not configured.') : null; if (r.apps.length === 1) st.pick = r.apps[0].id; draw(); }).catch(fail);
        m.addEventListener('change', (e) => {
          const t = e.target;
          if (t.matches('[data-pi-pick]')) { st.pick = t.value; st.name = ''; draw(); }
          else if (t.matches('[data-pi-name]')) st.name = t.value.trim();
          else if (t.matches('[data-pi-label]')) st.label = t.value;
          else if (t.matches('[data-pi-existing]')) st.existing = t.value;
          else if (t.matches('[data-pi-opt]')) st[t.dataset.piOpt] = t.checked;
        });
        m.addEventListener('click', async (e) => {
          const t = e.target.closest('button, [data-seg]'); if (!t || !el) return;
          if (t.closest('[data-pi-mode]') && t.dataset.seg) { st.mode = t.dataset.seg; draw(); return; }
          if (t.matches('[data-pi-back]')) { st.step = 'pick'; st.error = null; draw(); return; }
          if (t.matches('[data-pi-plan]')) {
            const nameEl = el.querySelector('[data-pi-name]'); if (nameEl) st.name = nameEl.value.trim();
            const target = st.mode === 'new' ? { mode: 'new', name: st.name, label: st.label } : { mode: 'existing', name: st.existing };
            if (!target.name) { fail({ message: st.mode === 'new' ? 'Name the new app.' : 'Choose the app to import into.' }); return; }
            st.busy = true; st.error = null; draw();
            try {
              st.plan = await App.post(BASE + '/plan', { platformApp: st.pick, target, options: { records: st.records, forms: st.forms, flows: st.flows, enableFlows: st.enableFlows, markPlatform: st.markPlatform } });
              st.step = 'report'; st.busy = false; draw();
            } catch (err) { fail(err); }
            return;
          }
          if (t.matches('[data-pi-start]')) {
            const r = st.plan.report;
            st.busy = true; draw();
            try {
              const out = await App.post(BASE + '/runs', { planId: st.plan.id });
              st.run = { id: out.id, state: 'queued', job: null, report: [] }; st.step = 'run'; st.busy = false; draw();
              ctx.toast('Import of ' + esc(r.source.app.key) + ' queued (job apps.platform-import). Audited app.platform-import.started.');
              poll();
            } catch (err) { fail(err); }
            return;
          }
          if (t.matches('[data-pi-open]')) { const id = st.run && st.run.summary && st.run.summary.appId; App.closeOverlay(); if (id) ctx.navigate('apps', { app: id }); }
        });
      } });
  };
  /** Whether the caller may import: designing apps, and the operator's platform connection. */
  App.appsPlatformImport.available = () => can('apps:design') && can('platform:manage');
})();
