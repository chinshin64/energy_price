# energy_price

Android 11+ 高德加油页面截屏采集器。用户手动操作高德时，应用使用 Android MediaProjection 持续截屏和本地中文 OCR，识别油站名、92#/95#、200 元时的油站价、优惠价、立减优惠、服务费、实付金额和 CP，并按 mobile-source v3 协议上传。

## 采集边界

- 不使用无障碍权限。
- 用户点击“开始截屏采集”后，由 Android 系统弹出截屏授权确认。
- 不自动点击，不发起支付。
- 92# 和 95# 通过页面蓝色选中态辅助判定，每个油号单独记录。
- CP 只从支付页提取；页面底部区域会单独放大 OCR，并要求连续两帧一致。
- 油站价和优惠价必须分别识别，禁止用优惠价回填油站价。
- UI 不显示数据上传状态；本地 outbox 在后台重试。

## 视频回归基准

`VideoSixRecordRegressionTest` 固化了用户视频中的 3 个油站 × 92#/95# 共 6 条记录：

- 浙江石油塘河供能加油站：CP 团油
- 双龙加油站：CP 易加油
- 中化道达尔杭州留祥路加油站：CP 滴滴加油

OCR 误读“滴加油”会规范为“滴滴加油”，原始证据文本仍保留在 payload 的 raw/evidence 中。

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

GitHub Actions 会生成 `energy-price-debug-apk` artifact，并在测试失败时保留 `android-test-log`。
