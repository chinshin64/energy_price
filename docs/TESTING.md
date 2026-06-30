# 测试与验收

## 语法检查

```bash
node --check backend/index.js
node --check backend/local-preview.js
node --check backend/services/mobile-command.js
node --check backend/services/mobile-sync.js
node --check frontend/public/app.js
node --check frontend/public/crawler.js
bash -n scripts/*.sh
```

## 回归脚本

```bash
./run-preview-smoke-test.sh
./run-backend-smoke-test.sh
./check-db-status.sh
./check-template-api.sh
./run-har-learning-smoke-test.sh
./check-ocr-env.sh
./check-charles-env.sh
./run-schedule-smoke-test.sh
```

## 页面模拟验证

- 页面访问正常。
- OCR 或文本读取可返回结构化结果。
- 异常时显示权限、窗口、页面状态。
- 识别结果可进入数据中心或证据中心。

## 业务请求验证

- 录包服务状态可查询。
- HAR 可导入。
- 模板可学习。
- 模板可保存、查询、去重。
- 请求证据可归档。

## 自动化采集验证

- 目标位置可解析。
- 坐标网格可生成。
- 请求预算生效。
- 列表模板可执行。
- 详情模板可执行。
- 失败原因可在结果中展示。

## 证据中心

- 报告列表可展示。
- 报告详情可打开。
- 风险发现、证据矩阵、复测标准可展示。
- 原始请求证据可筛选。
- 报告可下载。

## 手机交互控制

- 设备状态可刷新。
- 指令可解析。
- 任务可下发。
- 执行进度可展示。
- 结果可回传。

## 数据中心

- 相同场站不同采集时间保留多条快照。
- 分时价格写入价格表。
- 统计数据与数据库查询一致。
- CSV 可导出。
