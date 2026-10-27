# Emergency seal and unseal

Use this when the platform's keys must stop being usable now: a suspected compromise of a node, of the signer host or
of admin accounts, a stolen backup together with a leaked `DATA_KEY`, or a legal instruction to stop processing.
Sealing makes every instance drop its keys and refuse anything that needs one, until escrow share holders unseal it
(1.8.0, B-145). Nothing is deleted: everything sealed before reads back the same after the unseal.

## Before you need it

- **Escrow the key.** `exprsn-ai kms:escrow --shares 5 --threshold 3` (with the signer: add `--key-file <the signer's
  key file>` on the signer host). Hand each share to a different custodian. Without an escrow of the running key the
  seal is refused, because nothing could unseal it. Platform › Vault seal shows "Can be sealed: yes" and "matches the
  running key" when this is in place. Make a new escrow after every `kms:rewrap` to a new key.
- **With OpenBao** (`KMS_PROVIDER=openbao`) the app does not seal: seal OpenBao itself (`bao operator seal`) and
  unseal it with its own key shares. The app then answers 503 on everything that needs a key, as OpenBao refuses.
- **Rehearse.** Seal and unseal a staging deployment once a quarter with the real custodians.

## Seal

Pick one path.

**Dual control (normal).** Two different platform admins (`platform:manage`, each with a recent sign-in):

1. Admin A: Platform › Vault seal › Seal the vault, with the reason. (`POST /api/admin/platform/vault/seal/proposals`;
   audited `vault.seal.proposed`; every platform admin is notified.)
2. Admin B: Platform › Vault seal › Approve and seal. (`.../proposals/<id>/approve`; audited `vault.seal.approved`,
   then `vault.sealed`.) The proposal expires after an hour; A cannot approve their own.

**Break-glass (admin accounts cannot be trusted, or no second admin can be reached).** Threshold share holders,
together:

- on any host with the server's environment: `exprsn-ai vault:seal --break-glass --reason "<why>"`, then paste the
  shares one per line (or `--share <text>` each); or
- on `/unseal.html` (shown when the vault is open): "Break-glass seal" with the shares and a reason.

Holders of the threshold can already rebuild the key-encryption key, so this gives them nothing new. Prefer the CLI
on a trusted host: shares typed into a compromised server's page are exposed to it. Audited `vault.seal.break-glass`.

## What sealed looks like

- Every instance drops its unwrapped data keys, the keyring's HMAC secrets, opened private keys and cached derived
  secrets, and stops claiming jobs. With the signer, the signer drops its key-encryption key too and writes
  `signer.sealed` beside its socket, so restarting it does not undo the seal. Audited `vault.seal.applied` per
  instance (with the instance id).
- Instances learn it over Redis at once, and every server also polls the persisted flag (`vault_seal_state`) every
  5 seconds; a server started while sealed starts sealed.
- Still answering: `/healthz`, `/readyz` (ready, with `vault: sealed`, so the load balancer keeps routing to the unseal
  page), `/metrics`, the console's static files (the sign-in page shows), `GET /api/auth/session` (as signed out),
  and the unseal API under `/api/public/vault/`.
- Everything else answers `503 Vault sealed` (problem+json, `Retry-After: 30`): sign-in, every `/api` route, `/v1`,
  DAV, SCIM, the protocol endpoints and public links. Socket.io connections are refused (the session key is gone).
- The audit chain keeps recording (it needs no key). Checkpoint signing waits for the unseal and then covers what was
  written meanwhile.

Check: `exprsn-ai vault:seal-status`, or `curl -s https://<host>/api/public/vault/seal`.

## Unseal

Needs the threshold of escrow shares (the escrow the seal named; `vault:seal-status` shows its id and k of n).

**Console:** each holder opens `https://<host>/unseal.html` and submits their own share. Progress (for example
"1 of 3") is kept in that one server's memory, never stored, so every holder must reach the same instance (the page
names it; with several replicas, port-forward or pin one, or use the CLI). Each share is audited
`vault.unseal.share` (its number only, never its text); a wrong or foreign share is refused
(`vault.unseal.share.refused`). "Discard the shares given so far" resets the progress.

**CLI:** `exprsn-ai vault:unseal`, then paste k shares one per line (or `--share` each). If the escrow's row was lost
with the database, add `--check <key check value>` as `kms:escrow` printed it.

At the threshold the key is rebuilt in memory and checked against the escrow's key check value and the running key;
the signer is unsealed with the same shares (it checks them against the key it started with); the flag is cleared;
every instance reopens its keys (audited `vault.unsealed`, then `vault.unseal.applied` per instance). Too few shares,
duplicates, or shares of another escrow are refused and nothing changes (`vault.unseal.failed`).

**Several signers (one per host):** the instance that reached the quorum unseals its own signer. Another host's signer
keeps its seal and that instance logs "this instance's signer is still sealed". On that host run
`exprsn-ai vault:unseal --signer-only` with the shares.

## After

1. People sign in again as usual; sessions issued before the seal are still valid unless you revoke them.
2. `exprsn-ai audit:verify` and review `vault.*` entries for the seal window.
3. If the cause was a key compromise, rotate: new `DATA_KEY` (or signer key) with `DATA_KEY_PREVIOUS` and
   `kms:rewrap`, the keyring keys on Platform › Vault, then a new `kms:escrow` (the old shares are of the old key).
4. Write the incident up ([incident-response.md](incident-response.md)).
