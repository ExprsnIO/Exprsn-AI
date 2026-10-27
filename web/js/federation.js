/* Protocol pages served by the federation routes (no inline scripts: CSP script-src 'self').
   data-mode="continue": re-check the session from our own origin and resume, or sign in first.
   data-mode="device":   the RFC 8628 verification page (approve a device code as the signed-in user).
   data-mode="autopost": submit the SAML response form to the service provider.
   data-mode="reauth":   prompt=login or max_age: sign out of this session, then sign in again and resume.
   data-mode="logout":   the signed-out page: let the front-channel logout frames load, then continue. */
(function () {
  'use strict';
  var body = document.body;
  var mode = body.getAttribute('data-mode');
  var KEY = 'exprsn.continue';
  var LOOP = 'exprsn.continued';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* storage blocked: the user resumes by hand */ } }
  function read(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function session() { return fetch('/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }); }
  function signIn(url) { store(KEY, url); location.replace('/#/signin'); }

  if (mode === 'autopost') {
    var f = document.querySelector('form[data-autopost]');
    if (f) f.submit();
    return;
  }

  if (mode === 'continue') {
    var url = body.getAttribute('data-continue');
    session().then(function (s) {
      // Resume once from our own origin (the session cookie is SameSite=Strict); a second arrival means it did not help.
      var last = read(LOOP);
      if (s && s.authenticated && last !== url) { store(LOOP, url); location.replace(url); return; }
      store(LOOP, null);
      signIn(url);
    }, function () { signIn(url); });
    return;
  }

  if (mode === 'reauth') {
    var again = body.getAttribute('data-continue');
    session().then(function (s) {
      if (!s || !s.authenticated) { signIn(again); return; }
      return fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'x-csrf-token': s.csrf || '' } })
        .then(function () { store(LOOP, null); signIn(again); });
    }, function () { signIn(again); });
    return;
  }

  if (mode === 'logout') {
    var next = body.getAttribute('data-continue');
    var post = document.querySelector('form[data-logoutpost]');
    var frames = Array.prototype.slice.call(document.querySelectorAll('iframe'));
    var left = frames.length;
    var gone = false;
    var go = function () {
      if (gone) return;
      gone = true;
      if (post) post.submit(); else if (next) location.assign(next);
    };
    frames.forEach(function (f) { f.addEventListener('load', function () { left -= 1; if (left <= 0) go(); }); });
    // Frames that never load (an application that is down) do not hold the sign-out up for long.
    if (!frames.length) go(); else setTimeout(go, 3000);
    return;
  }

  if (mode === 'device') {
    var form = document.querySelector('form[data-device]');
    var out = form.querySelector('[data-out]');
    var input = form.querySelector('#uc');
    var csrf = null;
    var found = null;
    var here = body.getAttribute('data-continue');
    var notice = function (html, kind) { out.innerHTML = '<div class="notice ' + kind + '">' + html + '</div>'; };
    var problem = function (r) { return r.json().catch(function () { return {}; }).then(function (p) { throw new Error(p.detail || p.title || 'The request failed.'); }); };
    session().then(function (s) {
      if (!s || !s.authenticated) { signIn(here + (here.indexOf('?') < 0 && input.value ? '?user_code=' + encodeURIComponent(input.value) : '')); return; }
      csrf = s.csrf;
      if (s.user) notice('Signed in as <b>' + esc(s.user.displayName || s.user.username) + '</b>.', 'info');
      if (input.value) lookup();
    }, function () { notice('The session could not be checked. Reload the page.', 'danger'); });

    var lookup = function () {
      var code = input.value.trim();
      if (!code) { notice('Enter the code your device shows.', 'warn'); return; }
      fetch('/api/auth/device?user_code=' + encodeURIComponent(code), { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : problem(r); })
        .then(function (d) {
          found = d;
          out.innerHTML = '<div class="notice info"><b>' + esc(d.client.name) + '</b> asks to act as you with:</div><ul class="mono" style="margin:0;padding-left:18px;font-size:12px">' + d.scopes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
            + '<div class="hstack gap6"><button type="button" class="btn primary" data-approve="1">Approve</button><button type="button" class="btn" data-approve="0">Deny</button></div>';
          form.querySelector('[data-lookup]').style.display = 'none';
        }, function (err) { notice(esc(err.message), 'danger'); });
    };
    var decide = function (approve) {
      fetch('/api/auth/device', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf || '' }, body: JSON.stringify({ userCode: input.value.trim(), approve: approve }) })
        .then(function (r) { return r.ok ? r.json() : problem(r); })
        .then(function (d) { input.disabled = true; notice(d.approved ? '<b>Approved.</b> Return to your device; it signs in within a few seconds.' : 'Denied. The device will not get a token.', d.approved ? 'ok' : 'warn'); }, function (err) { notice(esc(err.message), 'danger'); });
    };
    form.addEventListener('submit', function (e) { e.preventDefault(); if (!found) lookup(); });
    out.addEventListener('click', function (e) { var b = e.target.closest('[data-approve]'); if (b) decide(b.getAttribute('data-approve') === '1'); });
  }
})();
