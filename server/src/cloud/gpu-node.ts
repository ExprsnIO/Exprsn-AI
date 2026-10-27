import type { KubeObject } from './kube.js';

/*
 * 1.9.99-final, Sprint 60 (B-10401, B-10404): what a cloud GPU node runs at first boot, rendered from the link.
 *
 * Both shapes follow `deploy/baremetal/ollama-node.md`: Ollama listens on 127.0.0.1 only, an mTLS proxy in front of
 * it on the node's private address (port 11435) accepts only the gateway's client certificate, and model weights
 * come from the internal mirror, never from the public registry.
 *
 *   GPU VM (EC2 G/P, Azure NC/ND/NV, DigitalOcean GPU Droplet): cloud-init. The enrolment token is not in the
 *   rendered user data: `@@EXPRSN_ENROL:<pool>:<key>@@` is replaced at create time by the adapter's secret broker
 *   (`bootstrapUserData` in `cloud/compute.ts`) with a single-use token minted for that VM.
 *   Node group (EKS, AKS, DOKS): a DaemonSet on the group's nodes (host network, the GPU taint tolerated). The
 *   reconcile job writes one single-use token per node into the Secret `exprsn-enrol` (key: the node's name); a
 *   token is bound to that node's name and private address, so another pod that reads it cannot use it.
 *
 * The bootstrap, on the node: an egress guard (nftables: DNS, the enrolment host and the mirror host only, the rest
 * of the outbound traffic dropped); a P-256 key made on the node (it never leaves it) and a CSR; `POST <enrol>` with
 * the token, the CSR and the private address, answered with the server certificate, the CA chain, the gateway's
 * client certificate fingerprint and the warm-up list; the proxy configured; the approved placements pulled from the
 * mirror (each reference checked against the mirror host first: `mirrorRefProblem`, the same rule in the script);
 * `exprsn-gpu: ready` on the console.
 */

