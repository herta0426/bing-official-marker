// 用真实抓回来的结果页片段做回归：引擎改版会先在这里红，而不是在用户控制台里静默失效。
//   toutiao-qqmusic-card.html          so.toutiao.com 服务端直出（未登录，壳为单层 url=）
//   toutiao-qqmusic-official-card.html so.toutiao.com 登录态渲染（壳多包一层，卡片带 data-log-extra）
//   so360m-qqmusic-card.html           m.so.com 移动端结果（data-pcurl 明文 + /jump?u= 壳）
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const api = require('../baidudreamourbings.user.js').__test__;

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* 没装 jsdom 时跳过依赖真实 DOM 的用例 */ }

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// 把抓回来的页面喂给 fetchEngineDomains，并顺带截获它发出的请求参数
function fetchWith(html, engine, keyword = 'QQ音乐') {
  const previousRequest = global.GM_xmlhttpRequest;
  const previousParser = global.DOMParser;
  let captured = null;
  global.DOMParser = new JSDOM('<!doctype html><html><body></body></html>').window.DOMParser;
  global.GM_xmlhttpRequest = (options) => {
    captured = options;
    options.onload({ status: 200, responseText: html, finalUrl: options.url, headers: '' });
  };
  return Promise.resolve()
    .then(() => api.fetchEngineDomains(keyword, engine))
    .then(hosts => ({ hosts, options: captured }))
    .finally(() => {
      if (previousRequest === undefined) delete global.GM_xmlhttpRequest;
      else global.GM_xmlhttpRequest = previousRequest;
      if (previousParser === undefined) delete global.DOMParser;
      else global.DOMParser = previousParser;
    });
}

const domTest = JSDOM ? test : test.skip;

domTest('头条登录态卡片：壳多包一层时靠 data-log-extra 的 host 拿到官网域名', async () => {
  const { hosts } = await fetchWith(fixture('toutiao-qqmusic-official-card.html'), 'toutiao');
  assert.ok(hosts.has('y.qq.com'), [...hosts].join(','));
});

domTest('头条服务端直出页：/search/jump?url= 单层壳也能解出域名', async () => {
  const { hosts } = await fetchWith(fixture('toutiao-qqmusic-card.html'), 'toutiao');
  assert.ok([...hosts].some(host => host.endsWith('y.qq.com')), [...hosts].join(','));
});

domTest('头条卡片里引擎自己的域名不算证据', async () => {
  const { hosts } = await fetchWith(fixture('toutiao-qqmusic-card.html'), 'toutiao');
  [...hosts].forEach(host => assert.ok(!api.isEngineHost(host), host));
});

domTest('360 移动端：data-pcurl 明文真实地址直接成为证据', async () => {
  const { hosts } = await fetchWith(fixture('so360m-qqmusic-card.html'), 'so360');
  assert.ok(hosts.has('y.qq.com'), [...hosts].join(','));
});

domTest('360 走移动端入口，且不带会话 cookie（避免把 PC 的验证态带过去）', async () => {
  const { options } = await fetchWith(fixture('so360m-qqmusic-card.html'), 'so360');
  assert.equal(new URL(options.url).hostname, 'm.so.com');
  assert.equal(options.anonymous, true); // 移动端服务端直出，匿名即可拿到结果
});

test('360 搜索入口是移动端 m.so.com，且已在 @connect 白名单里', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'baidudreamourbings.user.js'), 'utf8');
  const connects = [...source.matchAll(/^\/\/ @connect\s+(\S+)/gm)].map(match => match[1].toLowerCase());
  const host = new URL(api.engineSearchUrls('QQ音乐').so360).hostname;
  assert.equal(host, 'm.so.com');
  assert.ok(connects.includes('m.so.com'), 'm.so.com 不在 @connect 里，TM 会直接拒绝请求');
});

test('360 自家内容平台不算证据（百科/快资讯/影视等）', () => {
  ['baike.so.com', 'm.baike.so.com', 'news.so.com', '360kuai.com', '360kan.com', 'info.so.com']
    .forEach(host => assert.ok(api.NON_EVIDENCE_HOSTS.some(item => host === item || host.endsWith('.' + item)), host));
});

test('头条双层嵌套壳递归解码到真实域名（登录态结构）', () => {
  const anchor = href => ({ getAttribute: name => (name === 'href' ? href : null) });
  const base = 'https://so.toutiao.com/search?keyword=x';
  // sou.toutiao.com 不在 @connect 里，靠跟跳转必被拦 → 只能纯解码
  const nested = 'https://sou.toutiao.com/search/jump?url=' + encodeURIComponent(
    'https://sou.toutiao.com/search/jump?url=' + encodeURIComponent('http://y.qq.com/') + '&aid=4916&jtoken='
  ) + '&aid=4916&jtoken=';
  assert.equal(api.extractEmbeddedTarget(nested, base, 0), 'y.qq.com');
  assert.equal(api.resolveAnchorHost(anchor(nested), base), 'y.qq.com');
});

test('属性值是引擎跳转壳时继续解一层（360 的 data-url = m.so.com/jump?u=…）', () => {
  const base = 'https://m.so.com/s?q=x';
  assert.equal(api.hostFromAttrValue('https://m.so.com/jump?u=https%3A%2F%2Fy.qq.com%2Fm%2F&m=4a0091&from=m.so.com', base), 'y.qq.com');
  // 明文直链属性照旧直接取
  assert.equal(api.hostFromAttrValue('https://y.qq.com/', base), 'y.qq.com');
  // 引擎自家入口 → 放弃
  assert.equal(api.hostFromAttrValue('https://ai.so.com/search/?src=so_result_aitab', base), '');
  // 非 http 协议 → 放弃
  assert.equal(api.hostFromAttrValue('javascript:void(0)', base), '');
});

test('卡片元数据直读：host 缺失/引擎自己/非法值都返回空', () => {
  assert.equal(api.hostFromCardPayload('{"host":"y.qq.com","url":"http://y.qq.com/"}'), 'y.qq.com');
  assert.equal(api.hostFromCardPayload('{"host":"so.toutiao.com"}'), '');      // 引擎自己
  assert.equal(api.hostFromCardPayload('{"host":"ai.so.com"}'), '');            // 非证据主机
  assert.equal(api.hostFromCardPayload('{"query":"QQ音乐"}'), '');              // 没有 host
  assert.equal(api.hostFromCardPayload('not json'), '');
  assert.equal(api.hostFromCardPayload(''), '');
  assert.equal(api.hostFromCardPayload(null), '');
});
