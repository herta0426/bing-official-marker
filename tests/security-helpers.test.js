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
