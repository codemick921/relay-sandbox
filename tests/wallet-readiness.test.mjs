import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runReadiness, formatReadiness} from '../hosted/wallet-readiness.mjs';

const run = promisify(execFile);
const KEY = 'LIVE_API_KEY:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbb';
const APP = '11111111-2222-4333-8444-555555555555';
const USER_SECRET = 'u'.repeat(40);
const good = (extra = {}) => ({
  EUPOVA_WALLET_MODE: 'live', EUPOVA_WALLET_NETWORK: 'base', EUPOVA_CIRCLE_UCW_API_KEY: KEY, EUPOVA_CIRCLE_UCW_APP_ID: APP,
  EUPOVA_CIRCLE_UCW_USER_ID_SECRET: USER_SECRET, EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE: 'EOA', EUPOVA_CIRCLE_UCW_GAS_MODEL: 'wallet',
  ...extra,
});
const noLeak = text => { for (const v of [KEY, APP, USER_SECRET, 'bbbbbbbbbbbbbbbbbbbbbbbb']) assert.equal(text.includes(v), false); };

test('nothing requested means off, with every setting listed as missing and no error', async () => {
  const r = await runReadiness({env: {}});
  assert.equal(r.requested, false); assert.equal(r.ready, false);
  assert.match(formatReadiness(r), /NOT requested/);
  assert.ok(r.lines.every(l => l.status === 'MISSING'));
});

test('a complete mainnet configuration is ready, says REAL MONEY, and never prints a secret', async () => {
  const r = await runReadiness({env: good()});
  assert.equal(r.ready, true); assert.equal(r.realMoney, true);
  const text = formatReadiness(r);
  noLeak(text);
  assert.match(text, /REAL MONEY/); assert.match(text, /LIVE key/); assert.match(text, /pw-auth\.circle\.com/);
  assert.match(text, /0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/);
});

test('inconsistent settings are named and the wallet is not ready', async () => {
  for (const [patch, name] of [
    [{EUPOVA_CIRCLE_UCW_API_KEY: 'TEST_API_KEY:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbb'}, 'EUPOVA_CIRCLE_UCW_API_KEY'],
    [{EUPOVA_CIRCLE_UCW_APP_ID: 'not-a-uuid'}, 'EUPOVA_CIRCLE_UCW_APP_ID'],
    [{EUPOVA_CIRCLE_UCW_USER_ID_SECRET: 'short'}, 'EUPOVA_CIRCLE_UCW_USER_ID_SECRET'],
    [{EUPOVA_WALLET_NETWORK: 'ethereum'}, 'EUPOVA_WALLET_NETWORK'],
    [{EUPOVA_CIRCLE_UCW_GAS_MODEL: 'sponsored'}, 'EUPOVA_CIRCLE_UCW_GAS_MODEL'], // sponsored needs SCA
  ]) {
    const r = await runReadiness({env: good(patch)});
    assert.equal(r.ready, false, name);
    assert.notEqual(r.lines.find(l => l.name === name).status, 'ok', name);
    noLeak(formatReadiness(r));
  }
});

test('the online check makes one read-only call and reports only codes', async () => {
  const calls = [];
  const sdk = ok => ({initiateUserControlledWalletsClient: () => new Proxy({}, {get: (_, m) => async a => { calls.push([m, a]); if (!ok) throw Object.assign(new Error('x ' + KEY), {response: {status: 401, data: {code: 155104, message: KEY}}}); return {data: {users: []}}; }})});
  const a = await runReadiness({env: good(), online: true, loadSdk: async () => sdk(true)});
  assert.deepEqual(calls, [['listUsers', {pageSize: 1}]]); assert.equal(a.online.ok, true);
  calls.length = 0;
  const b = await runReadiness({env: good(), online: true, loadSdk: async () => sdk(false)});
  assert.equal(b.online.ok, false); assert.equal(b.online.httpStatus, 401); assert.equal(b.online.circleCode, 155104);
  noLeak(formatReadiness(b));
  const c = await runReadiness({env: good({EUPOVA_WALLET_NETWORK: 'x'}), online: true, loadSdk: async () => { throw new Error('must not load'); }});
  assert.equal(c.online.ran, false);
});

test('the script prints names and status only and exits by readiness', async () => {
  const base = {PATH: process.env.PATH};
  const ready = await run(process.execPath, ['scripts/check-wallet-readiness.mjs'], {env: {...base, ...good()}});
  noLeak(ready.stdout); assert.match(ready.stdout, /READY/);
  await assert.rejects(run(process.execPath, ['scripts/check-wallet-readiness.mjs'], {env: base}), e => { assert.equal(e.code, 1); noLeak(e.stdout); return /NOT requested/.test(e.stdout); });
});
