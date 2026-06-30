#!/usr/bin/env python3
"""
mitmproxy addon — 自动捕获滴滴充电签名请求，输出 JSONL。

用法:
    mitmdump -s mitm-signature-capture.py --set outfile=signatures.jsonl

拦截 energy.xiaojukeji.com 域名下带 wsgsig 参数的请求，
对 list (/station-api/homepage/stationList) 和
detail (/station-api/station/getoneinfo) 分别提取完整签名信息。
"""

import json
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from mitmproxy import ctx, http


# ── 目标城市列表 ──────────────────────────────────────────────────
TARGET_CITIES = [
    {"city": "武汉市", "lat": 30.5928, "lng": 114.3055},
    {"city": "上海市", "lat": 31.2304, "lng": 121.4737},
    {"city": "西安市", "lat": 34.3416, "lng": 108.9398},
    {"city": "南京市", "lat": 32.0603, "lng": 118.7969},
]

TARGET_DOMAIN = "energy.xiaojukeji.com"
LIST_PATH = "/station-api/homepage/stationlist"
DETAIL_PATH = "/station-api/station/getoneinfo"

CST = timezone(timedelta(hours=8))


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


def query_params_from_url(url):
    qs = urlsplit(url).query
    return {k: v[-1] for k, v in parse_qs(qs, keep_blank_values=True).items()} if qs else {}


def has_token(query_params, body_params):
    for container in (query_params, body_params):
        for key in ("token", "ticket", "_waf_token"):
            if container.get(key):
                return True
    return False


class SignatureCapture:
    def __init__(self):
        self.outfile = ""
        self.capture_count = 0
        self.skip_count = 0

    def load(self, loader):
        loader.add_option(
            name="outfile",
            typespec=str,
            default="signatures.jsonl",
            help="JSONL 输出文件路径",
        )

    def configure(self, updates):
        self.outfile = str(ctx.options.outfile or "signatures.jsonl").strip()
        ctx.log.info(f"[signature-capture] outfile = {self.outfile}")

    def response(self, flow):
        request = flow.request
        host = (getattr(request, "pretty_host", "") or "").lower()
        if TARGET_DOMAIN not in host:
            return

        url = request.pretty_url
        path = urlsplit(url).pathname if hasattr(urlsplit(url), "pathname") else urlsplit(url).path
        path_lower = path.lower()
        if LIST_PATH not in path_lower and DETAIL_PATH not in path_lower:
            return

        qp = query_params_from_url(url)
        if "wsgsig" not in qp:
            self.skip_count += 1
            return

        scope = "list" if LIST_PATH in path_lower else "detail"
        method = request.method.upper()

        try:
            entry = self._build_entry(request, scope, method, qp)
        except Exception as exc:
            ctx.log.warn(f"[signature-capture] build entry failed: {exc}")
            return

        if entry is None:
            self.skip_count += 1
            return

        self._append_jsonl(entry)
        self.capture_count += 1
        ctx.log.info(
            f"[signature-capture] #{self.capture_count} {scope} {method} "
            f"city={entry.get('city')} wsgsig={qp['wsgsig'][:12]}..."
        )

    def _build_entry(self, request, scope, method, qp):
        if scope == "list":
            return self._build_list_entry(request, method, qp)
        return self._build_detail_entry(request, method, qp)

    def _build_list_entry(self, request, method, qp):
        body_raw = (request.get_text() or "").strip()
        body = {}
        if body_raw:
            try:
                body = json.loads(body_raw)
            except (json.JSONDecodeError, TypeError):
                return None
            if not isinstance(body, dict):
                return None

        try:
            lat = float(body.get("lat") or qp.get("lat") or 0)
            lng = float(body.get("lng") or qp.get("lng") or 0)
        except (ValueError, TypeError):
            return None

        if lat == 0 and lng == 0:
            return None

        city = match_nearest_city(lat, lng) or ""
        now_cst = datetime.now(CST).strftime("%Y/%m/%d %H:%M:%S")
        target_lat = next((t["lat"] for t in TARGET_CITIES if t["city"] == city), lat)
        target_lng = next((t["lng"] for t in TARGET_CITIES if t["city"] == city), lng)

        return {
            "platform": "didi-charging",
            "scope": "list",
            "method": method,
            "baseUrl": request.pretty_url.split("?")[0],
            "city": city,
            "keyword": city,
            "targetLat": target_lat,
            "targetLng": target_lng,
            "lat": lat,
            "lng": lng,
            "pageNo": int(body.get("pageNo", 1)),
            "pageSize": int(body.get("pageSize", 10)),
            "sampleDistanceKm": round(distance_km(lat, lng, target_lat, target_lng), 4) if city else 0,
            "capturedAt": now_cst,
            "source": "mitm-capture",
            "hasToken": has_token(qp, body),
            "replayable": True,
            "queryParams": qp,
            "bodyParams": body,
            "headers": self._extract_headers(request),
        }

    def _build_detail_entry(self, request, method, qp):
        try:
            lat = float(qp.get("lat") or 0)
            lng = float(qp.get("lng") or 0)
        except (ValueError, TypeError):
            return None

        if lat == 0 and lng == 0:
            return None

        city = match_nearest_city(lat, lng) or ""
        now_cst = datetime.now(CST).strftime("%Y/%m/%d %H:%M:%S")
        target_lat = next((t["lat"] for t in TARGET_CITIES if t["city"] == city), lat)
        target_lng = next((t["lng"] for t in TARGET_CITIES if t["city"] == city), lng)
        station_id = (
            qp.get("fullstationid")
            or qp.get("fullStationId")
            or qp.get("stationId")
            or qp.get("stationid")
            or ""
        )

        return {
            "platform": "didi-charging",
            "scope": "detail",
            "method": method,
            "baseUrl": request.pretty_url.split("?")[0],
            "city": city,
            "keyword": city,
            "targetLat": target_lat,
            "targetLng": target_lng,
            "lat": lat,
            "lng": lng,
            "stationId": station_id,
            "fullStationId": station_id,
            "sampleDistanceKm": round(distance_km(lat, lng, target_lat, target_lng), 4) if city else 0,
            "capturedAt": now_cst,
            "source": "mitm-capture",
            "hasToken": has_token(qp, {}),
            "replayable": True,
            "queryParams": qp,
            "bodyParams": {},
            "headers": self._extract_headers(request),
        }

    @staticmethod
    def _extract_headers(request):
        result = {}
        for key in ("content-type", "user-agent", "referer"):
            value = request.headers.get(key, "")
            if value:
                result[key] = value
        xweb = request.headers.get("xweb_xhr", "")
        if xweb:
            result["xweb_xhr"] = xweb
        return result

    def _append_jsonl(self, entry):
        out = Path(self.outfile)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def done(self):
        ctx.log.info(
            f"[signature-capture] session done: "
            f"captured={self.capture_count} skipped={self.skip_count} "
            f"outfile={self.outfile}"
        )


addons = [SignatureCapture()]
