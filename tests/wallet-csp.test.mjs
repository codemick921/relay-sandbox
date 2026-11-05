import test from 'node:test';
import {pkgFile} from './fixtures/pkg.mjs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {CIRCLE_WEB_SDK_FRAME_ORIGINS, BASE_POLICY, contentSecurityPolicy, exactHttpsOrigin} from '../hosted/wallet-csp.mjs';
import {prod, PW} from './fixtures/prod-server.mjs';

// The policy Eupova served at the base commit 4fd9dc9, byte for byte.
const POLICY_AT_BASE = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const directives = csp => Object.fromEntries(csp.split(';').map(x => x.trim()).filter(Boolean).map(x => { const [k, ...v] = x.split(/\s+/); return [k, v]; }));

test('the base policy is unchanged and the wallet adds exactly one frame origin, with no wildcard anywhere', () => {
  assert.equal(BASE_POLICY, POLICY_AT_BASE);
  assert.equal(contentSecurityPolicy(), POLICY_AT_BASE);
  assert.deepEqual([...CIRCLE_WEB_SDK_FRAME_ORIGINS], ['https://pw-auth.circle.com']);
  const d = directives(contentSecurityPolicy({walletFrames: CIRCLE_WEB_SDK_FRAME_ORIGINS})), base = directives(POLICY_AT_BASE);
  assert.deepEqual(d['frame-src'], ["'self'", 'https://pw-auth.circle.com']);
  for (const k of Object.keys(base)) if (k !== 'frame-src') assert.deepEqual(d[k], base[k], k + ' is untouched');
  assert.ok(!contentSecurityPolicy({walletFrames: CIRCLE_WEB_SDK_FRAME_ORIGINS}).includes('*'));
  assert.ok(!/unsafe-inline|unsafe-eval|data:.*script/.test(d['script-src'].join(' ') + d['style-src'].join(' ')));
  for (const bad of ['https://*.circle.com', '*', 'http://pw-auth.circle.com', 'https://pw-auth.circle.com/', 'https://pw-auth.circle.com/path', 'pw-auth.circle.com', 'https://', "https://x.example 'unsafe-inline'", 'https://circle', 'wss://pw-auth.circle.com', '']) assert.throws(() => exactHttpsOrigin(bad), /exact https origin/, bad);
  assert.throws(() => contentSecurityPolicy({walletFrames: ['https://*.circle.com']}), /exact https origin/);
});

test('the pinned origin is the one the installed Circle web SDK actually uses', () => {
  const rootSdk = pathToFileURL(pkgFile('@circle-fin/w3s-pw-web-sdk', 'dist/src/index.js'));
  const src = readFileSync(createRequire(import.meta.url).resolve('@circle-fin/w3s-pw-web-sdk').replace(/\/dist\/src\/index\.js$/, '') + '/dist/src/index.js', 'utf8');
  assert.ok(rootSdk);
  assert.match(src, /this\.serviceUrl = 'https:\/\/pw-auth\.circle\.com'/);
  const circleHosts = [...new Set([...src.matchAll(/https?:\/\/([a-z0-9.-]*circle\.com)/g)].map(m => 'https://' + m[1]))];
  assert.deepEqual(circleHosts.sort(), [...CIRCLE_WEB_SDK_FRAME_ORIGINS].sort(), 'the SDK mentions no other Circle host; upgrading it must revisit this list');
  assert.match(src, /iframe\.src = `\$\{this\.serviceUrl\}\//, 'the host page frames it');
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|new WebSocket/, 'the page itself makes no network request, so connect-src needs no Circle origin');
  assert.match(read('package.json'), /"@circle-fin\/w3s-pw-web-sdk": "1\.1\.11"/, 'pinned to the version this policy was checked against');
});

test('actual production responses: the app page gets the one frame origin; API, wallet-less and Privy responses do not', async () => {
  const live = await prod({live: true});
  const none = await prod({live: false});
  try {
    const cookie = await live.signup('csp.check' + String.fromCharCode(64) + 'example.test');
    const fetchPolicy = async (base, path) => { const r = await fetch(base + path, {headers: {accept: 'text/html'}}); await r.arrayBuffer(); return {status: r.status, csp: r.headers.get('content-security-policy'), r}; };
    for (const path of ['/', '/my-wallet', '/assets/missing.js']) {
      const r = await fetchPolicy(live.origin, path);
      if (path === '/') assert.equal(r.status, 200, path);
      const d = directives(r.csp);
      assert.deepEqual(d['frame-src'], ["'self'", 'https://pw-auth.circle.com'], path);
      assert.deepEqual(d['connect-src'], ["'self'"], 'no Circle connect origin is needed or allowed');
      assert.deepEqual(d['script-src'], ["'self'"]); assert.deepEqual(d['style-src'], ["'self'"]); assert.deepEqual(d['default-src'], ["'self'"]);
      assert.deepEqual(d['frame-ancestors'], ["'none'"]);
      assert.ok(!r.csp.includes('*'));
      assert.equal(r.r.headers.get('x-frame-options'), 'DENY');
    }
    // The signed-in state response and every other API response keep the base policy.
    const api = await live.call('state', undefined, cookie);
    assert.equal(api.status, 200); assert.equal(api.headers.get('content-security-policy'), POLICY_AT_BASE);
    const apiErr = await fetch(live.origin + '/api/wallet/state'); await apiErr.arrayBuffer();
    assert.equal(apiErr.headers.get('content-security-policy'), POLICY_AT_BASE);
    // A deployment with no live wallet serves exactly the base-commit policy.
    for (const path of ['/', '/my-wallet']) assert.equal((await fetchPolicy(none.origin, path)).csp, POLICY_AT_BASE);
    // A misconfigured wallet (requested but not built) adds nothing either.
  } finally { await live.close(); await none.close(); }
});

test("Privy's pages keep their own isolated policy: the wallet policy is never merged into them", () => {
  for (const file of ['server/quote-first/native-privy-http.mjs', 'server/quote-first/buyer-connection-http.mjs', 'server/quote-first/wallet-bootstrap-http.mjs']) {
    const src = read(file);
    assert.match(src, /'Content-Security-Policy':connectionCsp/, file + ' sets its own policy');
    assert.doesNotMatch(src, /pw-auth\.circle\.com|wallet-csp|walletFrames|CIRCLE_WEB_SDK/, file + ' does not use the wallet policy');
  }
  const server = read('hosted/server.mjs');
  assert.match(server, /nativePrivy\(req,res\)/, 'the Privy handler still runs and overrides the header for its own pages');
  assert.equal(server.match(/Content-Security-Policy/g).length, 1, 'one place builds the page policy');
  for (const bad of ['unsafe-inline', 'unsafe-eval', "'*'"]) assert.ok(!read('hosted/wallet-csp.mjs').replace(/\/\/.*$/gm, '').includes(bad), bad);
});
