#!/usr/bin/env python3
"""Grafana webhook -> chart -> Slack. The image step only: Grafana still evaluates all rules and
sends the alert here; this queries Prometheus for the alert's series, renders it with matplotlib,
and uploads it to Slack via the CURRENT files API (files.getUploadURLExternal + completeUpload).
This sidesteps Grafana's built-in Slack image path, which is broken across these versions (Slack
retired files.upload; the image-renderer/Grafana pairing 408s).

Env: SLACK_BOT_TOKEN, SLACK_CHANNEL, PROM_URL (default http://prometheus:9090). Serves :9878."""
import http.server, json, os, io, time, urllib.request, urllib.parse

TOKEN = os.environ["SLACK_BOT_TOKEN"]
CHANNEL = os.environ.get("SLACK_CHANNEL", "C0BUGK1G7CZ")
PROM = os.environ.get("PROM_URL", "http://prometheus:9090")

# alert label `kind` -> (PromQL, y-axis label, optional threshold)
QUERIES = {
    "cpu":           ("node_load1", "load (1m)", None),
    "memory":        ("100*(1-node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes)", "host mem %", 85),
    "container-mem": ('max(container_memory_working_set_bytes{name=~"eris-.*"}/container_spec_memory_limit_bytes)*100', "container mem %", 90),
    "crash":         ("ascon_agent_crashes_total", "crashes", None),
    "chain":         ("ascon_chain_up", "chain up", None),
}

def prom_range(expr, minutes=20, step=15):
    end = int(time.time()); start = end - minutes * 60
    qs = urllib.parse.urlencode({"query": expr, "start": start, "end": end, "step": step})
    with urllib.request.urlopen(f"{PROM}/api/v1/query_range?{qs}", timeout=10) as r:
        d = json.load(r)
    return d.get("data", {}).get("result", [])

def chart(expr, ylabel, thr, title):
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    res = prom_range(expr)
    fig, ax = plt.subplots(figsize=(7, 3.2))
    for s in res[:12]:
        xs = [float(v[0]) for v in s["values"]]
        ys = [float(v[1]) for v in s["values"]]
        x0 = xs[0] if xs else 0
        lbl = s["metric"].get("name") or s["metric"].get("instance") or ""
        ax.plot([(x - x0) / 60 for x in xs], ys, lw=1.6, label=lbl[:22])
    if thr is not None:
        ax.axhline(thr, ls="--", lw=1, color="#d1495b")
    ax.set_title(title); ax.set_xlabel("minutes"); ax.set_ylabel(ylabel); ax.grid(alpha=.25)
    if res and res[0]["metric"].get("name"):
        ax.legend(fontsize=7, ncol=2)
    buf = io.BytesIO(); fig.tight_layout(); fig.savefig(buf, format="png", dpi=120); plt.close(fig)
    return buf.getvalue()

def slack_post_image(png, filename, comment):
    # 1) reserve an upload URL
    qs = urllib.parse.urlencode({"filename": filename, "length": len(png)})
    req = urllib.request.Request(f"https://slack.com/api/files.getUploadURLExternal?{qs}",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
    up = json.load(urllib.request.urlopen(req, timeout=10))
    if not up.get("ok"): print("getUploadURL failed:", up, flush=True); return slack_post_text(comment)
    # 2) PUT the bytes
    urllib.request.urlopen(urllib.request.Request(up["upload_url"], data=png, method="POST"), timeout=15).read()
    # 3) complete, attaching to the channel with the alert text as the comment
    body = json.dumps({"files": [{"id": up["file_id"], "title": filename}],
                       "channel_id": CHANNEL, "initial_comment": comment}).encode()
    req = urllib.request.Request("https://slack.com/api/files.completeUploadExternal", data=body,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=10))
    print("completeUpload ok=" + str(r.get("ok")), r.get("error", ""), flush=True)

def slack_post_text(text):
    body = json.dumps({"channel": CHANNEL, "text": text}).encode()
    req = urllib.request.Request("https://slack.com/api/chat.postMessage", data=body,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=10)); print("chat.postMessage ok=" + str(r.get("ok")), flush=True)

def handle_alert(a):
    lbls = a.get("labels", {}); ann = a.get("annotations", {})
    status = a.get("status", "firing"); kind = lbls.get("kind", "cpu")
    name = lbls.get("alertname", "alert")
    emoji = ":rotating_light:" if status == "firing" else ":white_check_mark:"
    comment = f"{emoji} *{name}* [{status}]\n{ann.get('summary', '')}"
    expr, ylabel, thr = QUERIES.get(kind, QUERIES["cpu"])
    try:
        png = chart(expr, ylabel, thr, f"{name} ({status})")
        slack_post_image(png, f"{kind}-{int(time.time())}.png", comment)
    except Exception as e:
        print("chart/upload failed, text fallback:", e, flush=True); slack_post_text(comment)

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            payload = {}
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
        for a in payload.get("alerts", []):
            try: handle_alert(a)
            except Exception as e: print("handle_alert error:", e, flush=True)
    def log_message(self, *a): pass

if __name__ == "__main__":
    print(f"alertimg webhook on :9878 -> Slack {CHANNEL} (prom={PROM})", flush=True)
    http.server.HTTPServer(("0.0.0.0", 9878), H).serve_forever()
