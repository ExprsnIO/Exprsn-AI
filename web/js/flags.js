// Feature flags in the console (1.9.0, Sprint 52: B-169).
//
// The server sends the flags meant for the console with the session (`flags` in /api/me and /api/auth/session, and
// GET /api/me/flags). Markup gates itself with `data-feature-flag`:
//
//   <div data-feature-flag="new-composer">        shown only while new-composer is on
//   <div data-feature-flag="!new-composer">       shown only while it is off
//   <div data-feature-flag="answer-style=long">   shown only while the variant (or number) is exactly that value
//
// An unknown flag counts as off. A hidden element gets `display: none` (set through the CSSOM, which the CSP allows),
// `inert` and `data-feature-flag-off`; it comes back when the flag turns on.
//
// The attribute is data-feature-flag, not data-flag: Moderation, Flags and SLA screens use data-flag for flag ids
// (2026-10-18: the gate hid their rows). The hook: app.js is not changed. A MutationObserver on the document catches every element with `data-feature-flag` the
// moment a screen, a dialog or a drawer puts it in the page (or changes the attribute), before the browser paints, so
// nothing flashes. `#main` is replaced on every render, which is why the observer watches the whole document rather
// than `#main` itself. App.setMe is wrapped so a new /api/me answer re-applies the gates, and the flags are fetched
// again at most once a minute when the route changes, so a change made elsewhere reaches an open console. Since
// 1.9.9-qa a `flags.changed` socket event (no values) makes it fetch at once; the minute stays as the fallback.
(function () {
  if (!window.App) return;
  const OFF = 'data-feature-flag-off';
  let fetched = 0;
  let inflight = null;

  const current = () => (App.me && App.me.flags) || {};
  const isOn = (v) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v > 0 : typeof v === 'string' ? v !== '' && v !== 'off' : false);

  /** Whether an element with this `data-feature-flag` value may be shown. */
  function allowed(spec) {
    spec = String(spec || '').trim();
    if (!spec) return true;
    const neg = spec.charAt(0) === '!';
    const body = neg ? spec.slice(1) : spec;
    const i = body.indexOf('=');
    const key = i < 0 ? body : body.slice(0, i);
    const v = current()[key];
    const on = i < 0 ? isOn(v) : v !== undefined && v !== null && String(v) === body.slice(i + 1);
    return neg ? !on : on;
  }

  function apply(el) {
    const ok = allowed(el.getAttribute('data-feature-flag'));
    if (!ok && !el.hasAttribute(OFF)) {
      el.setAttribute(OFF, el.style.getPropertyValue('display') || '');
      el.style.setProperty('display', 'none', 'important');
      el.inert = true;
    } else if (ok && el.hasAttribute(OFF)) {
      const prev = el.getAttribute(OFF);
      el.removeAttribute(OFF);
      if (prev) el.style.setProperty('display', prev); else el.style.removeProperty('display');
      el.inert = false;
    }
  }

  function sweep(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.hasAttribute('data-feature-flag')) apply(root);
    root.querySelectorAll('[data-feature-flag]').forEach(apply);
  }
  const sweepAll = () => sweep(document.documentElement);

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') { if (r.target.nodeType === 1 && r.target.hasAttribute('data-feature-flag')) apply(r.target); else if (r.target.hasAttribute && r.target.hasAttribute(OFF)) apply(r.target); continue; }
      r.addedNodes.forEach(sweep);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-feature-flag'] });

  /** Fetches the flags again (at most once a minute unless forced) and re-applies every gate. */
  function refresh(force) {
    if (!App.me) return Promise.resolve(current());
    if (inflight) return inflight;
    if (!force && Date.now() - fetched < 60000) return Promise.resolve(current());
    fetched = Date.now();
    inflight = App.get('/api/me/flags')
      .then((r) => { if (App.me) App.me.flags = (r && r.flags) || {}; sweepAll(); return current(); })
      .catch(() => current())
      .then((v) => { inflight = null; return v; });
    return inflight;
  }

  const setMe = App.setMe;
  if (typeof setMe === 'function') App.setMe = function (me) { const out = setMe.apply(this, arguments); fetched = Date.now(); sweepAll(); return out; };
  window.addEventListener('hashchange', () => { refresh(false); });

  // 1.9.9-qa: live changes. The server emits `flags.changed` (no keys, no values) to the sockets of the tenant a change
  // affects, or to every socket for a platform change; the console fetches its own flags again at once (after a short
  // random wait, so a whole tenant's consoles do not ask in the same instant) and re-applies every gate. A socket that
  // reconnects may have missed one, so it fetches too. The one-minute refetch on route changes stays as the fallback.
  let liveTimer = null;
  function soon() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => { liveTimer = null; (inflight || Promise.resolve()).then(() => refresh(true)); }, 50 + Math.floor(Math.random() * 400));
  }
  function hookSocket() {
    const sock = App.socket;
    if (!sock || sock.__flagsLive) return;
    sock.__flagsLive = true;
    let first = !sock.connected;
    sock.on('flags.changed', soon);
    sock.on('connect', () => { if (first) { first = false; return; } soon(); });
  }
  hookSocket();
  setInterval(hookSocket, 1000);

  App.flags = {
    /** Whether a flag is on for the signed-in person (unknown flags are off). */
    on: (key) => isOn(current()[key]),
    /** A flag's value, or null. */
    value: (key) => (Object.prototype.hasOwnProperty.call(current(), key) ? current()[key] : null),
    all: () => Object.assign({}, current()),
    allowed,
    refresh,
    apply: sweepAll,
    /** Whether this console hears live flag changes over its socket. */
    live: () => !!(App.socket && App.socket.__flagsLive)
  };
}());
