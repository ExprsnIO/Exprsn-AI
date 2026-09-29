#!/bin/sh
# Writes the secrets compose.yml mounts. Existing files are kept, so re-running is safe.
set -eu
cd "$(dirname "$0")"
umask 077
mkdir -p secrets
gen() { [ -s "secrets/$1.txt" ] || { printf '%s' "$2" > "secrets/$1.txt"; echo "wrote secrets/$1.txt"; }; }
gen session_secret "$(openssl rand -hex 32)"
gen data_key "$(openssl rand -base64 32)"
gen postgres_password "$(openssl rand -hex 24)"
gen database_url "postgres://exprsn_ai:$(cat secrets/postgres_password.txt)@postgres:5432/exprsn_ai"
[ -s secrets/ldap_bind_password.txt ] || { : > secrets/ldap_bind_password.txt; echo "created empty secrets/ldap_bind_password.txt: put your LDAP service account password in it"; }
