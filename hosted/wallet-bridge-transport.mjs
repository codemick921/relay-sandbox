// The Base -> Arc transport: everything the bridge state machine needs from the outside world, built from Circle's documented
// CCTP v2 Forwarding Service flow (approve, depositForBurnWithHook with the forwarding hook, Iris attestation, forwarded mint on Arc).
//   * It only PREPARES customer-approved challenges (the PIN step is the customer's) and READS everything else.
//   * Every answer is evidence, never a conclusion: the state machine compares it with what the customer approved.
//   * Reads of the chains use the RPC endpoints in the route table (Circle Bridge Kit chain data) and check the chain id first.
// Not yet exercised against a live Circle account or chain: see docs/customer-wallet.md "Not verified against Circle".
import {toEventSelector, parseAbi, decodeEventLog} from 'viem';

const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000'; // "cctp-forward", version 0, length 0 (Circle docs)
const ZERO32 = '0x' + '0'.repeat(64);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // keccak("Transfer(address,address,uint256)")
const SEL_ALLOWANCE = '0xdd62ed3e';
// Event ABIs exactly as in Circle's evm-cctp-contracts (TokenMessengerV2 / MessageTransmitterV2). The topics are pinned by a test against
// the selectors Circle publishes, so a typo here cannot silently make a wrong log "verify".
const EVENTS = parseAbi([
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
]);
export const EVENT_TOPICS = Object.freeze({depositForBurn: toEventSelector(EVENTS[0]), messageSent: toEventSelector(EVENTS[1]), messageReceived: toEventSelector(EVENTS[2])});
const lower = v => String(v ?? '').toLowerCase();
const word = (hex, off) => '0x' + hex.slice(off * 2, off * 2 + 64);
const u32 = (hex, off) => parseInt(hex.slice(off * 2, off * 2 + 8), 16);
// CCTP v2 message: version4 sourceDomain4 destinationDomain4 nonce32 sender32 recipient32 destinationCaller32 minFinality4 finalityExecuted4 body.
export function decodeMessage(message) {
  const h = String(message ?? '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(h) || h.length < 148 * 2) return null;
  return {sourceDomain: u32(h, 4), destinationDomain: u32(h, 8), nonce: word(h, 12), sender: addr(word(h, 44)), recipient: addr(word(h, 76)), destinationCaller: word(h, 108), body: h.slice(148 * 2)};
}
// BurnMessageV2 body: version4 burnToken32 mintRecipient32 amount32 messageSender32 maxFee32 feeExecuted32 expirationBlock32 hookData.
export function decodeBurnBody(body) {
  const h = String(body ?? '').replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(h) || h.length < 228 * 2) return null;
  return {burnToken: addr(word(h, 4)), mintRecipient: addr(word(h, 36)), amount: BigInt(word(h, 68)).toString(), messageSender: addr(word(h, 100)), maxFee: BigInt(word(h, 132)).toString(), feeExecuted: BigInt(word(h, 164)).toString()};
}
const IRIS = {mainnet: 'https://iris-api.circle.com', testnet: 'https://iris-api-sandbox.circle.com'};
const pad32 = hex => '0x' + String(hex).replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const addr = hex32 => '0x' + String(hex32 ?? '').replace(/^0x/i, '').slice(-40).toLowerCase();
const big = v => BigInt(String(v));
const hex0x = /^0x[0-9a-fA-F]*$/;
export const STEP_REF = (bridgeId, step) => `${bridgeId}:${step}`;

