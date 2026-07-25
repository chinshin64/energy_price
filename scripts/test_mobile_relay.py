#!/usr/bin/env python3
"""Unit tests for the public mobile relay allowlist."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
import urllib.error
import urllib.request


MODULE_PATH = Path(__file__).with_name("mobile-relay.py")
SPEC = importlib.util.spec_from_file_location("mobile_relay", MODULE_PATH)
assert SPEC and SPEC.loader
mobile_relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mobile_relay)


class MobileRelayAllowlistTest(unittest.TestCase):
    def test_allows_station_upload_and_query_string(self) -> None:
        self.assertTrue(mobile_relay.is_allowed_request("POST", "/api/mobile-sync/stations"))
        self.assertTrue(mobile_relay.is_allowed_request("GET", "/api/mobile-sync/commands/poll?deviceId=abc"))
        self.assertTrue(mobile_relay.is_allowed_request("POST", "/api/mobile-sync/commands/job-1/result"))

    def test_blocks_unrelated_backend_and_malformed_command_paths(self) -> None:
        self.assertFalse(mobile_relay.is_allowed_request("GET", "/api/settings"))
        self.assertFalse(mobile_relay.is_allowed_request("GET", "/api/mobile-sync/stations"))
        self.assertFalse(mobile_relay.is_allowed_request("POST", "/api/mobile-sync/commands/a/b/result"))
        self.assertFalse(mobile_relay.is_allowed_request("DELETE", "/api/mobile-sync/stations"))


class _OriginHandler(BaseHTTPRequestHandler):
    calls: list[dict[str, object]] = []

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        self.calls.append({
            "path": self.path,
            "body": self.rfile.read(length),
            "mobile_agent": self.headers.get("X-Mobile-Agent"),
            "relay_node": self.headers.get("X-Relay-Node"),
            "forwarded_for": self.headers.get("X-Forwarded-For"),
        })
        body = b'{"success":true}\n'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _fmt: str, *_args: object) -> None:
        return


class MobileRelayIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _OriginHandler.calls.clear()
        cls.origin = ThreadingHTTPServer(("127.0.0.1", 0), _OriginHandler)
        mobile_relay.TARGET_SOCKET = ""
        mobile_relay.TARGET_HOST = "127.0.0.1"
        mobile_relay.TARGET_PORT = cls.origin.server_address[1]
        mobile_relay.RELAY_NODE_ID = "test-relay"
        cls.relay = ThreadingHTTPServer(("127.0.0.1", 0), mobile_relay.RelayHandler)
        cls.threads = [
            threading.Thread(target=cls.origin.serve_forever, daemon=True),
            threading.Thread(target=cls.relay.serve_forever, daemon=True),
        ]
        for thread in cls.threads:
            thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.relay.shutdown()
        cls.origin.shutdown()
        cls.relay.server_close()
        cls.origin.server_close()

    def test_station_payload_is_forwarded_with_relay_identity(self) -> None:
        payload = json.dumps({"sourceAgent": "ios-agent", "stations": []}).encode()
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.relay.server_address[1]}/api/mobile-sync/stations",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Mobile-Agent": "ios-agent",
                "X-Relay-Node": "spoofed-client-value",
                "X-Forwarded-For": "203.0.113.1",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            self.assertEqual(200, response.status)
            self.assertTrue(json.load(response)["success"])

        call = _OriginHandler.calls[-1]
        self.assertEqual("/api/mobile-sync/stations", call["path"])
        self.assertEqual("ios-agent", call["mobile_agent"])
        self.assertEqual("test-relay", call["relay_node"])
        self.assertEqual("127.0.0.1", call["forwarded_for"])
        self.assertEqual(payload, call["body"])

    def test_unrelated_backend_route_never_reaches_origin(self) -> None:
        before = len(_OriginHandler.calls)
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(
                f"http://127.0.0.1:{self.relay.server_address[1]}/api/settings",
                timeout=2,
            )
        self.assertEqual(404, raised.exception.code)
        raised.exception.close()
        self.assertEqual(before, len(_OriginHandler.calls))


if __name__ == "__main__":
    unittest.main()
