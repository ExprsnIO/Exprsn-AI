/*
 * 1.9.0, Sprint 49 (B-153, B-154): Settings › Notifications, and the tenant's notification defaults and templates.
 *
 * - A panel of the Settings screen (`App.settingsPanels`): a table of notification kinds × channels (in the app,
 *   email, push, WebSocket), each cell a named checkbox ("Email for Workflows") and a "when" select (at once, or an
 *   hourly, daily or weekly digest); quiet hours per weekday in the person's time zone, with urgent notifications let
 *   through or not; the digest hour and weekday. Mandatory kinds are locked (disabled controls, a "Mandatory" label and
 *   the reason). When a tenant admin applied a template, it says which one and how many kinds the person changed since.
 * - The table: kinds in their catalogue groups, each group a disclosure (a button with aria-expanded, Expand all and
 *   Collapse all above); Enable all and Disable all for the whole table, per group and per channel, which change the
 *   form only (the person saves, as before) and leave mandatory kinds as they are, saying so in a polite status line.
 *   Titles wrap with the description under them; below 760 px of width each kind becomes a stacked block with its
 *   channels in a grid, still the same table for assistive technology.
 * - `App.tenantNotificationDefaults`: the same table for a tenant admin (tenant:manage) with a "Mandatory" column,
 *   rendered by the Tenants screen as its "Notifications" tab, and the tenant's notification templates under it:
 *   made, edited (a new version each time) and deleted there, applied to people, a role, a group or everyone, and one
 *   of them given to new members. Security alerts are mandatory everywhere.
 *
 * Changes are kept in a draft until saved, so a re-render of the screen (another panel loading) keeps them.
 */
