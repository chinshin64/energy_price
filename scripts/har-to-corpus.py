#!/usr/bin/env python3
"""
HAR/JSONL -> corpus merge script.

Merges mitmproxy-captured JSONL or Charles-exported HAR into existing
corpus.json with dedup, keep-latest, and atomic write.

Usage:
    python har-to-corpus.py --jsonl signatures.jsonl --corpus data/didi-signature-corpus.json
    python har-to-corpus.py --har session.har --corpus data/didi-signature-corpus.json
    python har-to-corpus.py --jsonl signatures.jsonl --corpus data/didi-signature-corpus.json --out data/corpus-new.json
"""

import argparse
import json
import math
import os
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlsplit


TARGET_CITIES = [
    {"city": "\u6b66\u6c49\u5e02", "lat": 30.5928, "lng": 114.3055},
    {"city": "\u4e0a\u6d77\u5e02", "lat": 31.2304, "lng": 121.4737},
    {"city": "\u897f\u5b89\u5e02", "lat": 34.3416, "lng": 108.9398},
    {"city": "\u5357\u4eac\u5e02", "lat": 32.0603, "lng": 118.7969},
]

LIST_PATH = "/station-api/homepage/stationlist"
DETAIL_PATH = "/station-api/station/getoneinfo"


def distance_km(lat1, lng1, lat2, lng2):
    radius = 6371
    to_rad = math.pi / 180
    dlat = (lat2 - lat1) * to_rad
    dlng = (lng2 - lng1) * to_rad
    value = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1 * to_rad) * math.cos(lat2 * to_rad) * math.sin(dlng / 2) ** 2
    )
    return 2 * radius * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def match_nearest_city(lat, lng):
    best = None
    best_dist = float("inf")
    for target in TARGET_CITIES:
        d = distance_km(lat, lng, target["lat"], target["lng"])
        if d < best_dist:
            best_dist = d
            best = target["city"]
    return best if best_dist <= 50 else None


# ── JSONL ──────────────────────────────────────────────────────────

def load_jsonl(path):
    entries = []
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"  [warn] JSONL line {line_no} parse error: {exc}", file=sys.stderr)
                continue
            if isinstance(obj, dict):
                entries.append(obj)
    return entries


# ── HAR (Charles-compatible) ───────────────────────────────────────

def load_har(path):
    with open(path, encoding="utf-8") as f:
        har = json.load(f)

    log = har.get("log", har)
    har_entries = log.get("entries", [])

    entries = []
    for har_entry in har_entries:
        try:
            entry = _convert_har_entry(har_entry)
            if entry is not None:
                entries.append(entry)
        except Exception:
            pass

    return entries


