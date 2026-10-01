# Exprsn-AI Helm chart

Chart version `1.2.0`, application version `1.2.0`. Kubernetes 1.27 or later.

The chart runs the Exprsn-AI application server as a Deployment behind a Service and an Ingress. Everything the
server depends on is external and referenced from `values.yaml`:

| Dependency | How the chart refers to it |
| --- | --- |
| PostgreSQL or MySQL | `config.database.client` and the `DATABASE_URL` secret. SQLite is not supported here; use Compose or systemd for a single node |
| Redis | The `REDIS_URL` secret. Required whenever more than one replica can run (`replicaCount` or `autoscaling.maxReplicas` above 1): the Socket.io adapter, the BullMQ job queue and the cross-instance bus use it |
| Blob store | `config.blobStore.type`: `s3` (MinIO, Ceph, SeaweedFS, AWS) or `pvc` (a volume at `/var/lib/exprsn-ai`, `ReadWriteMany` with more than one replica) |
| KMS | `config.kms.provider`: `local` with the `DATA_KEY` secret, or `openbao` with `config.kms.openbao.addr` and the `OPENBAO_TOKEN` secret |
| Directory | The identity YAML (`identity.config` or `identity.existingConfigMap`) and its secret files (`extraSecretFiles`) |
| Ollama | External GPU nodes or another namespace. Instances are registered in the console under Admin > Pools, not in this chart |

The chart never creates Secrets. Each entry under `secrets:` names a key of a Secret you create; the key is mounted
as a file under `/run/secrets/` and the server reads it through the matching `<NAME>_FILE` variable, so no secret value
appears in the pod specification or its environment.

## Install

```sh
kubectl create namespace exprsn-ai

# Secrets: generate the session secret and the data key once, and keep a copy of the data key outside the cluster
# (see docs/runbooks/backup-restore.md). Without it, sealed content cannot be read after a restore.
kubectl -n exprsn-ai create secret generic exprsn-ai \
  --from-literal=session_secret="$(openssl rand -hex 32)" \
  --from-literal=data_key="$(openssl rand -base64 32)" \
  --from-literal=database_url='postgres://exprsn_ai:...@postgres.data.svc:5432/exprsn_ai?sslmode=verify-full' \
  --from-literal=redis_url='redis://:...@redis.data.svc:6379' \
  --from-literal=s3_secret_access_key='...' \
  --from-literal=metrics_token="$(openssl rand -hex 24)"

# LDAP bind password referenced by the identity YAML as file:/run/secrets/ldap_bind_password
kubectl -n exprsn-ai create secret generic exprsn-ai-ldap --from-literal=bind_password='...'

helm install exprsn-ai deploy/helm/exprsn-ai -n exprsn-ai -f my-values.yaml
kubectl -n exprsn-ai exec -it deploy/exprsn-ai -- node server/dist/cli.js admin:create \
  --username root --display-name "Platform admin"
```

A minimal `my-values.yaml`:

```yaml
image:
  repository: registry.example.internal/exprsn-ai
  digest: sha256:...          # pin what CI built and scanned
config:
  publicUrl: https://ai.example.internal
  blobStore:
    type: s3
    s3: { endpoint: https://minio.data.svc:9000, bucket: exprsn-ai, accessKeyId: exprsn-ai }
identity:
  config: |
    tenants:
      - slug: northwind
        name: Northwind
        providers:
          - name: Northwind OpenLDAP
            kind: ldap
            config:
              url: ldaps://ldap.northwind.local:636
              bindDN: cn=exprsn-svc,ou=services,dc=northwind,dc=local
              bindPassword: file:/run/secrets/ldap_bind_password
              userBase: ou=people,dc=northwind,dc=local
extraSecretFiles:
  - { name: exprsn-ai-ldap, key: bind_password, path: ldap_bind_password }
ingress:
  hosts: [{ host: ai.example.internal, paths: [{ path: /, pathType: Prefix }] }]
  tls: [{ secretName: exprsn-ai-tls, hosts: [ai.example.internal] }]
networkPolicy:
  egress:
    database: { to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: data } } }], ports: [{ port: 5432 }] }
    redis: { to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: data } } }] }
    objectStorage: { to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: data } } }] }
    directory: { to: [{ ipBlock: { cidr: 10.31.0.0/24 } }] }
    inference: { to: [{ ipBlock: { cidr: 10.40.0.0/16 } }] }
```

