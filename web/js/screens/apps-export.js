// Apps, exports (1.8.0, Sprint 44, B-123): records with the current filters, a saved view or a report as XLSX, PDF
// or CSV. A small export downloads at once (POST /api/apps/:app/exports/download, at most 5000 rows); a larger one
// runs as the job apps.export-file, with its progress shown here, and lands in a sealed file only the requester
// downloads (GET /api/apps/:app/exports/:id/download). Everything is read as the person exporting, with their
// policies, masks and clearance: masked values are exported masked.
// apps.js calls App.appsExport.open(ctx, o) from the Records tab's Export button; apps-reports.js from a report.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const SYNC = 5000;
  const FORMATS = [
    { id: 'xlsx', label: 'Excel workbook (.xlsx)', hint: 'Typed cells, the header row frozen, grouped rows in outline' },
    { id: 'pdf', label: 'PDF', hint: 'The report\'s page setup, the header on every page' },
    { id: 'csv', label: 'CSV', hint: 'Plain text, cells made safe for spreadsheets' }
  ];
  const STATE_WORD = { queued: 'Queued', running: 'Running', ready: 'Ready', failed: 'Failed', expired: 'Expired' };
  const base = (app) => '/api/apps/' + enc(app.id) + '/exports';
  const detailOf = (err) => (err && ((err.problem && (err.problem.detail || err.problem.title)) || err.message)) || 'Something went wrong.';

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function fileName(res, fallback) {
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd);
    return m ? m[1] : fallback;
  }

  /** A direct download; resolves with the file name, or rejects with the problem (409 with queue: true when too large). */
  async function direct(app, body) {
    const res = await fetch(base(app) + '/download', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': App.state.csrf || '' }, body: JSON.stringify(body) });
    if (!res.ok) { let p = {}; try { p = await res.json(); } catch (x) { /* not json */ } throw new App.ApiError(Object.assign({ status: res.status }, p)); }
    const name = fileName(res, 'export.' + body.format);
    saveBlob(await res.blob(), name);
    return name;
  }

  /** Polls a queued export until it is ready or failed, writing its state into `statusEl` (a live region). */
  function follow(app, exp, statusEl, linkEl, onDone) {
    let stopped = false;
    const tick = async () => {
      if (stopped || !document.body.contains(statusEl)) return;
      let cur = exp;
      try {
        cur = await App.get(base(app) + '/' + enc(exp.id));
        let pct = null; let msg = '';
        if (cur.state === 'running' || cur.state === 'queued') {
          try { const jobs = await App.get('/api/me/jobs'); const list = Array.isArray(jobs) ? jobs : (jobs.jobs || jobs.items || []); const j = list.find((x) => x.id === cur.jobId); if (j) { pct = j.progress; msg = j.message || ''; } } catch (x) { /* progress is optional */ }
        }
        statusEl.textContent = (STATE_WORD[cur.state] || cur.state) + (pct != null && cur.state !== 'ready' ? ' ' + pct + '%' : '') + (msg && cur.state === 'running' ? ': ' + msg : '') + (cur.state === 'ready' ? ': ' + cur.rows + ' row' + (cur.rows === 1 ? '' : 's') + (cur.truncated ? ', truncated at the row cap' : '') : '') + (cur.state === 'failed' ? ': ' + (cur.error || 'the export failed') : '');
        if (cur.state === 'ready') {
          linkEl.innerHTML = '<a class="btn primary sm" href="' + esc(base(app) + '/' + enc(cur.id) + '/download') + '" download="' + esc(cur.file || '') + '">Download ' + esc(cur.file || 'the file') + '</a>';
          stopped = true; if (onDone) onDone(cur); return;
        }
        if (cur.state === 'failed' || cur.state === 'expired') { stopped = true; if (onDone) onDone(cur); return; }
      } catch (err) { statusEl.textContent = 'Could not read the export: ' + detailOf(err); }
      setTimeout(tick, 1200);
    };
    tick();
    return () => { stopped = true; };
  }

  /**
   * The export dialog. o: { app, kind: 'records'|'view'|'report', id, title, params, filters, rows (known count or null),
   * deps (apps.js depsFor: modal), onQueued }.
   */
  function open(ctx, o) {
    const modal = o.deps && o.deps.modal ? o.deps.modal : (m) => ctx.modal(m);
    const big = o.rows != null && o.rows > SYNC;
    const radios = '<fieldset class="apps-exf"><legend>Format</legend>' + FORMATS.map((f, i) => '<label class="check apps-exopt"><input type="radio" name="apps-exfmt" value="' + f.id + '"' + (i === 0 ? ' checked' : '') + ' data-ex-fmt> <span><b>' + esc(f.label) + '</b><br><span class="muted" style="font-size:12px">' + esc(f.hint) + '</span></span></label>').join('') + '</fieldset>';
    const kv = [['What', esc(o.title)]].concat(o.rows != null ? [['Rows', String(o.rows)]] : []).concat(o.summary || []);
    const body = '<style>#overlay .apps-exf{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;min-width:0}#overlay .apps-exf legend{font-weight:600;font-size:13px;margin-bottom:4px}#overlay .apps-exopt{align-items:flex-start;gap:8px}#overlay .apps-exopt span{min-width:0;overflow-wrap:anywhere}</style>'
      + UI.kv(kv, 1)
      + radios
      + UI.notice('Read as you, now: only the rows your policies and clearance allow, and masked values stay masked. ' + (big ? 'More than ' + SYNC + ' rows: the export runs as a job and lands in a sealed file only you can download, for 7 days.' : 'Up to ' + SYNC + ' rows download at once; more run as a job.'), 'info')
      + '<p class="muted" role="status" aria-live="polite" data-ex-status style="margin:0;font-size:13px"></p><div data-ex-link></div><div data-ex-err></div>';
    modal({ title: 'Export ' + esc(o.title), body,
      actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn(big ? 'Queue export' : 'Export', { kind: 'primary', attrs: 'data-ex-ok' }),
      onMount(m) {
        const ok = m.querySelector('[data-ex-ok]');
        const statusEl = m.querySelector('[data-ex-status]');
        const linkEl = m.querySelector('[data-ex-link]');
        const errEl = m.querySelector('[data-ex-err]');
        const first = m.querySelector('[data-ex-fmt]'); if (first) first.focus();
        const queue = async (payload) => {
          const exp = await App.post(base(o.app), payload);
          statusEl.textContent = 'Queued as the job apps.export-file. Audited app.export.queued.';
          if (o.onQueued) o.onQueued(exp);
          follow(o.app, exp, statusEl, linkEl, (cur) => { if (cur.state === 'ready') { const a = linkEl.querySelector('a'); if (a) a.focus(); } });
        };
        ok.addEventListener('click', async () => {
          errEl.innerHTML = ''; linkEl.innerHTML = '';
          const sel = m.querySelector('[data-ex-fmt]:checked');
          const payload = { kind: o.kind, id: o.id, format: sel ? sel.value : 'xlsx' };
          if (o.params && Object.keys(o.params).length) payload.params = o.params;
          if (o.filters) payload.filters = o.filters;
          ok.disabled = true;
          try {
            if (big) await queue(payload);
            else {
              statusEl.textContent = 'Writing the file…';
              try {
                const name = await direct(o.app, payload);
                statusEl.textContent = 'Downloaded ' + name + '. Audited app.export.rendered.';
              } catch (err) {
                if (err && err.status === 409 && err.problem && err.problem.queue) { statusEl.textContent = 'More than ' + SYNC + ' rows: queueing it as a job.'; await queue(payload); }
                else throw err;
              }
            }
          } catch (err) { statusEl.textContent = ''; errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
          finally { ok.disabled = false; }
        });
      } });
  }

  /** The caller's recent exports of one app, for the Reports tab's side panel. */
  function list(exports, app) {
    if (!exports || !exports.length) return '<p class="muted" style="margin:0;font-size:12px">No exports of this app yet.</p>';
    return '<ul class="apps-exlist" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px">' + exports.slice(0, 10).map((e) => '<li style="min-width:0;overflow-wrap:anywhere;font-size:12px">'
      + UI.pill(STATE_WORD[e.state] || e.state, e.state === 'ready' ? 'ok' : e.state === 'failed' ? 'danger' : e.state === 'expired' ? '' : 'info') + ' '
      + (e.state === 'ready' ? '<a href="' + esc(base(app) + '/' + enc(e.id) + '/download') + '" download="' + esc(e.file || '') + '">' + esc(e.file || e.format) + '</a>' : '<span>' + esc(e.kind + ', ' + e.format) + '</span>')
      + (e.state === 'ready' ? ' <span class="muted">' + esc(String(e.rows)) + ' rows' + (e.truncated ? ', truncated' : '') + '</span>' : '')
      + (e.error ? '<br><span class="muted">' + esc(e.error) + '</span>' : '') + '</li>').join('') + '</ul>';
  }

  App.appsExport = { open, list, direct, SYNC };
})();
