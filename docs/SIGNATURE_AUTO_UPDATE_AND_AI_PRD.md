# 签名语料自动更新 + AI签名演进 产品设计方案

日期：2026-06-08
作者：方宜龙

---

## 一、现状分析

### 1.1 签名语料现状

| 项 | 值 |
|------|------|
| 语料文件 | `data/didi-signature-corpus.json` |
| 生成时间 | 2026-05-28 11:04 |
| 已过期 | 11天 |
| 条目数 | 2012条 |
| 覆盖城市 | 4个（上海、武汉、南京、西安） |
| 数据来源 | fanpa-waf-csv（WAF日志导出） |
| 核心签名参数 | `wsgsig`（微信小程序客户端生成） |

### 1.2 当前架构链路

```
WAF日志CSV → build-didi-signature-corpus.py → didi-signature-corpus.json
                                                              ↓
                                            DidiSignatureProvider.applyListSample()
                                            DidiSignatureProvider.applyDetailSample()
                                                              ↓
                                            OutboundClient.request() → 目标API
```

### 1.3 关键问题

1. **语料过期风险**：`wsgsig`由客户端JS动态生成，含时间戳/会话因子，过期后请求被拒（苏州/桂林501）
2. **城市覆盖不足**：仅4城，新增城市无签名可用
3. **更新依赖人工**：需手动导WAF CSV → 跑脚本 → 替换文件 → 重启服务
4. **无失效检测**：不知道签名何时失效，直到爬取失败才发现

### 1.4 现有资产盘点

| 资产 | 能力 | 签名捕获能力 |
|------|------|-------------|
| `mobilecollector`（Android APK） | OCR采集、无障碍操控、网络指令 | ❌ 不捕获HTTP流量 |
| `export-charles.applescript` | Charles导出HAR | ✅ macOS端可导出 |
| `build-didi-signature-corpus.py` | CSV→语料构建 | ✅ 已有构建逻辑 |
| WAF日志导出 | 服务端日志 | ✅ 当前唯一数据源 |

---

## 二、方向一：签名语料自动更新

### 2.1 总体方案

采用**三层采集 + 定时构建 + 热更新**架构：

```
┌─────────────── 采集层 ───────────────┐
│  ① MITM代理（Android） — 主力       │
│  ② Charles HAR（macOS）  — 辅助     │
│  ③ WAF日志CSV           — 兜底      │
└──────────────────────────────────────┘
              ↓ 原始流量
┌─────────────── 构建层 ───────────────┐
│  corpus-builder 服务                  │
│  - 统一格式化（HAR/CSV/mitm）         │
│  - 去重 + 质量筛选                    │
│  - 城市标注 + 坐标匹配               │
│  - 输出 didi-signature-corpus.json   │
└──────────────────────────────────────┘
              ↓ 语料文件
┌─────────────── 运行层 ───────────────┐
│  DidiSignatureProvider                │
│  - fs.watch 热加载                    │
│  - 失效检测 + 告警                    │
└──────────────────────────────────────┘
```

### 2.2 签名捕获方式对比与选择

| 方案 | 原理 | 优势 | 劣势 | 推荐度 |
|------|------|------|------|--------|
| **MITM代理（Android）** | 在Android端安装自签CA，代理微信流量 | 全自动、可扩展城市、实时 | 需root或用户安装CA、微信可能证书固定 | ⭐⭐⭐⭐ |
| **Charles代理（macOS）** | macOS端Charles代理+导出HAR | 已有脚本、无需root | 需手动操作、单机 | ⭐⭐⭐ |
| **小程序Hook（Frida）** | Hook签名JS函数直接拿参数 | 最精准、拿到生成逻辑 | 需root、逆向维护成本高 | ⭐⭐ |
| **WAF日志** | 服务端日志导出 | 无需客户端、已跑通 | 延迟高（T+1）、覆盖有限 | ⭐⭐ |

**推荐方案：MITM代理为主，Charles为辅，WAF兜底。**

### 2.3 MITM代理方案详细设计

#### 2.3.1 架构

```
Android手机（安装mitmproxy CA）
    ↓ HTTP/HTTPS
mitmproxy（运行在开发机/服务器）
    ↓ 拦截 + 转发
微信小程序 → energy.xiaojukeji.com
    ↓
mitmproxy addon 自动提取签名参数
    ↓
写入 corpus-raw/ 目录（JSONL格式）
```

#### 2.3.2 mitmproxy addon 核心逻辑