def _convert_har_entry(har_entry):
    req = har_entry.get("request", {})
    url = req.get("url", "")
    path = urlsplit(url).path.lower()

    if LIST_PATH not in path and DETAIL_PATH not in path:
        return None

    qp_list = req.get("queryString", [])
    qp = {item["name"]: item["value"] for item in qp_list if isinstance(item, dict)}

    if "wsgsig" not in qp:
        return None

    method = req.get("method", "GET").upper()
    scope = "list" if LIST_PATH in path else "detail"

    body = {}
    post_data = req.get("postData", {})
    if isinstance(post_data, dict):
        text = post_data.get("text", "")
        if text:
            try:
                body = json.loads(text)
                if not isinstance(body, dict):
                    body = {}
            except (json.JSONDecodeError, TypeError):
                body = {}

    headers = {}
    for h in req.get("headers", []):
        if isinstance(h, dict):
            key = h.get("name", "").lower()
            if key in ("content-type", "user-agent", "referer", "xweb_xhr"):
                headers[key] = h.get("value", "")

    if scope == "list":
        try:
            lat = float(body.get("lat") or qp.get("lat") or 0)
            lng = float(body.get("lng") or qp.get("lng") or 0)
        except (ValueError, TypeError):
            return None
        if lat == 0 and lng == 0:
            return None
        city = match_nearest_city(lat, lng) or ""
        target_lat = next((t["lat"] for t in TARGET_CITIES if t["city"] == city), lat)
        target_lng = next((t["lng"] for t in TARGET_CITIES if t["city"] == city), lng)
        entry = {
            "platform": "didi-charging",
            "scope": "list",
            "method": method,
            "baseUrl": url.split("?")[0],
            "city": city,
            "keyword": city,
            "targetLat": target_lat,
            "targetLng": target_lng,
            "lat": lat,
            "lng": lng,
            "pageNo": int(body.get("pageNo", 1)),
            "pageSize": int(body.get("pageSize", 10)),
            "sampleDistanceKm": round(distance_km(lat, lng, target_lat, target_lng), 4) if city else 0,
            "capturedAt": har_entry.get("startedDateTime", ""),
            "source": "har-import",
            "hasToken": bool(body.get("token") or body.get("ticket") or qp.get("ticket") or qp.get("_waf_token")),
            "replayable": True,
            "queryParams": qp,
            "bodyParams": body,
            "headers": headers,
        }
    else:
        try:
            lat = float(qp.get("lat") or 0)
            lng = float(qp.get("lng") or 0)
        except (ValueError, TypeError):
            return None
        if lat == 0 and lng == 0:
            return None
        city = match_nearest_city(lat, lng) or ""
        target_lat = next((t["lat"] for t in TARGET_CITIES if t["city"] == city), lat)
        target_lng = next((t["lng"] for t in TARGET_CITIES if t["city"] == city), lng)
        station_id = (
            qp.get("fullstationid")
            or qp.get("fullStationId")
            or qp.get("stationId")
            or qp.get("stationid")
            or ""
        )
        entry = {
            "platform": "didi-charging",
            "scope": "detail",
            "method": method,
            "baseUrl": url.split("?")[0],
            "city": city,
            "keyword": city,
            "targetLat": target_lat,
            "targetLng": target_lng,
            "lat": lat,
            "lng": lng,
            "stationId": station_id,
            "fullStationId": station_id,
            "sampleDistanceKm": round(distance_km(lat, lng, target_lat, target_lng), 4) if city else 0,
            "capturedAt": har_entry.get("startedDateTime", ""),
            "source": "har-import",
            "hasToken": bool(qp.get("ticket") or qp.get("_waf_token")),
            "replayable": True,
            "queryParams": qp,
            "bodyParams": {},
            "headers": headers,
        }

    return entry


# ── Dedup keys ─────────────────────────────────────────────────────

def dedup_key(entry):
    scope = entry.get("scope", "")
    city = entry.get("city", "")
    wsgsig = entry.get("queryParams", {}).get("wsgsig", "")
    if scope == "list":
        page = str(entry.get("pageNo", 1))
        return (scope, city, page, wsgsig)
    station = entry.get("stationId") or entry.get("fullStationId") or ""
    return (scope, city, station, wsgsig)


def group_key(entry):
    scope = entry.get("scope", "")
    city = entry.get("city", "")
    if scope == "list":
        return (scope, city, str(entry.get("pageNo", 1)))
    station = entry.get("stationId") or entry.get("fullStationId") or ""
    return (scope, city, station)


def parse_captured_at(value):
    """Parse capturedAt into a sortable string, supporting multiple formats."""
    s = str(value or "").strip()
    if not s:
        return ""
    import datetime
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f%z"):
        try:
            dt = datetime.datetime.strptime(s, fmt)
            return dt.strftime("%Y%m%d%H%M%S")
        except ValueError:
            continue
    return s


# ── Merge ──────────────────────────────────────────────────────────

