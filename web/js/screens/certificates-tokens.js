// Certificates › Tokens (1.9.0, Sprint 55, B-188): CA tokens and one-time tickets. `certificates.js` calls
// App.certTokens(ctx, deps) for the tab's markup and its handlers; the state lives in ctx.state.ct. A token is shown
// once when it is issued (the server keeps only its id and hash); this tab lists, checks, refreshes and revokes them,
// and shows the token signers (rotated on a schedule; revoking a signer's certificate ends its tokens).
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const when = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const TONE = { active: 'ok', revoked: 'danger', spent: '', replaced: 'outline' };
  const RES = [{ value: 'url', label: 'URL' }, { value: 'did', label: 'DID' }, { value: 'cid', label: 'CID' }];
  const CSS = '#main .certificates-ct-sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}#main .certificates-ct-token{font-family:var(--mono);font-size:11px;overflow-wrap:anywhere;word-break:break-all;max-height:160px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 8px;background:var(--panel)}#main .certificates-ct-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px 12px;min-width:0}';
  const problem = (m, err) => { const p = err.problem || {}; const box = m.querySelector('[data-cterr]'); if (box) box.innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(err.message), 'danger'); };

  App.certTokens = function (ctx, deps) {
    const st = ctx.state;
    st.ct = st.ct || { filter: 'active' };
    const ct = st.ct;
    const load = () => App.get('/api/pki/tokens?limit=500' + (ct.filter === 'all' ? '' : '&state=' + enc(ct.filter)))
      .then((d) => { ct.data = d; ct.error = null; })
      .catch((err) => { ct.error = err; })
      .finally(() => { ct.loading = false; deps.later(); });
    if (!ct.data && !ct.loading && !ct.error) { ct.loading = true; load(); }
    if (ct.error) return { html: UI.problem('CA tokens could not be loaded', ct.error.message, ct.error.problem && ct.error.problem.trace_id), bind() {} };
    if (!ct.data) return { html: UI.notice('Loading…', 'info'), bind() {} };
    const D = ct.data;
    const userName = deps.userName;
    const users = deps.users();
    const reload = () => { ct.data = null; deps.refresh(); };

    let html = '<style>' + CSS + '</style>';
    if (!D.configured) {
      html += UI.notice('<b>CA tokens are not configured on this server yet.</b> Migration 128_ca_tokens has not run; tokens cannot be issued or checked until it does.', 'warn');
      return { html, bind() {} };
    }
    const d = D.defaults;
    if (ct.revealed) {
      html += UI.notice('<b>' + esc(ct.revealed.kind === 'ticket' ? 'Ticket' : 'Token') + ' issued.</b> It is shown once; the server keeps only its id and a hash. Give it to the holder now.<div class="certificates-ct-token" style="margin-top:6px" tabindex="0" aria-label="The new token">' + esc(ct.revealed.token) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copy="' + esc(ct.revealed.token) + '"' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-ctdone' }));
    }
    html += '<div class="hstack wrap gap6"><span class="muted grow" style="font-size:12px">Tokens are signed in custody (' + esc(d.signature) + ') and bound to one URL, DID or CID with permission bits. Defaults: ' + esc(d.expiry) + ', ' + d.ttlMinutes + ' minutes, ' + d.uses + ' use' + (d.uses === 1 ? '' : 's') + ', at most ' + d.maxBytes + ' bytes (Settings tab).</span>'
      + UI.btn('Issue token', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-ctissue' }) + UI.btn('Issue ticket', { size: 'sm', attrs: 'data-ctticket' }) + UI.btn('Check a token', { size: 'sm', attrs: 'data-ctcheck' }) + UI.btn('Revoke in bulk', { kind: 'ghost', size: 'sm', attrs: 'data-ctbulk' }) + '</div>';
    html += '<div class="hstack wrap gap6"><span class="muted" style="font-size:12px">Show</span>' + UI.seg([{ id: 'active', label: 'Active' }, { id: 'all', label: 'All' }, { id: 'revoked', label: 'Revoked' }, { id: 'spent', label: 'Spent' }], ct.filter, 'data-ctfilter aria-label="Show tokens"') + '</div>';
    html += UI.table(['Resource', 'Kind', 'Permissions', 'Ends', 'Uses left', 'Subject', 'State', 'Issued', { label: '', right: true }], D.tokens.map((t) => [
      '<span class="mono" style="font-size:12px;overflow-wrap:anywhere">' + esc(t.resource.type + ' ' + t.resource.id) + '</span>' + (t.label ? '<div class="certificates-ct-sub">' + esc(t.label) + '</div>' : ''),
      esc(t.kind === 'ticket' ? 'ticket: ' + t.action : 'token'),
      esc(t.permissions.join(', ')),
      t.expiry === 'persistent' ? 'persistent' : t.expiresAt ? esc(when(t.expiresAt)) : esc(t.expiry),
      t.maxUses === null ? '<span class="muted">no limit</span>' : '<span class="num">' + t.usesLeft + ' of ' + t.maxUses + '</span>',
      t.subject ? esc(userName(t.subject)) : '<span class="muted">none</span>',
      UI.pill(t.state, TONE[t.state] || '') + (t.revokedReason ? '<div class="certificates-ct-sub">' + esc(t.revokedReason) + '</div>' : ''),
      esc(when(t.createdAt)),
      t.state === 'active' ? UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-ctrevoke="' + esc(t.id) + '" aria-label="Revoke the token for ' + esc(t.resource.id) + '"' }) : ''
    ]), { clickable: false, minWidth: '900px', emptyTitle: 'No tokens here', emptyText: 'Issue a token for a resource, or a one-time ticket for a single action.' });
    html += UI.panel('Token signers', '<div class="vstack gap6"><div class="certificates-ct-sub">Each signer is a certificate under the tenant\'s intermediate with its key in custody. It rotates every ' + d.rotationDays + ' days and when the intermediate or the signature setting changes; a retired signer keeps verifying what it signed. Revoke a signer\'s certificate on the Certificates tab to end every token it signed.</div>'
      + UI.table(['Signer', 'Algorithm', 'Custody', 'State', 'Valid to', 'Created', 'Certificate'], D.signers.map((sg) => ['<span class="mono">' + esc(sg.id.slice(-6)) + '</span>', esc(sg.alg + ' (' + sg.keyType + ')'), esc(sg.custody), UI.pill(sg.state, sg.state === 'active' ? 'ok' : ''), esc(when(sg.notAfter)), esc(when(sg.createdAt)), '<a href="#" data-certlink="' + esc(sg.certificateId) + '">' + esc(sg.certificateId.slice(-6)) + '</a>']), { clickable: false, minWidth: '720px', emptyTitle: 'No signer yet', emptyText: 'The first token makes one under the active intermediate.' }) + '</div>', { actions: UI.btn('Rotate now', { size: 'sm', attrs: 'data-ctrotate' }) });
    html += '<div class="muted" style="font-size:12px">A resource server validates with <span class="mono">POST /api/pki/tokens/validate</span> (pki:tokens), or checks the signature offline against the chain at <span class="mono">/pki/tokens/&lt;tenant&gt;/keys</span>.</div>';

    const resourceFields = (prefix) => '<div class="certificates-ct-grid">' + UI.field('Resource type', UI.select(RES, 'url', 'data-' + prefix + 'rtype')) + UI.field('Resource', UI.input('', { attrs: 'data-' + prefix + 'rid maxlength="500"', placeholder: 'https://files.example.com/docs/' }), 'A URL covers the paths below it; a DID or CID only itself') + '</div>';
    const permChecks = () => '<div class="field" role="group" aria-label="Permissions"><span class="fl">Permissions</span><div class="hstack wrap gap8">' + D.permissions.map((p) => UI.check(p, p === 'read', 'data-ctperm="' + esc(p) + '"')).join('') + '</div></div>';
    const subjectSelect = () => UI.field('Subject (optional)', UI.select([{ value: '', label: 'Nobody in particular' }].concat(Object.keys(users).map((id) => ({ value: id, label: users[id] }))), '', 'data-ctsub'));
    const resourceOf = (m, prefix) => ({ type: m.querySelector('[data-' + prefix + 'rtype]').value, id: m.querySelector('[data-' + prefix + 'rid]').value.trim() });
    const permsOf = (m) => [].slice.call(m.querySelectorAll('[data-ctperm]')).filter((i) => i.checked).map((i) => i.dataset.ctperm);
    const reveal = (out) => { ct.revealed = { token: out.token, kind: out.kind }; App.closeOverlay(); App.toast(out.kind === 'ticket' ? 'Ticket issued.' : 'Token issued.', 'ok'); reload(); };

    return {
      html,
      bind() {
        ctx.on('click', '[data-ctfilter] [data-seg]', (e, t) => { ct.filter = t.dataset.seg; reload(); });
        ctx.on('click', '[data-ctdone]', () => { ct.revealed = null; ctx.rerender(); });
        ctx.on('click', '[data-ctissue]', () => {
          ctx.modal({ title: 'Issue a CA token',
            body: resourceFields('ct') + permChecks()
              + '<div class="certificates-ct-grid">' + UI.field('Expiry', UI.select([{ value: 'time', label: 'By time' }, { value: 'uses', label: 'By number of uses' }, { value: 'persistent', label: 'Persistent (until revoked)' }], d.expiry, 'data-ctexp')) + UI.field('Lifetime (minutes)', UI.input(String(d.ttlMinutes), { type: 'number', attrs: 'data-ctttl min="1" max="525600"' })) + UI.field('Uses', UI.input(String(d.uses), { type: 'number', attrs: 'data-ctuses min="1" max="1000000"' })) + '</div>'
              + subjectSelect() + UI.field('Label (optional)', UI.input('', { attrs: 'data-ctlabel maxlength="200"' })) + '<div data-cterr role="alert"></div>',
            actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Issue', { kind: 'primary', attrs: 'data-ctgo' }),
            onMount(m) {
              const first = m.querySelector('[data-ctrid]'); if (first) first.focus();
              m.querySelector('[data-ctgo]').addEventListener('click', () => {
                const kind = m.querySelector('[data-ctexp]').value;
                const ttl = Number(m.querySelector('[data-ctttl]').value); const uses = Number(m.querySelector('[data-ctuses]').value);
                const expiry = kind === 'time' ? { kind, ttlMinutes: ttl } : kind === 'uses' ? { kind, uses } : { kind };
                const body = { resource: resourceOf(m, 'ct'), permissions: permsOf(m), expiry, subject: m.querySelector('[data-ctsub]').value || null, label: m.querySelector('[data-ctlabel]').value.trim() || null };
                App.post('/api/pki/tokens', body).then(reveal).catch((err) => problem(m, err));
              });
            } });
        });
        ctx.on('click', '[data-ctticket]', () => {
          ctx.modal({ title: 'Issue a one-time ticket',
            body: '<p class="fg2" style="margin:0">A ticket is good for one use of one action, for at most ' + D.ticketMaxMinutes + ' minutes.</p>' + resourceFields('tk') + permChecks()
              + '<div class="certificates-ct-grid">' + UI.field('Action', UI.input('', { attrs: 'data-tkact maxlength="100"', placeholder: 'files.download' })) + UI.field('Lifetime (minutes)', UI.input('15', { type: 'number', attrs: 'data-tkttl min="1" max="' + D.ticketMaxMinutes + '"' })) + '</div>' + subjectSelect() + '<div data-cterr role="alert"></div>',
            actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Issue ticket', { kind: 'primary', attrs: 'data-tkgo' }),
            onMount(m) {
              const first = m.querySelector('[data-tkrid]'); if (first) first.focus();
              m.querySelector('[data-tkgo]').addEventListener('click', () => {
                const body = { resource: resourceOf(m, 'tk'), permissions: permsOf(m), action: m.querySelector('[data-tkact]').value.trim(), ttlMinutes: Number(m.querySelector('[data-tkttl]').value), subject: m.querySelector('[data-ctsub]').value || null };
                App.post('/api/pki/tickets', body).then(reveal).catch((err) => problem(m, err));
              });
            } });
        });
        ctx.on('click', '[data-ctcheck]', () => {
          ctx.modal({ title: 'Check a token',
            body: '<p class="fg2" style="margin:0">Introspection says what a token is without spending a use.</p>' + UI.field('Token', UI.textarea('', { attrs: 'data-ctin spellcheck="false"', rows: 4 })) + '<div data-ctout aria-live="polite"></div><div data-cterr role="alert"></div>',
            actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Refresh it', { attrs: 'data-ctref' }) + UI.btn('Check', { kind: 'primary', attrs: 'data-ctgo' }),
            onMount(m) {
              m.querySelector('[data-ctin]').focus();
              m.querySelector('[data-ctgo]').addEventListener('click', () => {
                App.post('/api/pki/tokens/introspect', { token: m.querySelector('[data-ctin]').value.trim() }).then((r) => {
                  m.querySelector('[data-cterr]').innerHTML = '';
                  m.querySelector('[data-ctout]').innerHTML = r.active ? UI.notice('<b>Active.</b> ' + esc(r.token_type) + ' for ' + esc(r.resource.type + ' ' + r.resource.id) + ', ' + esc(r.permissions.join(', ')) + (r.uses_left !== null ? ', ' + r.uses_left + ' uses left' : '') + (r.exp ? ', until ' + esc(when(r.exp * 1000)) : ''), 'ok') : UI.notice('<b>Not active:</b> ' + esc(r.reason) + '.', 'warn');
                }).catch((err) => problem(m, err));
              });
              m.querySelector('[data-ctref]').addEventListener('click', () => {
                App.post('/api/pki/tokens/refresh', { token: m.querySelector('[data-ctin]').value.trim() }).then(reveal).catch((err) => problem(m, err));
              });
            } });
        });
        ctx.on('click', '[data-ctbulk]', () => {
          ctx.modal({ title: 'Revoke tokens in bulk',
            body: '<p class="fg2" style="margin:0">Every active token that matches is revoked. Choose one filter.</p>'
              + UI.field('Revoke', UI.select([{ value: 'subject', label: 'Every token of a person' }, { value: 'resource', label: 'Every token for a resource (and below it)' }, { value: 'all', label: 'Every active token of this tenant' }], 'subject', 'data-bkby'))
              + subjectSelect() + resourceFields('bk') + UI.field('Reason', UI.input('', { attrs: 'data-bkwhy maxlength="100"' })) + '<div data-cterr role="alert"></div>',
            actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Revoke', { kind: 'danger', attrs: 'data-bkgo' }),
            onMount(m) {
              m.querySelector('[data-bkby]').focus();
              m.querySelector('[data-bkgo]').addEventListener('click', () => {
                const by = m.querySelector('[data-bkby]').value; const reason = m.querySelector('[data-bkwhy]').value.trim() || null;
                const body = by === 'subject' ? { subject: m.querySelector('[data-ctsub]').value || undefined, reason } : by === 'resource' ? { resource: resourceOf(m, 'bk'), reason } : { all: true, reason };
                App.post('/api/pki/tokens/revoke', body).then((r) => { App.closeOverlay(); App.toast(r.revoked + ' token' + (r.revoked === 1 ? '' : 's') + ' revoked.', 'ok'); reload(); }).catch((err) => problem(m, err));
              });
            } });
        });
        ctx.on('click', '[data-ctrevoke]', (e, t) => {
          const id = t.dataset.ctrevoke;
          ctx.confirm({ title: 'Revoke this token', tone: 'danger', body: '<p class="fg2" style="margin:0">Validation refuses it from now on, on every instance.</p>', ok: 'Revoke' }).then((ok) => {
            if (!ok) return;
            App.post('/api/pki/tokens/' + enc(id) + '/revoke', {}).then(() => { App.toast('Token revoked.', 'ok'); reload(); }).catch((err) => App.fail(err, 'Could not revoke the token'));
          });
        });
        ctx.on('click', '[data-ctrotate]', () => {
          ctx.confirm({ title: 'Rotate the token signer', body: '<p class="fg2" style="margin:0">A new key and certificate sign tokens from now on. The current signer is retired and keeps verifying what it signed.</p>', ok: 'Rotate' }).then((ok) => {
            if (!ok) return;
            App.post('/api/pki/tokens/signers/rotate', {}).then(() => { App.toast('Token signer rotated.', 'ok'); reload(); deps.reloadAll(); }).catch((err) => App.fail(err, 'Could not rotate the token signer'));
          });
        });
      }
    };
  };
})();
