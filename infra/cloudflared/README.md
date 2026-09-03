# cloudflared tunnel config (mirror)

`config.yml` here is the **source-of-truth mirror** of the cloudflared ingress that runs on
gohanserver. The live file is `/root/.cloudflared/config.yml` (root-owned, outside this repo), read at
startup by the `cloudflared` systemd unit (`ExecStart=cloudflared tunnel run gohanserver`, defined in
the box's `/etc/nixos/configuration.nix`). NixOS manages only that unit — it does **not** generate the
ingress file, so this file is the only place the routes/ports live. Keep this mirror in sync by hand.

## Port map

| public hostname | tunnel forwards to | what |
|---|---|---|
| `ascon-monitor.nyx.foundation` | `localhost:3000` | Grafana (`infra/monitoring`) |
| `ascon-rpc.nyx.foundation` | `localhost:8546` | RPC gateway (`infra/rpc-gateway`) → anvil `:8545` |

`ascon-rpc` points at the **gateway (8546)**, not anvil directly (8545), so every external RPC call is
metered (method / latency / caller). Auth is Cloudflare Access with a per-caller **service token**; the
gateway logs the token's `common_name` as the caller identity.

## Deploy a change

```bash
# edit config.yml here, then push it to the box and reload:
scp infra/cloudflared/config.yml gohan@gohanserver:/tmp/cf-config.yml
ssh -t gohan@gohanserver "sudo sh -c 'cp /tmp/cf-config.yml /root/.cloudflared/config.yml && systemctl restart cloudflared'"
```

The remote (dashboard/API) tunnel configuration is kept equal to this file so the two never disagree;
because a local config with `ingress:` wins, this file is authoritative.
