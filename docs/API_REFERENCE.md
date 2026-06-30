# 核心接口速查

## 基础

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/config` | GET | 当前运行模式、平台、基础配置 |
| `/api/stations/recent` | GET | 最近场站 |
| `/api/stations/range` | GET | 按时间范围查询场站 |
| `/api/stations/deduplicate` | POST | 执行统一去重 |
| `/api/export/csv` | GET | 导出 CSV |

## 手机同步与控制

这些接口已取消 `MOBILE_SYNC_TOKEN` 校验，访问权限由部署网络边界控制。

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/mobile-sync/config` | GET | 手机端同步配置 |
| `/api/mobile-sync/devices/register` | POST | 手机注册控制会话 |
| `/api/mobile-sync/commands/poll` | GET | 手机轮询待执行命令 |
| `/api/mobile-sync/commands/:id/result` | POST | 手机回传命令结果 |
| `/api/mobile-sync/ocr` | POST | 上传 OCR 文本行 |
| `/api/mobile-sync/stations` | POST | 上传手机端解析后的场站 |
| `/api/mobile-sync/supervisor` | POST | 上传 AI/规则监督事件 |
| `/api/mobile-control/browser-session` | POST | 兼容旧前端的无鉴权会话接口，返回 authMode=disabled |
| `/api/mobile-control/devices` | GET | 查看在线设备 |
| `/api/mobile-control/commands` | GET/POST | 查询或下发单条命令 |
| `/api/mobile-control/workflows` | GET | 查询手机工作流 |
| `/api/mobile-control/workflows/city-increment/start` | POST | 启动多城市增量采集工作流 |
| `/api/mobile-control/interaction/config` | GET | 查询 DCC/规则解析配置 |
| `/api/mobile-control/chat` | POST | 自然语言对话并下发命令 |
| `/api/mobile-control/chat/sessions` | GET | 查询对话会话 |

## 后台自动化识别

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/smart-collect/preflight` | POST | 自动化前置检查 |
| `/api/smart-collect/start` | POST | 启动自动化会话 |
| `/api/smart-collect/scroll` | POST | 执行一次或多次下滑 |
| `/api/smart-collect/status/:sessionId` | GET | 查询会话状态 |
| `/api/smart-collect/finish` | POST | 结束会话 |
| `/api/smart-collect/sessions` | GET | 查询会话列表 |
| `/api/smart-collect/cancel` | POST | 取消会话 |

## HAR 与模板

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/parse-charles` | POST | 解析 Charles/HAR 文件路径 |
| `/api/parse-har-upload` | POST | 上传 HAR 并解析入库 |
| `/api/crawler/learn` | POST | 从请求样本学习模板 |
| `/api/crawler/learn-upload` | POST | 上传 HAR 学习模板 |
| `/api/capture-recorder/status` | GET | 查询内置录包服务状态、监听端口和最近 HAR 会话 |
| `/api/capture-recorder/start` | POST | 启动系统录包服务，生成 HAR 会话 |
| `/api/capture-recorder/stop` | POST | 停止当前系统录包服务 |
| `/api/templates` | GET/POST | 查询或新增模板 |
| `/api/templates/batch` | POST | 批量保存模板 |
| `/api/templates/deduplicate` | POST | 清理重复模板 |
| `/api/templates/:id` | GET/PUT/DELETE | 模板详情、更新、删除 |
| `/api/templates/platform/:platform` | GET | 查询平台模板 |
| `/api/templates/:id/use` | POST | 使用指定模板采集 |

## 流量自动化识别

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/outbound/status` | GET | 查询统一出口配置摘要和最近请求证据 |
| `/api/outbound/evidence/recent` | GET | 查询最近服务器侧外部请求证据 |
| `/api/crawler/run-quota` | GET/PUT | 查询或更新当次请求上限 |
| `/api/crawler/generate-grid` | POST | 生成地标周边坐标网格 |
| `/api/crawler/crawl` | POST | 执行模板采集；响应包含 `preflightDiagnostics`，用于说明签名模板跨城保护等前置跳过原因 |
| `/api/crawler/crawl-platforms-with-coordinates` | POST | 同步执行多平台坐标采集 |
| `/api/crawler/crawl-platforms-with-coordinates/start` | POST | 异步启动多平台坐标采集；支持单任务多 `targetLocations`，每个目标独立请求预算和 `proxyContext` |

## 定时任务与自愈

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/schedules` | GET/POST | 查询或创建定时任务 |
| `/api/schedules/:id/drill` | POST | 演练任务 |
| `/api/schedules/:id` | DELETE | 删除任务 |
| `/api/self-heal/settings` | GET/PUT | 自愈配置 |
| `/api/self-heal/runs` | GET | 自愈记录 |
| `/api/self-heal/diagnose` | POST | 诊断异常 |
| `/api/self-heal/apply` | POST | 应用恢复动作 |