The chart refuses to render combinations the server would reject at start: a missing `publicUrl`, a plain `http://`
address in production, SQLite, missing secrets for the chosen KMS or blob store, several replicas without Redis, a
shared blob volume that is not `ReadWriteMany`, and a ServiceMonitor without a metrics token.

## What runs

- **Deployment** `server`: the image's `node server/dist/index.js` under `tini`, as the image's `node` user (UID 1000),
  with a read-only root filesystem, every capability dropped, no privilege escalation and the `RuntimeDefault`
  seccomp profile. `/tmp` is an `emptyDir`; `/var/lib/exprsn-ai` is the blob volume or an `emptyDir`. The service
  account token is not mounted: the server never calls the Kubernetes API.
- **Probes**: startup and liveness on `/healthz` (process up), readiness on `/readyz` (database reachable and fully
  migrated, KMS and blob store answering; 503 while draining). On SIGTERM the server stops accepting connections,
  closes sockets and exits within 25 s; `terminationGracePeriodSeconds` is 40 and a 5 s `preStop` pause lets the
  endpoints drop the pod first.
- **Migrations** (`migrations.mode`): `initContainer` (default) runs `node server/dist/cli.js migrate` in every pod
  before the server starts; Knex's migration lock makes concurrent pods safe. `job` runs it once as a
  `pre-install,pre-upgrade` hook Job. `none` leaves it to the server (`DB_MIGRATE_ON_START=true`). In the first two
  modes the chart sets `DB_MIGRATE_ON_START=false`.
- **Rolling updates**: `maxSurge: 1`, `maxUnavailable: 0`. A chat stream lives on the pod that runs it; when that pod
  drains, the answer ends where it was and is kept as stored so far. See `docs/runbooks/upgrade.md`.
- **PodDisruptionBudget** (`minAvailable: 1`) whenever at least two replicas run; **HorizontalPodAutoscaler** when
  `autoscaling.enabled` (scale-in is slow on purpose, one pod every two minutes after a ten-minute window).
- **ServiceMonitor** when `serviceMonitor.enabled`, scraping `/metrics` with the `METRICS_TOKEN` secret as a bearer
  token. Without a token `/metrics` is off in production.
- **ConfigMap** with the non-secret settings; `config.extra` passes any other variable from `docs/deploy.md`. Pods
  restart when the settings or the inline identity YAML change (checksum annotations). Secret rotation needs a
  `kubectl rollout restart` (identity-store secrets are read at use time and need none).

## NetworkPolicies and zones

The policies mirror the network zones of the design (the Zones screen): **edge**, **app**, **data**, **directory**,
**inference**, **sandbox**, **training** and **external**. The release's pods are the **app** zone and carry the label
`exprsn.ai/zone: app`.

| Policy | Direction | Zone | Default |
| --- | --- | --- | --- |
| `default-deny` | in and out | app | Denies everything not allowed below, for the server and the migration Job |
| `ingress` | in | edge to app | The ingress controller (`ingress-nginx` namespace and pods) on the HTTP port; Prometheus from `monitoring` when the ServiceMonitor is on |
| `egress-dns` | out | cluster DNS | `kube-dns` in `kube-system`, port 53 UDP and TCP |
| `egress-database` | out | data | Ports 5432 and 3306; no peers until you set them |
| `egress-redis` | out | data | Port 6379 |
| `egress-objectstorage` | out | data | Ports 9000 and 443 |
| `egress-kms` | out | OpenBao | Port 8200 |
| `egress-directory` | out | directory | LDAP 389 and 636, Kerberos 88 TCP and UDP |
| `egress-inference` | out | inference | Ollama 11434 and ComfyUI 8188; the gateway is the only client of Ollama |
| `egress-sandbox` | out | sandbox | MCP servers, tool and script runners, ClamAV, media workers; all ports of the peers you list unless you give ports |
| `egress-notifications`, `egress-siem` | out | mail relay, SIEM | SMTP ports; SIEM any port of the peers you list |

