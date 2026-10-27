// Knowledge, the References tab (migration 045): the documents of a base kept under version control, their revisions,
// the review, and who edits and approves. `knowledge.js` calls App.kbReferences(ctx, kb, deps) for the tab's markup
// and its handlers; the state lives in ctx.state.refs[kb.id].
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const TONE = { draft: 'neutral', 'in-review': 'warn', approved: 'info', published: 'ok', superseded: 'neutral', rejected: 'danger', withdrawn: 'neutral', failed: 'danger' };
  const NAME = { draft: 'Draft', 'in-review': 'In review', approved: 'Publishing', published: 'Published', superseded: 'Superseded', rejected: 'Rejected', withdrawn: 'Withdrawn', failed: 'Failed' };
  const pill = (state) => UI.pill(NAME[state] || state, TONE[state] || 'neutral');
  const BUMPS = [{ value: 'patch', label: 'Patch: corrections' }, { value: 'minor', label: 'Minor: added or changed material' }, { value: 'major', label: 'Major: rewrite or breaking change' }];
  const CSS = '.kbref-diff{font-family:var(--mono);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--line);border-radius:6px;padding:8px;max-height:340px;overflow:auto;background:var(--panel)}.kbref-diff .a{background:var(--ok-bg)}.kbref-diff .r{background:var(--danger-bg)}.kbref-diff .h{color:var(--muted)}.kbref-text{font-family:var(--mono);font-size:12px;min-height:260px}.kbref-sub{font-size:12px;color:var(--muted)}';
  const diffHtml = (text) => text.split('\n').map((l) => '<div class="' + (l[0] === '+' ? 'a' : l[0] === '-' ? 'r' : l[0] === '@' ? 'h' : '') + '">' + (esc(l) || '&nbsp;') + '</div>').join('');
  const problem = (m, err) => { const p = err.problem || {}; m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(err.message), 'danger'); };

  App.kbReferences = function (ctx, kb, deps) {
    const st = ctx.state;
    st.refs = st.refs || {};
    const base = '/api/knowledge/bases/' + enc(kb.id);
    const load = () => {
      // 1.8.0 (B-149): the page tree too (knowledge-feedback.js draws it); a server without it shows the list only.
      Promise.all([App.get(base + '/review'), App.get(base + '/references'), App.get(base + '/tree').catch(() => null)])
        .then((r) => { st.refs[kb.id] = { settings: r[0], list: r[1], tree: r[2], at: Date.now() }; deps.later(); })
        .catch((err) => { st.refs[kb.id] = { error: err }; deps.later(); });
    };
    const data = st.refs[kb.id];
    if (!data) { st.refs[kb.id] = { loading: true }; load(); }
    const done = (msg) => { App.closeOverlay(); if (msg) App.toast(msg, 'ok', 5000); load(); deps.refresh(); };

    let html = '<style>' + CSS + '</style>';
    if (!data || data.loading) html += UI.notice('Loading…', 'info');
    else if (data.error) html += UI.problem('The references could not be loaded', data.error.message, data.error.problem && data.error.problem.trace_id);
    else {
      const s = data.settings, d = s.duties, list = data.list;
      const waiting = list.filter((r) => r.open && r.open.state === 'in-review');
      // A revision that is being published settles within seconds: look again while one is.
      if (list.some((r) => r.open && r.open.state === 'approved') && !st.refPoll) st.refPoll = setTimeout(() => { st.refPoll = null; if (App.state.route === 'knowledge' && st.tab === 'references') load(); }, 3000);
      const who = (xs) => (xs.length ? xs.map((x) => esc(x.name) + (x.kind === 'role' ? ' (role)' : '')).join(', ') : '');
      html += UI.notice((s.review === 'required' ? 'This knowledge base takes changes through review only: uploads are refused. ' : 'References are kept under version control; other documents of this base are added as before. ')
        + 'Editors: ' + (who(s.editors) || 'whoever may manage the base') + '. Approvers: ' + (who(s.approvers) || 'whoever may manage the base') + '. '
        + (s.workflow ? 'A submitted revision is decided in a run of the workflow ' + esc(s.workflow.name || s.workflow.id) + '. ' : 'A submitted revision is decided here by an approver. ')
        + (s.fourEyes ? 'An author does not approve their own revision.' : 'An author may approve their own revision.'), 'info', d.manage ? '<a href="#" data-refsettings>Review settings</a>' : '');
      html += '<div class="toolbar"><span class="muted" style="font-size:12px">' + list.length + ' reference' + (list.length === 1 ? '' : 's') + (waiting.length ? ', ' + waiting.length + ' waiting for review' : '') + '</span>' + (d.edit ? '<span class="right">' + UI.btn('New reference', { size: 'sm', kind: 'primary', attrs: 'data-refnew' }) + '</span>' : '') + '</div>';
      if (waiting.length) html += '<div class="eyebrow">Waiting for review</div>' + UI.table(['Reference', 'Version', 'By', 'What changes', 'Submitted'], waiting.map((r) => ({ cells: ['<b>' + esc(r.title) + '</b><div class="kbref-sub mono">' + esc(r.slug) + '</div>', esc((r.version || 'new') + ' to ' + r.open.version), esc(r.open.author), esc(r.open.summary), esc(when(r.open.submittedAt))], attrs: 'data-rev="' + esc(r.open.id) + '"' })), { minWidth: '0' });
      const asTree = data.tree && App.kbTree && st.refView !== 'list';
      html += '<div class="hstack wrap"><div class="eyebrow grow">References</div>' + (data.tree && App.kbTree ? UI.seg([{ id: 'tree', label: 'Page tree' }, { id: 'list', label: 'List' }], asTree ? 'tree' : 'list', 'data-refview aria-label="Show references as"') : '') + '</div>';
      if (asTree) html += '<style>' + App.kbTree.CSS + '</style>' + (App.kbTree.html(data.tree, !!(data.tree.duties && data.tree.duties.edit)) || UI.empty('No references yet', d.edit ? 'A reference is a document with versions: propose its first revision, and it is published once an approver accepts it.' : 'Nothing is published under version control in this knowledge base yet.'));
      else html += UI.table(['Reference', 'Version', 'State', 'Open revision', 'Updated'], list.map((r) => ({ cells: ['<b>' + esc(r.title) + '</b><div class="kbref-sub mono">' + esc(r.slug) + '</div>', esc(r.version || 'none yet'), pill(r.state), r.open ? pill(r.open.state) + ' ' + esc(r.open.version) + ' by ' + esc(r.open.author) : 'none', esc(when(r.updatedAt))], attrs: 'data-ref="' + esc(r.id) + '"' })), { minWidth: '0', emptyTitle: 'No references yet', emptyText: d.edit ? 'A reference is a document with versions: propose its first revision, and it is published once an approver accepts it.' : 'Nothing is published under version control in this knowledge base yet.' });
    }

    function propose(ref, text) {
      ctx.modal({
        title: ref ? 'Propose a revision of ' + esc(ref.title) : 'New reference',
        body: (ref ? '' : UI.field('Reference', UI.input('', { placeholder: 'exprsn-ai/overview', attrs: 'data-slug' }), 'A short path that names the document for good. Letters, digits, ".", "_" and "-"; levels separated by "/".'))
          + UI.field('Title', UI.input(ref ? ref.title : '', { attrs: 'data-title' }))
          + (ref && ref.version ? UI.field('Version', UI.select(BUMPS, 'minor', 'data-bump'), 'Published now: ' + esc(ref.version) + '.') : '')
          + UI.field('What changes', UI.textarea('', { rows: 2, attrs: 'data-summary', placeholder: 'For the approver and the history' }))
          + UI.field('Feature', UI.input('', { attrs: 'data-feature', placeholder: 'Optional: the feature or change this documents' }))
          + UI.field('Document', UI.textarea(text || '', { rows: 12, attrs: 'data-content class="textarea kbref-text"' }), 'The whole document, as Markdown.')
          + '<div data-err></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save as draft', { attrs: 'data-go="draft"' }) + UI.btn('Submit for review', { kind: 'primary', attrs: 'data-go="submit"' }),
        onMount(m) {
          m.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', async () => {
            const v = (q) => { const el = m.querySelector(q); return el ? el.value.trim() : ''; };
            const body = { title: v('[data-title]'), content: m.querySelector('[data-content]').value, summary: v('[data-summary]'), submit: b.dataset.go === 'submit' };
            if (ref) body.reference = ref.id; else if (v('[data-slug]')) body.reference = v('[data-slug]');
            if (v('[data-bump]')) body.bump = v('[data-bump]');
            if (v('[data-feature]')) body.feature = v('[data-feature]');
            if (!body.title || !body.summary || !body.content.trim()) { m.querySelector('[data-err]').innerHTML = UI.notice('Give a title, what changes and the document.', 'danger'); return; }
            try { const r = await App.post(base + '/revisions', body); done('Revision ' + esc(r.version) + (r.state === 'in-review' ? ' submitted for review.' : ' saved as a draft.')); } catch (err) { problem(m, err); }
          }));
        }
      });
    }

    async function proposeFor(ref) {
      let text = '';
      try { if (ref.revisionId) text = (await App.get('/api/knowledge/revisions/' + enc(ref.revisionId))).content || ''; } catch (err) { App.fail(err); return; }
      propose(ref, text);
    }

    function decide(rev, decision) {
      ctx.modal({
        title: (decision === 'approve' ? 'Approve ' : 'Reject ') + esc(rev.reference.title) + ' ' + esc(rev.version),
        body: UI.field(decision === 'approve' ? 'Note' : 'Reason', UI.textarea('', { rows: 3, attrs: 'data-reason', placeholder: decision === 'approve' ? 'Optional; kept in the history' : 'What the author should change' }))
          + UI.notice(decision === 'approve' ? 'The revision is scanned, classified and indexed, then replaces version ' + esc(rev.reference.version || 'none') + '. The earlier version stays in the history.' : 'The author is told. What is published stays as it is.', 'info') + '<div data-err></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(decision === 'approve' ? 'Approve' : 'Reject', { kind: decision === 'approve' ? 'primary' : 'danger', attrs: 'data-go' }),
        onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            const reason = m.querySelector('[data-reason]').value.trim();
            if (decision === 'reject' && !reason) { m.querySelector('[data-err]').innerHTML = UI.notice('Say why, so the author can change it.', 'danger'); return; }
            try { await App.post('/api/knowledge/revisions/' + enc(rev.id) + '/decision', { decision: decision, reason: reason || null }); done(decision === 'approve' ? 'Approved. Version ' + esc(rev.version) + ' is published once it is indexed.' : 'Rejected. The author was told.'); } catch (err) { problem(m, err); }
          });
        }
      });
    }

    async function openRevision(id) {
      let rev;
      try { rev = await App.get('/api/knowledge/revisions/' + enc(id)); } catch (err) { App.fail(err); return; }
      const duties = (st.refs[kb.id].settings || {}).duties || {};
      const mine = rev.author.id && App.me && App.me.user && rev.author.id === App.me.user.id;
      const acts = [];
      if (rev.state === 'in-review' && rev.mayDecide) { acts.push(UI.btn('Reject', { attrs: 'data-act="reject"' })); acts.push(UI.btn('Approve', { kind: 'primary', attrs: 'data-act="approve"' })); }
      if (rev.state === 'draft' && duties.edit) acts.push(UI.btn('Submit for review', { kind: 'primary', attrs: 'data-act="submit"' }));
      if ((rev.state === 'draft' || rev.state === 'in-review') && (duties.manage || mine)) acts.push(UI.btn('Withdraw', { attrs: 'data-act="withdraw"' }));
      ctx.drawer({
        title: esc(rev.reference.title) + ' ' + esc(rev.version),
        body: '<style>' + CSS + '</style><div class="hstack">' + pill(rev.state) + UI.label(rev.reference.label) + '</div>'
          + UI.kv([['Reference', '<span class="mono">' + esc(rev.reference.slug) + '</span>'], ['Revision', String(rev.number)], ['Version', esc(rev.version)], ['Written by', esc(rev.author.name)], ['Submitted', esc(when(rev.submittedAt) || 'not yet')], ['Decided by', esc(rev.decidedBy ? rev.decidedBy.name : 'not yet')], ['Decided', esc(when(rev.decidedAt) || 'not yet')], ['Published', esc(when(rev.publishedAt) || 'not yet')], ['Feature', esc(rev.feature || 'none named')], ['Review run', rev.approvalRunId ? '<a href="#/workflows?run=' + esc(rev.approvalRunId) + '" class="mono">' + esc(rev.approvalRunId.slice(-6)) + '</a>' : 'none']], 2)
          + '<div class="eyebrow">What changes</div><div>' + esc(rev.summary) + '</div>'
          + (rev.reason ? '<div class="eyebrow">Decision note</div><div>' + esc(rev.reason) + '</div>' : '')
          + (rev.error ? UI.notice(esc(rev.error), 'danger') : '')
          + (rev.state === 'in-review' && rev.whyNot ? UI.notice(esc(rev.whyNot), 'info') : '')
          + (rev.diff ? '<div class="eyebrow">Changes against ' + esc(rev.diff.against ? 'version ' + rev.diff.against : 'nothing: the first version') + ' (' + rev.diff.added + ' added, ' + rev.diff.removed + ' removed)</div><div class="kbref-diff" tabindex="0" role="region" aria-label="Line changes">' + (rev.diff.text ? diffHtml(rev.diff.text) : 'No line changed.') + '</div>' + (rev.diff.truncated ? '<div class="kbref-sub">The diff is cut short; the document below is complete.</div>' : '') : '')
          + '<div class="eyebrow">Document</div><div class="kbref-diff" tabindex="0" role="region" aria-label="Document text">' + esc(rev.content || '') + '</div>',
        actions: UI.btn('Close', { attrs: 'data-close' }) + acts.join(''),
        onMount(m) {
          m.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
            const a = b.dataset.act;
            if (a === 'approve' || a === 'reject') { App.closeOverlay(); decide(rev, a); return; }
            try { await App.post('/api/knowledge/revisions/' + enc(rev.id) + '/' + a, {}); done(a === 'submit' ? 'Submitted for review.' : 'Withdrawn.'); } catch (err) { App.fail(err); }
          }));
        }
      });
    }

    async function openReference(id) {
      let ref, place = null;
      try { ref = await App.get('/api/knowledge/references/' + enc(id)); } catch (err) { App.fail(err); return; }
      // 1.8.0 (B-149): where it sits in the tree, what links to it, and "Was this helpful?" (knowledge-feedback.js).
      if (App.kbTree) place = await App.get('/api/knowledge/references/' + enc(id) + '/tree').catch(() => null);
      ctx.drawer({
        title: esc(ref.title),
        body: '<style>' + CSS + '</style>' + (App.kbTree ? App.kbTree.crumbs(place, ref.title) : '') + '<div class="hstack">' + pill(ref.state) + UI.label(ref.label) + '</div>'
          + UI.kv([['Reference', '<span class="mono">' + esc(ref.slug) + '</span>'], ['Version', esc(ref.version || 'none yet')], ['Knowledge base', esc(ref.kb)], ['Categories', esc((ref.categories || []).join(', ') || 'none')], ['Revisions', String(ref.revisions)], ['Updated', esc(when(ref.updatedAt))]], 2)
          + '<div class="eyebrow">History</div>'
          + UI.table(['Version', 'State', 'What changed', 'Written by', 'Approved by', 'When'], ref.history.map((v) => ({ cells: [esc(v.version) + '<div class="kbref-sub">revision ' + v.number + '</div>', pill(v.state), esc(v.summary) + (v.feature ? '<div class="kbref-sub">Feature: ' + esc(v.feature) + '</div>' : ''), esc(v.author.name), esc(v.decidedBy ? v.decidedBy.name : ''), esc(when(v.publishedAt || v.decidedAt || v.createdAt))], attrs: 'data-hrev="' + esc(v.id) + '"' })), { minWidth: '0' })
          + (App.kbTree ? App.kbTree.places(place) : '') + (App.kbFeedback && ref.state === 'published' ? App.kbFeedback.slot() : ''),
        actions: UI.btn('Close', { attrs: 'data-close' }) + (ref.duties.manage && !ref.open && ref.state !== 'retired' ? UI.btn('Retire', { attrs: 'data-retire' }) : '') + (ref.duties.edit && !ref.open ? UI.btn('Propose a revision', { kind: 'primary', attrs: 'data-propose' }) : ''),
        onMount(m) {
          m.querySelectorAll('[data-hrev]').forEach((row) => row.addEventListener('click', () => { App.closeOverlay(); openRevision(row.dataset.hrev); }));
          m.querySelectorAll('[data-kbgo]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); App.closeOverlay(); setTimeout(() => openReference(a.dataset.kbgo), 30); }));
          if (App.kbFeedback && ref.state === 'published') App.kbFeedback.attach(m.querySelector('[data-kbfb]'), { kind: 'reference', id: ref.id });
          const p = m.querySelector('[data-propose]');
          if (p) p.addEventListener('click', () => { App.closeOverlay(); proposeFor(ref); });
          const r = m.querySelector('[data-retire]');
          if (r) r.addEventListener('click', async () => {
            if (!(await ctx.confirm({ title: 'Retire ' + ref.title, tag: 'destructive', tone: 'danger', ok: 'Retire', body: '<div class="fg2">Its document leaves the index and search stops answering from it. Its revisions stay as its history.</div>' }))) return;
            try { await App.del('/api/knowledge/references/' + enc(ref.id)); done('Retired. Its history is kept.'); } catch (err) { App.fail(err); }
          });
        }
      });
    }

    async function settings() {
      const s = st.refs[kb.id].settings;
      let workflows = [], users = [];
      try { workflows = (await App.get('/api/workflows')).filter((w) => w.publishedVersion); } catch (err) { workflows = []; }
      try { users = (await App.get('/api/knowledge/principals')).users; } catch (err) { users = []; }
      const rows = (xs, duty) => (xs.length ? xs.map((x) => '<div class="hstack"><span class="grow">' + esc(x.name) + (x.kind === 'role' ? ' <span class="kbref-sub">role</span>' : '') + '</span>' + UI.btn('Remove', { size: 'sm', kind: 'ghost', attrs: 'data-rm="' + esc(x.id) + '" aria-label="Remove ' + esc(x.name) + ' as ' + duty + '"' }) + '</div>').join('') : '<div class="kbref-sub">None named: whoever may manage the base.</div>');
      ctx.modal({
        title: 'Review settings of ' + esc(kb.name),
        body: UI.field('Changes', UI.select([{ value: 'off', label: 'References are reviewed; other documents are added as before' }, { value: 'required', label: 'Everything goes through review: uploads are refused' }], s.review, 'data-review'))
          + UI.field('Decided by', UI.select([{ value: '', label: 'An approver, on the revision' }].concat(workflows.map((w) => ({ value: w.id, label: 'A run of the workflow ' + w.name }))).concat(s.workflow && !workflows.some((w) => w.id === s.workflow.id) ? [{ value: s.workflow.id, label: 'A run of the workflow ' + (s.workflow.name || s.workflow.id) }] : []), s.workflow ? s.workflow.id : '', 'data-workflow'), 'A review workflow has an approval step and ends with the tool knowledge_publish.')
          + UI.field('Four eyes', UI.select([{ value: 'on', label: 'An author does not approve their own revision' }, { value: 'off', label: 'An author may approve their own revision' }], s.fourEyes ? 'on' : 'off', 'data-four'))
          + '<div class="eyebrow">Editors</div>' + rows(s.editors, 'editor') + '<div class="eyebrow">Approvers</div>' + rows(s.approvers, 'approver')
          + '<div class="eyebrow">Name an editor or approver</div><div class="knowledge-two">' + UI.field('As', UI.select([{ value: 'editor', label: 'Editor' }, { value: 'approver', label: 'Approver' }], 'editor', 'data-duty'))
          + UI.field('Person', UI.select([{ value: '', label: users.length ? 'Choose a person' : 'People are listed for knowledge curators' }].concat(users.map((u) => ({ value: u.id, label: u.name || u.username }))), '', 'data-user')) + UI.field('Or role', UI.input('', { attrs: 'data-role', placeholder: 'knowledge-curator' })) + '</div>'
          + '<div>' + UI.btn('Add', { size: 'sm', attrs: 'data-add' }) + '</div><div data-err></div>',
        actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-go' }),
        onMount(m) {
          const again = async (fn) => { try { st.refs[kb.id].settings = await fn(); App.closeOverlay(); settings(); } catch (err) { problem(m, err); } };
          m.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => again(() => App.del(base + '/reviewers/' + enc(b.dataset.rm)))));
          m.querySelector('[data-add]').addEventListener('click', () => {
            const user = m.querySelector('[data-user]').value, role = m.querySelector('[data-role]').value.trim();
            if (!user && !role) { m.querySelector('[data-err]').innerHTML = UI.notice('Choose a person or name a role.', 'danger'); return; }
            again(() => App.post(base + '/reviewers', { duty: m.querySelector('[data-duty]').value, kind: user ? 'user' : 'role', id: user || role }));
          });
          m.querySelector('[data-go]').addEventListener('click', async () => {
            try { await App.patch(base + '/review', { review: m.querySelector('[data-review]').value, workflowId: m.querySelector('[data-workflow]').value || null, fourEyes: m.querySelector('[data-four]').value === 'on' }); done('Review settings saved. Audit entry written.'); } catch (err) { problem(m, err); }
          });
        }
      });
    }

    return {
      html: html,
      bind() {
        ctx.on('click', '[data-refnew]', () => propose(null, ''));
        ctx.on('click', '[data-refsettings]', (e) => { e.preventDefault(); settings(); });
        ctx.on('click', '[data-ref]', (e, t) => openReference(t.dataset.ref));
        ctx.on('click', '[data-refview] [data-seg]', (e, t) => { st.refView = t.dataset.seg; deps.later(); });
        const tree = st.refs[kb.id] && st.refs[kb.id].tree;
        if (tree && App.kbTree) App.kbTree.bind(ctx, tree, (msg, focusSel) => { App.toast(msg, 'ok', 4000); load(); if (focusSel) setTimeout(() => { const el = ctx.$(focusSel); if (el && !el.disabled) el.focus(); }, 400); });
        ctx.on('click', '[data-rev]', (e, t) => openRevision(t.dataset.rev));
      }
    };
  };
})();
