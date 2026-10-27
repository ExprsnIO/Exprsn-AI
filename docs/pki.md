# Certificate authority

Exprsn-AI runs a private certificate authority (1.4.0, Sprints 24 and 25): a platform root, one issuing intermediate
per tenant, profiles that say what each tenant may issue, CRLs and OCSP, an ACME server, export in the usual formats,
renewal, expiry notices and the `exprsn-ai pki` command; since 1.9.0 (Sprint 55) settings in the console, CA tokens
and one-time tickets, and member certificates with certificate sign-in. The routes are in [api.md](api.md) (sections "Sprint 24:
Certificate authority" and "Sprint 25a"); the limits are in [security.md](security.md) under "Known gaps".

## Keys

Issuer and OCSP responder keys are made and used only in the signer process (`exprsn-ai signer`, `SIGNER_SOCKET`) or
in OpenBao transit (`KMS_PROVIDER=openbao`). The database holds certificates, public keys and a reference to each
private key (the signer's wrapped blob, which the app cannot open, or the transit key name). With neither configured
the CA refuses to make keys. Subscriber keys are the subscriber's: the CA sees a CSR, an ACME finalize request or the
certificate being renewed. The one exception is issuance with `generateKey`, where a key is made in the app for a
client without CSR tooling, returned once inside a password-protected PKCS#12 file and never stored.

## Hierarchy

```
platform root          created by a platform admin (platform:manage, recent sign-in); rotate to replace
  └─ tenant intermediate   one active per tenant (pki:manage); pathLen 0; rotate or re-issue
       ├─ end-entity certificates, under a profile
       └─ delegated OCSP responder certificate (short-lived, ocsp-nocheck)
```

Relying parties should trust the tenant's intermediate where only that tenant's certificates should be accepted:
trusting the root trusts every tenant's issuance.

## Profiles

A profile (`server`, `client` or `code-signing`) lists the names it may issue (`domains` with `*.domain` for every
name below a domain, `allowWildcard`, `ipRanges`, `emailDomains`, `uriPrefixes`), the key types it accepts and its
lifetimes (at most 398 days for server certificates). Every issuance path checks every name against the profile; a
refusal is audited as `pki.issue.refused`.

## Issuing

| Path | Who proves what |
| --- | --- |
| `POST /api/pki/issuers/:id/issue` with a CSR | A `pki:manage` holder. The CSR's signature proves possession of the key; the profile bounds the names. No domain control is checked: the administrator is trusted for the names the profile allows |
| `POST /api/pki/issuers/:id/issue` with `generateKey` | As above; the key is made here and returned once in PKCS#12 |
| `exprsn-ai pki issue` | The operator on the host, as above |
| ACME (`/pki/acme/<tenant>/directory`) | Anyone with an ACME account on the tenant's directory (optionally bound to a key the tenant admin issued). Every name is both allowed by the directory's profile and proven by http-01 or dns-01 |

### How ACME orders map to profiles

The tenant admin opens the directory (`PUT /api/pki/acme`) and names one **server** profile. That profile is the
upper bound: a `newOrder` naming anything its `domains` do not allow (or a wildcard without `allowWildcard`, or an IP
address) is refused with `rejectedIdentifier` before any challenge is offered. Domain-control validation is the lower
bound: each allowed name still needs a valid http-01 or dns-01 challenge before the order is `ready`. The certificate
is issued by the tenant's active intermediate with the profile's default lifetime (ACME `notBefore` and `notAfter`
are refused) and key-type policy, and records the ACME account that ordered it.

So a profile used for ACME can be broad (`*.corp.example`): an ACME client only receives names it controls. Keep a
separate, narrower profile for administrator issuance, which does not check control. Changing the directory's profile
applies to new orders; orders already placed keep the profile they were placed under.

### Using the ACME server

Point any RFC 8555 client at `https://<PKI_ACME_URL or PKI_PUBLIC_URL>/pki/acme/<tenant slug>/directory` and trust
the tenant's intermediate (or the root). For example with certbot:

```sh
certbot certonly --server https://ca.example.org/pki/acme/acme-corp/directory \
  --standalone -d web.corp.example --eab-kid <kid> --eab-hmac-key <hmacKey>
```

Exprsn-AI's own platform certificates can use it too: set `ACME_DIRECTORY_URL` to the directory (and `ACME_EAB_KID`,
`ACME_EAB_HMAC_KEY` when the tenant requires binding).

- http-01 is fetched from port `PKI_ACME_HTTP_PORT` (80) of the name. Every address the name resolves to goes through
  the service address checks: cloud metadata and other link-local addresses are always refused, and with
  `PKI_ACME_INTERNAL_ONLY=true` public addresses are refused unless `PKI_ACME_ALLOWED_HOSTS` names them. Up to three
  redirects are followed, to http on the same port or https on 443 (the https certificate is not checked, as RFC 8555
  allows).
- dns-01 looks up TXT at `_acme-challenge.<name>` through `PKI_ACME_DNS_SERVERS` (for example the internal
  authoritative servers) or the system resolver. A wildcard is offered dns-01 only.
- External account binding: `POST /api/pki/acme/eab-keys` gives a `kid` and an `hmacKey` (shown once). With
  `eabRequired` every new account needs one; a key binds one account.
- Revocation through ACME is accepted from the ordering account, from an account holding valid authorizations for
  every name, or signed by the certificate's own key.
- Nonces are kept in the database, so a client may be balanced across instances.

## Export, renewal and expiry

- `GET /api/pki/certificates/:id/export?format=pem|der|chain` and `POST /api/pki/certificates/:id/pkcs12 {password}`.
  PKCS#12 files are written with PBES2 (PBKDF2-HMAC-SHA256, 100,000 iterations, AES-256-CBC) and an HMAC-SHA256 MAC;
  the tests open them with `openssl pkcs12` (OpenSSL 1.1.1 and later, LibreSSL 3) and Node's TLS stack. Readers that
  only know the legacy RC2 or 3DES encryption cannot open them.
- `POST /api/pki/certificates/:id/renew` issues the same names under the same profile from the current intermediate,
  for the old key or a new CSR's, and can revoke the old certificate as `superseded`. ACME clients renew by placing a
  new order.
- The `pki.expiry` job (every `PKI_EXPIRY_SWEEP_MINUTES`) notifies each valid certificate's owner once at each of
  `PKI_EXPIRY_NOTICE_DAYS` (30 and 7) days before expiry: the user who requested it, or the tenant's `pki:manage`
  holders for certificates issued over ACME or from the CLI. A certificate with a valid renewal is skipped. The same
  job removes used nonces and old ACME orders.

## The `exprsn-ai pki` command

Runs on a host with the server's configuration (the same database and the signer or OpenBao), as the operator, for
`--tenant <slug>` (default `DEFAULT_TENANT`). Every change is audited with actor `service: cli`.

```sh
exprsn-ai pki issuers
exprsn-ai pki list --state valid --limit 20
exprsn-ai pki issue --csr web.csr --profile web --days 90 --out web-chain.pem
exprsn-ai pki issue --csr web.csr --profile web --san dns:web.corp.example --san dns:www.corp.example
exprsn-ai pki revoke 01J9Z3K8V6Q2XW4T7B5N0C1D2E --reason keyCompromise
exprsn-ai pki revoke 4f3a9c...                     # by serial (hex)
exprsn-ai pki crl --out tenant.crl --der           # sign the next CRL now
```

Exit codes: 0 done, 1 refused or failed (a name outside the profile, an unknown profile), 3 conflict (already
revoked, no active intermediate), 64 usage.

## Certificates › Settings (1.9.0, B-187)

The CA's settings are saved in the console (Certificates › Settings) or with `exprsn-ai pki:settings`, for the
platform (`platform:manage` and a recent sign-in) and per tenant where that is safe. Each value is the tenant's saved
value, else the platform's, else the environment variable below, else the built-in default, and the screen shows which
(`source`). Migration `127_pki_settings` holds them; until it runs every value is the environment's and saving is
refused with `409`.

| Group | Settings | Scope |
| --- | --- | --- |
| Root | subject (C, ST, L, O, OU, email), validity (365 to 9,125 days), key algorithm, path length (none or 1 to 4) | platform, dual control |
| Intermediates | subject, validity (30 to 3,650 days, within the root), key algorithm, path length (0 to 3, below the root) | platform, dual control |
| Names | the subject attributes of issued certificates, and per profile | tenant (and platform default) |
| CRL | interval (`PKI_CRL_MINUTES`), validity (`PKI_CRL_VALIDITY_HOURS`, longer than the interval), next update in days (at least the validity) | platform, tenant may tighten |
| OCSP | answer validity (`PKI_OCSP_VALIDITY_MINUTES`) and cache (`PKI_OCSP_CACHE_SECONDS`) | platform, tenant may tighten |
| OCSP | delegated responder certificate on or off, its lifetime (`PKI_OCSP_SIGNER_DAYS`) and key algorithm, batch requests and how many certificates one request may name | platform |
| ACME | terms-of-service URL (new accounts must agree), certificate validity (within the profile), private identifiers allowed (`.local`, `.internal`, single labels…), the issuing intermediate | platform default, tenant |
| Public routes | the public URL (`PKI_PUBLIC_URL`), requests per address per minute (`PKI_PUBLIC_RATE_PER_MINUTE`) | platform |
| CA tokens | maximum size, signature (ECDSA P-256, ECDSA P-384, RSA-PSS), default expiry, lifetime and uses, signer rotation | platform default, tenant |
| Member certificates | on or off, client profile, a CA token too, renewal before expiry, certificate sign-in, mTLS, SAN mapping | tenant |

Key algorithms per tier: ECDSA P-256 and P-384, RSA 2,048, 3,072 and 4,096 bits; they need the signer (or OpenBao)
from this release, which knows P-384 and RSA 4,096.

- **Ranges and floors.** A value out of its range is refused (`422`, naming the setting). An environment variable set
  explicitly (or by an approved configuration override) is a floor: a saved value may be stricter (a shorter lifetime,
  a lower rate, a stronger key), never weaker. For a tenant the platform's value is the floor in the same way. The
  defaults of CA tokens (lifetime and uses) are defaults, not floors.
- **Taking effect.** Saved values apply at once: the next issuance, the next CRL, the next OCSP answer (cached answers
  are dropped on every instance), the next ACME request, the next public request. The CRL schedule ticks every minute
  and signs the CRLs that are due under each tenant's interval.
- **Dual control.** A change to the root or the intermediates (subject, algorithm, validity, path length) becomes a
  proposal that a second platform admin approves (never the proposer; a change made with `pki:settings` is approved
  in the console). Approved, it is read at the next **rotation** (a new key: subject and algorithm) or **re-issue**
  (the same key: validity and path length). Nothing is re-keyed when a setting changes, and a re-issue never changes
  the subject, so certificates already issued keep chaining. Audited `pki.settings.updated`, `.proposed`,
  `.approved`, `.rejected` and `.withdrawn`.

## CA tokens and tickets (1.9.0, B-188)

A CA token is a compact JWS (`typ: exprsn-ca+jwt`) signed in custody by the tenant's **token signer**: an end-entity
certificate under the tenant's intermediate (listed on the Certificates tab like any other) whose key is in the signer
or OpenBao. The header names the signer (`kid`) and its certificate (`x5t#S256`); the chain is public at
`/pki/tokens/<tenant>/keys`, so a resource server can verify offline, or ask `POST /api/pki/tokens/validate`
(`pki:tokens`) for revocation and uses.

```json
{ "iss": "https://ca.example.com/pki/tokens/acme", "jti": "01J…", "tid": "01J…", "sub": "01J…",
  "res": { "type": "url", "id": "https://files.example.com/docs/" }, "perm": ["read", "append"],
  "iat": 1760000000, "exp": 1760003600 }
```

- **Binding and permissions.** One resource: a URL (it covers the paths below it), a DID or a CID. Permission bits
  read 1, write 2, append 4, delete 8, admin 16.
- **Expiry.** By time (`exp`), by uses (`uses`; each validation spends one in a single conditional update, so
  concurrent checks on any number of instances never spend more than there is) or persistent (until revoked or its
  signer's certificate ends). A **ticket** (`kind: ticket`, `act`) is good for one use of one named action, for at
  most a day.
- **Operations.** Validate, introspect (spends nothing), refresh (a new token with the same binding and the uses left;
  the old one is `replaced`), revoke one, bulk revoke (by ids, person, resource, signer or all).
- **Signers.** Rotated every `tokens.rotationDays` (the hourly `pki.tokens.rotate` job), when the intermediate or the
  signature setting changes, or on demand. A retired signer keeps verifying what it signed; revoking a signer's
  certificate, or the intermediate above it, revokes every token it signed.
- **Storage.** Only the token's id and the SHA-256 of its text are kept; the token is shown once. Audited
  `pki.token.issued`, `.ticket.issued`, `.used`, `.ticket.redeemed`, `.refreshed`, `.revoked`, `.revoked.bulk`,
  `.signer.rotated`.
- **RSA-PSS** (PS256) needs the signer from this release (it signs with `padding: pss`); an older signer would return
  a PKCS#1 v1.5 signature, which the server's own check refuses (`502`), so nothing wrongly signed is ever issued.

Migration `128_ca_tokens` holds signers, tokens and member certificates; until it runs, tokens report as not
configured.

## Member certificates (1.9.0, B-189)

Off by default. With `members.enabled` and a client profile, each member gets a client certificate when they join
(created by an admin, through an invitation, SCIM, provisioning on first sign-in, sign-up approval or reactivation),
named by `exprsn-member://<tenant>/<user id>` (the profile must allow that URI prefix) or, with `members.san email`,
by the account's address. The key is made for them, sealed with the tenant key and handed over once under
Settings (`POST /api/me/certificates/<id>/pickup`, a PKCS#12 file under their password); after that the server keeps
only the certificate. With `members.withToken` a persistent CA token for this server comes with it the same way. The
`pki.members.sweep` job (`PKI_MEMBER_SWEEP_MINUTES`) renews certificates within `members.renewDays` of expiry with the
same key, issues those a join missed, and revokes the certificates (and tokens) of people who left
(`affiliationChanged`); offboarding a tenant revokes them all (`cessationOfOperation`). Audited `pki.member.issued`,
`.renewed`, `.revoked`, `.picked_up`, `.refused`, `.sweep`.

### Certificate sign-in and mTLS behind nginx

The app speaks plain HTTP behind a TLS proxy, so the proxy verifies the client certificate and forwards it. The
headers are believed only from a peer address in `PKI_CLIENT_CERT_PROXIES` (the socket's own address; `X-Forwarded-For`
and `TRUST_PROXY` are not consulted), and the certificate is checked again: a live member certificate of this CA,
signed by its intermediate, naming the account. A client that sends the headers itself, from anywhere else, is refused.

```nginx
server {
  listen 443 ssl;
  ssl_client_certificate /etc/nginx/exprsn-ca.pem;   # the root and the tenant intermediates (GET /pki/ca/<id>.pem)
  ssl_verify_client optional;
  ssl_verify_depth 2;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header X-SSL-Client-Cert   $ssl_client_escaped_cert;
    proxy_set_header X-SSL-Client-Verify $ssl_client_verify;
  }
}
```

Always set both headers in the proxy (an empty `$ssl_client_escaped_cert` when no certificate was sent), so a client
cannot pass its own through. Then `PKI_CLIENT_CERT_PROXIES=127.0.0.1` (the proxy's address as the app sees it).
Sign-in is `POST /api/auth/certificate` (the tenant's second-factor rules still apply); mTLS for the API needs
`members.mtls` and the request header `X-Client-Cert-Auth: 1` (a header a cross-site page cannot send without a
preflight, so a browser holding the certificate is not a CSRF vector).

## The `exprsn-ai pki:settings` command (1.9.0, B-195)

```sh
exprsn-ai pki:settings show [--tenant <slug>] [--json]          # effective values, sources, floors
exprsn-ai pki:settings set crl.validityHours=12 --tenant acme
exprsn-ai pki:settings set 'leaf.subject={"O":"Acme Ltd","C":"GB"}' --tenant acme
exprsn-ai pki:settings set root.keyType=ecdsa-p384 --platform   # a proposal: a platform admin approves it
exprsn-ai pki:settings reset ratePerMinute --platform
exprsn-ai pki:settings proposals
```

The operator acts as a platform admin for the platform scope but cannot approve a proposal. Exit codes: 0 done, 1
refused, 3 conflict (no migration yet, a save at the same time), 64 usage.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `PKI_PUBLIC_URL` | `PUBLIC_URL` | Base URL in certificates for CRLs, OCSP and issuer certificates |
| `PKI_ACME_URL` | `PKI_PUBLIC_URL` | Base URL of the ACME directories |
| `PKI_ACME_ORDER_HOURS` | `24` | How long orders and their pending authorizations last |
| `PKI_ACME_NONCE_MINUTES` | `60` | How long a replay nonce is accepted |
| `PKI_ACME_RATE_PER_MINUTE` | `120` | New accounts, orders, challenge responses, finalize, revocations and key changes per address |
| `PKI_ACME_HTTP_PORT` | `80` | The port http-01 is fetched from |
| `PKI_ACME_INTERNAL_ONLY`, `PKI_ACME_ALLOWED_HOSTS` | `false`, empty | Refuse public addresses for http-01 unless allowed |
| `PKI_ACME_DNS_SERVERS` | system resolver | `host[:port]` list for dns-01 TXT lookups |
| `PKI_EXPIRY_NOTICE_DAYS` | `30,7` | Expiry notice thresholds |
| `PKI_EXPIRY_SWEEP_MINUTES` | `360` | How often the expiry sweep runs (0 turns it off) |
| `PKI_CLIENT_CERT_PROXIES` | empty (never) | Peer addresses or ranges whose forwarded client-certificate headers are believed |
| `PKI_CLIENT_CERT_HEADER`, `PKI_CLIENT_CERT_VERIFY_HEADER` | `x-ssl-client-cert`, `x-ssl-client-verify` | The headers the proxy forwards the certificate and its verification in |
| `PKI_MEMBER_SWEEP_MINUTES` | `360` | How often member certificates are renewed, issued and revoked (0 turns it off) |

The Sprint 24 settings (CRL and OCSP timing, the public rate limit) are listed in [deploy.md](deploy.md); since
1.9.0 they are the defaults and floors of Certificates › Settings.