export function createCctpUcwTransport({provider, fetchImpl = globalThis.fetch, timeoutMs = 8000, rpcUrls = {}, irisBase = {}, finalityDepth = 32}) {
  if (!provider || typeof provider.executeContract !== 'function') throw new Error('A user-controlled wallet provider with contract execution is required.');
  const iris = env => (irisBase[env] ?? IRIS[env]).replace(/\/$/, '');
  const json = async (url, init) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await fetchImpl(url, {...init, signal: ctl.signal}); if (!r.ok) throw Object.assign(new Error('http ' + r.status), {status: r.status}); return await r.json(); } finally { clearTimeout(t); }
  };
  let rid = 0;
  const rpc = async (url, method, params = []) => {
    const out = await json(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: ++rid, method, params})});
    if (!out || out.error || !('result' in out)) throw new Error('rpc ' + method);
    return out.result;
  };
  const checked = new Map();
  // The endpoint must be the chain we think it is, or nothing it says is used.
  const chain = async (side, route) => {
    const spec = route[side], url = rpcUrls[spec.kitId] ?? spec.rpc, key = url + spec.chainId;
    if (!checked.has(key)) { const id = Number(await rpc(url, 'eth_chainId')); if (id !== spec.chainId) throw new Error('wrong chain'); checked.set(key, true); }
    return {url, spec};
  };
  const messageFor = async (route, burnTxHash) => {
    const out = await json(`${iris(route.environment)}/v2/messages/${route.source.domain}?transactionHash=${burnTxHash}`);
    const msgs = Array.isArray(out?.messages) ? out.messages : [];
    return msgs.length === 1 ? msgs[0] : msgs.length === 0 ? null : 'many';
  };
  const step = (route, bridgeId, binding, which, extra = {}) => {
    const src = route.source, base = {contractAddress: which === 'approve' ? src.usdc : src.tokenMessenger};
    if (which === 'approve') return {...base, abiFunctionSignature: 'approve(address,uint256)', abiParameters: [src.tokenMessenger, binding.amountRaw]};
    return {...base, abiFunctionSignature: 'depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)',
      abiParameters: [binding.amountRaw, String(binding.destination.domain), pad32(binding.destination.recipient), src.usdc, ZERO32, binding.fees.maxUsdcFeeRaw, String(binding.fees.minFinalityThreshold), FORWARD_HOOK]};
  };
  const identityMatches = (f, route, bridgeId, walletRef, which) => {
    const t = f.tx;
    return !!t && t.walletId === walletRef && t.blockchain === route.source.circleChain
      && t.refId === STEP_REF(bridgeId, which) && !!t.userId && t.userId === f.expectedUserId
      && lower(t.contractAddress) === lower(which === 'approve' ? route.source.usdc : route.source.tokenMessenger);
  };
  const callMatches = (t, route, bridgeId, binding, which) => {
    if (!binding) return false;
    const wanted = step(route, bridgeId, binding, which);
    return t.abiFunctionSignature === wanted.abiFunctionSignature && Array.isArray(t.abiParameters)
      && t.abiParameters.length === wanted.abiParameters.length
      && t.abiParameters.every((v, i) => lower(v) === lower(wanted.abiParameters[i]));
  };
  return {
    stepCall: step, FORWARD_HOOK,
    // Circle's fee API, read fresh every time (never cached or hardcoded): the protocol fee is quoted in basis points, possibly fractional
    // (0.325 for fast transfers, 0 for standard), and the forwarding fee in USDC minor units at low/med/high. Exact integer arithmetic;
    // the protocol fee is rounded UP and the forwarding fee is taken at its HIGH level. Anything unreadable fails the quote.
    async quote({route, amountRaw, walletRef, owner, recipient}) {
      const rows = await json(`${iris(route.environment)}/v2/burn/USDC/fees/${route.source.domain}/${route.destination.domain}?forward=true`);
      const pick = Array.isArray(rows) ? (rows.find(r => r.finalityThreshold === 1000) ?? rows.find(r => r.finalityThreshold === 2000)) : null;
      const fwd = pick?.forwardFee?.high, bpsText = String(pick?.minimumFee ?? '');
      if (!pick || !/^\d+(\.\d{1,6})?$/.test(bpsText) || !/^\d+$/.test(String(fwd))) throw new Error('unreadable fee quote');
      const [bi, bf = ''] = bpsText.split('.'), microBps = BigInt(bi) * 1_000_000n + BigInt(bf.padEnd(6, '0'));
      const amt = big(amountRaw), protocol = (amt * microBps + 9_999_999_999n) / 10_000_000_000n;     // bps = 1e-4, micro-bps = 1e-6
      const maxFee = protocol + BigInt(fwd);
      let native = '0';
      if (provider.feeModel?.asset !== 'sponsored') {
        const probe = step(route, 'quote', {amountRaw: String(amt), destination: {domain: route.destination.domain, recipient}, fees: {maxUsdcFeeRaw: String(maxFee), minFinalityThreshold: pick.finalityThreshold}}, 'burn');
        native = String(BigInt((await provider.estimateContractFee({owner, walletRef, ...probe})).estimateNativeWei) * 2n);   // approve + burn: an estimate
      }
      return {maxUsdcFeeRaw: String(maxFee), forwardFeeRaw: String(fwd), protocolFeeRaw: String(protocol), minFinalityThreshold: pick.finalityThreshold, maxNativeFeeWei: native};
    },
    async allowance({route, walletAddress}) {
      const {url, spec} = await chain('source', route);
      const data = SEL_ALLOWANCE + pad32(walletAddress).slice(2) + pad32(spec.tokenMessenger).slice(2);
      const out = await rpc(url, 'eth_call', [{to: spec.usdc, data}, 'latest']);
      if (!hex0x.test(out) || out.length < 3) throw new Error('unreadable allowance');
      return BigInt(out).toString();
    },
    // Challenges only. The customer completes them with their PIN; both are idempotent per bridge step.
    submitApprove({route, bridgeId, binding, walletRef, owner}) { return provider.executeContract({owner, walletRef, refId: STEP_REF(bridgeId, 'approve'), idempotencyKey: STEP_REF(bridgeId, 'approve'), ...step(route, bridgeId, binding, 'approve')}); },
    submitBurn({route, bridgeId, binding, walletRef, owner}) { return provider.executeContract({owner, walletRef, refId: STEP_REF(bridgeId, 'burn'), idempotencyKey: STEP_REF(bridgeId, 'burn'), ...step(route, bridgeId, binding, 'burn')}); },
    // What Circle holds for the approval step, verified against the approval by the caller.
    async findApprove({route, bridgeId, walletRef, owner, binding}) {
      const f = await provider.findContractTransaction({owner, walletRef, refId: STEP_REF(bridgeId, 'approve')});
      if (f.uncertain || !f.found) return f;
      if (!identityMatches(f, route, bridgeId, walletRef, 'approve') || !binding) return {uncertain: true};
      let valid = callMatches(f.tx, route, bridgeId, binding, 'approve');
      if (f.tx.state === 'COMPLETE') {
        // A smart account's outer transaction is a bundler call. Bind the actual ERC20 Approval event instead.
        const {url, spec} = await chain('source', route);
        const rc = await rpc(url, 'eth_getTransactionReceipt', [f.tx.txHash]);
        const approvalTopic = toEventSelector('Approval(address,address,uint256)');
        const logs = (rc?.logs ?? []).filter(l => lower(l.address) === lower(spec.usdc)
          && l.topics?.length === 3 && l.topics[0] === approvalTopic
          && addr(l.topics[1]) === lower(binding.source.address) && addr(l.topics[2]) === lower(spec.tokenMessenger));
        valid = rc?.status === '0x1' && logs.length === 1 && BigInt(logs[0].data) === BigInt(binding.amountRaw);
      }
      return valid ? {found: true, tx: {...f.tx, contractOk: true}, expectedUserId: f.expectedUserId} : {uncertain: true};
    },
    // The burn. Proven from the CHAIN'S OWN LOGS in the burn transaction, not from the outer transaction's from/to: a smart-contract
    // account sends through a bundler and the EntryPoint, so those fields are not the customer or the TokenMessenger. The proof is:
    // Circle's record (this wallet, COMPLETE, sourceAddress) + exactly one DepositForBurn log from the TokenMessengerV2 + exactly one MessageSent
    // log from the MessageTransmitterV2 whose message agrees with it field by field + Circle's attested message for the same transaction.
    async findBurn({route, bridgeId, walletRef, owner, binding}) {
      const f = await provider.findContractTransaction({owner, walletRef, refId: STEP_REF(bridgeId, 'burn')});
      if (f.uncertain || !f.found) return f;
      const c = f.tx;
      if (!identityMatches(f, route, bridgeId, walletRef, 'burn')) return {uncertain: true};
      if (c.state !== 'COMPLETE') {
        if (!callMatches(c, route, bridgeId, binding, 'burn')) return {uncertain: true};
        return {found: true, expectedUserId: f.expectedUserId, tx: {state: c.state, walletId: c.walletId, userId: c.userId,
          txHash: c.txHash, chainId: route.source.chainId, contract: c.contractAddress, burnToken: route.source.usdc,
          amountRaw: binding.amountRaw, destinationDomain: binding.destination.domain, mintRecipient: binding.destination.recipient,
          from: binding.source.address, maxFee: binding.fees.maxUsdcFeeRaw, minFinalityThreshold: binding.fees.minFinalityThreshold}};
      }
      try {
        if (!/^0x[0-9a-fA-F]{64}$/.test(c.txHash ?? '')) return {uncertain: true};
        const {url, spec} = await chain('source', route);
        const rc = await rpc(url, 'eth_getTransactionReceipt', [c.txHash]);
        if (!rc || rc.status !== '0x1') return {uncertain: true};
        const logs = rc.logs ?? [];
        const dep = logs.filter(l => lower(l.address) === lower(spec.tokenMessenger) && l.topics?.[0] === EVENT_TOPICS.depositForBurn);
        const sent = logs.filter(l => lower(l.address) === lower(spec.messageTransmitter) && l.topics?.[0] === EVENT_TOPICS.messageSent);
        if (dep.length !== 1 || sent.length !== 1) return {uncertain: true};
        const e = decodeEventLog({abi: EVENTS, data: dep[0].data, topics: dep[0].topics}); if (e.eventName !== 'DepositForBurn') return {uncertain: true};
        const a = e.args, msg = decodeMessage(decodeEventLog({abi: EVENTS, data: sent[0].data, topics: sent[0].topics}).args.message), body = msg && decodeBurnBody(msg.body);
        if (!msg || !body) return {uncertain: true};
        // The two logs describe one and the same burn.
        const same = msg.sourceDomain === spec.domain && msg.destinationDomain === Number(a.destinationDomain) && msg.sender === lower(spec.tokenMessenger) && lower(msg.destinationCaller) === lower(a.destinationCaller)
          && body.burnToken === lower(a.burnToken) && body.mintRecipient === addr(a.mintRecipient) && body.amount === a.amount.toString() && body.messageSender === lower(a.depositor) && body.maxFee === a.maxFee.toString();
        if (!same) return {uncertain: true};
        if (lower(c.sourceAddress) !== lower(a.depositor)) return {uncertain: true};       // Circle's record and the chain must name the same account
        const m = await messageFor(route, c.txHash);
        if (!m || m === 'many' || m.cctpVersion !== 2 || !m.decodedMessage?.decodedMessageBody) return {uncertain: true};
        const ib = m.decodedMessage.decodedMessageBody;
        if (addr(ib.messageSender) !== lower(a.depositor) || addr(ib.burnToken) !== lower(a.burnToken) || String(ib.amount) !== a.amount.toString() || addr(ib.mintRecipient) !== addr(a.mintRecipient)
          || String(m.decodedMessage.sourceDomain) !== String(spec.domain) || String(m.decodedMessage.destinationDomain) !== String(a.destinationDomain)) return {uncertain: true};
        return {found: true, expectedUserId: f.expectedUserId, tx: {state: 'COMPLETE', walletId: c.walletId, txHash: c.txHash, chainId: spec.chainId, contract: lower(dep[0].address), from: lower(a.depositor), burnToken: lower(a.burnToken),
          amountRaw: a.amount.toString(), destinationDomain: Number(a.destinationDomain), mintRecipient: addr(a.mintRecipient), eventNonce: String(m.eventNonce), userId: c.userId, networkFee: c.networkFee,
          maxFee: a.maxFee.toString(), minFinalityThreshold: Number(a.minFinalityThreshold)}};
      } catch { return {uncertain: true}; }
    },
    // Circle's attestation and forwarding status for one burn. 'complete' means the message is attested AND the forwarded mint is observed.
    async attestation({route, burnTxHash}) {
      const m = await messageFor(route, burnTxHash);
      if (!m || m === 'many') return {status: m === 'many' ? 'uncertain' : 'pending'};
      if (m.status !== 'complete' || m.forwardState !== 'COMPLETE') return {status: 'pending', forwardState: m.forwardState ?? null};
      const dest = m.destinationMintTxHash ?? m.forwardTxHash;
      if (!/^0x[0-9a-fA-F]{64}$/.test(dest ?? '')) return {status: 'pending', forwardState: m.forwardState};
      return {status: 'complete', eventNonce: String(m.eventNonce), destinationTxHash: dest, forwardState: m.forwardState, messageHash: null};
    },
    // The arrival, read from Arc itself, in THIS transaction's receipt: the MessageReceived log of the destination MessageTransmitterV2
    // carries the message's own nonce, source domain, sender and burn body, and the USDC mint to the recipient is read from the same receipt.
    // Nothing global ("is this nonce used anywhere?") and no unrelated transfer can stand in for it.
    async verifyDestination({route, destinationTxHash}) {
      const {url, spec} = await chain('destination', route);
      const rc = await rpc(url, 'eth_getTransactionReceipt', [destinationTxHash]);
      if (!rc) return {found: false};
      const bn = parseInt(rc.blockNumber, 16);
      let finalized = false;
      try { const f = await rpc(url, 'eth_getBlockByNumber', ['finalized', false]); finalized = !!f && parseInt(f.number, 16) >= bn; }
      catch { const latest = parseInt(await rpc(url, 'eth_blockNumber'), 16); finalized = latest - bn >= finalityDepth; }
      const logs = rc.logs ?? [];
      const rcv = logs.filter(l => lower(l.address) === lower(spec.messageTransmitter) && l.topics?.[0] === EVENT_TOPICS.messageReceived);
      let message = null;
      if (rcv.length === 1) {
        try {
          const e = decodeEventLog({abi: EVENTS, data: rcv[0].data, topics: rcv[0].topics}); const body = decodeBurnBody(e.args.messageBody);
          if (e.eventName === 'MessageReceived' && body) message = {nonce: BigInt(e.args.nonce).toString(), sourceDomain: Number(e.args.sourceDomain), sender: addr(e.args.sender), ...body};
        } catch { message = null; }
      }
      const credits = logs.filter(l => lower(l.address) === lower(spec.usdc) && l.topics?.length === 3 && l.topics[0] === TRANSFER_TOPIC && addr(l.topics[1]) === '0x' + '0'.repeat(40))
        .map(l => ({from: addr(l.topics[1]), to: addr(l.topics[2]), amountRaw: BigInt(l.data).toString()}));
      return {found: true, success: rc.status === '0x1', chainId: spec.chainId, token: spec.usdc, txHash: destinationTxHash, finalized, message, credits};
    },
  };
}
