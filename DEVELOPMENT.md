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
| `isEngineHost` / `extractEmbeddedTarget` | 识别引擎域（壳）与壳地址里编码的明文目标（递归解码，限 3 层） |
| `stripDownloadKeywords` | 去掉「下载/安装包/exe」等词后重搜，避免下载噪音干扰官网 |
| `defaultConfig` / `normalizeConfig` | 配置定义与归一化；`version: 2` 门控，旧配置自动回落新默认 |
| `registerVerification` / `showVerifyBanner` / `triggerVerifyRetry` | 安全验证提示条（百度/360/搜狗/头条通用）+ 一键开验证页 + 关窗自动重试，focus 自动重试**已移除** |
| `isVerificationResponse` / `looksLikeChallenge` / `pickCaptchaSource` | 识别引擎是否被验证拦截（3xx 跳挑战页 / 小体积验证页正文），并从 `Location` 取出真实挑战地址 |
| `engineSearchUrls` / `NON_EVIDENCE_HOSTS` | 各引擎搜索地址（主机名必须与 `@connect` 对齐）与不参与证据抓取的引擎自家主机 |
| `resolveAnchorHost` / `REAL_TARGET_ATTRS` | 结果项 → 真实目标主机名，**全程零请求**：属性（360 的 `data-mdurl`/`e-landurl`）→ 壳内明文目标解码 → 直链；已知壳解不出就放弃 |
| `xsnLookupHosts` / `xsnLookupHit` / `applyXsnVerdict` | XSN 只读情报：按域名查询 `GET /v1/ioc/:type/:value`，命中 `critical`/`high` 的结果标红为「XSN 风险」（标签只反映 XSN 判定，不做本地推断） |
| `trustedPlatformFor` / `applyTrustedPlatformVerdict` | 可信平台免检查名单：主机名（含子域）命中后把「未验证/需确认」换成绿色「可信平台」，本地高危与已验证官网不受影响 |

## 元数据块（UserScript header）

按 Tampermonkey 规范补全：`@namespace` 用仓库地址（原先是 TM 占位符 `http://tampermonkey.net/`）、`@license MIT`、`@homepageURL`/`@supportURL`、`@downloadURL`/`@updateURL` 指向 `main` 的 raw 地址（自动更新）、`@run-at document-idle`（与 TM 默认一致，显式写出）、`@noframes`。`@grant` 只列真正用到的 5 个 API：`GM_xmlhttpRequest`/`GM_addStyle`/`GM_getValue`/`GM_setValue`/`GM_registerMenuCommand`。

> **改 `@namespace` 的代价**：TM 以 `@namespace`+`@name` 识别脚本，改动后已装旧版的用户升级时可能被当成新脚本，**GM 存储里的配置（`bom-config`）会回到默认**，需要重新设置一次。发布后不要再改。

## 跨域白名单（@connect）

`www.baidu.com`、`wappass.baidu.com`、`verify.baidu.com`、`www.sogou.com`、`www.so.com`、`qcaptcha.so.com`、`so.toutiao.com`、`www.sm.cn`、`m.sm.cn`、`quark.sm.cn`、`www.google.com`、`html.duckduckgo.com`、`api.openai.com`、`api.deepseek.com`、`dashscope.aliyuncs.com`

## 可信平台（免检查名单）

**动机**：GitHub、论坛、百科这类平台的**平台本身可信，但页面内容是用户上传的**。脚本既判不了仓库/帖子里的内容，也不该给它们刷「未验证」——那是纯噪音。所以对这些域名只做"平台级"判定。

**匹配**：`trustedPlatformFor(hostname, config)` 用 `host === item || host.endsWith('.' + item)` 做主机名匹配。子域命中（`gist.github.com` → `github.com`），后缀仿冒不命中（`github.com.evil.tld`、`evilgithub.com`）。名单默认值在 `DEFAULT_TRUSTED_PLATFORMS`，配置里可增删，清空即关闭。

**优先级**（`applyTrustedPlatformVerdict`）：本地高危（`level === 'high-risk'`）**不受名单影响**，仍标红「高风险链接」；`官网参考` 保持不变；其余（未验证/需确认）换成「可信平台」+ `requiresConfirmation: false`。

