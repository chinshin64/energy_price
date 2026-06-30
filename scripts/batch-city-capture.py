#!/usr/bin/env python3
"""
Batch City Capture - Automated corpus generation for 300+ cities.

Flow per city:
  1. Start mitmdump with upstream:47.111.139.230:50181 + location override
  2. Enable system proxy on 172
  3. Wait for WeChat mini program to make requests (auto or manual refresh)
  4. Stop mitmdump
  5. Run har-to-corpus.py to extract signed request material
  6. Move to next city

Traffic exits through 47.111.139.230 (verified outbound IP).

Usage:
  python3 scripts/batch-city-capture.py [--max-cities N] [--capture-time SECS] [--start-from CITY]
"""

import json
import os
import subprocess
import sys
import time
import signal
import argparse
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
CITY_DB = DATA_DIR / "city-coordinate-database.json"
CORPUS_FILE = DATA_DIR / "didi-signature-corpus.json"
CAPTURE_DIR = DATA_DIR / "capture-sessions"

# 47 proxy (no-auth for 172's source IP)
UPSTREAM_PROXY = "47.111.139.230:50181"

# mitmdump
MITMDUMP_BIN = str(PROJECT_ROOT / ".venv-capture/bin/mitmdump")
HAR_DUMP_SCRIPT = str(PROJECT_ROOT / "scripts/mitm-har-dump.py")
LOCATION_OVERRIDE_SCRIPT = str(PROJECT_ROOT / "scripts/mitm-location-override.py")
HAR_TO_CORPUS_SCRIPT = str(PROJECT_ROOT / "scripts/har-to-corpus.py")


def load_city_nodes(max_cities=999, nodes_per_city=3, start_from=None):
    with open(CITY_DB) as f:
        data = json.load(f)
    
    cities = {}
    for node in data["nodes"]:
        city = node["city"]
        if city not in cities:
            cities[city] = []
        cities[city].append(node)
    
    result = []
    started = not start_from
    count = 0
    
    for city, nodes in cities.items():
        if not started:
            if city == start_from:
                started = True
            else:
                continue
        if count >= max_cities:
            break
        
        step = max(1, len(nodes) // nodes_per_city)
        selected = [nodes[i] for i in range(0, len(nodes), step)][:nodes_per_city]
        for node in selected:
            result.append({
                "city": city,
                "district": node["district"],
                "lat": node["lat"],
                "lng": node["lng"]
            })
        count += 1
    
    return result


def run_cmd(cmd, timeout=30):
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"


def set_system_proxy(enabled, host="127.0.0.1", port=8898):
    state = "on" if enabled else "off"
    run_cmd(f"networksetup -setwebproxystate Wi-Fi {state}")
    run_cmd(f"networksetup -setsecurewebproxystate Wi-Fi {state}")
    if enabled:
        run_cmd(f"networksetup -setwebproxy Wi-Fi {host} {port}")
        run_cmd(f"networksetup -setsecurewebproxy Wi-Fi {host} {port}")


def start_mitmdump(city, lat, lng, listen_port=8898):
    session_id = f"batch-{int(time.time())}-{city}"
    session_dir = CAPTURE_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    
    har_path = session_dir / "session.har"
    stats_path = session_dir / "capture-stats.json"
    log_path = session_dir / "mitmdump.log"
    
    cmd = [
        MITMDUMP_BIN,
        "--listen-host", "0.0.0.0",
        "--listen-port", str(listen_port),
        "--set", "block_global=false",
        "--mode", f"upstream:{UPSTREAM_PROXY}",
        "-s", HAR_DUMP_SCRIPT,
        "--set", f"data_for_didi_har_path={har_path}",
        "--set", f"data_for_didi_stats_path={stats_path}",
        "--set", "data_for_didi_filter_hosts=xiaojukeji.com,didichuxing.com,didiglobal.com",
        "-s", LOCATION_OVERRIDE_SCRIPT,
        "--set", f"data_for_didi_override_city={city}",
        "--set", f"data_for_didi_override_lat={lat}",
        "--set", f"data_for_didi_override_lng={lng}",
    ]
    
    log_file = open(log_path, "w")
    proc = subprocess.Popen(cmd, stdout=log_file, stderr=log_file)
    
    return proc, session_id, str(har_path), str(stats_path)


def stop_mitmdump(proc):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=3)


