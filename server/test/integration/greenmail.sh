#!/usr/bin/env bash
# B-3605: a containerised IMAP server for the email channel's integration test (test/integration/imap.test.ts).
#
#   server/test/integration/greenmail.sh <dir> [name]
#
# Makes a throwaway CA and a certificate for localhost (127.0.0.1) in <dir>, starts GreenMail with it (IMAPS on
# $GREENMAIL_IMAPS_PORT, default 3993; SMTP for delivery on $GREENMAIL_SMTP_PORT, default 3025) and the mailbox
# help@shop.example / imap-pw, waits until IMAPS answers, and prints the variables the test reads:
#
#   NODE_EXTRA_CA_CERTS=<dir>/ca.pem
#   TEST_IMAP_URL=imaps://help%40shop.example:imap-pw@127.0.0.1:3993/INBOX
#   TEST_IMAP_SMTP_URL=smtp://127.0.0.1:3025
#
# The channel's fetcher requires TLS and verifies the certificate against the host name, as in production; the CA is
# trusted through NODE_EXTRA_CA_CERTS only in the test process. Stop it with `docker rm -f <name>`.
set -euo pipefail
dir=${1:?usage: greenmail.sh <dir> [name]}
name=${2:-greenmail}
imaps=${GREENMAIL_IMAPS_PORT:-3993}
smtp=${GREENMAIL_SMTP_PORT:-3025}
image=greenmail/standalone:2.1.5@sha256:8a2024725c7b1ce8f720644bccb6f237781992a8cbf283023446eb7d29326ad0

mkdir -p "$dir"
cd "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=Exprsn AI test IMAP CA" -keyout ca.key -out ca.pem >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' >server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 7 -extfile server.ext -out server.pem >/dev/null 2>&1
openssl pkcs12 -export -in server.pem -inkey server.key -certfile ca.pem -name greenmail -passout pass:changeit -out greenmail.p12 >/dev/null 2>&1
chmod 644 greenmail.p12

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p "127.0.0.1:$imaps:3993" -p "127.0.0.1:$smtp:3025" \
  -v "$PWD/greenmail.p12:/home/greenmail/test.p12:ro" \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.tls.keystore.file=/home/greenmail/test.p12 -Dgreenmail.tls.keystore.password=changeit -Dgreenmail.users=help:imap-pw@shop.example -Dgreenmail.users.login=email" \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  # Ready once IMAPS answers a login over a verified TLS connection (curl speaks IMAP).
  if curl -fsS --max-time 5 --cacert ca.pem --user 'help@shop.example:imap-pw' "imaps://127.0.0.1:$imaps/" 2>/dev/null | grep -q INBOX; then
    echo "NODE_EXTRA_CA_CERTS=$PWD/ca.pem"
    echo "TEST_IMAP_URL=imaps://help%40shop.example:imap-pw@127.0.0.1:$imaps/INBOX"
    echo "TEST_IMAP_SMTP_URL=smtp://127.0.0.1:$smtp"
    exit 0
  fi
  sleep 1
done
docker logs "$name" >&2
exit 1
