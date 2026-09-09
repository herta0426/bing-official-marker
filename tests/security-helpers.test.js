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
  const config = api.normalizeConfig({ ai: { enabled: true, provider: 'deepseek' } });
  assert.equal(config.ai.enabled, true);
  assert.equal(config.ai.provider, 'deepseek');
  assert.equal(config.ai.apiKey, '');
  assert.equal(config.engines.baidu, true);
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
