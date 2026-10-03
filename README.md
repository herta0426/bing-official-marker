# bing-official-marker

## Baidu Dream Our Bings — 基于百度等多引擎的 Bing 官网标签体验优化

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-brightgreen)](https://www.tampermonkey.net/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在必应（Bing）搜索时，本脚本从**百度、搜狗、360、头条**等搜索引擎的结果中提取官方网站信息，为必应结果页对应的条目添加 **官网参考**、**需确认** 或 **风险** 标签，并把缺失的官网以“认证参考”形式补充到列表顶部。

> 参考结果也可能缺失官网。请自行判断，不要过度依赖结果。脚本由 AI 辅助编写，若有更好的实现欢迎借鉴或重构。

---

## 功能特点

- **智能提取**：从百度结果页的 `mu`、`data-landurl`、`data-click` 属性解析真实 URL，绕过百度跳转链接。
- **多参考引擎**：百度（默认）+ 搜狗、360、头条（默认开启，抓取携带浏览器 cookie 并带验证兜底）；Google、DuckDuckGo 可选匿名抓取；夸克(神马)因阿里滑块验证暂无法脚本化抓取，默认禁用。
- **跳转包壳解析（全程零请求）**：结果链接常是跳转壳，脚本不再跟随重定向，改为本地解析：① 读 `<a>` 上的真实目标属性（360 的 `data-mdurl` / `e-landurl`）；② 解出壳地址里编码的明文目标（头条 `/search/jump?…&url=<zlink，内含 h5_url>` 两层、Google `/url?q=`、DuckDuckGo `/l/?uddg=`）；③ 本来就是直链。解不出的（搜狗 `/link?url=` 是加密串）直接放弃，不贡献该条证据——这样既不会撞 Tampermonkey 的跳转白名单限制，控制台也不会再刷 `Request was redirected to a not whitelisted URL`。
- **下载词剥离**：命中下载意图时，把「下载/安装包/exe 等」关键词剥除后重新搜索作为参考，避免下载噪音干扰官网定位。
- **两级匹配机制**：
  - **完全匹配**（HTTPS 主机名相同）→ “官网参考”（蓝）。
  - **主域匹配**（同主域、不同子域）→ “需确认”（橙），点击前展示目标域名。
  - **高风险 URL**（HTTP、IP、短链、异常端口、含凭据、显式跳转）→ 拦截并展示风险原因。
  - **未验证结果** → 点击前要求确认，避免误把普通结果当官网。
- **补全缺失官网**：必应结果未出现官网时，插入到结果列表顶部并附来源说明。
- **百度 wappass / 360 qcaptcha / 搜狗 antispider 验证兜底**：被国内引擎的安全验证拦截时，页面顶部出现提示条，可一键打开真实挑战页；过码关窗后自动重试补货。反复验证不过时可改用「打开X首页」在新标签页里养会话。
- **AI 辅助（可选）**：支持 OpenAI、DeepSeek、通义千问及兼容接口的二次佐证，仅作提示、不解除本地高风险拦截。
- **XSN 情报标红（可选）**：本地高危只覆盖明文类特征（HTTP、IP、短链、非标准端口），像 HTTPS + 正常端口 + 真域名的站点本地只能给出「未验证」。启用后按域名查询 [XSN](https://xsn.linubuntu.dpdns.org/) 情报，命中 `critical`/`high` 的结果标红为「XSN 风险」。
- **可信平台免检查名单**：GitHub、论坛、百科等平台本身可信、内容由用户上传，命中后不再刷「未验证」，改标绿色「可信平台」；本地高危照常标红，名单不豁免。
- **配置中心**：Tampermonkey 菜单 `打开官网标记配置`，含排除词预设、引擎开关、AI 配置、保护模式等。

---

## 安装与使用

### 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome/Edge）。
2. 安装脚本：
   - [安装脚本（Gitee）](https://gitee.com/mb-v/bing-official-marker/raw/main/baidudreamourbings.user.js)
   - [安装脚本（GitHub）](https://raw.githubusercontent.com/herta0426/bing-official-marker/main/baidudreamourbings.user.js)
   - [安装脚本（jsDelivr）](https://cdn.jsdelivr.net/gh/herta0426/bing-official-marker@main/baidudreamourbings.user.js)
   - [安装脚本（Greasy Fork）](https://greasyfork.org/zh-CN/scripts/598249-baidudreamourbings)(不推荐，国内被拦截）
4. 首次使用会请求跨域授权（`www.baidu.com`、`wappass.baidu.com`、`www.sogou.com`、`www.so.com`、`qcaptcha.so.com`、`so.toutiao.com` 等），请点**允许**，否则对应引擎的请求会被拦截、脚本静默少拿到证据。启用 XSN 情报查询时会额外用到 `xsn.linubuntu.dpdns.org`。
5. 访问 `https://cn.bing.com/search?q=强调`，约 1~3 秒完成标记/补充。

### 配置中心

`Tampermonkey 菜单 → 打开官网标记配置`：

- **保护模式**：默认“仅标记”（不弹窗）。可选严格保护/下载保护（下载保护对下载意图或下载链接弹确认，曾有历史 bug，如需请先在真实环境验证）。
- **排除词**：天气、新闻、生活、娱乐、实时等预设 + 自定义词。
- **参考引擎**：百度、Google、DuckDuckGo、搜狗、360、头条、夸克开关（当前国内中文友好源默认开启；夸克因验证墙禁用）。
- **AI 辅助**：服务商、`获取模型列表`、模型选择、API Key（本地存储，不入库）。
- **XSN 情报**：是否启用查询。
- **可信平台（免检查名单）**：平台域名列表，每行一个（含子域），清空即关闭。
- 配置带版本号，旧配置在结构变更时自动回到最新默认。

### XSN 情报标红（可选）

**为什么需要**：脚本本地的高危判定只覆盖明文类特征——HTTP、IP 地址、短链、非标准端口、URL 内嵌凭据等，其中最常见的是 HTTP。而仿冒站、钓鱼站通常是 **HTTPS + 正常端口 + 看起来正常的真域名**，本地规则看不到任何异常，只会显示「未验证」或「需确认」。

**怎么补**：开启后，脚本按域名查询 [XSN（星海安全网络）](https://xsn.linubuntu.dpdns.org/) 的公开情报接口，把 XSN 的判定结果直接叠到标签上：

| XSN 判定 | 标签 | 颜色 |
| --- | --- | --- |
| `severity` 为 `critical`/`high` 且 `status` 非 `false_positive` | XSN 风险 | 红 |
| `low`/`medium` 或 `status=false_positive` | 不改判定，保留原有标签 | — |

标签只表示「XSN 的判定结果」，脚本不额外做本地推断。鼠标悬停在标签上会显示该情报的家族、等级、置信度、全网命中次数与状态。查询结果（含未命中）缓存 10 分钟，单页最多查询 20 个域名。

### 可信平台（免检查名单）

有些结果来自知名平台，**平台本身可信，但页面内容是用户上传的**——GitHub 的仓库、论坛的帖子、视频站的投稿。脚本没法判断这些内容安不安全，对它们标「未验证」只会变成噪音。

把这些域名放进免检查名单，命中后：

| 情况 | 结果 |
| --- | --- |
| 名单内的平台 + 非高危 | 绿色「可信平台」，不再提醒未验证/需确认，也不查询 XSN |
| 名单内的平台 + 本地高危（HTTP、IP、短链、非标准端口等） | 红色「高风险链接」，**名单不豁免高危** |
| 命中已验证官网 | 保持蓝色「官网参考」 |

默认名单：`github.com`、`gitlab.com`、`gitee.com`、`bitbucket.org`、`stackoverflow.com`、`stackexchange.com`、`wikipedia.org`、`wikimedia.org`、`zhihu.com`、`reddit.com`、`tieba.baidu.com`、`v2ex.com`、`bilibili.com`、`youtube.com`。配置里可增删，清空即关闭该功能；子域自动命中（`gist.github.com`），后缀仿冒不命中（`github.com.evil.tld`）。

> 「可信平台」只表示**该域名属于这个平台**，不表示页面内容安全。点仓库里的下载、跳转链接之前仍然要自己看一眼。

### 安全说明

- API Key 通过 Tampermonkey 存储在本机，不写入仓库。
- 百度与国内参考引擎（360/搜狗/头条）请求携带浏览器 cookie（非匿名）以降低验证触发，被拦截时可一键过码并自动重试；Google/DuckDuckGo 与 AI 请求使用匿名。域名均已在 `@connect` 白名单。
- AI 仅接收搜索词、标题、域名、URL，不接收网页正文；结果仅作提示。
- XSN 只做只读查询（`anonymous`，不带 cookie），脚本不会向 XSN 写入任何内容；关闭「启用 XSN 情报查询」即完全不访问该服务。

---

## 注意事项与常见问题

1. **跨域授权被拒导致脚本不跑**：控制台看不到 `[官网补全]` 日志，多半是 Tampermonkey 未允许新的 `@connect` 域名。到脚本管理器授权后刷新。
2. **安全验证（百度 wappass / 360 qcaptcha / 搜狗 antispider）**：引擎对异常或高频请求触发验证。出现黄色提示条时，点「去完成X验证」过码，关窗自动重试。**若反复验证不通过（360 尤其明显），点「打开X首页」在新标签页里随便搜一次**，养出正常会话后回来点「重试」——360 是 IP/行为风控，脚本无法复用弹窗里的过码结果。国内引擎请求携带浏览器既有 cookie，因此养好的会话能被后续重试复用。
3. **参考引擎域名是跳转壳**：脚本一律**不跟跳转**，只做本地解析（DOM 属性 → 壳里编码的明文目标 → 直链），每个引擎最多解析 25 个链接、产出 15 个域名。搜狗的结果链接是加密串（`/link?url=hedJjaC291…`），解不出明文，因此搜狗目前基本不贡献证据；360 与头条可正常解析。
4. **云重复标签/位置异常**：只移除自身生成的标签与补充结果；插在容器最前，不改变原有顺序。
5. **官网参考 ≠ 绝对安全**：“官网参考”只表示域名与参考源一致，不保证页面未被入侵。

---

## 项目结构

```
baidudreamourbings.user.js    # 主用户脚本（含配置 UI、抓取、匹配、标记、AI）
tests/security-helpers.test.js# 纯函数单元测试（node --test，无需浏览器）
docs/                          # 设计文档
LICENSE                        # MIT
```

### 本地测试

```bash
node --check baidudreamourbings.user.js                 # 语法检查
node --test tests/security-helpers.test.js              # 单元测试
```

---

## TODO

- [ ] 容器定位备选选择器增强
- [ ] 搜狗证据：`/link?url=` 是加密串，本地解不出，需要跟跳转才能拿（涉及放宽 `@connect`，暂缓）
- [ ] 下载词剥离后退化成无意义查询时的回退（如「如何下载抖音」→「如何抖音」拿不到官网）
- [x] 会话缓存（10 分钟，避免同关键词重复请求）
- [x] 需确认/高风险点击确认与风险提示
- [x] 多参考引擎
- [x] 百度 wappass 验证兜底 + 自动重试
- [x] 下载词剥离再搜索
- [x] 跳转壳零请求解析（360 属性 / 头条 h5_url / Google q= / DDG uddg=）
- [x] XSN 情报标红（只读）与可信平台免检查名单

---

## 更新日志

### 1.3

- **跳转壳解析改为零请求**：不再跟随重定向（Tampermonkey 对跨域跳转落点同样校验 `@connect`，跟了也会被拦并在控制台刷一屏红字），改为本地解析——360 读 `data-mdurl`/`e-landurl` 属性，头条解 `/search/jump?…&url=<zlink，内含 h5_url>`（两层编码），Google/DDG 解 `q=`/`uddg=`，其余直链直接用；解不出的（搜狗加密串）放弃该条证据。实测头条由"0 条证据 + 37 条红字"变为可正常解析出 `www.douyin.com` 等目标。
- **修掉头条长期静默失败**：请求主机 `www.so.toutiao.com` 已不存在（DNS 失败），改为 `so.toutiao.com`；`@connect`、验证兜底首页地址同步更新；`onerror` 日志不再把"域名失效"误报成"验证跳转"，并补上超时告警。
- **新增 XSN 情报标红（只读）**：按域名查询 XSN 公开情报，命中 `critical`/`high` 的结果标红「XSN 风险」；只调用公开的 `GET /v1/ioc/:type/:value`，不注册节点、不上报、不写入。默认关闭。
- **新增可信平台免检查名单**：GitHub、论坛、百科等平台命中后不再刷「未验证」，改标绿色「可信平台」；本地高危照常标红，名单不豁免。默认内置一批常见平台，可编辑，清空即关闭。
- 其他：引擎功能入口（`ai.so.com`、`fankui.sogou.com`）不再被当作跳转壳去请求；新增 37 项纯函数单测。

---

## 免责声明

- 仅供个人学习与提高效率，不得用于商业或非法目的。
- 默认配置下脚本不存储、不传输用户数据，全部处理在本地浏览器完成；若你启用 XSN 情报查询，结果域名会以只读查询方式发送给 XSN 公开情报服务（脚本不会向其写入任何内容）。
- 与百度、必应及第三参考引擎均无关联。
- 网站更新频繁，脚本不保证永久有效；问题可反馈但不保证解决。
- 使用即视为已知悉并接受以上声明。

---

## 许可证

[MIT License](LICENSE)