An egress group is rendered only when its `to:` list has at least one peer (a `namespaceSelector`, a `podSelector`,
both, or an `ipBlock`). Groups left empty stay denied, and `NOTES.txt` names the ones the server cannot start without.
Nothing allows the internet: the **external** zone stays empty in an air-gapped site, and **training** talks to the
data zone, not to the application.

The other zones' own policies live with the workloads in them. For the inference namespace, a policy that admits only
the application's pods looks like this:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: ollama-from-app-only, namespace: inference }
spec:
  podSelector: { matchLabels: { app.kubernetes.io/name: ollama } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: exprsn-ai } }
          podSelector: { matchLabels: { exprsn.ai/zone: app } }
      ports: [{ port: 11434, protocol: TCP }]
  egress: []      # no egress; add the internal weight mirror if models are pulled from one
```

NetworkPolicies need a CNI that enforces them (Calico, Cilium, Antrea and others). On a CNI that does not, they are
accepted and ignored.

## WebSocket and long-lived streams

The console connects to `/socket.io` over WebSocket first and falls back to HTTP long polling; chat answers stream for
minutes. The ingress must forward the `Upgrade` and `Connection` headers, allow long read and send timeouts, and keep a
client on one pod during long polling when there is more than one replica:

- **ingress-nginx**: the default annotations in `values.yaml` (`proxy-read-timeout`, `proxy-send-timeout`,
  `proxy-body-size`, cookie `affinity`). Upgrades are forwarded by default.
- **Traefik**: WebSocket works without configuration; set sticky sessions on the Service with
  `traefik.ingress.kubernetes.io/service.sticky.cookie: "true"` (under `service.annotations`) and raise the entry
  point's `respondingTimeouts.readTimeout` if you lowered it.
- **HAProxy Ingress**: `haproxy-ingress.github.io/timeout-tunnel: 1h` and
  `haproxy-ingress.github.io/affinity: cookie`.
- **Gateway API**: an `HTTPRoute` to the Service works for WebSocket; session persistence depends on the
  implementation.

Set `config.trustProxy` so the server sees client addresses: `uniquelocal` trusts any private address, which fits an
ingress controller inside the cluster.

## Scripts, media and images

The script sandbox needs a docker or podman CLI, which this locked-down pod does not have, so the chart sets
`SCRIPT_RUNNER=none` and script runs are refused. Media jobs need `ffmpeg` in the image (the stock image does not
include it). Image generation backends (`IMAGE_BACKENDS`) and the image-safety classifier are external URLs set with
`config.extra`; allow them in the inference or sandbox egress group.

## Checking the chart

```sh
helm lint deploy/helm/exprsn-ai -f deploy/helm/exprsn-ai/ci/default-values.yaml --strict
helm template t deploy/helm/exprsn-ai -f deploy/helm/exprsn-ai/ci/default-values.yaml | kubeconform -strict -summary \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
```

CI runs both for every file in `ci/`.

## Operations

- Backup and restore: [docs/runbooks/backup-restore.md](../../../docs/runbooks/backup-restore.md)
- Incidents: [docs/runbooks/incident-response.md](../../../docs/runbooks/incident-response.md)
- Upgrades and rollback: [docs/runbooks/upgrade.md](../../../docs/runbooks/upgrade.md)

## Zones applied in-cluster (1.3.0)

```yaml
zonesApply:
  enabled: true
  namespaces: [edge, app, data, directory, inference, sandbox, training]   # must exist
networkPolicy:
  egress:
    kubernetesApi:
      to: [{ ipBlock: { cidr: 10.96.0.1/32 } }]   # kubectl get endpoints kubernetes -n default
```

The server then applies each zone's rendered NetworkPolicy through the Kubernetes API (server-side apply) after every
approved zone change and reports drift on the Zones screen. Each listed namespace gets a Role allowing get, list,
create and patch on networkpolicies only, bound to the server's service account, whose token is mounted in the pod
(it is not otherwise). Dashboards and alert rules for the ServiceMonitor's metrics are in `deploy/observability/`.
