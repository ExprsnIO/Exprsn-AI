(function () {
  const { UI, esc, DATA } = App;

  const ACCOUNTS0 = [
    { id: 'gitlab', system: 'GitLab on-prem', scopes: 'read_api, write_repository', last: 'today 11:40', state: 'connected', tools: 'gitlab.create_mr, gitlab.read_file', vault: 'vault/users/mokafor/gitlab' },
    { id: 'jira', system: 'Jira internal', scopes: 'read, write:issue', last: 'today 14:02', state: 'connected', tools: 'jira-internal.create_issue, jira-internal.search', vault: 'vault/users/mokafor/jira' },
    { id: 'erp', system: 'ERP', scopes: 'ledger:read, cards:read', last: '', state: 'not connected', tools: 'ledger.query, cards.query', vault: 'vault/users/mokafor/erp' }
  ];
  const KEYS0 = [
    { id: 'k1', name: 'notebook-laptop', scopes: 'inference:invoke', models: 'analyst, fast', expires: '18 Dec 2026', last: '1 h ago', state: 'active', prefix: 'exai_k1_7f3a' },
    { id: 'k2', name: 'close-scripts', scopes: 'chat:write context:read', models: 'any allowed', expires: 'expired 1 Sep', last: '20 d ago', state: 'expired', prefix: 'exai_k2_0c91', gone: '1 Oct' }
  ];
  const SESSIONS0 = [
    { id: 's1', client: 'This browser', how: 'Kerberos SSO', zone: 'office', started: 'today 08:52', last: 'now', current: true },
    { id: 's2', client: 'exprsn-cli on build-03', how: 'device code', zone: 'build', started: '2 d ago', last: '35 min ago' },
    { id: 's3', client: 'Firefox on laptop-mo', how: 'LDAP password and passkey', zone: 'vpn', started: 'Mon 19:10', last: 'Mon 21:44' }
  ];
  const OWN_SCOPES = ['chat:read', 'chat:write', 'inference:invoke', 'context:read', 'context:write', 'images:generate', 'tools:invoke', 'agents:run', 'models:read'];
  // 1.4.0 identity gaps (B-1802, B-1803, B-1806, B-1807): the account's own verification, trusted devices, factors and DID
  const DEVICES0 = [{ id: 'd1', browser: 'Firefox on laptop-mo', createdAt: '2 Sep 2026', expiresAt: '2 Oct 2026', current: true }, { id: 'd2', browser: 'Safari on iPhone', createdAt: '11 Sep 2026', expiresAt: '11 Oct 2026' }];
  const FACTORS0 = [{ id: 'totp', kind: 'Authenticator app (TOTP)', label: 'Phone', added: '3 Feb 2026', last: 'today 08:52' }, { id: 'pk1', kind: 'Passkey', label: 'laptop-mo Touch ID', added: '14 Jun 2026', last: 'Mon 19:10' }];
  const ATPROTO0 = { did: 'did:plc:7iza6de2dwap2sbkpav7c6c6', handle: 'mara.northwind.social', verified: true, proof: 'profile', pds: 'https://pds.northwind.social', handleCheckedAt: 'today 06:00', verifiedAt: '4 Aug 2026' };
  // 1.5.0 (B-3415): app passwords for DAV clients, per device, DAV-only scopes; creating one needs a fresh second factor.
  const DAV_HOST = 'https://ai.northwind.local';
  const DAV_URLS = [['Server (any client)', DAV_HOST + '/dav/', 'Apple Calendar and Contacts, DAVx5 and Thunderbird can also start from the host name alone.'], ['CalDAV discovery', DAV_HOST + '/.well-known/caldav', 'Calendars and the events of your groups.'], ['CardDAV discovery', DAV_HOST + '/.well-known/carddav', 'The directory and your own address books.'], ['WebDAV', DAV_HOST + '/dav/', 'The file store answers here from B-32 (Sprint 34).']];
  const DAV_SCOPES = [['caldav', 'CalDAV', 'calendars and group events'], ['carddav', 'CardDAV', 'contacts'], ['webdav', 'WebDAV', 'files, from B-32']];
  const APPPW0 = [
    { id: 'a1', name: 'iPhone 17', scopes: ['caldav', 'carddav'], created: '4 Oct 2026', last: '12 min ago', lastFrom: '10.20.4.17, iOS/27.0 dataaccessd', expires: 'never', state: 'active', prefix: 'exai_d1_3f9a0c21b7e4' },
    { id: 'a2', name: 'Work Mac', scopes: ['caldav'], created: '5 Oct 2026', last: 'today 09:02', lastFrom: '10.20.1.33, macOS/27.0 CalendarAgent', expires: '3 Jan 2027', state: 'active', prefix: 'exai_d1_8d02e6b41a9f' },
    { id: 'a3', name: 'Old Android', scopes: ['caldav', 'carddav'], created: '2 Sep 2026', last: '20 Sep 2026', lastFrom: '10.20.9.4, DAVx5/4.5', expires: 'never', state: 'revoked', prefix: 'exai_d1_c71b5e09d3a2', revokedOn: '21 Sep 2026' }
  ];
  const NOTIFS = [['jobs', 'Finished jobs and workflow runs', true], ['approvals', 'Approvals waiting for me', true], ['flags', 'New flags in my queues', true], ['quota', 'Quota warnings', false]];

  const applyContrast = (mode) => {
    const r = document.documentElement.style;
    if (mode === 'AAA') { r.setProperty('--muted', 'var(--fg2)'); r.setProperty('--line', 'var(--muted)'); r.setProperty('--faint', 'var(--muted)'); r.setProperty('--shadow', 'none'); }
    else { r.removeProperty('--muted'); r.removeProperty('--line'); r.removeProperty('--faint'); r.removeProperty('--shadow'); }
  };

  App.register({
    id: 'settings', title: 'Settings', summary: 'Profile, public profile and status, appearance, notifications, security (email, factors, trusted devices), app passwords for DAV clients, connected accounts, API keys, sessions, AT-Protocol account', crumb: ['Settings'],
    commands: [{ label: 'Create an API key', sub: 'Settings', run(app) { app.stateFor('settings').openCreate = true; app.render(); } }],
    states: [
      { title: 'Key revealed once', tone: 'warn', text: 'The new key is shown once with a copy action. Afterwards only its name, scopes and dates remain.', apply(ctx) { const st = ctx.state; st.keys = st.keys || KEYS0.map((k) => Object.assign({}, k)); if (!st.keys.some((k) => k.id === 'k3')) st.keys.unshift({ id: 'k3', name: 'notebook-desk', scopes: 'inference:invoke chat:read', models: 'analyst', expires: '19 Mar 2027', last: 'never', state: 'active', prefix: 'exai_k3_4d2e' }); st.revealed = { name: 'notebook-desk', key: 'exai_k3_4d2e9b1f7c0a5e83d6f2b4a19c7e0d5f' }; ctx.rerender(); } },
      { title: 'Re-consent needed', tone: 'warn', text: 'GitLab revoked the grant. The row shows reconnect and tools that depend on it are paused.', apply(ctx) { const st = ctx.state; st.accounts = st.accounts || ACCOUNTS0.map((a) => Object.assign({}, a)); st.accounts.find((a) => a.id === 'gitlab').state = 're-consent needed'; ctx.rerender(); } },
      { title: 'Key expired', tone: 'neutral', text: 'Expired keys stay listed for 30 days for audit, then disappear.', apply(ctx) { ctx.state.expiredNote = true; ctx.rerender(); } },
      { title: 'Trusted devices forgotten', tone: 'neutral', text: 'Forgetting every trusted device makes the next sign-in from each browser ask for the second factor again. Audited as auth.trusted_device.removed.', apply(ctx) { ctx.state.devices = []; ctx.rerender(); ctx.toast('2 trusted devices forgotten. Audit entry written.', 'ok'); } },
      { title: 'DID challenge pending', tone: 'info', text: 'A claim issued a challenge token, shown once. Until the profile description contains it, Verify answers 409 and the binding is unverified.', apply(ctx) { ctx.state.atproto = { did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', handle: 'tomasz.bsky.social', verified: false, proof: null, pds: 'https://morel.us-east.host.bsky.network', challengePending: true, challengeExpiresAt: '20 Sep 2026, 14:02', token: 'exprsn-ai-verify-9f3c1a7e4b2d6c0f8a5e7d1b3c9f2a4e' }; ctx.rerender(); } },
      { title: 'Email factor added', tone: 'ok', text: 'An email one-time code is a second factor that admin roles may use (the Sprint 28 decision). Codes work once, for the session they were sent for.', apply(ctx) { const st = ctx.state; st.factors = st.factors || FACTORS0.map((f) => Object.assign({}, f)); if (!st.factors.some((f) => f.id === 'email')) st.factors.push({ id: 'email', kind: 'Email one-time code', label: 'm…r@northwind.local', added: 'just now', last: 'never' }); ctx.rerender(); } },
      { title: 'Address not verified', tone: 'warn', text: 'The tenant requires verified addresses. Until the link is redeemed, password sign-in refuses with email_unverified.', apply(ctx) { ctx.state.emailVerified = false; ctx.rerender(); } },
      { title: 'App password shown once', tone: 'warn', text: 'A new app password is shown once with the username and the server address to type into the client. Afterwards only its name, prefix, scopes and dates remain.', apply(ctx) { const st = ctx.state; st.apppw = st.apppw || APPPW0.map((a) => Object.assign({}, a)); if (!st.apppw.some((a) => a.id === 'a4')) st.apppw.unshift({ id: 'a4', name: 'iPad', scopes: ['caldav', 'carddav'], created: 'just now', last: 'never', lastFrom: '', expires: 'never', state: 'active', prefix: 'exai_d1_5b7e21c90f4d' }); st.davRevealed = { name: 'iPad', password: 'exai_d1_5b7e21c90f4d_q8Zr2VbX0kLm4TnYw6PcJh1sGd9FeA3uRoK7iE5xNtM' }; ctx.rerender(); } },
      { title: 'Step-up for an app password', tone: 'info', text: 'The second factor was confirmed more than 5 minutes ago. Creating an app password asks for an authenticator code or a passkey first; the password alone does not count (the owner decision of 5 October).', apply(ctx) { ctx.state.davFresh = false; ctx.state.openDavStepUp = true; ctx.rerender(); } },
      { title: 'Revoked app password refused', tone: 'danger', text: 'Revoking stops the password at once: the next DAV request from that device gets 401 with a Basic challenge, and the device asks for a new password.', apply(ctx) { const st = ctx.state; st.apppw = st.apppw || APPPW0.map((a) => Object.assign({}, a)); const w = st.apppw.find((a) => a.id === 'a2'); w.state = 'revoked'; w.revokedOn = 'just now'; st.davRefused = w.name; ctx.rerender(); } },
      // Sprint 34 (B-5801, B-5802): the public profile and the status.
      { title: 'Picture in quarantine', tone: 'info', text: 'A new picture is stored in the file store of your current workspace and scanned like any upload. Until the scan passes, everyone still sees the previous picture or your initials.', apply(ctx) { ctx.state.avatar = 'quarantined'; ctx.rerender(); } },
      { title: 'Picture refused by the scan', tone: 'danger', text: 'The picture failed the scan (malware, or bytes that are not an image). It is never shown; upload another one.', apply(ctx) { ctx.state.avatar = 'rejected'; ctx.rerender(); } },
      { title: 'Bio blocked by a guardrail', tone: 'danger', text: 'Pronouns and the bio are screened at user-input like a post. A blocking rule refuses the change with 422 and the old text stays.', apply(ctx) { ctx.state.bioProblem = true; ctx.rerender(); } },
      { title: 'Status set to busy', tone: 'ok', text: 'Busy is published at once over the socket: people who share a workspace with you see it within five seconds, people in a block with you never do.', apply(ctx) { ctx.state.status = 'busy'; ctx.rerender(); ctx.toast('Status: busy. Audited presence.status.updated.', 'ok'); } },
      { title: 'AAA mode', tone: 'info', text: 'Switching to AAA previews the change immediately and persists per user.', apply(ctx) { ctx.state.contrast = 'AAA'; applyContrast('AAA'); ctx.rerender(); ctx.toast('AAA contrast on. Saved to your profile.', 'ok'); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.accounts = st.accounts || ACCOUNTS0.map((a) => Object.assign({}, a));
      st.keys = st.keys || KEYS0.map((k) => Object.assign({}, k));
      st.sessions = st.sessions || SESSIONS0.map((s) => Object.assign({}, s));
      st.notifs = st.notifs || NOTIFS.reduce((o, n) => { o[n[0]] = n[2]; return o; }, {});
      st.contrast = st.contrast || 'AA'; st.language = st.language || 'English (UK)';
      st.devices = st.devices || DEVICES0.map((d) => Object.assign({}, d)); st.factors = st.factors || FACTORS0.map((f) => Object.assign({}, f)); st.emailVerified = st.emailVerified == null ? true : st.emailVerified;
      st.apppw = st.apppw || APPPW0.map((a) => Object.assign({}, a)); if (st.davFresh == null) st.davFresh = true;
      if (st.atproto === undefined) st.atproto = Object.assign({}, ATPROTO0);
      if (ctx.params.atproto === 'linked') { st.atproto = Object.assign({}, ATPROTO0, { proof: 'oauth', verifiedAt: 'just now' }); st.linkedNote = true; delete ctx.params.atproto; }
      if (ctx.params.tab === 'keys') { st.openCreate = true; delete ctx.params.tab; }
      const theme = App.state.theme === 'dark' ? 'Dark' : App.state.theme === 'light' ? 'Light' : 'Follow system';
      const u = DATA.user;

      const profile = UI.panel('Profile', UI.kv([['Name', esc(u.name)], ['Directory account', '<span class="mono">' + esc(u.username) + '</span>'], ['Clearance', UI.label(u.clearance, { sm: true })], ['Roles', esc(u.roles.map((r) => r.toLowerCase()).join(', '))]], 2)
        + '<div class="muted" style="font-size:12px">Name, account, clearance and roles come from OpenLDAP group mappings and cannot be edited here. Ask an identity admin to change them.</div>', { actions: UI.btn('Identity', { kind: 'ghost', size: 'sm', attrs: 'data-goidentity' }) });

      // B-5801: what others see of you, beyond what the user store gives.
      st.pronouns = st.pronouns == null ? 'she/her' : st.pronouns; st.bio = st.bio == null ? 'Finance Ops lead. Board pack, close calendar, and the Q3 flash.' : st.bio;
      st.plabel = st.plabel || 'internal'; st.pws = st.pws || 'all'; st.avatar = st.avatar || 'ready'; st.status = st.status || 'auto';
      const pic = st.avatar === 'ready' ? '<span class="settings-avatar pic" role="img" aria-label="Your profile picture">' + UI.icon('images', 22) + '</span>' : '<span class="settings-avatar" aria-hidden="true">' + esc(u.initials || 'MO') + '</span>';
      const picState = st.avatar === 'quarantined' ? UI.notice('<b>Scanning your new picture.</b> profile-picture.png is in the file store of Finance Ops and goes through its quarantine (type from the bytes, ClamAV). Until it passes, people see your initials.', 'info')
        : st.avatar === 'rejected' ? UI.notice('<b>Picture refused by the scan.</b> Malware detected: Eicar-Test-Signature. It is never shown; upload another picture.', 'danger', UI.btn('Upload another', { size: 'sm', attrs: 'data-upavatar' })) : '';
      const publicProfile = UI.panel('Public profile', '<div class="hstack" style="gap:12px;align-items:center">' + pic + '<div class="vstack" style="gap:6px">' + '<div class="hstack wrap gap6">' + UI.btn(st.avatar === 'none' ? 'Upload a picture' : 'Change picture', { size: 'sm', icon: 'upload', attrs: 'data-upavatar' }) + (st.avatar !== 'none' ? UI.btn('Remove', { size: 'sm', kind: 'ghost', attrs: 'data-rmavatar' }) : '') + '</div><span class="muted" style="font-size:12px">PNG, JPEG, WebP or GIF, at most 2 MiB. Kept in the file store and scanned before anyone sees it.</span></div></div>'
        + picState
        + '<div class="formgrid" style="--cols:2">' + UI.field('Pronouns', UI.input(st.pronouns, { attrs: 'data-pron maxlength="40"', placeholder: 'she/her' })) + UI.field('Label', UI.select(['public', 'internal', 'confidential'], st.plabel, 'data-plabel'), 'People below it see your name only.') + '</div>'
        + UI.field('Bio', UI.textarea(st.bio, { attrs: 'data-bio maxlength="500"', rows: 3 }), 'Up to 500 characters. Pronouns and the bio are screened at user-input like a post.')
        + (st.bioProblem ? UI.problem('Bio not saved (422, step guardrails)', 'The rule "Payment requests" blocked the text. Your previous bio is unchanged.', '5c1e9a2f7b3d4e6a8c0f1b2d3e4f5a6b') : '')
        + UI.field('Shown in', UI.select([{ value: 'all', label: 'Every workspace I share with them' }, { value: 'Finance Ops', label: 'Finance Ops only' }, { value: 'People Ops', label: 'People Ops only' }], st.pws, 'data-pws'), 'Outside these, people who share a workspace with you see your name only.')
        + '<div class="hstack">' + UI.btn('Save profile', { kind: 'primary', size: 'sm', attrs: 'data-saveprofile' }) + '<span class="grow"></span>' + UI.btn('See how others see you', { kind: 'ghost', size: 'sm', attrs: 'data-goperson' }) + '</div>');

      // B-5802: the status.
      const statusPanel = UI.panel('Status', UI.seg([{ id: 'auto', label: 'Automatic' }, { id: 'available', label: 'Available' }, { id: 'away', label: 'Away' }, { id: 'busy', label: 'Busy' }, { id: 'offline', label: 'Appear offline' }], st.status, 'data-status aria-label="Status"')
        + '<div class="hstack gap6" style="margin-top:4px">Others see ' + UI.pill(st.status === 'auto' ? 'available' : st.status, { available: 'ok', away: 'warn', busy: 'danger', offline: 'outline', auto: 'ok' }[st.status]) + '</div>'
        + '<span class="muted" style="font-size:12px">Automatic is available while you are connected, away after five minutes without input or while the console is hidden, offline when you close it. People in a block with you never see your status.</span>');

      const appearance = UI.panel('Appearance', '<div class="formgrid" style="--cols:3">' + UI.field('Theme', UI.select(['Follow system', 'Light', 'Dark'], theme, 'data-theme')) + UI.field('Contrast', UI.select(['AA (default)', 'AAA'], st.contrast === 'AAA' ? 'AAA' : 'AA (default)', 'data-contrast')) + UI.field('Language', UI.select(['English (UK)', 'English (US)', 'Deutsch', 'Français'], st.language, 'data-language')) + '</div>'
        + '<span class="muted" style="font-size:12px">AAA mode raises contrast and removes glass surfaces.</span>'
        + (st.contrast === 'AAA' ? UI.notice('<b>AAA contrast is on.</b> Muted text, borders and shadows now use the stronger tokens. Saved to your profile and applied on every device you sign in from.', 'info') : ''));

      const notifs = UI.panel('Notifications', '<div class="vstack gap6">' + NOTIFS.map((n) => UI.check(n[1], st.notifs[n[0]], 'data-notif="' + n[0] + '"')).join('') + '</div>'
        + '<span class="muted" style="font-size:12px">Delivered in the console over /ws' + (st.notifs.jobs || st.notifs.approvals ? ', and by email for approvals where the tenant allows it' : '') + '.</span>');

      const acctRows = st.accounts.map((a) => {
        const connected = a.state === 'connected';
        const reconsent = a.state === 're-consent needed';
        const scopes = connected || reconsent ? '<span class="mono">' + esc(a.scopes) + '</span>' : '<span class="muted" style="font-size:12px">not connected</span>';
        const action = connected ? UI.btn('Disconnect', { kind: 'ghost', size: 'sm', attrs: 'data-disconnect="' + a.id + '"' }) : reconsent ? UI.pill('re-consent needed', 'warn') + ' ' + UI.btn('Reconnect', { kind: 'primary', size: 'sm', attrs: 'data-connect="' + a.id + '"' }) : UI.btn('Connect', { size: 'sm', attrs: 'data-connect="' + a.id + '"' });
        return { cells: [esc(a.system), scopes, connected ? esc(a.last) : reconsent ? '<span style="color:var(--warn-fg)">grant revoked ' + esc(a.last.replace('today', 'today')) + '</span>' : '', '<span class="hstack gap6" style="justify-content:flex-end">' + action + '</span>'], attrs: 'data-account="' + a.id + '"' };
      });
      const reconsent = st.accounts.find((a) => a.state === 're-consent needed');
      const accounts = UI.panel('Connected accounts', (reconsent ? UI.notice('<b>' + esc(reconsent.system) + ' revoked the grant.</b> Tools that depend on it are paused until you reconnect: <span class="mono">' + esc(reconsent.tools) + '</span>. Agents that call them get a clear refusal, not a stale token.', 'warn') : '')
        + UI.table(['System', 'Scopes', 'Last used', { label: '', right: true }], acctRows, { minWidth: '0', cls: 'bare' })
        + '<span class="muted" style="font-size:12px">Tokens are held in the vault and are never placed in model context.</span>');

      const keyRows = st.keys.map((k) => {
        const expired = k.state === 'expired'; const revoked = k.state === 'revoked';
        const action = expired ? UI.pill('expired', 'warn') : revoked ? UI.pill('revoked', 'danger') : UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-revoke="' + k.id + '"' });
        return { cells: [esc(k.name), '<span class="mono">' + esc(k.scopes) + '</span>', esc(k.models), expired ? '<span style="color:var(--warn-fg)">' + esc(k.expires) + '</span>' : esc(k.expires), esc(k.last), '<span class="hstack" style="justify-content:flex-end">' + action + '</span>'], attrs: 'data-key="' + k.id + '"', selected: !!(st.expiredNote && expired) };
      });
      const keys = UI.panel('API keys', '<div>' + UI.btn('Create key', { kind: 'primary', size: 'sm', icon: 'key', attrs: 'data-create' }) + '</div>'
        + (st.revealed ? UI.notice('<b>Key <span class="mono">' + esc(st.revealed.name) + '</span> created. Copy it now; it is shown once.</b><div class="mono" style="margin-top:4px;overflow-wrap:anywhere">' + esc(st.revealed.key) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copy="' + esc(st.revealed.key) + '"' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-revealdone' })) : '')
        + (st.expiredNote ? UI.notice('<b>close-scripts expired on 1 Sep.</b> Expired keys stay listed for 30 days for audit, then disappear. This one leaves the list on 1 Oct. Calls made with it get <span class="mono">401 invalid_token</span>.', 'info') : '')
        + UI.table(['Name', 'Scopes', 'Models', 'Expires', 'Last used', { label: '', right: true }], keyRows, { minWidth: '0', cls: 'bare' })
        + '<span class="muted" style="font-size:12px">Keys work as the bearer token for OpenAI-compatible SDKs and the CLI. Each key carries a subset of your own scopes.</span>');

      const sessions = UI.panel('Sessions', UI.table(['Client', 'Signed in with', 'Zone', 'Started', 'Last activity', { label: '', right: true }], st.sessions.map((s) => ({ cells: [esc(s.client) + (s.current ? ' ' + UI.pill('this session', 'accent') : ''), esc(s.how), '<span class="mono">' + esc(s.zone) + '</span>', esc(s.started), esc(s.last), '<span class="hstack" style="justify-content:flex-end">' + (s.current ? '' : UI.btn('Sign out', { kind: 'ghost', size: 'sm', attrs: 'data-endsession="' + s.id + '"' })) + '</span>'], attrs: 'data-session="' + s.id + '"' })), { minWidth: '0', cls: 'bare', emptyTitle: 'No other sessions', emptyText: '' })
        + '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">Signing out revokes this session\'s refresh token at the identity service. The LDAP sync does the same for disabled accounts.</span>' + UI.btn('Sign out everywhere', { kind: 'ghost', size: 'sm', attrs: 'data-signoutall' }) + UI.btn('Sign out', { size: 'sm', icon: 'lock', attrs: 'data-signout' }) + '</div>');

      const security = UI.panel('Security', '<div class="eyebrow">Email address</div>'
        + (st.emailVerified ? '<div class="hstack"><span class="mono">m.okafor@northwind.local</span>' + UI.pill('verified', 'ok') + '</div>' : '<div class="hstack wrap"><span class="mono">m.okafor@northwind.local</span>' + UI.pill('not verified', 'warn') + UI.btn('Send verification link', { size: 'sm', attrs: 'data-sendverify' }) + '</div>' + UI.notice('Northwind requires a verified address. Until the link is redeemed, password sign-in answers <span class="mono">403 email_unverified</span> and sends a new link, throttled.', 'warn'))
        + '<div class="divider"></div><div class="hstack"><div class="eyebrow grow">Second factors</div>' + UI.btn('Add email code', { size: 'sm', icon: 'plus', attrs: 'data-addemail', disabled: st.factors.some((f) => f.id === 'email') }) + '</div>'
        + UI.table(['Factor', 'Label', 'Added', 'Last used', { label: '', right: true }], st.factors.map((f) => ({ cells: [esc(f.kind), esc(f.label), esc(f.added), esc(f.last), '<span class="hstack" style="justify-content:flex-end">' + (st.factors.length > 1 ? UI.btn('Remove', { kind: 'ghost', size: 'sm', attrs: 'data-rmfactor="' + f.id + '"' }) : '') + '</span>'], attrs: 'data-factor="' + f.id + '"' })), { minWidth: '0', cls: 'bare', clickable: false })
        + '<span class="muted" style="font-size:12px">Your roles require a second factor on every sign-in. Recovery codes: 8 of 10 left. <a href="#" data-recovery>Show recovery codes</a></span>'
        + '<div class="divider"></div><div class="hstack"><div class="eyebrow grow">Trusted devices, 30 days</div>' + UI.btn('Forget all', { kind: 'ghost', size: 'sm', attrs: 'data-forgetdevices', disabled: !st.devices.length }) + '</div>'
        + UI.table(['Browser', 'Trusted since', 'Until'], st.devices.map((d) => [esc(d.browser) + (d.current ? ' ' + UI.pill('this device', 'accent') : ''), esc(d.createdAt), esc(d.expiresAt)]), { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No trusted devices', emptyText: 'Tick "trust this browser" at the second-factor step to add one.' })
        + '<span class="muted" style="font-size:12px">A trusted browser skips the second factor until its period ends, until you sign out everywhere or change your password, or until the tenant shortens the period.</span>');

      const scopeNames = (list) => list.map((x) => (DAV_SCOPES.find((d) => d[0] === x) || [x, x])[1]).join(', ');
      const pwRows = st.apppw.map((a) => {
        const revoked = a.state === 'revoked';
        return { cells: [esc(a.name) + '<div class="mono muted" style="font-size:11px">' + esc(a.prefix) + '…</div>', esc(scopeNames(a.scopes)), esc(a.created), revoked ? '<span class="muted">revoked ' + esc(a.revokedOn) + '</span>' : esc(a.last) + (a.lastFrom ? '<div class="muted" style="font-size:11px">' + esc(a.lastFrom) + '</div>' : ''), esc(a.expires), '<span class="hstack" style="justify-content:flex-end">' + (revoked ? UI.pill('revoked', 'danger') : UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-davrevoke="' + a.id + '" aria-label="Revoke ' + esc(a.name) + '"' })) + '</span>'] };
      });
      const davPanel = UI.panel('App passwords for DAV clients', '<div class="fg2" style="font-size:13px">Calendar and contacts apps sign in with your username and an app password made for that device. App passwords work for CalDAV, CardDAV and WebDAV only; the console and the API refuse them.</div>'
        + UI.kv(DAV_URLS.map((d) => [esc(d[0]), '<span class="hstack gap6"><span class="mono" style="overflow-wrap:anywhere">' + esc(d[1]) + '</span>' + UI.iconbtn('copy', 'Copy ' + d[0], { attrs: 'data-copy="' + esc(d[1]) + '"', cls: 'sm ghost' }) + '</span><div class="muted" style="font-size:11px">' + esc(d[2]) + '</div>']).concat([['Username', '<span class="mono">' + esc(u.username) + '</span> <span class="muted" style="font-size:11px">or ' + esc(u.username) + '@northwind</span>']]), 2)
        + (st.davRevealed ? UI.notice('<b>App password for <span class="mono">' + esc(st.davRevealed.name) + '</span> created. Type it into the device now; it is shown once.</b><div class="mono" style="margin-top:4px;overflow-wrap:anywhere">' + esc(st.davRevealed.password) + '</div><div class="muted" style="font-size:12px;margin-top:4px">Username <span class="mono">' + esc(u.username) + '</span>, server <span class="mono">' + esc(DAV_HOST) + '/dav/</span></div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copy="' + esc(st.davRevealed.password) + '"' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-davdone' })) : '')
        + (st.davRefused ? UI.notice('<b>' + esc(st.davRefused) + ' was refused.</b> Its next request, <span class="mono">PROPFIND /dav/calendars/…</span>, got <span class="mono">401</span> with a Basic challenge. The device asks for a new password; make one here if it is still yours.', 'danger', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-davrefuseddone' })) : '')
        + '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">' + (st.davFresh ? 'Second factor confirmed at sign-in; creating one needs no further check for the next 5 minutes.' : 'Creating one asks for your authenticator code or a passkey first.') + '</span>' + UI.btn('Create app password', { kind: 'primary', size: 'sm', icon: 'key', attrs: 'data-davcreate' }) + '</div>'
        + UI.table(['Device', 'Scopes', 'Created', 'Last used', 'Expires', { label: '', right: true }], pwRows, { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No app passwords', emptyText: 'Make one for each phone, tablet or computer that syncs your calendars or contacts.' })
        + '<span class="muted" style="font-size:12px">Each device gets its own password, so revoking one leaves the others working. Revoked and expired passwords stay listed for 30 days. Creating and revoking one sends you a security notice.</span>');

      const at = st.atproto;
      const atproto = UI.panel('AT-Protocol account', (st.linkedNote ? UI.notice('<b>Account linked.</b> The authorization server confirmed <span class="mono">' + esc(at.did) + '</span>; the binding is verified with proof <span class="mono">oauth</span>.', 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-linkeddone' })) : '')
        + (!at ? UI.empty('No account linked', 'Bind your own AT-Protocol DID to sign in with it and to label as yourself.', UI.btn('Link an account', { kind: 'primary', size: 'sm', attrs: 'data-atlink' }))
          : UI.kv([['DID', '<span class="mono" style="overflow-wrap:anywhere">' + esc(at.did) + '</span>'], ['Handle', '<span class="mono">' + esc(at.handle) + '</span>' + (at.verified ? ' <span class="muted" style="font-size:12px">checked ' + esc(at.handleCheckedAt || '') + '</span>' : '')], ['State', at.verified ? UI.pill('verified', 'ok') + ' <span class="muted" style="font-size:12px">proof ' + esc(at.proof) + ', ' + esc(at.verifiedAt) + '</span>' : at.challengePending ? UI.pill('challenge pending', 'warn') : UI.pill('unverified', 'warn')], ['PDS', '<span class="mono">' + esc(at.pds) + '</span>']], 2)
          + (at.challengePending ? UI.notice('<b>Put this token in your profile description, then verify.</b> It is shown once and expires ' + esc(at.challengeExpiresAt) + '.<div class="mono" style="margin-top:4px;overflow-wrap:anywhere">' + esc(at.token) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copy="' + esc(at.token) + '"' })) : '')
          + '<div class="hstack wrap gap6">' + (at.challengePending ? UI.btn('Verify now', { kind: 'primary', size: 'sm', attrs: 'data-atverify' }) : '') + (!at.verified ? UI.btn('Sign in with the account instead', { size: 'sm', attrs: 'data-atoauth' }) : UI.btn('Change handle', { size: 'sm', attrs: 'data-athandle' })) + UI.btn('Remove', { kind: 'ghost', size: 'sm', attrs: 'data-atremove' }) + '</div>'
          + '<span class="muted" style="font-size:12px">A bound DID signs in as you through the tenant\'s <span class="mono">atproto</span> store. The handle counts only while its DID document names it back.</span>'));

      root.innerHTML = '<div class="page">' + UI.pagehead('Settings', 'Personal settings for ' + esc(u.name) + ' in ' + esc(DATA.tenant.workspace))
        + '<style>#main .settings-avatar{display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:var(--fg);color:var(--bg);font-size:18px;font-weight:700;flex-shrink:0}#main .settings-avatar.pic{background:var(--accent-tint);color:var(--accent)}</style>'
        + '<div class="grid2"><div class="vstack gap12" style="gap:14px">' + profile + publicProfile + statusPanel + appearance + notifs + '</div><div class="vstack" style="gap:14px">' + security + davPanel + accounts + keys + atproto + '</div></div>'
        + sessions
        + '</div>';

      // ---- events ----
      ctx.on('click', '[data-goidentity]', () => ctx.navigate('identity'));
      ctx.on('click', '[data-goperson]', () => ctx.navigate('person', { user: 'me' }));
      ctx.on('click', '[data-upavatar]', () => { st.avatar = 'quarantined'; ctx.rerender(); ctx.toast('Uploaded to Files in Finance Ops (202). Shown once the scan passes.', 'ok'); setTimeout(() => { if (st.avatar === 'quarantined') { st.avatar = 'ready'; if (App.state.route === 'settings') ctx.rerender(); } }, 2500); });
      ctx.on('click', '[data-rmavatar]', async () => { const ok = await ctx.confirm({ title: 'Remove your picture', body: '<p class="fg2" style="margin:0">People see your initials again. The image stays in Files, where you can trash it.</p>', ok: 'Remove' }); if (!ok) return; st.avatar = 'none'; ctx.rerender(); ctx.toast('Picture removed. Audited profile.avatar.removed.', 'ok'); });
      ctx.on('click', '[data-saveprofile]', () => { st.pronouns = ctx.$('[data-pron]').value; st.bio = ctx.$('[data-bio]').value; st.plabel = ctx.$('[data-plabel]').value; st.pws = ctx.$('[data-pws]').value; st.bioProblem = false; ctx.rerender(); ctx.toast('Profile saved. Audited profile.updated (the fields, not the text).', 'ok'); });
      ctx.on('click', '[data-status] [data-seg]', (e, t) => { st.status = t.dataset.seg; ctx.rerender(); ctx.toast('Status: ' + esc(t.textContent) + '. Published at once to people who share a workspace with you.', 'ok'); });
      ctx.on('change', '[data-theme]', (e, t) => { ctx.app.setTheme(t.value === 'Dark' ? 'dark' : t.value === 'Light' ? 'light' : null); ctx.toast('Theme: ' + esc(t.value) + '. Saved to your profile.'); });
      ctx.on('change', '[data-contrast]', (e, t) => { st.contrast = t.value === 'AAA' ? 'AAA' : 'AA'; applyContrast(st.contrast); ctx.rerender(); ctx.toast(st.contrast === 'AAA' ? 'AAA contrast on. Saved to your profile.' : 'Back to AA contrast.', 'ok'); });
      ctx.on('change', '[data-language]', (e, t) => { st.language = t.value; ctx.toast('Language set to ' + esc(t.value) + '. Model answers follow the prompt language, not this setting.'); });
      ctx.on('change', '[data-notif]', (e, t) => { st.notifs[t.dataset.notif] = t.checked; ctx.toast('Notification preference saved.'); ctx.rerender(); });
      ctx.on('click', '[data-disconnect]', async (e, t) => {
        const a = st.accounts.find((x) => x.id === t.dataset.disconnect);
        const ok = await ctx.confirm({ title: 'Disconnect ' + a.system + '?', tag: 'revokes token', tone: 'danger', body: '<div class="fg2">The token is deleted from the vault and the grant is revoked at ' + esc(a.system) + '. Tools that use it will refuse until you reconnect.</div>', kv: [['Scopes', '<span class="mono">' + esc(a.scopes) + '</span>'], ['Tools affected', '<span class="mono">' + esc(a.tools) + '</span>'], ['Vault path', '<span class="mono">' + esc(a.vault) + '</span>'], ['Acting as', esc(u.name)]], ok: 'Disconnect' });
        if (!ok) return; a.state = 'not connected'; a.last = ''; ctx.rerender(); ctx.toast(esc(a.system) + ' disconnected. Token removed from the vault and audit entry written.', 'ok');
      });
      ctx.on('click', '[data-connect]', (e, t) => {
        const a = st.accounts.find((x) => x.id === t.dataset.connect);
        ctx.modal({ title: (a.state === 're-consent needed' ? 'Reconnect ' : 'Connect ') + esc(a.system), body: '<div class="fg2">' + esc(a.system) + ' will ask you to sign in and approve these scopes. The token comes back to the vault at <span class="mono">' + esc(a.vault) + '</span> and is used only by tools acting as you.</div>' + '<div class="vstack gap6">' + a.scopes.split(', ').map((s) => UI.check(s, true, 'disabled')).join('') + '</div>' + UI.kv([['Tools that will work', '<span class="mono">' + esc(a.tools) + '</span>'], ['Label ceiling', UI.label(u.clearance, { sm: true })]], 2), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Continue to ' + a.system, { kind: 'primary', attrs: 'data-close data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { a.state = 'connected'; a.last = 'just now'; ctx.rerender(); ctx.toast(esc(a.system) + ' connected. Token stored in the vault.', 'ok'); }); } });
      });
      ctx.on('click', '[data-revoke]', async (e, t) => {
        const k = st.keys.find((x) => x.id === t.dataset.revoke);
        const ok = await ctx.confirm({ title: 'Revoke key ' + k.name + '?', tag: 'cannot be undone', tone: 'danger', body: '<div class="fg2">Clients using this key get <span class="mono">401 invalid_token</span> on their next call. The key stays listed for 30 days for audit.</div>', kv: [['Scopes', '<span class="mono">' + esc(k.scopes) + '</span>'], ['Models', esc(k.models)], ['Last used', esc(k.last)], ['Prefix', '<span class="mono">' + esc(k.prefix) + '</span>']], ok: 'Revoke key' });
        if (!ok) return; k.state = 'revoked'; k.expires = 'revoked today'; ctx.rerender(); ctx.toast('Key ' + esc(k.name) + ' revoked. Introspection now returns inactive.', 'ok');
      });
      const openCreate = () => {
        ctx.modal({ title: 'Create API key', body: UI.field('Name', UI.input('', { placeholder: 'for example notebook-desk', attrs: 'data-name' }), 'Shown in the audit log next to every call made with the key.')
          + '<div class="field"><span class="fl">Scopes, a subset of your own</span><div class="hstack wrap gap6" style="row-gap:6px">' + OWN_SCOPES.map((s) => UI.check(s, s === 'inference:invoke' || s === 'chat:read', 'data-scope="' + s + '"')).join('') + '</div></div>'
          + '<div class="formgrid">' + UI.field('Models', UI.select(['any allowed', 'analyst', 'chat-default', 'fast', 'coder', 'analyst, fast'], 'analyst', 'data-models')) + UI.field('Expires', UI.select(['30 days', '90 days', '180 days', '1 year'], '180 days', 'data-exp')) + '</div>'
          + UI.notice('The key is shown once after creation. It inherits your clearance ceiling of ' + UI.label(u.clearance, { sm: true }) + ' and is rejected in zones that do not allow it.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create key', { kind: 'primary', attrs: 'data-go' }),
          onMount(m) {
            const nameEl = m.querySelector('[data-name]'); nameEl.focus();
            m.querySelector('[data-go]').addEventListener('click', () => {
              const name = nameEl.value.trim() || 'notebook-desk'; const scopes = Array.prototype.slice.call(m.querySelectorAll('[data-scope]:checked')).map((c) => c.dataset.scope);
              if (!scopes.length) { ctx.toast('Pick at least one scope.', 'warn'); return; }
              const exp = m.querySelector('[data-exp]').value; const expires = { '30 days': '20 Oct 2026', '90 days': '19 Dec 2026', '180 days': '19 Mar 2027', '1 year': '20 Sep 2027' }[exp];
              const id = 'k' + (st.keys.length + 1); const hex = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
              st.keys.unshift({ id, name, scopes: scopes.join(' '), models: m.querySelector('[data-models]').value, expires, last: 'never', state: 'active', prefix: 'exai_' + id + '_' + hex.slice(0, 4) });
              st.revealed = { name, key: 'exai_' + id + '_' + hex }; App.closeOverlay(); ctx.rerender(); ctx.toast('Key created. Copy it now; it will not be shown again.', 'warn', 5000);
            });
          } });
      };
      ctx.on('click', '[data-create]', openCreate);
      ctx.on('click', '[data-revealdone]', () => { st.revealed = null; ctx.rerender(); });
      ctx.on('click', '[data-key]', (e, t) => { if (e.target.closest('button')) return; const k = st.keys.find((x) => x.id === t.dataset.key); ctx.drawer({ title: 'Key ' + esc(k.name) + ' ' + UI.pill(k.state), body: UI.kv([['Prefix', '<span class="mono">' + esc(k.prefix) + '…</span>'], ['Scopes', '<span class="mono">' + esc(k.scopes) + '</span>'], ['Models', esc(k.models)], ['Expires', esc(k.expires)], ['Last used', esc(k.last)], ['Clearance ceiling', UI.label(u.clearance, { sm: true })]], 2) + '<div class="eyebrow">Recent calls</div>' + UI.table(['When', 'Endpoint', 'Result'], k.state === 'expired' ? [['20 d ago', '<span class="mono">/v1/chat/completions</span>', UI.pill('401 invalid_token', 'danger')]] : [['1 h ago', '<span class="mono">/v1/chat/completions</span>', UI.pill('200', 'ok')], ['1 h ago', '<span class="mono">/v1/embeddings</span>', UI.pill('200', 'ok')], ['yesterday', '<span class="mono">/v1/chat/completions</span>', UI.pill('429 over quota', 'warn')]], { clickable: false, minWidth: '0', cls: 'bare' }), actions: UI.btn('Open in Usage and audit', { attrs: 'data-close data-goaudit' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { d.querySelector('[data-goaudit]').addEventListener('click', () => ctx.navigate('usage-audit', { key: k.name })); } }); });
      ctx.on('click', '[data-account]', (e, t) => { if (e.target.closest('button')) return; const a = st.accounts.find((x) => x.id === t.dataset.account); ctx.drawer({ title: esc(a.system) + ' ' + UI.pill(a.state), body: UI.kv([['Scopes', '<span class="mono">' + esc(a.scopes) + '</span>'], ['Vault path', '<span class="mono">' + esc(a.vault) + '</span>'], ['Tools', '<span class="mono">' + esc(a.tools) + '</span>'], ['Last used', esc(a.last || 'never')]], 1) + UI.notice('Tools receive a short-lived token minted from this grant per call. The model never sees it.', 'info'), actions: UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }) }); });
      ctx.on('click', '[data-endsession]', async (e, t) => { const s = st.sessions.find((x) => x.id === t.dataset.endsession); const ok = await ctx.confirm({ title: 'Sign out ' + s.client + '?', tag: 'revokes refresh token', tone: 'danger', kv: [['Signed in with', esc(s.how)], ['Zone', esc(s.zone)], ['Last activity', esc(s.last)]], ok: 'Sign out that session' }); if (!ok) return; st.sessions = st.sessions.filter((x) => x.id !== s.id); ctx.rerender(); ctx.toast('Session ended. Its refresh token was revoked at the identity service.', 'ok'); });
      ctx.on('click', '[data-signoutall]', async () => { const ok = await ctx.confirm({ title: 'Sign out everywhere?', tag: 'all sessions', tone: 'danger', body: '<div class="fg2">Every session and refresh token for <span class="mono">' + esc(u.username) + '</span> is revoked, including this one. API keys are not affected.</div>', ok: 'Sign out everywhere' }); if (ok) { ctx.toast('All sessions revoked.', 'ok'); ctx.app.signOut(); } });
      ctx.on('click', '[data-signout]', () => { ctx.toast('Signed out. Session cookie cleared and refresh token revoked.'); ctx.app.signOut(); });
      // ---- security and AT-Protocol (B-3413) ----
      ctx.on('click', '[data-sendverify]', () => ctx.toast('Verification link sent to m.okafor@northwind.local (202). It works once and expires in 24 hours.', 'ok', 4500));
      ctx.on('click', '[data-recovery]', (e) => { e.preventDefault(); ctx.modal({ title: 'Recovery codes', body: UI.notice('Each code works once. Two have been used. Generating new codes invalidates these.', 'info') + '<div class="mono" style="columns:2;font-size:13px;line-height:1.9">' + ['k7f3-2m9a', 'p2d8-x4q1', 'used', 'z9w1-h6t3', 'c4n8-r2v7', 'used', 'b1m6-y8k2', 'g5s3-j7l9', 'v2q4-e9t6', 'n8r1-w3c5'].map((c) => c === 'used' ? '<span class="muted"><s>used</s></span>' : esc(c)).join('<br>') + '</div>', actions: UI.btn('Generate new codes', { attrs: 'data-close data-newcodes' }) + UI.btn('Close', { kind: 'primary', attrs: 'data-close' }), onMount(m) { m.querySelector('[data-newcodes]').addEventListener('click', () => ctx.toast('10 new recovery codes generated. The old ones no longer work.', 'ok')); } }); });
      ctx.on('click', '[data-addemail]', () => ctx.modal({ title: 'Add an email one-time code', body: UI.notice('A six-digit code goes to <b>m.okafor@northwind.local</b>. Codes are in the body of the email, work once, expire in 10 minutes, and at most 5 are sent an hour. Wrong codes count in your lockout like wrong passwords.', 'info') + UI.field('Code from the email', UI.input('', { attrs: 'data-code inputmode="numeric" maxlength="6"', placeholder: '000000' }), 'Sent just now (201). Attempts remaining: 5.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Confirm factor', { kind: 'primary', attrs: 'data-confirmemail' }), onMount(m) { m.querySelector('[data-confirmemail]').addEventListener('click', () => { App.closeOverlay(); st.factors.push({ id: 'email', kind: 'Email one-time code', label: 'm…r@northwind.local', added: 'just now', last: 'never' }); ctx.rerender(); ctx.toast('Email factor confirmed. Sign-in now offers "Email me a code".', 'ok'); }); } }));
      ctx.on('click', '[data-rmfactor]', async (e, t) => { const f = st.factors.find((x) => x.id === t.dataset.rmfactor); const ok = await ctx.confirm({ title: 'Remove ' + f.kind + '?', tag: 'step-up', tone: 'danger', body: '<div class="fg2">Needs a recent sign-in. Your roles still require a second factor, so at least one other factor must remain.</div>', kv: [['Factor', esc(f.kind)], ['Label', esc(f.label)], ['Last used', esc(f.last)]], ok: 'Remove factor' }); if (!ok) return; st.factors = st.factors.filter((x) => x.id !== f.id); ctx.rerender(); ctx.toast(esc(f.kind) + ' removed. Audit entry written.', 'ok'); });
      ctx.on('click', '[data-forgetdevices]', async () => { const ok = await ctx.confirm({ title: 'Forget all trusted devices?', tone: 'info', body: '<div class="fg2">Every browser asks for the second factor on its next sign-in, this one included.</div>', kv: [['Devices', String(st.devices.length)], ['Period', '30 days']], ok: 'Forget all' }); if (!ok) return; const n = st.devices.length; st.devices = []; ctx.rerender(); ctx.toast(n + ' trusted devices forgotten. Audited auth.trusted_device.removed.', 'ok'); });
      ctx.on('click', '[data-linkeddone]', () => { st.linkedNote = false; ctx.rerender(); });
      const atLink = () => ctx.modal({ title: 'Link an AT-Protocol account', body: UI.field('Handle or DID', UI.input('mara.northwind.social', { attrs: 'data-ataccount' }), 'Resolved handle → DID → document → PDS through the service URL checks; a refused address is never fetched.') + '<div class="grid2">' + UI.panel('Prove it from your profile', '<div class="fg2" style="font-size:12px">We issue a challenge token; you put it in the profile description on your PDS, then verify here. Proof <span class="mono">profile</span>.</div>' + UI.btn('Issue challenge', { size: 'sm', kind: 'primary', attrs: 'data-atclaim' })) + UI.panel('Sign in with the account', '<div class="fg2" style="font-size:12px">The AT-Protocol OAuth flow with PKCE and DPoP; the callback binds the DID to you. Proof <span class="mono">oauth</span>.</div>' + UI.btn('Start sign-in', { size: 'sm', attrs: 'data-atoauth2' })) + '</div>' + UI.notice('Needs a recent sign-in. A DID already bound to another user of the tenant is refused (409).', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }), onMount(m) { m.querySelector('[data-atclaim]').addEventListener('click', () => { const acc = m.querySelector('[data-ataccount]').value.trim() || 'mara.northwind.social'; App.closeOverlay(); st.atproto = { did: 'did:plc:7iza6de2dwap2sbkpav7c6c6', handle: acc, verified: false, proof: null, pds: 'https://pds.northwind.social', challengePending: true, challengeExpiresAt: '20 Sep 2026, 14:02', token: 'exprsn-ai-verify-' + Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('') }; ctx.rerender(); ctx.toast('Challenge issued (201). Copy the token now; it is shown once and stored as a hash.', 'warn', 5000); }); m.querySelector('[data-atoauth2]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Redirecting to the account\'s authorization server (PAR, PKCE, DPoP). The callback returns to Settings.', 'info', 3500); setTimeout(() => ctx.navigate('settings', { atproto: 'linked' }), 900); }); } });
      ctx.on('click', '[data-atlink]', atLink);
      ctx.on('click', '[data-atoauth]', () => { ctx.toast('Redirecting to the account\'s authorization server (PAR, PKCE, DPoP). The callback returns to Settings.', 'info', 3500); setTimeout(() => ctx.navigate('settings', { atproto: 'linked' }), 900); });
      ctx.on('click', '[data-atverify]', () => { if (!st.atproto.tries) { st.atproto.tries = 1; ctx.toast('Not verified (409): the profile description does not contain the challenge yet. Save your profile on the PDS, then try again.', 'warn', 5000); return; } st.atproto = Object.assign({}, st.atproto, { verified: true, proof: 'profile', verifiedAt: 'just now', challengePending: false, handleCheckedAt: 'just now' }); ctx.rerender(); ctx.toast('DID verified from the profile record. Handle checked both ways. Audited atproto.did.verified.', 'ok', 4500); });
      ctx.on('click', '[data-athandle]', () => ctx.modal({ title: 'Change the handle shown', body: UI.field('Handle', UI.input(st.atproto.handle, { attrs: 'data-newhandle' }), 'Must resolve to ' + esc(st.atproto.did) + ' and be named by its DID document; otherwise 422 reason mismatch.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-savehandle' }), onMount(m) { m.querySelector('[data-savehandle]').addEventListener('click', () => { const h = m.querySelector('[data-newhandle]').value.trim(); if (!/northwind\.social$/.test(h)) { ctx.toast('Refused (422 reason: mismatch): ' + esc(h || 'that handle') + ' does not resolve to your DID.', 'danger', 4500); return; } App.closeOverlay(); st.atproto.handle = h; st.atproto.handleCheckedAt = 'just now'; ctx.rerender(); ctx.toast('Handle set. Audited atproto.handle.set.', 'ok'); }); } }));
      ctx.on('click', '[data-atremove]', async () => { const ok = await ctx.confirm({ title: 'Remove the AT-Protocol binding?', tone: 'danger', body: '<div class="fg2">The DID no longer signs you in. Labels already signed by the tenant\'s labeler are unaffected.</div>', kv: [['DID', '<span class="mono">' + esc(st.atproto.did) + '</span>'], ['Handle', esc(st.atproto.handle)]], ok: 'Remove' }); if (!ok) return; st.atproto = null; ctx.rerender(); ctx.toast('Binding removed (204). Audited atproto.did.removed.', 'ok'); });
      // ---- app passwords for DAV clients (B-3415) ----
      const davCreateForm = () => ctx.modal({ title: 'Create an app password',
        body: UI.field('Device name', UI.input('', { placeholder: 'for example iPad', attrs: 'data-davname maxlength="100"' }), 'Shown in this list, in the security notice and in the audit log.')
          + '<div class="field"><span class="fl">What it can reach</span><div class="hstack wrap gap6" style="row-gap:6px">' + DAV_SCOPES.map((d) => UI.check(d[1] + ' (' + d[2] + ')', d[0] !== 'webdav', 'data-davscope="' + d[0] + '"')).join('') + '</div></div>'
          + UI.field('Expires', UI.select(['Never', '30 days', '90 days', '180 days', '1 year'], 'Never', 'data-davexp'))
          + UI.notice('Within your roles: if they change, the device can do only what you can. It never signs in to the console or the API.', 'info'),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-davgo' }),
        onMount(m) {
          const nameEl = m.querySelector('[data-davname]'); nameEl.focus();
          m.querySelector('[data-davgo]').addEventListener('click', () => {
            const name = nameEl.value.trim(); const scopes = Array.prototype.slice.call(m.querySelectorAll('[data-davscope]:checked')).map((c) => c.dataset.davscope);
            if (!name) { ctx.toast('Give the device a name.', 'warn'); return; }
            if (!scopes.length) { ctx.toast('Pick at least one of CalDAV, CardDAV or WebDAV.', 'warn'); return; }
            const exp = m.querySelector('[data-davexp]').value; const hex = Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
            const tail = Array.from({ length: 43 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
            st.apppw.unshift({ id: 'a' + (st.apppw.length + 1), name, scopes, created: 'just now', last: 'never', lastFrom: '', expires: { Never: 'never', '30 days': '5 Nov 2026', '90 days': '4 Jan 2027', '180 days': '4 Apr 2027', '1 year': '6 Oct 2027' }[exp], state: 'active', prefix: 'exai_d1_' + hex });
            st.davRevealed = { name, password: 'exai_d1_' + hex + '_' + tail }; App.closeOverlay(); ctx.rerender(); ctx.toast('App password created. Type it into the device now; it will not be shown again.', 'warn', 5000);
          });
        } });
      const davStepUp = () => ctx.modal({ title: 'Confirm with your second factor',
        body: '<div class="fg2">An app password lets a device in without a second factor, so making one needs a fresh one now. Your password alone does not count.</div>'
          + UI.field('Authenticator code', UI.input('', { attrs: 'data-davcode inputmode="numeric" maxlength="6" autocomplete="one-time-code"', placeholder: '000000' })) + '<div data-davsuerr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Use a passkey', { icon: 'key', attrs: 'data-davpk' }) + UI.btn('Confirm', { kind: 'primary', attrs: 'data-davsugo' }),
        onMount(m) {
          const ok = () => { st.davFresh = true; App.closeOverlay(); ctx.rerender(); setTimeout(davCreateForm, 50); };
          m.querySelector('[data-davcode]').focus();
          m.querySelector('[data-davsugo]').addEventListener('click', () => { const c = m.querySelector('[data-davcode]').value.trim(); if (!/^\d{6}$/.test(c)) { m.querySelector('[data-davsuerr]').innerHTML = UI.notice('Enter the six-digit code from your authenticator.', 'warn'); return; } ok(); });
          m.querySelector('[data-davpk]').addEventListener('click', ok);
        } });
      ctx.on('click', '[data-davcreate]', () => (st.davFresh ? davCreateForm() : davStepUp()));
      ctx.on('click', '[data-davdone]', () => { st.davRevealed = null; ctx.rerender(); });
      ctx.on('click', '[data-davrefuseddone]', () => { st.davRefused = null; ctx.rerender(); });
      ctx.on('click', '[data-davrevoke]', async (e, t) => {
        const a = st.apppw.find((x) => x.id === t.dataset.davrevoke);
        const ok = await ctx.confirm({ title: 'Revoke the app password for ' + a.name + '?', tag: 'stops at once', tone: 'danger', body: '<div class="fg2">The next request from ' + esc(a.name) + ' is refused, and it asks for a new password. Your other devices keep working.</div>', kv: [['Scopes', esc(scopeNames(a.scopes))], ['Last used', esc(a.last) + (a.lastFrom ? ', ' + esc(a.lastFrom) : '')], ['Prefix', '<span class="mono">' + esc(a.prefix) + '</span>']], ok: 'Revoke' });
        if (!ok) return; a.state = 'revoked'; a.revokedOn = 'just now'; ctx.rerender(); ctx.toast('App password for ' + esc(a.name) + ' revoked. Audited dav.app_password.revoked.', 'ok');
      });
      ctx.on('click', '[data-copy]', (e, t) => { if (navigator.clipboard) navigator.clipboard.writeText(t.dataset.copy).catch(() => undefined); ctx.toast('Copied.', 'ok'); });
      if (st.openDavStepUp) { st.openDavStepUp = false; setTimeout(davStepUp, 50); }
      if (st.openCreate) { st.openCreate = false; setTimeout(openCreate, 50); }
    }
  });
})();
