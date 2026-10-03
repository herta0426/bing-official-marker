// ==UserScript==
// @name         BaiduDreamourBings
// @namespace    https://github.com/herta0426/bing-official-marker
// @version      1.4
// @description  必应结果官网标记/补全（百度等引擎交叉校验），零请求解析跳转壳，可选 XSN 情报标红与可信平台免检查，拦截可疑下载
// @author       herta0426
// @license      MIT
// @homepageURL  https://github.com/herta0426/bing-official-marker
// @supportURL   https://github.com/herta0426/bing-official-marker/issues
// @downloadURL  https://raw.githubusercontent.com/herta0426/bing-official-marker/main/baidudreamourbings.user.js
// @updateURL    https://raw.githubusercontent.com/herta0426/bing-official-marker/main/baidudreamourbings.user.js
// @match        https://*.bing.com/search?*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      www.baidu.com
// @connect      wappass.baidu.com
// @connect      verify.baidu.com
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      dashscope.aliyuncs.com
// @connect      www.google.com
// @connect      html.duckduckgo.com
// @connect      www.sogou.com
// @connect      www.so.com
// @connect      m.so.com
// @connect      qcaptcha.so.com
// @connect      so.toutiao.com
// @connect      www.sm.cn
// @connect      m.sm.cn
// @connect      quark.sm.cn
// @connect      xsn.linubuntu.dpdns.org
// ==/UserScript==