def merge_corpus(existing_entries, new_entries, max_per_group=3):
    seen = {}  # dedup_key -> entry

    for entry in existing_entries:
        key = dedup_key(entry)
        existing = seen.get(key)
        if existing is None:
            seen[key] = entry
        else:
            if parse_captured_at(entry.get("capturedAt")) > parse_captured_at(existing.get("capturedAt")):
                seen[key] = entry

    new_count = 0
    dup_in_new = 0
    for entry in new_entries:
        key = dedup_key(entry)
        if key in seen:
            existing = seen[key]
            if parse_captured_at(entry.get("capturedAt")) > parse_captured_at(existing.get("capturedAt")):
                seen[key] = entry
            dup_in_new += 1
        else:
            seen[key] = entry
            new_count += 1

    groups = defaultdict(list)
    for entry in seen.values():
        groups[group_key(entry)].append(entry)

    pruned_count = 0
    final_entries = []
    for group_entries in groups.values():
        group_entries.sort(key=lambda e: parse_captured_at(e.get("capturedAt")), reverse=True)
        if len(group_entries) > max_per_group:
            pruned_count += len(group_entries) - max_per_group
        final_entries.extend(group_entries[:max_per_group])

    stats = {
        "existingCount": len(existing_entries),
        "newInputCount": len(new_entries),
        "addedCount": new_count,
        "duplicateCount": dup_in_new,
        "prunedCount": pruned_count,
        "finalCount": len(final_entries),
    }
    return final_entries, stats


# ── Atomic write ───────────────────────────────────────────────────

def atomic_write_json(path, data):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(data, ensure_ascii=False, indent=2)

    fd, tmp_path = tempfile.mkstemp(
        dir=str(target.parent),
        prefix=".corpus-tmp-",
        suffix=".json",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, str(target))
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Main ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Merge JSONL/HAR signatures into corpus.json")
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--jsonl", help="mitmproxy JSONL file path")
    source_group.add_argument("--har", help="Charles HAR file path")
    parser.add_argument("--corpus", required=True, help="Existing corpus.json path")
    parser.add_argument("--out", default="", help="Output path (default: in-place update)")
    parser.add_argument("--max-per-group", type=int, default=3, help="Max entries per group")
    args = parser.parse_args()

    out_path = args.out.strip() or args.corpus

    # 1. Load existing corpus
    existing_entries = []
    existing_meta = {}
    if Path(args.corpus).exists():
        print(f"Loading existing corpus: {args.corpus}")
        with open(args.corpus, encoding="utf-8") as f:
            payload = json.load(f)
        if isinstance(payload, dict):
            existing_meta = payload.get("meta", {})
            existing_entries = payload.get("entries", [])
        elif isinstance(payload, list):
            existing_entries = payload
        print(f"  Existing entries: {len(existing_entries)}")
    else:
        print(f"Corpus file not found, will create: {args.corpus}")

    # 2. Load new entries
    if args.jsonl:
        print(f"Loading JSONL: {args.jsonl}")
        new_entries = load_jsonl(args.jsonl)
    else:
        print(f"Loading HAR: {args.har}")
        new_entries = load_har(args.har)
    print(f"  New input entries: {len(new_entries)}")

    # 3. Merge
    merged, stats = merge_corpus(existing_entries, new_entries, args.max_per_group)

    # 4. Update meta
    meta = existing_meta.copy() if existing_meta else {}
    meta["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    meta["lastMergeSource"] = "jsonl" if args.jsonl else "har"
    meta["lastMergeFile"] = str(Path(args.jsonl or args.har).resolve())

    output = {"meta": meta, "entries": merged}

    # 5. Atomic write
    print(f"Atomic write: {out_path}")
    atomic_write_json(out_path, output)

    # 6. Stats
    print()
    print("-- Merge Stats ---------------------")
    print(f"  Existing entries:  {stats['existingCount']}")
    print(f"  New input entries: {stats['newInputCount']}")
    print(f"  Added entries:     {stats['addedCount']}")
    print(f"  Duplicate entries: {stats['duplicateCount']}")
    print(f"  Pruned entries:    {stats['prunedCount']}")
    print(f"  Final total:       {stats['finalCount']}")
    print("------------------------------------")


if __name__ == "__main__":
    main()
