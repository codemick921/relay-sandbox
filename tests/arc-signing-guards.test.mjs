// Focused tests for the customer-wallet signing seam: speed mapping, fee cap / minimum output, and retry
// result validation. Pure and in-memory: fake wallet, fake Bridge Kit, no keys, no network, no transaction.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {approvalBinding, arcQuote, canonicalBinding, units} from '../shared/arc-funding.mjs';
import * as signing from '../src/arc-customer-signing.mjs';

const {SigningGatedError, createCustomerBridgeSigner, bridgeParams, estimateParams, checkEstimate, assertResultMatches, parseUsdcRaw, transferSpeedFor, sha256Hex} = signing;
const SOURCE = '0x' + 'a'.repeat(40), RECIPIENT = '0x7e57' + '0'.repeat(35) + '1', OTHER = '0x' + 'b'.repeat(40);
const gate = {approved: true, reviewed: {dependencies: true, permissions: true, custody: true, privyConfig: true}};

function setup(speed = 'fast', pence = 2500) {
  const quote = {...arcQuote({pence, speed}), id: randomUUID()};
  const binding = approvalBinding({
    source: {walletId: randomUUID(), address: SOURCE, chain: 'Base Sepolia'},
    destination: {mode: 'external_test', id: randomUUID(), revision: 1, label: 'Agent', address: RECIPIENT, chain: 'Arc Testnet'}, quote,
  });
  return {quote, binding};
}
const approvalFor = async binding => ({status: 'approved', binding, bindingHash: await sha256Hex(canonicalBinding(binding)), executedAt: null});
const maxFee = b => units(b.quote.bridgeFeeRaw);
const goodEstimate = (b, parts = 1) => {
  // Split the approved cap across `parts` fees that add up exactly to it.
  const total = BigInt(b.quote.bridgeFeeRaw), each = total / BigInt(parts);
  const fees = Array.from({length: parts}, (_, i) => ({type: i ? 'forwarder' : 'provider', token: 'USDC', amount: units(i === parts - 1 ? total - each * BigInt(parts - 1) : each)}));
  return {amount: units(b.amountRaw), destination: {recipientAddress: b.destination.address}, fees};
};
const goodResult = (b, patch = {}) => ({
  token: 'USDC', state: 'error', amount: units(b.amountRaw),
  source: {address: b.source.address, chain: {chain: 'Base_Sepolia', chainId: 84532}},
  destination: {address: b.destination.address, recipientAddress: b.destination.address, useForwarder: true, chain: {chain: 'Arc_Testnet', chainId: 5042002}},
  config: {transferSpeed: transferSpeedFor[b.quote.speed], maxFee: maxFee(b)}, ...patch,
});
function harness(estimateFor = goodEstimate) {
  const order = [];
  const wallet = {address: SOURCE, walletClientType: 'privy', switchChain: async id => { order.push(['switchChain', id]); }, getEthereumProvider: async () => { order.push(['provider']); return {id: 'eip1193'}; }};
  const kit = {
    estimate: async p => { order.push(['estimate', p]); return estimateFor(binding0, 1, p); },
    bridge: async p => { order.push(['bridge', p]); return {state: 'success'}; },
    retry: async (r, c) => { order.push(['retry', r, c]); return {state: 'success'}; },
  };
  let binding0;
  return {order, wallet, kit, bind: b => { binding0 = b; }, signer: createCustomerBridgeSigner({gate, wallet, createAdapterFromProvider: async ({provider}) => ({provider}), kit})};
}

test('the approved speed is mapped explicitly; anything else fails closed', async () => {
  assert.deepEqual({...transferSpeedFor}, {fast: 'FAST', standard: 'SLOW'});
  for (const [speed, sdk] of [['fast', 'FAST'], ['standard', 'SLOW']]) {
    const {binding} = setup(speed);
    const params = bridgeParams(binding, {a: 1});
    assert.equal(params.config.transferSpeed, sdk, speed);
    assert.equal(params.config.maxFee, units(binding.quote.bridgeFeeRaw), 'the SDK fee cap is the approved cap');
    assert.equal(params.config.batchTransactions, false, 'the customer sees the approve and the burn as separate steps');
    assert.equal('customFee' in params.config, false, 'no developer fee is ever added on top of the amount');
    assert.equal(params.amount, units(binding.amountRaw));
    assert.deepEqual(params.to, {chain: 'Arc_Testnet', recipientAddress: RECIPIENT, useForwarder: true});
    assert.notEqual(params.to.recipientAddress, binding.source.address);
  }
  const {binding} = setup('fast');
  for (const speed of ['instant', 'FAST', 'slow', '', undefined, null]) {
    const b = structuredClone(binding); b.quote.speed = speed;
    assert.throws(() => bridgeParams(b, {a: 1}), SigningGatedError, String(speed));
  }
  // The approved terms must be internally consistent: amount - fee cap = minimum received.
  for (const edit of [b => { b.quote.bridgeFeeRaw = '1'; }, b => { b.quote.estimatedArcRaw = '1'; }, b => { b.amountRaw = '0'; }, b => { b.quote.bridgeFeeRaw = 'x'; }]) {
    const b = structuredClone(binding); edit(b);
    assert.throws(() => bridgeParams(b, {a: 1}), SigningGatedError);
  }
});