```python
# mitm-addon/didi-signature-capture.py
import json
import time
from mitmproxy import http

TARGET_HOSTS = ["energy.xiaojukeji.com"]
TARGET_PATHS = ["/station-api/homepage/stationList", "/station-api/station/getoneinfo"]

class DidiSignatureCapture:
    def response(self, flow: http.HTTPFlow):
        req = flow.request
        if req.pretty_host not in TARGET_HOSTS:
            return
        if not any(p in req.path for p in TARGET_PATHS):
            return

        entry = {
            "capturedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "method": req.method,
            "baseUrl": req.pretty_url,
            "path": req.path,
            "queryParams": dict(req.query),
            "bodyParams": json.loads(req.get_text()) if req.get_text() else {},
            "headers": dict(req.headers),
            "responseStatus": flow.response.status_code if flow.response else None,
        }

        with open(f"corpus-raw/capture-{time.strftime('%Y%m%d')}.jsonl", "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

addons = [DidiSignatureCapture()]
```

#### 2.3.3 Android端部署

1. **CA安装**：通过ADB推送mitmproxy CA证书到系统信任区（需root或Android 7+用户证书）
2. **代理配置**：ADB设置WiFi代理指向mitmproxy
3. **自动化**：`mobile_city_batch.py`扩展`collect_landmark_with_capture`命令，采集前自动开代理+mitmproxy，采集后关代理
4. **多城市**：Android设备按城市列表自动切换，每次切换城市时同步采集签名

### 2.4 语料构建流程

#### 2.4.1 统一构建脚本

在现有`build-didi-signature-corpus.py`基础上扩展，支持多数据源输入：

```
corpus-builder/
  ├── build-corpus.py          # 统一入口，合并多源
  ├── parse-har.py             # 解析Charles HAR
  ├── parse-mitm-jsonl.py      # 解析mitmproxy JSONL
  ├── parse-waf-csv.py         # 解析WAF CSV（已有）
  └── cities.json              # 城市目标列表（可扩展）
```

#### 2.4.2 构建逻辑

```
1. 加载城市目标列表（cities.json，含城市名/中心坐标）
2. 遍历所有数据源（HAR/JSONL/CSV），解析请求
3. 按URL path区分 list/detail scope
4. 坐标匹配：计算请求坐标与最近城市中心的距离，标注城市
5. 质量筛选：
   - 必须含 wsgsig 参数
   - 响应状态码 200
   - 距离城市中心 ≤ maxDistanceKm
6. 去重：同一城市+同一pageNo+同一scope，只保留最新的N条
7. 输出 corpus.json（与现有格式完全兼容）
```

#### 2.4.3 城市覆盖扩展策略

```json
{
  "tier1": [
    {"city": "上海", "lat": 31.2304, "lng": 121.4737},
    {"city": "武汉", "lat": 30.5928, "lng": 114.3055},
    {"city": "南京", "lat": 32.0603, "lng": 118.7969},
    {"city": "西安", "lat": 34.3416, "lng": 108.9398}
  ],
  "tier2": [
    {"city": "北京", "lat": 39.9042, "lng": 116.4074},
    {"city": "广州", "lat": 23.1291, "lng": 113.2644},
    {"city": "深圳", "lat": 22.5431, "lng": 114.0579},
    {"city": "青岛", "lat": 36.0671, "lng": 120.3826}
  ],
  "tier3": [
    {"city": "苏州", "lat": 31.2990, "lng": 120.5853},
    {"city": "桂林", "lat": 25.2744, "lng": 110.2992}
  ]
}
```

- **tier1**：每次采集必覆盖（已有语料，增量更新）
- **tier2**：每周覆盖1次（新城市扩展，已有地标数据）
- **tier3**：按需覆盖（问题城市，定向补充）

### 2.5 触发机制

| 触发方式 | 时机 | 说明 |
|----------|------|------|
| **定时更新** | 每天凌晨3:00 | mitmproxy自动采集tier1城市签名 |
| **按需更新** | 失效检测触发 | 检测到签名失效时立即触发采集 |
| **手动触发** | API接口 | 运维人员手动触发采集特定城市 |
| **城市扩展** | 新城市首次采集 | 自动运行一次签名采集再开始爬取 |

### 2.6 热更新流程

当前`DidiSignatureProvider`已通过`fs.statSync`的`mtimeMs`实现文件变更检测和缓存刷新：

