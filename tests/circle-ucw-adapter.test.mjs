import test from 'node:test';
import {pkgFile} from './fixtures/pkg.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {
  createCircleUserControlledProvider, validateWalletConfig, walletConfigFromEnv, walletEnvNames, describeProviders, WalletProviderUnavailableError,
} from '../hosted/wallet-providers.mjs';
import {configuredCustomerWallet} from '../hosted/live-wallet.mjs';
import {WALLET_NETWORKS} from '../shared/wallet-model.mjs';

const require = createRequire(import.meta.url);
let sdkPath = null;
try { sdkPath = require.resolve('@circle-fin/user-controlled-wallets'); } catch { /* not installed here */ }
// Obviously fake values for a stubbed transport. They are not credentials.
const GOOD = {mode: 'live', network: 'base_sepolia', apiKey: 'TEST_API_KEY:stub-id:stub-secret', appId: '11111111-2222-4333-8444-555555555555', userIdSecret: 'x'.repeat(40), accountType: 'SCA', gasModel: 'wallet'};
const MAIN = {...GOOD, network: 'base', apiKey: 'LIVE_API_KEY:stub-id:stub-secret', accountType: 'EOA'};
const A = 'customer:aaaaaaaa', B = 'customer:bbbbbbbb';
const names = c => validateWalletConfig(c).problems.map(p => p.env).sort();

test('configuration is checked field by field and fails closed; nothing opens on partial, empty or inconsistent settings', () => {
  assert.equal(validateWalletConfig({}).requested, false); assert.equal(validateWalletConfig({mode: 'off'}).ready, false); assert.equal(validateWalletConfig({mode: 'test'}).requested, false, 'only the exact word "live" requests a live wallet');
  assert.equal(validateWalletConfig(GOOD).ready, true); assert.equal(validateWalletConfig(MAIN).ready, true); assert.equal(validateWalletConfig(MAIN).network.id, 'base');
  // Every field, one at a time.
  const w = walletEnvNames;
  const cases = [
    [{network: undefined}, [w.network]], [{network: 'ethereum'}, [w.network]], [{network: 'Base'}, [w.network]],
    [{apiKey: undefined}, [w.apiKey]], [{apiKey: 'short'}, [w.apiKey]], [{apiKey: 'TEST_API_KEY:onlyone'}, [w.apiKey]], [{apiKey: 'LIVE_API_KEY:a:b'}, [w.apiKey]],
    [{appId: undefined}, [w.appId]], [{appId: 'not-a-uuid'}, [w.appId]],
    [{userIdSecret: 'x'.repeat(31)}, [w.userIdSecret]], [{userIdSecret: undefined}, [w.userIdSecret]],
    [{accountType: undefined}, [w.accountType]], [{accountType: 'eoa'}, [w.accountType]], [{gasModel: 'free'}, [w.gasModel]], [{gasModel: 'sponsored', accountType: 'EOA'}, [w.gasDailyUsd, w.gasModel, w.gasPerTxUsd]], [{gasModel: 'sponsored', accountType: 'SCA'}, [w.gasDailyUsd, w.gasPerTxUsd]], [{gasModel: 'sponsored', accountType: 'SCA', gasDailyUsd: '5', gasPerTxUsd: '6'}, [w.gasPerTxUsd]], [{gasModel: 'sponsored', accountType: 'SCA', gasDailyUsd: '0', gasPerTxUsd: '0.05'}, [w.gasDailyUsd]], [{gasModel: 'sponsored', accountType: 'SCA', gasDailyUsd: '5', gasPerTxUsd: '1e-3'}, [w.gasPerTxUsd]],
    [{baseUrl: 'http://x.example'}, [w.baseUrl]],
  ];
  for (const [over, expect] of cases) assert.deepEqual(names({...GOOD, ...over}), expect, JSON.stringify(over));
  // Environment mismatch is refused in both directions.
  assert.deepEqual(names({...MAIN, apiKey: GOOD.apiKey}), [w.apiKey]); assert.deepEqual(names({...GOOD, apiKey: MAIN.apiKey}), [w.apiKey]);
  assert.equal(names({mode: 'live'}).length, 6, 'a bare "live" lists every missing name');
  // Providers cannot be built from invalid configuration, and the error names settings, never values.
  for (const bad of [{...GOOD, appId: 'x'}, {mode: 'live'}, {...GOOD, network: undefined}]) {
    assert.throws(() => createCircleUserControlledProvider({config: bad, sdkFactory: () => ({})}), e => e instanceof WalletProviderUnavailableError && !e.message.includes(GOOD.apiKey) && !e.message.includes(GOOD.userIdSecret));
  }
  assert.throws(() => createCircleUserControlledProvider({config: GOOD}), WalletProviderUnavailableError, 'no SDK, no provider');
  // The environment is parsed as-is: empty or whitespace values are absent, never defaulted into validity.
  const env = {EUPOVA_WALLET_MODE: 'live', EUPOVA_WALLET_NETWORK: ' base ', EUPOVA_CIRCLE_UCW_API_KEY: '  '};
  const c = walletConfigFromEnv(env);
  assert.equal(c.network, 'base'); assert.equal(c.apiKey, '');
  assert.ok(names(c).includes(w.apiKey));
  assert.equal(walletConfigFromEnv({}).mode, 'off');
});

