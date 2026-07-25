# energy_price

Android 11+ 高德加油页面伴随采集器。用户手动操作高德时，应用通过无障碍节点和本地中文 OCR 识别加油站、油号、200 元报价、优惠、服务费和 CP，并按 mobile-source v3 协议上传。

## 采集边界

- 只监听 `com.autonavi.minimap`。
- 不自动点击，不发起支付。
- 仅在识别到 92# 或 95#、金额 200 元、支付页优惠/服务费/CP 后形成完整记录。
- 每个油号单独记录和上传。
- UI 不显示回传状态；本地 outbox 在后台重试。

## 配置

仓库和 APK 均不包含 ingest token。安装 debug APK 并启动一次后运行：

```bash
./tools/provision.sh
```

脚本通过 ADB 将 `ocr-provisioning.json` 写入应用专属目录。应用导入后使用 Android Keystore 加密保存 token，并删除原文件。

服务根地址固定按 provisioning 提供，正式值应为 `https://mobile.314057.xyz`。

## 构建

```bash
gradle testDebugUnitTest assembleDebug
```

GitHub Actions 会生成 `energy-price-debug-apk` artifact。
