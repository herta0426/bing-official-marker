const assert = require('node:assert/strict');
const test = require('node:test');

const api = require('../baidudreamourbings.user.js').__test__;

test('strictly matches the same HTTPS hostname', () => {
  assert.equal(api.getMatchType('https://Example.com/path', 'https://example.com'), 'exact');
  assert.equal(api.classifyUrl('https://example.com').level, 'trusted');
});

test('requires confirmation for a legitimate subdomain match', () => {
  assert.equal(api.getMatchType('https://login.example.com', 'https://www.example.com'), 'main');
  assert.equal(api.classifyUrl('https://login.example.com').level, 'trusted');
});

test('does not treat public suffix tenants as the same organization', () => {
  assert.equal(api.getMatchType('https://attacker.github.io', 'https://official.github.io'), 'none');
});

test('classifies dangerous navigation targets', () => {
  assert.equal(api.classifyUrl('http://example.com').level, 'high-risk');
  assert.equal(api.classifyUrl('https://192.0.2.10/login').level, 'high-risk');
  assert.equal(api.classifyUrl('https://user:pass@example.com').level, 'high-risk');
  assert.equal(api.classifyUrl('https://example.com:8443').level, 'high-risk');
  assert.equal(api.classifyUrl('https://bit.ly/abc').level, 'high-risk');
});

test('rejects malformed and non-web URLs', () => {
  assert.equal(api.normalizeHttpUrl('javascript:alert(1)'), null);
  assert.equal(api.normalizeHttpUrl('not a url'), null);
});

test('requires confirmation when no Baidu reference matches', () => {
  const decision = api.getResultDecision('https://unknown.example/login', null, 'none');
  assert.equal(decision.label, '未验证');
  assert.equal(decision.requiresConfirmation, true);
});

test('requires confirmation for a high-risk result even without a Baidu match', () => {
  const decision = api.getResultDecision('http://unknown.example/login', null, 'none');
  assert.equal(decision.label, '高风险链接');
  assert.equal(decision.requiresConfirmation, true);
});

test('does not call an HTTP reference an exact trusted match', () => {
  assert.equal(api.getMatchType('https://example.com', 'http://example.com'), 'none');
});

test('ships useful exclusion presets for live and lifestyle searches', () => {
  const config = api.defaultConfig();
  assert.equal(config.exclusions.presets.weather, true);
  assert.equal(config.exclusions.presets.news, true);
  assert.ok(api.exclusionPresetWords().weather.includes('天气'));
  assert.ok(api.exclusionPresetWords().lifestyle.includes('菜谱'));
  assert.ok(api.shouldExcludeKeyword('北京天气', config));
  assert.ok(api.shouldExcludeKeyword('最新新闻', config));
  assert.equal(api.shouldExcludeKeyword('汽水音乐 官网', config), false);
});

test('respects disabled exclusion presets while keeping custom words', () => {
  const config = api.defaultConfig();
  config.exclusions.presets.weather = false;
  config.exclusions.words.push('我的项目');
  assert.equal(api.shouldExcludeKeyword('北京天气', config), false);
  assert.equal(api.shouldExcludeKeyword('我的项目官网', config), true);
});