test('fee cap and minimum output are enforced from the SDK estimate, exactly, and fail closed', () => {
  assert.equal(parseUsdcRaw('0.085000'), 85000n);
  assert.equal(parseUsdcRaw('12'), 12000000n);
  for (const bad of ['0.0000001', '1e3', '-1', '', null, undefined, 5, '1,5', ' 1', '0x10']) assert.throws(() => parseUsdcRaw(bad), SigningGatedError, String(bad));
  for (const speed of ['fast', 'standard']) {
    const {binding} = setup(speed);
    const ok = checkEstimate(binding, goodEstimate(binding, 2));
    assert.equal(ok.feesRaw, BigInt(binding.quote.bridgeFeeRaw), 'two fees are summed exactly');
    assert.equal(ok.outputRaw, BigInt(binding.quote.estimatedArcRaw));
    // Cheaper than approved is fine.
    const cheaper = goodEstimate(binding); cheaper.fees[0].amount = '0.000000';
    assert.ok(checkEstimate(binding, cheaper).outputRaw > BigInt(binding.quote.estimatedArcRaw));
    // One unit over the cap is refused.
    const over = goodEstimate(binding); over.fees[0].amount = units(BigInt(binding.quote.bridgeFeeRaw) + 1n);
    assert.throws(() => checkEstimate(binding, over), /above the .* you approved/);
    // Fees that cannot be read, are missing, or are in another token are refused.
    for (const mutate of [e => { e.fees = []; }, e => { e.fees = undefined; }, e => { e.fees[0].amount = null; }, e => { e.fees[0].error = new Error('x'); }, e => { e.fees[0].token = 'EURC'; }, e => { e.fees[0].type = 'unknown'; }, e => { e.fees[0].amount = '0.0000001'; }]) {
      const e = goodEstimate(binding); mutate(e);
      assert.throws(() => checkEstimate(binding, e), SigningGatedError);
    }
    // An application ("kit") fee that the customer did not approve is refused; a zero one is fine.
    const kitFee = goodEstimate(binding); kitFee.fees.push({type: 'kit', token: 'USDC', amount: '0.000001'});
    assert.throws(() => checkEstimate(binding, kitFee), /application fee|above the/);
    const zeroKit = goodEstimate(binding); zeroKit.fees[0].amount = units(BigInt(binding.quote.bridgeFeeRaw) - 0n); zeroKit.fees.push({type: 'kit', token: 'USDC', amount: '0.000000'});
    assert.ok(checkEstimate(binding, zeroKit));
    // A different quoted amount or recipient is refused.
    const amountMismatch = goodEstimate(binding); amountMismatch.amount = units(BigInt(binding.amountRaw) + 1n);
    assert.throws(() => checkEstimate(binding, amountMismatch), /different amount/);
    const recipientMismatch = goodEstimate(binding); recipientMismatch.destination.recipientAddress = OTHER;
    assert.throws(() => checkEstimate(binding, recipientMismatch), /different recipient/);
  }
});

test('execute estimates first and prompts the wallet only if the live fees are within the approval', async () => {
  const {binding} = setup('standard');
  const approval = await approvalFor(binding);
  // Within the cap: estimate, then chain switch, then bridge, in that order.
  {
    const h = harness(); h.bind(binding);
    await h.signer.execute(approval);
    const names = h.order.map(c => c[0]);
    assert.deepEqual(names.filter(n => n !== 'provider'), ['estimate', 'switchChain', 'bridge']);
    const bridge = h.order.find(c => c[0] === 'bridge')[1];
    assert.equal(bridge.config.transferSpeed, 'SLOW');
    // The live quote is requested WITHOUT our cap (the SDK would echo a supplied cap back); the burn carries the cap.
    const est = h.order.find(c => c[0] === 'estimate')[1];
    assert.equal('maxFee' in est.config, false);
    assert.equal(est.config.transferSpeed, bridge.config.transferSpeed);
    assert.deepEqual(est.to, bridge.to);
    assert.equal(est.amount, bridge.amount);
    assert.equal(bridge.config.maxFee, units(binding.quote.bridgeFeeRaw));
  }
  // Over the cap: nothing is signed and the wallet is never asked to switch chain.
  for (const bad of [(b, _p, _q) => { const e = goodEstimate(b); e.fees[0].amount = units(BigInt(b.quote.bridgeFeeRaw) + 1n); return e; }, () => ({fees: []}), () => ({})]) {
    const h = harness(bad); h.bind(binding);
    await assert.rejects(h.signer.execute(approval), SigningGatedError);
    assert.equal(h.order.some(c => c[0] === 'switchChain' || c[0] === 'bridge'), false, 'no chain switch, no approval prompt, no burn');
  }
  // The estimate method refuses the same way, and a pending approval cannot even be estimated.
  const h = harness(() => ({fees: []})); h.bind(binding);
  await assert.rejects(h.signer.estimate(approval), SigningGatedError);
  await assert.rejects(h.signer.estimate({...approval, status: 'pending'}), /Only an approval you made/);
});

