// ==UserScript==
// @name         BaiduDreamourBings
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  通过提取百度结果页获取官网 URL
// @author       herta0426
// @match        https://*.bing.com/search?*
// @grant        GM_xmlhttpRequest
// @connect      www.baidu.com
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

        const urlParams = new URLSearchParams(window.location.search);
        const keyword = urlParams.get('q');
        if (!keyword) {
            console.log('[官网补全] 未找到搜索关键词');
            return;
        }

        const officialLinks = await fetchBaiduOfficialLinks(keyword);
        if (searchId !== activeSearchId) return;

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
                titleContainer.appendChild(createTag(decision.label, title, extraStyle));
            }
            installNavigationGuard(link, getResultDecision(link.href, matched, matchType), matched && matched.url);
            item.querySelectorAll('a[href]').forEach((anchor) => {
                if (anchor === link) return;
                const decision = getResultDecision(anchor.href, null, 'none');
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
        module.exports.__test__ = { normalizeHttpUrl, classifyUrl, getMatchType, getResultDecision };
        return;
    }

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
