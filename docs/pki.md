# Certificate authority

Exprsn-AI runs a private certificate authority (1.4.0, Sprints 24 and 25): a platform root, one issuing intermediate
per tenant, profiles that say what each tenant may issue, CRLs and OCSP, an ACME server, export in the usual formats,
renewal, expiry notices and the `exprsn-ai pki` command. The routes are in [api.md](api.md) (sections "Sprint 24:
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

The Sprint 24 settings (CRL and OCSP timing, the public rate limit) are listed in [deploy.md](deploy.md).
