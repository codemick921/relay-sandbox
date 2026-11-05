import {toEventSelector} from 'viem';
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAbiParameters, encodeEventTopics, parseAbi} from 'viem';
import {createCctpUcwTransport, decodeMessage, decodeBurnBody, EVENT_TOPICS} from '../hosted/wallet-bridge-transport.mjs';
import {BRIDGE_ROUTES} from '../shared/wallet-bridge-route.mjs';

const R = BRIDGE_ROUTES.mainnet;
const SCA = '0x' + 'a1'.repeat(20), RECIPIENT = '0x' + 'e'.repeat(40), BUNDLER = '0x' + 'b1'.repeat(20), ENTRYPOINT = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', FORWARDER = '0x' + 'f0'.repeat(20);
const BURN_TX = '0x' + '1'.repeat(64), DEST_TX = '0x' + '3'.repeat(64), NONCE = '0x' + '77'.repeat(32), ZERO = '0x' + '0'.repeat(40);
const b32 = a => '0x' + a.replace('0x', '').toLowerCase().padStart(64, '0'), n32 = n => BigInt(n).toString(16).padStart(64, '0'), u32 = n => Number(n).toString(16).padStart(8, '0');
const EV = parseAbi([
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)']);
const HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000';

// ---- realistic pieces -------------------------------------------------------------------------------------------------------------
const burnBody = (o = {}) => '0x' + u32(1) + b32(o.burnToken ?? R.source.usdc).slice(2) + b32(o.mintRecipient ?? RECIPIENT).slice(2) + n32(o.amount ?? 10_000_000) + b32(o.messageSender ?? SCA).slice(2) + n32(o.maxFee ?? 200_000) + n32(o.feeExecuted ?? 0) + n32(o.expiration ?? 0) + HOOK.slice(2);
const message = (o = {}) => '0x' + u32(1) + u32(o.sourceDomain ?? 6) + u32(o.destinationDomain ?? 26) + (o.nonce ?? '0'.repeat(64)).replace('0x', '') + b32(o.sender ?? R.source.tokenMessenger).slice(2) + b32(o.recipient ?? '0x' + 'cc'.repeat(20)).slice(2) + '0'.repeat(64) + u32(1000) + u32(0) + burnBody(o.body).slice(2);
const depLog = (o = {}) => { const a = o.args ?? {}; const args = {burnToken: R.source.usdc, amount: 10_000_000n, depositor: SCA, mintRecipient: b32(RECIPIENT), destinationDomain: 26, destinationTokenMessenger: b32('0x' + 'cc'.repeat(20)), destinationCaller: b32(ZERO), maxFee: 200_000n, minFinalityThreshold: 1000, hookData: HOOK, ...a};
  return {address: o.address ?? R.source.tokenMessenger, topics: encodeEventTopics({abi: EV, eventName: 'DepositForBurn', args}),
    data: encodeAbiParameters([{type: 'uint256'}, {type: 'bytes32'}, {type: 'uint32'}, {type: 'bytes32'}, {type: 'bytes32'}, {type: 'uint256'}, {type: 'bytes'}], [args.amount, args.mintRecipient, args.destinationDomain, args.destinationTokenMessenger, args.destinationCaller, args.maxFee, args.hookData])}; };
const sentLog = (o = {}) => ({address: o.address ?? R.source.messageTransmitter, topics: encodeEventTopics({abi: EV, eventName: 'MessageSent'}), data: encodeAbiParameters([{type: 'bytes'}], [o.message ?? message(o.msg)])});
const rcvLog = (o = {}) => { const args = {caller: FORWARDER, sourceDomain: 6, nonce: NONCE, sender: b32(R.source.tokenMessenger), finalityThresholdExecuted: 1000, messageBody: burnBody({feeExecuted: 100_000, ...(o.body ?? {})}), ...(o.args ?? {})};
  return {address: o.address ?? R.destination.messageTransmitter, topics: encodeEventTopics({abi: EV, eventName: 'MessageReceived', args: {caller: args.caller, nonce: args.nonce, finalityThresholdExecuted: args.finalityThresholdExecuted}}),
    data: encodeAbiParameters([{type: 'uint32'}, {type: 'bytes32'}, {type: 'bytes'}], [args.sourceDomain, args.sender, args.messageBody])}; };
const transfer = (to, amount, o = {}) => ({address: o.address ?? R.destination.usdc, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', b32(o.from ?? ZERO), b32(to)], data: '0x' + n32(amount)});
// An ERC-4337 receipt: the OUTER transaction is bundler -> EntryPoint; the customer's smart account and the TokenMessenger appear only in logs.
const entryPointReceipt = logs => ({status: '0x1', from: BUNDLER, to: ENTRYPOINT, blockNumber: '0x10', logs: [{address: ENTRYPOINT, topics: ['0x' + '5'.repeat(64)], data: '0x'}, ...logs]});

function world(over = {}) {
  const w = {chainIds: {'https://mainnet.base.org': 8453, 'https://rpc.mainnet.arc.io/': 5042}, receipts: {}, iris: {}, fees: null, calls: [], finalized: 100, latest: 120, ...over};
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') {
      const b = JSON.parse(init.body); w.calls.push({url: u, method: b.method, params: b.params});
      const reply = r => ({ok: true, status: 200, json: async () => ({jsonrpc: '2.0', id: b.id, result: r})});
      if (b.method === 'eth_chainId') return reply('0x' + w.chainIds[u].toString(16));
      if (b.method === 'eth_getTransactionReceipt') return reply(w.receipts[b.params[0]] ?? null);
      if (b.method === 'eth_getBlockByNumber') { if (w.noFinalizedTag) return {ok: true, status: 200, json: async () => ({jsonrpc: '2.0', id: b.id, error: {code: -32602}})}; return reply({number: '0x' + w.finalized.toString(16)}); }
      if (b.method === 'eth_blockNumber') return reply('0x' + w.latest.toString(16));
      if (b.method === 'eth_call') return reply(w.allowanceHex ?? '0x' + n32(0));
    }
    const m = u.match(/\/v2\/messages\/6\?transactionHash=(0x[0-9a-f]+)/i);
    if (m) { if (w.irisDown) return {ok: false, status: 503, json: async () => ({})}; return {ok: true, status: 200, json: async () => ({messages: w.iris[m[1]] ?? []})}; }
    if (u.includes('/v2/burn/USDC/fees/')) { w.calls.push({fees: u}); return {ok: true, status: 200, json: async () => w.fees ?? [{finalityThreshold: 1000, minimumFee: 1.3, forwardFee: {low: 56035, med: 57543, high: 59052}}, {finalityThreshold: 2000, minimumFee: 0, forwardFee: {low: 56035, med: 57543, high: 59052}}]}; }
    throw new Error('unexpected ' + u);
  };
  return {w, fetchImpl};
}
const irisMsg = (o = {}) => ({cctpVersion: 2, status: 'complete', eventNonce: '9682', forwardState: 'COMPLETE', forwardTxHash: DEST_TX, destinationMintTxHash: DEST_TX,
  decodedMessage: {sourceDomain: '6', destinationDomain: '26', decodedMessageBody: {burnToken: R.source.usdc, mintRecipient: RECIPIENT, amount: '10000000', messageSender: SCA}}, ...o});
const circleTx = (o = {}) => ({found: true, expectedUserId: 'u', tx: {id: 't', state: 'COMPLETE', userId: 'u', walletId: 'w-1', blockchain: 'BASE', contractAddress: R.source.tokenMessenger, operation: 'CONTRACT_EXECUTION', sourceAddress: SCA, txHash: BURN_TX, networkFee: '0.00002', refId: 'b:burn', ...o}});
const mk = (extra = {}, over = {}) => { const {w, fetchImpl} = world(over); const provider = {executeContract: async p => (w.calls.push({exec: p}), {challengeId: 'c1'}), estimateContractFee: async p => (w.calls.push({est: p}), {estimateNativeWei: '1000000000000000'}),
  findContractTransaction: async () => w.circle ?? circleTx(), ...extra}; return {w, t: createCctpUcwTransport({provider, fetchImpl})}; };
const binding = {amountRaw: '10000000', destination: {domain: 26, recipient: RECIPIENT}, fees: {maxUsdcFeeRaw: '200000', minFinalityThreshold: 1000}};

test('event topics match the selectors Circle publishes, and messages decode to the documented layout', () => {
  assert.equal(EVENT_TOPICS.messageSent, '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036');
  assert.equal(EVENT_TOPICS.messageReceived, '0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c');
  assert.match(EVENT_TOPICS.depositForBurn, /^0x[0-9a-f]{64}$/);
  const m = decodeMessage(message({body: {amount: 12_345_678}})), b = decodeBurnBody(m.body);
  assert.deepEqual([m.sourceDomain, m.destinationDomain, m.sender], [6, 26, R.source.tokenMessenger.toLowerCase()]);
  assert.deepEqual([b.burnToken, b.mintRecipient, b.amount, b.messageSender, b.maxFee], [R.source.usdc.toLowerCase(), RECIPIENT, '12345678', SCA, '200000']);
  assert.equal(decodeMessage('0x1234'), null); assert.equal(decodeBurnBody('0x12'), null);
});

test('step calls: exact function, parameter order, forwarding hook, zero destination caller, padded recipient', async () => {
  const { t } = mk();
  const ap = t.stepCall(R, 'b', binding, 'approve'), bu = t.stepCall(R, 'b', binding, 'burn');
  assert.deepEqual([ap.contractAddress, ap.abiFunctionSignature, ap.abiParameters], [R.source.usdc, 'approve(address,uint256)', [R.source.tokenMessenger, '10000000']]);
  assert.equal(bu.contractAddress, R.source.tokenMessenger); assert.equal(bu.abiFunctionSignature, 'depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)');
  assert.deepEqual(bu.abiParameters, ['10000000', '26', b32(RECIPIENT), R.source.usdc, '0x' + '0'.repeat(64), '200000', '1000', HOOK]);
});

test('quote: protocol fee rounds up, forwarding fee at the HIGH level, burn estimate asks with source.walletId', async () => {
  const { t, w } = mk();
  const q = await t.quote({route: R, amountRaw: '10000000', walletRef: 'w-1', owner: 'o', recipient: RECIPIENT});
  assert.equal(q.protocolFeeRaw, '1300'); assert.equal(q.forwardFeeRaw, '59052'); assert.equal(q.maxUsdcFeeRaw, '60352'); assert.equal(q.minFinalityThreshold, 1000); assert.equal(q.maxNativeFeeWei, '2000000000000000');
  assert.ok(w.calls.find(c => c.fees).fees.endsWith('/v2/burn/USDC/fees/6/26?forward=true'));
  const est = w.calls.find(c => c.est).est; assert.equal(est.contractAddress, R.source.tokenMessenger); assert.equal(est.walletRef, 'w-1');
  for (const bad of [[], [{finalityThreshold: 1000, minimumFee: 'x', forwardFee: {high: 1}}], [{finalityThreshold: 1000, minimumFee: 1, forwardFee: {high: 1.5}}], {notAList: 1}]) {
    const { t: t2 } = mk({}, {fees: bad}); await assert.rejects(t2.quote({route: R, amountRaw: '10000000', walletRef: 'w', owner: 'o', recipient: RECIPIENT}), /fee/);
  }
});

test('a burn made through an ERC-4337 smart account verifies from the logs, not from the outer bundler transaction', async () => {
  const { t, w } = mk();
  w.receipts[BURN_TX] = entryPointReceipt([depLog(), sentLog()]); w.iris[BURN_TX] = [irisMsg()];
  assert.notEqual(w.receipts[BURN_TX].to.toLowerCase(), R.source.tokenMessenger.toLowerCase()); assert.notEqual(w.receipts[BURN_TX].from.toLowerCase(), SCA);
  const f = await t.findBurn({route: R, bridgeId: 'b', walletRef: 'w-1', owner: 'o'});
  assert.equal(f.found, true);
  assert.deepEqual([f.tx.contract, f.tx.from, f.tx.burnToken, f.tx.amountRaw, f.tx.destinationDomain, f.tx.mintRecipient, f.tx.chainId, f.tx.maxFee, f.tx.minFinalityThreshold],
    [R.source.tokenMessenger.toLowerCase(), SCA, R.source.usdc.toLowerCase(), '10000000', 26, RECIPIENT, 8453, '200000', 1000]);
  assert.equal(f.tx.eventNonce, '9682'); assert.equal(f.tx.walletId, 'w-1');
});

test('burn evidence that is not exactly this burn is uncertain: spoofed logs, duplicates, disagreeing message, other depositor, failure, bad attestation', async () => {
  const cases = {
    'no DepositForBurn': [sentLog()], 'no MessageSent': [depLog()], 'two burns in one transaction': [depLog(), depLog(), sentLog()],
    'DepositForBurn emitted by another contract': [depLog({address: '0x' + '9'.repeat(40)}), sentLog()], 'MessageSent emitted by another contract': [depLog(), sentLog({address: '0x' + '9'.repeat(40)})],
    'message amount differs': [depLog(), sentLog({msg: {body: {amount: 10_000_001}}})], 'message recipient differs': [depLog(), sentLog({msg: {body: {mintRecipient: '0x' + '7'.repeat(40)}}})],
    'message depositor differs': [depLog(), sentLog({msg: {body: {messageSender: '0x' + '7'.repeat(40)}}})], 'message domain differs': [depLog(), sentLog({msg: {destinationDomain: 7}})],
    'message sender is not the TokenMessenger': [depLog(), sentLog({msg: {sender: '0x' + '7'.repeat(40)}})], 'maxFee differs': [depLog(), sentLog({msg: {body: {maxFee: 1}}})],
    'depositor is not the Circle wallet': [depLog({args: {depositor: '0x' + '7'.repeat(40)}}), sentLog({msg: {body: {messageSender: '0x' + '7'.repeat(40)}}})],
  };
  for (const [name, logs] of Object.entries(cases)) {
    const { t, w } = mk(); w.receipts[BURN_TX] = entryPointReceipt(logs); w.iris[BURN_TX] = [irisMsg()];
    assert.equal((await t.findBurn({route: R, bridgeId: 'b', walletRef: 'w-1', owner: 'o'})).uncertain, true, name);
  }
  const ok = [depLog(), sentLog()];
  for (const [name, setup] of Object.entries({
    'receipt reverted': w => { w.receipts[BURN_TX] = {...entryPointReceipt(ok), status: '0x0'}; }, 'receipt not found yet': w => { delete w.receipts[BURN_TX]; },
    'no attested message': w => { w.iris[BURN_TX] = []; }, 'two attested messages': w => { w.iris[BURN_TX] = [irisMsg(), irisMsg()]; }, 'Iris unreachable': w => { w.irisDown = true; },
    'attested amount differs': w => { w.iris[BURN_TX] = [irisMsg({decodedMessage: {sourceDomain: '6', destinationDomain: '26', decodedMessageBody: {burnToken: R.source.usdc, mintRecipient: RECIPIENT, amount: '9', messageSender: SCA}}})]; },
    'wrong chain behind the RPC': w => { w.chainIds['https://mainnet.base.org'] = 1; }, 'Circle tx hash malformed': w => { w.circle = circleTx({txHash: 'nope'}); },
  })) {
    const { t, w } = mk(); w.receipts[BURN_TX] = entryPointReceipt(ok); w.iris[BURN_TX] = [irisMsg()]; setup(w);
    assert.equal((await t.findBurn({route: R, bridgeId: 'b', walletRef: 'w-1', owner: 'o'})).uncertain, true, name);
  }
  const { t, w } = mk(); w.circle = circleTx({state: 'FAILED'});                      // Circle's own failure record: reported, not hidden
  assert.equal((await t.findBurn({route: R, bridgeId: 'b', walletRef: 'w-1', owner: 'o'})).uncertain, true);
});

test('the arrival is read from this transaction\'s own MessageReceived and mint, through Circle\'s forwarder (outer transaction is not the proof)', async () => {
  const { t, w } = mk();
  w.receipts[DEST_TX] = {status: '0x1', from: BUNDLER, to: FORWARDER, blockNumber: '0x10', logs: [rcvLog(), transfer(RECIPIENT, 9_900_000), transfer('0x' + 'fe'.repeat(20), 100_000), transfer('0x' + '12'.repeat(20), 5, {from: '0x' + '34'.repeat(20)})]};
  const d = await t.verifyDestination({route: R, destinationTxHash: DEST_TX});
  assert.equal(d.found, true); assert.equal(d.success, true); assert.equal(d.finalized, true); assert.equal(d.chainId, 5042);
  assert.deepEqual(d.message, {nonce: BigInt(NONCE).toString(), sourceDomain: 6, sender: R.source.tokenMessenger.toLowerCase(), burnToken: R.source.usdc.toLowerCase(), mintRecipient: RECIPIENT, amount: '10000000', messageSender: SCA, maxFee: '200000', feeExecuted: '100000'});
  assert.deepEqual(d.credits.map(c => [c.to, c.amountRaw]), [[RECIPIENT, '9900000'], ['0x' + 'fe'.repeat(20), '100000']], 'only mints (from the zero address) count; an ordinary transfer in the same receipt is ignored');
  assert.equal(w.calls.some(c => c.method === 'eth_call'), false, 'no global usedNonces check stands in for the receipt\'s own event');
});

test('an arrival receipt without exactly one genuine MessageReceived carries no message', async () => {
  for (const [name, logs] of Object.entries({
    'only an unrelated USDC transfer': [transfer(RECIPIENT, 9_900_000)], 'MessageReceived from another contract': [rcvLog({address: '0x' + '9'.repeat(40)}), transfer(RECIPIENT, 9_900_000)],
    'two MessageReceived': [rcvLog(), rcvLog(), transfer(RECIPIENT, 9_900_000)], 'body too short to be a burn': [rcvLog({args: {messageBody: '0x1234'}})],
  })) {
    const { t, w } = mk(); w.receipts[DEST_TX] = {status: '0x1', from: BUNDLER, to: FORWARDER, blockNumber: '0x10', logs};
    assert.equal((await t.verifyDestination({route: R, destinationTxHash: DEST_TX})).message, null, name);
  }
  const { t, w } = mk(); assert.deepEqual(await t.verifyDestination({route: R, destinationTxHash: DEST_TX}), {found: false});
  w.receipts[DEST_TX] = {status: '0x0', blockNumber: '0x10', logs: []}; assert.equal((await t.verifyDestination({route: R, destinationTxHash: DEST_TX})).success, false);
  const fresh = mk({}, {chainIds: {'https://mainnet.base.org': 8453, 'https://rpc.mainnet.arc.io/': 1}}); fresh.w.receipts[DEST_TX] = {status: '0x1', blockNumber: '0x10', logs: []};
  await assert.rejects(fresh.t.verifyDestination({route: R, destinationTxHash: DEST_TX}), /wrong chain/);
});

test('finality: the finalized tag is used when the chain has it, and a depth rule is the stated fallback', async () => {
  const mkR = over => { const x = mk({}, over); x.w.receipts[DEST_TX] = {status: '0x1', blockNumber: '0x10', logs: [rcvLog(), transfer(RECIPIENT, 9_900_000)]}; return x; };
  assert.equal((await mkR({finalized: 15}).t.verifyDestination({route: R, destinationTxHash: DEST_TX})).finalized, false);
  assert.equal((await mkR({finalized: 16}).t.verifyDestination({route: R, destinationTxHash: DEST_TX})).finalized, true);
  assert.equal((await mkR({noFinalizedTag: true, latest: 16 + 31}).t.verifyDestination({route: R, destinationTxHash: DEST_TX})).finalized, false);
  assert.equal((await mkR({noFinalizedTag: true, latest: 16 + 32}).t.verifyDestination({route: R, destinationTxHash: DEST_TX})).finalized, true);
});

test('attestation reports complete only when attested AND the forwarded mint is observed; allowance reads the TokenMessenger spender', async () => {
  const { t, w } = mk();
  w.iris[BURN_TX] = [irisMsg({forwardState: 'PENDING', destinationMintTxHash: undefined, forwardTxHash: DEST_TX})];
  assert.equal((await t.attestation({route: R, burnTxHash: BURN_TX})).status, 'pending');
  w.iris[BURN_TX] = [irisMsg({status: 'pending_confirmations'})]; assert.equal((await t.attestation({route: R, burnTxHash: BURN_TX})).status, 'pending');
  w.iris[BURN_TX] = [irisMsg(), irisMsg()]; assert.equal((await t.attestation({route: R, burnTxHash: BURN_TX})).status, 'uncertain');
  w.iris[BURN_TX] = [irisMsg()]; const a = await t.attestation({route: R, burnTxHash: BURN_TX});
  assert.deepEqual([a.status, a.eventNonce, a.destinationTxHash], ['complete', '9682', DEST_TX]);
  w.allowanceHex = '0x' + n32(7_000_000); assert.equal(await t.allowance({route: R, walletAddress: SCA}), '7000000');
  const call = w.calls.filter(c => c.method === 'eth_call').at(-1).params[0];
  assert.equal(call.to, R.source.usdc); assert.equal(call.data.slice(0, 10), '0xdd62ed3e'); assert.ok(call.data.endsWith(R.source.tokenMessenger.slice(2).toLowerCase()));
});


test('approval proof binds wallet, chain, reference, spender and amount in the same smart-account receipt', async () => {
  const {t,w} = mk();
  const bd = {...binding, source:{address:SCA}};
  w.circle = circleTx({contractAddress:R.source.usdc,refId:'b:approve'});
  const log = {address:R.source.usdc,topics:[toEventSelector('Approval(address,address,uint256)'),b32(SCA),b32(R.source.tokenMessenger)],data:'0x'+n32(10_000_000)};
  w.receipts[BURN_TX] = entryPointReceipt([log]);
  const q = {route:R,bridgeId:'b',walletRef:'w-1',owner:'o',binding:bd};
  assert.equal((await t.findApprove(q)).tx.contractOk,true);
  for (const change of [{walletId:'other'},{blockchain:'ETH'},{refId:'other:approve'},{userId:'other'}]) {
    w.circle = circleTx({contractAddress:R.source.usdc,refId:'b:approve',...change});
    assert.equal((await t.findApprove(q)).uncertain,true);
  }
  w.circle = circleTx({contractAddress:R.source.usdc,refId:'b:approve'});
  w.receipts[BURN_TX] = entryPointReceipt([{...log,data:'0x'+n32(11_000_000)}]);
  assert.equal((await t.findApprove(q)).uncertain,true);
});
