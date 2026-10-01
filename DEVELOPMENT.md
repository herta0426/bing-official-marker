# 开发 / Agent 工作文档

本脚本是一个在必应(Bing)搜索页运行的用户脚本(Tampermonkey)。本文档面向后续维护者与 AI agent，说明架构、关键函数、流程、已知坑与测试方式。

## 总体架构

脚本为单体 `baidudreamourbings.user.js`（IIFE，约 5 万字节）。无构建、无依赖，纯原生浏览器 JS + `GM_xmlhttpRequest`。

**执行流程**
```
Bing 搜索页加载 / SPA 导航 / MutationObserver
  → main(keyword)                         # 检测新搜索、取词、去下载词
  → fetchBaiduOfficialLinks(keyword)      # 主引擎：百度
  → fetchEngineDomains(keyword, engine)   # 参考引擎：搜狗/360/头条/Google/DDG/夸克
  → 证据合并 → 分类 → 打标签注入 / 补全官网
```

## 关键函数

| 函数 | 作用 |
|---|---|
| `normalizeHttpUrl` / `classifyUrl` / `getMatchType` / `getResultDecision` | URL 归一化、风险分类、两级匹配判定 |
| `fetchBaiduOfficialLinks` | 从百度结果 `mu`/`data-landurl`/`data-click` 取真实链接；命中 wappass 时走验证兜底 |
| `fetchEngineDomains` | 参考引擎抓取，**经 `resolveRealHost` 跟随跳转取真实域名** |
| `resolveRealHost` | 识别跳转壳(so.com/sogou.com/toutiao.com/sm.cn/baidu.com…)并跟随重定向取 `finalUrl` 主机名；限制 ≤25 次迭代、结果 ≤15 个 |
| `stripDownloadKeywords` | 去掉「下载/安装包/exe」等词后重搜，避免下载噪音干扰官网 |
| `defaultConfig` / `normalizeConfig` | 配置定义与归一化；`version: 2` 门控，旧配置自动回落新默认 |
| `registerVerification` / `showVerifyBanner` / `triggerVerifyRetry` | 安全验证提示条（百度/360/搜狗/头条通用）+ 一键开验证页 + 关窗自动重试，focus 自动重试**已移除** |
| `isVerificationResponse` / `looksLikeChallenge` / `pickCaptchaSource` | 识别引擎是否被验证拦截（3xx 跳挑战页 / 小体积验证页正文），并从 `Location` 取出真实挑战地址 |

## 跨域白名单（@connect）

`www.baidu.com`、`wappass.baidu.com`、`verify.baidu.com`、`www.sogou.com`、`www.so.com`、`qcaptcha.so.com`、`www.so.toutiao.com`、`www.sm.cn`、`m.sm.cn`、`quark.sm.cn`、`www.google.com`、`html.duckduckgo.com`、`api.openai.com`、`api.deepseek.com`、`dashscope.aliyuncs.com`

> **挑战页域名必须单独写进 `@connect`**（百度 `wappass/verify`、360 `qcaptcha`）。实测 Tampermonkey **会忽略 `followRedirects: false` 直接跟随 302**，落到未授权域名时报 `This domain is not a part of the @connect list` 并走 `onerror` —— 脚本拿不到 `Location`/`finalUrl`，只能静默返回空集合。所以 `followRedirects: false` 不能当保险，白名单才是硬要求。

> **`@connect` 显式写出域名即自动放行，无需手动授权**：只要把每个目标域名都如实列在 `@connect` 中，Tampermonkey 对该域的跨域请求直接放行，不弹任何确认。若用通配符 `@connect *` 或域名遗漏则可能触发逐域授权/导致不注入 → 控制台无 `[官网补全]` 日志（排查"脚本没跑"先核对 `@connect` 是否完整写出全部目标域）。脚本改动无需重装，规则即时更新。

## 配置默认值（version 2）

- `protectionMode: 'mark'`（仅标记，默认不弹窗；曾因下载保护弹窗 bug 回退）
- 参考引擎：百度/搜狗/360/头条 = true；Google/DuckDuckGo = false；**`quark` 强制 false**（阿里滑块验证无法脚本化，UI 置灰禁勾）
- 排除词预设：weather/news/lifestyle/realtime 开，entertainment 关
- AI：默认关；provider openai
- 会话缓存 10 分钟

