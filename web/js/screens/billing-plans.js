(function () {
  /*
   * 1.9.0, Sprint 51 (B-162, B-165, B-166): the Billing tab's plans, subscription, discounts and promotion codes, shown
   * under the statements of Usage and audit › Billing. `usage-audit.js` calls `App.BillingPlans.html` and `wire`.
   *
   * - Subscription (`billing:read`; changes with `billing:manage` or `tenant:manage`): plan, seats, state, period;
   *   change the plan or seats with a proration preview, now or at renewal; cancel at period end; pause and resume.
   * - Plans (`billing:read`; the catalogue with `platform:manage`): new plans and new prices wait for a second platform
   *   admin, who approves or rejects them here.
   * - Discounts and promotion codes (`billing:manage`); tenant admins redeem a code for their own tenant.
   */
  const { UI, esc } = App;
  const ZERO = { BIF: 1, CLP: 1, DJF: 1, GNF: 1, JPY: 1, KMF: 1, KRW: 1, MGA: 1, PYG: 1, RWF: 1, UGX: 1, VND: 1, VUV: 1, XAF: 1, XOF: 1, XPF: 1 };
  const digits = (c) => (ZERO[String(c || '').toUpperCase()] ? 0 : 2);
  const money = (minor, cur) => { const d = digits(cur); return (Number(minor || 0) / Math.pow(10, d)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ' + (cur || ''); };
  const toMinor = (text, cur) => { const t = String(text == null ? '' : text).replace(/,/g, '').trim(); if (!t) return 0; const v = Number(t); if (!isFinite(v) || v < 0) return null; return Math.round(v * Math.pow(10, digits(cur))); };
  const fromMinor = (minor, cur) => String(Number(minor || 0) / Math.pow(10, digits(cur)));
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const METERS = { prompt_tokens: 'Prompt tokens', output_tokens: 'Output tokens', thinking_tokens: 'Thinking tokens', gpu_seconds: 'GPU-seconds', requests: 'Requests', calc_calls: 'Calculator calls' };
  const CYCLE = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', custom: 'Custom' };
  const cycleText = (c) => (c ? (c.kind === 'custom' ? 'Every ' + c.months + ' months' : CYCLE[c.kind]) + ', on day ' + c.anchorDay : '');
  const monthsText = (m) => (m === 1 ? 'month' : m === 3 ? 'quarter' : m === 12 ? 'year' : m + ' months');
  const EVENT = { created: 'Subscribed', 'trial-ended': 'Trial ended', renewed: 'Renewed', 'plan-changed': 'Plan changed', 'seats-changed': 'Seats changed', 'change-scheduled': 'Change scheduled for renewal', 'change-unscheduled': 'Scheduled change dropped', 'cancel-scheduled': 'Set to end at period end', 'cancel-unscheduled': 'Kept', cancelled: 'Cancelled', ended: 'Ended', paused: 'Paused', resumed: 'Resumed' };
  const canPlatform = () => App.can('platform:manage');
  const canChange = () => App.can('billing:manage') || App.can('tenant:manage');
  const canDiscounts = () => App.can('billing:manage');
  const problemText = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Something went wrong.';

  function load(st, refresh) {
    const p = (st.bp = st.bp || {});
    if (p.loaded || p.loading) return;
    p.loading = true;
    const opt = (cond, url) => (cond ? App.get(url).catch(() => null) : Promise.resolve(null));
    Promise.all([App.get('/api/admin/billing/subscription'), App.get('/api/admin/billing/plans'), opt(canDiscounts(), '/api/admin/billing/discounts'), opt(canDiscounts(), '/api/admin/billing/promo-codes'), opt(canDiscounts(), '/api/admin/billing/discount-approvals?state=pending'), opt(true, '/api/admin/billing/redemptions')])
      .then(([sub, plans, disc, codes, appr, red]) => { Object.assign(p, { sub, plans, disc, codes, appr, red, error: null }); })
      .catch((err) => { p.error = err; })
      .then(() => { p.loaded = true; p.loading = false; refresh(); });
  }

  // ---------- markup ----------

  function subscriptionHtml(p) {
    const s = p.sub && p.sub.subscription;
    const change = canChange();
    if (!s) {
      return UI.panel('Subscription', UI.empty('No subscription', 'This tenant is billed by usage alone, from its price book.', change ? UI.btn('Subscribe to a plan', { kind: 'primary', size: 'sm', attrs: 'data-bpsub' }) : ''), { attrs: 'data-bp="subscription"' });
    }
    const notes = []
      .concat(s.state === 'trialing' ? [UI.notice('<b>Trial.</b> The plan charges nothing until ' + esc(day(s.trialEnd)) + ', then renews as usual.', 'info')] : [])
      .concat(s.state === 'paused' ? [UI.notice('<b>Paused</b> since ' + esc(day(s.pausedAt)) + '. The plan charges nothing and includes no usage until it resumes; the rest of the period was credited.', 'warn')] : [])
      .concat(s.cancelAtPeriodEnd ? [UI.notice('<b>Ends on ' + esc(day(s.periodEnd)) + '.</b> After that the tenant is billed by usage alone.', 'warn', change ? UI.btn('Keep the subscription', { size: 'sm', attrs: 'data-bpkeep' }) : '')] : [])
      .concat(s.pendingChange ? [UI.notice('At renewal on ' + esc(day(s.pendingChange.at)) + ': ' + esc(s.pendingChange.planName || 'the plan') + ', ' + esc(String(s.pendingChange.seats)) + ' seats.', 'info', change ? UI.btn('Drop the change', { size: 'sm', attrs: 'data-bpunsched' }) : '')] : []);
    const actions = change
      ? UI.btn('Change plan or seats', { size: 'sm', attrs: 'data-bpchange' + (s.state === 'paused' ? ' disabled' : '') })
        + (s.state === 'active' ? UI.btn('Pause', { size: 'sm', kind: 'ghost', attrs: 'data-bppause' }) : '')
        + (s.state === 'paused' ? UI.btn('Resume', { size: 'sm', attrs: 'data-bpresume' }) : '')
        + (!s.cancelAtPeriodEnd ? UI.btn('Cancel at period end', { size: 'sm', kind: 'ghost', attrs: 'data-bpcancel' }) : '')
      : '';
    const hist = (p.sub.history || []).slice(0, 12);
    return UI.panel('Subscription', notes.join('')
      + UI.kv([
        ['Plan', '<b>' + esc(s.plan.name || s.plan.key || '') + '</b> <span class="muted">version ' + esc(String(s.plan.version)) + '</span>'],
        ['State', UI.pill(s.state)],
        ['Seats', esc(String(s.seats)) + ' <span class="muted">(' + esc(String(s.includedSeats)) + ' included)</span>'],
        ['Each cycle', esc(money(s.cycleAmountMinor, s.currency))],
        ['Cycle', esc(cycleText(s.cycle))],
        ['This period', esc(day(s.periodStart)) + ' to ' + esc(day(s.periodEnd - 1))]
      ], 3)
      + (actions ? '<div class="hstack wrap gap6">' + actions + '</div>' : '')
      + '<div class="eyebrow">History</div>'
      + UI.table(['When', 'What', 'State', { label: 'Seats', right: true }, { label: 'Prorated', right: true }], hist.map((e) => [esc(when(e.at)), esc(EVENT[e.kind] || e.kind), UI.pill(e.state), esc(String(e.seats)), e.detail && typeof e.detail.netMinor === 'number' ? esc(money(e.detail.netMinor, s.currency)) : '']), { clickable: false, minWidth: '560px', emptyTitle: 'No history', emptyText: '' }),
    { attrs: 'data-bp="subscription"' });
  }

  function priceText(v) {
    if (!v || !v.prices || !v.prices.length) return '';
    return v.prices.map((x) => money(x.priceMinor, x.currency) + ' a ' + monthsText(x.months) + (x.seatPriceMinor ? ', ' + money(x.seatPriceMinor, x.currency) + ' a seat over ' + x.includedSeats : '')).join('; ');
  }

  function plansHtml(p) {
    const list = (p.plans && p.plans.plans) || [];
    const manage = canPlatform();
    const me = App.me && App.me.user ? App.me.user.id : null;
    const rows = list.map((x) => {
      const pend = x.pending;
      const own = pend && pend.proposedBy === me;
      const acts = manage
        ? UI.btn('Details', { size: 'xs', kind: 'ghost', attrs: 'data-bpedit="' + esc(x.id) + '"' })
          + (!pend ? UI.btn('New prices', { size: 'xs', kind: 'ghost', attrs: 'data-bppropose="' + esc(x.id) + '"' }) : '')
          + (pend && !own ? UI.btn('Approve version ' + pend.version, { size: 'xs', attrs: 'data-bpapprove="' + esc(x.id) + ':' + pend.version + '"' }) + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-bpreject="' + esc(x.id) + ':' + pend.version + '"' }) : '')
          + (pend && own ? UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-bpreject="' + esc(x.id) + ':' + pend.version + '"' }) : '')
        : '';
      return ['<b>' + esc(x.name) + '</b> <span class="mono muted">' + esc(x.key) + '</span>' + (x.description ? '<div class="muted" style="font-size:12px">' + esc(x.description) + '</div>' : ''),
        esc(priceText(x.current)) || '<span class="muted">no approved prices</span>',
        UI.pill(x.visibility, x.visibility === 'visible' ? 'outline' : 'warn') + ' ' + UI.pill(x.state),
        (x.currentVersion ? 'v' + esc(String(x.currentVersion)) : '') + (pend ? ' ' + UI.pill('v' + pend.version + ' pending', 'warn') + (own ? ' <span class="muted" style="font-size:12px">yours; another platform admin approves it</span>' : '') : ''),
        acts];
    });
    return UI.panel('Plans', (manage ? '<div class="muted" style="font-size:12px">New plans and new prices take effect only when a second platform admin approves them. Subscribers move to new prices at their next renewal.</div>' : '')
      + UI.table(['Plan', 'Price', 'Shown to', 'Version', ''], rows, { clickable: false, minWidth: '760px', emptyTitle: 'No plans', emptyText: manage ? 'Create a plan to sell subscriptions.' : 'A platform admin keeps the plan catalogue.' }),
    { attrs: 'data-bp="plans"', actions: manage ? UI.btn('New plan', { size: 'sm', icon: 'plus', attrs: 'data-bpnew' }) : '' });
  }

  const ruleTerms = (r) => (r.kind === 'percent' || r.kind === 'commitment' ? (r.terms.percentPpm / 10000) + '%' + (r.kind === 'commitment' ? ' for ' + (r.terms.minMonths || 12) + '+ months' : '') : r.kind === 'amount' ? money(r.terms.amountMinor, r.currency || '') : r.kind === 'allowance' ? (r.terms.quantity || 0).toLocaleString() + ' ' + (METERS[r.terms.meter] || '') : r.kind);

  function discountsHtml(p) {
    if (!canDiscounts()) {
      if (!App.can('tenant:manage')) return '';
      const red = (p.red && p.red.redemptions) || [];
      return UI.panel('Promotion codes', '<div class="hstack wrap gap6">' + UI.input('', { attrs: 'data-bpcode aria-label="Promotion code" maxlength="40" style="width:200px"', placeholder: 'Code' }) + UI.btn('Redeem', { size: 'sm', attrs: 'data-bpredeem' }) + '</div>'
        + UI.table(['Redeemed', 'Discount'], red.map((x) => [esc(when(x.redeemedAt || x.createdAt)), esc(x.ruleName || x.ruleId || '')]), { clickable: false, emptyTitle: 'No codes redeemed', emptyText: 'A code applies to this tenant\'s statements while it is valid.' }), { attrs: 'data-bp="codes"' });
    }
    const rules = (p.disc && p.disc.rules) || [];
    const codes = (p.codes && p.codes.codes) || [];
    const appr = (p.appr && p.appr.approvals) || [];
    const me = App.me && App.me.user ? App.me.user.id : null;
    const name = (id) => { const r = rules.find((x) => x.id === id); return r ? r.name : id; };
    return UI.panel('Discounts and promotion codes',
      (appr.length ? '<div class="eyebrow">Waiting for a second admin</div>' + UI.table(['Discount', 'Change', 'Why', ''], appr.map((a) => [esc(name(a.ruleId)), esc(a.change), esc(a.reason || ''), a.proposedBy === me ? '<span class="muted">yours</span>' : UI.btn('Approve', { size: 'xs', attrs: 'data-bpdapprove="' + esc(a.id) + '"' }) + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-bpdreject="' + esc(a.id) + '"' })]), { clickable: false, minWidth: '560px' }) : '')
      + UI.table(['Discount', 'Source', 'Terms', 'Applies to', { label: 'Order', right: true }, 'State', ''], rules.map((r) => ['<b>' + esc(r.name) + '</b>', esc(r.source), esc(ruleTerms(r)), esc(r.scope + (r.scopeValue ? ' ' + r.scopeValue : '')), esc(String(r.stackOrder)), UI.pill(r.state), r.state === 'active' ? UI.btn('Retire', { size: 'xs', kind: 'ghost', attrs: 'data-bpdretire="' + esc(r.id) + '"' }) : '']), { clickable: false, minWidth: '760px', emptyTitle: 'No discounts', emptyText: 'Discounts are shown as their own lines on statements.' })
      + '<div class="eyebrow">Promotion codes</div>'
      + UI.table(['Code', 'Discount', { label: 'Redeemed', right: true }, 'Expires', 'State', ''], codes.map((c) => ['<span class="mono">' + esc(c.code) + '</span>', esc(name(c.ruleId)), esc(String(c.redemptions)) + (c.maxRedemptions ? ' of ' + esc(String(c.maxRedemptions)) : ''), esc(c.expiresAt ? day(Date.parse(c.expiresAt)) : 'never'), UI.pill(c.state), c.state === 'active' ? UI.btn('Retire', { size: 'xs', kind: 'ghost', attrs: 'data-bpcretire="' + esc(c.id) + '"' }) : '']), { clickable: false, minWidth: '640px', emptyTitle: 'No promotion codes', emptyText: 'A code redeems a promotion discount for one tenant.' }),
    { attrs: 'data-bp="discounts"', actions: UI.btn('New discount', { size: 'sm', icon: 'plus', attrs: 'data-bpdnew' }) + (rules.some((r) => r.source === 'promotion' && r.state === 'active') ? UI.btn('New code', { size: 'sm', attrs: 'data-bpcnew' }) : '') });
  }

  function html(st, refresh) {
    load(st, refresh);
    const p = st.bp || {};
    if (!p.loaded) return '<div class="muted" data-bp="loading">Loading plans and the subscription…</div>';
    if (p.error) return UI.problem('Plans and the subscription could not be loaded', problemText(p.error), p.error.problem && p.error.problem.trace_id);
    return '<div class="vstack gap12">' + subscriptionHtml(p) + plansHtml(p) + discountsHtml(p) + '</div>';
  }

  // ---------- dialogs ----------

  function versionFields(v, cur) {
    const prices = v && v.prices && v.prices.length ? v.prices : [{ currency: cur || 'USD', months: 1, priceMinor: 0, seatPriceMinor: 0, includedSeats: 1 }];
    const row = (x, i) => '<tr data-bprow="' + i + '"><td>' + UI.input(x.currency, { attrs: 'data-pf="currency" aria-label="Currency" maxlength="3" style="width:70px"' }) + '</td>'
      + '<td>' + UI.select([{ value: '1', label: 'Month' }, { value: '3', label: 'Quarter' }, { value: '12', label: 'Year' }].concat([1, 3, 12].indexOf(x.months) < 0 ? [{ value: String(x.months), label: x.months + ' months' }] : []), String(x.months), 'data-pf="months" aria-label="Cycle"') + '</td>'
      + '<td>' + UI.input(fromMinor(x.priceMinor, x.currency), { attrs: 'data-pf="price" aria-label="Price per cycle" inputmode="decimal" style="width:90px"' }) + '</td>'
      + '<td>' + UI.input(fromMinor(x.seatPriceMinor, x.currency), { attrs: 'data-pf="seat" aria-label="Price per extra seat" inputmode="decimal" style="width:90px"' }) + '</td>'
      + '<td>' + UI.input(String(x.includedSeats), { attrs: 'data-pf="incl" aria-label="Included seats" inputmode="numeric" style="width:70px"' }) + '</td>'
      + '<td>' + UI.iconbtn('x', 'Remove price', { cls: 'sm ghost', attrs: 'data-bprm="' + i + '"' }) + '</td></tr>';
    const allow = (v && v.allowances) || {};
    const ent = (v && v.entitlements) || {};
    return {
      html: '<div class="eyebrow">Prices</div><div class="tablewrap"><table class="dt"><thead><tr><th scope="col">Currency</th><th scope="col">Cycle</th><th scope="col">Price</th><th scope="col">Extra seat</th><th scope="col">Included seats</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody data-bprices>' + prices.map(row).join('') + '</tbody></table></div>'
        + UI.btn('Add a price', { size: 'sm', icon: 'plus', attrs: 'data-bpaddprice' })
        + '<div class="eyebrow">Included each month</div><div class="formgrid">' + Object.keys(METERS).map((m) => UI.field(METERS[m], UI.input(allow[m] != null ? String(allow[m]) : '', { attrs: 'data-allow="' + m + '" inputmode="numeric"', placeholder: 'none' }))).join('') + '</div>'
        + UI.field('Entitlements', UI.textarea(Object.keys(ent).map((k) => k + ' = ' + ent[k]).join('\n'), { attrs: 'data-bpent', rows: 3, placeholder: 'feature.export = true' }), 'One per line: a lower-case key, then a value (true, false, a number or text). For feature flags.'),
      mount(m) {
        const tbody = m.querySelector('[data-bprices]');
        const read = () => Array.prototype.slice.call(tbody.querySelectorAll('tr')).map((tr) => { const g = (k) => tr.querySelector('[data-pf="' + k + '"]').value.trim(); const c = g('currency').toUpperCase(); return { currency: c, months: Number(g('months')), priceMinor: toMinor(g('price'), c), seatPriceMinor: toMinor(g('seat'), c), includedSeats: Number(g('incl') || 0) }; });
        m.querySelector('[data-bpaddprice]').addEventListener('click', () => { const list = read(); list.push({ currency: list.length ? list[0].currency : 'USD', months: 12, priceMinor: 0, seatPriceMinor: 0, includedSeats: 1 }); tbody.innerHTML = list.map(row).join(''); });
        tbody.addEventListener('click', (e) => { const x = e.target.closest('[data-bprm]'); if (!x) return; const list = read(); list.splice(+x.dataset.bprm, 1); tbody.innerHTML = list.map(row).join(''); });
        return () => {
          const prices = read();
          if (!prices.length || prices.some((x) => !/^[A-Z]{3}$/.test(x.currency) || x.priceMinor == null || x.seatPriceMinor == null || !(x.includedSeats >= 0))) return { error: 'Each price needs a three-letter currency, amounts of zero or more and a number of included seats.' };
          const allowances = {};
          for (const k of Object.keys(METERS)) { const t = m.querySelector('[data-allow="' + k + '"]').value.trim(); if (!t) continue; const n = Number(t); if (!(n >= 0) || Math.floor(n) !== n) return { error: 'An allowance is a whole number of units.' }; allowances[k] = n; }
          const entitlements = {};
          for (const line of m.querySelector('[data-bpent]').value.split('\n').map((x) => x.trim()).filter(Boolean)) {
            const mm = /^([a-z][a-z0-9_.-]{0,63})\s*=\s*(.*)$/.exec(line);
            if (!mm) return { error: 'Write each entitlement as key = value, with a lower-case key.' };
            const raw = mm[2].trim();
            entitlements[mm[1]] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw;
          }
          return { prices, allowances, entitlements };
        };
      }
    };
  }

  function planModal(ctx, reload, plan) {
    const v = versionFields(null);
    ctx.modal({
      title: 'New plan', cls: 'wide',
      body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-bpname maxlength="100"' })) + UI.field('Key', UI.input('', { attrs: 'data-bpkey maxlength="64"', placeholder: 'team' }), 'Lower case letters, digits and dashes; it cannot change.')
        + UI.field('Shown to', UI.select([{ value: 'visible', label: 'Every tenant admin' }, { value: 'private', label: 'Platform admins only (assigned)' }], 'visible', 'data-bpvis')) + UI.field('Trial', UI.input('0', { attrs: 'data-bptrial inputmode="numeric"' }), 'Days, on a tenant\'s first subscription.') + '</div>'
        + UI.field('Description', UI.input('', { attrs: 'data-bpdesc maxlength="1000"' })) + v.html + '<div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Propose plan', { kind: 'primary', attrs: 'data-bpsave' }),
      onMount(m) {
        const collect = v.mount(m);
        m.querySelector('[data-bpsave]').addEventListener('click', async (e) => {
          const box = m.querySelector('[data-err]'); box.innerHTML = '';
          const ver = collect(); if (ver.error) { box.innerHTML = UI.notice(esc(ver.error), 'warn'); return; }
          const body = Object.assign({ key: m.querySelector('[data-bpkey]').value.trim(), name: m.querySelector('[data-bpname]').value.trim(), description: m.querySelector('[data-bpdesc]').value.trim() || null, visibility: m.querySelector('[data-bpvis]').value, trialDays: Number(m.querySelector('[data-bptrial]').value || 0) }, ver);
          if (!body.name || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(body.key)) { box.innerHTML = UI.notice('Give the plan a name and a key of lower-case letters, digits and dashes.', 'warn'); return; }
          e.target.disabled = true;
          try { await App.post('/api/admin/billing/plans', body); App.closeOverlay(); ctx.toast('Plan proposed. A second platform admin approves it before tenants can subscribe.', 'ok'); reload(); } catch (err) { e.target.disabled = false; box.innerHTML = UI.notice('<b>' + esc(problemText(err)) + '</b>', 'danger'); }
        });
      }
    });
    void plan;
  }

  function detailsModal(ctx, reload, plan) {
    ctx.modal({
      title: esc(plan.name),
      body: '<div class="formgrid">' + UI.field('Name', UI.input(plan.name, { attrs: 'data-bpname maxlength="100"' })) + UI.field('Shown to', UI.select([{ value: 'visible', label: 'Every tenant admin' }, { value: 'private', label: 'Platform admins only (assigned)' }], plan.visibility, 'data-bpvis'))
        + UI.field('State', UI.select([{ value: 'active', label: 'Active' }, { value: 'retired', label: 'Retired: no new subscriptions' }], plan.state, 'data-bpstate')) + UI.field('Trial', UI.input(String(plan.trialDays), { attrs: 'data-bptrial inputmode="numeric"' }), 'Days.') + '</div>'
        + UI.field('Description', UI.input(plan.description || '', { attrs: 'data-bpdesc maxlength="1000"' }))
        + '<div class="muted" style="font-size:12px">These change at once. Prices, allowances and entitlements change with New prices, under dual control.</div><div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-bpsave' }),
      onMount(m) {
        m.querySelector('[data-bpsave]').addEventListener('click', async (e) => {
          const box = m.querySelector('[data-err]');
          e.target.disabled = true;
          try { await App.patch('/api/admin/billing/plans/' + encodeURIComponent(plan.id), { name: m.querySelector('[data-bpname]').value.trim(), visibility: m.querySelector('[data-bpvis]').value, state: m.querySelector('[data-bpstate]').value, trialDays: Number(m.querySelector('[data-bptrial]').value || 0), description: m.querySelector('[data-bpdesc]').value.trim() || null }); App.closeOverlay(); ctx.toast('Plan saved. Audit entry written.', 'ok'); reload(); } catch (err) { e.target.disabled = false; box.innerHTML = UI.notice('<b>' + esc(problemText(err)) + '</b>', 'danger'); }
        });
      }
    });
  }

  function proposeModal(ctx, reload, plan) {
    const v = versionFields(plan.current);
    ctx.modal({
      title: 'New prices for ' + esc(plan.name), cls: 'wide',
      body: v.html + '<div class="muted" style="font-size:12px">The new version waits for a second platform admin. Subscribers move to it at their next renewal.</div><div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Propose version', { kind: 'primary', attrs: 'data-bpsave' }),
      onMount(m) {
        const collect = v.mount(m);
        m.querySelector('[data-bpsave]').addEventListener('click', async (e) => {
          const box = m.querySelector('[data-err]'); box.innerHTML = '';
          const ver = collect(); if (ver.error) { box.innerHTML = UI.notice(esc(ver.error), 'warn'); return; }
          e.target.disabled = true;
          try { await App.post('/api/admin/billing/plans/' + encodeURIComponent(plan.id) + '/versions', ver); App.closeOverlay(); ctx.toast('New prices proposed. A second platform admin approves them.', 'ok'); reload(); } catch (err) { e.target.disabled = false; box.innerHTML = UI.notice('<b>' + esc(problemText(err)) + '</b>', 'danger'); }
        });
      }
    });
  }

  function planOptions(p, cur, months) {
    return ((p.plans && p.plans.plans) || []).filter((x) => x.subscribable && x.current && x.current.prices.some((y) => (!cur || y.currency === cur) && (!months || y.months === months || y.months === 1)));
  }

  function subscribeModal(ctx, reload, p) {
    const plans = planOptions(p);
    if (!plans.length) { ctx.toast('No plan can be subscribed to yet.', 'warn'); return; }
    const curs = (x) => x.current.prices.map((y) => y.currency).filter((c, i, a) => a.indexOf(c) === i);
    ctx.modal({
      title: 'Subscribe to a plan',
      body: '<div class="formgrid">' + UI.field('Plan', UI.select(plans.map((x) => ({ value: x.id, label: x.name })), plans[0].id, 'data-bsplan'))
        + UI.field('Currency', UI.select(curs(plans[0]), curs(plans[0])[0], 'data-bscur'))
        + UI.field('Seats', UI.input('1', { attrs: 'data-bsseats inputmode="numeric"' }))
        + UI.field('Cycle', UI.select(Object.keys(CYCLE).map((k) => ({ value: k, label: CYCLE[k] })), 'monthly', 'data-bscycle'))
        + UI.field('Months', UI.input('6', { attrs: 'data-bsmonths inputmode="numeric"' }), 'For a custom cycle, 1 to 36.')
        + UI.field('Anchor day', UI.input(String(Math.min(28, new Date().getUTCDate())), { attrs: 'data-bsanchor inputmode="numeric"' }), 'Periods start on this day of the month, 1 to 28.') + '</div>'
        + '<div data-bsinfo class="muted" style="font-size:12px"></div><div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Subscribe', { kind: 'primary', attrs: 'data-bssave' }),
      onMount(m) {
        const info = () => { const x = plans.find((y) => y.id === m.querySelector('[data-bsplan]').value); m.querySelector('[data-bsinfo]').textContent = x ? priceText(x.current) + (x.trialDays ? '. A first subscription starts with a ' + x.trialDays + '-day trial.' : '.') : ''; };
        m.querySelector('[data-bsplan]').addEventListener('change', () => { const x = plans.find((y) => y.id === m.querySelector('[data-bsplan]').value); m.querySelector('[data-bscur]').innerHTML = curs(x).map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join(''); info(); });
        info();
        m.querySelector('[data-bssave]').addEventListener('click', async (e) => {
          const box = m.querySelector('[data-err]'); box.innerHTML = '';
          const kind = m.querySelector('[data-bscycle]').value;
          const body = { planId: m.querySelector('[data-bsplan]').value, currency: m.querySelector('[data-bscur]').value, seats: Number(m.querySelector('[data-bsseats]').value), cycle: { kind, anchorDay: Number(m.querySelector('[data-bsanchor]').value) } };
          if (kind === 'custom') body.cycle.months = Number(m.querySelector('[data-bsmonths]').value);
          if (!(body.seats >= 1) || !(body.cycle.anchorDay >= 1 && body.cycle.anchorDay <= 28)) { box.innerHTML = UI.notice('Seats are one or more; the anchor day is 1 to 28.', 'warn'); return; }
          e.target.disabled = true;
          try { await App.post('/api/admin/billing/subscription', body); App.closeOverlay(); ctx.toast('Subscribed. Audit entry written.', 'ok'); reload(); } catch (err) { e.target.disabled = false; box.innerHTML = UI.notice('<b>' + esc(problemText(err)) + '</b>', 'danger'); }
        });
      }
    });
  }

  function changeModal(ctx, reload, p) {
    const s = p.sub.subscription;
    const plans = planOptions(p, s.currency, s.cycle.months);
    const opts = plans.some((x) => x.id === s.plan.id) ? plans : [{ id: s.plan.id, name: s.plan.name }].concat(plans);
    ctx.modal({
      title: 'Change plan or seats',
      body: '<div class="formgrid">' + UI.field('Plan', UI.select(opts.map((x) => ({ value: x.id, label: x.name })), s.plan.id, 'data-bcplan')) + UI.field('Seats', UI.input(String(s.seats), { attrs: 'data-bcseats inputmode="numeric"' }))
        + UI.field('When', UI.select([{ value: 'now', label: 'Now, prorated' }, { value: 'renewal', label: 'At renewal, ' + day(s.periodEnd) }], 'now', 'data-bcwhen')) + '</div>'
        + UI.btn('Preview', { size: 'sm', attrs: 'data-bcpreview' }) + '<div data-bcout aria-live="polite"></div><div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Change', { kind: 'primary', attrs: 'data-bcsave' }),
      onMount(m) {
        const body = () => { const b = { when: m.querySelector('[data-bcwhen]').value }; const pl = m.querySelector('[data-bcplan]').value; const se = Number(m.querySelector('[data-bcseats]').value); if (pl !== s.plan.id) b.planId = pl; if (se !== s.seats) b.seats = se; return b; };
        const out = m.querySelector('[data-bcout]');
        const preview = async () => {
          const b = body(); out.innerHTML = '';
          if (b.planId === undefined && b.seats === undefined) { out.innerHTML = UI.notice('Choose another plan or number of seats.', 'warn'); return false; }
          try {
            const r = await App.post('/api/admin/billing/subscription/preview', b);
            out.innerHTML = UI.kv(r.when === 'now'
              ? [['Credit for the rest of the period', esc(money(r.creditMinor, s.currency))], ['Charge for the rest of the period', esc(money(r.chargeMinor, s.currency))], ['Due now', '<b>' + esc(money(r.netMinor, s.currency)) + '</b>'], ['Each cycle after', esc(money(r.nextCycleAmountMinor, s.currency))]]
              : [['Nothing changes until', esc(day(r.at))], ['Each cycle from then', '<b>' + esc(money(r.nextCycleAmountMinor, s.currency)) + '</b>']], 2)
              + '<div class="muted" style="font-size:12px">Prorated by the seconds left in the period, each amount rounded to the nearest ' + (digits(s.currency) ? 'cent' : 'unit') + ', halves away from zero.</div>';
            return true;
          } catch (err) { out.innerHTML = UI.notice('<b>' + esc(problemText(err)) + '</b>', 'danger'); return false; }
        };
        m.querySelector('[data-bcpreview]').addEventListener('click', preview);
        m.querySelector('[data-bcsave]').addEventListener('click', async (e) => {
          const box = m.querySelector('[data-err]'); box.innerHTML = '';
          const b = body();
          if (b.planId === undefined && b.seats === undefined) { box.innerHTML = UI.notice('Choose another plan or number of seats.', 'warn'); return; }
          if (!(Number(m.querySelector('[data-bcseats]').value) >= 1)) { box.innerHTML = UI.notice('Seats are one or more.', 'warn'); return; }
          e.target.disabled = true;
          try { await App.patch('/api/admin/billing/subscription', b); App.closeOverlay(); ctx.toast(b.when === 'now' ? 'Subscription changed. Audit entry written.' : 'Change scheduled for renewal. Audit entry written.', 'ok'); reload(); } catch (err) { e.target.disabled = false; box.innerHTML = UI.notice('<b>' + esc(problemText(err)) + '</b>', 'danger'); }
        });
      }
    });
  }

  function discountModal(ctx, reload, st) {
    ctx.modal({
      title: 'New discount',
      body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-dname maxlength="100"' })) + UI.field('Source', UI.select([{ value: 'rule', label: 'A rule' }, { value: 'promotion', label: 'A promotion (with codes)' }, { value: 'negotiated', label: 'Negotiated for this tenant' }], 'rule', 'data-dsource'))
        + UI.field('Kind', UI.select([{ value: 'percent', label: 'Percentage off' }, { value: 'amount', label: 'Fixed amount off' }], 'percent', 'data-dkind')) + UI.field('Value', UI.input('10', { attrs: 'data-dvalue inputmode="decimal"' }), 'A percentage, or an amount in the currency.')
        + UI.field('Currency', UI.input('USD', { attrs: 'data-dcur maxlength="3"' }), 'For a fixed amount.') + UI.field('Applies to', UI.select([{ value: 'statement', label: 'The whole statement' }, { value: 'plan', label: 'The plan' }, { value: 'seats', label: 'Seats' }], 'statement', 'data-dscope'))
        + UI.field('Stacking order', UI.input('100', { attrs: 'data-dorder inputmode="numeric"' }), 'Lower applies first.') + UI.field('Valid until', UI.input('', { type: 'date', attrs: 'data-dto' }), 'Empty: no end.') + '</div><div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create discount', { kind: 'primary', attrs: 'data-dsave' }),
      onMount(m) {
        m.querySelector('[data-dsave]').addEventListener('click', async (e) => {
          const box = m.querySelector('[data-err]'); box.innerHTML = '';
          const g = (k) => m.querySelector('[data-' + k + ']').value.trim();
          const kind = g('dkind'); const cur = g('dcur').toUpperCase(); const val = Number(g('dvalue'));
          if (!g('dname') || !(val > 0) || (kind === 'percent' && val > 100) || (kind === 'amount' && !/^[A-Z]{3}$/.test(cur))) { box.innerHTML = UI.notice('Give a name, a value above zero (at most 100 for a percentage) and a currency for a fixed amount.', 'warn'); return; }
          const body = { name: g('dname'), source: g('dsource'), scope: g('dscope'), kind, terms: kind === 'percent' ? { percentPpm: Math.round(val * 10000) } : { amountMinor: toMinor(String(val), cur) }, currency: kind === 'amount' ? cur : null, stackOrder: Number(g('dorder') || 100), validTo: g('dto') || null };
          if (body.source === 'negotiated') body.target = { kind: 'tenants', ids: [st.bill && st.bill.settings ? st.bill.settings.tenantId : App.me.tenant.id] };
          e.target.disabled = true;
          try { const r = await App.post('/api/admin/billing/discounts', body); App.closeOverlay(); ctx.toast(r.needsApproval ? 'Discount proposed: ' + esc(r.reason || 'it needs a second admin') + '.' : 'Discount created. Audit entry written.', 'ok'); reload(); } catch (err) { e.target.disabled = false; box.innerHTML = UI.notice('<b>' + esc(problemText(err)) + '</b>', 'danger'); }
        });
      }
    });
  }

  function codeModal(ctx, reload, p) {
    const rules = ((p.disc && p.disc.rules) || []).filter((r) => r.source === 'promotion' && r.state === 'active');
    ctx.modal({
      title: 'New promotion code',
      body: '<div class="formgrid">' + UI.field('Discount', UI.select(rules.map((r) => ({ value: r.id, label: r.name })), rules[0] ? rules[0].id : '', 'data-crule')) + UI.field('Code', UI.input('', { attrs: 'data-ccode maxlength="40"', placeholder: 'Generated when empty' }))
        + UI.field('Expires', UI.input('', { type: 'date', attrs: 'data-cexp' }), 'Empty: never.') + UI.field('Redemptions', UI.input('', { attrs: 'data-cmax inputmode="numeric"', placeholder: 'No limit' })) + '</div><div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create code', { kind: 'primary', attrs: 'data-csave' }),
      onMount(m) {
        m.querySelector('[data-csave]').addEventListener('click', async (e) => {
          const box = m.querySelector('[data-err]'); box.innerHTML = '';
          const g = (k) => m.querySelector('[data-' + k + ']').value.trim();
          const body = { ruleId: g('crule'), code: g('ccode') || null, expiresAt: g('cexp') || null, maxRedemptions: g('cmax') ? Number(g('cmax')) : null };
          if (body.code && !/^[A-Za-z0-9-]{4,40}$/.test(body.code)) { box.innerHTML = UI.notice('A code is 4 to 40 letters, digits or dashes.', 'warn'); return; }
          e.target.disabled = true;
          try { const c = await App.post('/api/admin/billing/promo-codes', body); App.closeOverlay(); ctx.toast('Code ' + esc(c.code) + ' created.', 'ok'); reload(); } catch (err) { e.target.disabled = false; box.innerHTML = UI.notice('<b>' + esc(problemText(err)) + '</b>', 'danger'); }
        });
      }
    });
  }

  // ---------- events ----------

  function wire(st, ctx, refresh) {
    const p = st.bp || {};
    const reload = () => { p.loaded = false; refresh(); };
    const planOf = (id) => ((p.plans && p.plans.plans) || []).find((x) => x.id === id);
    const act = async (opts, url, method, body, done) => {
      const ok = await ctx.confirm(opts);
      if (!ok) return;
      try { await App[method](url, body); ctx.toast(done, 'ok'); reload(); } catch (err) { App.fail(err, opts.title); }
    };
    ctx.on('click', '[data-bpsub]', () => subscribeModal(ctx, reload, p));
    ctx.on('click', '[data-bpchange]', () => changeModal(ctx, reload, p));
    ctx.on('click', '[data-bpcancel]', () => act({ title: 'Cancel at the end of this period?', tone: 'danger', body: '<p class="fg2" style="margin:0">The plan stays in force until ' + esc(day(p.sub.subscription.periodEnd)) + '; after that the tenant is billed by usage alone. You can keep it until then.</p>', ok: 'Cancel at period end' }, '/api/admin/billing/subscription/cancel', 'post', { when: 'period-end' }, 'The subscription ends at the end of the period. Audit entry written.'));
    ctx.on('click', '[data-bpkeep]', () => act({ title: 'Keep the subscription?', body: '<p class="fg2" style="margin:0">It renews as usual at the end of the period.</p>', ok: 'Keep it' }, '/api/admin/billing/subscription/keep', 'post', {}, 'The subscription renews as usual.'));
    ctx.on('click', '[data-bppause]', () => act({ title: 'Pause the subscription?', tone: 'danger', body: '<p class="fg2" style="margin:0">The plan stops charging and includes no usage until you resume it; the rest of this period is credited. Usage while paused is priced by the price book.</p>', ok: 'Pause' }, '/api/admin/billing/subscription/pause', 'post', {}, 'Subscription paused. Audit entry written.'));
    ctx.on('click', '[data-bpresume]', () => act({ title: 'Resume the subscription?', body: '<p class="fg2" style="margin:0">The plan charges again for what is left of this period.</p>', ok: 'Resume' }, '/api/admin/billing/subscription/resume', 'post', {}, 'Subscription resumed. Audit entry written.'));
    ctx.on('click', '[data-bpunsched]', () => act({ title: 'Drop the change scheduled for renewal?', body: '<p class="fg2" style="margin:0">The subscription renews on its current plan and seats.</p>', ok: 'Drop it' }, '/api/admin/billing/subscription/scheduled-change', 'del', undefined, 'Scheduled change dropped.'));
    ctx.on('click', '[data-bpnew]', () => planModal(ctx, reload));
    ctx.on('click', '[data-bpedit]', (e, t) => { const x = planOf(t.dataset.bpedit); if (x) detailsModal(ctx, reload, x); });
    ctx.on('click', '[data-bppropose]', (e, t) => { const x = planOf(t.dataset.bppropose); if (x) proposeModal(ctx, reload, x); });
    ctx.on('click', '[data-bpapprove]', (e, t) => {
      const parts = t.dataset.bpapprove.split(':'); const x = planOf(parts[0]); if (!x || !x.pending) return;
      act({ title: 'Approve version ' + parts[1] + ' of ' + x.name + '?', body: '<p class="fg2" style="margin:0">' + esc(priceText(x.pending)) + '</p><p class="fg2">It takes effect now for new subscriptions; subscribers move to it at their next renewal.</p>', ok: 'Approve' }, '/api/admin/billing/plans/' + encodeURIComponent(parts[0]) + '/versions/' + parts[1] + '/approve', 'post', {}, 'Version approved. Audit entry written.');
    });
    ctx.on('click', '[data-bpreject]', (e, t) => {
      const parts = t.dataset.bpreject.split(':');
      act({ title: 'Set version ' + parts[1] + ' aside?', tone: 'danger', body: '<p class="fg2" style="margin:0">The plan keeps the prices in force now.</p>', ok: 'Set aside' }, '/api/admin/billing/plans/' + encodeURIComponent(parts[0]) + '/versions/' + parts[1] + '/reject', 'post', {}, 'Version set aside. Audit entry written.');
    });
    ctx.on('click', '[data-bpdnew]', () => discountModal(ctx, reload, st));
    ctx.on('click', '[data-bpcnew]', () => codeModal(ctx, reload, p));
    ctx.on('click', '[data-bpdretire]', (e, t) => act({ title: 'Retire this discount?', tone: 'danger', body: '<p class="fg2" style="margin:0">Statements computed from now on leave it out.</p>', ok: 'Retire' }, '/api/admin/billing/discounts/' + encodeURIComponent(t.dataset.bpdretire), 'patch', { state: 'retired' }, 'Discount retired.'));
    ctx.on('click', '[data-bpcretire]', (e, t) => act({ title: 'Retire this code?', tone: 'danger', body: '<p class="fg2" style="margin:0">It can no longer be redeemed; redemptions made stand.</p>', ok: 'Retire' }, '/api/admin/billing/promo-codes/' + encodeURIComponent(t.dataset.bpcretire), 'patch', { state: 'retired' }, 'Code retired.'));
    ctx.on('click', '[data-bpdapprove]', (e, t) => act({ title: 'Approve this discount?', ok: 'Approve' }, '/api/admin/billing/discount-approvals/' + encodeURIComponent(t.dataset.bpdapprove) + '/approve', 'post', {}, 'Discount approved.'));
    ctx.on('click', '[data-bpdreject]', (e, t) => act({ title: 'Reject this discount?', tone: 'danger', ok: 'Reject' }, '/api/admin/billing/discount-approvals/' + encodeURIComponent(t.dataset.bpdreject) + '/reject', 'post', {}, 'Discount rejected.'));
    ctx.on('click', '[data-bpredeem]', async () => {
      const i = ctx.$('[data-bpcode]'); const code = i ? i.value.trim() : '';
      if (!/^[A-Za-z0-9-]{4,40}$/.test(code)) { ctx.toast('A code is 4 to 40 letters, digits or dashes.', 'warn'); return; }
      try { const r = await App.post('/api/admin/billing/promo-codes/redeem', { code }); ctx.toast(esc(r.rule.name) + ' applies to this tenant.', 'ok'); reload(); } catch (err) { App.fail(err, 'The code did not work'); }
    });
  }

  App.BillingPlans = { html, wire };
})();
