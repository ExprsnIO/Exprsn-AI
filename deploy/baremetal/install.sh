#!/bin/sh
# Installs or upgrades Exprsn-AI on a systemd host. Run as root.
#
#   From a signed release tarball (1.9.99-final, B-10204; what cloud-init runs on a deployed VM):
#     sudo install.sh --from-release <https-url> --sha256 <digest> [--bundle <url> --cert-identity-regexp <re>]
#   From a source checkout (the previous default; needs npm, python3, make and a C++ compiler), from the repo root:
#     sudo deploy/baremetal/install.sh [--from-source]      (no mode builds this checkout, as before)
#
# A release is downloaded into a private temporary directory and its sha256 compared with the pinned digest before
# anything from it is read; with --bundle, the cosign bundle is verified too (cosign verify-blob, keyless, the
# certificate identity given). A mismatch refuses: nothing is extracted, nothing runs. The archive's entries must all
# live under exprsn-ai/ (no absolute paths, no "..", no links leaving it) and hold a built server.
#
# Options (release):
#   --archive <file>          a local copy of the tarball already downloaded (the digest is still checked)
#   --bundle <url>            the cosign bundle of the tarball; needs --cert-identity-regexp and cosign on PATH
#   --cert-identity-regexp <re>  --cert-oidc-issuer <url>   (default issuer: GitHub Actions)
#   --kms <provider>          openbao, aws-kms or azure-keyvault: the key-encryption key is not local, so no DATA_KEY
#                             is generated or loaded (the KMS credential is one of the delivered credentials)
#   --credentials-list <file> lines "<credential-name> <VARIABLE>": the systemd credentials the unit loads
#   --credentials-wrapped <file>  JSON {"addr","token"}: a single-use OpenBao response-wrapping token holding them
#   --start                   enable and start the service when installed
#   --dry-run                 stop after verification (nothing is installed; root is not needed)
#   --work-dir <dir>          where to download and check (default: a new private temporary directory)
#
# Every outcome is one "exprsn-install: <state> ..." line (also on the console when run as root), which the
# deployment's readiness check reads back. Exit codes: 2 usage, 3 digest, 4 signature, 5 archive, 6 credentials.
# Idempotent: existing configuration and credentials are kept; the application directory is replaced.
set -eu

PREFIX=/opt/exprsn-ai
ETC=/etc/exprsn-ai
STATE=/var/lib/exprsn-ai
SRC=$(cd "$(dirname "$0")/../.." && pwd)

MODE=
URL=
SHA=
ARCHIVE_IN=
BUNDLE=
IDENTITY=
ISSUER=https://token.actions.githubusercontent.com
KMS=local
CRED_LIST=
CRED_WRAPPED=
START=0
DRY=0
WORK=

say() {
  echo "exprsn-install: $*"
  if [ "$(id -u)" -eq 0 ] && [ "${EXPRSN_INSTALL_CONSOLE:-1}" = 1 ] && [ -w /dev/console ]; then echo "exprsn-install: $*" > /dev/console 2>/dev/null || true; fi
}
refuse() {
  code=$1
  shift
  say "refused $*"
  exit "$code"
}
usage() {
  echo "usage: $0 --from-release <https-url> --sha256 <digest> [options] | --from-source" >&2
  exit 2
}
need() { [ $# -ge 2 ] && [ -n "$2" ] || usage; }

while [ $# -gt 0 ]; do
  case "$1" in
    --from-release) need "$@"; MODE=release; URL=$2; shift 2 ;;
    --sha256) need "$@"; SHA=$2; shift 2 ;;
    --archive) need "$@"; ARCHIVE_IN=$2; shift 2 ;;
    --bundle) need "$@"; BUNDLE=$2; shift 2 ;;
    --cert-identity-regexp) need "$@"; IDENTITY=$2; shift 2 ;;
    --cert-oidc-issuer) need "$@"; ISSUER=$2; shift 2 ;;
    --kms) need "$@"; KMS=$2; shift 2 ;;
    --credentials-list) need "$@"; CRED_LIST=$2; shift 2 ;;
    --credentials-wrapped) need "$@"; CRED_WRAPPED=$2; shift 2 ;;
    --work-dir) need "$@"; WORK=$2; shift 2 ;;
    --start) START=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --from-source) MODE=source; shift ;;
    -h | --help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