## 安全验证兜底逻辑（百度 / 360 / 搜狗 / 头条）

被验证拦截的引擎列在 `ENGINE_VERIFY`（label + host + home）。这些引擎的请求**携带浏览器既有 cookie**（`anonymous: false`）并带 `followRedirects: false`——匿名请求即使过码也无法复用验证结果；关跟随是为了尽量从 `Location` 拿到挑战地址，但 **TM 可能忽略它**，所以挑战页域名必须同时在 `@connect` 里（见上节）。

1. 百度请求 `anonymous` 关闭、携带浏览器 cookie 以降低验证触发；`followRedirects: false`。
2. `onload` 用 `isVerificationResponse` 判定拦截：`Location` 或 `finalUrl` 落在挑战页（`looksLikeChallenge`），或 200 但正文是"访问异常页面"类小体积验证页。**两种来源都要判**，因为 TM 跟随跳转后 `Location` 就没了、只剩 `finalUrl`。
3. 命中后 `registerVerification(engine, 挑战地址, 引擎首页)`：挑战地址依次尝试 `Location` → `finalUrl`（`pickCaptchaSource` 支持相对地址），都拿不到就回退引擎首页。
4. 提示条(fixed, z-index 极高) 列出所有被拦引擎，三个按钮：`去完成X验证`（popup，被拦则变红提示放行）、`打开X首页`（**普通新标签页，不监听关闭**）、`重试`。提示条第二行固定告知：**若反复验证不通过（尤其 360），去首页新标签里随便搜一次再重试**——360 的挑战是 IP/行为风控，脚本复用不了过码结果，只能靠用户养出正常会话。
5. `watchPopupClose` 每 500ms 轮询弹窗 `win.closed`，关窗自动 `triggerVerifyRetry()`（3s 防抖）重跑 `main`。**不要再加 focus 自动重试**（会连环刷、激化风控）；`打开X首页` 那条路径故意不参与自动重试，否则用户在里面养会话时一关窗就被打断。
6. 多个引擎同时被拦时并列显示，不会互相覆盖；`bomPendingVerifications` 为待处理队列（含 `home`，供"打开首页"按钮使用）。

## 测试

```bash
node --check baidudreamourbings.user.js   # 语法检查
node --test tests/security-helpers.test.js # 单元测试（纯函数，无浏览器）
```

## 已知坑 / 注意事项

- 搜索引擎链路脆弱：靠 DOM 抓取，站点改版即失效。
- **跳转包壳**：结果链接常是壳（如 `www.so.com/link?m=`），必须跟随重定向，不能直接取 href 域名。
- **360 验证墙**：`https://www.so.com/s?q=` 会被 302 到 `http://qcaptcha.so.com/?ret=…&tk=…`（标题"访问异常页面"，数字验证码）。**实测带真实 cookie 的正常浏览器会话同样被拦**，所以不能只靠 cookie 绕过，必须走"提示条 → 过码 → 关窗重试"。`qcaptcha.so.com` 必须写在 `@connect` 里，否则 TM 拒绝跳转、脚本静默拿到空集合（这是"加了检测却没有任何日志"的根因）。
- **搜狗验证墙**：`https://www.sogou.com/web?query=` 会被 302 到 `https://www.sogou.com/antispider/?m=1&antip=web_hd&from=…`。host 是已白名单的 `www.sogou.com`，所以**只能靠路径段 `antispider` 识别**——把它加进 `looksLikeChallenge` 之前，这种响应会被当成普通非 200 静默丢弃。
- **`fankui.sogou.com` 的报错不用管**：搜狗结果页能拿到时，链接壳 `www.sogou.com/link?url=` 会跳 `fankui.sogou.com`（它的风控反馈端点），TM 拒绝 → `resolveRealHost` 返回空、快速失败。**不要把它加进 `@connect`**：加了之后 TM 会真的去请求它（最多 25 次 × 7s 超时，拖慢整轮），而且解析出来的 `fankui.sogou.com` 会污染证据集合。
- 神马/夸克：`www.sm.cn`→`m.sm.cn` 会跳并触发阿里 x5sec 滑块，对匿名请求固定返回验证页，因此禁用。
- 频繁请求会触发百度 wappass，可能被风控激化；提示条应手动重试而非自动循环。
- 下载保护曾有 bug，默认"仅标记"；如需下载拦截先真实环境验证。