test('provides safe AI provider presets without an API key', () => {
  const providers = api.aiProviderPresets();
  assert.equal(providers.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(providers.deepseek.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(providers.qwen.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(providers.openai.apiKey, '');
});

test('normalizes imported config and never invents an API key', () => {
  const config = api.normalizeConfig({ version: 2, ai: { enabled: true, provider: 'deepseek' } });
  assert.equal(config.ai.enabled, true);
  assert.equal(config.ai.provider, 'deepseek');
  assert.equal(config.ai.apiKey, '');
  assert.equal(config.engines.baidu, true);
  assert.equal(config.engines.so360, true); // 国内可用中文引擎默认开启
  assert.equal(config.engines.toutiao, true);
  assert.equal(config.engines.quark, false); // 神马/夸克禁用
});

test('版本不符的旧配置自动回落到最新默认', () => {
  const stale = { version: 1, protectionMode: 'download', engines: { baidu: true, so360: false } };
  const config = api.normalizeConfig(stale);
  assert.equal(config.protectionMode, 'mark'); // 回落默认
  assert.equal(config.engines.so360, true); // 新默认生效
  assert.deepStrictEqual(config, api.defaultConfig()); // 与默认完全一致
});

test('summarizes multi-engine evidence without upgrading trust', () => {
  const result = api.summarizeEngineEvidence('https://www.example.com/path', {
    baidu: new Set(['example.com']),
    google: new Set(['example.com']),
    duckduckgo: new Set(['other.example'])
  });
  assert.equal(result.matches, 2);
  assert.equal(result.label, '多引擎参考');
  assert.equal(result.trusted, false);
});

test('normalizes model list responses and always keeps custom option', () => {
  assert.deepEqual(api.extractModelIds({ data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] }), ['gpt-a', 'gpt-b', 'custom']);
  assert.deepEqual(api.extractModelIds({ models: [{ name: 'qwen-plus' }] }), ['qwen-plus', 'custom']);
});

test('detects download intent without flagging ordinary searches', () => {
  const config = api.defaultConfig();
  assert.equal(api.hasDownloadIntent('北京天气', config), false);
  assert.equal(api.hasDownloadIntent('微信 官方下载', config), true);
  assert.equal(api.hasDownloadIntent('download chrome', config), true);
  assert.equal(api.hasDownloadIntent('安装包', config), true);
});

test('detects downloadable result URLs', () => {
  assert.equal(api.isDownloadUrl('https://example.com/download/app.exe', api.defaultConfig()), true);
  assert.equal(api.isDownloadUrl('https://example.com/article/how-to-install', api.defaultConfig()), false);
  assert.equal(api.isDownloadUrl('https://example.com/file.zip', api.defaultConfig()), true);
});

test('默认已禁用下载保护（mark 模式不弹确认）', () => {
  const config = api.defaultConfig();
  assert.equal(config.protectionMode, 'mark');
  assert.equal(api.shouldConfirmNavigation('https://unknown.example/download/app.exe', null, 'none', '普通搜索', config), false);
  assert.equal(api.shouldConfirmNavigation('https://unknown.example/article', null, 'none', '某软件下载', config), false);
});

test('开启下载保护模式后仍会下载链接/意图弹确认', () => {
  const config = api.defaultConfig();
  config.protectionMode = 'download';
  assert.equal(api.shouldConfirmNavigation('https://unknown.example/article', null, 'none', '普通搜索', config), false);
  assert.equal(api.shouldConfirmNavigation('https://unknown.example/download/app.exe', null, 'none', '普通搜索', config), true);
  assert.equal(api.shouldConfirmNavigation('https://unknown.example/article', null, 'none', '某软件下载', config), true);
});

test('去除下载意图词得到参考词（如 "qq 下载" → "qq"）', () => {
  const config = api.defaultConfig();
  assert.equal(api.stripDownloadKeywords('qq 下载', config), 'qq');
  assert.equal(api.stripDownloadKeywords('qq下载', config), 'qq');
  assert.equal(api.stripDownloadKeywords('微信PC版官方安装包', config), '微信 官方');
  assert.equal(api.stripDownloadKeywords('普通新闻', config), '普通新闻');
  assert.equal(api.stripDownloadKeywords('下载', config), '下载'); // 全被删时回退原词
});

test('识别引擎的人机验证挑战页', () => {
  // 360 实测下发的真实挑战地址（http + qcaptcha）
  const so360 = 'http://qcaptcha.so.com/?ret=https%3A%2F%2Fwww.so.com%2Fs%3Fq%3D%25E9%259F%25B3%25E4%25B9%2590%26src%3Dcaptcha&tk=00d15352';
  assert.equal(api.looksLikeChallenge(so360), true);
  assert.equal(api.looksLikeChallenge('https://wappass.baidu.com/static/captcha/tuxing.html'), true);
  assert.equal(api.looksLikeChallenge('https://www.so.com/s?q=%E9%9F%B3%E4%B9%90'), false);
  assert.equal(api.looksLikeChallenge(''), false);
  // 搜狗的挑战页挂在已白名单的 www.sogou.com 上，只能靠路径段 antispider 识别
  const sogou = 'https://www.sogou.com/antispider/?m=1&antip=web_hd&from=%2Fweb%3Fquery%3D11111';
  assert.equal(api.looksLikeChallenge(sogou), true);
  assert.equal(api.looksLikeChallenge('https://www.sogou.com/web?query=11111'), false);
  assert.equal(api.pickCaptchaSource(sogou), sogou);
  // 只取挑战页地址，普通跳转地址一律丢弃（回退到引擎首页）
  assert.equal(api.pickCaptchaSource(so360), so360);
  assert.equal(api.pickCaptchaSource('https://www.so.com/link?m=abc'), '');
  assert.equal(api.pickCaptchaSource(''), '');
});

test('把验证跳转与验证页正文判定为拦截', () => {
  const location360 = 'http://qcaptcha.so.com/?ret=x&tk=y';
  assert.equal(api.isVerificationResponse({ status: 302, responseText: '' }, 'https://www.so.com/s?q=x', location360), true);
  // 3xx 但目标是普通地址 → 不算验证拦截
  assert.equal(api.isVerificationResponse({ status: 302, responseText: '' }, 'https://www.so.com/s?q=x', 'https://m.so.com/s?q=x'), false);
  // 普通 200 搜索结果页 → 放行
  assert.equal(api.isVerificationResponse({ status: 200, responseText: '<html>' + 'x'.repeat(30000) + '</html>' }, 'https://www.so.com/s?q=x', ''), false);
  // 200 但正文是验证页 → 拦截
  assert.equal(api.isVerificationResponse({ status: 200, responseText: '<title>访问异常页面</title>' }, 'https://www.so.com/s?q=x', ''), true);
  // Tampermonkey 忽略 followRedirects:false 跟随后：200 + finalUrl 落在挑战页 → 同样要拦截
  assert.equal(api.isVerificationResponse({ status: 200, responseText: '<html>captcha</html>' }, 'http://qcaptcha.so.com/?ret=x&tk=y', ''), true);
  // 搜狗：跟随后 finalUrl 落在 antispider
  assert.equal(api.isVerificationResponse({ status: 200, responseText: '<html>antispider</html>' }, 'https://www.sogou.com/antispider/?m=1&antip=web_hd', ''), true);
  // 搜狗正常结果页 → 放行
  assert.equal(api.isVerificationResponse({ status: 200, responseText: 'y'.repeat(30000) }, 'https://www.sogou.com/web?query=x', ''), false);
  assert.equal(api.isVerificationResponse({ status: 500, responseText: 'boom' }, 'https://www.so.com/s?q=x', ''), false);
});

test('XSN 情报查询默认关闭，显式开启才生效', () => {
  const config = api.defaultConfig();
  assert.equal(config.xsn.enabled, false);
  const legacy = api.normalizeConfig({ version: 2, enabled: true, exclusions: {}, engines: {}, ai: {} });
  assert.equal(legacy.xsn.enabled, false);
  const optedIn = api.normalizeConfig({ version: 2, enabled: true, exclusions: {}, engines: {}, ai: {}, xsn: { enabled: true } });
  assert.equal(optedIn.xsn.enabled, true);
  // 接口地址固定，不进配置、不可改
  assert.equal('endpoint' in config.xsn, false);
  assert.equal('endpoint' in optedIn.xsn, false);
});

test('XSN 命中把本地判为未验证的结果标红为 XSN 风险', () => {
  const index = api.xsnIocIndex([
    { indicator_type: 'domain', indicator_value: 'huorong-app.hl.cn', severity: 'high', family: 'FakeHuoRong', confidence: 100, hit_count: 9, status: 'confirmed' },
    { indicator_type: 'domain', indicator_value: 'trojan.example', severity: 'critical', family: 'TrojanDownloader', confidence: 100, hit_count: 3, status: 'confirmed' }
  ]);
  const hit = api.xsnLookupHit('huorong-app.hl.cn', index);
  assert.equal(hit.family, 'FakeHuoRong');
  assert.equal(api.xsnIsHigh(hit), true);
  // 情报记在主域、结果落在子域时也要命中（如索引里是 trojan.example、结果是 login.trojan.example）
  assert.equal(api.xsnLookupHit('login.trojan.example', index).family, 'TrojanDownloader');

  // https + 正常端口 + 真域名：本地判「未验证」，命中情报后标红
  const local = api.getResultDecision('https://huorong-app.hl.cn/', null, 'none');
  assert.equal(local.label, '未验证');
  const upgraded = api.applyXsnVerdict(local, hit);
  assert.equal(upgraded.label, 'XSN 风险');
  assert.equal(upgraded.requiresConfirmation, true);
  assert.ok(upgraded.reasons.some(reason => reason.includes('FakeHuoRong')));
  assert.ok(api.xsnHitTitle(hit).includes('FakeHuoRong'));
  // 标签只反映 XSN 的判定，不因为家族是仿冒就改叫别的名字
  assert.equal(api.applyXsnVerdict(api.getResultDecision('https://trojan.example/', null, 'none'), api.xsnLookupHit('trojan.example', index)).label, 'XSN 风险');
});

test('低等级与误报情报不改判定，未命中返回空', () => {
  const index = api.xsnIocIndex([
    { indicator_value: 'low.example', severity: 'low', family: 'CLOUD_THREAT', status: 'confirmed' },
    { indicator_value: 'medium.example', severity: 'medium', family: 'RESTRICT_SUSPECT', status: 'confirmed' },
    { indicator_value: 'fp.example', severity: 'high', family: 'FALSE_POSITIVE', status: 'false_positive' },
    { indicator_value: 'absent.example', found: false }
  ]);
  const base = api.getResultDecision('https://low.example/', null, 'none');
  ['low.example', 'medium.example', 'fp.example'].forEach(host => {
    assert.equal(api.xsnIsHigh(api.xsnLookupHit(host, index)), false, host);
    assert.equal(api.applyXsnVerdict(base, api.xsnLookupHit(host, index)).label, '未验证', host);
  });
  // /v1/ioc 未命中时返回 found:false，不能进索引
  assert.equal(api.xsnLookupHit('absent.example', index), null);
  assert.equal(api.xsnLookupHit('never-seen.example', index), null);
  assert.equal(api.applyXsnVerdict({ label: '官网参考', reasons: [] }, null).label, '官网参考');
});

test('查询成功才缓存：未命中也要负缓存，第二次不再发请求', async () => {
  const store = new Map();
  let requests = 0;
  global.GM_getValue = (key, fallback) => (store.has(key) ? store.get(key) : fallback);
  global.GM_setValue = (key, value) => { store.set(key, value); };
  global.GM_xmlhttpRequest = (options) => {
    requests++;
    options.onload({ status: 200, responseText: JSON.stringify({ found: false, indicator_type: 'domain', indicator_value: 'clean.example' }) });
  };
  try {
    const first = await api.xsnLookupHosts(['clean.example']);
    assert.equal(requests, 1);
    assert.equal(first.get('clean.example'), null);          // 未命中 → null，不改判定
    const cached = JSON.parse(store.get('bom-xsn-ioc-cache'));
    assert.equal(cached.entries.length, 1);                  // 负结果进缓存
    const second = await api.xsnLookupHosts(['clean.example']);
    assert.equal(requests, 1);                               // 命中缓存，不再请求
    assert.equal(second.get('clean.example'), null);
  } finally {
    delete global.GM_getValue;
    delete global.GM_setValue;
    delete global.GM_xmlhttpRequest;
  }
});

test('查询失败时不标记也不缓存（限流不能当成没问题）', async () => {
  const store = new Map();
  global.GM_getValue = (key, fallback) => (store.has(key) ? store.get(key) : fallback);
  global.GM_setValue = (key, value) => { store.set(key, value); };
  global.GM_xmlhttpRequest = (options) => { options.onload({ status: 403, responseText: '{"error":"forbidden"}' }); };
  try {
    const index = await api.xsnLookupHosts(['throttled.example']);
    assert.equal(index.has('throttled.example'), false);     // 不进索引 → 不标红
    assert.equal(store.has('bom-xsn-ioc-cache'), false);     // 更不写负缓存
  } finally {
    delete global.GM_getValue;
    delete global.GM_setValue;
    delete global.GM_xmlhttpRequest;
  }
});

test('可信平台名单按主机名匹配，不放行仿冒域名', () => {
  const config = api.defaultConfig();
  assert.ok(config.trustedPlatforms.includes('github.com'));
  assert.equal(api.trustedPlatformFor('github.com', config), 'github.com');
  assert.equal(api.trustedPlatformFor('gist.github.com', config), 'github.com');   // 子域命中
  assert.equal(api.trustedPlatformFor('GITHUB.COM', config), 'github.com');        // 大小写无关
  assert.equal(api.trustedPlatformFor('github.com.evil.tld', config), null);       // 后缀仿冒不命中
  assert.equal(api.trustedPlatformFor('evilgithub.com', config), null);
  assert.equal(api.trustedPlatformFor('', config), null);
  // 名单可清空 → 功能等于关闭
  const empty = api.normalizeConfig({ version: 2, enabled: true, exclusions: {}, engines: {}, ai: {}, trustedPlatforms: [] });
  assert.deepEqual(empty.trustedPlatforms, []);
  assert.equal(api.trustedPlatformFor('github.com', empty), null);
});

test('可信平台压掉未验证/需确认，但压不掉高危和已验证官网', () => {
  const platform = 'github.com';
  // 普通 https 结果：未验证 → 可信平台
  const trusted = api.applyTrustedPlatformVerdict(api.getResultDecision('https://github.com/user/repo', null, 'none'), platform);
  assert.equal(trusted.label, '可信平台');
  assert.equal(trusted.requiresConfirmation, false);
  assert.equal(trusted.trustedPlatform, platform);
  // 本地高危（http）优先，名单不豁免
  const risky = api.applyTrustedPlatformVerdict(api.getResultDecision('http://github.com/user/repo', null, 'none'), platform);
  assert.equal(risky.label, '高风险链接');
  // 已验证官网保持「官网参考」
  const official = api.applyTrustedPlatformVerdict(api.getResultDecision('https://github.com/', { url: 'https://github.com/', displayDomain: 'github.com' }, 'exact'), platform);
  assert.equal(official.label, '官网参考');
  // 不在名单里就不动
  assert.equal(api.applyTrustedPlatformVerdict(api.getResultDecision('https://unknown.example/', null, 'none'), null).label, '未验证');
});

test('可信平台压掉 XSN 情报标红（名单内不查情报）', () => {
  const index = api.xsnIocIndex([{ indicator_value: 'github.com', severity: 'critical', family: 'CloudDetected', confidence: 100, hit_count: 5, status: 'confirmed' }]);
  const hit = api.xsnLookupHit('github.com', index);
  const trusted = api.applyTrustedPlatformVerdict(api.getResultDecision('https://github.com/user/repo', null, 'none'), 'github.com');
  // main() 里名单内的域名不进 XSN 查询列表，xsnHit 为 null；即使拿到命中，顺序也保证名单先生效
  assert.equal(api.applyXsnVerdict(trusted, hit).label, '可信平台');
  // 未命中名单的域名照旧标红
  assert.equal(api.applyXsnVerdict(api.getResultDecision('https://bad.example/', null, 'none'), api.xsnLookupHit('bad.example', api.xsnIocIndex([{ indicator_value: 'bad.example', severity: 'critical', family: 'CloudDetected', status: 'confirmed' }]))).label, 'XSN 风险');
});

test('每个参考引擎的请求主机都在 @connect 白名单里', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'baidudreamourbings.user.js'), 'utf8');
  const connects = [...source.matchAll(/^\/\/ @connect\s+(\S+)/gm)].map(match => match[1].toLowerCase());
  assert.ok(connects.length > 0);
  const urls = api.engineSearchUrls('测试');
  assert.deepEqual(Object.keys(urls).sort(), ['duckduckgo', 'google', 'quark', 'so360', 'sogou', 'toutiao']);
  Object.entries(urls).forEach(([engine, url]) => {
    const host = new URL(url).hostname.toLowerCase();
    const covered = connects.some(entry => host === entry || host.endsWith('.' + entry));
    assert.ok(covered, `${engine} 的 ${host} 不在 @connect 里`);
  });
});

