// 1.8.0, Sprint 48 (B-149): knowledge feedback and the reference tree, used by knowledge.js (a document's drawer and
// the Feedback tab), knowledge-references.js (the tree, breadcrumbs, children and backlinks) and chat.js (a
// citation's drawer).
//
//   App.kbFeedback.slot() / attach(el, target)   "Was this helpful?" with thumbs up or down and an optional comment;
//                                                target is {kind:'document', id}, {kind:'reference', id} or
//                                                {kind:'citation', conversationId, messageId, n}
//   App.kbCuration(ctx, kb, deps)                 the Feedback tab: counts, the curation list, comments, eval seed
//   App.kbTree                                    the References tab's tree and the drawer's breadcrumbs and links
//
// The server decides who sees what: comments are screened by the user-input guardrail and sealed, the counts are for
// the base's editors and curators, and nothing about a page the reader cannot read is ever returned.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const CSS = '.kbfb{border:1px solid var(--line);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:var(--panel)}.kbfb .hstack{flex-wrap:wrap}.kbfb [aria-pressed="true"]{border-color:var(--accent);background:var(--accent-tint)}'
    + '.kbtree{list-style:none;margin:0;padding:0}.kbtree .kbtree{padding-left:18px;border-left:1px solid var(--line);margin-left:8px}.kbtree li{margin:2px 0}.kbtree-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 6px;border-radius:6px}.kbtree-row:hover{background:var(--panel2)}.kbtree-row .t{font:inherit;background:none;border:0;color:var(--fg);cursor:pointer;text-align:left;padding:0;font-weight:600}.kbtree-row .t:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.kbtree-sub{font-size:12px;color:var(--muted)}'
    + '.kbcrumbs{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:12px;margin:0;padding:0;list-style:none}.kbcrumbs li+li::before{content:"/";color:var(--muted);margin-right:4px}.kbcrumbs a{color:var(--accent)}';
  const style = '<style>' + CSS + '</style>';
  const query = (t) => (t.kind === 'citation' ? 'conversation=' + enc(t.conversationId) + '&message=' + enc(t.messageId) + '&n=' + enc(t.n) : t.kind + '=' + enc(t.id));
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  let seq = 0;

  // ---------- "Was this helpful?" ----------

  function slot() { return style + '<div data-kbfb class="kbfb" aria-live="polite"><span class="muted" style="font-size:12px">Reading…</span></div>'; }

  function attach(el, target) {
    if (!el) return;
    const id = 'kbfb-' + (++seq);
    let mine = null; let open = false;
    const draw = () => {
      const up = mine && mine.helpful === true, down = mine && mine.helpful === false;
      el.innerHTML = '<div class="hstack gap6"><span class="grow" id="' + id + '" style="font-weight:600;font-size:13px">Was this helpful?</span>'
        + '<span role="group" aria-labelledby="' + id + '" class="hstack gap6">' + UI.btn('Yes', { size: 'sm', icon: 'thumb', attrs: 'data-fbvote="1" aria-pressed="' + (up ? 'true' : 'false') + '"' }) + UI.btn('No', { size: 'sm', attrs: 'data-fbvote="0" aria-pressed="' + (down ? 'true' : 'false') + '"' }) + '</span></div>'
        + (mine ? '<div class="muted" style="font-size:12px">You said ' + (mine.helpful ? 'it helped' : 'it did not help') + (mine.comment ? ': ' + esc(mine.comment) : '') + '. ' + '<a href="#" data-fbcomment>' + (mine.comment ? 'Change the comment' : 'Add a comment') + '</a> · <a href="#" data-fbwithdraw>Withdraw</a></div>' : '<div class="muted" style="font-size:12px">Your answer goes to the editors of this knowledge base.</div>')
        + (open ? UI.field('Comment', UI.textarea(mine && mine.comment ? mine.comment : '', { rows: 2, attrs: 'data-fbtext maxlength="1000"' }), 'Optional. Screened like any post; editors and curators read it.')
          + (target.kind === 'citation' ? UI.check('Let the editors use my question as a test case', false, 'data-fbshare') : '')
          + '<div class="hstack gap6">' + UI.btn('Send', { size: 'sm', kind: 'primary', attrs: 'data-fbsend' }) + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-fbcancel' }) + '</div>' : '')
        + '<div data-fberr role="alert"></div>';
      wire();
    };
    const fail = (err) => { const e = el.querySelector('[data-fberr]'); if (e) e.innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Not sent') + '.</b> ' + esc(err.message), 'danger'); };
    const send = async (helpful, comment, share) => {
      try {
        mine = await App.post('/api/knowledge/feedback', Object.assign({ target: target, helpful: helpful }, comment ? { comment: comment } : {}, share ? { shareQuestion: true } : {}));
        open = !comment && !helpful ? true : false;
        draw();
        App.toast(comment ? 'Thank you. Your comment was sent to the editors.' : 'Thank you for the feedback.', 'ok', 2500);
        const ta = el.querySelector('[data-fbtext]'); if (ta) ta.focus();
      } catch (err) { fail(err); }
    };
    function wire() {
      el.querySelectorAll('[data-fbvote]').forEach((b) => b.addEventListener('click', () => send(b.dataset.fbvote === '1', mine && mine.comment ? mine.comment : null, false)));
      const c = el.querySelector('[data-fbcomment]'); if (c) c.addEventListener('click', (e) => { e.preventDefault(); open = true; draw(); const ta = el.querySelector('[data-fbtext]'); if (ta) ta.focus(); });
      const cancel = el.querySelector('[data-fbcancel]'); if (cancel) cancel.addEventListener('click', () => { open = false; draw(); });
      const s = el.querySelector('[data-fbsend]'); if (s) s.addEventListener('click', () => { const text = el.querySelector('[data-fbtext]').value.trim(); const share = el.querySelector('[data-fbshare]'); send(mine ? mine.helpful : false, text, !!(share && share.checked)); });
      const w = el.querySelector('[data-fbwithdraw]'); if (w) w.addEventListener('click', async (e) => { e.preventDefault(); try { await App.del('/api/knowledge/feedback/' + enc(mine.id)); mine = null; open = false; draw(); App.toast('Your feedback was withdrawn.', 'ok', 2500); } catch (err) { fail(err); } });
    }
    App.get('/api/knowledge/feedback/mine?' + query(target)).then((r) => { mine = r.mine; draw(); }).catch((err) => { if (err.status === 404 || err.status === 403) { el.style.display = 'none'; return; } draw(); });
  }

  App.kbFeedback = { slot, attach };

  // ---------- the Feedback tab ----------

  App.kbCuration = function (ctx, kb, deps) {
    const st = ctx.state;
    st.kbfb = st.kbfb || {};
    const base = '/api/knowledge/bases/' + enc(kb.id);
    const data = st.kbfb[kb.id];
    const load = () => App.get(base + '/feedback').then((r) => { st.kbfb[kb.id] = { stats: r, at: Date.now() }; deps.later(); }).catch((err) => { st.kbfb[kb.id] = { error: err, at: Date.now() }; deps.later(); });
    if (!data) { st.kbfb[kb.id] = { loading: true }; load(); }
    else if (data.at && Date.now() - data.at > 30000) { data.at = Date.now(); load(); }
    let html = style;
    if (!data || data.loading) html += UI.notice('Loading…', 'info');
    else if (data.error) html += data.error.status === 403 ? UI.notice('Feedback on a knowledge base is for its editors and curators. Readers answer "Was this helpful?" on documents, references and chat sources.', 'info') : UI.problem('The feedback could not be loaded', data.error.message, data.error.problem && data.error.problem.trace_id);
    else {
      const s = data.stats;
      const pct = (x) => (x == null ? 'no answers' : Math.round(x * 100) + '%');
      const row = (g) => ({ cells: ['<b>' + esc(g.title) + '</b>' + (g.slug ? '<div class="kbtree-sub mono">' + esc(g.slug) + '</div>' : ''), '<span class="num">' + g.up + '</span>', '<span class="num">' + g.down + '</span>', esc(pct(g.helpfulness)), String(g.comments), esc(when(g.lastAt))], attrs: 'data-fbitem="' + esc(g.key) + '"' });
      html += '<div class="stats">' + UI.stat(String(s.totals.answers), 'Answers', 'at or below your clearance') + UI.stat(String(s.totals.helpful), 'Helpful', '') + UI.stat(String(s.totals.notHelpful), 'Not helpful', '') + UI.stat(String(s.curation.length), 'To look at', 'on the curation list') + '</div>'
        + '<div class="toolbar"><span class="muted" style="font-size:12px">The curation list holds pages with at least ' + s.rule.minAnswers + ' answers and fewer than ' + Math.round(s.rule.below * 100) + '% helpful, or a negative comment in the last ' + s.rule.recentDays + ' days.</span><span class="right">' + UI.btn('Export negative cases as an eval seed', { size: 'sm', icon: 'download', attrs: 'data-fbseed' }) + '</span></div>'
        + '<div class="eyebrow">Curation list</div>' + UI.table(['Page', { label: 'Helpful', right: true }, { label: 'Not helpful', right: true }, 'Share helpful', 'Comments', 'Last answer'], s.curation.map((g) => { const r = row(g); r.cells[0] += '<div class="kbtree-sub">' + g.reasons.map((x) => esc(x)).join(', ') + '</div>'; return r; }), { minWidth: '0', emptyTitle: 'Nothing to look at', emptyText: 'No page has low helpfulness or a recent negative comment.' })
        + '<div class="eyebrow">Every page with answers</div>' + UI.table(['Page', { label: 'Helpful', right: true }, { label: 'Not helpful', right: true }, 'Share helpful', 'Comments', 'Last answer'], s.items.map(row), { minWidth: '0', emptyTitle: 'No feedback yet', emptyText: 'Readers answer "Was this helpful?" on documents, references and the sources of chat answers.' });
    }

    async function comments(key) {
      const g = ((data && data.stats && data.stats.items) || []).find((x) => x.key === key); if (!g) return;
      let list = [];
      try { list = (await App.get(base + '/feedback/comments?' + (g.referenceId ? 'reference=' + enc(g.referenceId) : 'document=' + enc(g.documentId)))).comments; } catch (err) { App.fail(err); return; }
      ctx.drawer({ title: esc(g.title), body: style + UI.kv([['Helpful', String(g.up)], ['Not helpful', String(g.down)], ['Label', UI.label(g.label, { sm: true })]], 3)
        + '<div class="eyebrow">Answers</div>' + (list.length ? UI.timeline(list.map((c) => ({ title: (c.helpful ? 'Helpful' : 'Not helpful') + ', ' + esc(c.by), text: c.comment ? esc(c.comment) : '<span class="muted">No comment</span>', meta: esc(when(c.updatedAt)) + (c.origin === 'citation' ? ', on a chat source' + (c.question ? ', question shared' : '') : ''), tone: c.helpful ? 'ok' : 'warn' }))) : '<div class="muted">No answers.</div>'),
        actions: UI.btn('Close', { attrs: 'data-close' }) });
    }

    async function seed() {
      let r;
      try { r = await App.get(base + '/feedback/eval-seed'); } catch (err) { App.fail(err, 'Not exported'); return; }
      const text = JSON.stringify(r.seed, null, 2);
      ctx.modal({ title: 'Eval seed from negative feedback', cls: 'wide',
        body: '<p class="fg2" style="margin:0">' + r.cases + ' case' + (r.cases === 1 ? '' : 's') + ', one per negative answer with a comment or a shared question, in the shape of an evaluation set. ' + esc(r.use) + ' Audited as knowledge.feedback.exported.</p>' + UI.code(text.length > 4000 ? text.slice(0, 4000) + '\n…' : text, 'json'),
        actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Download JSON', { kind: 'primary', icon: 'download', attrs: 'data-fbdl', disabled: !r.cases }),
        onMount(m) {
          const b = m.querySelector('[data-fbdl]');
          if (b) b.addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'application/json' })); a.download = 'eval-seed-' + kb.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); ctx.toast('Eval seed downloaded.', 'ok'); });
        } });
    }

    return {
      html: html,
      bind() {
        ctx.on('click', '[data-fbitem]', (e, t) => comments(t.dataset.fbitem));
        ctx.on('click', '[data-fbseed]', () => seed());
      }
    };
  };

  // ---------- the reference tree ----------

  /** The tree's markup: nested lists in order; editors get Move up, Move down and Move to. */
  function treeHtml(tree, edit) {
    const kids = {};
    tree.nodes.forEach((n) => { const k = n.parentId || ''; (kids[k] = kids[k] || []).push(n); });
    const level = (pid) => {
      const list = kids[pid] || [];
      if (!list.length) return '';
      return '<ul class="kbtree"' + (pid ? '' : ' aria-label="References"') + '>' + list.map((n, i) => '<li><div class="kbtree-row"><button type="button" class="t" data-ref="' + esc(n.id) + '">' + esc(n.title) + '</button><span class="kbtree-sub mono">' + esc(n.slug) + '</span>' + UI.pill(n.version || n.state, n.state === 'published' ? 'ok' : 'neutral')
        + (edit ? '<span class="right hstack gap6">' + UI.btn('Move up', { size: 'xs', kind: 'ghost', attrs: 'data-treeup="' + esc(n.id) + '" aria-label="Move ' + esc(n.title) + ' up"', disabled: i === 0 }) + UI.btn('Move down', { size: 'xs', kind: 'ghost', attrs: 'data-treedown="' + esc(n.id) + '" aria-label="Move ' + esc(n.title) + ' down"', disabled: i === list.length - 1 }) + UI.btn('Move to…', { size: 'xs', kind: 'ghost', attrs: 'data-treemove="' + esc(n.id) + '" aria-label="Move ' + esc(n.title) + ' under another page"' }) + '</span>' : '') + '</div>'
        + level(n.id) + '</li>').join('') + '</ul>';
    };
    return tree.nodes.length ? level('') : '';
  }

  /** Puts a reference under a parent at a place; the server refuses cycles. */
  async function moveTo(id, parentId, position) {
    return App.put('/api/knowledge/references/' + enc(id) + '/tree', Object.assign({ parentId: parentId }, position != null ? { position: position } : {}));
  }

  function bindTree(ctx, tree, done) {
    const byId = {}; tree.nodes.forEach((n) => { byId[n.id] = n; });
    const siblings = (n) => tree.nodes.filter((x) => (x.parentId || null) === (n.parentId || null));
    const shift = async (id, d) => {
      const n = byId[id]; if (!n) return;
      const sib = siblings(n); const i = sib.indexOf(n); const j = i + d; if (j < 0 || j >= sib.length) return;
      try { await moveTo(id, n.parentId || null, j); done('Moved. Audited knowledge.reference.moved.', '[data-tree' + (d < 0 ? 'up' : 'down') + '="' + id + '"]'); } catch (err) { App.fail(err, 'Not moved'); }
    };
    ctx.on('click', '[data-treeup]', (e, t) => shift(t.dataset.treeup, -1));
    ctx.on('click', '[data-treedown]', (e, t) => shift(t.dataset.treedown, 1));
    ctx.on('click', '[data-treemove]', (e, t) => {
      const n = byId[t.dataset.treemove]; if (!n) return;
      // Its own descendants are left out: the server refuses them too.
      const below = {}; const mark = (pid) => tree.nodes.forEach((x) => { if (x.parentId === pid && !below[x.id]) { below[x.id] = true; mark(x.id); } }); mark(n.id);
      const options = [{ value: '', label: 'The top level' }].concat(tree.nodes.filter((x) => x.id !== n.id && !below[x.id]).map((x) => ({ value: x.id, label: x.title + ' (' + x.slug + ')' })));
      ctx.modal({ title: 'Move ' + esc(n.title), body: UI.field('Under', UI.select(options, n.parentId || '', 'data-mvparent')) + UI.field('Place', UI.select([{ value: 'end', label: 'Last' }, { value: '0', label: 'First' }], 'end', 'data-mvpos')) + '<div data-err role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Move', { kind: 'primary', attrs: 'data-go' }),
        onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            const parent = m.querySelector('[data-mvparent]').value || null; const pos = m.querySelector('[data-mvpos]').value;
            try { await moveTo(n.id, parent, pos === 'end' ? null : Number(pos)); App.closeOverlay(); done('Moved under ' + esc(parent ? byId[parent].title : 'the top level') + '. Audited knowledge.reference.moved.'); } catch (err) { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Not moved') + '.</b> ' + esc(err.message), 'danger'); }
          });
        } });
    });
  }

  /** The drawer's breadcrumbs (from the top down to the page's parent), all readable. */
  function crumbs(place, title) {
    if (!place || !place.breadcrumbs.length) return '';
    return style + '<nav aria-label="Breadcrumbs"><ol class="kbcrumbs">' + place.breadcrumbs.map((b) => '<li><a href="#" data-kbgo="' + esc(b.id) + '">' + esc(b.title) + '</a></li>').join('') + '<li aria-current="page">' + esc(title || place.slug) + '</li></ol></nav>';
  }

  /** The drawer's children, links and backlinks. */
  function places(place) {
    if (!place) return '';
    const list = (title, xs, empty) => '<div class="eyebrow">' + title + '</div>' + (xs.length ? '<ul class="kbtree">' + xs.map((x) => '<li><div class="kbtree-row"><a href="#" data-kbgo="' + esc(x.id) + '">' + esc(x.title) + '</a><span class="kbtree-sub mono">' + esc(x.slug) + '</span></div></li>').join('') + '</ul>' : '<div class="kbtree-sub">' + empty + '</div>');
    return list('Pages under it', place.children, 'None.') + list('Links to', place.links, 'It links to no other reference.') + list('Linked from', place.backlinks, 'No published reference links here.');
  }

  App.kbTree = { html: treeHtml, bind: bindTree, crumbs, places, CSS: CSS };
})();