```javascript
// didi-signature-provider.js 已有的热加载逻辑
if (this.cache && this.cacheMtimeMs === stat.mtimeMs) {
    return this.cache;  // 缓存未变，直接返回
}
// 文件变了，重新加载
const payload = JSON.parse(fs.readFileSync(this.corpusPath, 'utf8'));
```

**无需修改Provider代码**，只需替换语料文件即可实现热更新。增加：

1. **原子替换**：先写临时文件，再`mv`覆盖，避免读到半写状态
2. **更新通知**：写一个`corpus-updated`事件，通知爬取调度器刷新

```bash
# 原子替换
python3 build-corpus.py --out /tmp/corpus-new.json
mv /tmp/corpus-new.json data/didi-signature-corpus.json
# Provider下次请求自动加载新语料
```

### 2.7 失效检测与告警

#### 2.7.1 检测维度

| 维度 | 检测方法 | 阈值 | 告警级别 |
|------|----------|------|----------|
| **语料年龄** | corpus.json的meta.generatedAt | >7天 | ⚠️ 警告 |
| **请求失败率** | OutboundClient返回501/403比例 | >20% | 🔴 严重 |
| **签名命中率** | 有签名vs无签名的请求比例 | <80% | ⚠️ 警告 |
| **城市覆盖率** | 有语料的城市/目标城市 | <100% tier1 | ⚠️ 警告 |
| **语料新鲜度** | 最近capturedAt距今 | >3天 | ⚠️ 警告 |

#### 2.7.2 检测实现

在`DidiSignatureProvider`中增加健康检查方法：

```javascript
healthCheck() {
    const entries = this.getEntries();
    const meta = this.loadMeta();
    const now = Date.now();
    const generatedAt = new Date(meta.generatedAt).getTime();
    const ageDays = (now - generatedAt) / (1000 * 60 * 60 * 24);

    const cities = new Set(entries.map(e => e.city));
    const latestCapture = entries.reduce((max, e) =>
        new Date(e.capturedAt).getTime() > max ? new Date(e.capturedAt).getTime() : max, 0);
    const freshDays = (now - latestCapture) / (1000 * 60 * 60 * 24);

    return {
        totalEntries: entries.length,
        cityCount: cities.size,
        cities: [...cities],
        ageDays: Math.round(ageDays * 10) / 10,
        freshDays: Math.round(freshDays * 10) / 10,
        status: ageDays > 7 ? 'stale' : freshDays > 3 ? 'aging' : 'fresh',
        recommendation: ageDays > 7 ? '语料已过期，建议立即更新'
                      : freshDays > 3 ? '语料新鲜度下降，建议安排更新'
                      : '语料正常'
    };
}
```

#### 2.7.3 告警通道

- **D-Chat机器人**：推送到项目群
- **日志记录**：写入`data/corpus-health.log`
- **API暴露**：`GET /api/system/corpus-health`，供前端/监控调用
- **自动触发**：`stale`状态自动触发一次语料更新

---

## 三、方向二：AI签名生成

### 3.1 可行性分析

#### 3.1.1 wsgsig签名机制推测

| 特征 | 推测 |
|------|------|
| 参数位置 | query string |
| 命名 | `wsgsig`（WSG = WeChat Signature?） |
| 输入因素 | 可能包含：URL路径 + 请求参数 + 时间戳 + 会话密钥 |
| 生成位置 | 小程序客户端JS代码 |
| 依赖项 | 可能依赖`ticket`/`openid`等微信登录态 |

#### 3.1.2 AI生成的可行性判断

| 路径 | 可行性 | 难度 | 说明 |
|------|--------|------|------|
| **逆向签名算法** | ⭐⭐⭐⭐ | 中 | 反编译小程序JS，找到签名函数，用AI辅助理解 |
| **模式学习** | ⭐⭐ | 高 | 纯靠语料学习签名模式，输入输出关系复杂 |
| **签名重放+变换** | ⭐⭐⭐ | 低 | 复用已有签名，仅变换时间戳/坐标等非签名因子 |
| **实时签名服务** | ⭐⭐⭐⭐⭐ | 中 | 逆向后在服务端实现签名，彻底脱离语料 |

**结论**：纯AI"学习"签名模式可行性低（加密算法不可学），但AI辅助逆向+服务端签名生成可行。

### 3.2 演进路线图

