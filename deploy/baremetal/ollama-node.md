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
