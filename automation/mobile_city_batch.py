#!/usr/bin/env python3
"""ADB helper for Android mini-program collection."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "stations.db"
TOKEN = ""  # 访问鉴权已关闭，不再需要 MOBILE_SYNC_TOKEN
SERVER_URL = os.environ.get("MOBILE_SYNC_SERVER_URL", "http://localhost:3000").strip()
PKG = "com.datafordidi.mobilecollector"
RECEIVER = f"{PKG}/.AutomationCommandReceiver"
IME = f"{PKG}/.AdbTextInputService"

CITY_LANDMARKS = {
    "上海": [
        "上海大宁国际", "上海静安大悦城", "上海镇坪路", "上海宜山路", "上海杨浦滨江", "上海江湾体育场", "上海龙阳路", "上海前滩太古里", "上海世博源", "上海莘庄",
        "上海人民广场", "上海南京西路", "上海静安寺", "上海陆家嘴", "上海世纪大道", "上海徐家汇", "上海中山公园", "上海虹桥站", "上海打浦桥", "上海五角场",
        "上海淮海中路", "上海新天地", "上海豫园", "上海火车站", "上海曹家渡", "上海天山路", "上海北外滩", "上海浦东八佰伴", "上海漕河泾", "上海南站",
    ],
    "武汉": [
        "武汉菱角湖万达", "武汉常青花园", "武汉竹叶山", "武汉二七路", "武汉积玉桥", "武汉岳家嘴", "武汉白沙洲", "武汉光谷天地", "武汉软件园中路", "武汉汉阳造",
        "武汉江汉路", "武汉国际广场", "武汉天地", "武汉汉口站", "武汉王家墩东", "武汉楚河汉街", "武汉中南路", "武汉街道口", "武汉光谷广场", "武汉王家湾",
        "武汉广场", "武汉循礼门", "武汉香港路", "武汉武昌站", "武汉洪山广场", "武汉徐东", "武汉钟家村", "武汉青年路", "武汉光谷软件园", "武汉汉阳客运站",
    ],
    "北京": [
        "北京国贸", "北京三里屯", "北京朝阳门", "北京东直门", "北京西单", "北京金融街", "北京站", "北京大望路", "北京中关村", "北京望京SOHO",
        "北京朝阳大悦城", "北京亮马桥", "北京双井", "北京崇文门", "北京宣武门", "北京五道口", "北京魏公村", "北京四惠", "北京牡丹园", "北京丽泽商务区",
    ],
    "广州": [
        "广州珠江新城", "广州体育西路", "广州天河城", "广州正佳广场", "广州岗顶", "广州石牌桥", "广州猎德", "广州花城广场", "广州广州塔", "广州琶洲",
        "广州客村", "广州海珠广场", "广州北京路", "广州公园前", "广州越秀公园", "广州淘金", "广州区庄", "广州东山口", "广州杨箕", "广州广州东站",
        "广州林和西", "广州五山", "广州员村", "广州车陂南", "广州黄埔大道", "广州江南西", "广州昌岗", "广州中山大学", "广州芳村", "广州白云公园",
    ],
    "青岛": [
        "青岛啤酒城", "青岛石老人", "青岛市北CBD", "青岛中央商务区", "青岛敦化路", "青岛南京路", "青岛鞍山路", "青岛错埠岭", "青岛河西", "青岛合肥路",
        "青岛大拇指广场", "青岛汽车东站", "青岛青岛大学", "青岛软件园", "青岛沧口公园", "青岛维客广场", "青岛李沧万达", "青岛保利广场", "青岛市北万达", "青岛卓越大融城",
        "青岛五四广场", "青岛市政府", "青岛万象城", "青岛台东步行街", "青岛站", "青岛海信广场", "青岛麦岛", "青岛浮山后", "青岛崂山区政府", "青岛李村",
        "青岛香港中路", "青岛燕儿岛路", "青岛奥帆中心", "青岛中山路", "青岛北站", "青岛延吉路万达", "青岛辽阳西路", "青岛浮山所", "青岛海尔路", "青岛金狮广场",
    ],
    "深圳": [
        "深圳莲花村", "深圳莲花北", "深圳梅林", "深圳上梅林", "深圳下梅林", "深圳白石洲", "深圳蛇口海上世界", "深圳西丽", "深圳龙华壹方天地", "深圳龙华清湖",
        "深圳坂田", "深圳民治", "深圳布吉", "深圳龙岗中心城", "深圳坪洲", "深圳翻身", "深圳新安", "深圳大冲", "深圳腾讯滨海大厦", "深圳红山",
        "深圳福田中心", "深圳会展中心", "深圳车公庙", "深圳华强北", "深圳岗厦", "深圳深圳北站", "深圳南山科技园", "深圳后海", "深圳宝安中心", "深圳罗湖口岸",
        "深圳购物公园", "深圳市民中心", "深圳香蜜湖", "深圳竹子林", "深圳深大", "深圳科苑", "深圳世界之窗", "深圳前海", "深圳海岸城", "深圳国贸",
    ],
    "西安": [
        "西安凤城五路", "西安凤城八路", "西安未央路", "西安辛家庙", "西安胡家庙", "西安长乐公园", "西安互助路", "西安大明宫万达", "西安曲江创意谷", "西安电视塔",
        "西安航天城", "西安丈八北路", "西安唐延路", "西安西稍门", "西安土门",
        "西安钟楼", "西安小寨", "西安赛格国际", "西安大雁塔", "西安高新一路", "西安高新万达", "西安北大街", "西安火车站", "西安曲江池", "西安大唐不夜城",
        "西安南稍门", "西安体育场", "西安大悦城", "西安永宁门", "西安太乙路", "西安高新路", "西安科技路", "西安行政中心", "西安龙首原", "西安大明宫西",
    ],
}

DEBUG_CAPTURE_DIR = ROOT / "data" / "debug-captures"


def run_adb(*args: str, check: bool = True, timeout: int = 30) -> str:
    result = subprocess.run(
        ["adb", *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stdout.strip())
    return result.stdout.strip()


def shell(*args: str, check: bool = True, timeout: int = 30) -> str:
    return run_adb("shell", *args, check=check, timeout=timeout)


def capture_debug(label: str) -> tuple[Path, Path]:
    DEBUG_CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    safe_label = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in label)[:80]
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    png_path = DEBUG_CAPTURE_DIR / f"{safe_label}-{timestamp}.png"
    xml_path = DEBUG_CAPTURE_DIR / f"{safe_label}-{timestamp}.xml"
    with png_path.open("wb") as output:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], cwd=ROOT, stdout=output, check=False, timeout=20)
    shell("uiautomator", "dump", "/sdcard/data_for_didi_current.xml", check=False, timeout=20)
    subprocess.run(
        ["adb", "pull", "/sdcard/data_for_didi_current.xml", str(xml_path)],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=20,
    )
    print(f"[debug] captured {png_path} {xml_path}", flush=True)
    return png_path, xml_path


def focus_info() -> str:
    return run_adb(
        "shell",
        "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp|isKeyguardShowing'",
        timeout=20,
    )


def raw_tap(x: int, y: int) -> None:
    shell("input", "tap", str(x), str(y))
    time.sleep(0.8)


def dismiss_known_prompts() -> bool:
    """Dismiss blocking prompts without blind taps during collection."""
    prompt_buttons = [
        ("拒绝", False),
        ("否", False),
        ("不允许", True),
        ("暂不允许", True),
        ("取消", False),
    ]
    for text, contains in prompt_buttons:
        if click_text(text, contains=contains):
            capture_debug(f"dismissed-prompt-{text}")
            time.sleep(1.0)
            return True
    return False


def broadcast(action: str, *extras: str, check: bool = True) -> str:
    return shell("am", "broadcast", "-n", RECEIVER, "-a", action, *extras, check=check)


def tap(x: float, y: float) -> None:
    broadcast(
        "com.datafordidi.mobilecollector.AUTOMATION_TAP",
        "--ef",
        "x",
        f"{x:.4f}",
        "--ef",
        "y",
        f"{y:.4f}",
    )
    time.sleep(0.8)


def click_text(text: str, contains: bool = True) -> bool:
    output = broadcast(
        "com.datafordidi.mobilecollector.AUTOMATION_CLICK_TEXT",
        "--es",
        "text",
        text,
        "--ez",
        "contains",
        "true" if contains else "false",
        check=False,
    )
    time.sleep(0.8)
    return "result=0" in output or "code=0" in output


def set_text(text: str) -> bool:
    output = broadcast(
        "com.datafordidi.mobilecollector.AUTOMATION_IME_REPLACE_TEXT",
        "--es",
        "text",
        text,
        check=False,
    )
    time.sleep(1.0)
    return "result=0" in output or "code=0" in output


def enqueue_mobile_command(command_type: str, payload: dict | None = None) -> dict:
    url = SERVER_URL.rstrip("/") + "/api/mobile-control/commands"
    body = json.dumps({"type": command_type, "payload": payload or {}}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"enqueue command failed HTTP {error.code}: {detail}") from error


def ensure_ready() -> None:
    devices = run_adb("devices", "-l")
    if not any(line.split()[1:2] == ["device"] for line in devices.splitlines() if line and not line.startswith("List ")):
        raise RuntimeError(f"ADB device not ready:\n{devices}")
    state = shell("dumpsys", "window")
    if "isKeyguardShowing=true" in state:
        raise RuntimeError("phone is locked; unlock it before starting the batch")
    if os.environ.get("ENABLE_LOCAL_ADB_REVERSE", "").lower() in {"1", "true", "yes", "on"}:
        run_adb("reverse", "tcp:3000", "tcp:3000")
    shell("settings", "put", "secure", "enabled_accessibility_services", f"{PKG}/{PKG}.AutoScrollAccessibilityService")
    shell("settings", "put", "secure", "accessibility_enabled", "1")
    shell("appops", "set", PKG, "SYSTEM_ALERT_WINDOW", "allow", check=False)
    shell("ime", "enable", IME, check=False)
    shell("ime", "set", IME, check=False)
    ensure_didi_miniprogram()


def open_didi_from_wechat() -> None:
    run_adb("shell", "monkey", "-p", "com.tencent.mm", "-c", "android.intent.category.LAUNCHER", "1", check=False)
    time.sleep(2.0)
    raw_tap(895, 164)
    time.sleep(0.8)
    if not set_text("滴滴充电"):
        raise RuntimeError("failed to input mini-program keyword in WeChat search")
    time.sleep(1.5)
    # Phone FTS layout puts the "最常使用/滴滴充电 小程序" result near the top.
    raw_tap(330, 445)
    time.sleep(4.0)
    state = focus_info()
    if "com.tencent.mm" not in state or "AppBrandUI" not in state:
        # Older result layout fallback.
        raw_tap(500, 650)
        time.sleep(6.0)


def ensure_didi_miniprogram() -> None:
    state = focus_info()
    if "isKeyguardShowing=true" in state:
        raise RuntimeError("phone is locked; unlock it before starting the batch")
    if "com.tencent.mm" not in state:
        open_didi_from_wechat()
        state = focus_info()
    elif "AppBrandUI" not in state:
        open_didi_from_wechat()
        state = focus_info()
    if "com.tencent.mm" not in state or "AppBrandUI" not in state:
        raise RuntimeError("Didi Charging mini-program is not active; stop to avoid operating the wrong app")


def recover_to_base_page() -> None:
    """Keep the mini-program active before using the list search bar."""
    dismiss_known_prompts()
    state = focus_info()
    if "com.tencent.mm" not in state or "AppBrandUI" not in state:
        open_didi_from_wechat()


def save_settings(
    city: str,
    max_pages: int,
    min_interval: int,
    max_interval: int,
    detail_enrichment_enabled: bool,
) -> None:
    broadcast(
        "com.datafordidi.mobilecollector.AUTOMATION_SAVE_SETTINGS",
        "--es",
        "serverUrl",
        SERVER_URL,
        "--es",
        "platform",
        "didi-charging",
        "--es",
        "city",
        city,
        "--ei",
        "minIntervalMillis",
        str(min_interval),
        "--ei",
        "maxIntervalMillis",
        str(max_interval),
        "--ei",
        "maxPages",
        str(max_pages),
        "--ez",
        "detailEnrichmentEnabled",
        "true" if detail_enrichment_enabled else "false",
        "--ez",
        "aiSupervisorEnabled",
        "true",
        "--ez",
        "testEvidenceEnabled",
        "true",
    )


def switch_landmark(keyword: str) -> None:
    ensure_didi_miniprogram()
    recover_to_base_page()
    ensure_didi_miniprogram()
    dismiss_known_prompts()
    capture_debug(f"before-switch-{keyword}")
    # Didi mini-program search bar is sticky at the top of the list page.
    for attempt in range(3):
        raw_tap(550, 300)
        time.sleep(0.8)
        # Focus the search input on the search page.
        raw_tap(550, 300)
        if set_text(keyword):
            break
        dismiss_known_prompts()
        shell("input", "keyevent", "BACK", check=False)
        time.sleep(1.2)
        ensure_didi_miniprogram()
        if attempt == 2:
            capture_debug(f"failed-input-{keyword}")
            raise RuntimeError(f"failed to input landmark: {keyword}")
    time.sleep(0.8)
    # Trigger search, then open the first "查找附近场站" result.
    raw_tap(985, 300)
    time.sleep(2.5)
    capture_debug(f"after-search-{keyword}")
    clicked_nearby = (
        click_text("查找附近场站", contains=True)
        or click_text("附近场站", contains=True)
        or click_text("在此附近找站", contains=True)
    )
    if clicked_nearby:
        time.sleep(4.5)
    else:
        # Some Didi mini-program versions render the station list immediately
        # after search and no longer show a "查找附近场站" result entry. Do not
        # use coordinate fallback here; it can hit ads and cross-mini-program
        # jump cards. Continue with the current list page and let the collector
        # validate whether rows are produced.
        print(f"[switch] nearby entry not found after search; continue without blind tap: {keyword}", flush=True)
        time.sleep(1.5)
    capture_debug(f"after-nearby-{keyword}")
    ensure_didi_miniprogram()


def start_ocr_collection(collector_mode: str) -> None:
    ensure_didi_miniprogram()
    if collector_mode == "text":
        enqueue_mobile_command("start_text_collection", {})
        deadline = time.time() + 25
        while time.time() < deadline:
            time.sleep(2.0)
            if is_collector_running():
                ensure_didi_miniprogram()
                return
        raise RuntimeError("accessibility text collector service did not start")

    shell("am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(1.0)
    if not click_text("开始采集") and not click_text("开始OCR+自动下滑"):
        shell("input", "swipe", "540", "2140", "540", "760", "450")
        time.sleep(0.8)
        if not click_text("开始采集") and not click_text("开始OCR+自动下滑"):
            # Native page fallback coordinate after one scroll.
            shell("input", "tap", "540", "2036")
    time.sleep(1.0)
    if not click_text("立即开始") and not click_text("允许") and not click_text("Start now"):
        shell("input", "tap", "780", "2220")
    time.sleep(4.0)
    if is_collector_running():
        ensure_didi_miniprogram()
        return

    if collector_mode == "capture":
        raise RuntimeError("capture collector service did not start")

    # Screenshot permission is device-state dependent. Fall back to the
    # accessibility text collector instead of silently burning landmarks.
    shell("am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(1.0)
    if not click_text("开始兼容采集") and not click_text("无截屏文本识别"):
        shell("input", "swipe", "540", "2140", "540", "760", "450")
        time.sleep(0.8)
        if not click_text("开始兼容采集") and not click_text("无截屏文本识别"):
            raise RuntimeError("collector start button not found")
    time.sleep(3.0)
    if not is_collector_running():
        raise RuntimeError("collector service did not start")
    ensure_didi_miniprogram()


def is_collector_running() -> bool:
    services = shell("dumpsys", "activity", "services", PKG, timeout=20)
    return "CaptureOcrService" in services or "AccessibilityTextCollectService" in services


def stop_collection() -> None:
    shell("am", "broadcast", "-a", "com.datafordidi.mobilecollector.action.STOP", check=False)
    time.sleep(1.0)


def wait_collection_done(city: str, target: int, timeout_seconds: int, no_growth_seconds: int) -> None:
    deadline = time.time() + timeout_seconds
    no_growth_deadline = time.time() + no_growth_seconds
    saw_running = False
    last_distinct = city_count(city)[1]
    while time.time() < deadline:
        if dismiss_known_prompts():
            no_growth_deadline = time.time() + no_growth_seconds
            time.sleep(2)
            continue
        state = focus_info()
        if "com.tencent.mm" not in state or "AppBrandUI" not in state:
            print(f"[{city}] focus left mini-program, stop and recover", flush=True)
            stop_collection()
            open_didi_from_wechat()
            return
        running = is_collector_running()
        saw_running = saw_running or running
        if saw_running and not running:
            return
        total, distinct = city_count(city)
        if distinct >= target:
            print(f"[{city}] target reached while collecting: total={total}, distinct={distinct}", flush=True)
            stop_collection()
            return
        if distinct > last_distinct:
            last_distinct = distinct
            no_growth_deadline = time.time() + no_growth_seconds
        elif saw_running and time.time() > no_growth_deadline:
            print(f"[{city}] no distinct growth for {no_growth_seconds}s, stop current landmark early", flush=True)
            stop_collection()
            return
        time.sleep(8)
    raise TimeoutError("collector did not finish before timeout")


def wait_collection_done_by_refresh(
    city: str,
    started_at: str,
    target_refresh_count: int,
    timeout_seconds: int,
    no_growth_seconds: int,
) -> None:
    deadline = time.time() + timeout_seconds
    no_growth_deadline = time.time() + no_growth_seconds
    saw_running = False
    last_count = city_refresh_count(city, started_at)
    while time.time() < deadline:
        if dismiss_known_prompts():
            no_growth_deadline = time.time() + no_growth_seconds
            time.sleep(2)
            continue
        state = focus_info()
        if "com.tencent.mm" not in state or "AppBrandUI" not in state:
            print(f"[{city}] focus left mini-program, stop and recover", flush=True)
            stop_collection()
            open_didi_from_wechat()
            return
        running = is_collector_running()
        saw_running = saw_running or running
        refreshed = city_refresh_count(city, started_at)
        if refreshed >= target_refresh_count:
            print(f"[{city}] refresh target reached while collecting: refreshed={refreshed}", flush=True)
            stop_collection()
            return
        if saw_running and not running:
            return
        if refreshed > last_count:
            last_count = refreshed
            no_growth_deadline = time.time() + no_growth_seconds
        elif saw_running and time.time() > no_growth_deadline:
            print(f"[{city}] no refresh growth for {no_growth_seconds}s, stop current landmark early", flush=True)
            stop_collection()
            return
        time.sleep(8)
    raise TimeoutError("collector did not finish before timeout")


def city_count(city: str) -> tuple[int, int]:
    if not DB_PATH.exists():
        return (0, 0)
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute(
            """
            SELECT COUNT(*), COUNT(DISTINCT station_name)
            FROM stations
            WHERE platform='didi-charging'
              AND source_type='mobile-ocr'
              AND json_extract(raw_data, '$.mobileSync.meta.city') = ?
              AND station_name NOT LIKE '%可用券%'
              AND station_name NOT LIKE '%余额%'
              AND station_name NOT LIKE '%余額%'
              AND station_name NOT LIKE '%余领%'
              AND station_name NOT LIKE '%余颌%'
              AND station_name NOT LIKE '%即插即充%'
              AND station_name NOT LIKE '%可用充电%'
              AND station_name NOT LIKE '%场站专属%'
              AND station_name NOT LIKE '%停车减免%'
            """,
            (city,),
        )
        row = cursor.fetchone()
        return (int(row[0] or 0), int(row[1] or 0))


def city_refresh_count(city: str, started_at: str) -> int:
    if not DB_PATH.exists():
        return 0
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute(
            """
            SELECT COUNT(*)
            FROM stations
            WHERE platform='didi-charging'
              AND source_type='mobile-ocr'
              AND json_extract(raw_data, '$.mobileSync.meta.city') = ?
              AND datetime(collected_at) >= datetime(?)
              AND station_name NOT LIKE '%可用券%'
              AND station_name NOT LIKE '%余额%'
              AND station_name NOT LIKE '%余額%'
              AND station_name NOT LIKE '%余领%'
              AND station_name NOT LIKE '%余颌%'
              AND station_name NOT LIKE '%即插即充%'
              AND station_name NOT LIKE '%可用充电%'
              AND station_name NOT LIKE '%场站专属%'
              AND station_name NOT LIKE '%停车减免%'
            """,
            (city, started_at),
        )
        row = cursor.fetchone()
        return int(row[0] or 0)


def run_city(
    city: str,
    target: int,
    target_increment: int | None,
    target_refresh_increment: int | None,
    pages_per_landmark: int,
    min_interval: int,
    max_interval: int,
    no_growth_seconds: int,
    detail_enrichment_enabled: bool,
    collector_mode: str,
) -> None:
    landmarks = CITY_LANDMARKS[city]
    started_at = time.strftime("%Y-%m-%d %H:%M:%S")
    baseline_total, baseline_distinct = city_count(city)
    if target_increment is not None:
        target = baseline_distinct + target_increment
    refresh_target = max(1, target_refresh_increment or 0)
    if target_refresh_increment is not None:
        print(f"\n== {city} refresh_target={refresh_target} landmarks={len(landmarks)} ==", flush=True)
    else:
        print(f"\n== {city} target={target} landmarks={len(landmarks)} ==", flush=True)
    print(f"[{city}] baseline total={baseline_total}, distinct={baseline_distinct}", flush=True)
    for keyword in landmarks:
        total, distinct = city_count(city)
        refreshed = city_refresh_count(city, started_at)
        print(f"[{city}] current total={total}, distinct={distinct}, refreshed={refreshed}", flush=True)
        if target_refresh_increment is not None and refreshed >= refresh_target:
            return
        if target_refresh_increment is None and distinct >= target:
            return
        print(f"[{city}] switch landmark: {keyword}", flush=True)
        switch_landmark(keyword)
        save_settings(city, pages_per_landmark, min_interval, max_interval, detail_enrichment_enabled)
        start_ocr_collection(collector_mode)
        timeout_seconds = max(no_growth_seconds + 60, pages_per_landmark * (max_interval / 1000 + 4))
        if target_refresh_increment is not None:
            wait_collection_done_by_refresh(
                city,
                started_at,
                refresh_target,
                timeout_seconds,
                no_growth_seconds,
            )
        else:
            wait_collection_done(
                city,
                target,
                timeout_seconds,
                no_growth_seconds,
            )
    total, distinct = city_count(city)
    refreshed = city_refresh_count(city, started_at)
    print(f"[{city}] done total={total}, distinct={distinct}, refreshed={refreshed}", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cities", nargs="+", default=["上海", "武汉", "北京", "青岛", "深圳", "西安"])
    parser.add_argument("--target", type=int, default=500)
    parser.add_argument("--target-increment", type=int, default=None, help="Collect until each city's current distinct station count grows by this value.")
    parser.add_argument("--target-refresh-increment", type=int, default=100, help="Collect until this many price/gun snapshots are added in the current run. Use 0 to fall back to legacy distinct-total mode.")
    parser.add_argument("--pages-per-landmark", type=int, default=45)
    parser.add_argument("--min-interval", type=int, default=1500)
    parser.add_argument("--max-interval", type=int, default=2500)
    parser.add_argument("--no-growth-seconds", type=int, default=180)
    parser.add_argument("--detail-enrichment", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--collector-mode", choices=["auto", "capture", "text"], default="auto")
    parser.add_argument("--server-url", default=SERVER_URL)
    parser.add_argument("--sync-token", default="", help="已废弃：访问鉴权关闭后不再需要")
    return parser.parse_args()


def main() -> int:
    global SERVER_URL, TOKEN
    args = parse_args()
    SERVER_URL = str(args.server_url or "").strip()
    TOKEN = ""
    if not SERVER_URL:
        raise RuntimeError("server url required; pass --server-url or MOBILE_SYNC_SERVER_URL")
    ensure_ready()
    for city in args.cities:
        if city not in CITY_LANDMARKS:
            raise RuntimeError(f"unsupported city: {city}")
        run_city(
            city,
            args.target,
            args.target_increment,
            args.target_refresh_increment if args.target_refresh_increment and args.target_refresh_increment > 0 else None,
            args.pages_per_landmark,
            args.min_interval,
            args.max_interval,
            args.no_growth_seconds,
            args.detail_enrichment,
            args.collector_mode,
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