test('retry refuses a result from another source, destination, amount, speed or fee cap before any wallet or SDK action', async () => {
  const {binding} = setup('fast');
  const approval = {...(await approvalFor(binding)), executedAt: '2026-11-05T12:00:00Z'};
  const cases = {
    'another source account': goodResult(binding, {source: {address: OTHER, chain: {chain: 'Base_Sepolia', chainId: 84532}}}),
    'another source chain (Base mainnet)': goodResult(binding, {source: {address: SOURCE, chain: {chain: 'Base', chainId: 8453}}}),
    'another source chain (Ethereum Sepolia)': goodResult(binding, {source: {address: SOURCE, chain: {chain: 'Ethereum_Sepolia', chainId: 11155111}}}),
    'another destination chain (Arc mainnet)': goodResult(binding, {destination: {...goodResult(binding).destination, chain: {chain: 'Arc', chainId: 5042}}}),
    'another destination chain (Base Sepolia)': goodResult(binding, {destination: {...goodResult(binding).destination, chain: {chain: 'Base_Sepolia', chainId: 84532}}}),
    'another recipient': goodResult(binding, {destination: {...goodResult(binding).destination, recipientAddress: OTHER}}),
    'no recipient': goodResult(binding, {destination: {...goodResult(binding).destination, recipientAddress: undefined}}),
    'not forwarded': goodResult(binding, {destination: {...goodResult(binding).destination, useForwarder: false}}),
    'a larger amount': goodResult(binding, {amount: units(BigInt(binding.amountRaw) + 1n)}),
    'a smaller amount': goodResult(binding, {amount: units(BigInt(binding.amountRaw) - 1n)}),
    'an unreadable amount': goodResult(binding, {amount: '25.0000001'}),
    'another speed': goodResult(binding, {config: {transferSpeed: 'SLOW', maxFee: maxFee(binding)}}),
    'no speed (SDK default is FAST)': goodResult(binding, {config: {maxFee: maxFee(binding)}}),
    'a higher fee cap': goodResult(binding, {config: {transferSpeed: 'FAST', maxFee: units(BigInt(binding.quote.bridgeFeeRaw) + 1n)}}),
    'no fee cap (SDK default is 0)': goodResult(binding, {config: {transferSpeed: 'FAST'}}),
    'a custom fee': goodResult(binding, {config: {transferSpeed: 'FAST', maxFee: maxFee(binding), customFee: {value: '0.5', recipientAddress: OTHER}}}),
    'another token': goodResult(binding, {token: 'EURC'}),
    'already complete': goodResult(binding, {state: 'success'}),
    'unknown state': goodResult(binding, {state: 'weird'}),
    'no result': undefined,
    'a string': 'retry me',
  };
  for (const [name, result] of Object.entries(cases)) {
    const h = harness(); h.bind(binding);
    await assert.rejects(h.signer.retry(approval, result), SigningGatedError, name);
    assert.deepEqual(h.order, [], `${name}: no provider, no chain switch, no SDK call`);
  }
  // The matching result, in either failed or pending state, is retried with only the source adapter.
  for (const state of ['error', 'pending']) {
    const h = harness(); h.bind(binding);
    const result = goodResult(binding, {state});
    await h.signer.retry(approval, result);
    const call = h.order.find(c => c[0] === 'retry');
    assert.equal(call[1], result);
    assert.deepEqual(Object.keys(call[2]), ['from']);
    assert.equal(h.order.filter(c => c[0] === 'switchChain').length, 1);
  }
  // A retry still needs a real approval: a pending one, or one whose details were edited, is refused first.
  const h = harness(); h.bind(binding);
  await assert.rejects(h.signer.retry({...approval, status: 'denied'}, goodResult(binding)), /Only an approval you made/);
  const edited = structuredClone(approval); edited.binding.destination.address = OTHER;
  await assert.rejects(h.signer.retry(edited, goodResult(binding)), /do not match what you approved/);
  assert.deepEqual(h.order, []);
});

test('assertResultMatches accepts exactly the approved transfer, for both speeds and amounts', () => {
  for (const speed of ['fast', 'standard']) for (const pence of [200, 1999, 2500, 100000]) {
    const {binding} = setup(speed, pence);
    assert.equal(assertResultMatches(binding, goodResult(binding)), true);
    assert.equal(assertResultMatches(binding, goodResult(binding, {state: 'pending'})), true);
  }
});

test('the quote request omits the cap, and everything else matches what is later signed', () => {
  const {binding} = setup('fast');
  const bridge = bridgeParams(binding, {a: 1}), quote = estimateParams(binding, {a: 1});
  assert.equal('maxFee' in quote.config, false);
  assert.deepEqual({...quote, config: undefined}, {...bridge, config: undefined});
  assert.deepEqual(quote.config, {transferSpeed: bridge.config.transferSpeed, batchTransactions: false});
});