**与 XSN 的关系**：名单内的域名不进 `xsnLookupHosts` 的查询列表（既不检查，也不把这些域名发出去）；`applyXsnVerdict` 里另有一道 `label === '可信平台'` 的短路，保证即使拿到命中也不会覆盖名单判定——顺序不敏感，两处都拦。

**注意**：免检查只针对域名信誉这一维。下载保护（`shouldConfirmNavigation`）是另一套逻辑，名单内的平台下带下载意图的结果仍会按保护模式弹确认。

## XSN 情报标红（只读）

**动机**：脚本本地的高危判定（`classifyUrl`）只覆盖明文类特征——非 HTTPS、IP、短链、非标准端口、URL 内嵌凭据。仿冒/钓鱼站通常是 HTTPS + 正常端口 + 真域名，本地全部通过，只落成「未验证」。所以高危维度必须由外部信誉情报补齐，否则「高危」等价于「HTTP」。

**只用公开接口**：XSN 官网首页「API 接入」列出的 `GET /v1/ioc/:type/:value`。`xsnRequest` **只实现 GET**（签名里没有 method/data），结构上不存在写入路径——脚本不注册节点、不上报、不碰 `/v1/telemetry` 与 `/v1/scan/report`。

**标签语义**：`applyXsnVerdict` 只在 `severity` 为 `critical`/`high` 且 `status !== 'false_positive'` 时把标签替换为「XSN 风险」，`low`/`medium` 一律不动原有判定（该库里 medium/low 多为弱信号）。标签不区分家族、不做「伪官网」之类的本地推断，家族/等级/置信度/命中次数放在 `title` 悬浮提示里（`xsnHitTitle`）。

**匹配方向**：查询按结果主机名逐个发起（`xsnLookupHosts`），索引命中用两级——先精确主机名，再回落到主域（情报记 `bad.com`、结果在 `login.bad.com` 时命中）。反向（索引在子域、结果在更深子域）不匹配。

**接口地址固定**：`XSN_DEFAULT_ENDPOINT` 是常量，不进配置、界面上没有输入框（该服务的接口地址不可改）。