```
阶段0（当前）          阶段1               阶段2              阶段3
语料回放        →  语料自动更新     →  AI辅助逆向      →  签名生成服务
                                                         
❌ 手动导CSV         ✅ MITM自动采集     ✅ AI反编译JS      ✅ 服务端签名
❌ 11天过期          ✅ 每日更新         ✅ 算法识别        ✅ 实时生成
❌ 4城市             ✅ 多城市扩展       ✅ 参数还原        ✅ 无城市限制
❌ 无检测            ✅ 失效告警         ✅ 算法复现        ✅ 永不过期
```

#### 阶段1：语料自动更新（方向一，2周）

详见第二章。

#### 阶段2：AI辅助逆向（3-4周）

**步骤1：小程序JS提取**

```bash
# 从微信缓存中提取小程序源码
adb shell "find /data/data/com.tencent.mm/ -name '*.wxapkg'" > wxapkg-list.txt
# 解包
python3 wxappUnpacker.py -d xxx.wxapkg -o ./miniprogram-src/
```

**步骤2：AI辅助算法识别**

将提取的JS代码（混淆后）交给AI分析：

```
分析以下微信小程序JS代码，找出wsgsig签名的生成逻辑：
1. 签名函数入口在哪？
2. 输入参数有哪些？
3. 加密/哈希算法是什么？
4. 是否有服务端交互获取密钥？
5. 时间戳/随机因子如何参与？
```

**步骤3：算法复现验证**

```javascript
// 基于AI分析结果，在Node.js中复现签名
function generateWsgsig(params) {
    const { path, query, timestamp, sessionKey } = params;
    const input = `${path}|${sortAndJoin(query)}|${timestamp}|${sessionKey}`;
    return crypto.createHash('sha256').update(input).digest('hex');
}
```

#### 阶段3：签名生成服务（2-3周）

```
┌─────────────────────────────────────────────┐
│  Signature Service                           │
│                                              │
│  POST /api/signature/generate                │
│  { platform, scope, params, city }           │
│                                              │
│  → 获取sessionKey（从小程序/缓存）            │
│  → 按逆向算法计算wsgsig                      │
│  → 返回完整签名参数                          │
│                                              │
│  GET  /api/signature/health                  │
│  → 签名可用性检查                            │
└─────────────────────────────────────────────┘
```

集成到现有Provider：

```javascript
class DidiSignatureProvider {
    constructor(options) {
        this.signatureServiceUrl = options.signatureServiceUrl || null;
        this.fallbackToCorpus = options.fallbackToCorpus !== false;
    }

    async applyListSample(pattern, params, headers, proxyContext, options) {
        // 优先尝试签名生成服务
        if (this.signatureServiceUrl) {
            try {
                const generated = await this.generateSignature(pattern, params, 'list');
                if (generated) return generated;
            } catch (e) {
                // 降级到语料
            }
        }
        // 降级到语料回放
        return this.findListSample(pattern, params, proxyContext, options);
    }
}
```

### 3.3 验证标准

| 验证项 | 方法 | 通过标准 |
|--------|------|----------|
| **算法正确性** | 用已知请求参数+已知签名，验证生成结果一致 | 100%匹配 |
| **请求成功率** | 用生成签名请求目标API | ≥95% 返回200 |
| **时效性** | 签名生成后多少秒内有效 | ≥60秒 |
| **城市通用性** | 同一算法在不同城市请求中有效 | 全部tier1城市通过 |
| **降级可用** | 签名服务异常时降级到语料回放 | 自动降级，无报错 |

### 3.4 风险评估与回退

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 逆向失败（代码强混淆/白盒加密） | 中 | 阻塞阶段2→3 | 阶段1已解决实时性问题，阶段2可长期迭代 |
| 签名算法升级（微信版本更新） | 低 | 阶段3失效 | 监控失败率，自动降级到语料模式 |
| sessionKey获取困难 | 中 | 无法独立生成签名 | 维持MITM采集作为备选，sessionKey可从MITM流量中提取 |
| 法律合规风险 | 低 | 逆向可能违反条款 | 仅用于内部安全测试，不对外服务 |

**回退策略**：每个阶段独立可用，任何阶段失败都不影响前一阶段正常运行。

---

## 四、证据中心迭代规划

### 4.1 当前完成度

| 模块 | 状态 | 备注 |
|------|------|------|
| 报告CRUD | ✅ 已完成 | start/events/evidence/finalize |
| 报告列表+详情页 | ✅ 已完成 | 前端页面已部署 |
| 脱敏选项 | ✅ 已完成 | 查看/下载脱敏 |
| 爬虫集成 | ✅ 已完成 | 自动创建报告 |
| 172服务器部署 | ✅ 已完成 | 已验证 |