export const ENROL_PLACEHOLDER_RE = /@@EXPRSN_ENROL:([a-z0-9-]{1,40}):([a-z0-9-]{1,63})@@/g;
export const enrolPlaceholder = (pool: string, key: string): string => `@@EXPRSN_ENROL:${pool}:${key}@@`;
export const GPU_MARK = 'exprsn-gpu:';
/** The node's mTLS port (Ollama itself stays on 127.0.0.1:11434). */
export const NODE_TLS_PORT = 11435;
export const ENROL_PATH = '/cloud/gpu/v1/enrol';
export const GPU_NAMESPACE = 'exprsn-gpu';
export const ENROL_SECRET = 'exprsn-enrol';

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** The host of a mirror URL (`https://models.internal:5000/` → `models.internal:5000`), or null. */
export function mirrorHost(mirror: string | null | undefined): string | null {
  if (!mirror) return null;
  try {
    return new URL(mirror).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The mirror reference a node pulls for a catalogue model (`llama3.1:8b` → `<host>/library/llama3.1:8b`). */
export function mirrorRef(host: string, model: string): string {
  const name = model.replace(/^registry\.ollama\.ai\//, '');
  return `${host}/${name.includes('/') ? name : `library/${name}`}`;
}

/**
 * B-10404, the node's egress guard for pulls: a reference that is not on the mirror host is refused. The bootstrap
 * script applies the same rule before every pull (and nftables drops anything else), so a node never pulls from
 * outside the mirror.
 */
export function mirrorRefProblem(host: string | null, ref: string): string | null {
  if (!host) return 'no model mirror is configured (Platform › Mirrors, kind models)';
  const at = ref.toLowerCase();
  if (!at.startsWith(`${host}/`)) return `${ref} is not on the mirror ${host}`;
  if (/\s|\.\.|[;&|`$]/.test(ref)) return `${ref} is not a plain model reference`;
  return null;
}

export interface GpuNodeInput {
  deployment: string;
  pool: string;
  /** The graph key of the VM (one token per VM); a DaemonSet uses the node's name. */
  key: string;
  warmup: { source: 'mirror' | 'snapshot'; snapshotId?: string | null };
}

/**
 * The token file's content, written in place of the placeholder (a VM) or as the node's key of the Secret (a node
 * group): the single-use token, where to enrol, and the mirror host the egress guard admits. Nothing else.
 */
export interface EnrolPayload {
  token: string;
  url: string;
  mirror: string | null;
  expiresAt: number;
}

/** The bootstrap script both shapes run (as root on a VM, in the init container on a node group). */
export function gpuBootstrapScript(o: Omit<GpuNodeInput, 'key'> & { tokenFile: string; nodeName: string }): string[] {
  return [
    '#!/bin/sh',
    `# Exprsn-AI ${o.deployment}: GPU node of pool ${o.pool} (B-10401, B-10404). No secret is in this script.`,
    'set -eu',
    `TOKEN_FILE=${o.tokenFile}`,
    `NODE=${o.nodeName}`,
    `WARMUP=${shq(o.warmup.source)}`,
    'D=/etc/exprsn-gpu',
    `say() { echo "${GPU_MARK} $*"; echo "${GPU_MARK} $*" > /dev/console 2>/dev/null || true; }`,
    'mkdir -p "$D" && chmod 0700 "$D"',
    '[ -s "$TOKEN_FILE" ] || { say "refused no enrolment token"; exit 1; }',
    'field() { python3 -c \'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)\' "$TOKEN_FILE" "$1"; }',
    'ENROL=$(field url); MIRROR_HOST=$(field mirror)',
    'case "$ENROL" in https://*|http://*) ;; *) say "refused no enrolment URL"; exit 1 ;; esac',
    'ENROL_HOST=$(echo "$ENROL" | sed -E "s#^[a-z]+://([^/]+).*#\\1#")',
    // The egress guard: DNS, the enrolment host and the mirror only.
    'if command -v nft >/dev/null 2>&1; then',
    '  nft add table inet exprsn_egress 2>/dev/null || true',
    "  nft 'add chain inet exprsn_egress out { type filter hook output priority 0; policy drop; }' 2>/dev/null || true",
    '  nft add rule inet exprsn_egress out oif lo accept',
    '  nft add rule inet exprsn_egress out ct state established,related accept',
    '  nft add rule inet exprsn_egress out udp dport 53 accept',
    '  for h in "${ENROL_HOST%%:*}" "${MIRROR_HOST%%:*}"; do [ -n "$h" ] || continue; for a in $(getent ahostsv4 "$h" | cut -d" " -f1 | sort -u); do nft add rule inet exprsn_egress out ip daddr "$a" accept; done; done',
    'fi',
    'mirror_ok() { [ -n "$MIRROR_HOST" ] || { say "refused $1: no model mirror"; return 1; }; case "$1" in "$MIRROR_HOST"/*) return 0 ;; *) say "refused $1: not on the mirror $MIRROR_HOST"; return 1 ;; esac; }',
    'ADDR=$(ip -4 route get 1.1.1.1 | sed -n "s/.* src \\([0-9.]*\\).*/\\1/p")',
    'openssl ecparam -genkey -name prime256v1 -noout -out "$D/node.key" && chmod 0600 "$D/node.key"',
    'openssl req -new -key "$D/node.key" -subj "/CN=$ADDR" -out "$D/node.csr"',
    'BOOTED=$(( $(date +%s) - $(cut -d. -f1 /proc/uptime) ))',
    'python3 - "$TOKEN_FILE" "$D/node.csr" "$ADDR" "$NODE" "$BOOTED" > "$D/enrol.req" <<\'PY\'',
    'import json, sys',
    'print(json.dumps({"token": json.load(open(sys.argv[1]))["token"], "csr": open(sys.argv[2]).read(), "address": sys.argv[3], "node": sys.argv[4], "bootedAt": int(sys.argv[5]) * 1000}))',
    'PY',
    'curl -fsS --retry 5 -H "content-type: application/json" --data-binary @"$D/enrol.req" -o "$D/enrol.json" "$ENROL" || { say "refused the enrolment was not accepted"; rm -f "$D/enrol.req"; exit 1; }',
    'rm -f "$D/enrol.req"; [ -w "$TOKEN_FILE" ] && rm -f "$TOKEN_FILE" || true',
    'python3 - "$D" <<\'PY\'',
    'import json, sys',
    'd = sys.argv[1]; r = json.load(open(d + "/enrol.json"))',
    'open(d + "/node.crt", "w").write(r["certificate"] + "".join(r["chain"]))',
    'open(d + "/gateway-ca.pem", "w").write("".join(r["gateway"]["caChain"]))',
    'open(d + "/gateway.sha1", "w").write(r["gateway"]["clientSha1"])',
    'open(d + "/warmup.txt", "w").write("".join(m["ref"] + " " + m["name"] + "\\n" for m in r["warmup"]["models"]))',
    'PY',
    // The mTLS proxy in front of Ollama: only the gateway's client certificate, by CA and by fingerprint.
    'cat > /etc/nginx/conf.d/exprsn-gpu.conf <<EOF',
    `server { listen $ADDR:${NODE_TLS_PORT} ssl; ssl_certificate $D/node.crt; ssl_certificate_key $D/node.key; ssl_client_certificate $D/gateway-ca.pem; ssl_verify_client on; ssl_protocols TLSv1.3;`,
    '  if (\\$ssl_client_fingerprint != "$(cat $D/gateway.sha1)") { return 403; }',
    '  location / { proxy_pass http://127.0.0.1:11434; proxy_buffering off; proxy_read_timeout 600s; } }',
    'EOF',
    'nginx -s reload 2>/dev/null || nginx',
    // Warm-up: the approved placements, from the mirror only (or already on the snapshot volume).
    'while read -r ref name; do',
    '  [ -n "$ref" ] || continue',
    '  mirror_ok "$ref" || exit 1',
    '  if [ "$WARMUP" = snapshot ] && ollama show "$name" >/dev/null 2>&1; then continue; fi',
    '  ollama pull --insecure "$ref" && ollama cp "$ref" "$name" || { say "refused the pull of $ref failed"; exit 1; }',
    'done < "$D/warmup.txt"',
    'say "ready $ADDR"'
  ];
}

/** The cloud-init user data of one GPU VM (its token placeholder replaced at create time). */
export function renderGpuNodeInit(o: GpuNodeInput): string {
  const script = gpuBootstrapScript({ ...o, tokenFile: '/run/exprsn-bootstrap/enrol', nodeName: shq(o.key) });
  return [
    '#cloud-config',
    `# Exprsn-AI ${o.deployment}: GPU VM of pool ${o.pool} (B-10401). The enrolment token below is single use and bound to this VM.`,
    'package_update: false',
    'write_files:',
    '  - path: /etc/systemd/system/ollama.service.d/exprsn.conf',
    "    permissions: '0644'",
    '    content: |',
    '      [Service]',
    '      Environment=OLLAMA_HOST=127.0.0.1:11434',
    '      Environment=OLLAMA_KEEP_ALIVE=30m',
    `      Environment=OLLAMA_MODELS=${o.warmup.source === 'snapshot' ? '/var/lib/exprsn-models' : '/usr/share/ollama/.ollama/models'}`,
    '  - path: /run/exprsn-bootstrap/enrol',
    "    permissions: '0600'",
    `    content: '${enrolPlaceholder(o.pool, o.key)}'`,
    '  - path: /usr/local/sbin/exprsn-gpu-bootstrap',
    "    permissions: '0700'",
    '    content: |',
    ...script.map((l) => `      ${l}`),
    ...(o.warmup.source === 'snapshot' ? ['mounts:', "  - [ LABEL=exprsn-models, /var/lib/exprsn-models, auto, 'defaults,nofail', '0', '2' ]"] : []),
    'runcmd:',
    '  - [ systemctl, daemon-reload ]',
    '  - [ systemctl, restart, ollama ]',
    '  - [ /usr/local/sbin/exprsn-gpu-bootstrap ]',
    ''
  ].join('\n');
}

export interface DaemonSetInput extends Omit<GpuNodeInput, 'key'> {
  /** The node group's graph name (`exprsn.ai/node-group` label on its nodes). */
  nodeGroup: string;
  gpus: number;
  /** Images pinned by digest, from the image mirror. */
  images: { ollama: string; proxy: string };
}

/** The node group's DaemonSet and its ConfigMap (the bootstrap); the Secret with the tokens is written by the reconcile job. */
export function gpuDaemonSet(o: DaemonSetInput): KubeObject[] {
  const name = `exprsn-gpu-${o.pool}`.slice(0, 63);
  const labels = { 'app.kubernetes.io/name': 'exprsn-gpu-node', 'exprsn.ai/pool': o.pool };
  const script = gpuBootstrapScript({ ...o, tokenFile: '"/run/exprsn-enrol/$NODE_NAME"', nodeName: '"$NODE_NAME"' });
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: GPU_NAMESPACE, labels: { 'exprsn.ai/managed': 'true' } } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: `${name}-bootstrap`, namespace: GPU_NAMESPACE, labels }, data: { 'bootstrap.sh': script.join('\n') + '\n' } },
    {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name, namespace: GPU_NAMESPACE, labels },
      spec: {
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            hostNetwork: true,
            automountServiceAccountToken: false,
            nodeSelector: { 'exprsn.ai/node-group': o.nodeGroup },
            tolerations: [{ key: 'exprsn.ai/gpu', operator: 'Equal', value: 'true', effect: 'NoSchedule' }],
            initContainers: [
              {
                name: 'enrol',
                image: o.images.proxy,
                command: ['/bin/sh', '/bootstrap/bootstrap.sh'],
                env: [{ name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } }],
                securityContext: { capabilities: { add: ['NET_ADMIN'] } },
                volumeMounts: [
                  { name: 'bootstrap', mountPath: '/bootstrap', readOnly: true },
                  { name: 'enrol', mountPath: '/run/exprsn-enrol', readOnly: true },
                  { name: 'state', mountPath: '/etc/exprsn-gpu' }
                ]
              }
            ],
            containers: [
              { name: 'ollama', image: o.images.ollama, env: [{ name: 'OLLAMA_HOST', value: '127.0.0.1:11434' }, { name: 'OLLAMA_KEEP_ALIVE', value: '30m' }], resources: { limits: { 'nvidia.com/gpu': o.gpus } }, volumeMounts: [{ name: 'models', mountPath: '/root/.ollama' }] },
              { name: 'proxy', image: o.images.proxy, volumeMounts: [{ name: 'state', mountPath: '/etc/exprsn-gpu', readOnly: true }] }
            ],
            volumes: [
              { name: 'bootstrap', configMap: { name: `${name}-bootstrap`, defaultMode: 0o500 } },
              { name: 'enrol', secret: { secretName: ENROL_SECRET, optional: true, defaultMode: 0o400 } },
              { name: 'state', emptyDir: { medium: 'Memory' } },
              { name: 'models', hostPath: { path: '/var/lib/exprsn-models', type: 'DirectoryOrCreate' } }
            ]
          }
        }
      }
    }
  ];
}
