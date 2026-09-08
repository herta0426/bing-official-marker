// ==UserScript==
// @name         BaiduDreamourBings
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  通过提取百度结果页获取官网 URL
// @author       herta0426
// @match        https://*.bing.com/search?*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    const BAIDU_SEARCH_URL = 'https://www.baidu.com/s?wd=';
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

    function fetchBaiduOfficialLinks(keyword) {
        return new Promise((resolve) => {
            const url = BAIDU_SEARCH_URL + encodeURIComponent(keyword);
            console.log('[官网补全] 请求百度：', url);

            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: {
                    'User-Agent': navigator.userAgent,
                    'Cookie': document.cookie
                },
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
                                realUrl = decodeURIComponent(realUrl);
                                if (isBlockedUrl(realUrl)) {
                                    console.warn('[官网补全] 过滤虚假链接:', realUrl);
                                    return;
                                }
                                const domain = new URL(realUrl).hostname;
                                if (domain) {
                                    const titleEl = item.querySelector('h3 a, .t a');
                                    const title = titleEl ? titleEl.textContent.trim() : '官网';
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
                    resolve(officialList);
                },
                onerror: function(err) {
                    console.warn('[官网补全] 请求百度失败', err);
                    resolve([]);
                }
            });
        });
    }

    // 提取主域名（忽略子域前缀）
    function getMainDomain(hostname) {
        const parts = hostname.split('.');
        if (parts.length < 2) return hostname;
        const multiTlds = ['com.cn', 'net.cn', 'org.cn', 'co.uk', 'com.hk', 'com.sg', 'co.jp', 'gov.cn'];
        const lastThree = parts.slice(-3).join('.');
        const lastTwo = parts.slice(-2).join('.');
        if (multiTlds.includes(lastThree)) {
            return lastThree;
        } else {
            return lastTwo;
        }
    }

    /**
     * 比较两个 URL 的域名匹配程度
     * @returns {string} 'exact' - 完全相同, 'main' - 主域相同但子域不同, 'none' - 不匹配
     */
    function getMatchType(url1, url2) {
        try {
            const host1 = new URL(url1).hostname;
            const host2 = new URL(url2).hostname;
            if (host1 === host2) return 'exact';
            const main1 = getMainDomain(host1);
            const main2 = getMainDomain(host2);
            if (main1 === main2) return 'main';
            return 'none';
        } catch {
            return 'none';
        }
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
        tag.setAttribute('data-official', 'true');
        return tag;
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
    async function main() {
        console.log('[官网补全] 脚本开始运行');

        const urlParams = new URLSearchParams(window.location.search);
        const keyword = urlParams.get('q');
        if (!keyword) {
            console.log('[官网补全] 未找到搜索关键词');
            return;
        }

        const officialLinks = await fetchBaiduOfficialLinks(keyword);
        if (officialLinks.length === 0) {
            console.log('[官网补全] 未找到有效官网');
            return;
        }

        const container = await waitForContainer(30000);
        if (!container) {
            console.warn('[官网补全] 超时未找到搜索结果容器，放弃插入');
            return;
        }

        const bingItems = container.querySelectorAll(SELECTOR_BING_ITEM);
        const matchedSet = new Set();

        bingItems.forEach((item) => {
            const link = item.querySelector('a');
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
            if (matched) {
                const titleContainer = item.querySelector('h2, .b_title, .b_algoheader');
                if (titleContainer) {
                    // 移除旧的官方标签
                    const oldTags = titleContainer.querySelectorAll('span[data-official="true"]');
                    oldTags.forEach(el => el.remove());

                    let label = '官网';
                    let title = '百度认证官网';
                    let extraStyle = {};
                    if (matchType === 'exact') {
                        label = '官网';
                        title = '此网站与百度认证官网完全一致';
                    } else if (matchType === 'main') {
                        label = '疑似官网';
                        title = '百度认证主域与此相同，但子域名不同（认证: ' + matched.displayDomain + '）';
                        extraStyle = { backgroundColor: '#FF8C00' };
                    }
                    const tag = createTag(label, title, extraStyle);
                    titleContainer.appendChild(tag);
                }
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
            li.setAttribute('data-injected', 'true');   // 标记插入项，便于清理
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

            const tag = createTag('官网', '百度认证官网', {});
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
            descDiv.textContent = '来源：百度认证官网';

            li.appendChild(h2);
            li.appendChild(urlDiv);
            li.appendChild(descDiv);

            container.prepend(li);
            console.log('[官网补全] 已插入官网（顶部）:', o.title);
        });

        console.log('[官网补全] 处理完成');
    }

    // ==================== 启动与监听（支持无刷新搜索） ====================

    let lastKeyword = '';

    function runScript() {
        const urlParams = new URLSearchParams(window.location.search);
        const keyword = urlParams.get('q');
        if (!keyword) return;
        if (keyword === lastKeyword) return;
        lastKeyword = keyword;

        // 清除之前可能残留的标记
        window._my_bing_injected = false;

        // 移除之前插入的官方标签（避免重复）
        document.querySelectorAll('span[data-official="true"]').forEach(el => el.remove());
        // 移除之前插入的额外搜索结果项（如果有）
        document.querySelectorAll('li.b_algo[data-injected="true"]').forEach(el => el.remove());

        console.log('[官网补全] 检测到新搜索:', keyword);
        main();
    }

    // 监听 URL 变化（包括无刷新搜索）
    let lastUrl = location.href;
    const urlObserver = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(runScript, 400);
        }
    });
    urlObserver.observe(document, { subtree: true, childList: true });

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