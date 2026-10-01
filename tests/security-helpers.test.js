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