(function () {
  const { UI, esc } = App;
  const CH = [['in_app', 'In the app'], ['email', 'Email'], ['push', 'Push'], ['websocket', 'Live (WebSocket)']];
  const TM = [{ value: 'instant', label: 'At once' }, { value: 'hourly', label: 'Hourly digest' }, { value: 'daily', label: 'Daily digest' }, { value: 'weekly', label: 'Weekly digest' }];
  const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const cssq = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const names = (list) => (list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]);

  const STYLE = '<style>'
    + '#main .sn-wrap{container-type:inline-size;display:flex;flex-direction:column;gap:8px;min-width:0}'
    + '#main .sn-tools{display:flex;flex-direction:column;gap:6px}'
    + '#main .sn-chtools{display:flex;flex-wrap:wrap;gap:6px 14px}'
    + '#main .sn-chtool{display:flex;flex-wrap:wrap;align-items:center;gap:4px}'
    + '#main .sn-chname{font-size:12px;color:var(--fg2);margin-right:2px}'
    + '#main .sn-sep{width:1px;align-self:stretch;background:var(--line);margin:0 4px}'
    + '#main .sn-live{font-size:12px;color:var(--fg2);min-height:1em}'
    + '#main table.dt.sn-matrix{min-width:0;table-layout:auto}'
    + '#main .sn-matrix thead th{white-space:normal}'
    + '#main .sn-matrix th.sn-kind{font-weight:400;text-align:left;text-transform:none;letter-spacing:normal;font-size:13px;color:var(--fg);white-space:normal;min-width:180px;vertical-align:top}'
    + '#main .sn-matrix .sn-title{display:block;font-weight:600;overflow-wrap:anywhere}'
    + '#main .sn-matrix .sn-desc,#main .sn-tpl .sn-desc{display:block;font-size:12px;color:var(--fg2);overflow-wrap:anywhere;margin-top:2px}'
    + '#main .sn-matrix .sn-lock{display:block;font-size:12px;color:var(--fg2);margin-top:2px;overflow-wrap:anywhere}'
    + '#main .sn-matrix td{vertical-align:top;white-space:normal}'
    + '#main .sn-matrix .sn-cell{display:flex;flex-wrap:wrap;align-items:center;gap:6px}'
    + '#main .sn-matrix select{flex:none;width:auto;max-width:none}'
    + '#main .sn-matrix th.sn-group{text-align:left;background:var(--panel2);text-transform:none;letter-spacing:normal;font-size:13px;color:var(--fg);white-space:normal}'
    + '#main .sn-gbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px}'
    + '#main .sn-disc{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:4px 2px;font:inherit;font-weight:600;color:var(--fg);cursor:pointer;border-radius:4px;text-align:left}'
    + '#main .sn-disc:focus-visible{outline:var(--focus-w) solid var(--focus);outline-offset:2px}'
    + '#main .sn-count{font-weight:400;color:var(--fg2);font-size:12px}'
    + '#main .sn-gacts{display:inline-flex;flex-wrap:wrap;gap:4px}'
    + '#main .sn-matrix tr[hidden]{display:none!important}'
    + '@container (max-width: 760px){'
    + '#main .sn-matrix,#main .sn-matrix tbody,#main .sn-matrix tr,#main .sn-matrix th,#main .sn-matrix td{display:block;width:auto}'
    + '#main .sn-matrix thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}'
    + '#main .sn-matrix tr.sn-krow{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px 12px;padding:10px 4px;border-bottom:1px solid var(--line2)}'
    + '#main .sn-matrix tr.sn-krow>th{grid-column:1/-1;padding:0;border:0;min-width:0}'
    + '#main .sn-matrix tr.sn-krow>td{padding:0;border:0}'
    + '#main .sn-matrix tr.sn-krow>td::before{content:attr(data-label);display:block;font-size:12px;color:var(--fg2);margin-bottom:2px}'
    + '#main .sn-matrix th.sn-group{border-bottom:1px solid var(--line)}'
    + '}'
    + '#main .sn-quiet td{white-space:nowrap}#main .sn-quiet input[type=time]{max-width:120px}'
    // The apply dialog sits outside #main; its radios are 24 px targets (WCAG 2.5.8).
    + '.sn-mode{border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}.sn-mode legend{font-size:12px;font-weight:600;margin-bottom:4px}.sn-mode .check{min-height:24px;align-items:center}.sn-mode input[type=radio]{width:24px;height:24px;flex:none}'
    + '</style>';

  /** The choice shown for a kind and channel: the draft's, else the loaded one. */
  const shown = (st, k, c) => (st.draft.kinds[k.id] && st.draft.kinds[k.id][c]) || k.channels[c];
  const put = (st, kind, c, patch) => {
    const d = st.draft.kinds[kind.id] || (st.draft.kinds[kind.id] = {});
    d[c] = Object.assign({}, shown(st, kind, c), patch);
  };
  const groupsOf = (kinds) => {
    const groups = [];
    kinds.forEach((k) => { let g = groups.find((x) => x.name === k.group); if (!g) groups.push(g = { name: k.group, kinds: [] }); g.kinds.push(k); });
    return groups;
  };
  /** Whether a kind's channels stay as they are (a mandatory kind: always on, at once). */
  const lockedOf = (st, o, k) => (o.tenant ? !!k.locked || !!(st.draft.mandatory[k.id] != null ? st.draft.mandatory[k.id] : k.mandatory) : !!k.mandatory);

  /**
   * The kinds × channels table with its tools. `o`: `mid` (which matrix, for ids and handlers), `tenant` (adds the
   * Mandatory column), `label` (the tools' group name), `caption`.
   */
  const matrix = (st, o) => {
    const mid = o.mid, tenant = !!o.tenant;
    st.collapsed = st.collapsed || {};
    const m = ' data-m="' + mid + '"';
    const cols = (tenant ? 1 : 0) + CH.length + 1;
    const tools = '<div class="sn-tools" role="group" aria-label="' + esc(o.label) + ': change many kinds at once">'
      + '<div class="hstack gap6 wrap">' + UI.btn('Expand all', { kind: 'ghost', size: 'sm', attrs: 'data-snexpand="1"' + m }) + UI.btn('Collapse all', { kind: 'ghost', size: 'sm', attrs: 'data-snexpand="0"' + m })
      + '<span class="sn-sep" aria-hidden="true"></span>' + UI.btn('Enable all', { size: 'sm', attrs: 'data-snbulk="on"' + m }) + UI.btn('Disable all', { size: 'sm', attrs: 'data-snbulk="off"' + m }) + '</div>'
      + '<div class="sn-chtools">' + CH.map((c) => '<div class="sn-chtool" role="group" aria-label="' + esc(c[1]) + ' for every kind"><span class="sn-chname">' + esc(c[1]) + '</span>'
        + UI.btn('Enable all', { kind: 'ghost', size: 'sm', attrs: 'data-snbulk="on" data-c="' + c[0] + '"' + m + ' aria-label="Enable all: ' + esc(c[1]) + '"' })
        + UI.btn('Disable all', { kind: 'ghost', size: 'sm', attrs: 'data-snbulk="off" data-c="' + c[0] + '"' + m + ' aria-label="Disable all: ' + esc(c[1]) + '"' }) + '</div>').join('') + '</div></div>';
    const head = '<tr role="row"><th scope="col" role="columnheader">Notification</th>' + (tenant ? '<th scope="col" role="columnheader">Mandatory</th>' : '') + CH.map((c) => '<th scope="col" role="columnheader">' + esc(c[1]) + '</th>').join('') + '</tr>';
    const body = groupsOf(st.data.kinds).map((g) => {
      const open = !st.collapsed[g.name];
      const rowId = (k) => 'sn-' + mid + '-row-' + slug(k.id);
      const gname = esc(g.name);
      const ghead = '<tr role="row" class="sn-ghead"><th scope="rowgroup" role="rowheader" class="sn-group" colspan="' + cols + '"><div class="sn-gbar">'
        + '<button type="button" class="sn-disc" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="' + g.kinds.map(rowId).join(' ') + '" data-sntoggle="' + gname + '"' + m + '>' + UI.icon(open ? 'chevd' : 'chev', 14) + '<span>' + gname + '</span><span class="sn-count">' + plural(g.kinds.length, 'kind', 'kinds') + '</span></button>'
        + '<span class="sn-gacts">' + UI.btn('Enable all', { kind: 'ghost', size: 'sm', attrs: 'data-snbulk="on" data-g="' + gname + '"' + m + ' aria-label="Enable all: ' + gname + '"' })
        + UI.btn('Disable all', { kind: 'ghost', size: 'sm', attrs: 'data-snbulk="off" data-g="' + gname + '"' + m + ' aria-label="Disable all: ' + gname + '"' }) + '</span></div></th></tr>';
      const rows = g.kinds.map((k) => {
        const mand = tenant ? (st.draft.mandatory[k.id] != null ? st.draft.mandatory[k.id] : k.mandatory) : k.mandatory;
        const locked = tenant ? k.locked : k.mandatory;
        const reason = tenant ? (k.locked ? k.lockedReason : '') : k.lockedReason;
        const rid = 'sn-' + mid + '-' + slug(k.id);
        const title = esc(k.title);
        const label = '<span class="sn-title" id="' + rid + '">' + title + (locked || (!tenant && mand) ? ' ' + UI.pill('Mandatory', 'outline') : '') + '</span>'
          + '<span class="sn-desc">' + esc(k.description) + '</span>' + (reason ? '<span class="sn-lock" id="' + rid + '-why">' + UI.icon('lock', 11) + ' ' + esc(reason) + '</span>' : '');
        const mcell = tenant ? '<td role="cell" data-label="Mandatory"><input type="checkbox" data-snmand="' + esc(k.id) + '"' + m + (mand ? ' checked' : '') + (k.locked ? ' disabled' : '') + ' aria-label="Mandatory for ' + title + '"' + (reason ? ' aria-describedby="' + rid + '-why"' : '') + '></td>' : '';
        const cells = CH.map((c) => {
          const v = shown(st, k, c[0]);
          const off = !tenant && mand;
          const on = off ? true : v.enabled;
          const tm = off ? 'instant' : v.timing;
          const name = esc(c[1]) + ' for ' + title;
          return '<td role="cell" data-label="' + esc(c[1]) + '"><span class="sn-cell"><input type="checkbox" data-snon data-k="' + esc(k.id) + '" data-c="' + c[0] + '"' + m + (on ? ' checked' : '') + (off ? ' disabled' : '') + ' aria-label="' + name + '"' + (reason && !tenant ? ' aria-describedby="' + rid + '-why"' : '') + '>'
            + UI.select(TM, tm, 'data-sntm data-k="' + esc(k.id) + '" data-c="' + c[0] + '"' + m + ' aria-label="' + esc(c[1]) + ' timing for ' + title + '"' + (off || !on ? ' disabled' : '')) + '</span></td>';
        }).join('');
        return '<tr role="row" class="sn-krow" id="' + rowId(k) + '" data-sng="' + gname + '"' + m + (open ? '' : ' hidden') + '><th scope="row" role="rowheader" class="sn-kind">' + label + '</th>' + mcell + cells + '</tr>';
      }).join('');
      return '<tbody role="rowgroup">' + ghead + rows + '</tbody>';
    }).join('');
    return '<div class="sn-wrap">' + tools + '<div class="sn-live" role="status" aria-live="polite" data-snlive="' + mid + '"></div>'
      + '<div class="tablewrap bare" aria-label="' + esc(o.caption) + '"><table class="dt sn-matrix" role="table"><caption class="sr">' + esc(o.caption) + '</caption><thead role="rowgroup">' + head + '</thead>' + body + '</table></div></div>';
  };

  /** Draft entries that differ from what was loaded, as the API's `kinds` body. */
  const kindChanges = (st, tenant) => {
    const out = {};
    st.data.kinds.forEach((k) => {
      const d = st.draft.kinds[k.id];
      const entry = {};
      if (d) CH.forEach((c) => { const v = d[c[0]]; const was = k.channels[c[0]]; if (v && (v.enabled !== was.enabled || v.timing !== was.timing)) entry[c[0]] = { enabled: v.enabled, timing: v.timing }; });
      if (tenant) {
        const m = st.draft.mandatory[k.id];
        const changed = m != null && m !== k.mandatory;
        if (Object.keys(entry).length || changed) out[k.id] = Object.assign({}, changed ? { mandatory: m } : {}, Object.keys(entry).length ? { channels: entry } : {});
      } else if (Object.keys(entry).length) out[k.id] = entry;
    });
    return out;
  };

  const inMain = (sel) => document.querySelector('#main ' + sel);
  const allInMain = (sel) => Array.prototype.slice.call(document.querySelectorAll('#main ' + sel));

  /** Says what a bulk action did, politely; cleared first so the same words are announced again. */
  const announce = (mid, text) => {
    const live = inMain('[data-snlive="' + mid + '"]'); if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 60);
  };

  const setOpen = (st, mid, group, open) => {
    st.collapsed[group] = !open;
    const btn = inMain('[data-sntoggle="' + cssq(group) + '"][data-m="' + mid + '"]');
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const svg = btn.querySelector('svg'); if (svg) svg.outerHTML = UI.icon(open ? 'chevd' : 'chev', 14);
    }
    allInMain('tr[data-sng="' + cssq(group) + '"][data-m="' + mid + '"]').forEach((tr) => { tr.hidden = !open; });
  };

  /** Enable all or Disable all over a scope (`group`, `channel`, both or neither); mandatory kinds stay as they are. */
  const bulk = (st, o, on, scope, after) => {
    let n = 0; const kept = [];
    st.data.kinds.forEach((k) => {
      if (scope.group && k.group !== scope.group) return;
      if (lockedOf(st, o, k)) { kept.push(k.title); return; }
      (scope.channel ? [scope.channel] : CH.map((c) => c[0])).forEach((c) => {
        put(st, k, c, { enabled: on });
        const box = inMain('[data-snon][data-m="' + o.mid + '"][data-k="' + cssq(k.id) + '"][data-c="' + c + '"]');
        if (box) { box.checked = on; const sel = box.parentNode.querySelector('[data-sntm]'); if (sel) sel.disabled = !on; }
      });
      n++;
    });
    const verb = on ? 'turned on' : 'turned off';
    const ch = scope.channel ? CH.find((c) => c[0] === scope.channel)[1] : null;
    let text = (scope.group ? scope.group + ': ' : '') + (ch ? ch + ' ' + verb + ' for ' + plural(n, 'kind', 'kinds') : plural(n, 'kind', 'kinds') + ' ' + verb);
    if (kept.length) text += '; ' + names(kept) + (kept.length === 1 ? ' is mandatory and stays on' : ' are mandatory and stay on');
    text += '. ' + (o.saveHint || 'Save to keep the change.');
    announce(o.mid, text);
    if (after) after();
  };

  /** Keeps a matrix change in the draft and updates the cell without a re-render. */
  const bindMatrix = (ctx, st, o, onChange) => {
    const m = '[data-m="' + o.mid + '"]';
    const changed = () => { if (onChange) onChange(); };
    ctx.on('change', '[data-snon]' + m, (e, t) => {
      const kind = st.data.kinds.find((x) => x.id === t.dataset.k); if (!kind) return;
      put(st, kind, t.dataset.c, { enabled: t.checked });
      const sel = t.parentNode.querySelector('[data-sntm]'); if (sel) sel.disabled = !t.checked;
      changed();
    });
    ctx.on('change', '[data-sntm]' + m, (e, t) => { const kind = st.data.kinds.find((x) => x.id === t.dataset.k); if (kind) { put(st, kind, t.dataset.c, { timing: t.value }); changed(); } });
    ctx.on('change', '[data-snmand]' + m, (e, t) => { st.draft.mandatory[t.dataset.snmand] = t.checked; changed(); });
    ctx.on('click', '[data-sntoggle]' + m, (e, t) => setOpen(st, o.mid, t.dataset.sntoggle, t.getAttribute('aria-expanded') !== 'true'));
    ctx.on('click', '[data-snexpand]' + m, (e, t) => {
      const open = t.dataset.snexpand === '1';
      groupsOf(st.data.kinds).forEach((g) => setOpen(st, o.mid, g.name, open));
      announce(o.mid, open ? 'Every group expanded.' : 'Every group collapsed.');
    });
    ctx.on('click', '[data-snbulk]' + m, (e, t) => bulk(st, o, t.dataset.snbulk === 'on', { group: t.dataset.g || null, channel: t.dataset.c || null }, changed));
  };

  const fresh = (st, data) => { st.data = data; st.draft = { kinds: {}, mandatory: {}, settings: {} }; st.error = null; };

  /** Quiet hours per weekday; `pfx` names the controls (`sn` in Settings, `te` in the template editor). */
  const quietTable = (quiet, pfx) => '<div class="tablewrap bare" aria-label="Quiet hours by weekday"><table class="dt sn-quiet"><caption class="sr">Quiet hours by weekday</caption><thead><tr><th scope="col">Day</th><th scope="col">Quiet</th><th scope="col">From</th><th scope="col">Until</th></tr></thead><tbody>'
    + DAYS.map((d) => { const w = quiet[d[0]]; return '<tr><th scope="row">' + esc(d[1]) + '</th><td><input type="checkbox" data-' + pfx + 'qon="' + d[0] + '"' + (w ? ' checked' : '') + ' aria-label="Quiet hours on ' + d[1] + '"></td>'
      + '<td><input class="input" type="time" data-' + pfx + 'qs="' + d[0] + '" value="' + esc(w ? w.start : '22:00') + '"' + (w ? '' : ' disabled') + ' aria-label="' + d[1] + ', quiet from"></td>'
      + '<td><input class="input" type="time" data-' + pfx + 'qe="' + d[0] + '" value="' + esc(w ? w.end : '07:00') + '"' + (w ? '' : ' disabled') + ' aria-label="' + d[1] + ', quiet until"></td></tr>'; }).join('')
    + '</tbody></table></div>';

  /** Keeps quiet-hour changes in `get()`/`set(q)` (a copy of the weekday map). */
  const bindQuiet = (ctx, pfx, get, set) => {
    const ds = (t, k) => t.getAttribute('data-' + pfx + k);
    ctx.on('change', '[data-' + pfx + 'qon]', (e, t) => {
      const d = ds(t, 'qon'); const q = Object.assign({}, get());
      const s = ctx.$('[data-' + pfx + 'qs="' + d + '"]'), en = ctx.$('[data-' + pfx + 'qe="' + d + '"]');
      q[d] = t.checked ? { start: s.value || '22:00', end: en.value || '07:00' } : null;
      s.disabled = en.disabled = !t.checked;
      set(q);
    });
    ctx.on('change', '[data-' + pfx + 'qs],[data-' + pfx + 'qe]', (e, t) => {
      const d = ds(t, 'qs') || ds(t, 'qe'); const q = Object.assign({}, get());
      q[d] = { start: ctx.$('[data-' + pfx + 'qs="' + d + '"]').value, end: ctx.$('[data-' + pfx + 'qe="' + d + '"]').value };
      set(q);
    });
  };
  const quietProblem = (q) => DAYS.find((d) => q && q[d[0]] && (!q[d[0]].start || !q[d[0]].end || q[d[0]].start === q[d[0]].end));

  // ---------- Settings › Notifications ----------

  const zones = (() => { let z = null; return () => { if (z) return z; try { z = Intl.supportedValuesOf('timeZone'); } catch (e) { z = ['UTC']; } return z; }; })();
  const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } };
  const setting = (st, name) => (Object.prototype.hasOwnProperty.call(st.draft.settings, name) ? st.draft.settings[name] : st.data[name]);
  const PERSON = { mid: 'p', label: 'Your notifications', caption: 'Your notifications: kinds by channel' };

  const load = (ctx) => {
    const st = ctx.state.pnot || (ctx.state.pnot = {});
    if (st.loaded || st.loading) return st;
    st.loading = true;
    App.get('/api/me/notification-preferences').then((r) => fresh(st, r)).catch((err) => { st.error = err; })
      .finally(() => { st.loading = false; st.loaded = true; if (App.state.route === 'settings') ctx.rerender(); });
    return st;
  };

  const basedOn = (t) => {
    if (!t) return '';
    const newer = t.currentVersion != null && t.currentVersion > t.version ? ' The template has changed since (now version ' + esc(t.currentVersion) + '); your settings did not change with it.' : '';
    return UI.notice('Based on template <b>' + esc(t.name) + '</b>, version ' + esc(t.version) + '. ' + (t.changedKinds ? 'You changed ' + plural(t.changedKinds, 'kind', 'kinds') + ' since.' : 'You have not changed it since.') + newer, 'info');
  };

  const html = (ctx) => {
    const st = load(ctx);
    if (st.error) return UI.panel('Notifications', UI.problem('Notification settings could not be loaded', st.error.message, st.error.problem && st.error.problem.trace_id), { attrs: 'data-settings-notifications' });
    if (!st.data) return UI.panel('Notifications', UI.notice('Loading…', 'info'), { attrs: 'data-settings-notifications' });
    const tz = setting(st, 'timeZone') || '';
    const list = zones().indexOf(tz) >= 0 || !tz ? zones() : [tz].concat(zones());
    const bz = browserZone();
    const quiet = setting(st, 'quietHours');
    const hour = setting(st, 'digestHour'), wday = setting(st, 'digestWeekday');
    const when = '<div class="formgrid">'
      + UI.field('Time zone', UI.select([{ value: '', label: 'Not set (UTC)' }].concat(list.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))), tz, 'data-sntz'), 'Quiet hours and digest times follow this zone, including its daylight saving changes.')
      + UI.field('Daily and weekly digests at', UI.select(Array.from({ length: 24 }, (x, i) => ({ value: String(i), label: pad(i) + ':00' })), String(hour), 'data-snhour'))
      + UI.field('Weekly digest on', UI.select(DAYS.map((d, i) => ({ value: String(i), label: d[1] })), String(wday), 'data-snwday'))
      + '</div>'
      + (bz && bz !== tz ? '<div class="hstack gap6 wrap">' + UI.btn('Use this browser\'s zone', { kind: 'ghost', size: 'sm', attrs: 'data-snbz="' + esc(bz) + '" aria-describedby="sn-bz"' }) + '<span class="muted" id="sn-bz" style="font-size:12px;overflow-wrap:anywhere">' + esc(bz.replace(/_/g, ' ')) + '</span></div>' : '');
    const quietHtml = quietTable(quiet, 'sn')
      + '<div class="muted" style="font-size:12px">A window that ends before it starts runs past midnight into the next day. In quiet hours push, live and email notifications wait and arrive together when the window ends; the list in the app is never held back.</div>'
      + UI.check('Let urgent notifications through quiet hours', !!setting(st, 'urgentPassesQuiet'), 'data-snurgent');
    const dirty = Object.keys(st.draft.settings).length || Object.keys(kindChanges(st, false)).length;
    return STYLE + UI.panel('Notifications', '<div class="vstack" style="gap:12px">'
      + '<div class="muted" style="font-size:12px">Choose, for each kind of notification, where it reaches you and whether at once or in a digest. Mandatory kinds always reach you at once; they are locked, with the reason next to them.</div>'
      + basedOn(st.data.template)
      + matrix(st, PERSON)
      + '<div class="eyebrow">When</div>' + when
      + '<div class="eyebrow">Quiet hours</div>' + quietHtml
      + '<div class="hstack gap6 wrap">' + UI.btn('Save notification settings', { kind: 'primary', attrs: 'data-snsave' }) + (st.data.saved ? UI.btn('Back to the defaults', { kind: 'ghost', attrs: 'data-snreset' }) : '') + '<span class="muted" style="font-size:12px" role="status" data-sndirty>' + (dirty ? 'Unsaved changes' : '') + '</span></div>'
      + '</div>', { attrs: 'data-settings-notifications' });
  };

  const bind = (ctx) => {
    const st = ctx.state.pnot;
    if (!st || !st.data) return;
    const dirty = () => { const el = inMain('[data-sndirty]'); if (el) el.textContent = 'Unsaved changes'; };
    bindMatrix(ctx, st, PERSON, dirty);
    ctx.on('change', '[data-sntz]', (e, t) => { st.draft.settings.timeZone = t.value || null; dirty(); });
    ctx.on('click', '[data-snbz]', (e, t) => { st.draft.settings.timeZone = t.dataset.snbz; ctx.rerender(); });
    ctx.on('change', '[data-snhour]', (e, t) => { st.draft.settings.digestHour = Number(t.value); dirty(); });
    ctx.on('change', '[data-snwday]', (e, t) => { st.draft.settings.digestWeekday = Number(t.value); dirty(); });
    ctx.on('change', '[data-snurgent]', (e, t) => { st.draft.settings.urgentPassesQuiet = t.checked; dirty(); });
    bindQuiet(ctx, 'sn', () => setting(st, 'quietHours'), (q) => { st.draft.settings.quietHours = q; dirty(); });
    ctx.on('click', '[data-snsave]', () => {
      const body = Object.assign({}, st.draft.settings);
      const bad = quietProblem(body.quietHours);
      if (bad) { ctx.toast('Quiet hours on ' + bad[1] + ' need a start and an end that differ.', 'warn'); return; }
      const kinds = kindChanges(st, false);
      if (Object.keys(kinds).length) body.kinds = kinds;
      if (!Object.keys(body).length) { ctx.toast('Nothing to save.'); return; }
      App.api('PUT', '/api/me/notification-preferences', body).then((r) => { fresh(st, r); ctx.toast('Notification settings saved. Audited notification.prefs.updated.', 'ok'); ctx.rerender(); })
        .catch((err) => App.fail(err, 'Not saved'));
    });
    ctx.on('click', '[data-snreset]', async () => {
      const ok = await ctx.confirm({ title: 'Back to the defaults?', body: '<div class="fg2">Your choices for every kind, your quiet hours and your time zone are removed, and your organisation\'s defaults apply again.</div>', ok: 'Use the defaults' });
      if (!ok) return;
      App.del('/api/me/notification-preferences').then((r) => { fresh(st, r); ctx.toast('Back to the defaults. Audited notification.prefs.reset.', 'ok'); ctx.rerender(); }).catch((err) => App.fail(err, 'Not reset'));
    });
  };

  App.settingsPanels = App.settingsPanels || [];
  App.settingsPanels.push({ id: 'notifications', tab: 'preferences', html, bind });

  // ---------- Tenants › Notifications (tenant defaults) ----------

  const TENANT = { mid: 't', tenant: true, label: 'Tenant defaults', caption: 'Tenant defaults: notification kinds by channel' };
  const EDITOR = { mid: 'x', label: 'Template', caption: 'Template: notification kinds by channel', saveHint: 'Save the template to keep the change.' };

  const tLoad = (ctx) => {
    const st = ctx.state.tnot || (ctx.state.tnot = {});
    if (st.loaded || st.loading) return st;
    st.loading = true;
    App.get('/api/admin/notification-defaults').then((r) => fresh(st, r)).catch((err) => { st.error = err; })
      .finally(() => { st.loading = false; st.loaded = true; if (App.state.route === 'tenants') ctx.rerender(); });
    return st;
  };

  const tplLoad = (ctx, force) => {
    const tp = ctx.state.ttpl || (ctx.state.ttpl = {});
    if (!force && (tp.loaded || tp.loading)) return tp;
    tp.loading = true;
    App.get('/api/admin/notification-templates').then((r) => { tp.data = r; tp.error = null; }).catch((err) => { tp.error = err; })
      .finally(() => { tp.loading = false; tp.loaded = true; if (App.state.route === 'tenants') ctx.rerender(); });
    return tp;
  };

  /** An editor's state from a template (or a new one from the tenant defaults), shaped like the matrix's. */
  const editorFor = (defaults, t) => {
    const kinds = defaults.kinds.map((k) => {
      const mine = (t && t.kinds[k.id]) || {};
      return {
        id: k.id, title: k.title, description: k.description, group: k.group, mandatory: !!k.mandatory,
        lockedReason: k.locked ? k.lockedReason : k.mandatory ? 'Mandatory in this tenant, so a template cannot turn it off or delay it.' : null,
        channels: Object.fromEntries(CH.map((c) => [c[0], mine[c[0]] ? { enabled: mine[c[0]].enabled, timing: mine[c[0]].timing } : { enabled: k.channels[c[0]].enabled, timing: k.channels[c[0]].timing }]))
      };
    });
    return {
      id: t ? t.id : null, version: t ? t.version : null, name: t ? t.name : '', description: (t && t.description) || '', defaultForNew: !!(t && t.defaultForNewMembers),
      quiet: Object.assign({}, (t && t.quietHours) || {}), urgent: t && t.urgentPassesQuiet != null ? t.urgentPassesQuiet : true,
      digestHour: t && t.digestHour != null ? String(t.digestHour) : '', digestWeekday: t && t.digestWeekday != null ? String(t.digestWeekday) : '',
      data: { kinds }, draft: { kinds: {}, mandatory: {}, settings: {} }, collapsed: {}
    };
  };

  const editorHtml = (ed) => UI.panel(ed.id ? 'Edit template: ' + ed.name : 'New template', '<div class="vstack" style="gap:12px">'
    + '<div class="formgrid">' + UI.field('Name', UI.input(ed.name, { attrs: 'data-tename maxlength="100" autocomplete="off"' })) + UI.field('Description', UI.input(ed.description, { attrs: 'data-tedesc maxlength="500" autocomplete="off"' })) + '</div>'
    + UI.check('New members of this tenant get this template', ed.defaultForNew, 'data-tedefault')
    + '<div class="muted" style="font-size:12px">The choices people get when the template is applied. Mandatory kinds are left out: they always reach everyone at once.' + (ed.id ? ' Saving makes version ' + esc(ed.version + 1) + '; people keep what they were given until it is applied again.' : '') + '</div>'
    + matrix(ed, EDITOR)
    + '<div class="eyebrow">When</div><div class="formgrid">'
    + UI.field('Daily and weekly digests at', UI.select([{ value: '', label: 'Not set (08:00)' }].concat(Array.from({ length: 24 }, (x, i) => ({ value: String(i), label: pad(i) + ':00' }))), ed.digestHour, 'data-tehour'))
    + UI.field('Weekly digest on', UI.select([{ value: '', label: 'Not set (Monday)' }].concat(DAYS.map((d, i) => ({ value: String(i), label: d[1] }))), ed.digestWeekday, 'data-tewday'))
    + '</div><div class="eyebrow">Quiet hours</div>' + quietTable(ed.quiet, 'te')
    + UI.check('Let urgent notifications through quiet hours', ed.urgent, 'data-teurgent')
    + '<div class="hstack gap6 wrap">' + UI.btn('Save template', { kind: 'primary', attrs: 'data-tesave' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-tecancel' }) + '</div>'
    + '</div>', { attrs: 'data-template-editor' });

  const templatesHtml = (tp) => {
    if (tp.error) return UI.panel('Notification templates', UI.problem('Templates could not be loaded', tp.error.message, tp.error.problem && tp.error.problem.trace_id), { attrs: 'data-tenant-templates' });
    if (!tp.data) return UI.panel('Notification templates', UI.notice('Loading…', 'info'), { attrs: 'data-tenant-templates' });
    if (!tp.data.available) return UI.panel('Notification templates', UI.notice('Templates are not available yet: the database migration 132_notification_templates has not been applied on this server.', 'info'), { attrs: 'data-tenant-templates' });
    const rows = tp.data.templates.map((t) => ({ cells: [
      '<b>' + esc(t.name) + '</b>' + (t.description ? '<span class="sn-desc">' + esc(t.description) + '</span>' : ''),
      '<span class="num">' + esc(t.version) + '</span>',
      t.defaultForNewMembers ? UI.pill('New members', 'ok') : '<span class="muted">no</span>',
      '<span class="num">' + esc(t.people) + '</span>',
      '<span class="hstack gap6 wrap">' + UI.btn('Apply', { size: 'sm', attrs: 'data-tpapply="' + esc(t.id) + '" aria-label="Apply ' + esc(t.name) + '"' }) + UI.btn('Edit', { size: 'sm', kind: 'ghost', attrs: 'data-tpedit="' + esc(t.id) + '" aria-label="Edit ' + esc(t.name) + '"' }) + UI.btn('Delete', { size: 'sm', kind: 'ghost', attrs: 'data-tpdel="' + esc(t.id) + '" aria-label="Delete ' + esc(t.name) + '"' }) + '</span>'
    ] }));
    return UI.panel('Notification templates', '<div class="vstack sn-tpl" style="gap:12px">'
      + '<div class="muted" style="font-size:12px">A template is a set of notification choices you can apply to one person, a list, a role, a group or everyone. Applying writes them as each person\'s own settings, which they can change afterwards in Settings, Notifications. Fill in sets only the kinds a person has not chosen; replace resets their choices first. Mandatory kinds are never changed.</div>'
      + (tp.result ? UI.notice(tp.result, 'ok') : '')
      + UI.table(['Template', { label: 'Version', right: true }, 'New members', { label: 'People', right: true }, { srLabel: 'Actions' }], rows, { clickable: false, attrs: 'aria-label="Notification templates"', emptyTitle: 'No templates yet', emptyText: 'Make one to give people a starting set of notification choices.' })
      + (tp.edit ? '' : '<div class="hstack gap6">' + UI.btn('New template', { kind: 'primary', icon: 'plus', attrs: 'data-tpnew' }) + '</div>')
      + '</div>', { attrs: 'data-tenant-templates' }) + (tp.edit ? editorHtml(tp.edit) : '');
  };

  const applyDialog = (ctx, tp, t) => {
    const targets = tp.data.targets || { roles: [], groups: [] };
    const body = UI.field('Apply to', UI.select([{ value: 'users', label: 'One person or a list of people' }, { value: 'role', label: 'Everyone with a role' }, { value: 'group', label: 'The members of a group' }, { value: 'everyone', label: 'Everyone in the tenant' }], 'users', 'data-apto'))
      + '<div data-apbox="users">' + UI.field('Usernames', UI.textarea('', { attrs: 'data-apusers', rows: 3 }), 'One per line, or separated by commas.') + '</div>'
      + '<div data-apbox="role" hidden>' + (targets.roles.length ? UI.field('Role', UI.select(targets.roles, targets.roles[0], 'data-aprole')) : UI.notice('Nobody in this tenant holds a role yet.', 'info')) + '</div>'
      + '<div data-apbox="group" hidden>' + (targets.groups.length ? UI.field('Group', UI.select(targets.groups.map((g) => ({ value: g.id, label: g.name })), targets.groups[0].id, 'data-apgroup')) : UI.notice('This tenant has no groups.', 'info')) + '</div>'
      + '<fieldset class="sn-mode"><legend>How</legend>'
      + '<label class="check"><input type="radio" name="apmode" value="fill" checked data-apmode><span>Fill in: set only the kinds a person has not chosen</span></label>'
      + '<label class="check"><input type="radio" name="apmode" value="replace" data-apmode><span>Replace: reset each person\'s choices, then apply the template</span></label></fieldset>'
      + '<div data-apres role="status" aria-live="polite"></div>';
    App.modal({
      title: 'Apply ' + esc(t.name) + ', version ' + esc(t.version), body,
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Preview', { attrs: 'data-appreview' }) + UI.btn('Apply', { kind: 'primary', attrs: 'data-apok' }),
      onMount(m) {
        const $ = (s) => m.querySelector(s);
        const to = $('[data-apto]');
        to.addEventListener('change', () => m.querySelectorAll('[data-apbox]').forEach((b) => { b.hidden = b.dataset.apbox !== to.value; }));
        const request = (dryRun) => {
          const mode = (m.querySelector('[data-apmode]:checked') || {}).value || 'fill';
          let target;
          if (to.value === 'users') {
            const names = ($('[data-apusers]').value || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
            if (!names.length) return null;
            target = { kind: 'users', usernames: names };
          } else if (to.value === 'role') { const r = $('[data-aprole]'); if (!r) return null; target = { kind: 'role', role: r.value }; }
          else if (to.value === 'group') { const g = $('[data-apgroup]'); if (!g) return null; target = { kind: 'group', groupId: g.value }; }
          else target = { kind: 'everyone' };
          return { mode, target, dryRun };
        };
        const res = $('[data-apres]');
        const summary = (r, done) => (done ? 'Applied to ' : 'Would reach ') + plural(r.people, 'person', 'people') + ': ' + plural(r.changedPeople, 'person', 'people') + (done ? ' changed' : ' would change') + ', ' + plural(r.changedKinds, 'kind choice', 'kind choices') + ' in all.'
          + (r.skippedKinds && r.skippedKinds.length ? ' Left as they are, being mandatory: ' + r.skippedKinds.length + '.' : '') + (r.unknown && r.unknown.length ? ' Not in this tenant: ' + r.unknown.join(', ') + '.' : '');
        $('[data-appreview]').addEventListener('click', () => {
          const b = request(true); if (!b) { res.innerHTML = UI.notice('Name the people, role or group to apply the template to.', 'warn'); return; }
          App.post('/api/admin/notification-templates/' + encodeURIComponent(t.id) + '/apply', b).then((r) => { res.innerHTML = UI.notice(esc(summary(r, false)), 'info'); }).catch((err) => { res.innerHTML = UI.notice(esc((err.problem && err.problem.detail) || err.message), 'warn'); });
        });
        $('[data-apok]').addEventListener('click', () => {
          const b = request(false); if (!b) { res.innerHTML = UI.notice('Name the people, role or group to apply the template to.', 'warn'); return; }
          App.post('/api/admin/notification-templates/' + encodeURIComponent(t.id) + '/apply', b).then((r) => {
            App.closeOverlay();
            tp.result = esc(t.name + ' (version ' + r.template.version + ', ' + (r.mode === 'replace' ? 'replace' : 'fill in') + '). ' + summary(r, true));
            ctx.toast('Template applied. Audited notification.template.applied.', 'ok');
            tplLoad(ctx, true);
          }).catch((err) => { res.innerHTML = UI.notice(esc((err.problem && err.problem.detail) || err.message), 'warn'); });
        });
      }
    });
  };

  const bindTemplates = (ctx, tp, defaults) => {
    if (!tp.data || !tp.data.available) return;
    const byId = (id) => tp.data.templates.find((t) => t.id === id);
    ctx.on('click', '[data-tpnew]', () => { tp.edit = editorFor(defaults.data, null); tp.result = null; ctx.rerender(); setTimeout(() => { const n = inMain('[data-tename]'); if (n) n.focus(); }, 0); });
    ctx.on('click', '[data-tpedit]', (e, t) => {
      App.get('/api/admin/notification-templates/' + encodeURIComponent(t.dataset.tpedit)).then((full) => { tp.edit = editorFor(defaults.data, full); tp.result = null; ctx.rerender(); setTimeout(() => { const n = inMain('[data-tename]'); if (n) n.focus(); }, 0); })
        .catch((err) => App.fail(err, 'Template not loaded'));
    });
    ctx.on('click', '[data-tpapply]', (e, t) => { const x = byId(t.dataset.tpapply); if (x) applyDialog(ctx, tp, x); });
    ctx.on('click', '[data-tpdel]', async (e, t) => {
      const x = byId(t.dataset.tpdel); if (!x) return;
      const ok = await ctx.confirm({ title: 'Delete ' + x.name + '?', body: '<div class="fg2">People keep the settings it gave them; Settings no longer says they are based on it.' + (x.defaultForNewMembers ? ' New members then get the tenant defaults.' : '') + '</div>', ok: 'Delete', tone: 'danger' });
      if (!ok) return;
      App.del('/api/admin/notification-templates/' + encodeURIComponent(x.id)).then(() => { if (tp.edit && tp.edit.id === x.id) tp.edit = null; tp.result = null; ctx.toast(esc(x.name) + ' deleted. Audited notification.template.deleted.', 'ok'); tplLoad(ctx, true); })
        .catch((err) => App.fail(err, 'Not deleted'));
    });
    const ed = tp.edit;
    if (!ed) return;
    bindMatrix(ctx, ed, EDITOR);
    ctx.on('input', '[data-tename]', (e, t) => { ed.name = t.value; });
    ctx.on('input', '[data-tedesc]', (e, t) => { ed.description = t.value; });
    ctx.on('change', '[data-tedefault]', (e, t) => { ed.defaultForNew = t.checked; });
    ctx.on('change', '[data-tehour]', (e, t) => { ed.digestHour = t.value; });
    ctx.on('change', '[data-tewday]', (e, t) => { ed.digestWeekday = t.value; });
    ctx.on('change', '[data-teurgent]', (e, t) => { ed.urgent = t.checked; });
    bindQuiet(ctx, 'te', () => ed.quiet, (q) => { ed.quiet = q; });
    ctx.on('click', '[data-tecancel]', () => { tp.edit = null; ctx.rerender(); });
    ctx.on('click', '[data-tesave]', () => {
      const name = ed.name.trim();
      if (!name) { ctx.toast('Give the template a name.', 'warn'); const n = inMain('[data-tename]'); if (n) n.focus(); return; }
      const bad = quietProblem(ed.quiet);
      if (bad) { ctx.toast('Quiet hours on ' + bad[1] + ' need a start and an end that differ.', 'warn'); return; }
      const kinds = {};
      ed.data.kinds.forEach((k) => { if (k.mandatory) return; kinds[k.id] = Object.fromEntries(CH.map((c) => { const v = shown(ed, k, c[0]); return [c[0], { enabled: v.enabled, timing: v.timing }]; })); });
      const quiet = {}; DAYS.forEach((d) => { if (ed.quiet[d[0]]) quiet[d[0]] = ed.quiet[d[0]]; });
      const body = { name, description: ed.description.trim() || null, kinds, quietHours: Object.keys(quiet).length ? quiet : null, urgentPassesQuiet: ed.urgent, digestHour: ed.digestHour === '' ? null : Number(ed.digestHour), digestWeekday: ed.digestWeekday === '' ? null : Number(ed.digestWeekday), defaultForNewMembers: ed.defaultForNew };
      const req = ed.id ? App.api('PATCH', '/api/admin/notification-templates/' + encodeURIComponent(ed.id), body) : App.post('/api/admin/notification-templates', body);
      req.then((r) => { tp.edit = null; tp.result = esc(r.name) + ' saved as version ' + esc(r.version) + '.'; ctx.toast('Template saved. Audited notification.template.' + (ed.id ? 'updated' : 'created') + '.', 'ok'); tplLoad(ctx, true); })
        .catch((err) => App.fail(err, 'Template not saved'));
    });
  };

  App.tenantNotificationDefaults = {
    html(ctx) {
      const st = tLoad(ctx);
      if (st.error) return UI.problem('Notification defaults could not be loaded', st.error.message, st.error.problem && st.error.problem.trace_id);
      if (!st.data) return UI.notice('Loading…', 'info');
      const tp = tplLoad(ctx);
      return STYLE + UI.panel('Notification defaults', '<div class="vstack" style="gap:12px"><div class="muted" style="font-size:12px">What each person in this tenant gets until they choose otherwise in Settings, Notifications. A mandatory kind always reaches everyone at once, on every channel, and nobody can turn it off; security alerts are mandatory in every tenant.</div>'
        + matrix(st, TENANT)
        + '<div class="hstack gap6 wrap">' + UI.btn('Save defaults', { kind: 'primary', attrs: 'data-tnsave' }) + '<span class="muted" style="font-size:12px" role="status" data-tndirty></span></div></div>', { attrs: 'data-tenant-notifications' })
        + templatesHtml(tp);
    },
    bind(ctx) {
      const st = ctx.state.tnot;
      if (!st || !st.data) return;
      bindMatrix(ctx, st, TENANT, () => { const el = inMain('[data-tndirty]'); if (el) el.textContent = 'Unsaved changes'; });
      ctx.on('click', '[data-tnsave]', async () => {
        const kinds = kindChanges(st, true);
        if (!Object.keys(kinds).length) { ctx.toast('Nothing to save.'); return; }
        const made = Object.keys(kinds).filter((k) => kinds[k].mandatory === true).map((k) => st.data.kinds.find((x) => x.id === k).title);
        if (made.length) {
          const ok = await ctx.confirm({ title: 'Make ' + made.join(', ') + ' mandatory?', body: '<div class="fg2">Everyone in the tenant then gets ' + (made.length === 1 ? 'it' : 'them') + ' at once on every channel, and nobody can turn ' + (made.length === 1 ? 'it' : 'them') + ' off or into a digest.</div>', ok: 'Make mandatory' });
          if (!ok) return;
        }
        App.api('PUT', '/api/admin/notification-defaults', { kinds }).then((r) => { fresh(st, r); if (ctx.state.ttpl) ctx.state.ttpl.edit = null; ctx.toast('Defaults saved. Audited notification.defaults.updated.', 'ok'); ctx.rerender(); }).catch((err) => App.fail(err, 'Not saved'));
      });
      if (ctx.state.ttpl) bindTemplates(ctx, ctx.state.ttpl, st);
    }
  };
})();
