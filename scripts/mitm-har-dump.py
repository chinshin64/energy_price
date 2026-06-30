import base64
import ipaddress
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from mitmproxy import ctx, http


SENSITIVE_HEADERS = {"authorization", "cookie", "proxy-authorization", "set-cookie", "x-mobile-sync-token"}


class DataForDidiHarDump:
    def __init__(self):
        self.entries = []
        self.har_path = ""
        self.stats_path = ""
        self.filter_hosts = []
        self.filter_ip_networks = []
        self.filter_ips = set()
        self.block_hosts = []
        self.block_url_keywords = []
        self.allow_url_keywords = []
        self.stats = {
            "startedAt": datetime.now(timezone.utc).isoformat(),
            "updatedAt": None,
            "requestCount": 0,
            "responseCount": 0,
            "recordedCount": 0,
            "filteredCount": 0,
            "blockedCount": 0,
            "errorCount": 0,
            "hosts": {},
            "recordedHosts": {},
            "filteredHosts": {},
            "blockedHosts": {},
            "lastRequestAt": None,
            "lastRecordedAt": None,
            "lastFilteredAt": None,
            "lastBlockedAt": None,
            "lastErrorAt": None,
            "lastError": "",
            "recent": [],
        }

    def load(self, loader):
        loader.add_option(
            name="data_for_didi_har_path",
            typespec=str,
            default="",
            help="Path to write data_for_didi HAR capture output.",
        )
        loader.add_option(
            name="data_for_didi_filter_hosts",
            typespec=str,
            default="",
            help="Comma separated host/domain allowlist. Empty means record all hosts.",
        )
        loader.add_option(
            name="data_for_didi_stats_path",
            typespec=str,
            default="",
            help="Path to write data_for_didi capture stats output.",
        )
        loader.add_option(
            name="data_for_didi_filter_ips",
            typespec=str,
            default="",
            help="Comma separated IP/CIDR allowlist. Empty means record all IPs.",
        )
        loader.add_option(
            name="data_for_didi_block_hosts",
            typespec=str,
            default="",
            help="Comma separated host/domain blocklist. Blocks only matched requests.",
        )
        loader.add_option(
            name="data_for_didi_block_url_keywords",
            typespec=str,
            default="",
            help="Comma separated URL substrings to block.",
        )
        loader.add_option(
            name="data_for_didi_allow_url_keywords",
            typespec=str,
            default="",
            help="Comma separated URL substrings that bypass blocking.",
        )

    def configure(self, updates):
        self.har_path = str(ctx.options.data_for_didi_har_path or "").strip()
        self.stats_path = str(ctx.options.data_for_didi_stats_path or "").strip()
        self.filter_hosts = self.parse_list(ctx.options.data_for_didi_filter_hosts)
        self.filter_ip_networks, self.filter_ips = self.parse_ip_filters(ctx.options.data_for_didi_filter_ips)
        self.block_hosts = self.parse_list(ctx.options.data_for_didi_block_hosts)
        self.block_url_keywords = self.parse_list(ctx.options.data_for_didi_block_url_keywords)
        self.allow_url_keywords = self.parse_list(ctx.options.data_for_didi_allow_url_keywords)
        self.stats["filters"] = {
            "hosts": self.filter_hosts,
            "ips": [str(item) for item in self.filter_ip_networks] + sorted(self.filter_ips),
        }
        self.stats["trafficPolicy"] = {
            "blockHosts": self.block_hosts,
            "blockUrlKeywords": self.block_url_keywords,
            "allowUrlKeywords": self.allow_url_keywords,
        }
        self.write_stats()

    def request(self, flow):
        self.stats["requestCount"] += 1
        self.stats["lastRequestAt"] = self.now()
        host = self.primary_host(flow)
        self.increment_host("hosts", host)
        self.remember_recent(flow, "request", host)
        if self.should_block(flow):
            self.stats["blockedCount"] += 1
            self.stats["lastBlockedAt"] = self.now()
            self.increment_host("blockedHosts", host)
            flow.metadata["data_for_didi_blocked"] = True
            self.remember_recent(flow, "blocked", host, 204, "blocked by data_for_didi traffic policy")
            flow.response = http.Response.make(
                204,
                b"",
                {
                    "Cache-Control": "no-store",
                    "X-Data-For-Didi-Blocked": "1",
                },
            )
        self.write_stats()

    def response(self, flow):
        if not self.har_path or not flow.response:
            return
        if flow.metadata.get("data_for_didi_blocked"):
            self.write_stats()
            return

        request = flow.request
        response = flow.response
        host = self.primary_host(flow)
        self.stats["responseCount"] += 1
        if not self.should_record(flow):
            self.stats["filteredCount"] += 1
            self.stats["lastFilteredAt"] = self.now()
            self.increment_host("filteredHosts", host)
            self.remember_recent(flow, "filtered", host)
            self.write_stats()
            return

        started = datetime.fromtimestamp(request.timestamp_start, timezone.utc).isoformat()
        duration_ms = max(0, int((response.timestamp_end - request.timestamp_start) * 1000))
        request_content = request.raw_content or b""
        response_content = response.raw_content or b""
        content_payload = self.content_to_har(response_content, response.headers.get("content-type", ""))

        entry = {
            "startedDateTime": started,
            "time": duration_ms,
            "request": {
                "method": request.method,
                "url": request.pretty_url,
                "httpVersion": request.http_version,
                "headers": self.headers_to_har(request.headers),
                "queryString": [{"name": key, "value": value} for key, value in request.query.items(multi=True)],
                "cookies": [],
                "headersSize": -1,
                "bodySize": len(request_content),
            },
            "response": {
                "status": response.status_code,
                "statusText": response.reason,
                "httpVersion": response.http_version,
                "headers": self.headers_to_har(response.headers),
                "cookies": [],
                "content": content_payload,
                "redirectURL": response.headers.get("location", ""),
                "headersSize": -1,
                "bodySize": len(response_content),
            },
            "cache": {},
            "timings": {
                "send": 0,
                "wait": duration_ms,
                "receive": 0,
            },
        }
        if request_content:
            entry["request"]["postData"] = self.content_to_har(
                request_content,
                request.headers.get("content-type", "")
            )
        self.entries.append(entry)
        self.stats["recordedCount"] += 1
        self.stats["lastRecordedAt"] = self.now()
        self.increment_host("recordedHosts", host)
        self.remember_recent(flow, "recorded", host, response.status_code)
        self.write_har()
        self.write_stats()

    def error(self, flow):
        self.stats["errorCount"] += 1
        self.stats["lastErrorAt"] = self.now()
        self.stats["lastError"] = str(getattr(flow, "error", "") or "")
        self.remember_recent(flow, "error", self.primary_host(flow), None, self.stats["lastError"])
        self.write_stats()

    def should_record(self, flow):
        has_host_filter = len(self.filter_hosts) > 0
        has_ip_filter = len(self.filter_ip_networks) > 0 or len(self.filter_ips) > 0
        if not has_host_filter and not has_ip_filter:
            return True

        hosts = self.flow_hosts(flow)
        ips = self.flow_ips(flow, hosts)
        host_matched = has_host_filter and any(self.host_matches(host) for host in hosts)
        ip_matched = has_ip_filter and any(self.ip_matches(ip) for ip in ips)
        return host_matched or ip_matched

    def should_block(self, flow):
        if not self.block_hosts and not self.block_url_keywords:
            return False

        url = str(getattr(flow.request, "pretty_url", "") or "").lower()
        if self.allow_url_keywords and any(keyword in url for keyword in self.allow_url_keywords):
            return False

        hosts = self.flow_hosts(flow)
        host_matched = self.block_hosts and any(self.host_matches(host, self.block_hosts) for host in hosts)
        url_matched = self.block_url_keywords and any(keyword in url for keyword in self.block_url_keywords)

        if self.block_hosts and self.block_url_keywords:
            return bool(host_matched and url_matched)
        return bool(host_matched or url_matched)

    def flow_hosts(self, flow):
        request = flow.request
        values = [
            getattr(request, "host", ""),
            getattr(request, "pretty_host", ""),
        ]
        try:
            if flow.server_conn and flow.server_conn.address:
                values.append(flow.server_conn.address[0])
        except Exception:
            pass
        return [str(value or "").strip().lower() for value in values if str(value or "").strip()]

    def primary_host(self, flow):
        hosts = self.flow_hosts(flow)
        if hosts:
            return hosts[0]
        try:
            return urlsplit(flow.request.pretty_url).hostname or ""
        except Exception:
            return ""

    def flow_ips(self, flow, hosts):
        values = []
        try:
            if flow.server_conn and flow.server_conn.address:
                values.append(flow.server_conn.address[0])
        except Exception:
            pass
        for host in hosts:
            try:
                ipaddress.ip_address(host)
                values.append(host)
            except ValueError:
                continue
        return values

    def host_matches(self, host, rules=None):
        normalized = str(host or "").strip().lower().rstrip(".")
        if not normalized:
            return False
        for rule in rules if rules is not None else self.filter_hosts:
            candidate = str(rule or "").strip().lower().lstrip(".").rstrip(".")
            if not candidate:
                continue
            if normalized == candidate or normalized.endswith("." + candidate):
                return True
        return False

    def ip_matches(self, value):
        try:
            ip = ipaddress.ip_address(str(value or "").strip())
        except ValueError:
            return False
        if str(ip) in self.filter_ips:
            return True
        return any(ip in network for network in self.filter_ip_networks)

    def parse_list(self, value):
        items = []
        for raw in str(value or "").replace("，", ",").replace("；", ",").replace(";", ",").replace("|", ",").split(","):
            item = raw.strip().lower()
            if item and item not in items:
                items.append(item)
        return items

    def parse_ip_filters(self, value):
        networks = []
        ips = set()
        for item in self.parse_list(value):
            try:
                if "/" in item:
                    networks.append(ipaddress.ip_network(item, strict=False))
                else:
                    ips.add(str(ipaddress.ip_address(item)))
            except ValueError:
                ctx.log.warn(f"Ignore invalid capture IP filter: {item}")
        return networks, ips

    def done(self):
        self.write_har()
        self.write_stats()

    def headers_to_har(self, headers):
        result = []
        for key, value in headers.items(multi=True):
            safe_value = "<redacted>" if key.lower() in SENSITIVE_HEADERS else value
            result.append({"name": key, "value": safe_value})
        return result

    def content_to_har(self, content, mime_type):
        payload = {
            "size": len(content),
            "mimeType": mime_type or "",
        }
        try:
            payload["text"] = content.decode("utf-8")
        except UnicodeDecodeError:
            payload["text"] = base64.b64encode(content).decode("ascii")
            payload["encoding"] = "base64"
        return payload

    def write_har(self):
        if not self.har_path:
            return
        output = Path(self.har_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "log": {
                "version": "1.2",
                "creator": {
                    "name": "data_for_didi_capture_recorder",
                    "version": "1.0",
                },
                "entries": self.entries,
            }
        }
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def increment_host(self, bucket, host):
        normalized = str(host or "").strip().lower()
        if not normalized:
            normalized = "<unknown>"
        current = self.stats.get(bucket) or {}
        current[normalized] = int(current.get(normalized, 0)) + 1
        self.stats[bucket] = current

    def remember_recent(self, flow, event, host, status_code=None, error=""):
        recent = self.stats.get("recent") or []
        item = {
            "at": self.now(),
            "event": event,
            "host": host or "",
            "method": getattr(flow.request, "method", ""),
            "url": getattr(flow.request, "pretty_url", ""),
        }
        if status_code is not None:
            item["statusCode"] = status_code
        if error:
            item["error"] = error
        recent.append(item)
        self.stats["recent"] = recent[-30:]

    def write_stats(self):
        if not self.stats_path:
            return
        self.stats["updatedAt"] = self.now()
        output = Path(self.stats_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(self.stats, ensure_ascii=False, indent=2), encoding="utf-8")

    def now(self):
        return datetime.now(timezone.utc).isoformat()


addons = [DataForDidiHarDump()]