test('头条搜索用的是存活主机 so.toutiao.com', () => {
  // 老代码写成 www.so.toutiao.com，该主机已不存在（DNS 解析失败）→ 头条参考会静默拿不到数据
  assert.equal(new URL(api.engineSearchUrls('抖音').toutiao).hostname, 'so.toutiao.com');
});

test('结果链接解析全程零请求：直链取主机名，壳链接放弃而不是去请求', () => {
  const anchor = href => ({ getAttribute: name => (name === 'href' ? href : null) });
  const before = typeof global.GM_xmlhttpRequest;
  let requested = 0;
  global.GM_xmlhttpRequest = () => { requested++; };
  try {
    const sogouBase = 'https://www.sogou.com/web?query=x';
    const so360Base = 'https://www.so.com/s?q=x';
    // 直链：直接取主机名
    assert.equal(api.resolveAnchorHost(anchor('https://www.douyin.com/'), sogouBase), 'www.douyin.com');
    // 搜狗的壳是加密串（解不出合法 URL）→ 放弃，不发请求
    assert.equal(api.resolveAnchorHost(anchor('/link?url=hedJjaC291M7QghXzFlc6DtGMBTLg3lG'), sogouBase), '');
    // 引擎自家功能入口 → 放弃
    assert.equal(api.resolveAnchorHost(anchor('https://ai.so.com/search/?src=so_result_aitab'), so360Base), '');
    assert.equal(api.resolveAnchorHost(anchor('https://fankui.sogou.com/feedback'), sogouBase), '');
    // 协议不符 → 放弃
    assert.equal(api.resolveAnchorHost(anchor('javascript:void(0)'), so360Base), '');
    assert.equal(requested, 0);
  } finally {
    if (before === 'undefined') delete global.GM_xmlhttpRequest; else global.GM_xmlhttpRequest = before;
  }
});

