#!/usr/bin/env python3
"""ASCON domain exporter -> Prometheus. Turns the run's files + the chain RPC into metrics so the
same Grafana/alerting stack that handles CPU/memory also handles ASCON-specific signals:
  ascon_tx_total, ascon_unique_users, ascon_agents_active, ascon_agent_crashes_total,
  ascon_round_lag, ascon_epoch_index, ascon_chain_up, ascon_chain_block_number
Recomputed at most every ~10s (blocks.csv can be large). Writes a Prometheus textfile that node_exporter serves."""
import json, os, glob, urllib.request, time

RUNS = os.environ.get("ASCON_RUNS", "/runs")
RPC = os.environ.get("ASCON_RPC", "http://127.0.0.1:8545")
TEXTFILE = os.environ.get("ASCON_TEXTFILE", "/textfile/ascon.prom")

def latest_run():
    ds = glob.glob(RUNS + "/*/")
    return max(ds, key=os.path.getmtime).rstrip("/") if ds else None

def collect():
    crashes = lag = flow_tx = agent_tx = 0
    agents = set()
    epoch = -1
    run = latest_run()
    if run:
        # LIVE sources (blocks.csv trails/populates late). events.jsonl carries the environment's
        # order-flow txs (ownerId flow-*), crashes and round timing; each agents/<id>.jsonl carries
        # that competing agent's own submissions.
        ev = os.path.join(run, "events.jsonl")
        if os.path.exists(ev):
            with open(ev) as f:
                for ln in f:
                    if '"tx_submitted"' in ln:
                        flow_tx += 1
                    elif '"agent_process_exited"' in ln:
                        crashes += 1
                    elif '"round_timing"' in ln:
                        try: lag += max(0, json.loads(ln).get("blocksCaughtUp", 0) - 1)
                        except Exception: pass
        for af in glob.glob(os.path.join(run, "agents", "*.jsonl")):
            n = 0
            try:
                with open(af) as f:
                    for ln in f:
                        if '"event":"submitted"' in ln: n += 1
            except Exception: continue
            if n > 0:
                agent_tx += n
                agents.add(os.path.basename(af)[:-6])   # strip .jsonl
        ep = os.path.join(run, "epochs.jsonl")
        if os.path.exists(ep):
            with open(ep) as f:
                for ln in f:
                    if ln.strip():
                        try: epoch = json.loads(ln)["index"]
                        except Exception: pass
    tx = flow_tx + agent_tx
    up, bn = 0, 0
    try:
        req = urllib.request.Request(RPC, data=json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}).encode(),
            headers={"content-type": "application/json"})
        bn = int(json.loads(urllib.request.urlopen(req, timeout=3).read())["result"], 16); up = 1
    except Exception: pass
    return {"ascon_tx_total": tx, "ascon_flow_tx_total": flow_tx, "ascon_agent_tx_total": agent_tx,
            "ascon_unique_users": len(agents), "ascon_agents_active": len(agents),
            "ascon_agent_crashes_total": crashes, "ascon_round_lag": lag, "ascon_epoch_index": epoch,
            "ascon_chain_up": up, "ascon_chain_block_number": bn}

def write_textfile():
    """Atomically write the Prometheus textfile that node_exporter's textfile collector serves.
    (Delivering via a shared file avoids scraping this host-networked process across the host
    firewall; host networking is only needed so it can reach anvil on 127.0.0.1.)"""
    m = collect()
    tmp = TEXTFILE + ".tmp"
    os.makedirs(os.path.dirname(TEXTFILE), exist_ok=True)
    with open(tmp, "w") as f:
        for k, v in m.items():
            f.write(f"# TYPE {k} gauge\n{k} {v}\n")
    os.replace(tmp, TEXTFILE)

if __name__ == "__main__":
    print("ascon exporter -> %s (runs=%s rpc=%s)" % (TEXTFILE, RUNS, RPC), flush=True)
    while True:
        try: write_textfile()
        except Exception as e: print("write error:", e, flush=True)
        time.sleep(10)
