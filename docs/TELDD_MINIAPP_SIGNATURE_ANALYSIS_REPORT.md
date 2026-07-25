# 特来电小程序签名与加密能力逆向分析报告

> 分析日期：2026-07-10 | 适用范围：授权蓝军对特来电小程序(wx8d32c1a71ecd965d)的签名/加密链路复现评估

## 1. 结论摘要

特来电小程序的鉴权与加密机制**可完整离线复现**，但其机制与滴滴充电(wsgsig 客户端计算签名)本质不同：

- 滴滴：请求 URL 带 `wsgsig` 签名(HMAC 计算)，靠签名校验。
- 特来电：**无请求签名**，鉴权靠 `token`(ASLogin/ASRefreshToken)；请求/响应均 AES-CBC 加密，密钥为硬编码常量 + 动态 UTS/UVER。

两套机制都已在本地沙箱复现并通过真实抓包验证。

## 2. 材料获取链路

1. 从 172 微信沙盒提取特来电 wxapkg(需先授予终端"完全磁盘访问"以穿透 TCC)。
2. V1MMWX 加密包解密：salt=`saltiest`，iv=`the iv: 16 bytes`，AES-256-CBC，PBKDF2(appid,salt,1000,32,sha1)，wxid 倒数第2字节做剩余异或。
3. 解包得 app-service.js(主包 9100 行 webpack 混淆)。
4. 对照真实抓包 ~/Desktop/tld.har(22 请求，全是 teld.cn 域名)。

## 3. 加密体系总览

| 算法 | aType | 用途 | key | iv |
|------|-------|------|-----|-----|
| AES-CBC | token(1) | ASLogin/ASRefreshToken 请求与响应外层 | `7fb498553e3c462988c3b9573692bd5f` | `98d71fe589499967` |
| AES-CBC | business(2) | SLoginWithAuthCode 等 | `ErYu78ijuVaM7Y0UqwvpO738uNC9ALF7` | `Ol9mqvZ6ijnytr7O` |
| AES-CBC | encryption(3) | SearchStation/GetStationDetails | `ErYu78ijuVaM7Y0UqwvpO738uNC9ALF7` | `Ol9mqvZ6ijnytr7O` |
| AES-CBC(动态) | - | 内层 Data 加密 | UTS(时间戳+"uts"前16) | UVER(UTS加密派生前16) |
| 自定义SHA1 | - | SVER 防篡改 | `yBb6fQbbiHx3g6Me` | - |
| DES-CBC | - | 仅 checkHealthState 上报(非主链路) | `IJL9qaZ7` | `t9TEPqji86aMVuUE` |

> 注：getKI 中 business(2) 与 encryption(3) 共用同一套密钥。

## 4. 请求结构

```
POST https://{动态域名}/api/invoke?SID={groupName}-{methodName}
Headers:
  TELDAppID: (空)
  x-sps-v: 1.0
  Teld-RequestID: {uuid}_{ms_ts}_WX_SP
  Teld-RpcID: 0.5
  X-Token: {AccessToken}   # 登录态接口带
  content-type: application/x-www-form-urlencoded
Body (x-www-form-urlencoded 的 param/loginInfo/refreshToken 字段):
  {"UTS":"<ts>uts","UVER":"<16char>","Data":"<base64>","UUID":"<guid>"}
  + STS/SVER/SSDI/SCOI/SCOL/SRS 公共参数
```

SID 例：
- `CUS-WEBUI-ASLogin` (token)
- `CUS-WEBUI-ASRefreshToken` (token)
- `AAPI-V0700-SCSC-SearchStation` (encryption)
- `AAPI-V0700-SCSC-GetStationDetails` (encryption)

动态域名：H1C→sgh1c.teld.cn, H2C→sgh2c.teld.cn, T1C→sgit1c.teld.cn, A1C→sgia1c.teld.cn。路由由 getNginxSwitch 返回的 IDCSG 决定。

## 5. 响应解密(两阶段，已实测验证)

响应 body = `{"data":"<base64密文>"}`。teldAESDecrypt 两阶段：
1. 用 getKI(aType) 的固定 key/iv 解外层 → `{Data, UTS, UVER}`
2. 用 UTS 作 key、UVER 作 iv 解内层 Data
3. aType==3 时还需 gzip(pako.inflate)解压

实测：用 Python 成功解出 tld.har 中 ASLogin/ASRefreshToken/SearchStation/GetStationDetails 全部响应明文(JSON)。SVER 自定义 SHA1 用 Node 跑原始代码验证，输出与 HAR 完全一致。

## 6. Token/鉴权

- ASLogin 仅需 DeviceId/DeviceType/ReqSource，**不需手机号或微信 code**。
- 返回 AccessToken(`A01`+JWT,20分钟有效)+RefreshToken，存 `RefreshToken0`/`AccessToken0`。
- ASRefreshToken 用 refreshToken 字段刷新，ExpiresIn=1200。
- SLoginWithAuthCode 需微信 AuthCode(wx.login)，但账号未绑定时返回明文错误。

## 7. 离线复现可行性

**结论：可以完整离线复现。** 已验证可复现：请求加密(teldAESEncrypt)、响应解密(teldAESDecrypt+unzip)、SVER(TESDecrypt)、全部密钥常量。

所需要素全部具备：3 套 AES key/iv、UTS/UVER 生成、TESDecrypt(已提取为可运行 JS)、DeviceId、有效 AccessToken(调 ASLogin 获取，无需手机号)、gzip、域名路由。

注意：Token 20 分钟需定期刷新；首次需 getNginxSwitch 取路由或固定 sgh1c/sgit1c；微信登录流程(SLoginWithAuthCode)需小程序运行时取 AuthCode，但 ASLogin 不需要。

## 8. 与滴滴充电对比

| 维度 | 滴滴充电 | 特来电 |
|------|---------|--------|
| 鉴权方式 | wsgsig 客户端签名 | token(无请求签名) |
| 签名位置 | URL query `wsgsig=` | 无(HMAC 仅用于 SVER 防篡改) |
| 请求加密 | 无(明文) | AES-CBC(UTS/UVER 动态) |
| 响应加密 | 无 | AES-CBC 两阶段 + gzip |
| 复现难度 | 中(需提取 wsgsig 算法并沙箱运行) | 中(需还原 AES 两阶段 + 自定义SHA1) |
| 离线可复现 | ✅ 已复现 | ✅ 已复现(含真实抓包验证) |

## 9. 安全说明

本报告仅用于授权蓝军内部安全评估。密钥常量为小程序客户端硬编码，本身属公开可提取信息，但实际请求须遵守低频授权测试边界(每平台主动验证 ≤5 次)，不展示完整 token/会话材料。