test('壳里编码了明文目标时直接解码（头条 /search/jump → zlink → h5_url 两层，零请求）', () => {
  const anchor = href => ({ getAttribute: name => (name === 'href' ? href : null) });
  const toutiaoBase = 'https://so.toutiao.com/search?keyword=x';
  // 复刻线上结构：/search/jump?…&url=<编码的 zlink，其 h5_url 再编码一层>
  const zlinkHref = target => '/search/jump?aid=1455&jtoken=b20ce05f&url=' + encodeURIComponent(
    'https://article.zlink.toutiao.com/J4dQM?alert=0&article.zlink=1&h5_url=' + encodeURIComponent(target)
  );
  assert.equal(api.resolveAnchorHost(anchor(zlinkHref('https://m.wandoujia.com/apps/7461948?utm_source=wap')), toutiaoBase), 'm.wandoujia.com');
  assert.equal(api.resolveAnchorHost(anchor(zlinkHref('https://www.bilibili.com/video/BV1RUq8YGEH2/')), toutiaoBase), 'www.bilibili.com');
  // 解出来还是头条自己的文章页 → 不算证据
  assert.equal(api.resolveAnchorHost(anchor(zlinkHref('http://m.toutiao.com/group/7156182498602009124/')), toutiaoBase), '');
});

