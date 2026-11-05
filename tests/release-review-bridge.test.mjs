import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {fixture} from './fixtures/account-store.mjs';
import {createCustomerWallet} from '../hosted/customer-wallet.mjs';
import {liveProvider, FEE, ETH} from './fixtures/live-provider.mjs';
import {BRIDGE_ROUTES, routeForNetwork} from '../shared/wallet-bridge-route.mjs';
import {WALLET_NETWORKS} from '../shared/wallet-model.mjs';

const owner = 'customer:' + randomUUID(), other = 'customer:' + randomUUID();
const ARC_ADDR = '0x' + 'e'.repeat(40), NONCE = '4242', DEST_TX = '0x' + '3'.repeat(64), BURN_TX = '0x' + '1'.repeat(64);
const R = BRIDGE_ROUTES.mainnet;

// A scripted transport: every answer is whatever the test sets; it records what it was asked to do.
function transport(st) {
  const log = (k, v) => { (st[k] ??= []).push(v); };
  return {
    async quote(q) { log('quotes', q); if (st.quoteFails) throw new Error('down'); return {maxUsdcFeeRaw: st.quoteFee ?? '200000', maxNativeFeeWei: st.quoteNative ?? '0', minFinalityThreshold: st.quoteFinality ?? 1000}; },
    async allowance() { if (st.allowanceThrows) throw new Error('rpc'); return st.allowance ?? '0'; },
    async submitApprove(p) { log('approves', p); if (st.approveThrows) throw new Error('timeout'); return {challengeId: 'approve-' + st.approves.length, appId: 'a', userToken: 'T-USER-TOKEN', encryptionKey: 'E-KEY'}; },
    async submitBurn(p) { log('burns', p); if (st.burnThrows) throw new Error('timeout'); return {challengeId: 'burn-' + st.burns.length, appId: 'a', userToken: 'T-USER-TOKEN', encryptionKey: 'E-KEY'}; },
    async findApprove() { return st.approve ?? {found: false}; },
    async findBurn() { return st.burn ?? {found: false}; },
    async attestation() { return st.att ?? {status: 'pending'}; },
    async verifyDestination() { return st.dest ?? {found: false}; },
  };
}
async function setup(netId = 'base', over = {}) {
  const f = await fixture();
  const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}, quotes: [], approves: [], burns: [], ...over};
  const cw = createCustomerWallet({store: f.store, provider: liveProvider(netId, st), config: {}, bridgeTransport: transport(st)});
  await cw.migrate();
  return {...f, cw, st};
}
async function ready(f, who = owner, usdc = 50_000_000n, eth = ETH) {
  await f.cw.createWallet(who, {label: 'My Eupova wallet', requestId: randomUUID()});
  f.st.wallets[who] = {providerRef: 'w-' + who.slice(-6), address: '0x' + 'a'.repeat(34) + who.slice(-6).replace(/[^0-9a-f]/g, 'b').padEnd(6, 'b'), state: 'ready'};
  await f.cw.finishSetup(who); f.st.usdc[who] = usdc; f.st.eth[who] = eth;
}
const req = (f, who = owner, over = {}) => f.cw.bridge.request(who, {requestId: randomUUID(), recipient: ARC_ADDR, amount: '10', confirmDestination: true, ...over});
const fp = async (f, id, who = owner) => (await f.cw.bridge.state(who)).items.find(i => i.id === id).fingerprint;
const approve = async (f, id, who = owner) => f.cw.bridge.decide(who, {id, decision: 'approve', bindingHash: await fp(f, id, who)});
const row = async (f, id) => (await f.store.query('SELECT * FROM relay_cw_bridges WHERE id=$1', [id])).rows[0];
async function bindingOf(f, id) { const b = await row(f, id); const w = (await f.store.query('SELECT provider_ref FROM relay_cw_wallets WHERE id=$1', [b.wallet_id])).rows[0]; return {b: b.binding, ref: w.provider_ref}; }
const approveTx = async (f, id, over = {}) => { const {b, ref} = await bindingOf(f, id); return {found: true, expectedUserId: 'u', tx: {state: 'COMPLETE', walletId: ref, contractOk: true, userId: 'u', ...over}}; };
const burnTx = async (f, id, over = {}) => { const {b, ref} = await bindingOf(f, id); return {found: true, expectedUserId: 'u', tx: {walletId: ref, chainId: b.source.chainId, contract: R.source.tokenMessenger, burnToken: b.source.token, amountRaw: b.amountRaw, destinationDomain: 26,
  mintRecipient: b.destination.recipient, from: b.source.address, state: 'COMPLETE', txHash: BURN_TX, eventNonce: NONCE, userId: 'u', ...over}}; };
const arrival = async (f, id, over = {}) => { const {b} = await bindingOf(f, id); return {found: true, success: true, finalized: true, nonceUsed: true, chainId: 5042, token: R.destination.usdc, txHash: DEST_TX, nonce: NONCE,
  credits: [{from: '0x' + '0'.repeat(40), to: b.destination.recipient, amountRaw: '9900000'}], ...over}; };
const attested = {status: 'complete', eventNonce: NONCE, destinationTxHash: DEST_TX, forwardState: 'COMPLETE'};

test('release review: an approved payment and a bridge share the same available USDC', async () => {
  const f = await setup();
  try {
    await ready(f, owner, 10_000_000n);
    const payment = await f.cw.payments.send(owner, {requestId: randomUUID(), destination: '0x' + 'd'.repeat(40), amount: '8', service: 'Test service'});
    const p = (await f.cw.state(owner)).payments.find(p => p.id === payment.id);
    await f.cw.payments.decide(owner, {id:p.id, decision:'approve', bindingHash:p.fingerprint});
    const b = await req(f, owner, {amount:'5'});
    await assert.rejects(f.cw.bridge.decide(owner, {id:b.id, decision:'approve', bindingHash:await fp(f,b.id)}), /does not hold enough USDC/);
    assert.equal(f.st.burns.length + f.st.approves.length, 0, 'the conflicting bridge never reaches the provider');
    assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '8.000000');
  } finally { await f.close(); }
});

test('release review: bridge burn recovers after losing its provider response without resending', async () => {
  const f = await setup('base', {allowance:'999999999', burnThrows:true});
  try {
    await ready(f);
    const b = await req(f);
    await f.cw.bridge.decide(owner, {id:b.id, decision:'approve', bindingHash:await fp(f,b.id)});
    await f.store.query("UPDATE relay_cw_bridges SET updated_at=now()-interval '5 minutes' WHERE id=$1", [b.id]);
    f.st.burn = await burnTx(f, b.id);
    const result = await f.cw.bridge.refresh(owner,b.id);
    assert.equal(result.status,'awaiting_attestation');
    assert.equal(f.st.burns.length,1);
  } finally { await f.close(); }
});


test('release review: a Base smart-wallet address is not assumed to be controlled on Arc', async () => {
  const f = await setup();
  try {
    await ready(f);
    const ownBaseAddress = (await f.cw.state(owner)).wallet.address;
    await assert.rejects(req(f, owner, {recipient:ownBaseAddress}), /Arc|destination|same|Base|control/i);
    assert.equal(f.st.burns.length + f.st.approves.length, 0);
  } finally { await f.close(); }
});