### 4.2 下一迭代目标

聚焦**实用性提升**，从"能看"到"好用"。

### 4.3 迭代功能清单

#### P0：签名健康看板

| 功能 | 说明 |
|------|------|
| 语料状态卡片 | 展示语料年龄、城市覆盖、条目数、新鲜度 |
| 失效告警 | 语料过期/签名失败率飙升时，看板标红 |
| 更新操作 | 一键触发语料更新（关联方向一） |

#### P0：报告对比

| 功能 | 说明 |
|------|------|
| 同城历史对比 | 同城市不同日期报告的指标对比 |
| 复测对比 | 原报告 vs 复测报告并排展示 |
| 指标趋势 | 城市匹配率/完整率随时间变化的折线图 |

#### P1：证据中心增强

| 功能 | 说明 |
|------|------|
| 证据预览 | 截图缩略图、OCR文本预览（不必下载） |
| 证据关联 | 点击风险发现自动定位到对应证据 |
| 批量下载 | 打包下载报告全部证据（zip） |

#### P1：签名管理页

| 功能 | 说明 |
|------|------|
| 签名采集状态 | 显示MITM代理连接状态、采集进度 |
| 语料城市管理 | 增删城市、调整覆盖优先级 |
| 签名生成服务 | 显示阶段3签名服务状态（如已上线） |

#### P2：工作流自动化

| 功能 | 说明 |
|------|------|
| 定时采集 | 配置定时任务（每天/每周采集哪些城市） |
| 采集→报告 | 采集完成后自动生成蓝军报告 |
| 通知推送 | 报告完成后推送D-Chat通知 |

### 4.4 技术架构演进

```
当前架构                              迭代后架构
┌─────────────────┐            ┌──────────────────────────┐
│  Frontend       │            │  Frontend                │
│  - 报告列表     │            │  - 报告列表+对比         │
│  - 报告详情     │            │  - 报告详情+证据预览     │
│  - 脱敏开关     │            │  - 签名健康看板          │
└─────────────────┘            │  - 签名管理页            │
┌─────────────────┐            └──────────────────────────┘
│  Backend        │            ┌──────────────────────────┐
│  - 报告CRUD API │            │  Backend                 │
│  - 脱敏API      │            │  - 报告CRUD API          │
│  - 同步API      │            │  - 脱敏API               │
└─────────────────┘            │  - 同步API               │
┌─────────────────┐            │  - 签名健康API           │
│  Data           │            │  - 语料管理API           │
│  - stations.db  │            │  - 报告对比API           │
│  - corpus.json  │            └──────────────────────────┘
│  - reports/     │            ┌──────────────────────────┐
└─────────────────┘            │  Data                    │
                               │  - stations.db           │
                               │  - corpus.json           │
                               │  - reports/              │
                               │  - corpus-raw/ (新增)    │
                               │  - corpus-health.log     │
                               └──────────────────────────┘
                               ┌──────────────────────────┐
                               │  Services (新增)          │
                               │  - mitmproxy + addon     │
                               │  - corpus-builder 定时   │
                               │  - signature-service(未来)│
                               └──────────────────────────┘
```

### 4.5 里程碑

| 里程碑 | 内容 | 时间 |
|--------|------|------|
| M1 | MITM采集 + 语料自动构建 + 热更新 + 失效检测 | 第1-2周 |
| M2 | 签名健康看板 + 报告对比 | 第3周 |
| M3 | 城市扩展(tier2) + 证据预览增强 | 第4周 |
| M4 | AI辅助逆向启动 + 小程序JS提取 | 第5-6周 |
| M5 | 签名生成服务(如逆向成功) + 工作流自动化 | 第7-8周 |

---

## 五、总结

| 方向 | 核心价值 | 投入 | 收益 |
|------|----------|------|------|
| 签名语料自动更新 | 解决语料过期问题 | 2周 | 签名永不过期、城市可扩展 |
| AI签名生成 | 从回放升级到生成 | 5-8周 | 彻底脱离语料依赖、无城市限制 |
| 证据中心迭代 | 从能用到好用 | 3-4周 | 实用性+可观测性大幅提升 |

三个方向相互支撑：语料自动更新是基础，AI签名生成是终态，证据中心迭代让整个系统可观测、可管理。
