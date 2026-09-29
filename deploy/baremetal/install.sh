#!/bin/sh
# Installs or upgrades Exprsn-AI on a systemd host from a source checkout. Run as root from the repository root:
#   sudo deploy/baremetal/install.sh
# Needs Node.js 22+, npm, and (for native modules) python3, make and a C++ compiler.
# Idempotent: existing configuration and credentials are kept; the application directory is replaced.
set -eu

PREFIX=/opt/exprsn-ai
ETC=/etc/exprsn-ai
STATE=/var/lib/exprsn-ai
SRC=$(cd "$(dirname "$0")/../.." && pwd)

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node.js 22 or newer is required" >&2; exit 1; }

id exprsn-ai >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin exprsn-ai
install -d -m 0755 "$ETC"
install -d -m 0700 -o root -g root "$ETC/credentials"
install -d -m 0700 -o exprsn-ai -g exprsn-ai "$STATE"

# Build in a temporary copy so the checkout stays clean.
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
cp -R "$SRC/package.json" "$SRC/package-lock.json" "$SRC/server" "$SRC/web" "$SRC/docs" "$BUILD/"
rm -rf "$BUILD/server/node_modules" "$BUILD/server/dist"
(cd "$BUILD" && npm ci --workspaces --include-workspace-root --no-audit --no-fund \
  && npm run build -w server \
  && npm prune --omit=dev --workspaces --include-workspace-root --no-audit --no-fund)
rm -rf "$BUILD/server/src" "$BUILD/server/test"

NEW="$PREFIX.new"
rm -rf "$NEW"
mv "$BUILD" "$NEW"
chown -R root:root "$NEW"
chmod -R go-w "$NEW"
[ -d "$PREFIX" ] && rm -rf "$PREFIX.old" && mv "$PREFIX" "$PREFIX.old"
mv "$NEW" "$PREFIX"
trap - EXIT

gen() { [ -s "$ETC/credentials/$1" ] || { umask 077; printf '%s' "$2" > "$ETC/credentials/$1"; echo "generated $ETC/credentials/$1"; }; }
gen session_secret "$(openssl rand -hex 32)"
gen data_key "$(openssl rand -base64 32)"
[ -s "$ETC/credentials/database_url" ] || { umask 077; : > "$ETC/credentials/database_url"; echo "put the database URL in $ETC/credentials/database_url (e.g. postgres://exprsn_ai:...@db:5432/exprsn_ai)"; }
[ -f "$ETC/exprsn-ai.env" ] || install -m 0640 -g exprsn-ai "$SRC/deploy/baremetal/exprsn-ai.env.example" "$ETC/exprsn-ai.env"
[ -f "$ETC/identity.yaml" ] || install -m 0640 -g exprsn-ai "$SRC/deploy/config/identity.example.yaml" "$ETC/identity.yaml"

install -m 0644 "$SRC/deploy/baremetal/exprsn-ai.service" /etc/systemd/system/exprsn-ai.service
systemctl daemon-reload
echo
echo "Installed to $PREFIX. Next:"
echo "  1. edit $ETC/exprsn-ai.env, $ETC/identity.yaml and $ETC/credentials/database_url"
echo "  2. systemctl enable --now exprsn-ai"
echo "  3. create the first administrator (local account, second factor enrolled at first sign-in):"
echo "     sudo -u exprsn-ai env \$(cat $ETC/exprsn-ai.env | grep -v '^#' | xargs) SESSION_SECRET_FILE=$ETC/credentials/session_secret \\"
echo "       DATA_KEY_FILE=$ETC/credentials/data_key DATABASE_URL_FILE=$ETC/credentials/database_url node $PREFIX/server/dist/cli.js admin:create --username root --display-name 'Platform admin'"
