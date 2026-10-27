// Certificates › Settings (1.9.0, Sprint 55, B-187, B-189): the certificate authority's settings for this tenant
// and, for platform admins, the platform. `certificates.js` calls App.certSettings(ctx, deps) for the tab's markup and
// its handlers; the state lives in ctx.state.cs. Every value shows where it comes from (this tenant, the platform, the
// environment or the default), its floor and its range; root and intermediate changes wait for a second platform
// admin and apply at the next rotation or re-issue.
(function () {
  const { UI, esc } = App;
  const KEY_TYPES = ['ecdsa-p256', 'ecdsa-p384', 'rsa-2048', 'rsa-3072', 'rsa-4096'];
  const ENUMS = {
    'root.keyType': KEY_TYPES, 'intermediate.keyType': KEY_TYPES, 'ocsp.responderKeyType': KEY_TYPES,
    'tokens.signature': [{ value: 'ecdsa-p256', label: 'ECDSA P-256 (ES256)' }, { value: 'ecdsa-p384', label: 'ECDSA P-384 (ES384)' }, { value: 'rsa-pss', label: 'RSA-PSS (PS256)' }],
    'tokens.defaultExpiry': [{ value: 'time', label: 'By time' }, { value: 'uses', label: 'By number of uses' }, { value: 'persistent', label: 'Persistent' }],
    'members.san': [{ value: 'uri', label: 'URI (exprsn-member://tenant/user)' }, { value: 'email', label: 'Email address' }]
  };
  const BOOLS = ['ocsp.delegated', 'ocsp.batch', 'acme.privateIdentifiers', 'members.enabled', 'members.withToken', 'members.signIn', 'members.mtls'];
  const SUBJECTS = ['root.subject', 'intermediate.subject', 'leaf.subject'];
  const NULLABLE = ['root.pathLen', 'crl.nextUpdateDays', 'acme.certDays', 'acme.termsUrl', 'publicUrl', 'members.profileId', 'acme.issuerId'];
  const TEXTS = ['acme.termsUrl', 'publicUrl'];
  const ATTRS = [['C', 'Country (C)'], ['ST', 'State or province (ST)'], ['L', 'Locality (L)'], ['O', 'Organization (O)'], ['OU', 'Organizational unit (OU)'], ['email', 'Email']];
  const GROUPS = [
    ['root', 'Root CA', 'The platform root. A change waits for a second platform admin and applies at the next rotation (subject, algorithm) or re-issue (validity, path length); nothing is re-keyed when it is approved.'],
    ['intermediate', 'Intermediates', 'Every tenant\'s issuing CA, under the same rule as the root.'],
    ['names', 'Names in issued certificates', 'Subject attributes added to the common name of each certificate issued from now on.'],
    ['crl', 'Certificate revocation lists', 'How often CRLs are signed, how long one is served, and the next update it promises.'],
    ['ocsp', 'OCSP', 'How long an answer is valid and cached, who signs it, and how many certificates one request may ask about.'],
    ['acme', 'ACME', 'The ACME directory\'s terms, certificate validity, private names and issuing intermediate.'],
    ['public', 'Public routes', 'The URL issued certificates point at for CRLs, OCSP and issuers, and the requests each address may make.'],
    ['tokens', 'CA tokens', 'Defaults for CA tokens and tickets (Tokens tab).'],
    ['members', 'Member certificates', 'A client certificate for every member when they join, renewed before expiry and revoked when they leave. Off by default.']
  ];
  const SOURCE = { tenant: ['this tenant', 'info'], platform: ['platform', 'outline'], environment: ['environment', 'warn'], default: ['default', ''] };
  const subjectText = (o) => { const parts = ATTRS.filter((a) => o && o[a[0]]).map((a) => a[0] + '=' + o[a[0]]); return parts.length ? parts.join(', ') : 'none'; };
  const show = (k, v) => (v === null || v === undefined ? 'none' : typeof v === 'boolean' ? (v ? 'on' : 'off') : SUBJECTS.indexOf(k) >= 0 ? subjectText(v) : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const CSS = '#main .certificates-cs-sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}#main .certificates-cs-set{border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:0;min-width:0}#main .certificates-cs-set legend{font-size:12px;font-weight:600;padding:0 4px}#main .certificates-cs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 12px;min-width:0}#main .certificates-cs-row{min-width:0;overflow-wrap:anywhere}';

  App.certSettings = function (ctx, deps) {
    const st = ctx.state;
    st.cs = st.cs || { scope: 'tenant' };
    const cs = st.cs;
    const load = () => App.get('/api/pki/settings')
      .then((d) => { cs.data = d; cs.error = null; })
      .catch((err) => { cs.error = err; })
      .finally(() => { cs.loading = false; deps.later(); });
    if (!cs.data && !cs.loading && !cs.error) { cs.loading = true; load(); }
    if (cs.error) return { html: UI.problem('Certificate authority settings could not be loaded', cs.error.message, cs.error.problem && cs.error.problem.trace_id), bind() { ctx.on('click', '[data-csretry]', () => { cs.error = null; ctx.rerender(); }); } };
    if (!cs.data) return { html: UI.notice('Loading…', 'info'), bind() {} };

    const D = cs.data;
    const scope = D.canPlatform && cs.scope === 'platform' ? 'platform' : 'tenant';
    const rows = D[scope];
    const byKey = {}; rows.forEach((r) => { byKey[r.key] = r; });
    const profiles = deps.profiles();
    const issuers = deps.issuers();
    const userName = deps.userName;

    const sourceTag = (r) => { const s = SOURCE[r.source] || [r.source, '']; return UI.pill(s[0], s[1]); };
    const hint = (r) => '<span class="certificates-cs-sub">' + esc(r.range) + '. ' + (r.floor ? 'Floor ' + esc(show(r.key, r.floor.value)) + ' (' + esc(SOURCE[r.floor.source] ? SOURCE[r.floor.source][0] : r.floor.source) + '). ' : '') + esc(r.applies) + '.</span>';
    const control = (r) => {
      const k = r.key; const v = r.value; const attr = 'data-cs="' + esc(k) + '"';
      if (BOOLS.indexOf(k) >= 0) return UI.select([{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }], v ? 'true' : 'false', attr);
      if (ENUMS[k]) return UI.select(ENUMS[k], v, attr);
      if (k === 'members.profileId') return UI.select([{ value: '', label: 'None' }].concat(profiles.filter((p) => p.kind === 'client').map((p) => ({ value: p.id, label: p.name + (p.state === 'active' ? '' : ' (disabled)') }))), v || '', attr);
      if (k === 'acme.issuerId') return UI.select([{ value: '', label: 'The active intermediate' }].concat(issuers.filter((i) => i.kind === 'intermediate').map((i) => ({ value: i.id, label: i.name + ' G' + i.generation + ' (' + i.state + ')' }))), v || '', attr);
      if (k === 'profiles.subject') return UI.textarea(JSON.stringify(v || {}, null, 1), { attrs: attr + ' spellcheck="false"', rows: 3 });
      if (TEXTS.indexOf(k) >= 0) return UI.input(v || '', { type: 'url', attrs: attr, placeholder: 'none' });
      return UI.input(v === null || v === undefined ? '' : String(v), { type: 'number', attrs: attr + ' inputmode="numeric"', placeholder: NULLABLE.indexOf(k) >= 0 ? 'none' : '' });
    };
    const rowHtml = (r) => {
      const tags = '<span class="hstack wrap gap6">' + sourceTag(r) + (r.dual ? UI.pill('second admin', 'warn') : '') + (r.saved !== null && r.saved !== undefined ? UI.btn('Reset', { kind: 'ghost', size: 'xs', attrs: 'data-csreset="' + esc(r.key) + '" aria-label="Reset ' + esc(r.label) + '"' }) : '') + '</span>';
      if (SUBJECTS.indexOf(r.key) >= 0) {
        const v = r.value || {};
        return '<div class="certificates-cs-row"><fieldset class="certificates-cs-set"><legend>' + esc(r.label) + '</legend><div class="vstack gap6">' + tags + '<div class="certificates-cs-grid">'
          + ATTRS.map((a) => UI.field(a[1], UI.input(v[a[0]] || '', { attrs: 'data-cs="' + esc(r.key) + '" data-csattr="' + a[0] + '"' + (a[0] === 'C' ? ' maxlength="2"' : ' maxlength="64"') }))).join('') + '</div>' + hint(r) + '</div></fieldset></div>';
      }
      return '<div class="certificates-cs-row">' + UI.field(r.label, control(r), hint(r)) + tags + '</div>';
    };

    let html = '<style>' + CSS + '</style>';
    if (!D.configured) html += UI.notice('<b>Saved settings are not available on this server yet.</b> Migration 127_pki_settings has not run, so the environment values below apply and cannot be changed here.', 'warn');
    if (D.canPlatform) html += '<div class="hstack wrap gap6"><span class="muted" style="font-size:12px">Settings for</span>' + UI.seg([{ id: 'tenant', label: 'This tenant' }, { id: 'platform', label: 'Platform' }], scope, 'data-csscope aria-label="Settings for"') + '</div>';
    else html += '<div class="muted" style="font-size:12px">This tenant\'s settings. Platform settings and the root belong to platform administrators; a tenant may tighten them, never loosen them.</div>';

    // Pending proposals (dual control), for platform admins.
    if (D.proposals && D.proposals.length) {
      html += UI.panel('Waiting for a second platform admin', '<div class="vstack gap8">' + D.proposals.map((p) => {
        const mine = App.me && App.me.user && p.proposedBy === App.me.user.id;
        return '<div class="vstack gap4 certificates-cs-row"><div class="hstack wrap gap6"><b>' + esc(Object.keys(p.changes).join(', ')) + '</b>' + UI.pill(p.scope === 'platform' ? 'platform' : 'tenant', 'outline') + '</div>'
          + '<div class="certificates-cs-sub">' + Object.keys(p.changes).map((k) => esc(k) + ' = ' + esc(show(k, p.changes[k]))).join('; ') + '</div>'
          + '<div class="certificates-cs-sub">Proposed by ' + esc(p.proposedBy ? userName(p.proposedBy) : 'the pki:settings CLI') + (p.reason ? ': ' + esc(p.reason) : '') + '</div>'
          + '<div class="hstack wrap gap6">' + (mine ? '' : UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-csapprove="' + esc(p.id) + '"' })) + UI.btn(mine ? 'Withdraw' : 'Reject', { size: 'sm', attrs: 'data-csreject="' + esc(p.id) + '"' }) + '</div></div>';
      }).join('') + '</div>');
    }

    if (scope === 'platform' || D.issuers.intermediate) {
      const now = (label, i, tier) => (i ? '<div class="certificates-cs-row"><b>' + esc(label) + '</b> <span class="certificates-cs-sub">now ' + esc(i.keyType) + ', ' + i.days + ' days, path length ' + (i.pathLen === null ? 'unlimited' : i.pathLen) + (tier ? '; at its next rotation ' + esc(show('', tier.key)) + ', ' + esc(show('', tier.days)) + ' days, path length ' + (tier.pathLen === null || tier.pathLen === undefined ? 'unlimited' : tier.pathLen) : '') + '</span></div>' : '');
      const tier = (t) => (byKey[t + '.keyType'] ? { key: byKey[t + '.keyType'].value, days: byKey[t + '.days'].value, pathLen: byKey[t + '.pathLen'].value } : null);
      html += UI.panel('Issuers in force', '<div class="vstack gap4">' + now('Root', D.issuers.root, scope === 'platform' ? tier('root') : null) + now('This tenant\'s intermediate', D.issuers.intermediate, scope === 'platform' ? tier('intermediate') : null) + (D.issuers.root || D.issuers.intermediate ? '' : '<span class="muted">No issuer yet.</span>') + '</div>');
    }

    GROUPS.forEach((g) => {
      const list = rows.filter((r) => r.group === g[0]);
      if (!list.length) return;
      html += UI.panel(g[1], '<div class="vstack gap8"><div class="certificates-cs-sub">' + esc(g[2]) + '</div>' + list.map(rowHtml).join('') + '<div data-cserr="' + g[0] + '" role="alert"></div></div>', { actions: UI.btn('Save', { kind: 'primary', size: 'sm', attrs: 'data-cssave="' + g[0] + '"', disabled: !D.configured }), attrs: 'data-csgroup="' + g[0] + '"' });
    });

    const problemIn = (group, err) => { const box = ctx.$('[data-cserr="' + group + '"]'); const p = (err && err.problem) || {}; if (box) box.innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(err.message) + (p.key ? ' (' + esc(p.key) + ')' : ''), 'danger'); else App.fail(err, 'Could not save'); };
    const readValue = (panel, r) => {
      const k = r.key;
      if (SUBJECTS.indexOf(k) >= 0) {
        const out = {};
        panel.querySelectorAll('[data-cs="' + k + '"][data-csattr]').forEach((i) => { const v = i.value.trim(); if (v) out[i.dataset.csattr] = v; });
        return out;
      }
      const el = panel.querySelector('[data-cs="' + k + '"]'); if (!el) return undefined;
      const raw = el.value.trim();
      if (BOOLS.indexOf(k) >= 0) return raw === 'true';
      if (k === 'profiles.subject') { if (!raw) return {}; try { return JSON.parse(raw); } catch (e) { throw new Error('Subject per profile must be JSON: {"<profile id>": {"O": "…"}}.'); } }
      if (ENUMS[k] || TEXTS.indexOf(k) >= 0 || k === 'members.profileId' || k === 'acme.issuerId') return raw === '' ? null : raw;
      if (raw === '') return NULLABLE.indexOf(k) >= 0 ? null : undefined;
      return Number(raw);
    };
    const send = (body) => {
      const go = () => App.put('/api/pki/settings', body);
      return scope === 'platform' ? deps.withStepUp(go) : go();
    };
    const after = (out) => {
      if (!out) return;
      cs.data = out.settings;
      if (out.proposal) App.toast('Saved for a second platform admin: ' + Object.keys(out.proposal.changes).join(', ') + '. It applies at the next rotation or re-issue.', 'warn', 7000);
      else if (out.applied.length) App.toast('Saved: ' + out.applied.join(', ') + '. It takes effect now.', 'ok', 5000);
      else App.toast('Nothing changed.', 'info');
      deps.refresh();
    };

    return {
      html,
      bind() {
        ctx.on('click', '[data-csscope] [data-seg]', (e, t) => { cs.scope = t.dataset.seg; ctx.rerender(); });
        ctx.on('click', '[data-cssave]', (e, t) => {
          const group = t.dataset.cssave; const panel = ctx.$('[data-csgroup="' + group + '"]');
          const values = {};
          try {
            rows.filter((r) => r.group === group).forEach((r) => { const v = readValue(panel, r); if (v !== undefined && !same(v, r.value)) values[r.key] = v; });
          } catch (err) { problemIn(group, err); return; }
          if (!Object.keys(values).length) { App.toast('Nothing changed in ' + group + '.', 'info'); return; }
          const dual = Object.keys(values).filter((k) => byKey[k] && byKey[k].dual);
          const run = () => send({ scope, values }).then(after).catch((err) => problemIn(group, err));
          if (!dual.length) { run(); return; }
          ctx.confirm({ title: 'Propose a change to the ' + (group === 'root' ? 'root' : 'intermediates'), tag: 'Dual control', tone: 'warn', body: '<p class="fg2" style="margin:0">A second platform admin must approve ' + esc(dual.join(', ')) + '. It then applies at the next rotation or re-issue; no key changes now.</p>', ok: 'Propose' }).then((ok) => { if (ok) run(); });
        });
        ctx.on('click', '[data-csreset]', (e, t) => {
          const k = t.dataset.csreset; const r = byKey[k];
          ctx.confirm({ title: 'Reset ' + (r ? r.label : k), body: '<p class="fg2" style="margin:0">The value goes back to ' + (scope === 'tenant' ? 'the platform\'s' : 'the environment\'s') + '.' + (r && r.dual ? ' A second platform admin must approve it.' : '') + '</p>', ok: 'Reset' }).then((ok) => {
            if (!ok) return;
            send({ scope, reset: [k] }).then(after).catch((err) => App.fail(err, 'Could not reset'));
          });
        });
        ctx.on('click', '[data-csapprove]', (e, t) => {
          const id = t.dataset.csapprove;
          ctx.confirm({ title: 'Approve this change', tag: 'Dual control', tone: 'warn', body: '<p class="fg2" style="margin:0">It applies at the next rotation or re-issue of the root or intermediates. Nothing is re-keyed now.</p>', ok: 'Approve' }).then((ok) => {
            if (!ok) return;
            deps.withStepUp(() => App.post('/api/pki/settings/proposals/' + encodeURIComponent(id) + '/approve', {})).then((out) => { if (!out) return; App.toast('Approved. It applies at the next rotation or re-issue.', 'ok', 5000); cs.data = null; deps.refresh(); }).catch((err) => App.fail(err, 'Could not approve'));
          });
        });
        ctx.on('click', '[data-csreject]', (e, t) => {
          const id = t.dataset.csreject;
          App.post('/api/pki/settings/proposals/' + encodeURIComponent(id) + '/reject', {}).then((out) => { App.toast(out.state === 'withdrawn' ? 'Withdrawn.' : 'Rejected.', 'ok'); cs.data = null; deps.refresh(); }).catch((err) => App.fail(err, 'Could not reject'));
        });
      }
    };
  };
})();