# No mode builds this checkout, as the installer always did (2026-10-20: refusing a bare run broke existing installs).
if [ -z "$MODE" ]; then
  MODE=source
  echo "note: no mode given, so this checkout is built (--from-source); --from-release <url> --sha256 <digest> installs a release instead" >&2
fi
case "$KMS" in local | openbao | aws-kms | azure-keyvault) ;; *) echo "--kms takes local, openbao, aws-kms or azure-keyvault" >&2; exit 2 ;; esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else openssl dgst -sha256 -r "$1" | cut -d' ' -f1; fi
}

# Copies a URL to a file: https:// (curl, https only, TLS 1.2+, no redirects to another scheme) or file://.
fetch() {
  case "$1" in
    https://*) curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 -o "$2" "$1" ;;
    file://*) cp "${1#file://}" "$2" ;;
    *) return 1 ;;
  esac
}

# Whether a relative path stays inside its root once ".." is applied (no absolute paths).
inside() {
  case "$1" in /*) return 1 ;; esac
  printf '%s\n' "$1" | awk -F/ '{ d = 0; for (i = 1; i <= NF; i++) { if ($i == "..") d--; else if ($i != "." && $i != "") d++; if (d < 0) { exit 1 } } }'
}

install_files() {
  # $1: the directory holding the built tree (package.json, server/dist, web, docs, deploy).
  NEW="$PREFIX.new"
  rm -rf "$NEW"
  mv "$1" "$NEW"
  chown -R root:root "$NEW"
  chmod -R go-w "$NEW"
  if [ -d "$PREFIX" ]; then rm -rf "$PREFIX.old" && mv "$PREFIX" "$PREFIX.old"; fi
  mv "$NEW" "$PREFIX"
}

if [ "$MODE" = release ]; then
  # ---------- verify before anything from the archive is read ----------
  printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{64}$' || refuse 2 "--sha256 takes 64 lower-case hex digits"
  case "$URL" in https://* | file://*) ;; *) refuse 2 "the release URL must be https:// (or file:// for a local copy)" ;; esac
  if [ -n "$BUNDLE" ] && [ -z "$IDENTITY" ]; then refuse 2 "--bundle needs --cert-identity-regexp (whose signature to accept)"; fi
  if [ -z "$WORK" ]; then WORK=$(mktemp -d); CLEAN_WORK=1; else mkdir -p "$WORK"; CLEAN_WORK=0; fi
  chmod 0700 "$WORK"
  cleanup() { if [ "$CLEAN_WORK" = 1 ]; then rm -rf "$WORK"; else rm -rf "$WORK/release.tar.gz" "$WORK/x" "$WORK/release.bundle"; fi; }
  trap cleanup EXIT
  ARCHIVE="$WORK/release.tar.gz"
  if [ -n "$ARCHIVE_IN" ]; then cp "$ARCHIVE_IN" "$ARCHIVE" || refuse 5 "the local archive $ARCHIVE_IN cannot be read"
  else fetch "$URL" "$ARCHIVE" || refuse 5 "the release tarball could not be downloaded from $URL"; fi
  GOT=$(sha256_of "$ARCHIVE")
  if [ "$GOT" != "$SHA" ]; then
    rm -f "$ARCHIVE"
    refuse 3 "sha256 mismatch: expected $SHA, got $GOT; nothing was extracted or run"
  fi
  if [ -n "$BUNDLE" ]; then
    command -v cosign >/dev/null 2>&1 || refuse 4 "a signature bundle was given but cosign is not installed"
    fetch "$BUNDLE" "$WORK/release.bundle" || refuse 4 "the signature bundle could not be downloaded from $BUNDLE"
    cosign verify-blob --bundle "$WORK/release.bundle" --certificate-identity-regexp "$IDENTITY" --certificate-oidc-issuer "$ISSUER" "$ARCHIVE" >/dev/null 2>&1 || refuse 4 "the cosign signature does not verify for $IDENTITY"
  fi
  # The entries: everything under exprsn-ai/, nothing absolute, no "..".
  tar -tzf "$ARCHIVE" > "$WORK/entries" 2>/dev/null || refuse 5 "the archive cannot be read as a gzipped tar"
  while IFS= read -r e; do
    case "$e" in exprsn-ai/* | exprsn-ai) ;; *) refuse 5 "the archive holds $e outside exprsn-ai/" ;; esac
    inside "$e" || refuse 5 "the archive entry $e leaves the archive"
  done < "$WORK/entries"
  mkdir -p "$WORK/x"
  tar -xzf "$ARCHIVE" -C "$WORK/x" --no-same-owner || refuse 5 "the archive could not be extracted"
  # Links must stay inside the tree (npm's node_modules/.bin links do).
  find "$WORK/x" -type l > "$WORK/links"
  while IFS= read -r l; do
    rel=${l#"$WORK/x/"}
    target=$(readlink "$l")
    inside "$(dirname "$rel")/$target" || refuse 5 "the archive link $rel points outside it ($target)"
  done < "$WORK/links"
  T="$WORK/x/exprsn-ai"
  for f in package.json server/dist/index.js server/dist/cli.js web/index.html deploy/baremetal/exprsn-ai.service deploy/baremetal/exprsn-ai.env.example; do
    [ -e "$T/$f" ] || refuse 5 "the archive has no $f (not a built release)"
  done
  VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$T/package.json" | head -1)
  say "verified sha256 $SHA${BUNDLE:+ and the cosign signature} (release ${VERSION:-unknown})"
  if [ "$DRY" = 1 ]; then
    say "dry-run verified; nothing was installed"
    exit 0
  fi
  [ "$(id -u)" -eq 0 ] || refuse 2 "run as root (or with --dry-run)"
  NODE=/usr/bin/node
  if [ -x "$T/node/bin/node" ]; then NODE=$PREFIX/node/bin/node; NODE_CHECK=$T/node/bin/node; else NODE_CHECK=node; fi
  "$NODE_CHECK" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || refuse 2 "Node.js 22 or newer is required (bundle it in the release as node/bin/node, or install it)"
  UNIT_SRC="$T/deploy/baremetal/exprsn-ai.service"
  ENV_EXAMPLE="$T/deploy/baremetal/exprsn-ai.env.example"
  IDENTITY_EXAMPLE="$T/deploy/config/identity.example.yaml"
  cp "$UNIT_SRC" "$WORK/unit"
  UNIT_SRC="$WORK/unit"
else
  [ "$DRY" = 0 ] || { echo "--dry-run is for --from-release" >&2; exit 2; }
  [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node.js 22 or newer is required" >&2; exit 1; }
  NODE=/usr/bin/node
  UNIT_SRC="$SRC/deploy/baremetal/exprsn-ai.service"
  ENV_EXAMPLE="$SRC/deploy/baremetal/exprsn-ai.env.example"
  IDENTITY_EXAMPLE="$SRC/deploy/config/identity.example.yaml"
fi

id exprsn-ai >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin exprsn-ai
install -d -m 0755 "$ETC"
install -d -m 0700 -o root -g root "$ETC/credentials"
install -d -m 0700 -o exprsn-ai -g exprsn-ai "$STATE"
[ -f "$ETC/exprsn-ai.env" ] || install -m 0640 -g exprsn-ai "$ENV_EXAMPLE" "$ETC/exprsn-ai.env"
[ -f "$ETC/identity.yaml" ] || { [ -f "$IDENTITY_EXAMPLE" ] && install -m 0640 -g exprsn-ai "$IDENTITY_EXAMPLE" "$ETC/identity.yaml"; } || true

if [ "$MODE" = release ]; then
  rm -rf "$T/server/src" "$T/server/test"
  install_files "$T"
else
  # Build in a temporary copy so the checkout stays clean.
  BUILD=$(mktemp -d)
  trap 'rm -rf "$BUILD"' EXIT
  cp -R "$SRC/package.json" "$SRC/package-lock.json" "$SRC/server" "$SRC/web" "$SRC/docs" "$BUILD/"
  rm -rf "$BUILD/server/node_modules" "$BUILD/server/dist"
  (cd "$BUILD" && npm ci --workspaces --include-workspace-root --no-audit --no-fund \
    && npm run build -w server \
    && npm prune --omit=dev --workspaces --include-workspace-root --no-audit --no-fund)
  rm -rf "$BUILD/server/src" "$BUILD/server/test"
  install_files "$BUILD"
  trap - EXIT
fi

gen() { [ -s "$ETC/credentials/$1" ] || [ -s "$ETC/credentials/$1.cred" ] || { umask 077; printf '%s' "$2" > "$ETC/credentials/$1"; echo "generated $ETC/credentials/$1"; }; }

# ---------- credentials: systemd credentials, never environment variables ----------
NAMES=
if [ -n "$CRED_LIST" ]; then
  [ -f "$CRED_LIST" ] || refuse 6 "the credentials list $CRED_LIST is missing"
  NAMES=$(awk 'NF >= 2 && $1 ~ /^[a-z][a-z0-9_]*$/ && $2 ~ /^[A-Z][A-Z0-9_]*$/ { print $1 ":" $2 }' "$CRED_LIST")
  if printf '%s\n' "$NAMES" | grep -Eq ':DATA_KEY(_PREVIOUS)?$'; then refuse 6 "DATA_KEY is never a delivered credential; it stays in OpenBao transit or the signer"; fi
fi
if [ -n "$CRED_WRAPPED" ] && [ -s "$CRED_WRAPPED" ]; then
  ADDR=$("$NODE_CHECK" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")||"{}");process.stdout.write(j.addr||"")' "$CRED_WRAPPED")
  TOKEN_FILE="$WORK/wrap-token"
  ( umask 077; "$NODE_CHECK" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")||"{}");process.stdout.write(j.token||"")' "$CRED_WRAPPED" > "$TOKEN_FILE" )
  rm -f "$CRED_WRAPPED"
  if [ -s "$TOKEN_FILE" ] && [ -n "$ADDR" ]; then
    case "$ADDR" in https://*) ;; *) refuse 6 "the OpenBao address is not https" ;; esac
    # The token goes in a header file (never on the command line); a single-use token that was already used fails here.
    ( umask 077; printf 'X-Vault-Token: %s\n' "$(cat "$TOKEN_FILE")" > "$WORK/wrap-header" )
    ( umask 077; curl -fsS --proto '=https' --tlsv1.2 -X POST -H @"$WORK/wrap-header" "$ADDR/v1/sys/wrapping/unwrap" > "$WORK/unwrapped" ) || { rm -f "$TOKEN_FILE" "$WORK/wrap-header" "$WORK/unwrapped"; refuse 6 "the wrapped credentials could not be unwrapped (already used or expired: a copy of the boot data may have been read)"; }
    rm -f "$TOKEN_FILE" "$WORK/wrap-header"
    for pair in $NAMES; do
      name=${pair%%:*}
      ( umask 077; "$NODE_CHECK" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(j.data||{})[process.argv[2]];if(typeof v!=="string"){process.exit(3)}process.stdout.write(v)' "$WORK/unwrapped" "$name" > "$ETC/credentials/$name" ) || { rm -f "$WORK/unwrapped"; refuse 6 "the wrapped credentials hold no $name"; }
    done
    rm -f "$WORK/unwrapped"
    say "credentials loaded as systemd credentials"
  else
    rm -f "$TOKEN_FILE"
    say "credentials pending: no wrapped token; put them in $ETC/credentials by hand"
  fi
fi
[ -n "$NAMES" ] || gen session_secret "$(openssl rand -hex 32)"
[ "$KMS" != local ] || gen data_key "$(openssl rand -base64 32)"
[ -s "$ETC/credentials/database_url" ] || [ -n "$NAMES" ] || { umask 077; : > "$ETC/credentials/database_url"; echo "put the database URL in $ETC/credentials/database_url (e.g. postgres://exprsn_ai:...@db:5432/exprsn_ai)"; }

# Seal each credential to this host (TPM2 or the host key) where systemd-creds works: LoadCredentialEncrypted=.
ENCRYPT=0
if [ -n "$NAMES" ] && command -v systemd-creds >/dev/null 2>&1; then ENCRYPT=1; fi
CRED_LINES=
ENV_LINE=
for pair in $NAMES; do
  name=${pair%%:*}
  var=${pair#*:}
  [ -e "$ETC/credentials/$name" ] || [ -e "$ETC/credentials/$name.cred" ] || ( umask 077; : > "$ETC/credentials/$name" )
  if [ "$ENCRYPT" = 1 ] && [ -f "$ETC/credentials/$name" ] && systemd-creds encrypt --name="$name" "$ETC/credentials/$name" "$ETC/credentials/$name.cred" >/dev/null 2>&1; then
    rm -f "$ETC/credentials/$name"
    CRED_LINES="${CRED_LINES}LoadCredentialEncrypted=$name:$ETC/credentials/$name.cred
"
  else
    CRED_LINES="${CRED_LINES}LoadCredential=$name:$ETC/credentials/$name
"
  fi
  ENV_LINE="$ENV_LINE ${var}_FILE=%d/$name"
done

# ---------- the unit ----------
UNIT=/etc/systemd/system/exprsn-ai.service
if [ -n "$NAMES" ] || [ "$KMS" != local ] || [ "$NODE" != /usr/bin/node ]; then
  # The unit from the release with its credential lines replaced: only what was delivered, DATA_KEY only with local KMS.
  {
    while IFS= read -r line; do
      case "$line" in
        LoadCredential=data_key:*) [ "$KMS" != local ] || [ -n "$NAMES" ] || printf '%s\n' "$line" ;;
        LoadCredential=*) [ -n "$NAMES" ] || printf '%s\n' "$line" ;;
        Environment=SESSION_SECRET_FILE=*)
          if [ -n "$NAMES" ]; then printf '%s' "$CRED_LINES"; printf 'Environment=%s\n' "${ENV_LINE# }"
          elif [ "$KMS" != local ]; then printf '%s\n' "$line" | sed 's# DATA_KEY_FILE=%d/data_key##'
          else printf '%s\n' "$line"; fi ;;
        ExecStart=/usr/bin/node*) printf '%s\n' "$line" | sed "s#/usr/bin/node#$NODE#" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < "$UNIT_SRC"
  } > "$UNIT.tmp"
  install -m 0644 "$UNIT.tmp" "$UNIT"
  rm -f "$UNIT.tmp"
else
  install -m 0644 "$UNIT_SRC" "$UNIT"
fi
systemctl daemon-reload

if [ "$MODE" = release ]; then
  if [ "$START" = 1 ]; then systemctl enable --now exprsn-ai; fi
  say "installed ${VERSION:-release} from $URL"
  exit 0
fi
echo
echo "Installed to $PREFIX. Next:"
echo "  1. edit $ETC/exprsn-ai.env, $ETC/identity.yaml and $ETC/credentials/database_url"
echo "  2. systemctl enable --now exprsn-ai"
echo "  3. create the first administrator (local account, second factor enrolled at first sign-in):"
echo "     sudo -u exprsn-ai env \$(cat $ETC/exprsn-ai.env | grep -v '^#' | xargs) SESSION_SECRET_FILE=$ETC/credentials/session_secret \\"
echo "       DATA_KEY_FILE=$ETC/credentials/data_key DATABASE_URL_FILE=$ETC/credentials/database_url node $PREFIX/server/dist/cli.js admin:create --username root --display-name 'Platform admin'"
