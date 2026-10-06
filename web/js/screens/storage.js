(function () {
  const { UI, esc } = App;

  // 1.6.0, Sprint 35c (B-4204): Storage, live. Stores and health, usage against the file quotas, the quarantine, the
  // integrity check ops.blobs.verify with orphan deletion after a dry run (decision Q10), the purge schedules, and
  // blob store migration as a copy-then-switch job (Q16). Everything here needs platform:manage.

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const when = (ms) => { if (!ms) return 'never'; const d = new Date(ms); const today = new Date().toDateString() === d.toDateString(); return (today ? 'today ' : d.getDate() + ' ' + MON[d.getMonth()] + ' ') + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const ago = (ms) => { if (!ms) return ''; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + ' s' : s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' days'; };
  const dur = (ms) => { if (ms == null) return ''; if (ms < 1000) return ms + ' ms'; if (ms < 60000) return (ms / 1000).toFixed(1) + ' s'; if (ms < 3600000) return Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s'; return Math.floor(ms / 3600000) + ' h ' + Math.round((ms % 3600000) / 60000) + ' min'; };
  const size = (n) => { if (n == null) return 'unknown'; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MiB'; if (n < 1099511627776) return (n / 1073741824).toFixed(1) + ' GiB'; return (n / 1099511627776).toFixed(2) + ' TiB'; };
  const num = (n) => '<span class="num">' + esc(n == null ? '' : Number(n).toLocaleString('en')) + '</span>';
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const tone = (p) => (p > 100 ? 'danger' : p > 80 ? 'warn' : '');
  const qKind = (s) => (s === 'scanning' ? 'info' : s === 'infected' || s === 'type mismatch' ? 'danger' : s === 'deleted' ? '' : 'warn');
  const fKind = (f) => (f === 'orphan' ? 'warn' : 'danger');
  const KIND_LABEL = { files: 'Files', versions: 'Versions', trash: 'Trash', media: 'Media', knowledge: 'Knowledge uploads', attachments: 'Attachments' };
  const GIB = 1073741824;

  // ---------- step-up (B-106): starting or retiring a migration needs a recent sign-in ----------
  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">This change needs a fresh check of who you are. ' + (pw && totp ? 'Enter your password or a code from your authenticator.' : pw ? 'Enter your password.' : totp ? 'Enter a code from your authenticator.' : 'Sign out and sign in again.') + '</div>'
        + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
        + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
        + '<div data-suerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + (pw || totp ? UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }) : ''),
      onMount(m) {
        const err = m.querySelector('[data-suerr]');
        const go = async () => {
          const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
          const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
          if (!pwv && !code) { err.innerHTML = UI.notice('Enter your password or a code.', 'warn'); return; }
          try { await App.post('/api/me/step-up', pwv ? { password: pwv } : { code }); ok = true; App.closeOverlay(); }
          catch (e) { err.innerHTML = UI.notice(esc((e.problem && e.problem.detail) || e.message), 'danger'); }
        };
        const b = m.querySelector('[data-sugo]'); if (b) b.addEventListener('click', go);
        m.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }));
      },
      onClose() { resolve(ok); } });
  });
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) return undefined;
      return fn();
    }
  };

  /** A confirm that asks for a reason: resolves the reason, or null when cancelled. */
  const askReason = (ctx, o) => new Promise((resolve) => {
    let out = null;
    ctx.modal({ title: esc(o.title) + (o.tag ? ' ' + UI.pill(o.tag, o.tone === 'danger' ? 'danger' : 'info') : ''),
      body: (o.body || '') + (o.kv ? UI.kv(o.kv, 2) : '') + UI.field('Reason', UI.textarea('', { rows: 2, placeholder: o.placeholder || 'Why', attrs: 'data-reason aria-required="true"' }), o.required === false ? 'Optional; written to the audit chain.' : 'Required; written to the audit chain.') + '<div data-rerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(o.ok || 'Confirm', { kind: o.tone === 'danger' ? 'danger' : 'primary', attrs: 'data-rok' }),
      onMount(m) {
        m.querySelector('[data-rok]').addEventListener('click', () => {
          const v = m.querySelector('[data-reason]').value.trim();
          if (o.required !== false && v.length < 3) { m.querySelector('[data-rerr]').innerHTML = UI.notice('Give a reason of at least 3 characters.', 'warn'); return; }
          out = v; App.closeOverlay();
        });
      },
      onClose() { resolve(out); } });
  });

  function menu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown'; d.setAttribute('role', 'menu');
    d.innerHTML = items.map((it) => '<button type="button" role="menuitemradio" aria-checked="' + (it[0] === active) + '" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  const go = (ctx, route, params) => { if (App.screens[route]) ctx.navigate(route, params); else ctx.toast('That screen is not part of this build yet.', 'warn'); };

  App.register({
    id: 'storage', title: 'Storage', section: 'admin', live: true, crumb: ['Admin', 'Storage'],
    summary: 'Blob stores, usage against quotas, quarantine, integrity and purges',
    commands: [
      { label: 'Run an integrity check', sub: 'Storage', run(app) { const s = app.stateFor('storage'); s.tab = 'integrity'; s.openVerify = true; app.render(); } },
      { label: 'Set a workspace quota', sub: 'Storage', run(app) { const s = app.stateFor('storage'); s.tab = 'usage'; s.openQuota = true; app.render(); } }
    ],
    states: [
      { title: 'Store nearly full', tone: 'warn', text: 'Above 90 % of what the blob store reports as its capacity, the meter turns amber and a notice names the store.', apply(ctx) { const st = ctx.state; st.tab = 'stores'; st.sel = 'blobs'; const b = st.data && st.data.stores.stores.find((x) => x.id === 'blobs'); if (b && b.capacityBytes && pct(b.usedBytes || 0, b.capacityBytes) <= 90) ctx.toast('The blob store is at ' + pct(b.usedBytes || 0, b.capacityBytes) + ' % of its capacity; the notice appears above 90 %.', '', 5000); else if (b && !b.capacityBytes) ctx.toast('This store reports no capacity (S3); the notice appears when a capacity is known.', '', 5000); ctx.rerender(); } },
      { title: 'ClamAV unreachable', tone: 'danger', text: 'When the daemon at CLAMD_HOST does not answer, uploads stay in quarantine, nothing is released unscanned and Rescan answers 503.', apply(ctx) { const st = ctx.state; st.tab = 'quarantine'; const sc = st.data && st.data.quarantine.scanner; if (sc && sc.reachable !== false) ctx.toast(sc.configured ? 'ClamAV answers at ' + esc(sc.host) + '.' : 'No ClamAV is configured (CLAMD_HOST): uploads get the type check only.', 'ok', 5000); ctx.rerender(); } },
      { title: 'Orphans found', tone: 'warn', text: 'The last verification found objects no row references. Delete orphans runs a dry run first, then asks for a reason.', apply(ctx) { const st = ctx.state; st.tab = 'integrity'; const l = st.data && st.data.integrity.last; if (!l) ctx.toast('No verification has finished yet: run one.', 'warn'); else if (!l.orphans) ctx.toast('The last verification found no orphans.', 'ok'); ctx.rerender(); } },
      { title: 'Quota exceeded', tone: 'danger', text: 'A workspace above its file quota refuses uploads with 413 until space is freed or the quota raised (B-2403).', apply(ctx) { const st = ctx.state; st.tab = 'usage'; st.usageBy = 'workspace'; const over = st.data && st.data.usage.workspaces.find((w) => w.quotaBytes != null && w.quotaUsed > w.quotaBytes); if (over) st.selUsage = over.id; else ctx.toast('No workspace is above its quota.', 'ok'); ctx.rerender(); } },
      { title: 'Filesystem store on one node', tone: 'neutral', text: 'BLOB_STORE=fs keeps objects under BLOB_DIR on one instance. A second instance needs a shared path or an S3 store.', apply(ctx) { const st = ctx.state; st.tab = 'stores'; st.sel = 'blobs'; const b = st.data && st.data.stores.stores.find((x) => x.id === 'blobs'); if (b && !b.singleNode) ctx.toast('The blob store is S3: every instance reads the same objects.', 'ok'); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const D = { tab: 'stores', sel: 'blobs', usageBy: 'workspace', qState: 'all', qQuery: '' };
      Object.keys(D).forEach((k) => { if (st[k] == null) st[k] = D[k]; });
      if (location.hash !== st.paramsHash) {
        st.paramsHash = location.hash;
        if (ctx.params.tab) st.tab = ctx.params.tab;
        if (ctx.params.workspace) { st.tab = 'usage'; st.wantWorkspace = ctx.params.workspace; }
      }

      // ---------- loading ----------
      const refresh = () => {
        if (App.state.route !== 'storage') return;
        if (document.getElementById('overlay')) { st.dirty = true; return; }
        ctx.rerender();
      };
      const busy = (d) => !!d && (!!d.integrity.running || (d.stores.migration && (d.stores.migration.state === 'queued' || d.stores.migration.state === 'copying')));
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all(['stores', 'usage', 'quarantine', 'integrity', 'purges'].map((p) => App.get('/api/admin/storage/' + p)))
          .then((r) => { st.data = { stores: r[0], usage: r[1], quarantine: r[2], integrity: r[3], purges: r[4] }; st.loaded = true; st.loadError = null; })
          .catch((err) => { st.loadError = err; })
          .finally(() => {
            st.loading = false;
            if (st.timer) { clearTimeout(st.timer); st.timer = null; }
            if (busy(st.data)) st.timer = setTimeout(() => { st.timer = null; if (App.state.route === 'storage') load(); }, 1500);
            refresh();
          });
      };
      if (!st.loaded && !st.loadError) load();
      const act = (p, ok, kind) => p.then((r) => { if (r === undefined) return r; if (ok) ctx.toast(typeof ok === 'function' ? ok(r) : ok, kind || 'ok', 5000); load(); return r; }).catch((err) => { App.fail(err); load(); });

      if (!st.data) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Storage', 'Blob stores, usage against quotas, quarantine, integrity and purges') + (st.loadError ? UI.problem('Storage could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-retry' }) + '</div>' : '<div class="muted">Loading…</div>') + '</div>';
        ctx.on('click', '[data-retry]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      const d = st.data;
      const stores = d.stores.stores, usage = d.usage, quarantine = d.quarantine.items, scanner = d.quarantine.scanner, integ = d.integrity;
      if (st.wantWorkspace) { const u = usage.workspaces.find((w) => w.id === st.wantWorkspace || w.workspace === st.wantWorkspace); if (u) st.selUsage = u.id; st.wantWorkspace = null; }
      const canQuota = App.can('tenant:manage');
      const tabs = UI.tabs([{ id: 'stores', label: 'Stores', count: stores.length }, { id: 'usage', label: 'Usage' }, { id: 'quarantine', label: 'Quarantine', count: quarantine.filter((q) => q.holdsBytes).length }, { id: 'integrity', label: 'Integrity' }, { id: 'purges', label: 'Purges' }], st.tab);
      let body = '', insp = '';

      // ---------------- Stores ----------------
      if (st.tab === 'stores') {
        const blobs = stores.find((s) => s.id === 'blobs');
        const bp = blobs.capacityBytes ? pct(blobs.usedBytes || 0, blobs.capacityBytes) : null;
        if (!stores.some((s) => s.id === st.sel)) st.sel = 'blobs';
        const sel = stores.find((s) => s.id === st.sel);
        const mig = d.stores.migration;
        body += (bp != null && bp > 90 ? UI.notice('<b>Blob store at ' + bp + ' %.</b> ' + esc(size(blobs.usedBytes)) + ' of ' + esc(size(blobs.capacityBytes)) + ' used.', 'warn', UI.btn('Usage by workspace', { size: 'xs', attrs: 'data-tab-go="usage"' })) : '')
          + (blobs.health !== 'ok' ? UI.notice('<b>The blob store does not answer.</b> ' + esc(blobs.detail), 'danger') : '')
          + (blobs.singleNode && !mig ? UI.notice('<b>Filesystem store on one node.</b> BLOB_STORE is <span class="mono">fs</span>; objects live under ' + esc(blobs.location) + ' on this instance only. A second instance needs a shared path or an S3 store.', 'info', UI.btn('BLOB_STORE', { size: 'xs', attrs: 'data-setting="BLOB_STORE"' })) : '')
          + (mig ? migNotice(mig) : '')
          + UI.table(['Store', 'Kind', 'Location', { label: 'Used', right: true }, { label: 'Capacity', right: true }, 'Objects', 'Health', 'Checked'], stores.map((s) => { const p = s.capacityBytes ? pct(s.usedBytes || 0, s.capacityBytes) : null; return { cells: ['<span style="font-weight:600">' + esc(s.name) + '</span>', esc(s.kind), '<span class="mono" style="font-size:12px;overflow-wrap:anywhere">' + esc(s.location) + '</span>', '<span class="num" style="white-space:nowrap">' + esc(s.usedBytes == null ? 'n/a' : size(s.usedBytes)) + '</span>', s.capacityBytes ? '<span class="num" style="white-space:nowrap">' + esc(size(s.capacityBytes)) + ' <span class="' + (tone(p) ? '' : 'muted') + '" style="' + (tone(p) ? 'color:var(--' + tone(p) + '-fg)' : '') + '">' + p + ' %</span></span>' : '<span class="muted">not reported</span>', esc(s.objects), UI.pill(s.health, s.health === 'ok' ? 'ok' : s.health === 'late' ? 'warn' : 'danger'), esc(when(s.checkedAt))], attrs: 'data-store="' + esc(s.id) + '"', selected: s.id === st.sel }; }), { minWidth: '980px' })
          + '<span class="muted" style="font-size:12px">Health is what this instance sees (<span class="mono">/readyz</span> for the blob store and the database); the other rows come from the owning service. Capacity is what the filesystem reports; S3 does not report one.</span>';
        if (sel) {
          const p = sel.capacityBytes ? pct(sel.usedBytes || 0, sel.capacityBytes) : null;
          const g = sel.growth || [];
          insp = '<div class="hstack"><div class="eyebrow grow">Selected store</div>' + UI.pill(sel.health, sel.health === 'ok' ? 'ok' : sel.health === 'late' ? 'warn' : 'danger') + '</div><div style="font-size:15px;font-weight:600">' + esc(sel.name) + '</div><div class="muted" style="font-size:12px;overflow-wrap:anywhere">' + esc(sel.kind) + ', ' + esc(sel.location) + '</div>'
            + (p != null && sel.usedBytes != null ? UI.meter('Used', size(sel.usedBytes) + ' of ' + size(sel.capacityBytes), p, tone(p)) : UI.kv([['Used', esc(sel.usedBytes == null ? 'not counted yet' : size(sel.usedBytes))]].concat(sel.capacityBytes ? [['Capacity', esc(size(sel.capacityBytes)) + (sel.freeBytes != null ? ' <span class="muted">' + esc(size(sel.freeBytes)) + ' free</span>' : '')]] : []), 1))
            + UI.kv([['Objects', esc(sel.objects)], ['Checked', esc(when(sel.checkedAt))]], 1)
            + '<div class="eyebrow">Health detail</div><div class="fg2" style="font-size:12px;overflow-wrap:anywhere">' + esc(sel.detail) + '</div>'
            + '<div class="eyebrow">Settings</div><div class="hstack wrap gap6">' + sel.settings.map((k) => '<button type="button" class="chip mono" data-setting="' + esc(k) + '" title="Open in Configuration">' + esc(k) + '</button>').join('') + '</div>'
            + (g.length >= 2 ? '<div class="hstack"><div class="eyebrow grow">Last ' + g.length + ' days</div><span class="muted" style="font-size:11px">' + esc(size(g[0])) + ' → ' + esc(size(g[g.length - 1])) + '</span></div>' + UI.spark(g, g.length - 1) : '<span class="muted" style="font-size:12px">' + (sel.id === 'blobs' || sel.id === 'db' || sel.id === 'backups' ? 'Growth appears once a few daily samples are recorded.' : 'No growth samples for this store.') + '</span>')
            + '<div class="hstack wrap gap6">' + (sel.verify ? UI.btn('Verify now', { kind: 'primary', size: 'sm', icon: 'check', attrs: 'data-runverify', disabled: !!integ.running }) : '') + (sel.link ? UI.btn(sel.link.label, { size: 'sm', attrs: 'data-link="' + esc(sel.id) + '"' }) : '') + (sel.migrate ? UI.btn('Migrate to another store', { size: 'sm', attrs: 'data-migrate', disabled: !!mig }) : '') + '</div>'
            + (sel.id === 'blobs' ? '<span class="muted" style="font-size:12px">Verify runs the integrity check (Integrity tab). Migrate copies every object to a second store as a job, checking each SHA-256, and switches reads when the copy is complete; the old store stays readable until you retire it.</span>' : '');
        }
      }
      function migNotice(m) {
        if (m.state === 'queued' || m.state === 'copying') return UI.notice('<b>Migration running</b> from ' + esc(m.from) + ' to ' + esc(m.to) + ': ' + (m.objects ? esc(Number(m.copied || 0).toLocaleString('en')) + ' of ' + esc(Number(m.objects).toLocaleString('en')) + ' objects copied' : 'waiting for every instance to copy new writes') + '. Reads stay on the current store until the copy is verified.', 'info', m.jobId && App.screens.jobs ? UI.btn('Open the job', { size: 'xs', attrs: 'data-gojob="' + esc(m.jobId) + '"' }) : '');
        if (m.state === 'switched') return UI.notice('<b>Reads and writes now go to ' + esc(m.to) + '.</b> ' + esc(Number(m.verified || 0).toLocaleString('en')) + ' objects copied and verified; ' + esc(m.from) + ' stays readable for anything the copy missed until you retire it. Update BLOB_STORE in the environment to the new store before the next deployment.', 'ok', UI.btn('Retire the old store', { size: 'xs', attrs: 'data-retire="' + esc(m.id) + '"' }));
        if (m.state === 'failed' || m.state === 'cancelled') return UI.notice('<b>The last migration ' + esc(m.state) + ':</b> ' + esc(m.error || '') + ' Reads and writes stayed on ' + esc(m.from) + '.', 'danger');
        return '';
      }

      // ---------------- Usage ----------------
      if (st.tab === 'usage') {
        const rows = usage.workspaces;
        if (!rows.some((u) => u.id === st.selUsage)) st.selUsage = rows.length ? rows[0].id : null;
        const sel = rows.find((u) => u.id === st.selUsage);
        const over = rows.filter((u) => u.quotaBytes != null && u.quotaUsed > u.quotaBytes);
        const all = rows.reduce((a, u) => a + u.total, 0);
        body += (over.length ? UI.notice('<b>Quota exceeded:</b> ' + over.map((u) => esc(u.workspace) + ' at ' + pct(u.quotaUsed, u.quotaBytes) + ' %').join(', ') + '. Uploads to the workspace answer <span class="mono">413</span> until space is freed or the quota raised.', 'danger', canQuota ? UI.btn('Set quota', { size: 'xs', attrs: 'data-quota="' + esc(over[0].id) + '"' }) : '') : '')
          + '<div class="toolbar">' + UI.seg([{ id: 'workspace', label: 'By workspace' }, { id: 'user', label: 'By user' }, { id: 'kind', label: 'By kind' }], st.usageBy, 'data-usageby') + '<span class="muted right" style="font-size:12px">' + esc(size(all)) + ' across ' + rows.length + ' workspaces</span></div>';
        if (st.usageBy === 'workspace') {
          body += UI.table(['Workspace', { label: 'Files', right: true }, { label: 'Versions', right: true }, { label: 'Trash', right: true }, { label: 'Media', right: true }, { label: 'Knowledge uploads', right: true }, { label: 'Attachments', right: true }, { label: 'Total', right: true }, { label: 'Quota', right: true }, { label: 'Of quota', width: '120px' }], rows.map((u) => { const p = u.quotaBytes ? pct(u.quotaUsed, u.quotaBytes) : null; return { cells: ['<span style="font-weight:600">' + esc(u.workspace) + '</span> ' + UI.label(u.label, { sm: true }) + '<div class="muted" style="font-size:11px">' + esc(u.tenant) + '</div>', sz(u.files), sz(u.versions), sz(u.trash), sz(u.media), sz(u.knowledge), sz(u.attachments), '<span class="num" style="font-weight:600">' + esc(size(u.total)) + '</span>', u.quotaBytes != null ? sz(u.quotaBytes) : '<span class="muted">none</span>', p != null ? UI.meter('', p + ' %', Math.min(100, p), tone(p)) : '<span class="muted">no quota</span>'], attrs: 'data-usage="' + esc(u.id) + '"', selected: u.id === st.selUsage }; }), { minWidth: '900px', emptyTitle: 'No workspaces', emptyText: 'Workspaces appear here with what they hold.' })
            + '<span class="muted" style="font-size:12px">The file quota (B-2403) counts files, versions and trash; media, knowledge uploads and attachments are shown beside it but not counted against it.</span>';
        } else if (st.usageBy === 'user') {
          const list = usage.users; const top = list.length ? list[0].bytes : 0;
          body += UI.table(['User', 'Workspaces', { label: 'Total', right: true }, { label: 'Of the largest', width: '160px' }], list.map((x) => ['<span style="font-weight:600">' + esc(x.name) + '</span>', esc(x.workspaces.join(', ')), '<span class="num">' + esc(size(x.bytes)) + '</span>', UI.meter('', pct(x.bytes, top) + ' %', pct(x.bytes, top), '')]), { clickable: false, minWidth: '700px', emptyTitle: 'Nothing uploaded yet', emptyText: 'Uploads of files, attachments and media are counted by who made them.' }) + '<span class="muted" style="font-size:12px">What a person uploaded as files and versions, attachments and media in every workspace. Quotas apply per workspace, not per user (B-2403).</span>';
        } else {
          const kinds = usage.kinds; const tot = kinds.reduce((a, k) => a + k.bytes, 0);
          body += UI.table(['Kind', { label: 'Total', right: true }, { label: 'Share', right: true }, { label: '', width: '200px' }], kinds.map((k) => [esc(KIND_LABEL[k.kind] || k.kind) + (usage.quotaCounts.indexOf(k.kind) >= 0 ? ' <span class="muted" style="font-size:11px">counts against the quota</span>' : ''), '<span class="num">' + esc(size(k.bytes)) + '</span>', '<span class="num">' + pct(k.bytes, tot) + ' %</span>', UI.meter('', '', pct(k.bytes, tot), '')]), { clickable: false, minWidth: '600px' }) + '<span class="muted" style="font-size:12px">Trash counts against the quota until the purge removes it (FILES_TRASH_DAYS). Versions are kept per file; restoring one makes it the current version.</span>';
        }
        if (sel && st.usageBy === 'workspace') {
          const p = sel.quotaBytes ? pct(sel.quotaUsed, sel.quotaBytes) : null; const g = sel.growth || [];
          insp = '<div class="hstack"><div class="eyebrow grow">Selected workspace</div>' + UI.label(sel.label, { sm: true }) + '</div><div style="font-size:15px;font-weight:600">' + esc(sel.workspace) + '</div><div class="muted" style="font-size:12px">' + esc(sel.tenant) + ' tenant</div>'
            + (p != null ? UI.meter('Of quota', size(sel.quotaUsed) + ' of ' + size(sel.quotaBytes), Math.min(100, p), tone(p)) + (p > 100 ? UI.notice('Uploads are refused with 413. Free space from Files or raise the quota.', 'danger') : p > 80 ? UI.notice('Above 80 %. Members see a warning in Files.', 'warn') : '') : UI.kv([['Quota', 'none set'], ['Counted', esc(size(sel.quotaUsed))]], 1))
            + UI.kv([['Total held', esc(size(sel.total))]], 1)
            + '<div class="eyebrow">Top users</div>' + (sel.users.length ? UI.kv(sel.users.map((x) => [esc(x.name), '<span class="num">' + esc(size(x.bytes)) + '</span>']), 1) : '<span class="muted" style="font-size:12px">Nothing uploaded yet.</span>')
            + (g.length >= 2 ? '<div class="hstack"><div class="eyebrow grow">Last ' + g.length + ' days</div><span class="muted" style="font-size:11px">' + esc(size(g[0])) + ' → ' + esc(size(g[g.length - 1])) + '</span></div>' + UI.spark(g, g.length - 1) : '<span class="muted" style="font-size:12px">Growth appears once a few daily samples are recorded.</span>')
            + '<div class="hstack wrap gap6">' + (canQuota ? UI.btn('Set quota', { kind: 'primary', size: 'sm', attrs: 'data-quota="' + esc(sel.id) + '"' }) : '') + UI.btn('Open Files', { size: 'sm', attrs: 'data-files="' + esc(sel.id) + '"' }) + '</div>'
            + '<span class="muted" style="font-size:12px"><a href="#" data-goaudit="file.quota">Audit entries</a>: file.quota.updated.</span>';
        }
      }
      function sz(n) { return '<span class="num" style="white-space:nowrap">' + esc(size(n)) + '</span>'; }

      // ---------------- Quarantine ----------------
      if (st.tab === 'quarantine') {
        const q = st.qQuery.toLowerCase();
        const rows = quarantine.filter((x) => (st.qState === 'all' || x.state === st.qState) && (!q || (x.object + ' ' + x.workspace + ' ' + x.label + ' ' + (x.by || '')).toLowerCase().indexOf(q) >= 0));
        if (!rows.some((x) => x.kind + ':' + x.id === st.selQ)) st.selQ = rows.length ? rows[0].kind + ':' + rows[0].id : null;
        const sel = quarantine.find((x) => x.kind + ':' + x.id === st.selQ);
        const waiting = quarantine.filter((x) => x.state === 'scanning').length;
        const down = scanner.configured && scanner.reachable === false;
        const refusedText = Object.keys(scanner.refusedToday).length ? Object.keys(scanner.refusedToday).map((k) => scanner.refusedToday[k] + ' ' + k).join(', ') : 'none';
        const states = ['all', 'scanning', 'scan failed', 'timed out', 'infected', 'type mismatch', 'too large', 'above the ceiling', 'refused', 'deleted'];
        body += (down ? UI.notice('<b>ClamAV is unreachable</b> at <span class="mono">' + esc(scanner.host) + '</span>' + (scanner.error ? ' (' + esc(scanner.error) + ')' : '') + '. Uploads stay in quarantine and nothing is released unscanned; ' + waiting + ' objects wait. Rescan works again once the daemon answers.', 'danger', UI.btn('CLAMD_HOST', { size: 'xs', attrs: 'data-setting="CLAMD_HOST"' })) : '')
          + '<div class="grid2">' + UI.panel('Scanner', UI.kv([['Daemon', scanner.configured ? '<span class="mono">' + esc(scanner.host) + '</span> <span class="muted">(CLAMD_HOST, CLAMD_PORT)</span>' : '<span class="muted">none: CLAMD_HOST is unset, uploads get the type check only</span>'], ['Reachable', !scanner.configured ? UI.pill('not configured', 'outline') : scanner.reachable ? UI.pill('yes', 'ok') + ' <span class="muted">answered PING just now</span>' : UI.pill('no', 'danger')], ['Signature database', scanner.signatures ? esc((scanner.engine || '') + ', daily ' + scanner.signatures.version + ', ' + scanner.signatures.date) : '<span class="muted">' + (scanner.configured ? 'not reported' : 'none') + '</span>'], ['Scanned today', num(scanner.scannedToday) + ' objects'], ['Refused today', esc(refusedText)], ['Scans failed today', num(scanner.failedToday)]], 2))
          + UI.panel('How quarantine works', '<div class="fg2" style="font-size:12px">Every upload is streamed to quarantine first: the type check compares the declared type with the content, the size cap applies, then ClamAV scans it when one is configured. Only a clean object moves into the store and becomes readable; a refusal deletes the bytes and the uploader is told why. Objects in quarantine count against the workspace quota.</div>') + '</div>'
          + '<div class="toolbar">' + UI.search('Filter by object, workspace, uploader', 'data-qsearch', st.qQuery) + '<span class="relative">' + UI.btn(st.qState === 'all' ? 'State' : 'State: ' + st.qState, { size: 'sm', icon: 'filter', attrs: 'data-menu="qstate" aria-haspopup="menu"', cls: st.qState !== 'all' ? 'active' : '' }) + '</span><span class="muted right" style="font-size:12px">' + rows.length + ' shown, ' + waiting + ' waiting</span></div>'
          + UI.table(['Object', 'Kind', 'Workspace', { label: 'Size', right: true }, 'State', 'Age', 'Uploaded by'], rows.map((x) => ({ cells: ['<span class="mono" style="font-size:12px;overflow-wrap:anywhere">' + esc(x.object) + '</span>', esc(x.label), esc(x.workspace), '<span class="num">' + esc(size(x.size)) + '</span>', UI.pill(x.state, qKind(x.state)), esc(ago(x.at)), esc(x.by || 'a source sync')], attrs: 'data-q="' + esc(x.kind + ':' + x.id) + '"', selected: x.kind + ':' + x.id === st.selQ })), { minWidth: '860px', emptyTitle: 'Quarantine is empty', emptyText: 'Nothing is waiting for a scan and nothing was refused in the last 24 hours.' });
        if (sel) {
          insp = '<div class="hstack"><div class="eyebrow grow">Quarantined object</div>' + UI.pill(sel.state, qKind(sel.state)) + '</div><div class="mono" style="font-size:13px;font-weight:600;overflow-wrap:anywhere">' + esc(sel.object) + '</div>'
            + UI.kv([['Kind', esc(sel.label)], ['Workspace', esc(sel.workspace)], ['Size', esc(size(sel.size))], ['Age', esc(ago(sel.at))], ['Uploaded by', esc(sel.by || 'a source sync')], ['Bytes held', sel.holdsBytes ? 'in quarantine, unreadable' : 'none: never released']], 2)
            + '<div class="eyebrow">What happened</div><div class="fg2" style="font-size:12px">' + esc(sel.detail || '') + '</div>'
            + (sel.state === 'scanning' && down ? UI.notice('Waits for the scanner. Rescan is refused (503) while ClamAV is unreachable.', 'danger') : '')
            + '<div class="hstack wrap gap6">' + UI.btn('Rescan', { kind: 'primary', size: 'sm', icon: 'refresh', attrs: 'data-rescan', disabled: !sel.canRescan || down }) + UI.btn('Delete', { kind: 'danger', size: 'sm', icon: 'trash', attrs: 'data-qdelete', disabled: !sel.canDelete }) + (sel.state === 'infected' && App.can('flags:review') ? UI.btn('Open flags', { size: 'sm', attrs: 'data-goflags' }) : '') + '</div>'
            + '<span class="muted" style="font-size:12px">Nothing here can be released by hand; a clean rescan releases it. <a href="#" data-goaudit="file.quarantine">Audit entries</a>: file.quarantine.rescanned, file.quarantine.deleted.</span>';
        }
      }

      // ---------------- Integrity ----------------
      if (st.tab === 'integrity') {
        const lv = integ.last; const run = integ.running; const findings = integ.findings;
        const openOrphans = findings.filter((f) => f.kind === 'orphan' && f.state === 'open');
        const missing = findings.filter((f) => f.kind === 'missing' && f.state === 'open');
        if (st.dryRun && (Date.now() > st.dryRun.expiresAt || !lv || st.dryRun.run !== lv.id)) st.dryRun = null;
        body += (run ? UI.notice('<b>Verification ' + esc(run.state) + '</b>' + (run.jobId ? ' as job <span class="mono">' + esc(run.jobId) + '</span>' : '') + (run.checksums ? ', comparing checksums' : '') + '. The findings below are replaced when it finishes.', 'info', run.jobId && App.screens.jobs ? UI.btn('Open the job', { size: 'xs', attrs: 'data-gojob="' + esc(run.jobId) + '"' }) : '') : '')
          + (lv && lv.orphans > 100 && openOrphans.length ? UI.notice('<b>' + Number(lv.orphans).toLocaleString('en') + ' orphans and ' + lv.missing + ' missing objects</b> in the last run. Orphans take space nobody can reach; missing objects mean a file version or upload cannot be opened until it is restored from a backup.', 'warn') : '')
          + (lv && lv.missing ? UI.notice('<b>' + lv.missing + ' missing ' + (lv.missing === 1 ? 'object' : 'objects') + '.</b> A row names an object the store does not have; it cannot be opened until it is restored from a backup.', 'danger', UI.btn('Restore from backup', { size: 'xs', attrs: 'data-restore' })) : '')
          + '<div class="grid2">' + UI.panel('Last verification', lv ? UI.kv([['When', esc(when(lv.finishedAt)) + ' <span class="muted">(ops.blobs.verify' + (integ.everyMinutes ? ', every ' + esc(integ.everyMinutes >= 1440 && integ.everyMinutes % 1440 === 0 ? (integ.everyMinutes / 1440) + ' day' + (integ.everyMinutes > 1440 ? 's' : '') : integ.everyMinutes + ' min') : ', schedule off') + ')</span>'], ['Duration', esc(dur((lv.finishedAt || 0) - (lv.startedAt || lv.createdAt)))], ['Objects checked', num(lv.objects) + ' <span class="muted">' + esc(size(lv.bytes)) + '</span>'], ['Missing', '<span class="num" style="' + (lv.missing ? 'color:var(--danger-fg)' : '') + '">' + lv.missing + '</span> <span class="muted">referenced, not in the store</span>'], ['Orphans', '<span class="num" style="' + (openOrphans.length ? 'color:var(--warn-fg)' : '') + '">' + Number(openOrphans.length ? lv.orphans : 0).toLocaleString('en') + '</span> <span class="muted">in the store, referenced by nothing' + (lv.orphanBytes ? ', ' + esc(size(lv.orphanBytes)) : '') + '</span>'], ['Checksum mismatches', lv.checksums ? '<span class="num" style="' + (lv.mismatches ? 'color:var(--danger-fg)' : '') + '">' + lv.mismatches + '</span>' : '<span class="muted">not compared in this run</span>']], 2) : UI.empty('No verification yet', 'Run one to count the objects and find missing and orphaned ones.'), { actions: UI.btn(run ? 'Running' : 'Run verification', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-runverify', disabled: !!run }) })
          + UI.panel('What the check does', '<div class="fg2" style="font-size:12px">Lists every object in the blob store and walks every row of every table. A row naming an object the store does not have is <b>missing</b>; an object older than ' + integ.graceHours + ' h that no row references is an <b>orphan</b>; with checksums on, an object whose SHA-256 changed without the server writing it is a <b>mismatch</b>. Backups and mirror files are never orphans. The check never deletes anything; the actions below act on its report.</div>' + (st.dryRun ? UI.notice('<b>Dry run:</b> ' + st.dryRun.count.toLocaleString('en') + ' orphans, ' + esc(size(st.dryRun.bytes)) + (st.dryRun.oldest ? ', oldest ' + esc(when(st.dryRun.oldest)) : '') + (st.dryRun.skipped ? '; ' + st.dryRun.skipped + ' skipped as gone or referenced again' : '') + '. Nothing was deleted. Confirm within ' + integ.dryRunMinutes + ' minutes with a reason.', 'info') : '')) + '</div>'
          + UI.table(['Finding', 'Object', 'Referenced by', { label: 'Size', right: true }, 'Found', { label: '', right: true }], findings.map((f) => [UI.pill(f.state === 'open' ? f.kind : f.kind + ', ' + f.state, f.state === 'open' ? fKind(f.kind) : ''), '<span class="mono" style="font-size:12px;overflow-wrap:anywhere">' + esc(f.object) + '</span>', esc(f.referencedBy ? f.referencedBy.map((r) => r.table + '.' + r.column + (r.id ? ' ' + r.id : '')).join(', ') : f.kind === 'orphan' ? 'nothing' : ''), '<span class="num">' + esc(f.size == null ? '' : size(f.size)) + '</span>', esc(when(f.foundAt)), f.state !== 'open' ? '<span class="muted" style="font-size:12px">' + esc(f.note || '') + '</span>' : f.kind === 'orphan' ? UI.btn('Delete', { size: 'xs', kind: 'ghost', attrs: 'data-delorphan="' + esc(f.id) + '"' }) : f.kind === 'missing' ? UI.btn('Restore from backup', { size: 'xs', kind: 'ghost', attrs: 'data-restore' }) : UI.btn('Accept current', { size: 'xs', kind: 'ghost', attrs: 'data-accept="' + esc(f.id) + '"' })]), { clickable: false, minWidth: '900px', emptyTitle: 'No findings', emptyText: lv ? 'The last run found every reference and every object in agreement.' : 'Run a verification to see findings here.' })
          + '<div class="hstack wrap gap6">' + UI.btn(st.dryRun ? 'Delete orphans (confirm)' : 'Delete orphans (dry run)', { size: 'sm', kind: st.dryRun ? 'danger' : undefined, icon: 'trash', attrs: 'data-delorphans', disabled: !openOrphans.length }) + UI.btn('Restore missing from backup', { size: 'sm', attrs: 'data-restore', disabled: !missing.length }) + '<span class="muted" style="font-size:12px">Deleting orphans asks for a reason and is audited as platform.blobs.orphans.deleted with the list of objects (decision Q10). Restoring opens Platform › Backups.</span></div>';
      }

      // ---------------- Purges ----------------
      if (st.tab === 'purges') {
        body += UI.table(['What', 'Policy set in', 'Job', 'Period', 'Last run', 'Removed', 'Next run'], d.purges.map((p, i) => ['<span style="font-weight:600">' + esc(p.what) + '</span><div class="muted" style="font-size:11px">' + esc(p.policy) + '</div>', '<a href="#" data-purgewhere="' + i + '">' + esc(p.where.label) + '</a>', '<span class="mono">' + esc(p.job) + '</span>', p.everyMinutes > 0 ? esc('every ' + (p.everyMinutes % 1440 === 0 ? (p.everyMinutes / 1440) + ' day' + (p.everyMinutes > 1440 ? 's' : '') : p.everyMinutes % 60 === 0 ? (p.everyMinutes / 60) + ' h' : p.everyMinutes + ' min')) + (p.setting ? ' <span class="muted mono" style="font-size:11px">(' + esc(p.setting) + ')</span>' : '') : UI.pill('off', 'outline') + (p.setting ? ' <span class="muted mono" style="font-size:11px">(' + esc(p.setting) + ' = 0)</span>' : ''), p.lastRun ? esc(when(p.lastRun)) + (p.lastState === 'failed' ? ' ' + UI.pill('failed', 'danger') : '') : '<span class="muted">not yet</span>', esc(p.removed || ''), p.nextRun ? esc(when(p.nextRun)) : '<span class="muted">off</span>']), { clickable: false, minWidth: '1000px' })
          + UI.notice('Purges run as scheduled jobs. Changing a period means changing the setting named in the row; the policy itself (how long to keep things) is set where the row links.' + (App.screens.jobs ? ' Jobs and queues › Schedules runs one now.' : ''), 'info', App.screens.jobs ? UI.btn('Open Schedules', { size: 'xs', attrs: 'data-goschedules' }) : '');
      }

      const firstQuota = (usage.workspaces.find((u) => u.id === st.selUsage) || usage.workspaces[0] || {}).id || '';
      root.innerHTML = '<div class="page">' + UI.pagehead('Storage', 'Blob stores, usage against quotas, quarantine, integrity and purges', UI.btn('Run integrity check', { attrs: 'data-runverify', disabled: !!integ.running }) + (canQuota && firstQuota ? UI.btn('Set a workspace quota', { kind: 'primary', attrs: 'data-quota="' + esc(firstQuota) + '"' }) : '')) + tabs + body + '</div>' + (insp ? '<aside class="inspector w360" aria-label="Details">' + insp + '</aside>' : '');

      // ---------- handlers ----------
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-tab-go]', (e, t) => { st.tab = t.dataset.tabGo; ctx.rerender(); });
      ctx.on('click', 'tr[data-store]', (e, t) => { st.sel = t.dataset.store; ctx.rerender(); });
      ctx.on('click', 'tr[data-usage]', (e, t) => { st.selUsage = t.dataset.usage; ctx.rerender(); });
      ctx.on('click', 'tr[data-q]', (e, t) => { st.selQ = t.dataset.q; ctx.rerender(); });
      ctx.on('click', '[data-usageby]', (e) => { const b = e.target.closest('[data-seg]'); if (b) { st.usageBy = b.dataset.seg; ctx.rerender(); } });
      ctx.on('input', 'input[data-qsearch]', (e, t) => { st.qQuery = t.value; ctx.rerender(); });
      ctx.on('click', '[data-menu="qstate"]', (e, t) => menu(ctx, t, [['all', 'Any state'], ['scanning', 'scanning'], ['scan failed', 'scan failed'], ['timed out', 'timed out'], ['infected', 'infected'], ['type mismatch', 'type mismatch'], ['too large', 'too large'], ['above the ceiling', 'above the ceiling'], ['refused', 'refused'], ['deleted', 'deleted']], st.qState, (v) => { st.qState = v; ctx.rerender(); }));
      ctx.on('click', '[data-setting]', (e, t) => { e.preventDefault(); go(ctx, 'configuration', { q: t.dataset.setting }); });
      ctx.on('click', '[data-link]', (e, t) => { const s = stores.find((x) => x.id === t.dataset.link); if (s && s.link) go(ctx, s.link.route, s.link.params); });
      ctx.on('click', '[data-files]', () => go(ctx, 'files', {}));
      ctx.on('click', '[data-goflags]', () => go(ctx, 'flags', {}));
      ctx.on('click', '[data-goaudit]', (e, t) => { e.preventDefault(); go(ctx, 'usage-audit', { tab: 'audit', q: t.dataset.goaudit }); });
      ctx.on('click', '[data-goschedules]', () => go(ctx, 'jobs', { tab: 'schedules' }));
      ctx.on('click', '[data-gojob]', (e, t) => go(ctx, 'jobs', { tab: 'jobs', q: t.dataset.gojob }));
      ctx.on('click', '[data-purgewhere]', (e, t) => { e.preventDefault(); const p = d.purges[+t.dataset.purgewhere]; go(ctx, p.where.route, p.where.params); });
      ctx.on('click', '[data-restore]', () => go(ctx, 'platform', { tab: 'backups' }));

      const runVerify = () => ctx.modal({ title: 'Run verification ' + UI.pill('read only', 'info'),
        body: '<p class="fg2" style="margin:0">Lists every object in the blob store and walks every reference as job ops.blobs.verify. Nothing is changed; the findings replace the table when it finishes.' + (integ.last ? ' The last run took ' + esc(dur((integ.last.finishedAt || 0) - (integ.last.startedAt || integ.last.createdAt))) + '.' : '') + '</p>'
          + UI.kv([['Store', esc(d.stores.active.label)], ['Objects', integ.last ? esc(Number(integ.last.objects).toLocaleString('en')) : 'not counted yet']], 2)
          + UI.check('Also compare checksums (reads every byte)', false, 'data-vsums'),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Start', { kind: 'primary', attrs: 'data-vgo' }),
        onMount(m) { m.querySelector('[data-vgo]').addEventListener('click', () => { const cb = m.querySelector('[data-vsums] input') || m.querySelector('[data-vsums]'); const sums = !!(cb && (cb.checked || cb.getAttribute('aria-checked') === 'true' || cb.classList.contains('on'))); App.closeOverlay(); st.tab = 'integrity'; act(App.post('/api/admin/storage/integrity/verify', { checksums: sums }), (r) => 'Verification queued as job ' + esc(r.jobId || '') + '. Audit event written.'); }); },
        onClose() { if (st.dirty) { st.dirty = false; refresh(); } } });
      ctx.on('click', '[data-runverify]', runVerify);
      if (st.openVerify) { st.openVerify = false; setTimeout(runVerify, 60); }

      ctx.on('click', '[data-migrate]', () => {
        const blobs = stores.find((s) => s.id === 'blobs');
        ctx.modal({ cls: 'wide', title: 'Migrate to another store',
          body: '<p class="fg2" style="margin:0">Copies every object from the current store to the target as job ops.blobs.migrate, checking each SHA-256 on arrival, while the current store keeps serving and every instance copies new writes to the target too. When the copy is complete and verified, reads and writes switch to the target; the old store stays readable until you retire it. Needs a recent sign-in.</p>'
            + UI.kv([['From', esc(d.stores.active.label)], ['Objects', esc(blobs.objects)]], 2)
            + '<div class="formgrid">' + UI.field('Target', UI.select([{ value: 's3', label: 'S3-compatible bucket' }, { value: 'fs', label: 'Filesystem directory (one instance, or a shared path)' }], 's3', 'data-mkind'))
            + '<div data-ms3>' + UI.field('Endpoint', UI.input('', { attrs: 'data-mendpoint', placeholder: 'https://minio.internal:9000' })) + UI.field('Bucket', UI.input('', { attrs: 'data-mbucket', placeholder: 'exprsn-blobs-2' })) + UI.field('Region', UI.input('us-east-1', { attrs: 'data-mregion' })) + UI.field('Access key id', UI.input('', { attrs: 'data-mkey autocomplete="off"' })) + UI.field('Secret access key', UI.input('', { type: 'password', attrs: 'data-msecret autocomplete="new-password"' }), 'Sealed with the platform key; never shown again.') + '</div>'
            + '<div data-mfs hidden>' + UI.field('Directory', UI.input('', { attrs: 'data-mdir', placeholder: '/mnt/blobs' }), 'An absolute path every instance can reach.') + '</div>'
            + UI.field('Reason', UI.textarea('', { rows: 2, attrs: 'data-mreason', placeholder: 'Why the store moves' }), 'Required; written to the audit chain.') + '</div><div data-merr role="alert"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Start migration', { kind: 'primary', attrs: 'data-mgo' }),
          onMount(m) {
            const kindSel = m.querySelector('[data-mkind]');
            const sync = () => { const fs = kindSel.value === 'fs'; m.querySelector('[data-ms3]').hidden = fs; m.querySelector('[data-mfs]').hidden = !fs; };
            kindSel.addEventListener('change', sync); sync();
            m.querySelector('[data-mgo]').addEventListener('click', async () => {
              const v = (s) => m.querySelector(s).value.trim();
              const reason = v('[data-mreason]'); const err = m.querySelector('[data-merr]');
              if (reason.length < 3) { err.innerHTML = UI.notice('Give a reason of at least 3 characters.', 'warn'); return; }
              const bodyOut = kindSel.value === 'fs' ? { kind: 'fs', dir: v('[data-mdir]'), reason } : { kind: 's3', endpoint: v('[data-mendpoint]'), bucket: v('[data-mbucket]'), region: v('[data-mregion]') || undefined, accessKeyId: v('[data-mkey]'), secretAccessKey: m.querySelector('[data-msecret]').value, reason };
              try {
                const r = await withStepUp(ctx, () => App.post('/api/admin/storage/migrations', bodyOut));
                if (r === undefined) return;
                App.closeOverlay(); st.tab = 'stores'; ctx.toast('Migration to ' + esc(r.to) + ' queued. Audit event written.', 'ok', 6000); load();
              } catch (e) { err.innerHTML = UI.problem(e.problem && e.problem.title || 'Refused', (e.problem && e.problem.detail) || e.message, e.problem && e.problem.trace_id); }
            });
          },
          onClose() { if (st.dirty) { st.dirty = false; refresh(); } } });
      });
      ctx.on('click', '[data-retire]', (e, t) => askReason(ctx, { title: 'Retire the old store', tag: 'final', tone: 'danger', body: '<p class="fg2" style="margin:0">Stops reading anything from the old store. Every object was copied and verified when the migration switched; an object only the old store has (written by something outside the server) is no longer found. Nothing is deleted from the old store.</p>', ok: 'Retire', placeholder: 'Why the old store can go' }).then((reason) => {
        if (reason == null) return;
        act(withStepUp(ctx, () => App.post('/api/admin/storage/migrations/' + encodeURIComponent(t.dataset.retire) + '/retire', { reason })), 'The old store is retired; reads come from the new one only. Audit event written.');
      }));

      const quota = (id) => {
        const u = usage.workspaces.find((x) => x.id === id) || usage.workspaces[0]; if (!u) return;
        ctx.modal({ title: 'Set quota for ' + esc(u.workspace),
          body: '<p class="fg2" style="margin:0">Applies to files, versions and trash in the workspace (B-2403). Above it, uploads are refused with <span class="mono">413</span> and members see the reason in Files.</p>' + UI.field('Quota (GiB)', UI.input(u.quotaBytes != null ? String(Math.round((u.quotaBytes / GIB) * 100) / 100) : '', { type: 'number', attrs: 'data-quotaval min="0" step="0.1" placeholder="no quota"' }), 'Counted now: ' + size(u.quotaUsed) + '. Leave empty for no quota.') + UI.notice('A quota below the current use refuses every new upload until space is freed; nothing is deleted.', 'info') + '<div data-qerr role="alert"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save quota', { kind: 'primary', attrs: 'data-savequota' }),
          onMount(m) { m.querySelector('[data-savequota]').addEventListener('click', () => {
            const raw = m.querySelector('[data-quotaval]').value.trim(); const v = raw === '' ? null : Number(raw);
            if (v != null && (!isFinite(v) || v < 0)) { m.querySelector('[data-qerr]').innerHTML = UI.notice('Enter a quota of 0 GiB or more, or leave it empty.', 'warn'); return; }
            const bytes = v == null ? null : Math.round(v * GIB);
            App.closeOverlay(); st.tab = 'usage'; st.usageBy = 'workspace'; st.selUsage = u.id;
            act(App.api('PUT', '/api/admin/tenants/' + encodeURIComponent(u.tenantId) + '/workspaces/' + encodeURIComponent(u.id) + '/file-quota', { maxBytes: bytes }), esc(u.workspace) + (bytes == null ? ' has no quota now.' : ' quota set to ' + size(bytes) + (u.quotaUsed > bytes ? '; uploads are refused until use falls below it' : '') + '.') + ' Audit event written.', bytes != null && u.quotaUsed > bytes ? 'warn' : 'ok');
          }); },
          onClose() { if (st.dirty) { st.dirty = false; refresh(); } } });
      };
      ctx.on('click', '[data-quota]', (e, t) => quota(t.dataset.quota));
      if (st.openQuota) { st.openQuota = false; if (canQuota) setTimeout(() => quota(st.selUsage || firstQuota), 60); }

      const selQ = () => quarantine.find((x) => x.kind + ':' + x.id === st.selQ);
      ctx.on('click', '[data-rescan]', () => { const q = selQ(); if (!q) return; ctx.confirm({ title: 'Rescan ' + q.object, tone: 'info', body: '<p class="fg2" style="margin:0">Runs the type check and ClamAV again on the quarantined bytes. A clean result moves the object into the store and releases it; a refusal deletes the bytes and records the reason.</p>', kv: [['Workspace', esc(q.workspace)], ['Size', esc(size(q.size))]], ok: 'Rescan' }).then((ok) => { if (!ok) return; act(App.post('/api/admin/storage/quarantine/' + q.kind + '/' + encodeURIComponent(q.id) + '/rescan'), esc(q.object) + ' queued for another scan. Audit event written.'); }); });
      ctx.on('click', '[data-qdelete]', () => { const q = selQ(); if (!q) return; askReason(ctx, { title: 'Delete ' + q.object, tag: 'destructive', tone: 'danger', required: false, body: '<p class="fg2" style="margin:0">Removes the quarantined bytes and refuses the upload. Nothing was ever released, so no file, message or record changes; the uploader sees the refusal.</p>', kv: [['Workspace', esc(q.workspace)], ['State', esc(q.state)]], ok: 'Delete', placeholder: 'Why it goes' }).then((reason) => { if (reason == null) return; act(App.post('/api/admin/storage/quarantine/' + q.kind + '/' + encodeURIComponent(q.id) + '/delete', { reason: reason || null }), esc(q.object) + ' deleted from quarantine. Audit event written.'); }); });

      const confirmDelete = (dry) => askReason(ctx, { title: 'Delete ' + dry.count.toLocaleString('en') + (dry.count === 1 ? ' orphan' : ' orphans'), tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">Deletes exactly the objects the dry run listed. They are referenced by nothing, so no file, upload or output changes; the space is freed in the store. The reason goes into the audit chain with the list of objects.</p>' + (dry.keys && dry.keys.length ? '<div class="codebox mono" style="font-size:11px;max-height:120px;overflow:auto">' + dry.keys.slice(0, 20).map(esc).join('<br>') + (dry.count > 20 ? '<br>and ' + (dry.count - 20) + ' more' : '') + '</div>' : ''), kv: [['Objects', dry.count.toLocaleString('en')], ['Size', esc(size(dry.bytes))]], ok: 'Delete orphans', placeholder: 'Why these objects can go' }).then((reason) => {
        if (reason == null) return;
        const id = dry.id; st.dryRun = null;
        act(App.post('/api/admin/storage/orphans/delete', { dryRun: id, reason }), (r) => r.deleted.toLocaleString('en') + (r.deleted === 1 ? ' orphan' : ' orphans') + ' deleted; ' + size(r.bytes) + ' freed' + (r.failed ? '; ' + r.failed + ' could not be deleted' : '') + '. Audit event platform.blobs.orphans.deleted written.', 'ok');
      });
      ctx.on('click', '[data-delorphans]', () => {
        if (st.dryRun) { confirmDelete(st.dryRun); return; }
        App.post('/api/admin/storage/orphans/dry-run').then((r) => { st.dryRun = Object.assign({ run: integ.last && integ.last.id }, r); ctx.rerender(); ctx.toast('Dry run: ' + r.count.toLocaleString('en') + (r.count === 1 ? ' orphan' : ' orphans') + ', ' + size(r.bytes) + ', would be deleted. Nothing changed.', '', 5000); }).catch((err) => App.fail(err, 'Dry run refused'));
      });
      ctx.on('click', '[data-delorphan]', (e, t) => {
        const f = integ.findings.find((x) => x.id === t.dataset.delorphan); if (!f) return;
        App.post('/api/admin/storage/orphans/dry-run', { objects: [f.object] }).then((r) => confirmDelete(r)).catch((err) => { App.fail(err, 'Dry run refused'); load(); });
      });
      ctx.on('click', '[data-accept]', (e, t) => {
        const f = integ.findings.find((x) => x.id === t.dataset.accept); if (!f) return;
        askReason(ctx, { title: 'Accept the current checksum', tone: 'info', body: '<p class="fg2" style="margin:0">Takes the object\'s SHA-256 as it is now as the one to compare against from now on. Do this only when you know why the bytes changed (restored by hand, re-sealed); otherwise restore the object from a backup.</p>', kv: [['Object', '<span class="mono" style="overflow-wrap:anywhere">' + esc(f.object) + '</span>'], ['Recorded', '<span class="mono">' + esc((f.expected || '').slice(0, 16)) + '</span>'], ['Now', '<span class="mono">' + esc((f.actual || '').slice(0, 16)) + '</span>']], ok: 'Accept', placeholder: 'Why the change is expected' }).then((reason) => { if (reason == null) return; act(App.post('/api/admin/storage/findings/' + encodeURIComponent(f.id) + '/accept', { reason }), 'Checksum accepted. Audit event written.'); });
      });
    }
  });
})();
