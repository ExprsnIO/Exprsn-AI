// Workflows, Sprint 47 (Builders' tools, B-138): the schedule editor of a trigger step whose source is schedule: a
// preset picker, the time zone and the next runs (/api/workflow-schedules/presets and /preview). `workflows.js` asks
// App.wfSchedulePanel(ctx, wf, node, deps) for the inspector markup and calls App.wfScheduleBind(ctx, deps) once per
// render; deps has selNode() (the selected step), changed() (the draft changed: re-render), editable and later()
// (re-render when a fetch lands). The cron stays the trigger's `cron`; the zone is its `timezone` (left out for UTC).
(function () {
  const { UI, esc } = App;
  const CSS = '.wfsch-sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.wfsch-runs{margin:0;padding:0 0 0 18px;font-size:12px;font-variant-numeric:tabular-nums}.wfsch-params{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:6px}';
  let presets = null;
  let presetsLoading = false;
  let zones = null;

  function zoneList() {
    if (zones) return zones;
    let list = [];
    try { list = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []; } catch (e) { list = []; }
    zones = ['UTC'].concat(list.filter((z) => z !== 'UTC'));
    return zones;
  }

  function st(ctx) { const s = ctx.state; s.wfsch = s.wfsch || { previews: {} }; return s.wfsch; }

  function loadPresets(deps) {
    if (presets || presetsLoading) return;
    presetsLoading = true;
    App.get('/api/workflow-schedules/presets').then((d) => { presets = d.presets; }).catch(() => { presets = []; }).finally(() => { presetsLoading = false; deps.later(); });
  }

  function loadPreview(ctx, deps, cron, tz) {
    const s = st(ctx); const key = cron + '|' + tz;
    if (s.previews[key]) return;
    s.previews[key] = { loading: true };
    App.post('/api/workflow-schedules/preview', { cron, timezone: tz, count: 5 })
      .then((d) => { s.previews[key] = { data: d }; })
      .catch((err) => { s.previews[key] = { error: (err.problem && err.problem.detail) || err.message }; })
      .finally(() => deps.later());
  }

  App.wfSchedulePanel = function (ctx, wf, n, deps) {
    loadPresets(deps);
    const s = st(ctx);
    const c = n.config || {};
    const ro = deps.editable ? '' : ' disabled';
    const tz = c.timezone || 'UTC';
    const zl = zoneList();
    const tzControl = zl.length > 1 ? UI.select(zl.indexOf(tz) >= 0 ? zl : [tz].concat(zl), tz, 'data-wfsch-tz' + ro) : UI.input(tz, { attrs: 'data-wfsch-tz' + ro, placeholder: 'Europe/Berlin' });
    const p = presets && s.preset ? presets.find((x) => x.id === s.preset) : null;
    const presetOpts = [{ value: '', label: presets ? 'Choose a preset…' : 'Loading the presets…' }].concat((presets || []).map((x) => ({ value: x.id, label: x.group + ': ' + x.title })));
    let html = '<style>' + CSS + '</style>'
      + UI.field('Preset', UI.select(presetOpts, s.preset || '', 'data-wfsch-preset' + ro), 'Fills in the cron below; the cron is what the trigger keeps')
      + (p && p.params.length ? '<div class="wfsch-params">' + p.params.map((x) => UI.field(x.label, UI.input(String((s.values || {})[x.name] != null ? s.values[x.name] : x.default), { type: 'number', attrs: 'data-wfsch-param="' + x.name + '" min="' + x.min + '" max="' + x.max + '"' + ro }))).join('') + '</div>' : '')
      + (p ? '<div>' + UI.btn('Use this preset', { size: 'sm', attrs: 'data-wfsch-apply', disabled: !deps.editable }) + '</div>' : '')
      + UI.field('Cron', UI.input(c.cron || '', { placeholder: '0 9 * * 1-5', attrs: 'data-wfsch-cron' + ro }), 'Minute, hour, day of the month, month, day of the week. Also JAN–DEC, SUN–SAT, L (last day), LW (last weekday), 15W (weekday nearest the 15th) and 1#2 (second Monday). Leave it empty when an app\'s schedule trigger starts the workflow.')
      + UI.field('Time zone', tzControl, 'The cron reads its times in this zone; daylight-saving changes keep the wall-clock time. Each due time is claimed once across instances.');
    if (c.cron) {
      const key = c.cron + '|' + tz;
      const pv = s.previews[key];
      if (!pv) loadPreview(ctx, deps, c.cron, tz);
      html += '<div class="eyebrow">Next runs</div><div aria-live="polite" data-wfsch-preview>'
        + (!pv || pv.loading ? '<div class="wfsch-sub">Working out the next runs…</div>'
          : pv.error ? UI.notice(esc(pv.error), 'danger')
          : '<div style="font-size:13px">' + esc(pv.data.description) + '</div><ol class="wfsch-runs">' + pv.data.runs.map((r) => '<li>' + esc(r.local) + (tz !== 'UTC' ? ' <span class="muted">' + esc(r.iso.slice(11, 16)) + ' UTC</span>' : '') + '</li>').join('') + '</ol>' + (pv.data.notes.length ? UI.notice(pv.data.notes.map(esc).join(' '), 'info') : ''))
        + '</div>';
    }
    return html;
  };

  App.wfScheduleBind = function (ctx, deps) {
    const s = st(ctx);
    const node = () => { const n = deps.selNode(); return n && n.kind === 'trigger' && (n.config || {}).source === 'schedule' ? n : null; };
    ctx.on('change', '[data-wfsch-preset]', (e, el) => { s.preset = el.value || null; s.values = {}; ctx.rerender(); const again = ctx.$('[data-wfsch-preset]'); if (again) again.focus(); });
    ctx.on('change', '[data-wfsch-param]', (e, el) => { s.values = s.values || {}; s.values[el.dataset.wfschParam] = Math.round(Number(el.value)); });
    ctx.on('click', '[data-wfsch-apply]', async () => {
      const n = node(); if (!n || !deps.editable || !s.preset) return;
      const values = {};
      Object.keys(s.values || {}).forEach((k) => { if (!isNaN(s.values[k])) values[k] = s.values[k]; });
      try {
        const out = await App.post('/api/workflow-schedules/preview', { preset: s.preset, values, timezone: (n.config && n.config.timezone) || 'UTC', count: 5 });
        n.config.cron = out.cron;
        s.previews[out.cron + '|' + out.timezone] = { data: out };
        deps.changed();
        ctx.toast('<span>Schedule set: ' + esc(out.description) + '.</span>', 'ok');
      } catch (err) { App.fail(err, 'The preset cannot be used'); }
    });
    ctx.on('change', '[data-wfsch-cron]', (e, el) => {
      const n = node(); if (!n || !deps.editable) return;
      const v = el.value.trim();
      if (v) n.config.cron = v; else delete n.config.cron;
      deps.changed();
    });
    ctx.on('change', '[data-wfsch-tz]', (e, el) => {
      const n = node(); if (!n || !deps.editable) return;
      const v = el.value.trim();
      if (v && v !== 'UTC') n.config.timezone = v; else delete n.config.timezone;
      deps.changed();
      const again = ctx.$('[data-wfsch-tz]'); if (again) again.focus();
    });
  };
})();
