// Apps, the Roles tab (1.8.0, Sprint 48, B-143): the app's own role catalogue (Clerk, Approver, Viewer...), who holds
// each role here (people, social groups, or every member of a workspace as a default role), and what a role can do,
// read from the row and field policies that name it (subject kind app_role). A role grants nothing by itself: only the
// policies naming it do, and never past the reader's permissions or clearance. Designers (apps:design) manage it.
// apps.js calls App.appsRoles(ctx, app, deps) for the tab and App.appsRolesCount(st, app) for its count; state lives
// in ctx.state.ar.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const KIND_WORD = { user: 'Person', group: 'Group', workspace: 'Workspace default' };
  const OP_WORD = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'in', contains: 'contains', startsWith: 'starts with', exists: 'has a value' };
  const CSS = '#main .apps-ar{display:flex;flex-direction:column;gap:12px;min-width:0}'
    + '#main .apps-ar .ar-assign{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;min-width:0}#main .apps-ar .ar-assign .field{margin:0;min-width:0;flex:1 1 180px;max-width:100%}'
    + '#main .apps-ar .ar-assign select,#main .apps-ar .ar-assign input{max-width:100%;min-width:0}'
    + '#main .apps-ar .ar-found{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none;min-width:0}'
    + '#main .apps-ar .ar-can{margin:0;padding-left:18px}#main .apps-ar .ar-can li{margin:4px 0;overflow-wrap:anywhere}'
    + '#main .apps-ar .ar-desc{font-size:12px;overflow-wrap:anywhere}';

  const base = (app) => '/api/apps/' + enc(app.id) + '/roles';
  const arOf = (st) => st.ar || (st.ar = { key: null, list: null, sel: null, kind: 'user', found: null, q: '' });
  const overlay = () => !!document.querySelector('#overlay .modal, #overlay .drawer');

  function load(ctx, app, deps) {
    const ar = arOf(ctx.state);
    if (ar.busy === app.id) return;
    ar.busy = app.id;
    App.get(base(app))
      .then((r) => { ar.list = r.roles; ar.key = app.id; ar.err = null; if (!ar.list.some((x) => x.id === ar.sel)) ar.sel = ar.list[0] ? ar.list[0].id : null; })
      .catch((err) => { ar.err = err; ar.key = app.id; })
      .finally(() => { ar.busy = null; if (!overlay()) deps.refresh(); });
  }
  function groupsFor(ar, app) {
    if (ar.groups || ar.groupsBusy) return;
    ar.groupsBusy = true;
    App.get('/api/groups').then((l) => { const all = Array.isArray(l) ? l : (l && l.items) || []; ar.groups = all.filter((g) => !app.workspaceId || g.workspaceId === app.workspaceId); }).catch(() => { ar.groups = []; }).finally(() => { ar.groupsBusy = false; });
  }

  /** A row condition in words: `amount < 1000 and region = $user.attributes.region`. */
  function rowsText(f) {
    if (!f) return 'every record';
    if (f.and) return f.and.map(rowsText).join(' and ');
    if (f.or) return '(' + f.or.map(rowsText).join(' or ') + ')';
    if (f.not) return 'not ' + rowsText(f.not);
    const v = Array.isArray(f.value) ? f.value.join(', ') : f.value === undefined ? '' : String(f.value);
    return f.field + ' ' + (OP_WORD[f.op] || f.op) + (v ? ' ' + v : '');
  }
  /** The field grants of a policy in words. */
  function fieldsText(p) {
    const parts = [];
    const o = p.otherFields || {};
    Object.keys(p.fields || {}).forEach((name) => {
      const g = p.fields[name];
      if (!g.read) parts.push(name + ' hidden');
      else if (!g.unmasked) parts.push(name + ' masked (' + g.mask + ')');
      const no = ['create', 'update'].filter((k) => g[k] === false);
      if (no.length) parts.push('no ' + no.join(' or ') + ' of ' + name);
    });
    if (o.read === false) parts.push('other fields hidden');
    const oNo = ['create', 'update'].filter((k) => o[k] === false);
    if (oNo.length) parts.push('no ' + oNo.join(' or ') + ' of other fields');
    return parts.length ? parts.join('; ') : 'every field, read and write';
  }
  function canDo(role) {
    if (!role.policies.length) return UI.notice('No policy names ' + esc(role.name) + ' yet, so holding it gives nothing. Name it in a policy on the Policies tab (subject kind app_role).', 'warn');
    return '<ul class="ar-can">' + role.policies.map((p) => '<li><b>' + esc(p.name) + '</b>' + (p.enabled ? '' : ' ' + UI.pill('off', '')) + ': ' + esc(p.entity ? 'records of ' + p.entity : 'records of every entity') + ' where ' + '<span class="mono">' + esc(rowsText(p.rows)) + '</span>; ' + esc(fieldsText(p)) + '</li>').join('') + '</ul>'
      + '<p class="muted" style="margin:0;font-size:12px">Labels and clearance apply first, and a reader still needs records:read (records:write to change records). Other policies may give a holder more.</p>';
  }

  App.appsRolesCount = function (st, app) {
    const ar = st.ar;
    return ar && ar.key === app.id && ar.list ? ar.list.length : null;
  };

  App.appsRoles = function (ctx, app, deps) {
    const st = ctx.state;
    const ar = arOf(st);
    if (ar.key !== app.id) { if (ar.key) { ar.list = null; ar.sel = null; ar.found = null; ar.groups = null; } load(ctx, app, deps); }
    groupsFor(ar, app);
    const head = '<style>' + CSS + '</style>';
    if (ar.err && ar.key === app.id) return { body: head + UI.problem('Roles could not be loaded', deps.detailOf(ar.err), deps.traceOf(ar.err)) + '<div>' + UI.btn('Try again', { attrs: 'data-ar-reload' }) + '</div>', inspector: '' };
    if (ar.key !== app.id || !ar.list) return { body: head + UI.notice('Loading roles…', 'info'), inspector: '' };
    const role = ar.list.find((r) => r.id === ar.sel) || null;

    let html = head + '<div class="apps-ar">';
    html += UI.panel('Roles of this app', UI.notice('Each app keeps its own roles. A row or field policy names a role (subject kind <span class="mono">app_role</span>); whoever holds the role here gets what the policy says, and nothing more: a role never passes the reader\'s permissions or clearance and means nothing outside this app. Packages and promotions carry the roles, not who holds them: assign people in each environment.', 'info')
      + '<div class="hstack wrap" style="gap:6px">' + UI.btn('New role', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-ar-new' }) + UI.btn('Refresh', { size: 'sm', icon: 'refresh', attrs: 'data-ar-reload' }) + '</div>'
      + UI.table(['Role', 'Held by', 'Policies', { label: '', right: true }], ar.list.map((r) => ({
        cells: ['<b>' + esc(r.name) + '</b>' + (r.description ? '<div class="muted ar-desc">' + esc(r.description) + '</div>' : ''), esc(String(r.members.length)), esc(String(r.policies.length)),
          '<span class="hstack wrap" style="justify-content:flex-end;gap:4px">' + UI.btn(r.id === ar.sel ? 'Shown' : 'Show', { size: 'xs', kind: 'ghost', attrs: 'data-ar-sel="' + esc(r.id) + '" aria-pressed="' + (r.id === ar.sel ? 'true' : 'false') + '" aria-label="Show ' + esc(r.name) + '"' }) + UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-ar-edit="' + esc(r.id) + '" aria-label="Edit ' + esc(r.name) + '"' }) + UI.btn('Delete', { size: 'xs', kind: 'ghost', attrs: 'data-ar-del="' + esc(r.id) + '" aria-label="Delete ' + esc(r.name) + '"' }) + '</span>'],
        selected: r.id === ar.sel
      })), { clickable: false, minWidth: '0', emptyTitle: 'No roles yet', emptyText: 'Add the roles people have in this app, such as Clerk, Approver or Viewer, then name them in policies.' }));

    if (role) {
      const members = UI.table(['Holder', 'How', 'Since', { label: '', right: true }], role.members.map((m) => [esc(m.name || m.subjectId), esc(KIND_WORD[m.kind] || m.kind), esc(deps.when(m.createdAt)), UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-ar-unassign="' + esc(m.id) + '" aria-label="Remove ' + esc(m.name || m.subjectId) + ' from ' + esc(role.name) + '"' })]), { clickable: false, minWidth: '0', emptyTitle: 'Nobody holds ' + role.name, emptyText: 'Give it to people, a group, or every member of a workspace below.' });
      let pick = '';
      if (ar.kind === 'user') {
        pick = UI.field('Find a person', UI.input(ar.q || '', { type: 'search', placeholder: 'name or username', attrs: 'data-ar-q maxlength="100" autocomplete="off"' })) + UI.btn('Find', { size: 'sm', attrs: 'data-ar-find' });
      } else if (ar.kind === 'group') {
        const groups = ar.groups || [];
        pick = UI.field('Group', UI.select(groups.length ? groups.map((g) => ({ value: g.id, label: g.name })) : [{ value: '', label: ar.groups ? 'No group of this workspace' : 'Loading groups…' }], '', 'data-ar-group')) + UI.btn('Assign', { kind: 'primary', size: 'sm', attrs: 'data-ar-assign-group' + (groups.length ? '' : ' disabled') });
      } else {
        const spaces = ((App.me && App.me.workspaces) || []).filter((w) => !app.workspaceId || w.id === app.workspaceId);
        pick = UI.field('Workspace', UI.select(spaces.length ? spaces.map((w) => ({ value: w.id, label: w.name })) : [{ value: '', label: 'No workspace' }], '', 'data-ar-ws')) + UI.btn('Assign', { kind: 'primary', size: 'sm', attrs: 'data-ar-assign-ws' + (spaces.length ? '' : ' disabled') });
      }
      const found = ar.kind === 'user' && ar.found ? (ar.found.length ? '<ul class="ar-found" aria-label="People found">' + ar.found.map((p) => '<li>' + UI.btn('Assign ' + p.displayName + ' (' + p.username + ')', { size: 'sm', attrs: 'data-ar-assign-user="' + esc(p.id) + '"' }) + '</li>').join('') + '</ul>' : '<p class="muted" style="margin:0">Nobody of the app\'s workspace matches.</p>') : '';
      html += UI.panel('What ' + esc(role.name) + ' can do', canDo(role));
      html += UI.panel('Who holds ' + esc(role.name), members
        + '<div class="ar-assign">' + UI.field('Give the role to', UI.select([{ value: 'user', label: 'A person' }, { value: 'group', label: 'A group' }, { value: 'workspace', label: 'Every member of a workspace' }], ar.kind, 'data-ar-kind')) + pick + '</div>' + found
        + '<p class="muted" style="margin:0;font-size:12px">A group\'s members hold the role while they count as members (not banned, suspended or gone). Every change is audited (app.role.assigned, app.role.unassigned).</p>');
    }
    html += '</div>';

    // ----- events -----
    const reload = () => { ar.key = null; load(ctx, app, deps); };
    const fail = (err, what) => App.fail(err, what);
    ctx.on('click', '[data-ar-reload]', () => reload());
    ctx.on('click', '[data-ar-sel]', (e, t) => { ar.sel = t.dataset.arSel; ar.found = null; deps.refresh(); });
    ctx.on('change', '[data-ar-kind]', (e, t) => { ar.kind = t.value; ar.found = null; deps.refresh(); });
    ctx.on('input', '[data-ar-q]', (e, t) => { ar.q = t.value; });
    const find = async () => {
      try { ar.found = (await App.get(base(app) + '/candidates?q=' + enc((ar.q || '').trim()))).people; } catch (err) { fail(err, 'Could not search'); return; }
      deps.refresh();
    };
    ctx.on('click', '[data-ar-find]', () => find());
    ctx.on('keydown', '[data-ar-q]', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });

    const roleModal = (r) => deps.modal({
      title: r ? 'Edit role ' + esc(r.name) : 'New role',
      body: '<div class="formgrid">' + UI.field('Name', UI.input(r ? r.name : '', { placeholder: 'for example Clerk', attrs: 'data-ar-name maxlength="63"' }), 'Unique in this app. Renaming it renames it in the policies that name it.') + UI.field('Description (optional)', UI.input(r && r.description ? r.description : '', { attrs: 'data-ar-descr maxlength="500"' })) + '</div><div data-ar-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(r ? 'Save role' : 'Add role', { kind: 'primary', attrs: 'data-ar-ok' }),
      onMount(m) {
        const nameEl = m.querySelector('[data-ar-name]'); nameEl.focus();
        m.querySelector('[data-ar-ok]').addEventListener('click', async () => {
          const errEl = m.querySelector('[data-ar-err]'); errEl.innerHTML = '';
          const body = { name: nameEl.value.trim(), description: m.querySelector('[data-ar-descr]').value.trim() || null };
          if (!body.name) { errEl.innerHTML = UI.notice('Give the role a name.', 'warn'); return; }
          try {
            const out = r ? await App.patch(base(app) + '/' + enc(r.id), body) : await App.post(base(app), body);
            App.closeOverlay(); ar.sel = out.id; reload();
            ctx.toast((r ? 'Role ' + esc(out.name) + ' saved' : 'Role ' + esc(out.name) + ' added') + '. Audited app.role.' + (r ? 'updated' : 'created') + '.', 'ok');
          } catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(deps.detailOf(err)), 'danger'); }
        });
      }
    });
    ctx.on('click', '[data-ar-new]', () => roleModal(null));
    ctx.on('click', '[data-ar-edit]', (e, t) => roleModal(ar.list.find((r) => r.id === t.dataset.arEdit)));
    ctx.on('click', '[data-ar-del]', async (e, t) => {
      const r = ar.list.find((x) => x.id === t.dataset.arDel); if (!r) return;
      if (r.policies.length) { ctx.toast('The policies ' + esc(r.policies.map((p) => p.name).join(', ')) + ' name ' + esc(r.name) + '; take it out of them first.', 'warn', 5000); return; }
      const ok = await ctx.confirm({ title: 'Delete role ' + esc(r.name) + '?', tone: 'danger', body: '<p>The role and its ' + r.members.length + ' assignment' + (r.members.length === 1 ? '' : 's') + ' go. No policy names it, so nobody loses access.</p>', ok: 'Delete role' });
      if (!ok) return;
      try { await App.del(base(app) + '/' + enc(r.id)); ar.sel = null; reload(); ctx.toast('Role ' + esc(r.name) + ' deleted. Audited app.role.deleted.', 'ok'); } catch (err) { fail(err, 'Could not delete the role'); }
    });
    const assign = async (body, who) => {
      if (!role) return;
      const ok = await ctx.confirm({ title: 'Give ' + esc(role.name) + ' to ' + esc(who) + '?', body: '<p>' + esc(who) + ' get' + (body.kind === 'user' ? 's' : '') + ' what the policies naming ' + esc(role.name) + ' allow, within their permissions and clearance.</p>', ok: 'Assign' });
      if (!ok) return;
      try { await App.post(base(app) + '/' + enc(role.id) + '/members', body); ar.found = null; reload(); ctx.toast(esc(who) + ' now hold' + (body.kind === 'user' ? 's ' : ' ') + esc(role.name) + '. Audited app.role.assigned.', 'ok'); } catch (err) { fail(err, 'Could not assign the role'); }
    };
    ctx.on('click', '[data-ar-assign-user]', (e, t) => { const p = (ar.found || []).find((x) => x.id === t.dataset.arAssignUser); if (p) assign({ kind: 'user', id: p.id }, p.displayName); });
    ctx.on('click', '[data-ar-assign-group]', () => { const sel = ctx.$('[data-ar-group]'); const g = (ar.groups || []).find((x) => x.id === (sel && sel.value)); if (g) assign({ kind: 'group', id: g.id }, 'the members of ' + g.name); });
    ctx.on('click', '[data-ar-assign-ws]', () => { const sel = ctx.$('[data-ar-ws]'); const w = ((App.me && App.me.workspaces) || []).find((x) => x.id === (sel && sel.value)); if (w) assign({ kind: 'workspace', id: w.id }, 'every member of ' + w.name); });
    ctx.on('click', '[data-ar-unassign]', async (e, t) => {
      if (!role) return;
      const m = role.members.find((x) => x.id === t.dataset.arUnassign); if (!m) return;
      const ok = await ctx.confirm({ title: 'Take ' + esc(role.name) + ' from ' + esc(m.name || m.subjectId) + '?', tone: 'danger', body: '<p>What the role gave stops at the next request.</p>', ok: 'Remove' });
      if (!ok) return;
      try { await App.del(base(app) + '/' + enc(role.id) + '/members/' + enc(m.id)); reload(); ctx.toast(esc(m.name || m.subjectId) + ' no longer holds ' + esc(role.name) + '. Audited app.role.unassigned.', 'ok'); } catch (err) { fail(err, 'Could not remove the assignment'); }
    });
    return { body: html, inspector: '' };
  };
})();
