// 1.8.0, Sprint 47 (B-140): presence and the soft edit lock in the designers (the workflow designer, the app-flow
// canvas, the form editor and the entity designer), over the console's socket (server: realtime/design-locks.ts).
//
//   const dp = App.designPresence.use('workflow', { kind: 'workflow', id }, { unsaved: () => bool, snapshot: () => data, onRestore(data) {} });
//   html += App.designPresence.bar(dp);           // who has it open, who edits it, take over / break / restore
//   App.designPresence.bind(ctx, dp);             // inside render: wires the bar's buttons
//   if (App.designPresence.readOnly(dp)) ...      // someone else holds the lock: show read-only controls
//   App.designPresence.claim(dp);                 // on the first change: takes the lock (no-op once held)
//
// The server decides everything from the session: who may see the object (its read right, workspace and clearance),
// who may take the lock (its manage right), and who holds it. One slot per designer holds at most one open object;
// a slot whose bar is no longer on the page is closed after a moment (another tab of the screen, another route).
// When the lock is lost (taken over, broken) with unsaved changes, they are kept on this device (localStorage) and
// offered back the next time the object is opened here.
(function () {
  const { UI, esc } = App;
  const BEAT_MS = 15000;
  const slots = {};
  const byKey = {};
  let wired = null;
  let observer = null;
  let sweepTimer = null;

  const userId = () => (App.me && App.me.user ? App.me.user.id || App.me.user.username : 'me');
  const keyOf = (kind, id) => kind + ':' + id;
  const stashKey = (h) => 'exprsn.design.stash:' + userId() + ':' + h.target.kind + ':' + (h.id || h.target.id);
  const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const time = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
  const sock = () => (App.socket && App.socket.connected ? App.socket : null);

  /** Re-renders the screen soon, never while a dialog is open or someone types in it. */
  let later = null;
  function rerender() {
    if (later) return;
    later = setTimeout(() => {
      later = null;
      const a = document.activeElement;
      const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && a.closest('#main');
      const busy = Object.keys(slots).some((k) => { try { return !!(slots[k].opts.busy && slots[k].opts.busy()); } catch (e) { return false; } });
      if (document.getElementById('overlay') || typing || busy) { rerender(); return; }
      if (Object.keys(slots).length) App.render();
    }, 250);
  }

  function apply(h, st) {
    if (!st) return;
    // Only a change of who is here or who edits re-renders (a heartbeat that changes nothing does not).
    const sig = (x) => JSON.stringify([(x && x.viewers || []).map((v) => v.userId), x && x.lock ? [x.lock.userId, x.lock.mine, x.lock.since] : null]);
    const before = sig(h.st);
    h.st = Object.assign({}, h.st || {}, { viewers: st.viewers || [], lock: st.lock || null });
    if (sig(h.st) !== before) rerender();
  }

  function wire() {
    const s = App.socket;
    if (!s || wired === s) return;
    if (wired) unwire();
    wired = s;
    s.on('design.state', onState);
    s.on('design.lock.lost', onLost);
    s.on('design.closed', onClosed);
    s.on('connect', onReconnect);
  }
  function unwire() {
    if (!wired) return;
    wired.off('design.state', onState); wired.off('design.lock.lost', onLost); wired.off('design.closed', onClosed); wired.off('connect', onReconnect);
    wired = null;
  }
  function onState(d) { const h = d && byKey[keyOf(d.kind, d.id)]; if (h) apply(h, d); }
  function onClosed(d) {
    const h = d && byKey[keyOf(d.kind, d.id)]; if (!h) return;
    h.open = false; h.error = 'You no longer have access to this.'; h.st = null; rerender();
  }
  function onLost(d) {
    const h = d && byKey[keyOf(d.kind, d.id)]; if (!h) return;
    const by = d.by && d.by.name ? d.by.name : 'Someone';
    let kept = false;
    try { if (h.opts.unsaved && h.opts.unsaved()) { stash(h, h.opts.snapshot ? h.opts.snapshot() : null); kept = true; } } catch (e) { /* nothing to keep */ }
    if (d.reason === 'moved') App.toast('<span>You are editing ' + esc(h.title()) + ' in another tab now; this one is read-only.' + (kept ? ' Your unsaved changes here are kept on this device.' : '') + '</span>', 'warn', 7000);
    else App.toast('<span><b>' + esc(by) + (d.reason === 'broken' ? ' broke your edit lock' : ' took over editing') + '</b> on ' + esc(h.title()) + '.' + (kept ? ' Your unsaved changes are kept on this device; restore them once you edit again.' : '') + '</span>', 'warn', 9000);
    rerender();
  }
  function onReconnect() { Object.keys(slots).forEach((k) => { const h = slots[k]; h.open = false; h.opening = false; openNow(h); }); }

  function openNow(h) {
    wire();
    const s = sock();
    if (!s || h.opening || h.open || h.closed) { if (!s && !h.retry && !h.closed) h.retry = setTimeout(() => { h.retry = null; openNow(h); }, 1000); return; }
    h.opening = true;
    const msg = { kind: h.target.kind, id: h.target.id }; if (h.target.app) msg.app = h.target.app;
    s.emit('design.open', msg, (r) => {
      h.opening = false;
      if (h.closed) { if (r && r.ok) s.emit('design.close', { kind: h.target.kind, id: r.id }); return; }
      if (!r || !r.ok) { h.error = (r && r.error) || 'Presence is not available.'; h.open = false; rerender(); return; }
      h.open = true; h.error = null; h.id = r.id; byKey[keyOf(h.target.kind, r.id)] = h;
      h.st = { viewers: r.viewers || [], lock: r.lock || null, canManage: !!r.canManage, canBreak: !!r.canBreak, title: r.title, label: r.label };
      clearInterval(h.beat);
      h.beat = setInterval(() => beat(h), BEAT_MS);
      rerender();
    });
  }
  function beat(h) {
    const s = sock(); if (!s || !h.open || !h.id) return;
    s.emit('design.heartbeat', { kind: h.target.kind, id: h.id }, (r) => { if (r && r.ok) apply(h, r); else if (r && !r.ok && h.open) { h.open = false; h.error = r.error || 'Presence is not available.'; rerender(); } });
  }
  function close(h) {
    h.closed = true;
    clearInterval(h.beat); clearTimeout(h.retry);
    const s = sock();
    if (s && h.open && h.id) s.emit('design.close', { kind: h.target.kind, id: h.id });
    if (h.id) delete byKey[keyOf(h.target.kind, h.id)];
    h.open = false;
  }

  /** Slots whose bar left the page (another tab, another route) close after a moment. */
  function sweepSoon() {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => {
      Object.keys(slots).forEach((slot) => { if (!document.querySelector('[data-dp="' + slot + '"]')) leave(slot); });
    }, 1500);
  }
  function watchPage() {
    if (observer) return;
    const main = document.getElementById('main');
    if (!main || !window.MutationObserver) return;
    observer = new MutationObserver(sweepSoon);
    observer.observe(main, { childList: true });
    window.addEventListener('hashchange', sweepSoon);
  }

  function leave(slot) {
    const h = slots[slot]; if (!h) return;
    close(h); delete slots[slot];
  }

  function use(slot, target, opts) {
    const cur = slots[slot];
    const same = cur && cur.target.kind === target.kind && cur.target.id === target.id && (cur.target.app || '') === (target.app || '');
    if (same) { cur.opts = opts || cur.opts; if (target.title) cur.target.title = target.title; return cur; }
    if (cur) leave(slot);
    const h = { slot, target: Object.assign({}, target), opts: opts || {}, open: false, opening: false, closed: false, st: null, error: null, id: null };
    h.title = () => (h.st && h.st.title) || h.target.title || 'this design';
    slots[slot] = h;
    watchPage();
    openNow(h);
    return h;
  }

  // ---------- the lock ----------

  /** Someone else holds the lock (or this person in another tab, from its socket): edit controls are read-only. */
  function readOnly(h) {
    const l = h && h.st && h.st.lock;
    return !!(l && !l.mine && !(l.you && l.via === 'api'));
  }
  function mine(h) { const l = h && h.st && h.st.lock; return !!(l && l.mine); }

  function lockNow(h, takeover) {
    const s = sock();
    if (!s || !h.open || !h.id) return Promise.resolve(true); // no presence here: the server still guards the save
    return new Promise((resolve) => {
      s.emit('design.lock', { kind: h.target.kind, id: h.id, takeover: !!takeover }, (r) => {
        if (r && (r.viewers || r.lock !== undefined)) apply(h, r);
        if (r && r.ok) { resolve(true); return; }
        resolve(false);
      });
    });
  }

  /** The first change takes the lock; later ones find it held. Resolves false if someone else got there first. */
  function claim(h) {
    if (!h || mine(h)) return Promise.resolve(true);
    if (readOnly(h)) return Promise.resolve(false);
    if (h.st && !h.st.canManage) return Promise.resolve(true);
    if (h.claiming) return h.claiming;
    h.claiming = lockNow(h, false).then((ok) => {
      h.claiming = null;
      if (!ok) {
        const l = h.st && h.st.lock;
        try { if (h.opts.unsaved && h.opts.unsaved()) stash(h, h.opts.snapshot ? h.opts.snapshot() : null); } catch (e) { /* nothing to keep */ }
        App.toast('<span><b>' + esc(l ? l.name : 'Someone') + '</b> started editing ' + esc(h.title()) + ' first. Your change is kept on this device; take over to go on.</span>', 'warn', 8000);
        rerender();
      }
      return ok;
    });
    return h.claiming;
  }

  // ---------- unsaved state kept on this device ----------

  function stash(h, data) {
    if (data == null) return;
    try { localStorage.setItem(stashKey(h), JSON.stringify({ at: Date.now(), data })); } catch (e) { /* storage unavailable */ }
  }
  function stashed(h) {
    if (!h) return null;
    try { const v = JSON.parse(localStorage.getItem(stashKey(h)) || 'null'); return v && v.at ? v : null; } catch (e) { return null; }
  }
  function dropStash(h) { try { localStorage.removeItem(stashKey(h)); } catch (e) { /* storage unavailable */ } }

  // ---------- the bar ----------

  const CSS = '<style>#main .dp-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);font-size:12px;min-width:0}'
    + '#main .dp-bar.held{border-color:var(--warn-fg);background:var(--warn-bg);color:var(--warn-fg)}#main .dp-bar.held .dp-note{color:var(--fg)}'
    + '#main .dp-people{display:flex;flex-wrap:wrap;gap:4px 8px;list-style:none;margin:0;padding:0;min-width:0}#main .dp-people li{display:inline-flex;align-items:center;gap:4px;min-width:0}'
    + '#main .dp-people .dp-name{overflow-wrap:anywhere}#main .dp-note{overflow-wrap:anywhere;min-width:0;flex:1 1 180px}#main .dp-acts{display:flex;flex-wrap:wrap;gap:6px}</style>';

  function bar(h) {
    if (!h) return '';
    const slot = esc(h.slot);
    if (h.error && !h.open) return CSS + '<div class="dp-bar" data-dp="' + slot + '"><span class="muted">' + esc(h.error) + '</span></div>';
    if (!h.st) return CSS + '<div class="dp-bar" data-dp="' + slot + '"><span class="muted">Checking who else has this open…</span></div>';
    const viewers = h.st.viewers || [];
    const others = viewers.filter((v) => !v.you);
    const l = h.st.lock;
    const people = '<ul class="dp-people" aria-label="Who has this open">' + viewers.map((v) => '<li><span class="avatar" aria-hidden="true">' + esc(initials(v.name)) + '</span><span class="dp-name">' + esc(v.name) + (v.you ? ' (you)' : '') + '</span></li>').join('') + '</ul>';
    let note = others.length ? '' : 'Only you have this open.';
    let acts = '';
    let held = false;
    if (l && l.mine) note = 'You are editing. Others see it read-only until you save or close it.';
    else if (l && l.you && l.via === 'socket') { held = true; note = 'You are editing this in another tab since ' + esc(time(l.since)) + '. This tab is read-only.'; if (h.st.canManage) acts += UI.btn('Edit here', { size: 'xs', attrs: 'data-dp-take="' + slot + '" data-dp-quiet' }); }
    else if (l && !(l.you && l.via === 'api')) {
      held = true;
      note = '<b>Being edited by ' + esc(l.name) + '</b> since ' + esc(time(l.since)) + '. Read-only until they save or close it.';
      if (h.st.canManage) acts += UI.btn('Take over', { size: 'xs', attrs: 'data-dp-take="' + slot + '"' });
      if (h.st.canBreak) acts += UI.btn('Break lock', { size: 'xs', kind: 'ghost', attrs: 'data-dp-break="' + slot + '"' });
    } else if (others.length) note = others.length === 1 ? esc(others[0].name) + ' also has this open. The first to change something edits; the other sees it read-only.' : others.length + ' others have this open. The first to change something edits.';
    const kept = stashed(h);
    const keptHtml = kept ? '<span class="dp-note">Unsaved changes from ' + esc(time(kept.at)) + ' are kept on this device.</span><span class="dp-acts">' + (h.opts.onRestore ? UI.btn('Restore them', { size: 'xs', attrs: 'data-dp-restore="' + slot + '"', disabled: readOnly(h) }) : '') + UI.btn('Discard', { size: 'xs', kind: 'ghost', attrs: 'data-dp-discard="' + slot + '"' }) + '</span>' : '';
    return CSS + '<div class="dp-bar' + (held ? ' held' : '') + '" data-dp="' + slot + '" aria-label="Presence and editing">' + people + '<span class="dp-note">' + note + '</span>' + (acts ? '<span class="dp-acts">' + acts + '</span>' : '') + keptHtml + '</div>';
  }

  /** Wires the bar's buttons (register inside render, as every ctx.on handler). */
  function bind(ctx) {
    ctx.on('click', '[data-dp-take]', async (e, t) => {
      const h = slots[t.dataset.dpTake]; if (!h) return;
      const l = h.st && h.st.lock;
      if (!t.hasAttribute('data-dp-quiet')) {
        const ok = await ctx.confirm({ title: 'Take over editing ' + h.title(), tag: 'edit lock', tone: 'warn', body: '<p class="fg2" style="margin:0">' + esc(l ? l.name : 'The editor') + ' is told at once and can no longer save. Their unsaved changes stay on their device, not here. Audited design.lock.taken_over.</p>', ok: 'Take over' });
        if (!ok) return;
      }
      const done = await lockNow(h, true);
      if (done) ctx.toast('<span>You are editing ' + esc(h.title()) + ' now.</span>', 'ok'); else ctx.toast('<span>The edit lock was not taken. Reload and try again.</span>', 'warn');
      ctx.rerender();
    });
    ctx.on('click', '[data-dp-break]', async (e, t) => {
      const h = slots[t.dataset.dpBreak]; if (!h || !h.id) return;
      const l = h.st && h.st.lock;
      const ok = await ctx.confirm({ title: 'Break the edit lock on ' + h.title(), tag: 'admin', tone: 'danger', body: '<p class="fg2" style="margin:0">The lock of ' + esc(l ? l.name : 'its holder') + ' is removed without anyone taking it; they are told and keep their unsaved changes on their device. Audited design.lock.broken.</p>', ok: 'Break lock' });
      if (!ok) return;
      try { await App.post('/api/admin/design-locks/' + encodeURIComponent(h.target.kind) + '/' + encodeURIComponent(h.id) + '/break', {}); ctx.toast('<span>Edit lock broken. Audited design.lock.broken.</span>', 'warn'); }
      catch (err) { App.fail(err, 'Could not break the lock'); }
    });
    ctx.on('click', '[data-dp-restore]', async (e, t) => {
      const h = slots[t.dataset.dpRestore]; const kept = stashed(h); if (!h || !kept || !h.opts.onRestore) return;
      const ok = await ctx.confirm({ title: 'Restore your unsaved changes', tag: 'this device', tone: 'warn', body: '<p class="fg2" style="margin:0">The changes kept at ' + esc(time(kept.at)) + ' replace what is on screen now. Nothing is saved until you save.</p>', ok: 'Restore' });
      if (!ok) return;
      dropStash(h);
      h.opts.onRestore(kept.data);
      claim(h);
    });
    ctx.on('click', '[data-dp-discard]', (e, t) => { const h = slots[t.dataset.dpDiscard]; if (!h) return; dropStash(h); ctx.toast('<span>The kept changes were discarded.</span>'); ctx.rerender(); });
  }

  App.designPresence = { use, leave, bar, bind, readOnly, mine, claim, stash, stashed, dropStash };
})();
