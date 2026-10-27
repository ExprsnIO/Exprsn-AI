// Groups, the Proposals tab and the governance settings (1.9.0, Sprint 53, B-174 to B-176): proposals, voting with
// receipts for secret ballots, results with the method's working, decisions carried out or waiting for an owner, and
// the group's budget. `groups.js` calls App.groupGovernance(ctx, g, deps) on the Proposals and Overview tabs for the
// markup and its handlers; the state lives in ctx.state.gov[g.id]. Receipts of secret ballots stay in this browser only
// (localStorage, when it is available) and are shown once, to copy.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const small = (t) => '<span class="muted" style="font-size:12px">' + t + '</span>';
  const KIND = { free: 'Free-form', setting: 'Change a setting', member: 'Add or remove a member', role: 'Give or take a role', rules: 'Change the rules', spend: 'Spend from the budget' };
  const METHOD = { majority: 'Simple majority', supermajority: 'Supermajority', approval: 'Approval voting', ranked: 'Ranked choice' };
  const STATE = { draft: ['draft', 'warn'], open: ['voting', 'info'], closed: ['closed', ''], carried_out: ['carried out', 'ok'], failed: ['failed', 'danger'] };
  const OUTCOME = { passed: ['passed', 'ok'], rejected: ['rejected', 'danger'], no_quorum: ['no quorum', 'warn'] };
  const statePill = (s) => UI.pill((STATE[s] || [s])[0], (STATE[s] || [])[1] || '');
  const outcomePill = (o) => (o ? UI.pill((OUTCOME[o] || [o])[0], (OUTCOME[o] || [])[1] || '') : '');
  const money = (minor, cur) => (cur ? (minor / 100).toLocaleString(undefined, { style: 'currency', currency: cur }) : String(minor));
  // The dialogs are drawn in #overlay, outside #main: their rules name it too.
  const CSS = '#main .gov-body,#overlay .gov-body{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}#main .gov-mono{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}'
    + '#main .gov-choices,#overlay .gov-choices{display:flex;flex-direction:column;gap:14px;margin:6px 0}#main .gov-rank{display:flex;gap:8px;align-items:center;flex-wrap:wrap}#main .gov-rank .select{width:auto;min-width:120px}';
  const receiptKey = (id) => 'exprsn.ballot.' + id;
  const loadReceipt = (id) => { try { const v = window.localStorage.getItem(receiptKey(id)); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  const saveReceipt = (r) => { try { window.localStorage.setItem(receiptKey(r.proposalId), JSON.stringify(r)); } catch (e) { /* not kept: it is shown to copy */ } };
  const choiceText = (c, options) => (Array.isArray(c) ? (c.length ? c.map((o, i) => { const opt = (options || []).find((x) => x.id === o); return (c.length > 1 ? (i + 1) + '. ' : '') + (opt ? opt.label : o); }).join(', ') : 'none') : c);
  const problemOf = (err) => { const p = err.problem || {}; return UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(err.message), 'danger'); };

  App.groupGovernance = function (ctx, g, deps) {
    const st = ctx.state;
    st.gov = st.gov || {};
    const base = '/api/groups/' + enc(g.id);
    const d = st.gov[g.id] || (st.gov[g.id] = {});
    const load = (quiet) => {
      if (d.loading) { d.again = true; return; }
      d.loading = true;
      // A link's proposal is taken once, whatever the answer (a failed load must not ask again on every render).
      const want = st.govWant; st.govWant = null;
      Promise.all([App.get(base + '/governance'), App.get(base + '/proposals').catch(() => null), App.get(base + '/budget').catch(() => null), App.get(base + '/roles').catch(() => null)])
        .then((r) => {
          d.view = r[0]; d.list = r[1] && r[1].proposals ? r[1].proposals : []; d.budget = r[2]; d.roles = r[3]; d.error = null; d.loaded = true;
          if (want) d.sel = want;
          if (d.sel && !d.list.some((x) => x.id === d.sel)) d.sel = null;
          if (!d.sel && d.list.length) d.sel = d.list[0].id;
          return d.sel ? App.get('/api/group-proposals/' + enc(d.sel)).then((x) => { d.detail = x; }).catch(() => { d.detail = null; }) : (d.detail = null);
        })
        .catch((err) => { if (!quiet) d.error = err; d.loaded = true; })
        .finally(() => { d.loading = false; d.at = Date.now(); if (d.again) { d.again = false; load(true); return; } deps.later(); });
    };
    // Loaded once, again when a link names a proposal, and again when the tab is drawn after 15 seconds (others vote).
    if (!d.loaded && !d.loading) load();
    else if (!d.loading && (st.govWant || Date.now() - (d.at || 0) > 15000)) load(true);
    const done = (msg) => { App.closeOverlay(); if (msg) App.toast(msg, 'ok', 5000); load(true); };
    const v = d.view;
    const where = deps.where;

    // ---------- the settings panel (Overview) ----------
    if (where === 'overview') {
      if (!v || !v.available || !v.canManage) return { html: '', bind() {} };
      const roleName = (id) => { const c = d.roles && d.roles.custom ? d.roles.custom.find((r) => r.id === id) : null; return c ? c.name : id; };
      const html = UI.panel('Governance', UI.kv([
        ['Who may propose', esc(v.propose === 'members' ? 'Members' : v.propose === 'owners' ? 'Owners only' : 'Holders of ' + roleName(v.proposeRole) + ' or more')],
        ['Default method', esc(METHOD[v.method] + (v.method === 'supermajority' ? ' (' + v.threshold.num + '/' + v.threshold.den + ')' : ''))],
        ['Quorum', esc(v.quorum.kind === 'none' ? 'None' : v.quorum.kind === 'share' ? v.quorum.value + '% of the electorate' : v.quorum.value + ' ballots')],
        ['Voting lasts', esc(v.minHours + ' to ' + v.maxHours + ' hours, ' + v.defaultHours + ' by default')],
        ['Ballots', esc(v.secret ? 'Secret by default' : 'Public by default')],
        ['Owners confirm', esc(v.confirmKinds.length ? v.confirmKinds.map((k) => KIND[k]).join(', ') : 'Nothing: passed decisions are carried out at once')]
      ], 3) + (v.rules ? UI.field('Rules', '<div class="gov-body">' + esc(v.rules) + '</div>') : small('The group has no written rules.')),
      { actions: deps.canWrite ? UI.btn('Edit governance', { size: 'sm', attrs: 'data-goveditsettings' }) : '' });
      return { html: '<style>' + CSS + '</style>' + html, bind() { ctx.on('click', '[data-goveditsettings]', () => settingsModal()); } };
    }

    // ---------- the Proposals tab ----------
    let html = '<style>' + CSS + '</style>';
    if (!d.loaded) html += UI.notice('Loading…', 'info');
    else if (d.error) html += UI.problem('Proposals could not be loaded', d.error.message, (d.error.problem && d.error.problem.trace_id) || false);
    else if (!v || !v.available) html += UI.notice('<b>Proposals are not available yet.</b> They need the database migrations 133_group_proposals and 134_group_votes, which an administrator applies.', 'info');
    else {
      const list = d.list || [];
      html += (v.rules ? UI.panel('Rules', '<div class="gov-body">' + esc(v.rules) + '</div>') : '')
        + UI.panel('Proposals', UI.table(['Proposal', 'Kind', 'State', 'Voting', { label: 'Turnout', right: true }, 'You'], list.map((x) => ({
          cells: ['<b>' + esc(x.title) + '</b>' + (x.secret ? ' ' + UI.pill('secret', 'outline') : ''), esc(KIND[x.kind] || x.kind), statePill(x.state) + ' ' + outcomePill(x.outcome) + (x.needsConfirmation ? ' ' + UI.pill('waits for an owner', 'warn') : ''),
            esc(x.state === 'open' ? 'until ' + when(x.closesAt) : x.closesAt ? 'closed ' + when(x.closesAt) : 'not opened'), '<span class="num">' + (x.state === 'draft' ? '' : x.turnout + ' of ' + x.electorate) + '</span>',
            x.mine.voted ? UI.pill('voted', 'ok') : x.state === 'open' && x.mine.eligible ? UI.pill('to vote', 'info') : ''],
          attrs: 'data-gproposal="' + esc(x.id) + '" tabindex="0" aria-label="Open the proposal ' + esc(x.title) + '"', selected: x.id === d.sel
        })), { minWidth: '640px', emptyTitle: 'No proposals yet', emptyText: v.canPropose ? 'Propose something for the group to decide.' : 'Members the group\'s settings allow make proposals here.' }),
        { actions: v.canPropose && deps.canWrite ? UI.btn('New proposal', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-govnew' }) : '' })
        + (d.detail ? detailHtml(d.detail) : '')
        + budgetHtml();
    }

    function detailHtml(x) {
      const r = x.result;
      const opt = (id) => { const o = x.options.find((y) => y.id === id); return o ? o.label : id; };
      const label = (k) => (x.method === 'approval' || x.method === 'ranked' ? opt(k) : k);
      const act = x.action || {};
      const actionText = x.kind === 'setting' ? Object.keys(act.patch || {}).map((k) => k + ': ' + JSON.stringify(act.patch[k])).join(', ')
        : x.kind === 'member' ? (act.op === 'add' ? 'Add ' : 'Remove ') + (act.userName || act.userId)
          : x.kind === 'role' ? 'Give ' + (act.userName || act.userId) + ' the role ' + (act.customRoleId ? (d.roles && d.roles.custom ? (d.roles.custom.find((c) => c.id === act.customRoleId) || {}).name : '') || 'a custom role' : act.role)
            : x.kind === 'rules' ? 'New rules: ' + (act.rules || '(none)')
              : x.kind === 'spend' ? 'Spend ' + money(act.amountMinor, d.budget && d.budget.currency) + (act.memo ? ' for ' + act.memo : '') : '';
      const rec = x.secret ? (st.govReceipt && st.govReceipt.proposalId === x.id ? st.govReceipt : loadReceipt(x.id)) : null;
      let vote = '';
      if (x.can.vote && deps.canWrite) {
        const opts = x.options;
        let form;
        if (x.method === 'majority' || x.method === 'supermajority') form = '<div class="gov-choices" role="radiogroup" aria-label="Your vote">' + ['yes', 'no', 'abstain'].map((c) => '<label class="check"><input type="radio" name="govyn" value="' + c + '" data-govyn' + ((x.mine.choice || (rec && rec.choice)) === c ? ' checked' : '') + '><span>' + esc(c[0].toUpperCase() + c.slice(1)) + '</span></label>').join('') + '</div>';
        else if (x.method === 'approval') form = '<div class="gov-choices" role="group" aria-label="Options you approve">' + opts.map((o) => UI.check(o.label, (x.mine.choice || (rec && rec.choice) || []).indexOf(o.id) >= 0, 'data-govapprove="' + esc(o.id) + '"')).join('') + '</div>';
        else form = '<div class="gov-choices">' + opts.map((o) => '<div class="gov-rank">' + UI.field(o.label, UI.select([{ value: '', label: 'Not ranked' }].concat(opts.map((_, i) => ({ value: String(i + 1), label: 'Choice ' + (i + 1) }))), (() => { const c = x.mine.choice || (rec && rec.choice) || []; const i = c.indexOf(o.id); return i >= 0 ? String(i + 1) : ''; })(), 'data-govrank="' + esc(o.id) + '"')) + '</div>').join('') + '</div>';
        vote = UI.panel(x.mine.voted ? 'Change your vote' : 'Your vote', form + '<div data-goverr></div><div class="hstack gap6">' + UI.btn(x.mine.voted ? 'Change vote' : 'Cast vote', { kind: 'primary', size: 'sm', attrs: 'data-govvote' })
          + small(x.secret ? (x.mine.voted ? (rec ? 'Your receipt in this browser lets you change it until close.' : 'A secret vote is changed with the receipt you were given; it is not in this browser.') : 'Secret ballot: the server records that you voted, not how. You get a receipt to check the count.') : 'Public ballot: members see who voted for what. You can change it until close.') + '</div>');
      }
      const tallyRows = r ? Object.keys(r.counts).map((k) => [esc(label(k)), '<span class="num">' + r.counts[k] + '</span>']) : [];
      const rounds = r && r.rounds && r.rounds.length ? UI.table(['Round', 'Counts', 'Exhausted', 'What happened'], r.rounds.map((rd) => [String(rd.round), esc(Object.keys(rd.counts).map((k) => opt(k) + ' ' + rd.counts[k]).join(', ')), '<span class="num">' + rd.exhausted + '</span>', esc(rd.note)]), { clickable: false, minWidth: '0', cls: 'gov-rounds' }) : '';
      const ballots = x.ballots ? UI.table(['Member', 'Vote'], x.ballots.map((b) => [esc(b.name || b.userId), esc(choiceText(b.choice, x.options))]), { clickable: false, minWidth: '0', emptyTitle: 'No votes yet', emptyText: 'Members who vote are listed here with their vote.' }) : '';
      const commitments = x.commitments ? UI.table(['Commitment', 'Choice'], x.commitments.map((c) => ['<span class="gov-mono">' + esc(c.commitment) + '</span>' + (rec && rec.commitment === c.commitment ? ' ' + UI.pill('yours', 'ok') : ''), esc(choiceText(c.choice, x.options))]), { clickable: false, minWidth: '0' }) : '';
      const receiptPanel = rec ? UI.panel('Your receipt', UI.kv([['Ballot', '<span class="gov-mono">' + esc(rec.ballotId) + '</span>'], ['Choice', esc(choiceText(rec.choice, x.options))], ['Commitment', '<span class="gov-mono">' + esc(rec.commitment) + '</span>'], ['Nonce', '<span class="gov-mono">' + esc(rec.nonce) + '</span>']], 2)
        + '<div class="hstack gap6" style="flex-wrap:wrap">' + UI.btn('Copy receipt', { size: 'sm', attrs: 'data-govcopy' }) + (x.commitments ? UI.btn('Check my receipt', { size: 'sm', attrs: 'data-govcheck' }) : '') + small(x.commitments ? 'The list of commitments was published when voting closed; yours should be in it with your choice.' : 'When voting closes, the commitments are published and you can check yours is counted.') + '</div>'
        + (st.govChecked && st.govChecked.id === x.id ? UI.notice(esc(st.govChecked.detail), st.govChecked.counted ? 'ok' : 'warn') : '')) : '';
      const confirm = x.can.confirm && deps.canWrite ? UI.notice('<b>This decision waits for an owner.</b> The owners chose to confirm decisions of this kind before they are carried out.', 'warn', '<span class="hstack gap6">' + UI.btn('Confirm and carry out', { kind: 'primary', size: 'sm', attrs: 'data-govconfirm' }) + UI.btn('Decline', { size: 'sm', attrs: 'data-govdecline' }) + '</span>') : x.needsConfirmation && x.state === 'closed' ? UI.notice('This decision waits for an owner\'s confirmation.', 'info') : '';
      return UI.panel('Proposal', '<h2 class="groups-title">' + esc(x.title) + '</h2>'
        + '<div class="hstack gap6" style="flex-wrap:wrap">' + statePill(x.state) + outcomePill(x.outcome) + UI.pill(KIND[x.kind] || x.kind, 'outline') + UI.pill(METHOD[x.method] + (x.threshold ? ' ' + x.threshold.num + '/' + x.threshold.den : ''), 'outline') + (x.secret ? UI.pill('secret ballot', 'outline') : '') + UI.label(x.label, { sm: true }) + '</div>'
        + (x.body ? '<div class="gov-body">' + esc(x.body) + '</div>' : '')
        + (actionText ? UI.kv([['If it passes', esc(actionText)]], 1) : '')
        + (x.options.length ? UI.kv([['Options', esc(x.options.map((o) => o.label).join(', '))]], 1) : '')
        + UI.kv([['Proposed by', esc(x.createdByName || '')], ['Quorum', esc(x.quorum.kind === 'none' ? 'none' : x.quorum.kind === 'share' ? x.quorum.value + '% of the electorate' : x.quorum.value + ' ballots')], ['Voting', esc(x.opensAt ? when(x.opensAt) + ' to ' + when(x.closesAt) : (x.hours || (x.voting && x.voting.defaultHours)) + ' hours once opened')], ['Turnout', esc(x.state === 'draft' ? '' : x.turnout + ' of ' + x.electorate + ' who may vote')]], 2)
        + (x.discussion ? '<div class="hstack gap6">' + small('Discussed in the group\'s conversation.') + (App.canOpen && App.canOpen('messages') ? UI.btn('Open the discussion', { size: 'xs', attrs: 'data-govdiscuss="' + esc(x.discussion.conversationId) + '"' }) : '') + '</div>' : x.state !== 'draft' ? small('The group has no linked conversation, so this proposal has no discussion thread.') : '')
        + (x.state === 'draft' && deps.canWrite ? '<div class="hstack gap6" style="flex-wrap:wrap">' + (x.can.edit ? UI.btn('Edit', { size: 'sm', attrs: 'data-govedit' }) : '') + (x.can.open ? UI.btn('Open voting', { kind: 'primary', size: 'sm', attrs: 'data-govopen' }) : '') + (x.can.delete ? UI.btn('Delete draft', { size: 'sm', kind: 'ghost', attrs: 'data-govdelete' }) : '') + '</div>' : '')
        + (x.state === 'open' && !x.mine.eligible ? small('You were not in the group when voting opened, so you do not vote on this proposal.') : '')
        + confirm
        + (x.state === 'carried_out' ? UI.notice('<b>Carried out</b> ' + esc(when(x.carriedAt)) + ' by the group' + (x.confirmedByName ? ', confirmed by ' + esc(x.confirmedByName) : '') + '.', 'ok') : '')
        + (x.state === 'failed' && x.failure ? UI.notice('<b>Not carried out.</b> ' + esc(x.failure), 'danger') : '')
        + (r ? '<h3 class="eyebrow">Result</h3><p class="fg2" style="margin:0">' + esc(r.explanation) + (r.quorum.kind !== 'none' ? ' Quorum: ' + r.ballots + ' of ' + r.quorum.required + ' needed.' : '') + '</p>' + UI.table([x.method === 'ranked' ? 'First choices' : 'Choice', { label: 'Votes', right: true }], tallyRows, { clickable: false, minWidth: '0' }) + rounds : ''),
      { attrs: 'aria-label="Selected proposal"' }) + vote + receiptPanel
        + (ballots ? UI.panel('Ballots', ballots + small('Public ballot: who voted for what is visible to members.')) : '')
        + (commitments ? UI.panel('Published commitments', commitments + small('Each secret ballot as a commitment and its choice, published at close. The tally above counts this list; the server keeps no voter beside a choice.')) : '');
    }

    function budgetHtml() {
      const b = d.budget;
      if (!b || !b.available) return '';
      const can = b.canManage && deps.canWrite;
      return UI.panel('Budget', (b.currency ? UI.kv([['Balance', '<b>' + esc(money(b.balanceMinor, b.currency)) + '</b>'], ['Currency', esc(b.currency)]], 2)
        + UI.table(['When', 'Amount', 'Balance after', 'Memo', 'By'], (b.entries || []).map((e) => [esc(when(e.createdAt)), esc(money(e.amountMinor, e.currency)), esc(money(e.balanceAfter, e.currency)), esc(e.memo || ''), esc(e.proposalId ? 'By decision' : e.createdByName || '')]), { clickable: false, minWidth: '0', emptyTitle: 'No entries', emptyText: 'Money in and out of the budget is listed here.' })
        : small('The group has no budget. An owner sets its currency; then proposals can spend from it.')) + small('A record of what the group holds and decided to spend. No payment is made from here.'),
      { actions: can ? (b.currency ? UI.btn('Record an entry', { size: 'sm', attrs: 'data-govledger' }) : '') + UI.btn(b.currency ? 'Change currency' : 'Set up a budget', { size: 'sm', attrs: 'data-govcurrency' }) : '' });
    }

    // ---------- dialogs ----------
    function settingsModal() {
      const custom = d.roles && d.roles.custom ? d.roles.custom : [];
      const roleOpts = ['moderator', 'admin', 'member'].map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) + ' or more' })).concat(custom.map((c) => ({ value: c.id, label: c.name })));
      ctx.modal({ title: 'Governance', body: '<div class="formgrid" style="--cols:2">'
        + UI.field('Who may propose', UI.select([{ value: 'members', label: 'Members' }, { value: 'role', label: 'Holders of a role' }, { value: 'owners', label: 'Owners only' }], v.propose, 'data-gpropose'))
        + UI.field('Role', UI.select(roleOpts, v.proposeRole || 'moderator', 'data-gprole'), 'Used when holders of a role propose; owners always may')
        + UI.field('Default method', UI.select(Object.keys(METHOD).map((k) => ({ value: k, label: METHOD[k] })), v.method, 'data-gmethod'), 'A change to the group is always decided by majority or supermajority')
        + UI.field('Supermajority', UI.input(v.threshold.num + '/' + v.threshold.den, { attrs: 'data-gthreshold inputmode="numeric" maxlength="7"' }), 'A fraction above one half, such as 2/3 or 3/5')
        + UI.field('Quorum', UI.select([{ value: 'none', label: 'None' }, { value: 'share', label: 'A share of the electorate (%)' }, { value: 'count', label: 'A number of ballots' }], v.quorum.kind, 'data-gqkind'))
        + UI.field('Quorum value', UI.input(String(v.quorum.value), { attrs: 'data-gqvalue inputmode="numeric" maxlength="7"' }))
        + UI.field('Shortest vote (hours)', UI.input(String(v.minHours), { attrs: 'data-gmin inputmode="numeric" maxlength="4"' }))
        + UI.field('Longest vote (hours)', UI.input(String(v.maxHours), { attrs: 'data-gmax inputmode="numeric" maxlength="4"' }))
        + UI.field('Default length (hours)', UI.input(String(v.defaultHours), { attrs: 'data-gdef inputmode="numeric" maxlength="4"' }))
        + UI.field('Ballots', UI.select([{ value: 'public', label: 'Public by default' }, { value: 'secret', label: 'Secret by default' }], v.secret ? 'secret' : 'public', 'data-gsecret')) + '</div>'
        + UI.field('Owners confirm before these are carried out', '<div class="gov-choices">' + ['setting', 'member', 'role', 'rules', 'spend'].map((k) => UI.check(KIND[k], v.confirmKinds.indexOf(k) >= 0, 'data-gconfirm="' + k + '"')).join('') + '</div>')
        + UI.field('Rules', UI.textarea(v.rules || '', { rows: 4, attrs: 'data-grules maxlength="20000"' }), 'The group\'s written rules, shown on the Proposals tab. A proposal can change them too')
        + '<div data-goverr></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-gsave' }),
      onMount(m) {
        m.querySelector('[data-gsave]').addEventListener('click', () => {
          const q = (s) => m.querySelector(s);
          const th = q('[data-gthreshold]').value.split('/').map((x) => parseInt(x, 10));
          const body = { propose: q('[data-gpropose]').value, method: q('[data-gmethod]').value, threshold: { num: th[0] || 2, den: th[1] || 3 }, quorum: { kind: q('[data-gqkind]').value, value: parseInt(q('[data-gqvalue]').value, 10) || 0 },
            minHours: parseInt(q('[data-gmin]').value, 10) || 1, maxHours: parseInt(q('[data-gmax]').value, 10) || 1, defaultHours: parseInt(q('[data-gdef]').value, 10) || 1, secret: q('[data-gsecret]').value === 'secret',
            confirmKinds: Array.prototype.slice.call(m.querySelectorAll('[data-gconfirm]')).filter((x) => x.checked).map((x) => x.dataset.gconfirm), rules: q('[data-grules]').value };
          if (body.propose === 'role') body.proposeRole = q('[data-gprole]').value;
          App.put(base + '/governance', body).then(() => done('Governance saved. Audited as group.governance.updated.')).catch((err) => { m.querySelector('[data-goverr]').innerHTML = problemOf(err); });
        });
      } });
    }

    function proposalModal(existing) {
      const x = existing || { kind: 'free', title: '', body: '', options: [], action: {}, method: v.method === 'approval' || v.method === 'ranked' ? 'majority' : v.method, secret: v.secret, hours: null };
      const act = x.action || {};
      const members = (deps.members || []).map((m) => ({ value: m.userId, label: m.displayName || m.username }));
      const custom = d.roles && d.roles.custom ? d.roles.custom : [];
      const kindFields = (k) => {
        if (k === 'setting') return '<div class="formgrid" style="--cols:2">' + UI.field('New name', UI.input((act.patch && act.patch.name) || '', { attrs: 'data-pname maxlength="200"', placeholder: 'unchanged' }))
          + UI.field('Visibility', UI.select([{ value: '', label: 'Unchanged' }, 'public', 'private', 'hidden'], (act.patch && act.patch.visibility) || '', 'data-pvis'))
          + UI.field('Join mode', UI.select([{ value: '', label: 'Unchanged' }, 'open', 'request', 'invite'], (act.patch && act.patch.joinMode) || '', 'data-pjoin'))
          + UI.field('Member limit', UI.input(act.patch && act.patch.memberLimit != null ? String(act.patch.memberLimit) : '', { attrs: 'data-plimit inputmode="numeric" maxlength="7"', placeholder: 'unchanged' })) + '</div>'
          + UI.field('New description', UI.textarea((act.patch && act.patch.description) || '', { rows: 2, attrs: 'data-pdesc', placeholder: 'unchanged' }));
        if (k === 'member') return '<div class="formgrid" style="--cols:2">' + UI.field('Change', UI.select([{ value: 'add', label: 'Add (invite) a person' }, { value: 'remove', label: 'Remove a member' }], act.op || 'add', 'data-pop'))
          + UI.field('Person', UI.select(deps.candidates && deps.candidates.length ? [{ value: '', label: 'Choose' }].concat(deps.candidates.map((c) => ({ value: c.userId, label: c.displayName + ' (not a member)' }))).concat(members.map((m) => ({ value: m.value, label: m.label + ' (member)' }))) : [{ value: '', label: 'Choose' }].concat(members), act.userId || '', 'data-puser')) + '</div>';
        if (k === 'role') return '<div class="formgrid" style="--cols:2">' + UI.field('Member', UI.select([{ value: '', label: 'Choose' }].concat(members), act.userId || '', 'data-puser'))
          + UI.field('Role', UI.select(['owner', 'admin', 'moderator', 'member', 'guest'].map((r) => ({ value: r, label: r })).concat(custom.map((c) => ({ value: 'custom:' + c.id, label: c.name + ' (custom)' }))), act.customRoleId ? 'custom:' + act.customRoleId : act.role || 'member', 'data-prole'), 'Taking a role is giving member') + '</div>';
        if (k === 'rules') return UI.field('The new rules', UI.textarea(act.rules != null ? act.rules : (v.rules || ''), { rows: 5, attrs: 'data-prules maxlength="20000"' }));
        if (k === 'spend') return '<div class="formgrid" style="--cols:2">' + UI.field('Amount' + (d.budget && d.budget.currency ? ' (' + d.budget.currency + ')' : ''), UI.input(act.amountMinor ? String(act.amountMinor / 100) : '', { attrs: 'data-pamount inputmode="decimal" maxlength="15"', placeholder: '25.00' }))
          + UI.field('What for', UI.input(act.memo || '', { attrs: 'data-pmemo maxlength="500"' })) + '</div>' + (d.budget && d.budget.currency ? small('The budget holds ' + esc(money(d.budget.balanceMinor, d.budget.currency)) + ' now.') : UI.notice('The group has no budget yet; an owner sets one up first.', 'warn'));
        return UI.field('Options', UI.textarea((x.options || []).map((o) => o.label).join('\n'), { rows: 3, attrs: 'data-poptions', placeholder: 'One per line, for approval or ranked choice' }), 'Leave empty for a yes or no vote');
      };
      ctx.modal({ title: existing ? 'Edit the proposal' : 'New proposal', body: UI.field('Kind', UI.select(Object.keys(KIND).map((k) => ({ value: k, label: KIND[k] })), x.kind, 'data-pkind' + (existing ? ' disabled' : '')))
        + UI.field('Title', UI.input(x.title, { attrs: 'data-ptitle maxlength="200"' }))
        + UI.field('Text', UI.textarea(x.body || '', { rows: 3, attrs: 'data-pbody maxlength="20000"' }), 'Sealed with the group\'s label, as posts are')
        + '<div data-pkindfields>' + kindFields(x.kind) + '</div>'
        + '<div class="formgrid" style="--cols:3">' + UI.field('Method', UI.select(Object.keys(METHOD).map((k) => ({ value: k, label: METHOD[k] })), x.method, 'data-pmethod'))
        + UI.field('Ballots', UI.select([{ value: 'public', label: 'Public' }, { value: 'secret', label: 'Secret' }], x.secret ? 'secret' : 'public', 'data-psecret'))
        + UI.field('Voting lasts (hours)', UI.input(x.hours ? String(x.hours) : '', { attrs: 'data-phours inputmode="numeric" maxlength="4"', placeholder: String(v.defaultHours) }), v.minHours + ' to ' + v.maxHours) + '</div>'
        + '<div data-goverr></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(existing ? 'Save draft' : 'Create draft', { kind: 'primary', attrs: 'data-psave' }),
      onMount(m) {
        const q = (s) => m.querySelector(s);
        q('[data-pkind]').addEventListener('change', () => { q('[data-pkindfields]').innerHTML = kindFields(q('[data-pkind]').value); });
        q('[data-psave]').addEventListener('click', () => {
          const kind = q('[data-pkind]').value;
          const body = { title: q('[data-ptitle]').value, body: q('[data-pbody]').value, method: q('[data-pmethod]').value, secret: q('[data-psecret]').value === 'secret' };
          const h = parseInt(q('[data-phours]').value, 10); if (h) body.hours = h;
          if (kind === 'free') { const o = q('[data-poptions]').value.split('\n').map((s) => s.trim()).filter(Boolean); body.options = o; body.action = {}; }
          else {
            body.options = [];
            if (kind === 'setting') { const p = {}; const nm = q('[data-pname]').value.trim(); if (nm) p.name = nm; if (q('[data-pvis]').value) p.visibility = q('[data-pvis]').value; if (q('[data-pjoin]').value) p.joinMode = q('[data-pjoin]').value; const lim = parseInt(q('[data-plimit]').value, 10); if (lim) p.memberLimit = lim; const ds = q('[data-pdesc]').value.trim(); if (ds) p.description = ds; body.action = { patch: p }; }
            if (kind === 'member') body.action = { op: q('[data-pop]').value, userId: q('[data-puser]').value };
            if (kind === 'role') { const r = q('[data-prole]').value; body.action = r.indexOf('custom:') === 0 ? { userId: q('[data-puser]').value, customRoleId: r.slice(7) } : { userId: q('[data-puser]').value, role: r }; }
            if (kind === 'rules') body.action = { rules: q('[data-prules]').value };
            if (kind === 'spend') { const a = Math.round(parseFloat(q('[data-pamount]').value) * 100); body.action = { amountMinor: a || 0 }; const memo = q('[data-pmemo]').value.trim(); if (memo) body.action.memo = memo; }
          }
          const req = existing ? App.patch('/api/group-proposals/' + enc(existing.id), body) : App.post(base + '/proposals', Object.assign({ kind }, body));
          req.then((pr) => { d.sel = pr.id; done(existing ? 'Draft saved. Audited as group.proposal.updated.' : 'Draft created. Open voting when it is ready. Audited as group.proposal.created.'); }).catch((err) => { q('[data-goverr]').innerHTML = problemOf(err); });
        });
      } });
    }

    function bind() {
      if (where === 'overview') return;
      const x = d.detail;
      const pick = (id) => { d.sel = id; st.govChecked = null; App.get('/api/group-proposals/' + enc(id)).then((y) => { d.detail = y; deps.later(); }).catch((err) => App.fail(err, 'Proposal not loaded')); };
      ctx.on('click', '[data-gproposal]', (e, t) => pick(t.dataset.gproposal));
      ctx.on('keydown', '[data-gproposal]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(t.dataset.gproposal); } });
      ctx.on('click', '[data-govnew]', () => {
        // The person pickers: members (and, for an invitation, people who may be invited).
        Promise.all([App.get(base + '/members').catch(() => []), App.get(base + '/candidates').catch(() => [])]).then((r) => { deps.members = Array.isArray(r[0]) ? r[0] : (r[0].items || []); deps.candidates = r[1] || []; proposalModal(null); });
      });
      if (!x) return;
      const url = '/api/group-proposals/' + enc(x.id);
      ctx.on('click', '[data-govedit]', () => { Promise.all([App.get(base + '/members').catch(() => []), App.get(base + '/candidates').catch(() => [])]).then((r) => { deps.members = Array.isArray(r[0]) ? r[0] : (r[0].items || []); deps.candidates = r[1] || []; proposalModal(x); }); });
      ctx.on('click', '[data-govopen]', async () => {
        if (!(await ctx.confirm({ title: 'Open voting on this proposal?', tone: 'info', body: '<p style="margin:0" class="fg2">Who may vote is fixed now: the group\'s members as they stand. Voting lasts ' + esc(String(x.hours || (x.voting && x.voting.defaultHours))) + ' hours. The proposal can no longer be changed.</p>', ok: 'Open voting' }))) return;
        App.post(url + '/open', {}).then(() => done('Voting is open. The members were told. Audited as group.proposal.opened.')).catch((err) => App.fail(err, 'Voting not opened'));
      });
      ctx.on('click', '[data-govdelete]', async () => {
        if (!(await ctx.confirm({ title: 'Delete this draft?', tone: 'danger', ok: 'Delete draft' }))) return;
        App.del(url).then(() => { d.sel = null; done('Draft deleted. Audited as group.proposal.deleted.'); }).catch((err) => App.fail(err, 'Not deleted'));
      });
      ctx.on('click', '[data-govvote]', () => {
        const root = document.getElementById('main');
        let choice;
        if (x.method === 'majority' || x.method === 'supermajority') { const c = root.querySelector('[data-govyn]:checked'); if (!c) { ctx.toast('Choose yes, no or abstain.', 'warn'); return; } choice = c.value; }
        else if (x.method === 'approval') choice = Array.prototype.slice.call(root.querySelectorAll('[data-govapprove]')).filter((c) => c.checked).map((c) => c.dataset.govapprove);
        else choice = Array.prototype.slice.call(root.querySelectorAll('[data-govrank]')).filter((s) => s.value).sort((a, b) => +a.value - +b.value).map((s) => s.dataset.govrank);
        const body = { choice };
        const rec = x.secret ? loadReceipt(x.id) || (st.govReceipt && st.govReceipt.proposalId === x.id ? st.govReceipt : null) : null;
        if (x.secret && x.mine.voted && rec) { body.ballotId = rec.ballotId; body.token = rec.token; }
        App.post(url + '/ballots', body).then((r) => {
          if (r.receipt) { st.govReceipt = r.receipt; saveReceipt(r.receipt); }
          done(r.secret ? 'Vote recorded. Keep your receipt: it checks the count and changes your vote. Audited as ' + (r.changed ? 'group.vote.changed' : 'group.vote.cast') + ', without your choice.' : 'Vote recorded. Audited as ' + (r.changed ? 'group.vote.changed.' : 'group.vote.cast.'));
        }).catch((err) => { const box = root.querySelector('[data-goverr]'); if (box) box.innerHTML = problemOf(err); else App.fail(err, 'Not voted'); });
      });
      ctx.on('click', '[data-govcopy]', () => {
        const rec = (st.govReceipt && st.govReceipt.proposalId === x.id ? st.govReceipt : null) || loadReceipt(x.id); if (!rec) return;
        const text = JSON.stringify(rec);
        const nope = () => ctx.toast('Copy the receipt from the panel; the clipboard is not available here.', 'warn');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => ctx.toast('Receipt copied. It includes the token that changes your vote: keep it to yourself.', 'ok', 5000), nope); else nope();
      });
      ctx.on('click', '[data-govcheck]', () => {
        const rec = (st.govReceipt && st.govReceipt.proposalId === x.id ? st.govReceipt : null) || loadReceipt(x.id); if (!rec) return;
        App.post(url + '/verify-receipt', { commitment: rec.commitment, choice: rec.choice }).then((r) => { st.govChecked = { id: x.id, counted: r.counted, detail: r.detail }; deps.later(); }).catch((err) => App.fail(err, 'Not checked'));
      });
      ctx.on('click', '[data-govconfirm]', async () => {
        if (!(await ctx.confirm({ title: 'Carry out this decision?', tone: 'info', body: '<p style="margin:0" class="fg2">The group carries it out now, through its own services, with an owner\'s rights in this group.</p>', ok: 'Confirm' }))) return;
        App.post(url + '/confirm', {}).then((r) => done(r.state === 'carried_out' ? 'Confirmed and carried out. Audited as group.decision.confirmed and group.decision.applied.' : 'Confirmed; it could not be carried out. See the proposal.')).catch((err) => App.fail(err, 'Not confirmed'));
      });
      ctx.on('click', '[data-govdecline]', () => {
        ctx.modal({ title: 'Decline this decision', body: UI.field('Why (optional)', UI.textarea('', { rows: 2, attrs: 'data-dreason maxlength="500"' }), 'Posted with the proposal and in the conversation') + '<div data-goverr></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Decline', { kind: 'danger', attrs: 'data-dgo' }),
          onMount(m) { m.querySelector('[data-dgo]').addEventListener('click', () => { App.post(url + '/decline', { reason: m.querySelector('[data-dreason]').value || null }).then(() => done('Declined; it will not be carried out. Audited as group.decision.declined.')).catch((err) => { m.querySelector('[data-goverr]').innerHTML = problemOf(err); }); }); } });
      });
      ctx.on('click', '[data-govdiscuss]', (e, t) => App.navigate('messages', { c: t.dataset.govdiscuss }));
      ctx.on('click', '[data-govcurrency]', () => {
        ctx.modal({ title: 'Budget currency', body: UI.field('Currency', UI.input((d.budget && d.budget.currency) || 'EUR', { attrs: 'data-bcur maxlength="3"' }), 'Three letters (ISO 4217). Changed only while the balance is zero') + '<div data-goverr></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-bgo' }),
          onMount(m) { m.querySelector('[data-bgo]').addEventListener('click', () => { App.put(base + '/budget', { currency: m.querySelector('[data-bcur]').value.trim() }).then(() => done('Budget currency saved. Audited as group.budget.currency.')).catch((err) => { m.querySelector('[data-goverr]').innerHTML = problemOf(err); }); }); } });
      });
      ctx.on('click', '[data-govledger]', () => {
        ctx.modal({ title: 'Record a budget entry', body: '<div class="formgrid" style="--cols:2">' + UI.field('Direction', UI.select([{ value: 'in', label: 'Money in' }, { value: 'out', label: 'Money out' }], 'in', 'data-bdir')) + UI.field('Amount (' + esc(d.budget.currency) + ')', UI.input('', { attrs: 'data-bamt inputmode="decimal" maxlength="15"', placeholder: '25.00' })) + '</div>' + UI.field('Memo', UI.input('', { attrs: 'data-bmemo maxlength="500"' })) + '<div data-goverr></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Record', { kind: 'primary', attrs: 'data-bgo' }),
          onMount(m) { m.querySelector('[data-bgo]').addEventListener('click', () => { const a = Math.round(parseFloat(m.querySelector('[data-bamt]').value) * 100) || 0; App.post(base + '/budget/entries', { amountMinor: m.querySelector('[data-bdir]').value === 'out' ? -a : a, memo: m.querySelector('[data-bmemo]').value || null }).then(() => done('Entry recorded. Audited as group.budget.' + (m.querySelector('[data-bdir]').value === 'out' ? 'spent.' : 'credited.'))).catch((err) => { m.querySelector('[data-goverr]').innerHTML = problemOf(err); }); }); } });
      });
    }

    return { html, bind };
  };
})();
