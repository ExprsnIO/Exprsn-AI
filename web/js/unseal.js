/*
 * 1.8.0 (B-145): the unseal page (/unseal.html). It works while the vault is sealed: it needs no session and no
 * console script, only the public seal API:
 *   GET  /api/public/vault/seal          sealed or not, the escrow's threshold, this instance's progress
 *   POST /api/public/vault/unseal        one share; at the threshold the vault is unsealed
 *   POST /api/public/vault/unseal/reset  forget the shares given so far on this instance
 *   POST /api/public/vault/break-glass   enough shares together seal it at once
 * Plain ES2017, no inline script (CSP).
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  try {
    var theme = localStorage.getItem('exprsn.theme');
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
    var a11y = localStorage.getItem('exprsn.a11y');
    if (a11y === 'aaa' || a11y === 'aa') document.documentElement.setAttribute('data-a11y', a11y);
  } catch (e) { /* storage unavailable */ }

  var notice = function (text, kind) { return '<div class="notice ' + (kind || 'info') + '"><span class="grow">' + text + '</span></div>'; };
  var when = function (t) { try { return new Date(t).toLocaleString(); } catch (e) { return ''; } };

  function api(method, url, body) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { if (!res.ok) { var err = new Error(data.detail || data.title || ('HTTP ' + res.status)); err.status = res.status; throw err; } return data; }); });
  }

  var state = { sealed: null };

  function render(st) {
    state = st;
    var status = $('unseal-status');
    var shares = $('unseal-shares');
    var bg = $('unseal-breakglass');
    if (!st.sealed) {
      $('unseal-title').textContent = 'The vault is not sealed';
      status.innerHTML = notice('Everything that needs a key works as usual. Nothing to unseal here.', 'ok') + '<p class="unseal-meta">Instance <span class="mono">' + esc(st.instance) + '</span></p>';
      shares.hidden = true;
      bg.hidden = false;
      return;
    }
    $('unseal-title').textContent = 'Unseal the vault';
    var p = st.progress || { submitted: 0, needed: null };
    var need = p.needed || (st.escrow && st.escrow.threshold) || 0;
    var dots = '';
    for (var i = 0; i < need; i++) dots += '<span class="unseal-dot' + (i < p.submitted ? ' on' : '') + '" aria-hidden="true"></span>';
    status.innerHTML = notice('<b>The vault is sealed</b>' + (st.since ? ' since ' + esc(when(st.since)) : '') + (st.mode === 'break-glass' ? ' (break-glass)' : '') + '. Nothing that needs a key runs, and nobody can sign in, until enough escrow share holders unseal it.', 'danger')
      + '<div class="unseal-card"><div class="unseal-progress"><b>' + esc(p.submitted) + ' of ' + esc(need || '?') + '</b> shares submitted to this instance' + (st.escrow ? ' (escrow <span class="mono">' + esc(st.escrow.id) + '</span>, ' + esc(st.escrow.threshold) + ' of ' + esc(st.escrow.shares) + ')' : '') + '</div><div class="unseal-dots">' + dots + '</div><div class="unseal-meta">Instance <span class="mono">' + esc(st.instance) + '</span></div></div>';
    shares.hidden = false;
    bg.hidden = true;
  }

  function load() {
    return api('GET', '/api/public/vault/seal').then(render).catch(function (err) { $('unseal-status').innerHTML = notice('The seal state could not be read: ' + esc(err.message), 'danger'); });
  }

  $('unseal-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var box = $('unseal-share');
    var text = box.value.trim();
    var out = $('unseal-result');
    if (!text) { out.innerHTML = notice('Paste your share first.', 'warn'); box.focus(); return; }
    $('unseal-submit').disabled = true;
    api('POST', '/api/public/vault/unseal', { share: text }).then(function (r) {
      box.value = '';
      if (r.sealed === false) {
        out.innerHTML = notice('<b>The vault is unsealed.</b> Every instance reopens its keys. <a href="/">Sign in to the console</a>.', 'ok');
        return load();
      }
      out.innerHTML = notice('Share accepted. ' + esc(r.progress.submitted) + ' of ' + esc(r.progress.needed) + ' shares are in; the next holder submits theirs here.', 'ok');
      return load();
    }).catch(function (err) {
      out.innerHTML = notice('<b>' + esc(err.status || '') + '</b> ' + esc(err.message), 'danger');
      return load();
    }).then(function () { $('unseal-submit').disabled = false; });
  });

  $('unseal-reset').addEventListener('click', function () {
    var out = $('unseal-result');
    api('POST', '/api/public/vault/unseal/reset', {}).then(function () { out.innerHTML = notice('The shares given so far on this instance were discarded.', 'info'); return load(); }).catch(function (err) { out.innerHTML = notice(esc(err.message), 'danger'); });
  });

  $('unseal-bg-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var out = $('unseal-bg-result');
    var shares = $('unseal-bg-shares').value.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    var reason = $('unseal-bg-reason').value.trim();
    if (shares.length < 2 || reason.length < 10) { out.innerHTML = notice('Give at least two shares and a reason of at least 10 characters.', 'warn'); return; }
    if (!window.confirm('Seal the vault on every instance now? Nothing that needs a key works until enough share holders unseal it.')) return;
    $('unseal-bg-submit').disabled = true;
    api('POST', '/api/public/vault/break-glass', { shares: shares, reason: reason }).then(function () {
      $('unseal-bg-shares').value = '';
      out.innerHTML = notice('<b>The vault is sealed.</b>', 'warn');
      return load();
    }).catch(function (err) { out.innerHTML = notice('<b>' + esc(err.status || '') + '</b> ' + esc(err.message), 'danger'); }).then(function () { $('unseal-bg-submit').disabled = false; });
  });

  load();
  setInterval(function () { if (document.visibilityState === 'visible' && document.activeElement && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') load(); }, 5000);
}());