(function() {
    'use strict';

    const PUBLIC_SUFFIXES = new Set([
        'co.uk', 'com.au', 'com.br', 'com.cn', 'com.hk', 'com.sg', 'co.jp',
        'co.kr', 'co.nz', 'co.za', 'gov.cn', 'net.cn', 'org.cn', 'github.io',
        'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app'
    ]);
    const SHORTENER_HOSTS = new Set([
        'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'is.gd', 'ow.ly', 'rb.gy'
    ]);

    // XSN（星海安全网络）接入：只用其官网首页「API 接入」里公开列出的查询接口
    //   GET /v1/ioc/:type/:value   单条情报快速查询
    // 脚本只读：不注册节点、不上报、不调用任何写入接口
    const XSN_DEFAULT_ENDPOINT = 'https://xsn.linubuntu.dpdns.org';
    const XSN_IOC_KEY = 'bom-xsn-ioc-cache';
    const XSN_IOC_TTL_MS = 10 * 60 * 1000;
    const XSN_LOOKUP_MAX = 20;          // 单页最多查询的域名数
    const XSN_HIGH_SEVERITIES = new Set(['critical', 'high']);

    // 可信平台（免检查名单）：平台本身可信，但其页面内容由用户上传，
    // 脚本只能判定"平台域名是不是这个平台"，没法判定仓库/帖子/评论里的内容安全。
    // 命中后不再做未验证/需确认提醒，也不查 XSN；本地高危（HTTP、IP、短链等）仍照常标红。
    const DEFAULT_TRUSTED_PLATFORMS = [
        'github.com', 'gitlab.com', 'gitee.com', 'bitbucket.org',
        'stackoverflow.com', 'stackexchange.com',
        'wikipedia.org', 'wikimedia.org',
        'zhihu.com', 'reddit.com', 'tieba.baidu.com', 'v2ex.com',
        'bilibili.com', 'youtube.com'
    ];

    const AI_PROVIDERS = {
        openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
        deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' },
        qwen: { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKey: '' },
        custom: { name: '自定义 OpenAI 兼容接口', baseUrl: '', model: '', apiKey: '' }
    };
    const EXCLUSION_PRESETS = {
        weather: ['天气', '气温', '降雨', '台风', '空气质量'],
        news: ['新闻', '热点', '头条', '时政', '财经新闻'],
        lifestyle: ['菜谱', '美食', '旅游', '酒店', '机票', '公交', '地铁'],
        entertainment: ['电影', '电视剧', '音乐', '游戏', '明星'],
        realtime: ['股票', '基金', '汇率', '彩票', '比分']
    };
    const DEFAULT_DOWNLOAD_KEYWORDS = ['下载', '安装包', '软件', '客户端', '驱动', '固件', 'apk', 'exe', 'msi', 'iso', '破解', '汉化版', '绿色版', '便携版', '最新版', '官方安装', 'pc版', 'windows版', 'mac版', '安卓版', 'ios版', 'download', 'installer', 'setup', 'driver', 'firmware', 'portable', 'crack', 'patched'];
    const DEFAULT_DOWNLOAD_EXTENSIONS = ['.exe', '.msi', '.apk', '.dmg', '.zip', '.rar', '.7z', '.iso', '.deb', '.pkg'];

    // 会被安全验证拦截的参考引擎：请求携带浏览器既有 cookie，并在被拦时走"提示条 → 过码 → 关窗重试"兜底。
    // 只有带 cookie 的请求才能在用户过码后复用验证结果，匿名请求过码无效。
    const ENGINE_VERIFY = {
        baidu:   { label: '百度', host: 'baidu.com',      home: 'https://www.baidu.com/' },
        so360:   { label: '360',  host: 'so.com',         home: 'https://m.so.com/' },
        sogou:   { label: '搜狗', host: 'sogou.com',      home: 'https://www.sogou.com/' },
        toutiao: { label: '头条', host: 'so.toutiao.com', home: 'https://so.toutiao.com/' }
    };

    // 走移动端入口的引擎：结果页是服务端直出、不依赖会话，也不需要带 cookie。
    // 带上 PC 端 cookie 反而可能把"验证中"的状态带过去，所以这类引擎一律匿名请求。
    // 360 桌面端 www.so.com/s 直接被 qcaptcha 挡住（实测必跳验证页），
    // 移动端 m.so.com/s 同关键词正常返回结果，因此 360 改用移动入口。
    const ENGINE_ANONYMOUS_ONLY = new Set(['so360']);

    function usesEngineCookies(hostname) {
        const host = String(hostname || '').toLowerCase();
        return Object.values(ENGINE_VERIFY).some(item => host === item.host || host.endsWith('.' + item.host));
    }

    // 判断一个地址是否像人机验证挑战页：
    // 360 的 qcaptcha.so.com、百度的 wappass.baidu.com、搜狗的 www.sogou.com/antispider/
    function looksLikeChallenge(value) {
        const raw = String(value || '');
        try {
            const url = new URL(raw);
            return /wappass|qcaptcha|captcha|verify|qrcode|passport|security|tuxing|punish|antispider/i.test(url.hostname + url.pathname);
        } catch (_) {
            return /wappass|qcaptcha|captcha|verify|punish|antispider/i.test(raw);
        }
    }

    function defaultConfig() {
        return {
            version: 2,
            // 新配置自带最新版本号，不会被"回落默认关闭的引擎"的迁移逻辑再动一次
            engineDefaultsVersion: ENGINE_DEFAULTS_VERSION,
            enabled: true,
            unknownConfirmation: true,
            riskBlocking: true,
            cacheMinutes: 10,
            protectionMode: 'mark',
            downloadKeywords: [...DEFAULT_DOWNLOAD_KEYWORDS],
            downloadExtensions: [...DEFAULT_DOWNLOAD_EXTENSIONS],
            alwaysBlockRisk: true,
            exclusions: { enabled: true, presets: { weather: true, news: true, lifestyle: true, entertainment: false, realtime: true }, words: [] },
            // 360 与搜狗默认关闭：桌面端 360 对新会话必下发 qcaptcha，搜狗结果是加密串解不出，
            // 两者都会拖慢一次搜索、还经常一条证据都拿不到（详见 DEVELOPMENT.md「已知坑」）
            engines: { baidu: true, google: false, duckduckgo: false, sogou: false, so360: false, toutiao: true, quark: false },
            trustedPlatforms: [...DEFAULT_TRUSTED_PLATFORMS],
            ai: { enabled: false, provider: 'openai', baseUrl: AI_PROVIDERS.openai.baseUrl, model: AI_PROVIDERS.openai.model, apiKey: '' },
            xsn: { enabled: false }
        };
    }

    // 引擎 key → 日志里显示的中文名（ENGINE_VERIFY 只覆盖需要验证兜底的那几个）
    const ENGINE_LABELS = {
        baidu: '百度', google: 'Google', duckduckgo: 'DuckDuckGo', sogou: '搜狗',
        so360: '360', toutiao: '头条', quark: '夸克'
    };

    // 默认关闭的引擎的迁移版本号。老配置里 360/搜狗 存的是 true，
    // 只改 defaultConfig 对已存过配置的用户不生效（engines 是整体覆盖），
    // 所以靠这个版本号做一次性回落；回落之后用户手动开启的选择会被保留。
    const ENGINE_DEFAULTS_VERSION = 2;
    const ENGINE_DEFAULT_OFF = ['so360', 'sogou'];

    function normalizeConfig(input) {
        if (!input || typeof input !== 'object' || input.version !== 2) return defaultConfig(); // 版本不符/旧配置 → 回到最新默认
        const base = defaultConfig();
        const value = input && typeof input === 'object' ? input : {};
        const ai = value.ai && typeof value.ai === 'object' ? value.ai : {};
        const provider = AI_PROVIDERS[ai.provider] ? ai.provider : base.ai.provider;
        return {
            ...base,
            ...value,
            exclusions: { ...base.exclusions, ...(value.exclusions || {}), presets: { ...base.exclusions.presets, ...((value.exclusions || {}).presets || {}) }, words: Array.isArray((value.exclusions || {}).words) ? [...new Set(value.exclusions.words.filter(word => typeof word === 'string' && word.trim()))] : base.exclusions.words },
            engines: {
                ...base.engines,
                ...(value.engines || {}),
                quark: false, // 神马/夸克：验证模块无法脚本化，永久关闭
                // 版本号落后就一次性回落到新的默认值（360/搜狗 默认关）；
                // 已经迁移过的话，用户手动开启的选择不再被覆盖
                ...(Number(value.engineDefaultsVersion || 0) < ENGINE_DEFAULTS_VERSION
                    ? Object.fromEntries(ENGINE_DEFAULT_OFF.map(engine => [engine, false]))
                    : {})
            },
            engineDefaultsVersion: ENGINE_DEFAULTS_VERSION,
            trustedPlatforms: Array.isArray(value.trustedPlatforms)
                ? [...new Set(value.trustedPlatforms.filter(host => typeof host === 'string' && host.trim()).map(host => host.trim().toLowerCase()))]
                : base.trustedPlatforms,
            ai: { ...base.ai, ...ai, provider, apiKey: typeof ai.apiKey === 'string' ? ai.apiKey : '' },
            xsn: {
                // 接入 XSN 是用户选择：缺省即关
                enabled: (value.xsn || {}).enabled === true
            }
        };
    }

    function aiProviderPresets() {
        return JSON.parse(JSON.stringify(AI_PROVIDERS));
    }

    function exclusionPresetWords() {
        return JSON.parse(JSON.stringify(EXCLUSION_PRESETS));
    }

    function summarizeEngineEvidence(candidateUrl, evidence) {
        const host = normalizeHttpUrl(candidateUrl)?.hostname;
        const domain = host ? getRegistrableDomain(host) : '';
        const matches = Object.values(evidence || {}).filter(domains => domains && [...domains].some(value => getRegistrableDomain(value) === domain)).length;
        return { matches, label: matches > 1 ? '多引擎参考' : matches === 1 ? '单引擎参考' : '未找到一致结果', trusted: false };
    }

    function extractModelIds(payload) {
        const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
        const ids = entries.map(item => typeof item === 'string' ? item : item?.id || item?.name).filter(Boolean);
        return [...new Set([...ids, 'custom'])];
    }

    function fetchModelIds(config) {
        const endpoint = config.ai.baseUrl.replace(/\/$/, '') + '/models';
        if (!config.ai.apiKey || !/^https:\/\/(api\.openai\.com|api\.deepseek\.com|dashscope\.aliyuncs\.com)\//.test(endpoint)) return Promise.reject(new Error('请填写预设服务商的 API Key 和接口地址'));
        return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'GET', url: endpoint, anonymous: true, timeout: 15000, headers: { Authorization: 'Bearer ' + config.ai.apiKey }, onload: response => { try { if (response.status < 200 || response.status >= 300) throw new Error('HTTP ' + response.status); resolve(extractModelIds(JSON.parse(response.responseText))); } catch (error) { reject(error); } }, onerror: () => reject(new Error('模型列表请求失败')), ontimeout: () => reject(new Error('模型列表请求超时')) }));
    }

    // 引擎主机：这些域上的链接是"壳"（跳转地址或加密 token），不是结果本身
    const ENGINE_WRAPPER_SUFFIXES = ['google.com', 'duckduckgo.com', 'sogou.com', 'so.com', 'toutiao.com', 'sm.cn', 'baidu.com'];

    function isEngineHost(hostname) {
        const host = String(hostname || '').toLowerCase();
        return ENGINE_WRAPPER_SUFFIXES.some(suffix => host === suffix || host.endsWith('.' + suffix));
    }

    function isSkippedHost(hostname) {
        const host = String(hostname || '').toLowerCase();
        return NON_EVIDENCE_HOSTS.some(item => host === item || host.endsWith('.' + item));
    }

    // 壳地址常把真实目标编码在参数上：头条 /search/jump?…&url=<编码的 zlink，内含再一层 h5_url>、
    // Google /url?q=<目标>、DuckDuckGo /l/?uddg=<编码目标>。纯解码即可拿到目标主机名。
    // 中间层可能仍是引擎自己的跳转壳，所以递归解（限 3 层）。搜狗的 url= 是加密串，
    // 解不出合法 URL，会自然落到"放弃"，不会误当成证据。
    function extractEmbeddedTarget(raw, base, depth) {
        if (!raw || (depth || 0) > 3) return '';
        let url = null;
        try { url = new URL(raw, base); } catch (_) { return ''; }
        for (const name of EMBEDDED_TARGET_PARAMS) {
            const value = url.searchParams.get(name);
            if (!value) continue;
            let inner = null;
            try { inner = new URL(value, base); } catch (_) { continue; }
            if (inner.protocol !== 'http:' && inner.protocol !== 'https:') continue;
            if (isSkippedHost(inner.hostname)) continue;
            if (isEngineHost(inner.hostname)) {
                const deeper = extractEmbeddedTarget(inner.href, base, (depth || 0) + 1);
                if (deeper) return deeper;
                continue;
            }
            return inner.hostname;
        }
        return '';
    }

    // 参考引擎响应是否被人机验证拦截：Location/finalUrl 落到挑战页，或小体积的验证页正文。
    // 注意 Tampermonkey 会忽略 followRedirects:false 直接跟随跳转，所以必须同时看 finalUrl。
    function isVerificationResponse(response, finalUrl, location) {
        if (looksLikeChallenge(location) || looksLikeChallenge(finalUrl)) return true;
        if (response.status !== 200) return false;
        const text = String(response.responseText || '');
        return text.length < 20000 && /访问异常页面|安全验证|人机验证|滑动验证|拖动滑块|访问过于频繁|请输入.{0,8}验证码/i.test(text);
    }

    // 各参考引擎的搜索地址。主机名必须同时出现在文件头的 @connect 里，否则 TM 会拒绝请求。
    // 注意头条：老代码用的是 www.so.toutiao.com，该主机已不存在（DNS 解析失败），
    // 会让头条参考静默拿不到数据，正确的主机是 so.toutiao.com。
    // 注意 360：桌面端 www.so.com/s 对新会话一律下发 qcaptcha 验证，抓到的永远是挑战页；
    // 移动端 m.so.com/s 服务端直出结果、不弹验证，且跳转壳是明文（/jump?u=），解析更稳。
    function engineSearchUrls(keyword) {
        const query = encodeURIComponent(keyword);
        return {
            google: `https://www.google.com/search?q=${query}`,
            duckduckgo: `https://html.duckduckgo.com/html/?q=${query}`,
            sogou: `https://www.sogou.com/web?query=${query}`,
            so360: `https://m.so.com/s?q=${query}`,
            toutiao: `https://so.toutiao.com/search?keyword=${query}`,
            quark: `https://quark.sm.cn/s?q=${query}`
        };
    }

    // 引擎结果页上的这些主机不参与证据抓取：它们是引擎自己的功能入口或自家内容平台，
    // 既不是"包壳跳转"，也不该写进 @connect（写了 TM 会真的去请求，白等 7 秒还污染证据集）
    const NON_EVIDENCE_HOSTS = [
        'ai.so.com', 'fankui.sogou.com',
        // 360 自家内容平台：结果里很常见，但不是目标官网
        'baike.so.com', 'news.so.com', 'image.so.com', 'video.so.com', 'info.so.com',
        '360kuai.com', '360kan.com'
    ];

    // 有的引擎把真实目标地址直接挂在结果元素的属性上（360 移动端 data-pcurl 是明文真实地址、
    // data-url / data-mdurl / e-landurl 是跳转壳），读属性即可：零网络请求，
    // 也就不存在 @connect 拦跳转的问题。属性不存在时退回 href（先尝试解码壳里的明文目标）。
    const REAL_TARGET_ATTRS = ['data-pcurl', 'data-mdurl', 'e-landurl', 'data-url'];

    // 壳地址里可能编码着明文目标的参数名（按优先级）。
    // 'u' 是 360 移动端 /jump?u=<目标> 的明文参数名。
    const EMBEDDED_TARGET_PARAMS = ['h5_url', 'uddg', 'q', 'url', 'u', 'target'];

    // 头条每张结果卡片的容器上都挂了 data-log-extra，里面直接写着结果归属域名：
    //   data-log-extra='{"host":"y.qq.com","url":"http://y.qq.com/",...}'
    // 比解跳转壳稳得多：不受壳编码层数变化影响（登录态下壳会多包一层），也完全不需要网络请求。
    // 卡片里 host 也可能是引擎自己（so.toutiao.com），读出来后照样按引擎域名过滤掉。
    const CARD_HOST_ATTRS = ['data-log-extra', 'data-log-click', 'data-log-view'];
    // 结果 <a> 到卡片容器（挂 data-log-extra 的那层）实测有 5 层，留点余量
    const CARD_HOST_MAX_DEPTH = 6;

    function hostFromCardPayload(raw) {
        if (!raw || raw.indexOf('host') < 0) return '';
        let data = null;
        try { data = JSON.parse(raw); } catch (_) { return ''; }
        const host = String((data && data.host) || '').toLowerCase();
        if (!host || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return '';
        if (isEngineHost(host) || isSkippedHost(host)) return '';
        return host;
    }

    // 从结果 <a> 往上找几层，把卡片元数据里的 host 读出来；找不到就返回空，交给后面的壳解析
    function cardHostFrom(anchor) {
        if (!anchor || typeof anchor.getAttribute !== 'function') return '';
        let node = anchor;
        for (let depth = 0; node && depth <= CARD_HOST_MAX_DEPTH; depth++) {
            for (const name of CARD_HOST_ATTRS) {
                const host = hostFromCardPayload(node.getAttribute(name));
                if (host) return host;
            }
            node = node.parentElement || null;
        }
        return '';
    }

    // 属性值可能是明文直链（360 移动端的 data-pcurl），也可能仍是引擎自己的跳转壳
    //（data-url 就是 m.so.com/jump?u=…），后者要再往下解一层才能拿到目标。
    function hostFromAttrValue(raw, base) {
        let url = null;
        try { url = normalizeHttpUrl(new URL(raw, base).href); } catch (_) { return ''; }
        if (!url) return '';
        if (isSkippedHost(url.hostname)) return '';
        if (isEngineHost(url.hostname)) return extractEmbeddedTarget(url.href, base, 0);
        return url.hostname;
    }

    // 结果项 → 真实目标主机名，全程零网络请求：
    //   1) 卡片元数据里直接写了归属域名（头条 data-log-extra 的 host）
    //   2) 目标挂在元素属性上（360 的 data-pcurl / data-mdurl / e-landurl / data-url）
    //   3) 壳地址里编码了明文目标（解码，可递归）
    //   4) 本来就是直链
    // 都拿不到的（如搜狗 /link?url= 的加密串）直接放弃：不再跟跳转。
    // 因为 TM 对跳转落点同样校验 @connect，跟也只会被拦（Request was redirected to a
    // not whitelisted URL），白刷一屏红字且一条证据都拿不到。
    function resolveAnchorHost(anchor, base) {
        const attr = name => (anchor.getAttribute ? anchor.getAttribute(name) : null);
        // 1) 卡片元数据直读：不受壳编码层数影响，头条登录态下壳会多包一层也不影响
        const cardHost = cardHostFrom(anchor);
        if (cardHost) return cardHost;
        // 2) 元素属性上的真实目标
        for (const name of REAL_TARGET_ATTRS) {
            const raw = attr(name);
            if (!raw) continue;
            const host = hostFromAttrValue(raw, base);
            if (host) return host;
        }
        const href = attr('href') || '';
        const embedded = extractEmbeddedTarget(href, base, 0);
        if (embedded) return embedded;
        let parsed = null;
        try { parsed = new URL(href, base); } catch (_) { return ''; }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        if (isEngineHost(parsed.hostname) || isSkippedHost(parsed.hostname)) return ''; // 已知壳：放弃，不发注定被拦的请求
        return parsed.hostname;
    }

    function fetchEngineDomains(keyword, engine) {
        const urls = engineSearchUrls(keyword);
        const base = urls[engine];
        if (!base) return Promise.resolve(new Set());
        const managed = Boolean(ENGINE_VERIFY[engine]); // 国内引擎：验证兜底（提示条 / 重试）
        // 移动端入口的引擎不依赖会话：匿名请求拿到的就是结果页
        const useCookies = managed && !ENGINE_ANONYMOUS_ONLY.has(engine);
        return new Promise(resolve => GM_xmlhttpRequest({
            // followRedirects 关闭：被验证拦截时保留 3xx 与 Location，才能取到真实挑战地址（与百度一致）
            method: 'GET', url: base, anonymous: !useCookies, followRedirects: !managed, timeout: 10000,
            onload: async response => {
                const hosts = new Set();
                const finalUrl = response.finalUrl || base;
                const location = extractRedirectUrl(response.headers);
                if (managed && isVerificationResponse(response, finalUrl, location)) {
                    const challenge = pickCaptchaSource(location, base) || pickCaptchaSource(finalUrl, base);
                    console.warn('[官网补全] ' + ENGINE_VERIFY[engine].label + ' 触发安全验证，本次参考抓取被拦截：', challenge || location || finalUrl);
                    registerVerification(engine, challenge, base);
                    return resolve(hosts);
                }
                if (response.status !== 200) {
                    console.warn('[官网补全] ' + engine + ' 返回异常状态:', response.status, finalUrl);
                    return resolve(hosts);
                }
                const doc = new DOMParser().parseFromString(response.responseText, 'text/html');
                // 属性里带真实目标的引擎（360）不一定有 <a href>，头条的归属域名在卡片容器上，
                // 选择器要把这几种都算进来。带目标属性的元素几乎必然是结果项，先解析它们，
                // 再用 a[href] 兜底（Google/头条等只有 href 的引擎）。
                const prioritized = [...doc.querySelectorAll('[data-pcurl], [data-mdurl], [e-landurl], [data-url]')];
                const rest = [...doc.querySelectorAll('a[href]')];
                const anchors = [...new Set([...prioritized, ...rest])];
                let iter = 0;
                for (const anchor of anchors) {
                    // 结果项通常排在页面中后部（前面是导航、相关搜索、推荐位），扫描上限要放宽，
                    // 否则 360 这种"前面一堆无关链接"的页面只能拿到两三条证据。
                    if (iter++ >= 150 || hosts.size >= 15) break; // 限制解析量与结果数
                    const host = resolveAnchorHost(anchor, base);
                    if (host) hosts.add(host);
                }
                resolve(hosts);
            },
            onerror: err => {
                // 三种都会走到这里：域名失效/DNS 失败、网络中断、跳转落到 @connect 未覆盖的域名。
                // err.error 只在 @connect 被拒时有值，所以以前把域名失效也报成"验证跳转"，容易误判。
                if (managed) {
                    const detail = (err && (err.error || err.statusText))
                        || (err && err.status ? 'HTTP ' + err.status : '连接失败（域名可能已失效，或被网络/@connect 拦截）');
                    console.warn('[官网补全] ' + ENGINE_VERIFY[engine].label + ' 请求失败：', detail, '|', base);
                }
                resolve(new Set());
            },
            ontimeout: () => {
                if (managed) console.warn('[官网补全] ' + ENGINE_VERIFY[engine].label + ' 请求超时：', base);
                resolve(new Set());
            }
        }));
    }

    function shouldExcludeKeyword(keyword, config) {
        if (!config || !config.exclusions || !config.exclusions.enabled) return false;
        const text = String(keyword || '').toLowerCase();
        const presetWords = Object.entries(config.exclusions.presets || {})
            .filter(([, enabled]) => enabled)
            .flatMap(([name]) => EXCLUSION_PRESETS[name] || []);
        const words = [...new Set([...(config.exclusions.words || []), ...presetWords])];
        return words.some(word => text.includes(String(word).toLowerCase()));
    }

    function hasDownloadIntent(keyword, config) {
        const words = Array.isArray(config?.downloadKeywords) ? config.downloadKeywords : DEFAULT_DOWNLOAD_KEYWORDS;
        const text = String(keyword || '').toLowerCase();
        return words.some(word => text.includes(String(word).toLowerCase()));
    }

    function escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // 下载意图词去除后得到的"参考词"，用于再次搜索定位官网（如 "qq 下载" → "qq"）
    function stripDownloadKeywords(keyword, config) {
        const words = Array.isArray(config?.downloadKeywords) ? config.downloadKeywords : DEFAULT_DOWNLOAD_KEYWORDS;
        let text = String(keyword || '').trim();
        words.forEach(word => {
            const w = String(word).trim().toLowerCase();
            if (!w) return;
            text = text.replace(new RegExp(escapeRegExp(w), 'gi'), ' ');
        });
        text = text.replace(/\s+/g, ' ').trim();
        return text || String(keyword || '').trim();
    }

    function isDownloadUrl(value, config) {
        const url = normalizeHttpUrl(value);
        if (!url) return false;
        const extensions = Array.isArray(config?.downloadExtensions) ? config.downloadExtensions : DEFAULT_DOWNLOAD_EXTENSIONS;
        return extensions.some(extension => url.pathname.toLowerCase().endsWith(String(extension).toLowerCase())) || /(^|\/)(download|downloads|software|installer|releases?)(\/|$)/i.test(url.pathname);
    }

    function shouldConfirmNavigation(url, matched, matchType, keyword, config) {
        const mode = config?.protectionMode || 'download';
        if (mode === 'mark') return false;
        const decision = getResultDecision(url, matched, matchType);
        if (decision.level === 'high-risk' && config?.alwaysBlockRisk !== false) return true;
        if (mode === 'strict') return decision.requiresConfirmation;
        return hasDownloadIntent(keyword, config) || isDownloadUrl(url, config);
    }

    function loadConfig() {
        try { return normalizeConfig(GM_getValue('bom-config', defaultConfig())); } catch (_) { return defaultConfig(); }
    }

    function saveConfig(config) {
        GM_setValue('bom-config', normalizeConfig(config));
    }

    function requestAiReview(keyword, candidates, config) {
        if (!config.ai.enabled || !config.ai.apiKey || !config.ai.baseUrl || !config.ai.model) return Promise.resolve(null);
        const endpoint = config.ai.baseUrl.replace(/\/$/, '') + '/chat/completions';
        const body = JSON.stringify({ model: config.ai.model, temperature: 0, max_tokens: 240, messages: [
            { role: 'system', content: '仅根据搜索词、标题、域名和URL给出简短风险参考。不要宣称绝对安全，不要覆盖本地规则。' },
            { role: 'user', content: JSON.stringify({ keyword, candidates: candidates.map(item => ({ title: item.title, url: item.url, domain: item.displayDomain })) }) }
        ] });
        const request = typeof GM_xmlhttpRequest === 'function' && /^https:\/\/(api\.openai\.com|api\.deepseek\.com|dashscope\.aliyuncs\.com)\//.test(endpoint)
            ? new Promise(resolve => GM_xmlhttpRequest({ method: 'POST', url: endpoint, anonymous: true, timeout: 15000, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.ai.apiKey }, data: body, onload: response => { try { const data = response.status >= 200 && response.status < 300 ? JSON.parse(response.responseText) : null; resolve(data?.choices?.[0]?.message?.content || null); } catch (_) { resolve(null); } }, onerror: () => resolve(null), ontimeout: () => resolve(null) }))
            : fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.ai.apiKey }, body }).then(response => response.ok ? response.json() : null).then(data => data?.choices?.[0]?.message?.content || null).catch(() => null);
        return request;
    }

    function openConfigPage() {
        const config = loadConfig();
        const overlay = document.createElement('div');
        overlay.id = 'bom-config-overlay';
        overlay.innerHTML = `<div class="bom-config" role="dialog" aria-modal="true" aria-labelledby="bom-config-title">
          <div class="bom-config-head"><div><div class="bom-kicker">BING OFFICIAL MARKER</div><h1 id="bom-config-title">安全与比对配置</h1></div><button type="button" data-bom-close aria-label="关闭">×</button></div>
          <p class="bom-note">百度认证、多引擎和 AI 都只是参考信号，最终拦截规则始终由本地安全规则决定。</p>
          <section><details class="bom-collapse" open><summary><h2>搜索行为</h2></summary><label><input type="checkbox" data-bom-enabled> 启用官网标记</label><label>保护模式 <select data-bom-mode><option value="download">下载保护（推荐）</option><option value="strict">严格保护</option><option value="mark">仅标记</option></select></label><label><input type="checkbox" data-bom-risk> 高风险链接始终拦截</label><label class="bom-inline">缓存时间 <input type="number" min="0" max="1440" data-bom-cache> 分钟</label><label>下载意图关键词（每行一个）<textarea rows="4" data-bom-download-words></textarea></label><label>下载扩展名（每行一个）<textarea rows="2" data-bom-download-exts></textarea></label></details></section>
          <section><details class="bom-collapse" open><summary><h2>排除词</h2></summary><p class="bom-note">命中排除词时不请求百度、不调用 AI，也不修改 Bing 结果。</p><div class="bom-presets"><label><input type="checkbox" data-bom-preset="weather"> 天气</label><label><input type="checkbox" data-bom-preset="news"> 新闻</label><label><input type="checkbox" data-bom-preset="lifestyle"> 生活</label><label><input type="checkbox" data-bom-preset="entertainment"> 娱乐</label><label><input type="checkbox" data-bom-preset="realtime"> 实时信息</label></div><label>自定义排除词（每行一个）<textarea rows="4" data-bom-words></textarea></label></details></section>
          <section><details class="bom-collapse"><summary><h2>可信平台（免检查名单）</h2></summary><p class="bom-note">命中名单的结果不再显示「未验证」/「需确认」，也不查询 XSN，改标绿色「可信平台」。这些平台本身可信，但页面内容由用户上传（仓库、帖子、评论、视频等），<strong>脚本只判定平台域名本身，不分析内容安全性</strong>，需要你自己判断。本地高危（HTTP、IP、短链、非标准端口等）仍然照常标红，不受名单豁免。</p><label>平台域名（每行一个，含子域）<textarea rows="4" data-bom-trusted></textarea></label></details></section>
          <section><details class="bom-collapse" open><summary><h2>多引擎参考</h2></summary><div class="bom-presets"><label><input type="checkbox" data-bom-engine="baidu"> 百度认证</label><label><input type="checkbox" data-bom-engine="google" title="国内网络通常无法直连（TCP 连接超时），需自备代理才能用"> Google<span style="opacity:.6">（国内需代理）</span></label><label><input type="checkbox" data-bom-engine="duckduckgo" title="国内网络通常无法直连（TCP 连接超时），需自备代理才能用"> DuckDuckGo<span style="opacity:.6">（国内需代理）</span></label><label><input type="checkbox" data-bom-engine="sogou" title="结果链接是加密串，本地解不出，且频繁触发 antispider 验证"> 搜狗<span style="opacity:.6">（验证 + 加密壳，默认关）</span></label><label><input type="checkbox" data-bom-engine="so360" title="桌面端对新会话必下发 qcaptcha 验证，已改走移动端入口但仍可能受 IP 风控影响"> 360 搜索<span style="opacity:.6">（易触发验证，默认关）</span></label><label><input type="checkbox" data-bom-engine="toutiao"> 头条搜索</label><label><input type="checkbox" data-bom-engine="quark" disabled title="验证问题暂无法适配"> 神马搜索<span style="opacity:.6">（验证问题暂无法适配）</span></label></div><p class="bom-note">国内引擎抓取时携带浏览器既有 cookie；若被安全验证拦截，页面顶部会出现提示条，过码关窗后自动重试。<strong>360 与搜狗默认关闭</strong>：360 桌面端对新会话必下发 qcaptcha（现改走移动端入口，仍可能受 IP 风控），搜狗的结果链接是加密串（<code>/link?url=</code>）本地解不出、且频繁触发 antispider，两者经常一条证据都拿不到还会拖慢搜索。需要时可手动勾选，或用「参考引擎证据」日志确认它们是否真的在贡献证据。<strong>Google 与 DuckDuckGo 在国内通常无法直连</strong>（实测 TCP 连接超时，且 DNS 会被解析到无关地址），只有挂了代理的环境才用得上。神马/夸克因验证模块适配问题已禁用。</p></details></section>
          <section><details class="bom-collapse"><summary><h2>XSN 情报</h2></summary><label><input type="checkbox" data-bom-xsn-enabled> 启用 XSN 情报查询</label><p class="bom-note">启用后按域名查询 XSN 情报，命中 <code>critical</code>/<code>high</code> 的结果标红为「XSN 风险」，悬停显示家族、等级、置信度与全网命中次数。本地规则只覆盖明文类特征（HTTP、IP、短链、非标准端口），像 HTTPS + 正常端口 + 真域名的站点本地只能给出「未验证」，这部分由 XSN 情报补上。</p></details></section>
          <section><details class="bom-collapse"><summary><h2>AI 辅助比对</h2></summary><label><input type="checkbox" data-bom-ai-enabled> 启用 AI 辅助分析</label><label>服务商 <select data-bom-ai-provider><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="qwen">通义千问</option><option value="custom">自定义 OpenAI 兼容接口</option></select></label><label>接口地址 <input type="url" data-bom-ai-url placeholder="https://api.example.com/v1"></label><label>API Key <input type="password" data-bom-ai-key autocomplete="off" placeholder="只保存在浏览器扩展存储"></label><label>模型 <select data-bom-ai-model-select data-bom-model-select><option value="custom">自定义</option></select></label><button type="button" data-bom-fetch-models>获取模型列表</button><label data-bom-custom-model hidden>自定义模型 <input type="text" data-bom-ai-model-custom placeholder="输入模型名称"></label><p class="bom-model-status" data-bom-model-status></p><p class="bom-note">只发送搜索词、标题、域名和 URL，不发送网页正文。AI 不能解除本地高风险拦截。</p></details></section>
          <div class="bom-actions"><button type="button" data-bom-reset>恢复默认</button><button type="button" data-bom-cancel>取消</button><button type="button" data-bom-save>保存配置</button></div><div class="bom-status" role="status" data-bom-status></div>
        </div>`;
        GM_addStyle(`
          #bom-config-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.58);display:flex;align-items:center;justify-content:center;padding:20px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033}
          .bom-config{box-sizing:border-box;width:auto;max-width:min(680px,100%);max-height:min(850px,calc(100vh - 40px));overflow:auto;background:#fff;border:1px solid #d7dde8;border-radius:10px;box-shadow:0 20px 60px rgba(15,23,42,.28);padding:24px}
          .bom-config-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.bom-kicker{font-size:11px;letter-spacing:1.5px;color:#64748b;font-weight:700}.bom-config h1{font-size:25px;line-height:1.2;margin:4px 0 0}.bom-config h2{font-size:15px;margin:0 0 12px}.bom-config section{border-top:1px solid #e5e7eb;padding:18px 0}.bom-config label{display:block;margin:9px 0}.bom-config input[type=checkbox]{margin-right:8px;width:16px;height:16px;accent-color:#2563eb;vertical-align:-2px}.bom-config input[type=text],.bom-config input[type=url],.bom-config input[type=password],.bom-config input[type=number],.bom-config select{display:block;width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:0 10px;margin-top:5px;font:inherit;height:40px;line-height:40px}.bom-config textarea{display:block;width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:9px;margin-top:5px;font:inherit;resize:vertical}.bom-config label.bom-inline{display:inline-flex;align-items:center;gap:8px}.bom-config label.bom-inline input{display:inline-block;flex:none;width:96px;margin:0}.bom-presets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 20px}.bom-presets label{margin:4px 0}.bom-note{color:#526176;font-size:13px;margin:7px 0}.bom-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:10px}.bom-actions button,.bom-config-head button{border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:9px 14px;cursor:pointer;font:inherit}.bom-actions [data-bom-save]{background:#2563eb;border-color:#2563eb;color:#fff}.bom-config-head button{font-size:22px;line-height:1;padding:4px 10px}.bom-status{min-height:20px;color:#166534;text-align:right;margin-top:8px}.bom-model-status{min-height:20px;margin:6px 0;color:#526176}.bom-config .is-error{color:#b91c1c}.bom-config{scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent}.bom-config::-webkit-scrollbar{width:8px}.bom-config::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:4px}.bom-config::-webkit-scrollbar-thumb:hover{background:#94a3b8}.bom-config::-webkit-scrollbar-track{background:transparent}.bom-config section h2{position:relative;padding-left:11px}.bom-config section h2::before{content:"";position:absolute;left:0;top:3px;bottom:3px;width:4px;border-radius:2px;background:linear-gradient(180deg,#2563eb,#4E6EF2)}.bom-config [data-bom-fetch-models]{width:100%;margin-top:4px;box-sizing:border-box;height:40px;line-height:38px;padding:0 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font:inherit}@media(max-width:600px){#bom-config-overlay{padding:0}.bom-config{max-height:100vh;border-radius:0;padding:18px}.bom-presets{grid-template-columns:1fr}}.bom-config input[type=text],.bom-config input[type=url],.bom-config input[type=password],.bom-config input[type=number],.bom-config select,.bom-config textarea,.bom-config button{transition:border-color .15s,box-shadow .15s,background .15s,color .15s}.bom-config input[type=text]:hover,.bom-config input[type=url]:hover,.bom-config input[type=password]:hover,.bom-config input[type=number]:hover,.bom-config select:hover,.bom-config textarea:hover{border-color:#94a3b8}.bom-config input:focus,.bom-config select:focus,.bom-config textarea:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.14)}.bom-actions button:hover,.bom-config-head button:hover,.bom-config [data-bom-fetch-models]:hover{border-color:#94a3b8}.bom-actions [data-bom-save]:hover{background:#1d4ed8}.bom-config-head button:hover{color:#2563eb}#bom-config-overlay{backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}details.bom-collapse>summary{list-style:none;cursor:pointer;user-select:none;padding:6px 8px;margin:-4px -8px;border-radius:6px;transition:background .15s}details.bom-collapse>summary:hover{background:#f1f5f9}details.bom-collapse>summary:active{background:#e2e8f0}details.bom-collapse>summary::-webkit-details-marker{display:none}details.bom-collapse>summary h2{margin:0}details.bom-collapse>summary h2::after{content:" ▸";color:#94a3b8;font-size:12px}details.bom-collapse[open]>summary h2::after{content:" ▾"}@media(max-width:420px){.bom-config{padding:14px}.bom-config h1{font-size:21px}}
        `);
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        const $ = selector => overlay.querySelector(selector);
        const fill = current => {
            $('[data-bom-enabled]').checked = current.enabled;
            $('[data-bom-risk]').checked = current.alwaysBlockRisk !== false;
            $('[data-bom-cache]').value = current.cacheMinutes ?? 10;
            $('[data-bom-mode]').value = current.protectionMode || 'download';
            $('[data-bom-download-words]').value = (current.downloadKeywords || DEFAULT_DOWNLOAD_KEYWORDS).join('\n');
            $('[data-bom-download-exts]').value = (current.downloadExtensions || DEFAULT_DOWNLOAD_EXTENSIONS).join('\n');
            $('[data-bom-words]').value = current.exclusions.words.join('\n');
            $('[data-bom-trusted]').value = (current.trustedPlatforms || DEFAULT_TRUSTED_PLATFORMS).join('\n');
            overlay.querySelectorAll('[data-bom-preset]').forEach(el => el.checked = current.exclusions.presets[el.dataset.bomPreset] !== false);
            overlay.querySelectorAll('[data-bom-engine]').forEach(el => el.checked = current.engines[el.dataset.bomEngine] === true);
            $('[data-bom-ai-enabled]').checked = current.ai.enabled;
            $('[data-bom-ai-provider]').value = current.ai.provider;
            $('[data-bom-ai-url]').value = current.ai.baseUrl;
            $('[data-bom-ai-model-select]').value = 'custom';
            $('[data-bom-ai-model-custom]').value = current.ai.model;
            $('[data-bom-custom-model]').hidden = true;
            $('[data-bom-ai-key]').value = current.ai.apiKey;
            $('[data-bom-xsn-enabled]').checked = current.xsn.enabled === true;
        };
        fill(config);
        const close = () => { document.body.style.overflow = ''; overlay.remove(); };
        overlay.querySelectorAll('[data-bom-close],[data-bom-cancel]').forEach(el => el.addEventListener('click', close));
        $('[data-bom-ai-provider]').addEventListener('change', event => { const status = $('[data-bom-model-status]'); if (status) status.classList.remove('is-error'); const preset = AI_PROVIDERS[event.target.value]; if (preset) { $('[data-bom-ai-url]').value = preset.baseUrl; $('[data-bom-ai-model-select]').value = 'custom'; $('[data-bom-ai-model-custom]').value = preset.model; $('[data-bom-custom-model]').hidden = false; } });
        $('[data-bom-ai-model-select]').addEventListener('change', event => { $('[data-bom-custom-model]').hidden = event.target.value !== 'custom'; });
        $('[data-bom-fetch-models]').addEventListener('click', async () => { const status = $('[data-bom-model-status]'); status.classList.remove('is-error'); status.textContent = '正在获取模型列表...'; try { const models = await fetchModelIds({ ai: { apiKey: $('[data-bom-ai-key]').value, baseUrl: $('[data-bom-ai-url]').value } }); const select = $('[data-bom-ai-model-select]'); select.replaceChildren(); models.forEach(model => { const option = document.createElement('option'); option.value = model; option.textContent = model; select.appendChild(option); }); select.value = 'custom'; $('[data-bom-custom-model]').hidden = false; status.textContent = `已获取 ${models.length - 1} 个模型`; } catch (error) { status.classList.add('is-error'); status.textContent = error.message; } });
        $('[data-bom-reset]').addEventListener('click', () => fill(defaultConfig()));
        $('[data-bom-save]').addEventListener('click', () => {
            const next = normalizeConfig({
                version: config.version,
                enabled: $('[data-bom-enabled]').checked, protectionMode: $('[data-bom-mode]').value, alwaysBlockRisk: $('[data-bom-risk]').checked,
                cacheMinutes: Math.max(0, Math.min(1440, Number($('[data-bom-cache]').value) || 10)),
                downloadKeywords: $('[data-bom-download-words]').value.split(/\r?\n|[,，]/).map(word => word.trim()).filter(Boolean),
                downloadExtensions: $('[data-bom-download-exts]').value.split(/\r?\n|[,，]/).map(word => word.trim()).filter(Boolean),
                exclusions: { enabled: true, presets: Object.fromEntries([...overlay.querySelectorAll('[data-bom-preset]')].map(el => [el.dataset.bomPreset, el.checked])), words: $('[data-bom-words]').value.split(/\r?\n|[,，]/).map(word => word.trim()).filter(Boolean) },
                trustedPlatforms: $('[data-bom-trusted]').value.split(/\r?\n|[,，]/).map(host => host.trim()).filter(Boolean),
                engines: Object.fromEntries([...overlay.querySelectorAll('[data-bom-engine]')].map(el => [el.dataset.bomEngine, el.checked])),
                ai: { enabled: $('[data-bom-ai-enabled]').checked, provider: $('[data-bom-ai-provider]').value, baseUrl: $('[data-bom-ai-url]').value.trim(), model: $('[data-bom-ai-model-select]').value === 'custom' ? $('[data-bom-ai-model-custom]').value.trim() : $('[data-bom-ai-model-select]').value, apiKey: $('[data-bom-ai-key]').value },
                xsn: { enabled: $('[data-bom-xsn-enabled]').checked }
            });
            saveConfig(next); $('[data-bom-status]').textContent = '已保存。刷新搜索页后生效。';
        });
        $('[data-bom-close]').focus();
    }

    function normalizeHttpUrl(value) {
        if (typeof value !== 'string' || !value.trim()) return null;
        try {
            const url = new URL(value.trim());
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
            url.hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
            if ((url.protocol === 'http:' && url.port === '80') ||
                (url.protocol === 'https:' && url.port === '443')) url.port = '';
            return url;
        } catch (_) {
            return null;
        }
    }

    function isIpHostname(hostname) {
        return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
    }

    function getRegistrableDomain(hostname) {
        const parts = hostname.split('.');
        if (parts.length < 2) return hostname;
        const suffix = parts.slice(-2).join('.');
        if (PUBLIC_SUFFIXES.has(suffix) && parts.length >= 3) {
            return parts.slice(-3).join('.');
        }
        return suffix;
    }

    function classifyUrl(value) {
        const url = normalizeHttpUrl(value);
        if (!url) return { level: 'high-risk', reasons: ['无法解析为网页 URL'], url: null };
        const reasons = [];
        if (url.protocol !== 'https:') reasons.push('未使用 HTTPS');
        if (isIpHostname(url.hostname)) reasons.push('使用 IP 地址');
        if (url.username || url.password) reasons.push('URL 包含登录凭据');
        if (url.port) reasons.push('使用非标准端口');
        if (SHORTENER_HOSTS.has(url.hostname)) reasons.push('使用短链接服务');
        if (/[?&](url|target|redirect|redirect_uri|next)=/i.test(url.search)) reasons.push('包含可能的跳转参数');
        return { level: reasons.length ? 'high-risk' : 'trusted', reasons, url };
    }

    function getMatchType(url1, url2) {
        const first = normalizeHttpUrl(url1);
        const second = normalizeHttpUrl(url2);
        if (!first || !second || first.protocol !== 'https:' || second.protocol !== 'https:') return 'none';
        if (first.hostname === second.hostname) return 'exact';
        if (getRegistrableDomain(first.hostname) === getRegistrableDomain(second.hostname) &&
            !PUBLIC_SUFFIXES.has(first.hostname) && !PUBLIC_SUFFIXES.has(second.hostname)) return 'main';
        return 'none';
    }

    function getResultDecision(url, matched, matchType) {
        const urlDecision = classifyUrl(url);
        urlDecision.matchType = matchType;
        if (urlDecision.level === 'high-risk') {
            return { ...urlDecision, label: '高风险链接', requiresConfirmation: true };
        }
        if (matched && matchType === 'exact') {
            return { ...urlDecision, label: '官网参考', requiresConfirmation: false };
        }
        if (matched && matchType === 'main') {
            return { ...urlDecision, label: '需确认', requiresConfirmation: true };
        }
        return { ...urlDecision, label: '未验证', requiresConfirmation: true };
    }

    // ==================== XSN 情报标红（只读） ====================
    // 只用到 XSN（星海安全网络）官网首页「API 接入」公开列出的查询接口：
    //   GET /v1/ioc/:type/:value   单条情报快速查询
    // 脚本对 XSN 只读：不注册节点、不上报、不调用任何写入接口。
    // 标签直接反映 XSN 的判定结果，不额外做本地语义推断：命中 high/critical → 「XSN 风险」。
    // 它补的是本地看不到的那一类：HTTPS + 正常端口 + 真域名的站点，本地只能给出「未验证」。

    function xsnIocIndex(list) {
        const index = new Map();
        (Array.isArray(list) ? list : []).forEach(item => {
            const value = String((item && item.indicator_value) || '').toLowerCase();
            if (!value || item.found === false) return;
            index.set(value, {
                severity: String(item.severity || '').toLowerCase(),
                family: item.family || '',
                confidence: item.confidence,
                hit_count: item.hit_count,
                status: String(item.status || '').toLowerCase()
            });
        });
        return index;
    }

    function trustedPlatformList(config) {
        const list = config && Array.isArray(config.trustedPlatforms) ? config.trustedPlatforms : DEFAULT_TRUSTED_PLATFORMS;
        return list.map(host => String(host || '').trim().toLowerCase()).filter(Boolean);
    }

    // 只按主机名匹配平台本身：github.com 及其子域命中，github.com.evil.tld 不命中
    function trustedPlatformFor(hostname, config) {
        const host = String(hostname || '').toLowerCase();
        if (!host) return null;
        return trustedPlatformList(config).find(item => host === item || host.endsWith('.' + item)) || null;
    }

    // 免检查名单只压掉"未验证/需确认/XSN 情报"这类提醒，压不掉本地高危
    function applyTrustedPlatformVerdict(decision, platform) {
        if (!decision || !platform) return decision;
        if (decision.level === 'high-risk') return decision;
        if (decision.label === '官网参考') return decision;
        return {
            ...decision,
            label: '可信平台',
            requiresConfirmation: false,
            trustedPlatform: platform,
            reasons: [`${platform} 在可信平台名单里：脚本只判定平台域名本身`]
        };
    }

    function xsnLookupHit(hostname, index) {
        const host = String(hostname || '').toLowerCase();
        if (!host || !(index instanceof Map)) return null;
        if (index.has(host)) return index.get(host);
        const domain = getRegistrableDomain(host);
        return index.has(domain) ? index.get(domain) : null;
    }

    function xsnIsHigh(hit) {
        return Boolean(hit) && XSN_HIGH_SEVERITIES.has(hit.severity) && hit.status !== 'false_positive';
    }

    function xsnHitTitle(hit) {
        const parts = [`XSN 情报：${hit.family || '未标注家族'}`, `等级 ${hit.severity || '未知'}`];
        if (hit.confidence != null) parts.push(`置信 ${hit.confidence}`);
        if (hit.hit_count != null) parts.push(`全网命中 ${hit.hit_count} 次`);
        if (hit.status) parts.push(`状态 ${hit.status}`);
        return parts.join(' · ');
    }

    function applyXsnVerdict(decision, hit) {
        // 免检查名单优先：名单内的平台不查情报，即使拿到命中也不覆盖「可信平台」
        if (decision && decision.label === '可信平台') return decision;
        if (!xsnIsHigh(hit)) return decision;
        return {
            ...decision,
            label: 'XSN 风险',
            requiresConfirmation: true,
            xsn: hit,
            reasons: [...new Set([...(decision.reasons || []), `XSN 情报：${hit.family || '未标注家族'}（${hit.severity}）`])]
        };
    }

    // 刻意只实现 GET：脚本对 XSN 只有查询能力，结构上不存在写入路径
    function xsnRequest(path, timeout) {
        if (typeof GM_xmlhttpRequest !== 'function') return Promise.resolve(null);
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: XSN_DEFAULT_ENDPOINT + path,
                anonymous: true,
                timeout: timeout || 10000,
                onload: response => {
                    try {
                        resolve({ status: response.status, data: JSON.parse(response.responseText) });
                    } catch (_) {
                        resolve({ status: response.status, data: null });
                    }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null)
            });
        });
    }

    // 按域逐个查公开情报；未命中的负结果一起缓存，10 分钟内不重复请求
    async function xsnLookupHosts(hosts) {
        const index = new Map();
        const cachedHosts = new Set();
        try {
            const saved = JSON.parse(GM_getValue(XSN_IOC_KEY, 'null'));
            const fresh = saved && Array.isArray(saved.entries) && Date.now() - Number(saved.at || 0) < XSN_IOC_TTL_MS;
            (fresh ? saved.entries : []).forEach(entry => {
                if (Array.isArray(entry) && entry.length === 2) {
                    index.set(entry[0], entry[1]);
                    cachedHosts.add(entry[0]);
                }
            });
        } catch (_) { /* 缓存读取失败就当作空缓存 */ }
        const targets = [...new Set(hosts.map(host => String(host || '').toLowerCase()).filter(Boolean))];
        const missing = targets
            .filter(host => !index.has(host) && !index.has(getRegistrableDomain(host)))
            .slice(0, XSN_LOOKUP_MAX);
        // 只有确实拿到 200 的查询才写缓存：限流/网络故障时不能把"查不到"当成"没问题"缓存下来
        const resolved = new Set();
        for (const host of missing) {
            const response = await xsnRequest('/v1/ioc/domain/' + encodeURIComponent(host));
            if (!response || response.status !== 200) continue;
            const data = response.data;
            resolved.add(host);
            index.set(host, data && data.found ? {
                severity: String(data.severity || '').toLowerCase(),
                family: data.family || '',
                confidence: data.confidence,
                hit_count: data.hit_count,
                status: String(data.status || '').toLowerCase()
            } : null);
        }
        if (missing.length && !resolved.size) {
            console.warn('[官网补全] XSN 情报查询未成功（可能是限流或网络问题），本次不做情报标记');
        }
        if (resolved.size) {
            try {
                const keep = [...index].filter(([host]) => cachedHosts.has(host) || resolved.has(host));
                GM_setValue(XSN_IOC_KEY, JSON.stringify({ at: Date.now(), entries: keep.slice(-400) }));
            } catch (_) { /* 存储不可用时只是不缓存，不影响标记 */ }
        }
        return index;
    }

    const BAIDU_SEARCH_URL = 'https://www.baidu.com/s?wd=';
    const CACHE_PREFIX = 'bom:baidu:';
    const CACHE_TTL_MS = 10 * 60 * 1000;
    const SELECTOR_BAIDU_ITEM = '.result-op, .result';
    const SELECTOR_OFFICIAL_TAG = '.www-tag-fill-blue_3n0y3, .www-tag-fill-blue, .cos-tag-filled, .c-tag.c-tag-filled';
    const SELECTOR_BING_ITEM = 'li.b_algo';

    const BLOCKED_URL_PATTERNS = [
        'nourl.ubs.baidu.com',
        'baidu.php?url=',
        'link?url=',
        'jump?',
        'click?',
        'adx.php',
        'e.baidu.com'
    ];

    function isBlockedUrl(url) {
        if (!url || typeof url !== 'string') return true;
        const lower = url.toLowerCase();
        return BLOCKED_URL_PATTERNS.some(pattern => lower.includes(pattern));
    }

    function cacheKey(keyword) {
        return CACHE_PREFIX + encodeURIComponent(keyword.trim().toLowerCase());
    }

    function readCache(keyword) {
        try {
            const value = JSON.parse(sessionStorage.getItem(cacheKey(keyword)) || 'null');
            return value && Date.now() - value.time <= CACHE_TTL_MS && Array.isArray(value.links) ? value.links : null;
        } catch (_) {
            return null;
        }
    }

    function writeCache(keyword, links) {
        try {
            sessionStorage.setItem(cacheKey(keyword), JSON.stringify({ time: Date.now(), links }));
        } catch (_) { /* storage may be unavailable */ }
    }
    function fetchBaiduOfficialLinks(keyword) {
        return new Promise((resolve) => {
            const cached = readCache(keyword);
            if (cached) {
                // 不打日志时，命中缓存与"请求被拦"在控制台上长得一模一样，排查会误判
                console.log('[官网补全] 百度结果命中缓存（10 分钟内）:', keyword, cached.length, '条');
                resolve(cached);
                return;
            }
            const url = BAIDU_SEARCH_URL + encodeURIComponent(keyword);
            console.log('[官网补全] 请求百度：', url);

            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 10000,
                followRedirects: false,
                onload: function(response) {
                    const finalUrl = response.finalUrl || url;
                    const blockedToCaptcha = response.status >= 300 || /wappass|安全验证|captcha|verify/i.test(finalUrl);
                    if (response.status !== 200 || response.responseText.length < 5000 || blockedToCaptcha) {
                        if (blockedToCaptcha) {
                            console.warn('[官网补全] 百度触发了 wappass 安全验证，本次抓取被拦截。可在浏览器中先打开一个百度页面手动过码，再回到 Bing 刷新，通常一段时间内可正常获取官网。', finalUrl);
                            registerVerification('baidu', pickCaptchaSource(extractRedirectUrl(response.headers), url), url);
                        } else {
                            console.warn('[官网补全] 百度返回异常或过短', response.status, finalUrl);
                        }
                        resolve([]);
                        return;
                    }

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(response.responseText, 'text/html');
                    const items = doc.querySelectorAll(SELECTOR_BAIDU_ITEM);
                    console.log('[官网补全] 解析到百度结果项数量:', items.length);

                    const officialList = [];
                    const seenUrls = new Set();
                    items.forEach((item) => {
                        const tag = Array.from(item.querySelectorAll(SELECTOR_OFFICIAL_TAG))
                            .find(el => el.textContent.trim() === '官方');
                        if (!tag) return;

                        let realUrl = null;

                        const muEl = item.closest('[mu]') || item.querySelector('[mu]');
                        if (muEl) {
                            realUrl = muEl.getAttribute('mu');
                        }

                        if (!realUrl) {
                            const landLink = item.querySelector('a[data-landurl]');
                            if (landLink) {
                                realUrl = landLink.getAttribute('data-landurl');
                            }
                        }

                        if (!realUrl) {
                            const clickEl = item.querySelector('[data-click]');
                            if (clickEl) {
                                try {
                                    const clickData = JSON.parse(clickEl.getAttribute('data-click'));
                                    realUrl = clickData.mu || clickData.url;
                                    if (realUrl && typeof realUrl === 'string' && !realUrl.startsWith('http')) {
                                        realUrl = null;
                                    }
                                } catch (e) { /* ignore */ }
                            }
                        }

                        if (realUrl && realUrl.startsWith('http')) {
                            try {
                                realUrl = normalizeHttpUrl(decodeURIComponent(realUrl));
                                if (!realUrl) return;
                                realUrl = realUrl.href;
                                if (isBlockedUrl(realUrl)) {
                                    console.warn('[官网补全] 过滤虚假链接:', realUrl);
                                    return;
                                }
                                const domain = new URL(realUrl).hostname;
                                if (domain) {
                                    const titleEl = item.querySelector('h3 a, .t a');
                                    const title = titleEl ? titleEl.textContent.trim() : '官网';
                                    if (seenUrls.has(realUrl)) return;
                                    seenUrls.add(realUrl);
                                    officialList.push({
                                        url: realUrl,
                                        title: title,
                                        displayDomain: domain
                                    });
                                    console.log('[官网补全] 找到官网:', title, '→', realUrl);
                                }
                            } catch (e) {
                                console.warn('[官网补全] 无效 URL:', realUrl);
                            }
                        } else {
                            console.warn('[官网补全] 未找到有效 URL');
                        }
                    });

                    console.log('[官网补全] 共提取到', officialList.length, '个官网');
                    writeCache(keyword, officialList);
                    resolve(officialList);
                },
                onerror: function(err) {
                    console.warn('[官网补全] 请求百度失败', err);
                    resolve([]);
                },
                ontimeout: function() {
                    console.warn('[官网补全] 百度请求超时');
                    resolve([]);
                }
            });
        });
    }

    // ==================== 安全验证被拦时的提示条 + 重试（百度/360/搜狗/头条通用） ====================
    let bomLastRetryAt = 0;
    let bomPendingVerifications = []; // [{ engine, label, url }]
    const BOM_BANNER_STYLE = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);width:fit-content;min-width:min(420px,calc(100vw - 32px));' +
        'z-index:2147483000;max-width:calc(100vw - 32px);box-sizing:border-box;' +
        'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' +
        'padding:8px 12px;border:1px solid #f5d078;border-radius:6px;' +
        'background:#fffbe6;color:#6b4f08;font:13px/1.5 system-ui,"Segoe UI",sans-serif;';

    function extractRedirectUrl(headers) {
        const lines = String(headers || '').split(/\r?\n/);
        for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx < 0) continue;
            if (line.slice(0, idx).trim().toLowerCase() === 'location') {
                return line.slice(idx + 1).trim();
            }
        }
        return '';
    }

    // 只优先使用"看起来像验证页"的地址（引擎下发的真实挑战），否则回退到引擎首页重新触发验证
    function pickCaptchaSource(location, base) {
        const raw = String(location || '');
        if (!raw) return '';
        try {
            const url = new URL(raw, base);
            if (looksLikeChallenge(url.href)) return url.href;
        } catch (_) { /* 非 URL 则忽略 */ }
        return '';
    }

    // 记录一个待处理的验证挑战：同一引擎只保留一条，多个引擎同时被拦则在同一提示条里并列
    function registerVerification(engine, captchaUrl, fallbackUrl) {
        const meta = ENGINE_VERIFY[engine] || { label: engine, home: '' };
        const url = captchaUrl || fallbackUrl || meta.home;
        const existing = bomPendingVerifications.find(item => item.engine === engine);
        if (existing) {
            if (url) existing.url = url;
        } else {
            bomPendingVerifications.push({ engine, label: meta.label, url, home: meta.home });
        }
        showVerifyBanner();
    }

    function showVerifyBanner() {
        const pending = bomPendingVerifications;
        if (!pending.length) return;
        const old = document.getElementById('bom-verify-banner');
        if (old) old.remove();

        const bar = document.createElement('div');
        bar.id = 'bom-verify-banner';
        bar.style.cssText = BOM_BANNER_STYLE;
        const info = document.createElement('div');
        info.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';
        const text = document.createElement('span');
        text.textContent = `${pending.map(item => item.label).join('、')}安全验证拦截，未能获取完整参考数据。`;
        info.appendChild(text);
        const hint = document.createElement('span');
        hint.style.cssText = 'font-size:12px;opacity:.85;';
        hint.textContent = `若验证反复不通过（尤其 360），请点「打开${pending[0].label}首页」在新标签页里随便搜一次，再回来点「重试」。`;
        info.appendChild(hint);
        bar.appendChild(info);

        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.textContent = `去完成${pending[0].label}验证`;
        goBtn.style.cssText = 'border:1px solid #c2981f;border-radius:4px;background:#fff;padding:3px 10px;cursor:pointer;font:inherit;';
        goBtn.onclick = () => openVerifyPopup(pending[0].url, goBtn);
        bar.appendChild(goBtn);

        // 新标签页打开引擎首页：不监听关闭（用户要在里面正常搜索养会话），因而不参与自动重试
        const homeBtn = document.createElement('button');
        homeBtn.type = 'button';
        homeBtn.textContent = `打开${pending[0].label}首页`;
        homeBtn.title = '在新标签页打开，并在里面随便搜一次';
        homeBtn.style.cssText = 'border:1px solid #c2981f;border-radius:4px;background:#fff;padding:3px 10px;cursor:pointer;font:inherit;';
        homeBtn.onclick = () => openEngineHomeInNewTab(pending[0].home);
        bar.appendChild(homeBtn);

        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.id = 'bom-verify-retry';
        retryBtn.textContent = '重试';
        retryBtn.style.cssText = 'border:1px solid #c2981f;border-radius:4px;background:#fff;padding:3px 10px;cursor:pointer;font:inherit;';
        retryBtn.onclick = () => triggerVerifyRetry();
        bar.appendChild(retryBtn);

        document.body.appendChild(bar);
    }

    // 普通新标签页打开（不是被 watchPopupClose 跟踪的弹窗），用于让用户在新页面里"养"出正常会话
    function openEngineHomeInNewTab(url) {
        if (!url) return;
        const win = window.open(url, '_blank');
        if (!win) {
            console.warn('[官网补全] 浏览器拦截了新标签页，请在站点设置允许 bing.com 弹窗后再次点击');
        }
    }

    function openVerifyPopup(url, btn) {
        const target = url || 'https://www.baidu.com';
        // 优先开真正的独立弹窗（带尺寸串，才能用 win.closed 感知关闭并做"过码后回调"）
        let win = null;
        try {
            win = window.open(target, 'bomVerify', 'popup=1,width=900,height=660,left=120,top=80,resizable=yes,scrollbars=yes,status=yes');
        } catch (_) { /* ignore */ }
        if (!win) {
            // 弹窗被拦，回退为新标签页（仍是 window.open，仅目标不同）
            win = window.open(target, '_blank');
        }
        if (!win) {
            btn.textContent = '弹出窗口被拦截，请在本站放行弹窗后重试';
            btn.style.borderColor = '#b91c1c';
            console.warn('[官网补全] 浏览器拦截了弹窗，请在站点设置允许 bing.com 弹窗后再次点击');
            return;
        }
        watchPopupClose(win);
    }

    function watchPopupClose(win) {
        const timer = setInterval(() => {
            if (win.closed) {
                clearInterval(timer);
                console.log('[官网补全] 验证窗口已关闭，自动重试抓取');
                triggerVerifyRetry();
            }
        }, 500);
        // 兜底：超过 10 分钟未关闭就不再轮询，避免泄漏
        setTimeout(() => clearInterval(timer), 10 * 60 * 1000);
    }

    function triggerVerifyRetry() {
        const now = Date.now();
        if (now - bomLastRetryAt < 3000) return; // 防抖，防止连续点击造成连环请求
        bomLastRetryAt = now;
        const bar = document.getElementById('bom-verify-banner');
        if (bar) bar.remove();
        bomPendingVerifications = [];
        // 清理上一次结果后重新抓取并标记（与 runScript 的清理保持一致）
        document.querySelectorAll('[data-bom-tag="true"]').forEach(el => el.remove());
        document.querySelectorAll('li[data-bom-injected="true"]').forEach(el => el.remove());
        main(++activeSearchId);
    }

    function createTag(label, title, extraStyle) {
        const tag = document.createElement('span');
        tag.textContent = label;
        tag.style.display = 'inline-block';
        tag.style.backgroundColor = '#4E6EF2';
        tag.style.color = '#FFFFFF';
        tag.style.fontSize = '12px';
        tag.style.fontWeight = '500';
        tag.style.padding = '1px 6px';
        tag.style.borderRadius = '3px';
        tag.style.marginLeft = '8px';
        tag.style.lineHeight = '18px';
        tag.style.verticalAlign = 'middle';
        if (title) tag.title = title;
        if (extraStyle) Object.assign(tag.style, extraStyle);
        tag.setAttribute('data-bom-tag', 'true');
        return tag;
    }

    function getResultLink(item) {
        const link = item.querySelector('h2 a, .b_algoheader a, .b_title a');
        const url = link && normalizeHttpUrl(link.href);
        return url ? link : null;
    }

    function installNavigationGuard(anchor, decision, officialUrl) {
        if (!decision.requiresConfirmation) return;
        if (anchor.dataset.bomGuarded === 'true') return;
        anchor.dataset.bomGuarded = 'true';
        const guard = (event) => {
            event.preventDefault();
            const reasons = decision.reasons.length ? `\n风险：${decision.reasons.join('、')}` : '';
            const reference = officialUrl ? `\n百度认证参考：${officialUrl}` : '';
            const message = `即将打开：${anchor.href}${reference}${reasons}\n\n该链接不是已确认的严格匹配结果，仍要继续吗？`;
            if (window.confirm(message)) window.location.href = anchor.href;
        };
        anchor.addEventListener('click', guard, true);
        anchor.addEventListener('auxclick', guard, true);
    }

    // ==================== 优化的容器查找 ====================
    function getResultsContainer() {
        const el = document.querySelector('#b_results');
        if (el && el.children.length > 0) {
            console.log('[官网补全] 使用容器选择器: #b_results');
            return el;
        }
        if (el) {
            console.log('[官网补全] #b_results 存在但为空，等待渲染');
            return null;
        }
        console.warn('[官网补全] 未找到 #b_results');
        return null;
    }

    // ==================== 改进的等待容器函数 ====================
    function waitForContainer(maxWaitMs = 30000) {
        return new Promise((resolve) => {
            // 先立即检查
            const existing = getResultsContainer();
            if (existing) {
                resolve(existing);
                return;
            }

            let timeoutId = null;
            let intervalId = null;

            // 定时轮询（兜底）
            intervalId = setInterval(() => {
                const container = getResultsContainer();
                if (container) {
                    clearInterval(intervalId);
                    clearTimeout(timeoutId);
                    resolve(container);
                }
            }, 300);

            // MutationObserver 监听
            const observer = new MutationObserver(() => {
                const container = getResultsContainer();
                if (container) {
                    observer.disconnect();
                    clearInterval(intervalId);
                    clearTimeout(timeoutId);
                    resolve(container);
                }
            });
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            // 超时
            timeoutId = setTimeout(() => {
                observer.disconnect();
                clearInterval(intervalId);
                const lastTry = getResultsContainer();
                if (lastTry) {
                    resolve(lastTry);
                } else {
                    console.warn('[官网补全] 等待容器超时');
                    resolve(null);
                }
            }, maxWaitMs);
        });
    }

    // ==================== 核心主逻辑 ====================
    async function main(searchId) {
        console.log('[官网补全] 脚本开始运行');

        const config = loadConfig();

        const urlParams = new URLSearchParams(window.location.search);
        const keyword = urlParams.get('q');
        if (!keyword) {
            console.log('[官网补全] 未找到搜索关键词');
            return;
        }

        if (!config.enabled || shouldExcludeKeyword(keyword, config)) {
            console.log('[官网补全] 当前搜索命中排除词或脚本已关闭');
            return;
        }

        // 下载意图：去掉下载词后得到的"参考词"再搜索，避免下载噪音干扰官网定位（如 "qq 下载" → "qq"）
        const referenceKeyword = hasDownloadIntent(keyword, config) ? stripDownloadKeywords(keyword, config) : keyword;
        const officialLinks = config.engines.baidu ? await fetchBaiduOfficialLinks(referenceKeyword) : [];
        if (searchId !== activeSearchId) return;

        const engineEntries = Object.entries(config.engines).filter(([engine, enabled]) => enabled && engine !== 'baidu');
        const engineResults = await Promise.all(engineEntries.map(async ([engine]) => [engine, await fetchEngineDomains(referenceKeyword, engine)]));
        const engineEvidence = Object.fromEntries(engineResults);
        if (config.engines.baidu) engineEvidence.baidu = new Set(officialLinks.map(item => item.displayDomain));
        // 抓取成功时本来是全程静默的，和"请求被拦/解析不到"在控制台上无法区分，
        // 所以这里把每个引擎拿到的域名数打出来：看到 0 就知道该引擎实际没贡献证据。
        console.log('[官网补全] 参考引擎证据:', Object.entries(engineEvidence)
            .map(([engine, hosts]) => `${ENGINE_LABELS[engine] || engine} ${hosts.size}`)
            .join('、') || '（无）');
        // 0 条不一定是"被验证拦截"（那条有单独的 warn），也可能是页面结构变了或该词本来就没官网，
        // 总之值得提示一句，否则用户只能看到"什么都没发生"
        Object.entries(engineEvidence).forEach(([engine, hosts]) => {
            if (!hosts.size) console.warn('[官网补全] ' + (ENGINE_LABELS[engine] || engine) + ' 本次未拿到任何证据');
        });

        const aiReview = await requestAiReview(keyword, officialLinks, config);
        if (aiReview && searchId === activeSearchId) {
            console.log('[官网补全] AI 辅助参考:', aiReview);
        }

        const container = await waitForContainer(30000);
        if (searchId !== activeSearchId) return;
        if (!container) {
            console.warn('[官网补全] 超时未找到搜索结果容器，放弃插入');
            return;
        }

        const bingItems = container.querySelectorAll(SELECTOR_BING_ITEM);
        const matchedSet = new Set();
        console.log('[官网补全] Bing 结果项:', bingItems.length, '｜百度认证官网:', officialLinks.length);

        // 先批量取回本页结果域名的 XSN 公开情报（缓存 10 分钟），再统一做标记。
        // 免检查名单里的域名不查 XSN：既不检查，也不把这些域名发出去
        const resultHosts = [...bingItems]
            .map(item => { const link = getResultLink(item); const parsed = link && normalizeHttpUrl(link.href); return parsed ? parsed.hostname : ''; })
            .filter(Boolean);
        const xsnHosts = resultHosts.filter(host => !trustedPlatformFor(host, config));
        const xsnIndex = config.xsn.enabled && xsnHosts.length ? await xsnLookupHosts(xsnHosts) : new Map();
        if (searchId !== activeSearchId) return;

        bingItems.forEach((item) => {
            const link = getResultLink(item);
            if (!link) return;
            let matched = null;
            let matchType = 'none';
            for (const o of officialLinks) {
                const type = getMatchType(link.href, o.url);
                if (type !== 'none') {
                    matched = o;
                    matchType = type;
                    break;
                }
            }
            const parsedLink = normalizeHttpUrl(link.href);
            const xsnHit = config.xsn.enabled && parsedLink ? xsnLookupHit(parsedLink.hostname, xsnIndex) : null;
            const trustedPlatform = parsedLink ? trustedPlatformFor(parsedLink.hostname, config) : null;
            const titleContainer = item.querySelector('h2, .b_title, .b_algoheader');
            if (titleContainer) {
                const oldTags = titleContainer.querySelectorAll('span[data-bom-tag="true"]');
                oldTags.forEach(el => el.remove());

                let decision = getResultDecision(link.href, matched, matchType);
                decision = applyTrustedPlatformVerdict(decision, trustedPlatform);
                decision = applyXsnVerdict(decision, xsnHit);
                const title = decision.label === '未验证'
                    ? '未找到对应的百度认证官网，请在打开前核对域名'
                    : decision.label === '可信平台' ? `${decision.trustedPlatform}：只判定平台域名本身，页面内容由用户上传（仓库/帖子/评论等），安全性请自行判断`
                    : decision.label === 'XSN 风险' ? xsnHitTitle(decision.xsn)
                    : decision.label === '高风险链接' ? decision.reasons.join('、')
                    : decision.label === '官网参考' ? 'HTTPS 主机名与百度认证结果一致，但不代表页面绝对安全'
                    : '主域相同但主机名不同（认证: ' + matched.displayDomain + '）';
                const extraStyle = decision.label === '可信平台' ? { backgroundColor: '#15803d' }
                    : decision.label === 'XSN 风险' ? { backgroundColor: '#b91c1c' }
                    : decision.label === '高风险链接' ? { backgroundColor: '#b91c1c' }
                    : decision.label === '需确认' ? { backgroundColor: '#FF8C00' }
                    : decision.label === '未验证' ? { backgroundColor: '#6b7280' } : {};
                const evidence = summarizeEngineEvidence(link.href, engineEvidence);
                const evidenceTitle = evidence.matches > 1 ? `${title}；${evidence.label}（${evidence.matches} 个引擎）` : title;
                titleContainer.appendChild(createTag(decision.label, evidenceTitle, extraStyle));
            }
            let decision = getResultDecision(link.href, matched, matchType);
            decision = applyTrustedPlatformVerdict(decision, trustedPlatform);
            decision = applyXsnVerdict(decision, xsnHit);
            decision.requiresConfirmation = shouldConfirmNavigation(link.href, matched, matchType, keyword, config);
            installNavigationGuard(link, decision, matched && matched.url);
            item.querySelectorAll('a[href]').forEach((anchor) => {
                if (anchor === link) return;
                const decision = getResultDecision(anchor.href, null, 'none');
                decision.requiresConfirmation = shouldConfirmNavigation(anchor.href, null, 'none', keyword, config);
                installNavigationGuard(anchor, decision, null);
            });
            if (matched) {
                matchedSet.add(matched.url);
                console.log('[官网补全] 标记已有结果:', matched.title, '→', matchType);
            }
        });

        // 插入未匹配的官网（这些是百度认证的，直接显示官网）
        const unmatched = officialLinks.filter(o => !matchedSet.has(o.url));
        if (unmatched.length === 0) {
            // officialLinks 为空时也会走到这里，不能报成"所有官网已匹配"——那是空跑，不是成功
            const note = officialLinks.length
                ? `标记 ${matchedSet.size} 条结果，无待插入官网`
                : '百度未返回认证官网，本页仅按本地规则标记';
            console.log('[官网补全] 处理完成：' + note);
            return;
        }

        unmatched.reverse().forEach((o) => {
            const li = document.createElement('li');
            li.className = 'b_algo';
            li.setAttribute('data-bom-injected', 'true');
            li.style.padding = '12px 0';
            li.style.borderBottom = '1px solid #ebebeb';

            const h2 = document.createElement('h2');
            h2.style.fontSize = '20px';
            h2.style.fontWeight = '400';
            h2.style.margin = '0';
            h2.style.padding = '0';

            const a = document.createElement('a');
            a.href = o.url;
            a.target = '_blank';
            a.style.color = '#1a0dab';
            a.style.textDecoration = 'none';
            a.textContent = o.title;

            const tag = createTag('百度认证参考', '百度认证结果仅供参考，不代表绝对安全', {});
            h2.appendChild(a);
            h2.appendChild(tag);

            const urlDiv = document.createElement('div');
            urlDiv.style.color = '#006621';
            urlDiv.style.fontSize = '14px';
            urlDiv.style.margin = '2px 0';
            urlDiv.textContent = o.url;

            const descDiv = document.createElement('div');
            descDiv.style.color = '#545454';
            descDiv.style.fontSize = '12px';
            descDiv.textContent = '来源：百度认证参考；点击前仍需核对域名';

            li.appendChild(h2);
            li.appendChild(urlDiv);
            li.appendChild(descDiv);

            const decision = classifyUrl(o.url);
            decision.matchType = 'exact';
            installNavigationGuard(a, decision, o.url);

            container.prepend(li);
            console.log('[官网补全] 已插入官网（顶部）:', o.title);
        });

        console.log(`[官网补全] 处理完成：标记 ${matchedSet.size} 条结果，插入 ${unmatched.length} 个官网`);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports.__test__ = { normalizeHttpUrl, classifyUrl, getMatchType, getResultDecision, defaultConfig, normalizeConfig, aiProviderPresets, exclusionPresetWords, shouldExcludeKeyword, summarizeEngineEvidence, extractModelIds, hasDownloadIntent, isDownloadUrl, shouldConfirmNavigation, stripDownloadKeywords, looksLikeChallenge, pickCaptchaSource, isVerificationResponse, trustedPlatformFor, applyTrustedPlatformVerdict, xsnIocIndex, xsnLookupHit, xsnIsHigh, xsnHitTitle, applyXsnVerdict, xsnLookupHosts, engineSearchUrls, isEngineHost, extractEmbeddedTarget, resolveAnchorHost, hostFromAttrValue, cardHostFrom, hostFromCardPayload, NON_EVIDENCE_HOSTS, REAL_TARGET_ATTRS, EMBEDDED_TARGET_PARAMS, CARD_HOST_ATTRS, fetchEngineDomains };
        return;
    }

    GM_registerMenuCommand('打开官网标记配置', openConfigPage);

    // ==================== 启动与监听（支持无刷新搜索） ====================

    let lastSearchKey = '';
    let activeSearchId = 0;

    function runScript() {
        const urlParams = new URLSearchParams(window.location.search);
        const keyword = urlParams.get('q');
        if (!keyword) return;
        const searchKey = window.location.href;
        if (searchKey === lastSearchKey) return;
        lastSearchKey = searchKey;
        const searchId = ++activeSearchId;

        // 清除之前可能残留的标记
        window._my_bing_injected = false;

        // 移除之前插入的官方标签（避免重复）
        document.querySelectorAll('[data-bom-tag="true"]').forEach(el => el.remove());
        // 移除之前插入的额外搜索结果项（如果有）
        document.querySelectorAll('li[data-bom-injected="true"]').forEach(el => el.remove());

        console.log('[官网补全] 检测到新搜索:', keyword);
        main(searchId);
    }

    // 监听 URL 变化（包括无刷新搜索）
    let lastUrl = location.href;
    let observerTimer = null;
    const urlObserver = new MutationObserver(() => {
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = setTimeout(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(runScript, 400);
        }
        }, 150);
    });
    urlObserver.observe(document.body, { subtree: true, childList: true });

    // 监听 popstate（前进/后退）
    window.addEventListener('popstate', () => {
        setTimeout(runScript, 400);
    });

    // 监听 pageshow（从 BFCache 恢复）
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) {
            setTimeout(runScript, 400);
        }
    });

    // 初始启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runScript);
    } else {
        runScript();
    }

})();
