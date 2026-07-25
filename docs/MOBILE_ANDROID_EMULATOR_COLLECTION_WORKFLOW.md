# Android Emulator Mobile Collection Workflow

## Goal

Use a project-owned Android ARM64 virtual device as a controllable fallback when the real-phone WeChat mini-program does not accept Android mock location.

## Current Real-Phone Finding

- ADB device: `KBPNQKLZQ8YLLVMV`, model `22041216C`.
- Android `cmd location` mock providers can be set successfully on the real phone.
- Verified providers: `gps`, `network`, and `fused` all reported `34.341600,108.939800 mock` for Xi'an.
- The Didi Charging mini-program still rendered Hangzhou nearby stations after WeChat restart and map locate.
- In the mini-program search page, selecting `西安市` is possible while logged out.
- Submitting cross-city search while logged out shows the Didi login page; tapping `暂不登录/注册` returns to the search page and does not continue the query.

Conclusion: current real-phone, logged-out flow cannot collect other-city data by system mock location alone. It needs either a logged-in Didi flow, a deeper hook, or a virtual Android route where location and app state can be controlled from boot.

## Emulator State

- AVD name: `data_test_didi_api36`
- Serial: `emulator-5554`
- ABI: `arm64-v8a`
- Android: API 36 default ARM64 system image
- Screen: `1080x1920`
- Installed project APK: `com.datafordidi.mobilecollector`
- Installed WeChat APK: `com.tencent.mm`

The emulator has been verified with:

```bash
python3 automation/android_mock_location.py --serial emulator-5554 --city 西安 --verify-only
```

Expected success evidence:

- `gps.mockProvider = true`
- `network.mockProvider = true`
- `fused.mockProvider = true`
- `lat = 34.3416`
- `lng = 108.9398`

## Commands

Prepare the emulator:

```bash
scripts/android-emulator-mobile-collector.sh prepare
```

Set a city location:

```bash
CITY=西安 scripts/android-emulator-mobile-collector.sh set-location
```

Install WeChat from an official APK path:

```bash
WECHAT_APK=.codex_tmp/apks/wechat-8.0.53-arm64.apk \
  scripts/android-emulator-mobile-collector.sh install-wechat
```

Run mobile batch against the emulator:

```bash
MOBILE_ADB_SERIAL=emulator-5554 python3 automation/mobile_city_batch.py \
  --adb-serial emulator-5554 \
  --cities 西安 \
  --target-refresh-increment 20 \
  --pages-per-landmark 20 \
  --no-detail-enrichment \
  --mock-location
```

## Manual Gate

WeChat inside the emulator starts at the normal WeChat login screen. The user must complete WeChat login or QR authorization before the Didi Charging mini-program can be opened there.

Do not claim emulator collection is complete until:

1. WeChat is logged in on `emulator-5554`.
2. Didi Charging mini-program opens inside the emulator.
3. The page renders the target city under emulator mock location.
4. List-only OCR inserts rows with `raw_data.mobileSync.meta.city` equal to the target city.
5. `automation/ocr_quality_audit.py --sample-limit 20` passes for newly collected rows.