test('production wiring starts a live wallet only from a complete configuration, otherwise reports exactly what to fix and offers nothing', async () => {
  const logs = [], store = {};
  assert.deepEqual(await configuredCustomerWallet({store, env: {}, log: m => logs.push(m)}), {wallet: null, status: {enabled: false, reason: 'off'}});
  assert.deepEqual(logs, [], 'off is silent');
  const env = {EUPOVA_WALLET_MODE: 'live', EUPOVA_WALLET_NETWORK: 'base_sepolia', EUPOVA_CIRCLE_UCW_API_KEY: GOOD.apiKey};
  const r = await configuredCustomerWallet({store, env, log: m => logs.push(m)});
  assert.equal(r.wallet, null); assert.equal(r.status.reason, 'misconfigured'); assert.ok(r.status.problems.includes(walletEnvNames.appId));
  assert.match(logs[0], /NOT started/); assert.ok(!logs[0].includes(GOOD.apiKey), 'no value in the log');
  const noSdk = await configuredCustomerWallet({store, env: {EUPOVA_WALLET_MODE: 'live', EUPOVA_WALLET_NETWORK: 'base', EUPOVA_CIRCLE_UCW_API_KEY: MAIN.apiKey, EUPOVA_CIRCLE_UCW_APP_ID: MAIN.appId, EUPOVA_CIRCLE_UCW_USER_ID_SECRET: MAIN.userIdSecret, EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE: 'EOA'}, loadSdk: async () => { throw new Error('missing'); }, log: m => logs.push(m)});
  assert.equal(noSdk.wallet, null); assert.match(logs.at(-1), /not installed/);
  // Never a fallback to the simulation.
  for (const x of [r, noSdk]) assert.equal(x.wallet, null);
  const list = describeProviders({config: GOOD});
  assert.equal(list.find(p => p.id === 'circle_ucw').ready, true); assert.equal(list.find(p => p.id === 'privy').ready, false);
  assert.ok(!JSON.stringify(list).includes(GOOD.apiKey));
});

test('the installed Circle SDKs expose what the adapter calls, with the documented browser sequence', { skip: !sdkPath }, () => {
  const sdk = require(sdkPath);
  const client = sdk.initiateUserControlledWalletsClient({apiKey: GOOD.apiKey});
  for (const m of ['createUser', 'createUserToken', 'createUserPinWithWallets', 'listWallets', 'getWalletTokenBalance', 'estimateTransferFee', 'createTransaction', 'listTransactions']) assert.equal(typeof client[m], 'function', m);
  assert.equal(JSON.parse(readFileSync(pkgFile('@circle-fin/user-controlled-wallets', 'package.json'), 'utf8')).version, '10.8.1');
  const web = readFileSync(pkgFile('@circle-fin/w3s-pw-web-sdk', 'dist/src/index.d.ts'), 'utf8');
  for (const m of ['getDeviceId(): Promise<string>', 'setAuthentication', 'execute(challengeId']) assert.ok(web.includes(m), m);
  assert.match(readFileSync(pkgFile('@circle-fin/w3s-pw-web-sdk', 'dist/src/types.d.ts'), 'utf8'), /appSettings: AppSettings/);
});

