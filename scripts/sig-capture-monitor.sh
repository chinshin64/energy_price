#!/bin/bash
# Signature capture monitor - runs on 172 server
# Checks mitmproxy capture stats and extracts new signatures

SESSION_DIR="/Users/didi/fyl/data_for_didi/data/capture-sessions/capture-1781614008"
CORPUS_PATH="/Users/didi/fyl/data_for_didi/data/didi-signature-corpus.json"
STATS_PATH="${SESSION_DIR}/stats2.json"
LOG="/tmp/sig-capture-monitor.log"

echo "$(date): Starting signature capture monitor" >> "$LOG"

# Check mitmdump is running
if ! pgrep -f mitmdump > /dev/null; then
    echo "$(date): WARNING: mitmdump not running!" >> "$LOG"
    echo "STATUS: mitmdump NOT RUNNING"
else
    PID=$(pgrep -f mitmdump | head -1)
    echo "STATUS: mitmdump running (PID=$PID)"
fi

# Check upstream proxy
if lsof -i :10808 > /dev/null 2>&1; then
    echo "PROXY: xray upstream on 10808 OK"
else
    echo "PROXY: xray upstream on 10808 NOT RUNNING"
fi

# Check frp tunnel
if pgrep -f frpc > /dev/null; then
    echo "TUNNEL: frpc running"
else
    echo "TUNNEL: frpc NOT RUNNING"
fi

# Show stats
if [ -f "$STATS_PATH" ]; then
    echo "STATS:"
    python3 -c "
import json
s = json.load(open(\"$STATS_PATH\"))
rc = s[\"requestCount\"]
rd = s[\"recordedCount\"]
en = s.get(\"hosts\",{}).get(\"energy.xiaojukeji.com\",0)
lr = s.get(\"lastRequestAt\",\"none\")
print(\"  total_requests: %d\" % rc)
print(\"  recorded: %d\" % rd)
print(\"  energy: %d\" % en)
print(\"  lastRequest: %s\" % lr)
"
fi

# Extract signatures from ALL sessions with HAR data (both capture.har and session.har)
python3 << 'PYEOF'
import json, os
from datetime import datetime

corpus_path = "/Users/didi/fyl/data_for_didi/data/didi-signature-corpus.json"
sessions_dir = "/Users/didi/fyl/data_for_didi/data/capture-sessions"

try:
    corpus = json.load(open(corpus_path))
    existing = corpus.get("entries", [])
except:
    existing = []
    corpus = {"meta": {}, "entries": []}

existing_set = set()
for s in existing:
    w = s.get("wsgsig", "")
    if not w and "queryParams" in s:
        w = s["queryParams"].get("wsgsig", "")
    if not w and s.get("queryParams_wsgsig", ""):
        w = s["queryParams_wsgsig"]
    existing_set.add(w)

new_total = 0
for sess in sorted(os.listdir(sessions_dir)):
    for har_name in ["capture.har", "session.har"]:
        har_path = os.path.join(sessions_dir, sess, har_name)
        if not os.path.exists(har_path):
            continue
        try:
            har = json.load(open(har_path))
            entries = har.get("log", {}).get("entries", [])
            energy_entries = [e for e in entries if "energy.xiaojukeji.com" in e.get("request", {}).get("url", "")]
            for e in energy_entries:
                url = e.get("request", {}).get("url", "")
                method = e.get("request", {}).get("method", "")
                qs = e.get("request", {}).get("queryString", [])
                wsgsig = ""
                for q in qs:
                    if q.get("name", "") == "wsgsig":
                        wsgsig = q.get("value", "")
                if wsgsig and wsgsig != "test" and wsgsig not in existing_set:
                    existing.append({
                        "url": url.split("?")[0],
                        "method": method,
                        "wsgsig": wsgsig,
                        "captured_at": e.get("startedDateTime", ""),
                        "source": "mitmproxy-172-wechat",
                        "session": sess
                    })
                    existing_set.add(wsgsig)
                    new_total += 1
        except Exception as ex:
            pass

if new_total > 0:
    corpus["entries"] = existing
    corpus["meta"]["lastUpdated"] = datetime.now().isoformat()
    with open(corpus_path, "w") as f:
        json.dump(corpus, f, ensure_ascii=False, indent=2)

print("CORPUS: %d entries (%d new)" % (len(existing), new_total))
PYEOF