test('Google /url?q= 与 DuckDuckGo /l/?uddg= 也能直接解码', () => {
  const anchor = href => ({ getAttribute: name => (name === 'href' ? href : null) });
  assert.equal(api.resolveAnchorHost(anchor('/url?q=https://www.douyin.com/&sa=U'), 'https://www.google.com/search?q=x'), 'www.douyin.com');
  assert.equal(api.resolveAnchorHost(anchor('//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.douyin.com%2F&rut=x'), 'https://html.duckduckgo.com/html/?q=x'), 'www.douyin.com');
});

test('结果 <a> 带真实目标属性时直接读属性，零请求（360 的 data-mdurl / e-landurl）', async () => {
  const makeAnchor = (href, attrs) => ({
    getAttribute: (name) => (name === 'href' ? href : (attrs && attrs[name]) || null)
  });
  const before = typeof global.GM_xmlhttpRequest;
  let requested = 0;
  global.GM_xmlhttpRequest = () => { requested++; };
  try {
    // 360 形态：href 是 /link?m= 壳，真实目标挂在属性上
    assert.equal(await api.resolveAnchorHost(makeAnchor('https://www.so.com/link?m=abc', { 'data-mdurl': 'https://www.douyin.com/' }), 'https://www.so.com/s?q=x'), 'www.douyin.com');
    assert.equal(await api.resolveAnchorHost(makeAnchor('https://www.so.com/link?m=abc', { 'e-landurl': 'http://bilibili.com/video' }), 'https://www.so.com/s?q=x'), 'bilibili.com');
    // 相对属性值也要能解析
    assert.equal(await api.resolveAnchorHost(makeAnchor('', { 'data-mdurl': '//www.douyin.com/' }), 'https://www.so.com/s?q=x'), 'www.douyin.com');
    // 属性值是垃圾/非 http 协议 → 不当证据
    assert.equal(await api.resolveAnchorHost(makeAnchor('javascript:void(0)', { 'data-mdurl': 'about:blank' }), 'https://www.so.com/s?q=x'), '');
    assert.equal(requested, 0);            // 全程没有发过请求
    // 没有属性时退回原逻辑：非壳直链直接取主机名（同样不需要请求）
    assert.equal(await api.resolveAnchorHost(makeAnchor('https://www.douyin.com/', null), 'https://www.so.com/s?q=x'), 'www.douyin.com');
    assert.equal(requested, 0);
  } finally {
    if (before === 'undefined') delete global.GM_xmlhttpRequest; else global.GM_xmlhttpRequest = before;
  }
});

test('抓取循环优先用属性解析，不因壳链接发起跳转请求', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'baidudreamourbings.user.js'), 'utf8');
  assert.ok(source.includes('a[href], a[data-mdurl], a[e-landurl]'), '选择器要覆盖只有属性的结果项');
  assert.ok(api.REAL_TARGET_ATTRS.includes('data-mdurl'));
  assert.ok(api.REAL_TARGET_ATTRS.includes('e-landurl'));
});