def extract_corpus(har_path):
    if not os.path.exists(har_path) or os.path.getsize(har_path) < 1000:
        return 0
    
    cmd = ["python3", HAR_TO_CORPUS_SCRIPT, "--har", har_path, "--corpus", str(CORPUS_FILE)]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    
    # Parse output for added count
    for line in result.stdout.split("\n"):
        if "Added entries" in line:
            try:
                return int(line.split(":")[-1].strip())
            except ValueError:
                pass
    return 0


def count_target_requests(har_path):
    if not os.path.exists(har_path):
        return 0
    try:
        with open(har_path) as f:
            har = json.load(f)
        target_hosts = ["xiaojukeji.com", "didichuxing.com", "didiglobal.com"]
        return sum(1 for e in har["log"]["entries"]
                   if any(h in e["request"]["url"] for h in target_hosts))
    except Exception:
        return 0


def main():
    parser = argparse.ArgumentParser(description="Batch city capture")
    parser.add_argument("--max-cities", type=int, default=999)
    parser.add_argument("--nodes-per-city", type=int, default=3)
    parser.add_argument("--capture-time", type=int, default=30, help="Seconds to capture per node")
    parser.add_argument("--start-from", type=str, default=None)
    args = parser.parse_args()
    
    nodes = load_city_nodes(args.max_cities, args.nodes_per_city, args.start_from)
    
    print(f"=== Batch City Capture ===")
    print(f"Total tasks: {len(nodes)}")
    print(f"Upstream proxy: {UPSTREAM_PROXY} (verified 47.111.139.230 outbound)")
    print(f"Capture time per node: {args.capture_time}s")
    print(f"")
    
    total_cities = set()
    total_entries_added = 0
    total_target_requests = 0
    failed_cities = []
    
    for i, node in enumerate(nodes):
        city = node["city"]
        district = node["district"]
        lat = node["lat"]
        lng = node["lng"]
        total_cities.add(city)
        
        print(f"[{i+1}/{len(nodes)}] {city}/{district} (lat={lat}, lng={lng})")
        
        # Start mitmdump
        proc, session_id, har_path, stats_path = start_mitmdump(city, lat, lng)
        time.sleep(2)
        
        # Enable system proxy
        set_system_proxy(True, port=8898)
        
        # Wait for capture
        print(f"  Capturing for {args.capture_time}s... (refresh mini program if needed)")
        time.sleep(args.capture_time)
        
        # Disable system proxy
        set_system_proxy(False)
        
        # Stop mitmdump
        stop_mitmdump(proc)
        time.sleep(2)
        
        # Count target requests
        target_reqs = count_target_requests(har_path)
        total_target_requests += target_reqs
        
        # Extract corpus
        entries_added = extract_corpus(har_path)
        total_entries_added += entries_added
        
        status = "OK" if target_reqs > 0 else "NO_DATA"
        print(f"  {status}: target_requests={target_reqs}, corpus_entries_added={entries_added}")
        
        if target_reqs == 0:
            failed_cities.append(city)
        
        # Small delay between cities
        time.sleep(2)
    
    print(f"\n=== Batch Capture Complete ===")
    print(f"Cities processed: {len(total_cities)}")
    print(f"Total target requests: {total_target_requests}")
    print(f"Total corpus entries added: {total_entries_added}")
    print(f"Failed cities (no data): {len(failed_cities)}")
    if failed_cities:
        print(f"  First 10: {failed_cities[:10]}")


if __name__ == "__main__":
    main()