**缓存与失败处理**：只有 HTTP 200 的查询结果才写入 GM 存储（`bom-xsn-ioc-cache`），TTL 10 分钟，单页最多查 20 个域名；`found:false` 的负结果同样缓存，避免重复请求。**限流或网络失败（403/429/超时）时既不标记也不缓存**——否则会把"这次没查到"当成"这个域名没问题"缓存 10 分钟，对安全标记是有害的；此时打一条 `console.warn` 便于排查。

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
- **不要再"跟随重定向取真实域名"**：Tampermonkey 不仅校验 `GM_xmlhttpRequest` 的初始 URL，**对跨域跳转的落点同样校验**。壳跳转必然离开引擎域名落到目标站，落点不在白名单就中断，报 `Request was redirected to a not whitelisted URL`（不是"验证拦截"）。实测一次搜索周期内刷出 37 条这种拒绝（落点正是 `www.douyin.com` 等真实目标），而一条证据都拿不到——所以 1.3 起**彻底删掉跟跳转**（原 `resolveRealHost` 已移除），改为 `resolveAnchorHost` 的零请求解析链。
- **零请求解析链**（`resolveAnchorHost`，见该函数注释）：① 属性 `data-mdurl` / `e-landurl`（360）；② 壳地址里编码的明文目标，`EMBEDDED_TARGET_PARAMS` 递归解码（头条 `/search/jump?…&url=<编码的 zlink，其 h5_url 再编码一层>`、Google `/url?q=`、DDG `/l/?uddg=`）；③ 直链取主机名。解出来仍落在引擎域（如头条自己的 `m.toutiao.com` 文章页）就当没有，避免污染证据集；完全解不出的壳（搜狗 `/link?url=hedJjaC…` 加密串）直接放弃。**线上实测**：对 `so.toutiao.com/search?keyword=抖音` 的真实 4.4MB 页面，单页可解出 `www.douyin.com`、`musician.douyin.com`、`creator.douyin.com`、`m.wandoujia.com`、`www.bilibili.com` 等，全程零请求。
- **若哪天想让搜狗也贡献证据**：它的 `url=` 是加密的，本地解不出，只能靠跟跳转，而跟跳转需要 `@connect *`（放宽权限面）。当前取舍是：宁可少一个引擎的证据，也不放宽权限、不刷红字。
- **搜狗"降级到 http 拿明文直链"的旧技巧已失效**（2023 年的做法）：实测 `http://www.sogou.com/web?query=` 现在 302 回 `https://www.sogou.com/web?...`，响应体只有 137 字节，拿不到明文直链。
- **360 验证墙**：`https://www.so.com/s?q=` 会被 302 到 `http://qcaptcha.so.com/?ret=…&tk=…`（标题"访问异常页面"，数字验证码）。**实测带真实 cookie 的正常浏览器会话同样被拦**，所以不能只靠 cookie 绕过，必须走"提示条 → 过码 → 关窗重试"。`qcaptcha.so.com` 必须写在 `@connect` 里，否则 TM 拒绝跳转、脚本静默拿到空集合（这是"加了检测却没有任何日志"的根因）。
- **搜狗验证墙**：`https://www.sogou.com/web?query=` 会被 302 到 `https://www.sogou.com/antispider/?m=1&antip=web_hd&from=…`。host 是已白名单的 `www.sogou.com`，所以**只能靠路径段 `antispider` 识别**——把它加进 `looksLikeChallenge` 之前，这种响应会被当成普通非 200 静默丢弃。
- **引擎自家功能入口不参与证据抓取**：`fankui.sogou.com`（搜狗风控反馈端点）、`ai.so.com`（360 结果页的 AI 问答 tab）都不是"包壳跳转"，但 `resolveRealHost` 的 `wrapped` 正则会把它们当包壳去请求；它们又不在 `@connect` 里，TM 会拒绝并在控制台抛 `This domain is not a part of the @connect list`（红字，看着像脚本坏了）。现在这两个主机写在 `NON_EVIDENCE_HOSTS` 里，在发请求**之前**就跳过：既没有红字报错，也不会白等 7 秒。**不要把它们加进 `@connect`**——加了 TM 会真的去请求（最多 25 次 × 7s），而且解析出来的引擎域名会污染证据集合。
- **头条搜索主机已变更**：老代码请求 `https://www.so.toutiao.com/search?keyword=`，该主机已不存在（DNS NXDOMAIN），GM_xmlhttpRequest 直接走 `onerror`，而 `err.error` 对这种连接失败是 `undefined`，于是被旧日志误报成"可能是验证跳转到了未授权域名"——实际和验证无关，线索全被误导。现有实现：请求主机改为 `so.toutiao.com`（实测 200，标题「抖音-头条搜索」），`ENGINE_VERIFY.toutiao.home` 同步改掉，`@connect` 同步替换；`onerror` 日志改为区分「@connect 被拒 / HTTP 状态 / 连接失败」，并补上 `ontimeout` 的 warn（以前超时是完全静默的）。**改版/下线这类问题只能靠真实请求发现**，所以 `engineSearchUrls` 被独立出来，配了一条单测校验"每个引擎的请求主机都在 `@connect` 白名单里"。
- **头条结果链接是 `/search/jump?jtoken=…` 相对跳转**：目标站点通过跳转才能拿到（实测跟随后落到 `www.douyin.com`、`musician.douyin.com`）。注意首次抓取返回的页面体积/结构会随会话状态变化（4.4MB 完整版 vs 只有导航的轻量版），排查时以浏览器里的实际响应为准。
- 神马/夸克：`www.sm.cn`→`m.sm.cn` 会跳并触发阿里 x5sec 滑块，对匿名请求固定返回验证页，因此禁用。
- 频繁请求会触发百度 wappass，可能被风控激化；提示条应手动重试而非自动循环。
- 下载保护曾有 bug，默认"仅标记"；如需下载拦截先真实环境验证。