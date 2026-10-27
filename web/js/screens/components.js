(function () {
  const { UI, esc } = App;

  const TABS = ['Overview', 'Versions', 'Evals', 'Placement'];
  const TAB_TEXT = {
    Overview: 'qwen2.5:32b-q4_K_M, 32B parameters, 4-bit K-quant, 32k context. Default for the analyst profile.',
    Versions: 'v4 in review, v3 published, v2 deprecated, v1 retired. Second approver required for baseline changes.',
    Evals: 'finance-qa 0.81, tool-use 0.88, safety 0.97. Last run 18 Sep on gpu-large-2.',
    Placement: 'Pinned on gpu-large-1 and gpu-large-2. Blue/green swap scheduled for Sat 02:00.'
  };
  const VERSIONS = ['v4, in review', 'v3, published', 'v2, deprecated', 'v1, retired'];
  const ROWS = [
    { name: 'Finance KB', status: 'published', label: 'confidential', updated: '2 h' },
    { name: 'Travel policy', status: 'published', label: 'internal', updated: '3 d' },
    { name: 'HR handbook', status: 'draft', label: 'internal', updated: '9 d' }
  ];

  App.register({
    id: 'components', title: 'Shared components', summary: 'Design system sheet: badges, pills, buttons, meters, sheets, tables', crumb: ['Design system', 'Shared components'],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'Versions'; st.version = st.version || VERSIONS[0]; st.row = st.row == null ? 0 : st.row;
      st.review = st.review || 'in review'; st.job = st.job || { pct: 64, state: 'running' }; st.deleted = st.deleted || false;
      st.toggles = st.toggles || { think: true, hide: false };

      const card = (title, body, opts) => UI.panel(title, body, opts);
      const hs = (h) => '<div class="hstack wrap" style="row-gap:8px">' + h + '</div>';

      const cards = [
        card('Label badge', hs(['public', 'internal', 'confidential', 'restricted'].map((l) => UI.label(l)).join('')) + '<span class="muted" style="font-size:12px">Bars carry the level. Colour only on restricted.</span>'),
        card('Object status', hs(UI.pill('draft') + UI.pill('in review', 'info') + UI.pill('published', 'ok') + UI.pill('deprecated', 'warn') + UI.pill('retired')) + '<span class="muted" style="font-size:12px">Registry objects: models, tools, agents, workflows, rules. Kind is inferred from the word.</span>'),
        card('Job state', hs(UI.pill('queued') + UI.pill('running', 'info') + UI.pill('succeeded', 'ok') + UI.pill('failed', 'danger') + UI.pill('cancelled') + UI.pill('preempted', 'warn')) + '<span class="muted" style="font-size:12px">Every asynchronous job: media, image, index, training, workflow steps.</span>'),
        card('Worker class', hs(UI.pill('Thinking', 'outline') + UI.pill('Doing', 'outline') + UI.pill('Calculating', 'outline')) + '<span class="muted" style="font-size:12px">Which worker produced a turn. Calculating means an exact result, never a model estimate.</span>'),
        card('Buttons', hs(UI.btn('Publish', { kind: 'primary', attrs: 'data-say="Published. Version 4 is live for the analyst profile."' }) + UI.btn('Save draft', { attrs: 'data-say="Draft saved. Nothing changes until it goes through review."' }) + UI.btn('Discard', { kind: 'ghost', attrs: 'data-say="Draft discarded."' }) + UI.btn('Retire', { kind: 'danger', attrs: 'data-retire' }) + UI.btn('Add', { size: 'sm', icon: 'plus', attrs: 'data-say="Added."' })) + '<span class="muted" style="font-size:12px">Primary, default, ghost, danger, small. One primary per view.</span>'),
        card('Quota meter', UI.meter('Tokens today', '310k of 500k, resets 00:00', 62) + UI.meter('GPU-seconds this month', '16,380 of 18,000', 91, 'warn') + '<span class="muted" style="font-size:12px">Warn tone from 85 percent. Danger at 100, with the reset time and who can raise the limit.</span>'),
        card('Review bar', st.review === 'in review'
          ? UI.reviewbar('Version 4 is in review. Second approver required for baseline changes.', UI.btn('Reject', { size: 'sm', attrs: 'data-review="rejected"' }) + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-review="approved"' }))
          : st.review === 'approved' ? UI.notice('Version 4 approved by you. Waiting for a second approver before it goes live.', 'ok', UI.btn('Undo', { size: 'sm', attrs: 'data-review="in review"' })) : UI.notice('Version 4 rejected. The author sees your note and can resubmit.', 'warn', UI.btn('Undo', { size: 'sm', attrs: 'data-review="in review"' }))),
        card('Confirmation sheet', '<div style="font-size:14px;font-weight:600" class="hstack">' + (st.deleted ? 'Deleted 3 documents from Finance KB' : 'Delete 3 documents from Finance KB?') + ' ' + UI.pill('destructive', 'danger') + '</div>'
          + UI.kv([['Tool', '<span class="mono">kb.delete_documents</span>'], ['Acting as', 'Mara Okafor'], ['Target', 'Finance KB'], ['Label', UI.label('confidential', { sm: true })]], 2)
          + '<div class="hstack">' + UI.btn('Cancel', { attrs: 'data-say="Cancelled. Nothing was deleted."' }) + UI.btn(st.deleted ? 'Restore documents' : 'Delete documents', { kind: 'danger', attrs: st.deleted ? 'data-restore' : 'data-delete' }) + '</div>'
          + '<span class="muted" style="font-size:12px">Opens as a modal from tools with write or destructive effects. Click Delete documents to see it.</span>'),
        card('Problem detail', UI.problem('Model endpoint refused the request', 'The zone ceiling for gpu-small is internal and this conversation is confidential.') + '<span class="muted" style="font-size:12px">RFC 9457 problem detail with the trace ID. The copy action puts the trace on the clipboard for a ticket.</span>'),
        card('Job progress', '<div class="hstack"><span style="font-weight:600;width:150px;flex-shrink:0" class="mono">index.document</span><div class="grow">' + (st.job.state === 'cancelled' ? UI.meter('Cancelled at ' + st.job.pct + '%', '', st.job.pct) : UI.meter('Embedding chunks', st.job.pct + '%', st.job.pct, 'accent')) + '</div>' + (st.job.state === 'cancelled' ? UI.btn('Retry', { kind: 'ghost', size: 'sm', attrs: 'data-jobretry' }) : UI.btn('Cancel', { kind: 'ghost', size: 'sm', attrs: 'data-jobcancel' })) + '</div>' + '<span class="muted" style="font-size:12px">Stage names come from the worker. No indeterminate spinner and no invented percentage.</span>'),
        card('Context block', UI.ctx('Finance KB, Q3 cost centre review.pdf, page 4', 'Field Sales exceeded its travel allocation in each month of the quarter.', 'confidential') + '<span class="muted" style="font-size:12px">Retrieved passages and tool results, always with their own label. Raises the conversation label when higher.</span>'),
        card('Empty state', UI.empty('No knowledge bases yet', 'A knowledge base holds labelled documents that chat can cite. Nothing has been added to this workspace.', UI.btn('Add a source', { attrs: 'data-gokb' }))),
        card('Version switcher and tabs', UI.tabs(TABS, st.tab, 'data-tabs') + '<div class="fg2" style="font-size:12px;min-height:34px">' + esc(TAB_TEXT[st.tab]) + '</div>' + '<div class="hstack" style="align-items:flex-end">' + UI.field('Version', UI.select(VERSIONS, st.version, 'data-version')) + UI.btn('Diff against v3', { size: 'sm', attrs: 'data-diff' }) + '</div>'),
        card('Data table', UI.table(['Name', 'Status', 'Label', 'Updated'], ROWS.map((r) => [esc(r.name), UI.pill(r.status), UI.label(r.label, { sm: true }), esc(r.updated)]), { selected: st.row, minWidth: '0', cls: 'bare' }) + '<span class="muted" style="font-size:12px">Row click selects and fills the inspector. Selected: <b>' + esc(ROWS[st.row].name) + '</b>.</span>'),
        card('Form controls', '<div class="formgrid">' + UI.field('Profile', UI.select(['analyst', 'chat-default', 'fast', 'coder'], 'analyst')) + UI.field('Thinking ceiling', UI.select(['off', 'low', 'medium', 'high'], 'high')) + '</div>' + UI.field('Alias', UI.input('finance-analyst', { attrs: 'class="input mono"' }).replace('class="input" ', ''), 'Lower case, digits and hyphens.') + '<div class="vstack gap6">' + UI.toggle('Allow thinking', st.toggles.think, 'data-tg="think"') + UI.toggle('Hide thinking trace from members', st.toggles.hide, 'data-tg="hide"') + UI.check('Require second approver', true) + '</div>' + '<span class="muted" style="font-size:12px">Toggles act at once. Checks and selects save with the form.</span>'),
        card('Notices and toasts', UI.notice('Information: models on this pool are pinned to Ollama 0.32.5.', 'info') + UI.notice('Warning: 2 of 48 frames withheld by the image-safety classifier.', 'warn', '<a href="#" data-say="Opened the flag.">Flag</a>') + UI.notice('Stopped by guardrail Finance baseline v12.', 'danger') + UI.notice('Import bundle 2026-38 verified.', 'ok') + hs(UI.btn('Toast', { size: 'sm', attrs: 'data-say="Saved."' }) + UI.btn('Toast ok', { size: 'sm', attrs: 'data-say="Published." data-kind="ok"' }) + UI.btn('Toast warn', { size: 'sm', attrs: 'data-say="Quota at 91 percent." data-kind="warn"' }) + UI.btn('Toast danger', { size: 'sm', attrs: 'data-say="Import refused: unsigned bundle." data-kind="danger"' }))),
        card('Timeline and stats', '<div class="stats">' + UI.stat('1,204', 'Runs today', '+8% on last week') + UI.stat('0.81', 'Eval score', 'finance-lora-v3') + '</div>' + UI.timeline([{ title: 'Extract frames', text: 'media worker, 48 frames', tone: 'ok' }, { title: 'Transcribe audio', text: 'whisper, 12 min of audio', tone: 'ok' }, { title: 'Summarise', text: 'analyst, thinking medium', tone: 'accent' }, { title: 'Guardrail check', text: 'waiting', tone: '' }]))
      ];

      root.innerHTML = '<div class="page">' + UI.pagehead('Shared components', 'Every screen is built from these. Reached from the command palette, not the sidebar.', UI.btn('Prototype map', { kind: 'ghost', size: 'sm', attrs: 'data-map' }))
        + '<div class="grid3">' + cards.join('') + '</div></div>';

      // ---- events ----
      ctx.on('click', '[data-say]', (e, t) => { e.preventDefault(); ctx.toast(esc(t.dataset.say), t.dataset.kind || ''); });
      ctx.on('click', '[data-map]', () => ctx.app.map());
      ctx.on('click', '[data-retire]', async () => { const ok = await ctx.confirm({ title: 'Retire qwen2.5:32b-q4_K_M v2?', tag: 'destructive', tone: 'danger', body: '<div class="fg2">Profiles still pointing at v2 fall through their fallback chain. Two profiles are affected.</div>', kv: [['Profiles', 'analyst, coder'], ['Acting as', 'Mara Okafor']], ok: 'Retire' }); if (ok) ctx.toast('v2 retired. analyst and coder now resolve to v3.', 'ok'); });
      ctx.on('click', '[data-review]', (e, t) => { st.review = t.dataset.review; ctx.rerender(); if (t.dataset.review !== 'in review') ctx.toast('Version 4 ' + t.dataset.review + '. Audit entry written.', t.dataset.review === 'approved' ? 'ok' : 'warn'); });
      ctx.on('click', '[data-delete]', async () => { const ok = await ctx.confirm({ title: 'Delete 3 documents from Finance KB?', tag: 'destructive', tone: 'danger', body: '<div class="fg2">The documents leave the index at once. Their chunks stop being cited on the next turn. This cannot be undone from chat.</div>', kv: [['Tool', '<span class="mono">kb.delete_documents</span>'], ['Acting as', 'Mara Okafor'], ['Target', 'Finance KB'], ['Label', UI.label('confidential', { sm: true })]], ok: 'Delete documents' }); if (ok) { st.deleted = true; ctx.rerender(); ctx.toast('3 documents deleted from Finance KB. Audit entry written.', 'ok'); } });
      ctx.on('click', '[data-restore]', () => { st.deleted = false; ctx.rerender(); ctx.toast('Sheet reset.'); });
      ctx.on('click', '[data-jobcancel]', () => { st.job = { pct: st.job.pct, state: 'cancelled' }; ctx.rerender(); ctx.toast('index.document cancelled. Chunks already embedded are kept.'); });
      ctx.on('click', '[data-jobretry]', () => { st.job = { pct: 64, state: 'running' }; ctx.rerender(); });
      ctx.on('click', '[data-gokb]', () => ctx.navigate('knowledge'));
      ctx.on('click', '[data-tabs] [data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('change', '[data-version]', (e, t) => { st.version = t.value; ctx.toast('Showing ' + esc(t.value) + '.'); });
      ctx.on('click', '[data-diff]', () => { ctx.modal({ cls: 'wide', title: 'Diff ' + esc(st.version.split(',')[0]) + ' against v3', body: UI.code('  name: analyst\n  model: qwen2.5:32b-q4_K_M\n- think: medium\n+ think: high\n- guardrails: finance-baseline-v11\n+ guardrails: finance-baseline-v12\n  fallback: [chat-default, fast]', 'diff') + '<div class="fg2" style="font-size:12px">Two fields changed. The guardrail bump is a baseline change and needs a second approver.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) }); });
      ctx.on('click', 'tr.row', (e, t) => { st.row = +t.dataset.row; ctx.rerender(); });
      ctx.on('click', '[data-tg]', (e, t) => { st.toggles[t.dataset.tg] = !t.classList.contains('on'); });
    }
  });
})();
