#!/usr/bin/env python3
"""Set Android emulator mock location providers over ADB.

This helper intentionally uses Android's built-in `cmd location` interface so it
can work with an Android VM/emulator that is reachable through ADB. Physical
phones use the dedicated location-controller app; assigning mock location to
``com.android.shell`` would revoke that app's only-provider ownership.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time


CITY_COORDINATES = {
    "上海": (31.2304, 121.4737),
    "北京": (39.9042, 116.4074),
    "广州": (23.1291, 113.2644),
    "深圳": (22.5431, 114.0579),
    "武汉": (30.5928, 114.3055),
    "青岛": (36.0671, 120.3826),
    "西安": (34.3416, 108.9398),
    "杭州": (30.2741, 120.1551),
}

PROVIDERS = ("gps", "network", "fused")


def adb_prefix(serial: str | None) -> list[str]:
    prefix = ["adb"]
    if serial:
        prefix.extend(["-s", serial])
    return prefix


def run_adb(args: list[str], serial: str | None = None, check: bool = True, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [*adb_prefix(serial), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stdout.strip() or f"adb exited {result.returncode}: {' '.join(args)}")
    return result


def shell(args: list[str], serial: str | None = None, check: bool = True, timeout: int = 30) -> str:
    return run_adb(["shell", *args], serial=serial, check=check, timeout=timeout).stdout.strip()


def ensure_shell_mock_permission(serial: str | None) -> None:
    qemu = shell(["getprop", "ro.kernel.qemu"], serial=serial, check=False)
    boot_qemu = shell(["getprop", "ro.boot.qemu"], serial=serial, check=False)
    product = shell(["getprop", "ro.product.name"], serial=serial, check=False).lower()
    if qemu != "1" and boot_qemu != "1" and "emulator" not in product and "sdk_gphone" not in product:
        raise RuntimeError(
            "refusing to assign physical-phone mock location to com.android.shell; "
            "use scripts/android-real-phone-mock-provider.sh set-location instead"
        )
    shell(["cmd", "location", "set-location-enabled", "true"], serial=serial)
    shell(["appops", "set", "com.android.shell", "android:mock_location", "allow"], serial=serial)
    shell(["settings", "put", "secure", "mock_location", "com.android.shell"], serial=serial, check=False)


def provider_flags(provider: str) -> list[str]:
    if provider == "gps":
        return ["--supportsAltitude", "--supportsSpeed", "--supportsBearing", "--powerRequirement", "1"]
    if provider == "network":
        return ["--requiresNetwork", "--requiresCell", "--powerRequirement", "1"]
    return ["--requiresNetwork", "--supportsAltitude", "--supportsSpeed", "--supportsBearing", "--powerRequirement", "1"]


def add_provider(provider: str, serial: str | None) -> None:
    result = shell(
        ["cmd", "location", "providers", "add-test-provider", provider, *provider_flags(provider)],
        serial=serial,
        check=False,
    )
    lower = result.lower()
    if result and "already" not in lower and "exists" not in lower:
        # Some vendor builds print harmless warnings to stdout. Provider enabling
        # below is the real success signal, so only fail on clear exceptions.
        if "exception" in lower or "error" in lower:
            raise RuntimeError(result)


def set_provider_location(provider: str, lat: float, lng: float, accuracy: float, serial: str | None) -> None:
    add_provider(provider, serial)
    shell(["cmd", "location", "providers", "set-test-provider-enabled", provider, "true"], serial=serial)
    shell(
        [
            "cmd",
            "location",
            "providers",
            "set-test-provider-location",
            provider,
            "--location",
            f"{lat:.6f},{lng:.6f}",
            "--accuracy",
            f"{accuracy:g}",
        ],
        serial=serial,
    )


def verify_location(lat: float, lng: float, serial: str | None) -> dict:
    dumpsys = shell(["dumpsys", "location"], serial=serial, timeout=20)
    lat_text = f"{lat:.6f}"
    lng_text = f"{lng:.6f}"
    providers = {}
    for provider in PROVIDERS:
        providers[provider] = {
            "mockProvider": f"{provider} provider [mock]" in dumpsys,
            "hasTargetLocation": provider in dumpsys and lat_text in dumpsys and lng_text in dumpsys,
        }
    return {
        "success": lat_text in dumpsys and lng_text in dumpsys,
        "lat": lat,
        "lng": lng,
        "providers": providers,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--city", choices=sorted(CITY_COORDINATES.keys()))
    parser.add_argument("--lat", type=float)
    parser.add_argument("--lng", type=float)
    parser.add_argument("--accuracy", type=float, default=20.0)
    parser.add_argument("--serial", default="")
    parser.add_argument("--verify-only", action="store_true")
    return parser.parse_args()


def resolve_location(args: argparse.Namespace) -> tuple[str | None, float, float]:
    if args.city:
        lat, lng = CITY_COORDINATES[args.city]
        return args.city, lat, lng
    if args.lat is None or args.lng is None:
        raise RuntimeError("pass --city or both --lat and --lng")
    return None, float(args.lat), float(args.lng)


def main() -> int:
    args = parse_args()
    city, lat, lng = resolve_location(args)
    serial = args.serial.strip() or None
    started_at = time.time()

    if not args.verify_only:
        ensure_shell_mock_permission(serial)
        for provider in PROVIDERS:
            set_provider_location(provider, lat, lng, args.accuracy, serial)

    verification = verify_location(lat, lng, serial)
    print(json.dumps({
        "success": verification["success"],
        "city": city,
        "lat": lat,
        "lng": lng,
        "accuracy": args.accuracy,
        "serial": serial,
        "elapsedMs": int((time.time() - started_at) * 1000),
        "verification": verification,
    }, ensure_ascii=False, indent=2))
    return 0 if verification["success"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
