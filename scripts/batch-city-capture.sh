#!/bin/bash
# batch-city-capture.sh
# Batch capture for all cities in city-coordinate-database.json
# Routes traffic through 47.111.139.230:50180 (tinyproxy)
#
# Usage:
#   ./scripts/batch-city-capture.sh [--start-from CITY_NAME] [--max-cities N] [--nodes-per-city N]
#
# Prerequisites:
#   1. WeChat mini program open on 172 with system proxy configured
#   2. mitmdump + mitm-location-override.py available
#   3. 47.111.139.230:50180 accessible from the execution host

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"
CORPUS_FILE="$DATA_DIR/didi-signature-corpus.json"
CITY_DB="$DATA_DIR/city-coordinate-database.json"
CAPTURE_DIR="$DATA_DIR/capture-sessions"

# Proxy config (47.111.139.230 outbound)
UPSTREAM_PROXY="47.111.139.230:50181"

# mitmdump config
MITMDUMP_BIN="$PROJECT_ROOT/.venv-capture/bin/mitmdump"
HAR_DUMP_SCRIPT="$PROJECT_ROOT/scripts/mitm-har-dump.py"
LOCATION_OVERRIDE_SCRIPT="$PROJECT_ROOT/scripts/mitm-location-override.py"
HAR_TO_CORPUS="$PROJECT_ROOT/scripts/har-to-corpus.py"

# API config
API_BASE="http://127.0.0.1:50080"

# Defaults
START_FROM=""
MAX_CITIES=999
NODES_PER_CITY=3  # For batch, pick 3 representative nodes per city
CAPTURE_DURATION=30  # seconds per node

while [[ $# -gt 0 ]]; do
    case $1 in
        --start-from) START_FROM="$2"; shift 2 ;;
        --max-cities) MAX_CITIES="$2"; shift 2 ;;
        --nodes-per-city) NODES_PER_CITY="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

echo "=== Batch City Capture ==="
echo "Project: $PROJECT_ROOT"
echo "Upstream proxy: 47.111.139.230:50180"
echo "Max cities: $MAX_CITIES"
echo "Nodes per city: $NODES_PER_CITY"
echo ""

# Extract cities and nodes from database
CITY_LIST=$(python3 -c "
import json, sys
with open('$CITY_DB') as f:
    data = json.load(f)
cities = {}
for node in data['nodes']:
    city = node['city']
    if city not in cities:
        cities[city] = []
    cities[city].append((node['lat'], node['lng'], node['district']))

started = '$START_FROM' != ''
count = 0
for city, nodes in cities.items():
    if started and city != '$START_FROM':
        continue
    started = True
    if count >= $MAX_CITIES:
        break
    # Pick evenly spaced representative nodes
    step = max(1, len(nodes) // $NODES_PER_CITY)
    selected = [nodes[i] for i in range(0, len(nodes), step)][:$NODES_PER_CITY]
    for lat, lng, district in selected:
        print(f'{city}|{district}|{lat}|{lng}')
    count += 1
")

if [ -z "$CITY_LIST" ]; then
    echo "No cities to process"
    exit 0
fi

TOTAL_LINES=$(echo "$CITY_LIST" | wc -l | tr -d ' ')
echo "Total capture tasks: $TOTAL_LINES"
echo ""

# Process each node
CURRENT=0
for line in $CITY_LIST; do
    CURRENT=$((CURRENT + 1))
    IFS='|' read -r CITY DISTRICT LAT LNG <<< "$line"
    
    echo "[$CURRENT/$TOTAL_LINES] Capturing: $CITY / $DISTRICT (lat=$LAT, lng=$LNG)"
    
    SESSION_ID="batch-$(date +%s)-$CITY-$DISTRICT"
    SESSION_DIR="$CAPTURE_DIR/$SESSION_ID"
    mkdir -p "$SESSION_DIR"
    HAR_PATH="$SESSION_DIR/session.har"
    STATS_PATH="$SESSION_DIR/capture-stats.json"
    LOG_PATH="$SESSION_DIR/mitmdump.log"
    
    # Start mitmdump with location override + upstream proxy
    $MITMDUMP_BIN \
        --listen-host 0.0.0.0 \
        --listen-port 8899 \
        --set block_global=false \
        --mode upstream=$UPSTREAM_PROXY \
        -s "$HAR_DUMP_SCRIPT" \
        --set "data_for_didi_har_path=$HAR_PATH" \
        --set "data_for_didi_stats_path=$STATS_PATH" \
        --set data_for_didi_filter_hosts=xiaojukeji.com,didichuxing.com,didiglobal.com \
        --set data_for_didi_filter_ips= \
        --set data_for_didi_block_hosts=google.com,googleapis.com \
        -s "$LOCATION_OVERRIDE_SCRIPT" \
        --set "data_for_didi_override_city=$CITY" \
        --set "data_for_didi_override_lat=$LAT" \
        --set "data_for_didi_override_lng=$LNG" \
        > "$LOG_PATH" 2>&1 &
    
    MITMDUMP_PID=$!
    echo "  mitmdump started (PID=$MITMDUMP_PID, upstream=47.111.139.230:50180)"
    
    # Wait for capture duration
    sleep $CAPTURE_DURATION
    
    # Stop mitmdump
    kill $MITMDUMP_PID 2>/dev/null || true
    wait $MITMDUMP_PID 2>/dev/null || true
    sleep 2
    
    # Check if HAR was created and has content
    HAR_SIZE=$(stat -f%z "$HAR_PATH" 2>/dev/null || echo 0)
    TARGET_REQUESTS=0
    
    if [ "$HAR_SIZE" -gt 1000 ]; then
        # Extract corpus from HAR
        python3 "$HAR_TO_CORPUS" \
            --har "$HAR_PATH" \
            --corpus "$CORPUS_FILE" \
            2>&1 | tail -5
        
        # Count target requests
        TARGET_REQUESTS=$(python3 -c "
import json
try:
    with open('$HAR_PATH') as f:
        har = json.load(f)
    target = sum(1 for e in har['log']['entries']
                 if any(h in e['request']['url'] for h in ['xiaojukeji.com', 'didichuxing.com', 'didiglobal.com']))
    print(target)
except:
    print(0)
")
    fi
    
    echo "  Result: HAR=${HAR_SIZE}B, target_requests=$TARGET_REQUESTS"
    echo ""
done

echo "=== Batch Capture Complete ==="
echo "Corpus file: $CORPUS_FILE"

# Final corpus stats
python3 -c "
import json
with open('$CORPUS_FILE') as f:
    corpus = json.load(f)
entries = corpus.get('entries', [])
from collections import Counter
cities = Counter(e.get('city', 'unknown') for e in entries)
print(f'Total entries: {len(entries)}')
print(f'Cities covered: {len(cities)}')
print(f'Top 10 cities:')
for city, count in cities.most_common(10):
    print(f'  {city}: {count}')
"
