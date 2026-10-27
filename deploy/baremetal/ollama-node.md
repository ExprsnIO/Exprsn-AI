# Ollama inference nodes on bare metal

Exprsn-AI registers Ollama endpoints as *pool instances* (one Ollama process per accelerator group), polls
`/api/version`, `/api/ps` and `/api/tags` every few seconds, and routes requests by profile and label. Prepare the
node as below, then add it under **Admin > Pools > Add instance** with its URL, memory size and the settings you gave
Ollama (parallel requests, maximum loaded models, context length, KV cache type, keep-alive), so the memory planner
and slot accounting match the node. For mutual TLS, give the instance the CA, client certificate and key paths on
the Exprsn-AI server and put an mTLS-terminating proxy in front of Ollama.

## Rules

- Ollama listens only on the inference network. It is never published to users or the internet; only the
  Exprsn-AI server (gateway) reaches it. Put an mTLS proxy in front of it when the network is shared.
- Model weights come from the internal mirror, not from the public registry.
- One Ollama process per accelerator group, pinned with `CUDA_VISIBLE_DEVICES` / `ROCR_VISIBLE_DEVICES`.

## systemd drop-in

```ini
# /etc/systemd/system/ollama.service.d/exprsn.conf
[Service]
Environment=OLLAMA_HOST=10.20.0.11:11434
Environment=OLLAMA_KEEP_ALIVE=30m
Environment=OLLAMA_MAX_QUEUE=16
Environment=OLLAMA_NUM_PARALLEL=4
Environment=OLLAMA_MAX_LOADED_MODELS=2
Environment=OLLAMA_KV_CACHE_TYPE=q8_0
Environment=CUDA_VISIBLE_DEVICES=0
```

For a second GPU, copy the unit as `ollama@1.service` with `OLLAMA_HOST=…:11435` and `CUDA_VISIBLE_DEVICES=1`.

## Firewall

```sh
# allow only the Exprsn-AI server(s) to reach Ollama
nft add rule inet filter input ip saddr 10.20.0.5 tcp dport 11434 accept
nft add rule inet filter input tcp dport 11434 drop
```

## Docker placement

`deploy/docker/compose.yml` runs Ollama on an internal network (`--profile inference`, plus `compose.gpu.yml`
for NVIDIA GPUs). Both placements are registered the same way in Sprint 3.

## Spot interruption watcher (cloud GPU nodes)

A cloud GPU node on EC2 Spot or Azure Spot runs `exprsn-spot-watch.sh` beside Ollama (1.9.99-final, B-10403). It
polls the instance metadata service every 5 s (IMDSv2 `spot/instance-action` and the rebalance recommendation on
EC2; Scheduled Events `Preempt` on Azure) and posts each notice once to `POST /cloud/v1/nodes/interruptions` with the
node certificate the Exprsn-AI CA issued at enrolment (`EXPRSN_NODE_CERT`, `EXPRSN_NODE_KEY`, `EXPRSN_CA`,
`EXPRSN_URL`, `EXPRSN_CLOUD=aws` or `azure`). The gateway then drains the node before the provider reclaims it. It
never acknowledges an Azure event. DigitalOcean GPU Droplets are on-demand only and need no watcher.

## Cloud GPU nodes (1.9.99-final, B-10401)

GPU node groups (EKS, AKS, DOKS) and GPU VMs (EC2 G/P, Azure NC/ND/NV, DigitalOcean GPU Droplets) planned from a
deployment spec's `gpuPools` follow the same rules and register themselves; nobody adds them under Pools. What the
bootstrap does (`server/src/cloud/gpu-node.ts`; the cloud-init of a VM, or the `exprsn-gpu-<pool>` DaemonSet's init
container on a node group):

1. Reads its single-use enrolment token (a VM: `/run/exprsn-bootstrap/enrol` from its user data; a node group: its
   node's key of the Secret `exprsn-enrol`), which also names the enrolment URL and the model mirror's host.
2. Locks egress with nftables: DNS, the enrolment host and the mirror only; everything else outbound is dropped.
3. Makes its own P-256 key and a CSR for its private address and posts them with the token to
   `POST <PUBLIC_URL>/cloud/gpu/v1/enrol`. The token works once; the answer is a server certificate from the Exprsn-AI
   CA naming exactly that address, the CA chain, and the gateway client certificate's fingerprint.
4. Runs Ollama on `127.0.0.1:11434` and nginx on `<address>:11435` with that certificate, `ssl_verify_client on`
   against the CA chain and the gateway's fingerprint pinned, proxying to Ollama.
5. Pulls the pool's approved placements from the mirror only (a reference on another host is refused), or takes them
   from the pre-seeded volume (`warmup.source: snapshot`, mounted by `LABEL=exprsn-models`), then prints
   `exprsn-gpu: ready <address>` on the console.

The gateway registers the instance (`deploy: cloud`) as the node enrols, connects with the pool's client certificate
and trusts the node by its CA chain and its pinned certificate. A GPU VM set up by hand in a cloud account can enrol
the same way with a token minted under Admin › Cloud (`POST /api/admin/cloud/gpu-pools/:id/enrolments`, shown once).
