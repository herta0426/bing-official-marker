// ==UserScript==
// @name         BaiduDreamourBings
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  通过提取百度结果页获取官网 URL
// @author       herta0426
// @match        https://*.bing.com/search?*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      www.baidu.com
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      dashscope.aliyuncs.com
// @connect      www.google.com
// @connect      html.duckduckgo.com
// @connect      www.sogou.com
// @connect      www.so.com
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

    function defaultConfig() {
        return {
            version: 1,
            enabled: true,
            unknownConfirmation: true,
            riskBlocking: true,
            cacheMinutes: 10,
            protectionMode: 'download',
            downloadKeywords: [...DEFAULT_DOWNLOAD_KEYWORDS],
            downloadExtensions: [...DEFAULT_DOWNLOAD_EXTENSIONS],
            alwaysBlockRisk: true,
            exclusions: { enabled: true, presets: { weather: true, news: true, lifestyle: true, entertainment: false, realtime: true }, words: [] },
            engines: { baidu: true, google: false, duckduckgo: false, sogou: false, so360: false },
            ai: { enabled: false, provider: 'openai', baseUrl: AI_PROVIDERS.openai.baseUrl, model: AI_PROVIDERS.openai.model, apiKey: '' }
        };
    }

    function normalizeConfig(input) {
        const base = defaultConfig();
        const value = input && typeof input === 'object' ? input : {};
        const ai = value.ai && typeof value.ai === 'object' ? value.ai : {};
        const provider = AI_PROVIDERS[ai.provider] ? ai.provider : base.ai.provider;
        return {
            ...base,
            ...value,
            exclusions: { ...base.exclusions, ...(value.exclusions || {}), presets: { ...base.exclusions.presets, ...((value.exclusions || {}).presets || {}) }, words: Array.isArray((value.exclusions || {}).words) ? [...new Set(value.exclusions.words.filter(word => typeof word === 'string' && word.trim()))] : base.exclusions.words },
            engines: { ...base.engines, ...(value.engines || {}) },
            ai: { ...base.ai, ...ai, provider, apiKey: typeof ai.apiKey === 'string' ? ai.apiKey : '' }
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

    function fetchEngineDomains(keyword, engine) {
        const urls = { google: `https://www.google.com/search?q=${encodeURIComponent(keyword)}`, duckduckgo: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}`, sogou: `https://www.sogou.com/web?query=${encodeURIComponent(keyword)}`, so360: `https://www.so.com/s?q=${encodeURIComponent(keyword)}` };
        if (!urls[engine]) return Promise.resolve(new Set());
        return new Promise(resolve => GM_xmlhttpRequest({ method: 'GET', url: urls[engine], anonymous: true, timeout: 10000, onload: response => { if (response.status !== 200) return resolve(new Set()); const domains = new Set(); const parser = new DOMParser(); const doc = parser.parseFromString(response.responseText, 'text/html'); doc.querySelectorAll('a[href]').forEach(anchor => { const parsed = normalizeHttpUrl(anchor.href); if (parsed && parsed.protocol === 'https:') domains.add(parsed.hostname); }); resolve(domains); }, onerror: () => resolve(new Set()), ontimeout: () => resolve(new Set()) }));
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
          <section><h2>搜索行为</h2><label><input type="checkbox" data-bom-enabled> 启用官网标记</label><label>保护模式 <select data-bom-mode><option value="download">下载保护（推荐）</option><option value="strict">严格保护</option><option value="mark">仅标记</option></select></label><label><input type="checkbox" data-bom-risk> 高风险链接始终拦截</label><label>缓存时间 <input type="number" min="0" max="1440" data-bom-cache> 分钟</label><label>下载意图关键词（每行一个）<textarea rows="4" data-bom-download-words></textarea></label><label>下载扩展名（每行一个）<textarea rows="2" data-bom-download-exts></textarea></label></section>
          <section><h2>排除词</h2><p class="bom-note">命中排除词时不请求百度、不调用 AI，也不修改 Bing 结果。</p><div class="bom-presets"><label><input type="checkbox" data-bom-preset="weather"> 天气</label><label><input type="checkbox" data-bom-preset="news"> 新闻</label><label><input type="checkbox" data-bom-preset="lifestyle"> 生活</label><label><input type="checkbox" data-bom-preset="entertainment"> 娱乐</label><label><input type="checkbox" data-bom-preset="realtime"> 实时信息</label></div><label>自定义排除词（每行一个）<textarea rows="4" data-bom-words></textarea></label></section>
          <section><h2>多引擎参考</h2><div class="bom-presets"><label><input type="checkbox" data-bom-engine="baidu"> 百度认证</label><label><input type="checkbox" data-bom-engine="google"> Google</label><label><input type="checkbox" data-bom-engine="duckduckgo"> DuckDuckGo</label><label><input type="checkbox" data-bom-engine="sogou"> 搜狗</label><label><input type="checkbox" data-bom-engine="so360"> 360 搜索</label></div><p class="bom-note">当前版本保存引擎偏好；跨站抓取需各引擎允许访问，默认只启用百度。</p></section>
          <section><h2>AI 辅助比对</h2><label><input type="checkbox" data-bom-ai-enabled> 启用 AI 辅助分析</label><label>服务商 <select data-bom-ai-provider><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="qwen">通义千问</option><option value="custom">自定义 OpenAI 兼容接口</option></select></label><label>接口地址 <input type="url" data-bom-ai-url placeholder="https://api.example.com/v1"></label><label>API Key <input type="password" data-bom-ai-key autocomplete="off" placeholder="只保存在浏览器扩展存储"></label><label>模型 <select data-bom-ai-model-select data-bom-model-select><option value="custom">自定义</option></select></label><button type="button" data-bom-fetch-models>获取模型列表</button><label data-bom-custom-model hidden>自定义模型 <input type="text" data-bom-ai-model-custom placeholder="输入模型名称"></label><p class="bom-model-status" data-bom-model-status></p><p class="bom-note">只发送搜索词、标题、域名和 URL，不发送网页正文。AI 不能解除本地高风险拦截。</p></section>
          <div class="bom-actions"><button type="button" data-bom-reset>恢复默认</button><button type="button" data-bom-cancel>取消</button><button type="button" data-bom-save>保存配置</button></div><div class="bom-status" role="status" data-bom-status></div>
        </div>`;
        GM_addStyle(`
          #bom-config-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.58);display:flex;align-items:center;justify-content:center;padding:20px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033}
          .bom-config{width:min(720px,100%);max-height:min(850px,calc(100vh - 40px));overflow:auto;background:#fff;border:1px solid #d7dde8;border-radius:10px;box-shadow:0 20px 60px rgba(15,23,42,.28);padding:24px}
          .bom-config-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.bom-kicker{font-size:11px;letter-spacing:1.5px;color:#64748b;font-weight:700}.bom-config h1{font-size:25px;line-height:1.2;margin:4px 0 0}.bom-config h2{font-size:15px;margin:0 0 12px}.bom-config section{border-top:1px solid #e5e7eb;padding:18px 0}.bom-config label{display:block;margin:9px 0}.bom-config input[type=checkbox]{margin-right:8px}.bom-config input[type=text],.bom-config input[type=url],.bom-config input[type=password],.bom-config input[type=number],.bom-config select,.bom-config textarea{display:block;width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:9px;margin-top:5px;font:inherit}.bom-config textarea{resize:vertical}.bom-presets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 20px}.bom-presets label{margin:4px 0}.bom-note{color:#526176;font-size:13px;margin:7px 0}.bom-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:10px}.bom-actions button,.bom-config-head button{border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:9px 14px;cursor:pointer;font:inherit}.bom-actions [data-bom-save]{background:#2563eb;border-color:#2563eb;color:#fff}.bom-config-head button{font-size:22px;line-height:1;padding:4px 10px}.bom-status{min-height:20px;color:#166534;text-align:right;margin-top:8px}@media(max-width:600px){#bom-config-overlay{padding:0}.bom-config{max-height:100vh;border-radius:0;padding:18px}.bom-presets{grid-template-columns:1fr}}
        `);
        document.body.appendChild(overlay);
        const $ = selector => overlay.querySelector(selector);
        const fill = current => {
            $('[data-bom-enabled]').checked = current.enabled;
            $('[data-bom-risk]').checked = current.alwaysBlockRisk !== false;
            $('[data-bom-cache]').value = current.cacheMinutes ?? 10;
            $('[data-bom-mode]').value = current.protectionMode || 'download';
            $('[data-bom-download-words]').value = (current.downloadKeywords || DEFAULT_DOWNLOAD_KEYWORDS).join('\n');
            $('[data-bom-download-exts]').value = (current.downloadExtensions || DEFAULT_DOWNLOAD_EXTENSIONS).join('\n');
            $('[data-bom-words]').value = current.exclusions.words.join('\n');
            overlay.querySelectorAll('[data-bom-preset]').forEach(el => el.checked = current.exclusions.presets[el.dataset.bomPreset] !== false);
            overlay.querySelectorAll('[data-bom-engine]').forEach(el => el.checked = current.engines[el.dataset.bomEngine] === true);
            $('[data-bom-ai-enabled]').checked = current.ai.enabled;
            $('[data-bom-ai-provider]').value = current.ai.provider;
            $('[data-bom-ai-url]').value = current.ai.baseUrl;
            $('[data-bom-ai-model-select]').value = 'custom';
            $('[data-bom-ai-model-custom]').value = current.ai.model;
            $('[data-bom-custom-model]').hidden = true;
            $('[data-bom-ai-key]').value = current.ai.apiKey;
        };
        fill(config);
        const close = () => overlay.remove();
        overlay.querySelectorAll('[data-bom-close],[data-bom-cancel]').forEach(el => el.addEventListener('click', close));
        $('[data-bom-ai-provider]').addEventListener('change', event => { const preset = AI_PROVIDERS[event.target.value]; if (preset) { $('[data-bom-ai-url]').value = preset.baseUrl; $('[data-bom-ai-model-select]').value = 'custom'; $('[data-bom-ai-model-custom]').value = preset.model; $('[data-bom-custom-model]').hidden = false; } });
        $('[data-bom-ai-model-select]').addEventListener('change', event => { $('[data-bom-custom-model]').hidden = event.target.value !== 'custom'; });
        $('[data-bom-fetch-models]').addEventListener('click', async () => { const status = $('[data-bom-model-status]'); status.textContent = '正在获取模型列表...'; try { const models = await fetchModelIds({ ai: { apiKey: $('[data-bom-ai-key]').value, baseUrl: $('[data-bom-ai-url]').value } }); const select = $('[data-bom-ai-model-select]'); select.replaceChildren(); models.forEach(model => { const option = document.createElement('option'); option.value = model; option.textContent = model; select.appendChild(option); }); select.value = 'custom'; $('[data-bom-custom-model]').hidden = false; status.textContent = `已获取 ${models.length - 1} 个模型`; } catch (error) { status.textContent = error.message; } });
        $('[data-bom-reset]').addEventListener('click', () => fill(defaultConfig()));
        $('[data-bom-save]').addEventListener('click', () => {
            const next = normalizeConfig({
                enabled: $('[data-bom-enabled]').checked, protectionMode: $('[data-bom-mode]').value, alwaysBlockRisk: $('[data-bom-risk]').checked,
                cacheMinutes: Math.max(0, Math.min(1440, Number($('[data-bom-cache]').value) || 10)),
                downloadKeywords: $('[data-bom-download-words]').value.split(/\r?\n|[,，]/).map(word => word.trim()).filter(Boolean),
                downloadExtensions: $('[data-bom-download-exts]').value.split(/\r?\n|[,，]/).map(word => word.trim()).filter(Boolean),
                exclusions: { enabled: true, presets: Object.fromEntries([...overlay.querySelectorAll('[data-bom-preset]')].map(el => [el.dataset.bomPreset, el.checked])), words: $('[data-bom-words]').value.split(/\r?\n|[,，]/).map(word => word.trim()).filter(Boolean) },
                engines: Object.fromEntries([...overlay.querySelectorAll('[data-bom-engine]')].map(el => [el.dataset.bomEngine, el.checked])),
                ai: { enabled: $('[data-bom-ai-enabled]').checked, provider: $('[data-bom-ai-provider]').value, baseUrl: $('[data-bom-ai-url]').value.trim(), model: $('[data-bom-ai-model-select]').value === 'custom' ? $('[data-bom-ai-model-custom]').value.trim() : $('[data-bom-ai-model-select]').value, apiKey: $('[data-bom-ai-key]').value }
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
                resolve(cached);
                return;
            }
            const url = BAIDU_SEARCH_URL + encodeURIComponent(keyword);
            console.log('[官网补全] 请求百度：', url);

            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                anonymous: true,
                timeout: 10000,
                onload: function(response) {
                    if (response.status !== 200 || response.responseText.length < 5000) {
                        console.warn('[官网补全] 百度返回异常或过短');
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

        const officialLinks = config.engines.baidu ? await fetchBaiduOfficialLinks(keyword) : [];
        if (searchId !== activeSearchId) return;

        const engineEntries = Object.entries(config.engines).filter(([engine, enabled]) => enabled && engine !== 'baidu');
        const engineResults = await Promise.all(engineEntries.map(async ([engine]) => [engine, await fetchEngineDomains(keyword, engine)]));
        const engineEvidence = Object.fromEntries(engineResults);
        if (config.engines.baidu) engineEvidence.baidu = new Set(officialLinks.map(item => item.displayDomain));

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
            const titleContainer = item.querySelector('h2, .b_title, .b_algoheader');
            if (titleContainer) {
                const oldTags = titleContainer.querySelectorAll('span[data-bom-tag="true"]');
                oldTags.forEach(el => el.remove());

                const decision = getResultDecision(link.href, matched, matchType);
                const title = decision.label === '未验证'
                    ? '未找到对应的百度认证官网，请在打开前核对域名'
                    : decision.label === '高风险链接' ? decision.reasons.join('、')
                    : decision.label === '官网参考' ? 'HTTPS 主机名与百度认证结果一致，但不代表页面绝对安全'
                    : '主域相同但主机名不同（认证: ' + matched.displayDomain + '）';
                const extraStyle = decision.label === '高风险链接' ? { backgroundColor: '#b91c1c' }
                    : decision.label === '需确认' ? { backgroundColor: '#FF8C00' }
                    : decision.label === '未验证' ? { backgroundColor: '#6b7280' } : {};
                const evidence = summarizeEngineEvidence(link.href, engineEvidence);
                const evidenceTitle = evidence.matches > 1 ? `${title}；${evidence.label}（${evidence.matches} 个引擎）` : title;
                titleContainer.appendChild(createTag(decision.label, evidenceTitle, extraStyle));
            }
            const decision = getResultDecision(link.href, matched, matchType);
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
            console.log('[官网补全] 所有官网已匹配');
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

        console.log('[官网补全] 处理完成');
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports.__test__ = { normalizeHttpUrl, classifyUrl, getMatchType, getResultDecision, defaultConfig, normalizeConfig, aiProviderPresets, exclusionPresetWords, shouldExcludeKeyword, summarizeEngineEvidence, extractModelIds, hasDownloadIntent, isDownloadUrl, shouldConfirmNavigation };
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