// The real SDK with its HTTP transport replaced by an in-memory stub. No request leaves the process.
async function withStub(setup, run) {
  const axios = createRequire(sdkPath)('axios');
  const saved = axios.defaults.adapter, calls = [], users = new Set();
  const st = {balances: [], wallets: null, txs: [], estimate: null, ...setup};
  const err = (status, code, message, cfg) => new axios.AxiosError(message, 'ERR_BAD_REQUEST', cfg, null, {status, statusText: 'x', headers: {}, config: cfg, data: {code, message}});
  axios.defaults.adapter = async cfg => {
    const url = new URL((cfg.baseURL ?? '') + cfg.url), h = cfg.headers.toJSON ? cfg.headers.toJSON() : cfg.headers, body = cfg.data ? JSON.parse(cfg.data) : null;
    const rec = {method: cfg.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, userToken: h['X-User-Token'] ?? null, hasAuth: !!h.Authorization};
    calls.push(rec);
    const ok = data => ({status: 200, statusText: 'OK', headers: {}, config: cfg, data: {data}});
    // Circle-style paging: pageSize items per call, continuing after the id given in pageAfter.
    const page = (list, idOf) => { const size = Number(rec.query.pageSize ?? 10); if (st.noAdvance) return list.slice(0, size); const i = rec.query.pageAfter ? list.findIndex(x => idOf(x) === rec.query.pageAfter) + 1 : 0; return list.slice(i, i + size); };
    if (url.hostname !== 'api.circle.com') throw new Error('unexpected host');
    const user = /^tok-(.+)$/.exec(rec.userToken ?? '')?.[1];
    if (rec.method === 'post' && rec.path === '/v1/w3s/users') { if (users.has(body.userId)) throw err(409, 155101, 'User already created', cfg); users.add(body.userId); return ok({}); }
    if (rec.method === 'post' && rec.path === '/v1/w3s/users/token') return ok({userToken: 'tok-' + body.userId, encryptionKey: 'key-' + body.userId});
    if (rec.method === 'post' && rec.path === '/v1/w3s/user/initialize') { if (st.initialized) throw err(409, 155106, 'User already initialized', cfg); return ok({challengeId: 'init-' + body.idempotencyKey}); }
    if (rec.method === 'get' && rec.path === '/v1/w3s/wallets') return ok({wallets: page(st.wallets ?? [{id: 'w-' + user, address: '0x' + 'a'.repeat(40), blockchain: st.chain, state: 'LIVE'}], w => w.id)});
    if (rec.method === 'get' && /\/balances$/.test(rec.path)) return ok({tokenBalances: page(st.balances, r => r.token.id)});
    if (rec.method === 'post' && rec.path === '/v1/w3s/user/transactions/transfer/estimateFee' || /estimateFee|transfer\/estimate/.test(rec.path)) return ok(st.estimate);
    if (rec.method === 'post' && rec.path === '/v1/w3s/user/transactions/transfer') return ok({challengeId: 'pay-' + body.idempotencyKey});
    if (rec.method === 'post' && rec.path === '/v1/w3s/user/sign/typedData') return ok({challengeId: 'type-' + body.idempotencyKey});
    if (rec.method === 'get' && rec.path === '/v1/w3s/transactions') return ok({transactions: page(st.txs, t => t.id)});
    if (rec.method === 'post' && /contractExecution\/estimateFee|contract.*estimateFee|estimateFee.*contract/i.test(rec.path)) return ok(st.contractEstimate ?? {low: {networkFee: '0.00001'}, medium: {networkFee: '0.00002'}, high: {networkFee: '0.00003'}});
    if (rec.method === 'post' && /contract/i.test(rec.path)) return ok({challengeId: 'ct-' + body.idempotencyKey});
    throw new Error('unstubbed ' + rec.method + ' ' + rec.path);
  };
  try { await run({calls, st, users}); } finally { axios.defaults.adapter = saved; }
}
// Every call the adapter makes to the REAL SDK client is checked against the input type the installed SDK declares for that method:
// an unknown top-level key (for example a top-level walletId where the SDK wants source.walletId, or amounts where it wants amount) fails here,
// not in production. The allowed keys are read from the SDK's own type declarations, including the types it intersects.
const sdkTypes = (() => { try { return ['dist/types/user-controlled-wallets.d.ts', 'dist/types/clients/user-controlled-wallets.d.ts', 'dist/types/clients/core.d.ts'].map(f => readFileSync(pkgFile('@circle-fin/user-controlled-wallets', f), 'utf8')).join('\n'); } catch { return ''; } })();
function allowedKeys(typeName, seen = new Set()) {
  if (seen.has(typeName)) return new Set(); seen.add(typeName);
  const m = new RegExp('^(?:declare )?(?:type|interface) ' + typeName + '\\b', 'm').exec(sdkTypes); if (!m) return new Set();
  const rest = sdkTypes.slice(m.index), end = rest.slice(1).search(/\n(?:\/\*\*|type |interface |declare |export |\/\/)/), block = end < 0 ? rest : rest.slice(0, end + 1);
  const keys = new Set([...block.matchAll(/^ {4}['"]?(\w+)['"]?\??:/gm)].map(x => x[1]));
  for (const ref of block.matchAll(/\b([A-Z][A-Za-z0-9]+)\b/g)) if (ref[1] !== typeName) for (const k of allowedKeys(ref[1], seen)) keys.add(k);
  return keys;
}
const inputTypeOf = method => new RegExp('\\n\\s+' + method + '\\(input: (\\w+)\\)').exec(sdkTypes)?.[1] ?? null;
export const validatedMethods = new Set();
const checked = client => new Proxy(client, {get(t, name) {
  const fn = t[name]; if (typeof fn !== 'function') return fn;
  return (...args) => {
    const type = inputTypeOf(String(name));
    if (type && args[0] && typeof args[0] === 'object') {
      const ok = allowedKeys(type), extra = Object.keys(args[0]).filter(k => !ok.has(k));
      assert.deepEqual(extra, [], `${String(name)} was called with keys the installed SDK's ${type} does not declare`); validatedMethods.add(String(name));
    }
    return fn.apply(t, args);
  };
}});
const build = config => createCircleUserControlledProvider({config, sdkFactory: cfg => checked(require(sdkPath).initiateUserControlledWalletsClient(cfg))});
const tok = (net, over = {}) => ({amount: '12.345678', token: {id: 'tok-usdc', blockchain: net.circleChain, tokenAddress: net.usdc.toLowerCase(), symbol: 'USDC', decimals: 6, isNative: false}, ...over});
const eth = net => ({amount: '0.01', token: {id: 'tok-eth', blockchain: net.circleChain, symbol: 'ETH', decimals: 18, isNative: true}});

for (const [label, config] of [['Base Sepolia', GOOD], ['Base mainnet', MAIN]]) {
  const net = WALLET_NETWORKS[config.network];
  test(`real SDK, stubbed transport (${label}): binding, session, setup challenge, listing, exact-token balance`, { skip: !sdkPath }, async () => {
    await withStub({chain: net.circleChain, balances: [tok(net), eth(net)]}, async ({calls, st}) => {
      const p = build(config);
      assert.equal(p.network.id, config.network); assert.equal(p.network.environment, config.network === 'base' ? 'mainnet' : 'testnet');
      assert.notEqual(p.userIdFor(A), p.userIdFor(B)); assert.match(p.userIdFor(A), /^eupova-ucw-[0-9a-f]{39}$/); assert.ok(!p.userIdFor(A).includes('aaaaaaaa'));
      // Circle's ExternalUserId is 5 to 50 characters. Going over is a live 400 that reads as a generic 503 in the app.
      assert.ok(p.userIdFor(A).length <= 50, `userId is ${p.userIdFor(A).length} characters; Circle allows at most 50`);
      assert.ok(p.userIdFor(A).length >= 5);
      const s1 = await p.startSession(A), s2 = await p.startSession(A);
      assert.equal(s1.userToken, 'tok-' + p.userIdFor(A)); assert.equal(s2.userToken, s1.userToken, 'a repeat user (155101) is tolerated');
      const requestId = randomUUID();
      const a = await p.beginWalletSetup({owner: A, requestId}), a2 = await p.beginWalletSetup({owner: A, requestId});
      const init = calls.filter(c => c.path === '/v1/w3s/user/initialize')[0];
      assert.deepEqual(init.body.blockchains, [net.circleChain]); assert.equal(init.body.accountType, config.accountType); assert.equal(init.userToken, 'tok-' + p.userIdFor(A));
      assert.equal(a.challengeId, a2.challengeId, 'resuming with the same request id asks for the same challenge');
      st.initialized = true;
      assert.deepEqual(await p.beginWalletSetup({owner: A, requestId: randomUUID()}), {alreadyInitialized: true}, '155106: already has wallets, so there is no PIN step');
      assert.deepEqual(await p.findWallet(A), {providerRef: 'w-' + p.userIdFor(A), address: '0x' + 'a'.repeat(40), state: 'ready'});
      assert.equal(calls.filter(c => c.path === '/v1/w3s/wallets').at(-1).query.blockchain, net.circleChain);
      assert.equal(await p.balance(A, 'w-' + p.userIdFor(A)), '12345678');
      assert.equal(await p.nativeBalanceWei(A, 'w-' + p.userIdFor(A)), '10000000000000000');
      // A wallet that is not this customer's is refused, even though the id is a valid one.
      await assert.rejects(p.balance(A, 'w-someone-else'), /not available for this customer/);
      // Wrong chain, a lookalike symbol at the wrong address, or an address match that is flagged native never count.
      st.balances = [tok(net, {token: {...tok(net).token, tokenAddress: '0x' + '9'.repeat(40)}}), tok(net, {token: {...tok(net).token, blockchain: 'ETH'}}), tok(net, {token: {...tok(net).token, isNative: true}})];
      assert.equal(await p.balance(A, 'w-' + p.userIdFor(A)), '0', 'matching on symbol is never done');
      st.balances = [tok(net), tok(net)];
      await assert.rejects(p.balance(A, 'w-' + p.userIdFor(A)), /More than one token/);
      st.balances = [tok(net, {token: {...tok(net).token, decimals: 18}})];
      await assert.rejects(p.balance(A, 'w-' + p.userIdFor(A)), /6 decimals/);
      st.balances = [tok(net, {amount: '1.1234567'})]; await assert.rejects(p.balance(A, 'w-' + p.userIdFor(A)), /precision/);
      st.balances = [tok(net, {amount: 'abc'})]; await assert.rejects(p.balance(A, 'w-' + p.userIdFor(A)), /Unreadable/);
      st.wallets = [{id: 'w1', address: '0x' + 'a'.repeat(40), blockchain: net.circleChain, state: 'LIVE'}, {id: 'w2', address: '0x' + 'b'.repeat(40), blockchain: net.circleChain, state: 'LIVE'}];
      await assert.rejects(p.findWallet(A), /More than one live wallet/);
      st.wallets = [{id: 'w1', address: '0x' + 'a'.repeat(40), blockchain: net.circleChain, state: 'FROZEN'}, {id: 'w9', address: '0x' + 'c'.repeat(40), blockchain: 'ETH', state: 'LIVE'}];
      assert.equal(await p.findWallet(A), null);
      assert.ok(calls.every(c => c.hasAuth)); assert.ok(!JSON.stringify(calls.map(c => ({...c, userToken: undefined}))).includes('API_KEY'), 'the API key is only ever in a header');
    });
  });

  test(`real SDK, stubbed transport (${label}): fee bound in ETH, payment by exact token id with explicit gas limits, transaction lookup`, { skip: !sdkPath }, async () => {
    await withStub({chain: net.circleChain, balances: [tok(net), eth(net)], estimate: {low: {}, medium: {}, high: {gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1', networkFee: '0.00016250', gasPrice: '2.5', baseFee: '2.4'}}}, async ({calls, st}) => {
      const p = build(config), owner = A, ref = 'w-' + p.userIdFor(A);
      const fee = await p.estimateFee({owner, walletRef: ref, destination: '0x' + 'c'.repeat(40), amountRaw: '1234567'});
      if (config.gasModel === 'wallet') assert.deepEqual(fee, {asset: 'ETH', gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1', maxFeeNativeWei: '162500000000000', basis: 'circle_estimate_high_tier', capEnforcedOnChain: false});
      const est = calls.find(c => /estimate/i.test(c.path));
      assert.equal(est.body.tokenId, 'tok-usdc'); assert.deepEqual(est.body.amounts, ['1.234567']); assert.equal(est.userToken, 'tok-' + p.userIdFor(A));
      st.estimate = {high: {gasLimit: 'x', maxFee: '1', priorityFee: '1', networkFee: '1'}}; await assert.rejects(p.estimateFee({owner, walletRef: ref, destination: '0x' + 'c'.repeat(40), amountRaw: '1'}), /unreadable/);
      st.estimate = null; await assert.rejects(p.estimateFee({owner, walletRef: ref, destination: '0x' + 'c'.repeat(40), amountRaw: '1'}));
      const payment = {id: randomUUID(), owner, walletRef: ref, destination: '0x' + 'c'.repeat(40), amountRaw: '1234567', fee: {asset: 'ETH', gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1'}};
      const out = await p.executeTransfer(payment), again = await p.executeTransfer(payment);
      assert.equal(out.state, 'pending_challenge', 'a challenge for the customer, never an instant payment'); assert.equal(out.challengeId, again.challengeId); assert.equal(out.tokenId, 'tok-usdc');
      const t = calls.filter(c => c.path === '/v1/w3s/user/transactions/transfer').at(-1).body;
      assert.deepEqual({walletId: t.walletId, destinationAddress: t.destinationAddress, amounts: t.amounts, tokenId: t.tokenId, refId: t.refId, gasLimit: t.gasLimit, maxFee: t.maxFee, priorityFee: t.priorityFee, feeLevel: t.feeLevel, tokenAddress: t.tokenAddress},
        {walletId: ref, destinationAddress: payment.destination, amounts: ['1.234567'], tokenId: 'tok-usdc', refId: payment.id, gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1', feeLevel: undefined, tokenAddress: undefined});
      st.balances = []; await assert.rejects(p.executeTransfer({...payment, id: randomUUID()}), /no USDC/);
      // Transaction lookup: reported as-is for the caller to verify; duplicates are uncertain; an unreadable or non-advancing list is uncertain; a fully read list with no match is not found.
      const dest = payment.destination, row = (o = {}) => ({id: 't1', refId: payment.id, state: 'COMPLETE', userId: p.userIdFor(A), walletId: ref, blockchain: net.circleChain, destinationAddress: dest, amounts: ['1.234567'], tokenId: 'tok-usdc', txHash: '0xabc', networkFee: '0.0001', transactionType: 'OUTBOUND', ...o});
      st.txs = [row()];
      const f = await p.findTransaction({owner, walletRef: ref, refId: payment.id, destination: dest});
      assert.equal(f.found, true); assert.equal(f.tx.state, 'COMPLETE'); assert.equal(f.expectedUserId, p.userIdFor(A));
      const q = calls.filter(c => c.path === '/v1/w3s/transactions').at(-1).query; assert.equal(q.destinationAddress, dest); assert.equal(q.blockchain, net.circleChain);
      st.txs = [row(), row({id: 't2'})]; assert.deepEqual(await p.findTransaction({owner, walletRef: ref, refId: payment.id, destination: dest}), {uncertain: true});
      st.txs = Array.from({length: 50}, (_, i) => row({id: 'x' + i, refId: 'other-' + i})); assert.deepEqual(await p.findTransaction({owner, walletRef: ref, refId: payment.id, destination: dest}), {found: false}, 'every page was read and none matched: positively not found');
      st.txs = [row({refId: 'other'})]; assert.deepEqual(await p.findTransaction({owner, walletRef: ref, refId: payment.id, destination: dest}), {found: false});
    });
  });
}

test('signing typed data is a challenge, never a signature, and the typed data goes over the wire as one JSON string', { skip: !sdkPath }, async () => {
  await withStub({chain: 'BASE', balances: []}, async ({calls, st}) => {
    const p = build(MAIN);
    const typedData = {domain: {name: 'USDC', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'}, types: {TransferWithAuthorization: [{name: 'from', type: 'address'}]}, primaryType: 'TransferWithAuthorization', message: {from: '0x' + 'a'.repeat(40)}};
    const out = await p.signTypedData({owner: A, walletRef: 'w-' + p.userIdFor(A), typedData, refId: 'auth-1', memo: 'Pay for one API call'});
    // The browser gets a challenge to run, the same shape the PIN step takes. There is no signature in this response.
    assert.equal(typeof out.challengeId, 'string');
    assert.equal(typeof out.userToken, 'string');
    assert.equal(out.signature, undefined, 'a signature can only come back from the customer completing the challenge');
    const sent = calls.filter(c => c.path === '/v1/w3s/user/sign/typedData').at(-1).body;
    assert.equal(sent.walletId, 'w-' + p.userIdFor(A));
    assert.equal(typeof sent.data, 'string', 'Circle takes the typed data as a JSON string');
    assert.deepEqual(JSON.parse(sent.data), typedData);
    assert.equal(sent.memo, 'Pay for one API call');
    // Circle's SignTypedDataInput has no idempotency key, unlike its other mutating calls, so the SDK cannot dedupe a
    // repeated signing request. That guarantee has to live in our own records, and this test records the absence so a
    // future SDK change is noticed rather than assumed.
    assert.equal(sent.idempotencyKey, undefined, 'the SDK declares no idempotency key for signing; dedupe belongs to our records');
    assert.deepEqual(Object.keys(sent).sort(), ['data', 'memo', 'walletId'].concat('userToken' in sent ? ['userToken'] : []).sort());
  });
});

test('sponsored fees: no ETH ceiling is invented, and sponsorship needs smart-contract accounts', { skip: !sdkPath }, async () => {
  const cfg = {...GOOD, gasModel: 'sponsored', accountType: 'SCA', gasDailyUsd: '5', gasPerTxUsd: '0.05'};
  assert.equal(validateWalletConfig(cfg).ready, true);
  await withStub({chain: 'BASE-SEPOLIA', balances: [tok(WALLET_NETWORKS.base_sepolia)]}, async () => {
    const p = build(cfg);
    assert.equal(p.feeModel.asset, 'sponsored');
    assert.deepEqual(await p.estimateFee({owner: A, walletRef: 'w-' + p.userIdFor(A), destination: '0x' + 'c'.repeat(40), amountRaw: '1'}), {asset: 'sponsored', maxFeeNativeWei: '0', gasLimit: null, maxFee: null, priorityFee: null});
  });
});

test('the browser challenge runner follows Circle\'s sequence and never starts without a complete challenge', async () => {
  const {runCircleChallenge} = await import('../src/circle-challenge.mjs');
  const seen = [];
  class FakeSdk {
    constructor(cfg) { seen.push(['new', cfg]); }
    async getDeviceId() { seen.push(['device']); return 'device-1'; }
    setAuthentication(a) { seen.push(['auth', a]); }
    execute(id, cb) { seen.push(['execute', id]); cb(undefined, {type: 'TRANSACTION', status: 'COMPLETE'}); }
  }
  const challenge = {appId: 'app', userToken: 'ut', encryptionKey: 'ek', challengeId: 'ch'};
  assert.deepEqual(await runCircleChallenge(challenge, async () => ({W3SSdk: FakeSdk})), {type: 'TRANSACTION', status: 'COMPLETE'});
  assert.deepEqual(seen, [['new', {appSettings: {appId: 'app'}}], ['device'], ['auth', {userToken: 'ut', encryptionKey: 'ek'}], ['execute', 'ch']], 'getDeviceId comes before setAuthentication and execute');
  // A signing challenge carries its signature in result.data; the runner surfaces it once, for the server to verify.
  const typed = {appId: 'app', userToken: 'ut', encryptionKey: 'ek', challengeId: 'ch'};
  class Signing extends FakeSdk { execute(id, cb) { cb(undefined, {type: 'SIGN_TYPEDDATA', status: 'COMPLETE', data: {signature: '0x' + 'ab'.repeat(65)}}); } }
  const signed = await runCircleChallenge(typed, async () => ({W3SSdk: Signing}));
  assert.equal(signed.signature, '0x' + 'ab'.repeat(65));
  const {challengeSignature} = await import('../src/circle-challenge.mjs');
  assert.equal(challengeSignature(signed), '0x' + 'ab'.repeat(65));
  assert.equal(challengeSignature({type: 'TRANSACTION'}), null, 'a transaction challenge is not a signature');
  assert.equal(challengeSignature({data: {signature: 'nonsense'}}), null, 'a malformed signature is not surfaced');
  class Failing extends FakeSdk { execute(id, cb) { cb({message: 'User closed the PIN step'}); } }
  await assert.rejects(runCircleChallenge(challenge, async () => ({W3SSdk: Failing})), /User closed the PIN step/);
  class NoDevice extends FakeSdk { async getDeviceId() { return ''; } }
  await assert.rejects(runCircleChallenge(challenge, async () => ({W3SSdk: NoDevice})), /no device session/);
  let loaded = false;
  for (const bad of [null, {}, {...challenge, userToken: ''}, {...challenge, challengeId: undefined}]) await assert.rejects(runCircleChallenge(bad, async () => { loaded = true; return {W3SSdk: FakeSdk}; }), /could not start/);
  assert.equal(loaded, false);
});

// ---- paging: a list is never trusted from its first page ---------------------------------------------------------
const fillerTokens = n => Array.from({length: n}, (_, i) => ({amount: '1', token: {id: 'junk-' + i, blockchain: 'BASE-SEPOLIA', tokenAddress: '0x' + (i + 1).toString(16).padStart(40, '0'), symbol: 'JUNK' + i, decimals: 6, isNative: false}}));
const USDC_ROW = {amount: '12.345678', token: {id: 'tok-usdc', blockchain: 'BASE-SEPOLIA', tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', symbol: 'USDC', decimals: 6, isNative: false}};
const NATIVE_ROW = {amount: '0.01', token: {id: 'tok-eth', blockchain: 'BASE-SEPOLIA', symbol: 'ETH', decimals: 18, isNative: true}};

test('balances walk every page: USDC and the gas balance are found on the last page, never lost after page one', async () => {
  const p = build(GOOD);
  await withStub({chain: 'BASE-SEPOLIA', balances: [...fillerTokens(120), USDC_ROW, NATIVE_ROW]}, async ({calls}) => {
    assert.equal(await p.balance('owner-p', 'w-' + p.userIdFor('owner-p')), '12345678');
    assert.equal(await p.nativeBalanceWei('owner-p', 'w-' + p.userIdFor('owner-p')), '10000000000000000');
    const pages = calls.filter(c => /\/balances$/.test(c.path));
    assert.ok(pages.length >= 6, 'it followed the cursor: ' + pages.length);
    assert.ok(pages.filter(c => c.query.pageAfter).length >= 4, 'later pages continue after the previous id');
  });
});

test('wallets and the transaction lookup also walk every page; a wallet on page 2 is found, a transfer on page 3 is verified', async () => {
  const p = build(GOOD);
  const owner = 'owner-w'; const uid = p.userIdFor(owner);
  const other = i => ({id: 'x-' + i, address: '0x' + 'b'.repeat(40), blockchain: 'BASE-SEPOLIA', state: 'LIVE'});
  const dest = '0x' + 'd'.repeat(40);
  const txs = [...Array.from({length: 100}, (_, i) => ({id: 'old-' + i, refId: 'r-' + i, destinationAddress: dest, state: 'COMPLETE'})), {id: 'tx-target', refId: 'pay-1', userId: uid, walletId: 'w-' + uid, blockchain: 'BASE-SEPOLIA', destinationAddress: dest, amounts: ['1'], tokenId: 'tok-usdc', state: 'COMPLETE', transactionType: 'OUTBOUND', txHash: '0x' + '9'.repeat(64)}];
  await withStub({chain: 'BASE-SEPOLIA', wallets: [...Array.from({length: 60}, (_, i) => other(i)), {id: 'w-' + uid, address: '0x' + 'a'.repeat(40), blockchain: 'BASE-SEPOLIA', state: 'LIVE'}], txs}, async () => {
    const found = await p.findTransaction({owner, walletRef: 'w-' + uid, refId: 'pay-1', destination: dest});
    assert.equal(found.found, true); assert.equal(found.tx.id, 'tx-target');
    const w = await p.findWallet(owner).catch(e => e);
    assert.ok(w instanceof Error, 'sixty-one live wallets is not one wallet: refused');
  });
});

test('a list that does not advance, or is longer than the cap, is an error or "unknown", never a partial answer', async () => {
  const p = build(GOOD);
  const uid = p.userIdFor('owner-n'); const dest = '0x' + 'd'.repeat(40);
  await withStub({chain: 'BASE-SEPOLIA', noAdvance: true, balances: fillerTokens(80)}, async () => {
    await assert.rejects(p.balance('owner-n', 'w-' + uid), /did not advance/);
  });
  await withStub({chain: 'BASE-SEPOLIA', noAdvance: true, txs: Array.from({length: 70}, (_, i) => ({id: 't' + i, refId: 'r' + i, destinationAddress: dest}))}, async () => {
    const r = await p.findTransaction({owner: 'owner-n', walletRef: 'w-' + uid, refId: 'nope', destination: dest});
    assert.deepEqual(r, {uncertain: true}, 'an unreadable list never means "not found"');
  });
  await withStub({chain: 'BASE-SEPOLIA', balances: fillerTokens(2100)}, async () => {
    await assert.rejects(p.balance('owner-n', 'w-' + uid), /partial list is not trusted|more than/);
  });
});

test('history is best effort: it follows a few pages and shows what it has instead of failing the page', async () => {
  const p = build(GOOD); const uid = p.userIdFor('owner-h');
  const txs = Array.from({length: 130}, (_, i) => ({id: 'h' + i, state: 'COMPLETE', createDate: '2026-11-05T10:00:00Z', transactionType: 'INBOUND', amounts: ['1'], tokenId: 'tok-usdc'}));
  await withStub({chain: 'BASE-SEPOLIA', txs}, async () => {
    const rows = await p.history('owner-h', 'w-' + uid);
    assert.equal(rows.length, 130);
  });
});

test('every SDK call the adapter makes uses exactly the input keys the installed SDK declares (contract execution and fee estimates included)', { skip: !sdkPath || !sdkTypes }, async () => {
  assert.ok(allowedKeys('EstimateContractExecutionFeeInput').has('source') && !allowedKeys('EstimateContractExecutionFeeInput').has('walletId'), 'the checker reads the SDK: source.walletId, not a top-level walletId');
  assert.ok(allowedKeys('EstimateTransferFeeInput').has('amount') && !allowedKeys('EstimateTransferFeeInput').has('amounts'));
  // The checker itself catches the two mistakes this SDK version punishes.
  const probe = checked({estimateContractExecutionFee: async () => ({}), estimateTransferFee: async () => ({})});
  assert.throws(() => probe.estimateContractExecutionFee({userToken: 't', walletId: 'w', contractAddress: '0x1', abiFunctionSignature: 'f()', abiParameters: []}), /does not declare/);
  assert.throws(() => probe.estimateTransferFee({userToken: 't', walletId: 'w', tokenId: 'x', destinationAddress: '0x1', amounts: ['1']}), /does not declare/);
  const net = WALLET_NETWORKS.base;
  await withStub({chain: net.circleChain, balances: [tok(net), eth(net)], estimate: {high: {gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1', networkFee: '0.001'}}}, async ({calls}) => {
    const p = build(MAIN), ref = 'w-' + p.userIdFor(A), dest = '0x' + 'd'.repeat(40);
    await p.startSession(A); await p.beginWalletSetup({owner: A, requestId: randomUUID()}); await p.findWallet(A);
    await p.balance(A, ref); await p.nativeBalanceWei(A, ref); await p.resolveUsdcTokenId(A, ref); await p.history(A, ref);
    await p.estimateFee({owner: A, walletRef: ref, destination: dest, amountRaw: '1000000'});
    await p.executeTransfer({id: randomUUID(), owner: A, walletRef: ref, destination: dest, amountRaw: '1000000', fee: {asset: 'ETH', gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1'}});
    await p.findTransaction({owner: A, walletRef: ref, refId: randomUUID(), destination: dest});
    const call = {owner: A, walletRef: ref, contractAddress: net.usdc, abiFunctionSignature: 'approve(address,uint256)', abiParameters: [dest, '1']};
    await p.estimateContractFee(call);
    const c = await p.executeContract({...call, refId: 'b:approve', idempotencyKey: 'b:approve'});
    assert.match(c.challengeId, /^ct-/);
    await p.findContractTransaction({owner: A, walletRef: ref, refId: 'b:approve'});
    const body = calls.find(x => /contract/i.test(x.path) && !/estimate/i.test(x.path)).body;
    assert.equal(body.contractAddress, net.usdc); assert.equal(body.walletId, ref); assert.equal(body.abiFunctionSignature, 'approve(address,uint256)'); assert.equal(body.refId, 'b:approve');
  });
  for (const m of ['createUser', 'createUserToken', 'createUserPinWithWallets', 'listWallets', 'getWalletTokenBalance', 'estimateTransferFee', 'createTransaction', 'listTransactions', 'createUserTransactionContractExecutionChallenge', 'estimateContractExecutionFee'])
    assert.ok(validatedMethods.has(m), m + ' was exercised and validated');
});
