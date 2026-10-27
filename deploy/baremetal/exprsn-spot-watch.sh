#!/usr/bin/env bash
# 1.9.99-final, Sprint 60 (B-10403): the node-side spot interruption watcher for an Exprsn-AI cloud GPU node.
#
# Polls the instance metadata service every 5 s and posts a notice to Exprsn-AI over mTLS, with the node certificate
# the Exprsn-AI CA issued at enrolment, so the gateway drains the node before the provider reclaims it:
#   - EC2 (IMDSv2):  /latest/meta-data/spot/instance-action          -> ec2_interruption (the two-minute notice)
#                    /latest/meta-data/events/recommendations/rebalance -> ec2_rebalance
#   - Azure:         /metadata/scheduledevents (EventType Preempt)     -> azure_preempt (NotBefore as reclaimAt)
# DigitalOcean offers on-demand capacity only and needs no watcher. Each notice is posted once per event; the server
# also records each one once. Azure events are never acknowledged here (an acknowledgement would start the eviction).
#
# Settings (environment, e.g. from /etc/exprsn-ai/spot-watch.env):
#   EXPRSN_URL         the Exprsn-AI base URL the node enrolled with (https://...)
#   EXPRSN_NODE_CERT   the node certificate (PEM), EXPRSN_NODE_KEY its key, EXPRSN_CA the Exprsn-AI CA bundle
#   EXPRSN_CLOUD       aws or azure
set -euo pipefail

: "${EXPRSN_URL:?EXPRSN_URL is required}"
: "${EXPRSN_NODE_CERT:?EXPRSN_NODE_CERT is required}"
: "${EXPRSN_NODE_KEY:?EXPRSN_NODE_KEY is required}"
: "${EXPRSN_CA:?EXPRSN_CA is required}"
: "${EXPRSN_CLOUD:?EXPRSN_CLOUD is aws or azure}"

IMDS=http://169.254.169.254
seen=""

post() { # kind eventId reclaimAt(ISO or empty)
  local body
  body=$(printf '{"kind":"%s","eventId":"%s"%s}' "$1" "$2" "${3:+,\"reclaimAt\":\"$3\"}")
  curl -fsS --max-time 10 --cacert "$EXPRSN_CA" --cert "$EXPRSN_NODE_CERT" --key "$EXPRSN_NODE_KEY" \
    -H 'content-type: application/json' -d "$body" "$EXPRSN_URL/cloud/v1/nodes/interruptions" >/dev/null \
    && seen="$seen $1:$2" || echo "spot-watch: posting $1 failed; retrying" >&2
}

once() { case " $seen " in *" $1:$2 "*) return 0 ;; *) return 1 ;; esac; }

while true; do
  if [ "$EXPRSN_CLOUD" = aws ]; then
    token=$(curl -fsS --max-time 2 -X PUT "$IMDS/latest/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' || true)
    if [ -n "$token" ]; then
      action=$(curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: $token" "$IMDS/latest/meta-data/spot/instance-action" || true)
      if [ -n "$action" ]; then
        when=$(printf '%s' "$action" | sed -n 's/.*"time" *: *"\([^"]*\)".*/\1/p')
        once ec2_interruption "${when:-notice}" || post ec2_interruption "${when:-notice}" "$when"
      fi
      rebalance=$(curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: $token" "$IMDS/latest/meta-data/events/recommendations/rebalance" || true)
      if [ -n "$rebalance" ]; then
        at=$(printf '%s' "$rebalance" | sed -n 's/.*"noticeTime" *: *"\([^"]*\)".*/\1/p')
        once ec2_rebalance "${at:-rebalance}" || post ec2_rebalance "${at:-rebalance}" ""
      fi
    fi
  else
    events=$(curl -fsS --max-time 3 -H 'Metadata: true' "$IMDS/metadata/scheduledevents?api-version=2020-07-01" || true)
    # One line per event: EventId and NotBefore of each Preempt (jq when present, else a narrow sed).
    if command -v jq >/dev/null 2>&1; then
      lines=$(printf '%s' "$events" | jq -r '.Events[]? | select(.EventType == "Preempt") | "\(.EventId) \(.NotBefore)"' || true)
    else
      lines=$(printf '%s' "$events" | tr '{' '\n' | grep '"Preempt"' | sed -n 's/.*"EventId" *: *"\([^"]*\)".*"NotBefore" *: *"\([^"]*\)".*/\1 \2/p' || true)
    fi
    while read -r id notbefore; do
      [ -n "${id:-}" ] || continue
      iso=$(date -u -d "$notbefore" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
      once azure_preempt "$id" || post azure_preempt "$id" "$iso"
    done <<<"$lines"
  fi
  sleep 5
done
