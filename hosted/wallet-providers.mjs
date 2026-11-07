// Wallet provider adapters behind one customer wallet screen.
//
//  * simulated      : the only provider used in the offline preview. Fake addresses, no network, no keys.
//  * circle_ucw     : Circle USER-CONTROLLED wallets (customer owns the key and approves with their PIN).
//                     It exists only when the deployment configuration is complete and consistent. There is no
//                     reviewer flag: missing or inconsistent configuration simply means it is not available.
//  * privy (compare): the existing Privy embedded-wallet work, described for the test settings screen only.
//
// Nothing here reads the environment, writes a credential, or calls a network on import. Credentials arrive as
// injected values and are never logged or returned.
import {createHmac, createHash, randomBytes} from 'node:crypto';
import {WALLET_NETWORKS, units} from '../shared/wallet-model.mjs';

export class WalletProviderUnavailableError extends Error {
  constructor(message, problems = []) { super(message); this.name = 'WalletProviderUnavailableError'; this.status = 503; this.problems = problems; }
}

const uuidFrom = text => {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Circle's ExternalUserId is 5 to 50 characters. Eupova's own prefix plus a digest must fit inside that.
export const USER_ID_PREFIX = 'eupova-ucw-';
export const USER_ID_MAX = 50;

// ---- simulated ------------------------------------------------------------------------------------------
// outcome(payment) lets tests choose: 'success' (default), 'definite_failure', 'unknown', 'throw'.
export function createSimulatedWalletProvider({outcome = () => 'success'} = {}) {
  return Object.freeze({
    id: 'simulated', mode: 'simulated', simulated: true, label: 'Simulated wallet (test data)',
    custody: 'The customer approves every payment. Nothing here can sign: there is no key.',
    async createWallet({requestId}) {
      // A clearly fake address (prefix 0x51ed) that exists on no network.
      const hex = createHash('sha256').update('sim-wallet:' + requestId).digest('hex').slice(0, 36);
      return {providerRef: 'sim-' + hex.slice(0, 12), address: '0x51ed' + hex.padEnd(36, '0').slice(0, 36), state: 'ready'};
    },
    async executeTransfer(payment) {
      const kind = outcome(payment);
      if (kind === 'throw') throw new Error('simulated provider crash');
      if (kind === 'unknown') return {state: 'unknown'};
      if (kind === 'definite_failure') return {state: 'failed', reason: 'Simulated network refusal.'};
      const fee = BigInt(payment.maxFeeRaw) < 10000n ? BigInt(payment.maxFeeRaw) : 10000n;
      // A simulation reference, deliberately not shaped like a transaction hash.
      return {state: 'confirmed', ref: 'sim-pay-' + randomBytes(6).toString('hex'), feeRaw: fee.toString()};
    },
    async transferStatus() { return {state: 'unknown'}; },
    feeModel: Object.freeze({asset: 'USDC', simulated: true}),
    async estimateFee() { return null; },
    readiness: () => ({ready: true, simulated: true, missing: []}),
  });
}

// ---- Circle user-controlled wallets -----------------------------------------------------------------------
// Configuration is explicit and checked field by field. Nothing here reads the environment: the caller passes the
// values in, and `validateWalletConfig` says exactly which names are missing or inconsistent (never their values).
export const walletEnvNames = Object.freeze({
  mode: 'EUPOVA_WALLET_MODE', network: 'EUPOVA_WALLET_NETWORK', apiKey: 'EUPOVA_CIRCLE_UCW_API_KEY', appId: 'EUPOVA_CIRCLE_UCW_APP_ID',
  userIdSecret: 'EUPOVA_CIRCLE_UCW_USER_ID_SECRET', accountType: 'EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE', gasModel: 'EUPOVA_CIRCLE_UCW_GAS_MODEL', baseUrl: 'EUPOVA_CIRCLE_UCW_BASE_URL',
  gasDailyUsd: 'EUPOVA_CIRCLE_UCW_GAS_DAILY_USD', gasPerTxUsd: 'EUPOVA_CIRCLE_UCW_GAS_PER_TX_USD',
});

export function walletConfigFromEnv(env = {}) {
  const get = k => (typeof env[walletEnvNames[k]] === 'string' ? env[walletEnvNames[k]].trim() : undefined);
  return {mode: get('mode') ?? 'off', network: get('network'), apiKey: get('apiKey'), appId: get('appId'), userIdSecret: get('userIdSecret'),
    accountType: get('accountType'), gasModel: get('gasModel') ?? 'wallet', baseUrl: get('baseUrl'), gasDailyUsd: get('gasDailyUsd'), gasPerTxUsd: get('gasPerTxUsd')};
}

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function validateWalletConfig(config = {}) {
  const problems = [], need = (key, why) => problems.push({env: walletEnvNames[key], why});
  if (config.mode !== 'live') return {requested: false, ready: false, problems: [], network: null};
  const net = WALLET_NETWORKS[config.network];
  if (!net) need('network', 'Must be exactly "base" (Base mainnet) or "base_sepolia" (Base Sepolia test network).');
  const keyMatch = typeof config.apiKey === 'string' && /^(TEST|LIVE)_API_KEY:[^:\s]+:[^:\s]+$/.exec(config.apiKey);
  if (!keyMatch) need('apiKey', 'A Circle API key of the form TEST_API_KEY:<id>:<secret> or LIVE_API_KEY:<id>:<secret>.');
  else if (net && ((net.environment === 'mainnet') !== (keyMatch[1] === 'LIVE'))) need('apiKey', `A ${net.environment === 'mainnet' ? 'LIVE' : 'TEST'}_API_KEY is required for ${net.label}; a key of the other environment is refused.`);
  if (typeof config.appId !== 'string' || !UUID.test(config.appId)) need('appId', 'The User-Controlled Wallets application id (a UUID) from the Circle Console.');
  if (typeof config.userIdSecret !== 'string' || config.userIdSecret.length < 32) need('userIdSecret', 'A random secret of at least 32 characters generated by the operator.');
  if (!['EOA', 'SCA'].includes(config.accountType)) need('accountType', 'Must be exactly "EOA" or "SCA". Circle advises EOA on mainnet chains such as Ethereum and SCA on L2s such as Base.');
  if (!['wallet', 'sponsored'].includes(config.gasModel)) need('gasModel', 'Must be exactly "wallet" (the customer\'s wallet pays network fees in ETH) or "sponsored" (Circle Gas Station pays).');
  else if (config.gasModel === 'sponsored' && config.accountType !== 'SCA') need('gasModel', '"sponsored" needs EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE=SCA, because Gas Station sponsors smart-contract accounts.');
  if (config.gasModel === 'sponsored') {
    // Eupova keeps its OWN local pacing limit so sponsorship is never assumed to be unlimited. It is not Circle's policy: Circle enforces the real one.
    const usd = v => typeof v === 'string' && /^\d{1,4}(\.\d{1,6})?$/.test(v) && Number(v) > 0;
    if (!usd(config.gasDailyUsd)) need('gasDailyUsd', 'With "sponsored", set the daily limit (US dollars, e.g. 5) to match the Gas Station policy in the Circle Console. Eupova uses it only as its own local limit; Circle enforces the real policy.');
    if (!usd(config.gasPerTxUsd)) need('gasPerTxUsd', 'With "sponsored", set a planning figure (US dollars, e.g. 1) for the most one sponsored transaction is expected to cost. It is a local estimate used to pace requests: it cannot prove a transaction is eligible for sponsorship or measure what was actually spent.');
    if (usd(config.gasDailyUsd) && usd(config.gasPerTxUsd) && Number(config.gasPerTxUsd) > Number(config.gasDailyUsd)) need('gasPerTxUsd', 'Cannot be larger than the daily limit.');
  }
  if (config.baseUrl !== undefined && !/^https:\/\/[a-z0-9.-]+(\/[^\s]*)?$/i.test(config.baseUrl)) need('baseUrl', 'If set, must be an https URL.');
  return {requested: true, ready: problems.length === 0, problems, network: net ?? null};
}

const decimalToRaw = (text, decimals) => {
  if (typeof text !== 'string' || !new RegExp(`^\\d{1,30}(\\.\\d{1,40})?$`).test(text)) throw new Error('Unreadable amount from provider.');
  const [w, f = ''] = text.split('.');
  if (f.length > decimals && /[1-9]/.test(f.slice(decimals))) throw new Error('Amount has more precision than the token allows.');
  return BigInt(w + f.slice(0, decimals).padEnd(decimals, '0'));
};
const apiCode = e => e?.response?.data?.code ?? e?.code;

// ---- paging -----------------------------------------------------------------------------------------------
// Circle returns lists one page at a time (pageSize up to 50) and continues with `pageAfter` = the id of the last item.
// A list is never trusted from its first page alone: balances, wallets and transaction lookups walk every page. A page that
// does not advance, or a list longer than the cap, is an error (the caller keeps reservations and reports "unknown") rather
// than a silently partial list. Unverified against the live API: the cursor id used for token balances (the token id).
export const PAGE_SIZE = 50;
export const MAX_PAGES = 40;
export async function allPages(fetchPage, idOf, label, {maxPages = MAX_PAGES, partialOk = false} = {}) {
  const rows = []; const seen = new Set(); let after;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(after);
    if (!Array.isArray(page)) throw new Error(`${label}: the provider returned something other than a list.`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return {rows, complete: true};
    const last = idOf(page[page.length - 1]);
    if (typeof last !== 'string' || last === '' || seen.has(last)) throw new Error(`${label}: the provider's paging did not advance, so the list cannot be trusted.`);
    seen.add(last); after = last;
  }
  if (partialOk) return {rows, complete: false};
  throw new Error(`${label}: more than ${maxPages * PAGE_SIZE} records; a partial list is not trusted.`);
}

export function createCircleUserControlledProvider({config, sdkFactory}) {
  const check = validateWalletConfig(config);
  if (!check.ready) throw new WalletProviderUnavailableError('Circle user-controlled wallets are not available: ' + (check.requested ? check.problems.map(p => p.env).join(', ') : 'EUPOVA_WALLET_MODE is not "live"'), check.problems);
  if (typeof sdkFactory !== 'function') throw new WalletProviderUnavailableError('The Circle SDK could not be loaded.');
  const net = check.network;
  const client = sdkFactory({apiKey: config.apiKey, ...(config.baseUrl ? {baseUrl: config.baseUrl} : {})});
  // Per-customer binding: an opaque, stable id derived on the server from the authenticated owner.
  // Circle caps its ExternalUserId at 50 characters (openapi: maxLength 50). The prefix is 11, so the digest keeps 39.
  // 11 + 40 was 51 and the live API refused every createUser with it, which surfaced as a generic 503 in the wallet.
  const userIdFor = owner => USER_ID_PREFIX + createHmac('sha256', config.userIdSecret).update('user:' + owner).digest('hex').slice(0, USER_ID_MAX - USER_ID_PREFIX.length);

  async function session(owner) {
    const userId = userIdFor(owner);
    // 155101: the user already exists. Anything else is a real failure.
    try { await client.createUser({userId}); } catch (e) { if (apiCode(e) !== 155101) throw e; }
    const t = (await client.createUserToken({userId})).data;
    if (!t?.userToken || !t?.encryptionKey) throw new Error('Circle did not return a session.');
    return {userId, userToken: t.userToken, encryptionKey: t.encryptionKey};
  }
  const browserSession = (s, extra = {}) => ({appId: config.appId, userToken: s.userToken, encryptionKey: s.encryptionKey, ...extra});

  const listAllWallets = async s => (await allPages(after => client.listWallets({userToken: s.userToken, blockchain: net.circleChain, pageSize: PAGE_SIZE, ...(after ? {pageAfter: after} : {})}).then(r => r.data?.wallets ?? []), w => w?.id, 'Wallet list')).rows;
  async function walletOf(owner, walletRef, s) {
    // The wallet must belong to THIS customer: it is looked up with their token, never trusted from the caller.
    const list = await listAllWallets(s);
    const w = list.find(x => x.id === walletRef && x.blockchain === net.circleChain && x.state === 'LIVE');
    if (!w) throw new Error('That wallet is not available for this customer on this network.');
    return w;
  }
  // The USDC token on THIS chain, matched by blockchain and exact contract address. Never by symbol or name.
  async function usdcOf(s, walletRef) {
    const rows = (await allPages(after => client.getWalletTokenBalance({userToken: s.userToken, walletId: walletRef, includeAll: true, pageSize: PAGE_SIZE, ...(after ? {pageAfter: after} : {})}).then(r => r.data?.tokenBalances ?? []), r => r?.token?.id, 'Token balances')).rows;
    const hits = rows.filter(r => r.token?.blockchain === net.circleChain && typeof r.token?.tokenAddress === 'string' && r.token.tokenAddress.toLowerCase() === net.usdc.toLowerCase() && r.token.isNative === false);
    if (hits.length > 1) throw new Error('More than one token matched the USDC contract.');
    const hit = hits[0] ?? null;
    if (hit && hit.token.decimals !== 6) throw new Error('The USDC token does not report 6 decimals.');
    const native = rows.filter(r => r.token?.blockchain === net.circleChain && r.token?.isNative === true)[0] ?? null;
    return {tokenId: hit?.token.id ?? null, amountRaw: hit ? decimalToRaw(hit.amount, 6) : 0n, nativeWei: native ? decimalToRaw(native.amount, 18) : 0n};
  }

  return Object.freeze({
    id: 'circle_ucw', mode: net.environment, live: true, simulated: false, label: `Circle user-controlled wallet (${net.label})`, network: net,
    custody: 'The customer holds the key (PIN and recovery). Eupova and Circle cannot sign for them.',
    feeModel: Object.freeze({asset: config.gasModel === 'sponsored' ? 'sponsored' : 'ETH', accountType: config.accountType}),
    userIdFor,
    // Short-lived browser session. The caller sends it with no-store, once, and never logs or stores it.
    async startSession(owner) { return browserSession(await session(owner)); },
    // Sequence: createUser (155101 tolerated) -> createUserToken -> createUserPinWithWallets. 155106 means the
    // customer already has wallets, so there is no PIN step to run and the wallet is read back instead.
    async beginWalletSetup({owner, requestId}) {
      const s = await session(owner);
      try {
        const r = (await client.createUserPinWithWallets({userToken: s.userToken, blockchains: [net.circleChain], accountType: config.accountType, idempotencyKey: uuidFrom('setup:' + owner + ':' + requestId)})).data;
        return browserSession(s, {challengeId: r.challengeId});
      } catch (e) { if (apiCode(e) === 155106) return {alreadyInitialized: true}; throw e; }
    },
    async findWallet(owner) {
      const s = await session(owner);
      const list = (await listAllWallets(s)).filter(x => x.blockchain === net.circleChain && x.state === 'LIVE');
      if (list.length > 1) throw new Error('More than one live wallet exists on this network for this customer.');
      return list[0] ? {providerRef: list[0].id, address: list[0].address, state: 'ready'} : null;
    },
    // Ask the wallet to sign EIP-712 typed data. This is a CHALLENGE, not a signature: the customer completes it with
    // their PIN in the browser and the signature comes back through the web SDK. Eupova never sees a key, and cannot
    // sign without that step.
    //
    // Circle's SignTypedDataInput takes no idempotency key, unlike every other mutating call here, so the SDK cannot
    // deduplicate this one. Duplicate prevention therefore has to live in our own records: one authorization row per
    // request reference, and no second challenge while one is outstanding. A caller that retries must resolve the
    // existing row rather than start again.
    async signTypedData({owner, walletRef, typedData, refId, memo}) {
      const s = await session(owner); await walletOf(owner, walletRef, s);
      const r = (await client.signTypedData({
        userToken: s.userToken, walletId: walletRef, data: JSON.stringify(typedData),
        ...(memo ? {memo: String(memo).slice(0, 200)} : {}),
      })).data;
      if (!r?.challengeId) throw new Error('The wallet did not start the signing step.');
      return browserSession(s, {challengeId: r.challengeId, refId: refId ?? null});
    },
    // Spendable USDC (base units) from the provider. This is the only balance a live wallet has.
    async balance(owner, walletRef) {
      const s = await session(owner); await walletOf(owner, walletRef, s);
      return (await usdcOf(s, walletRef)).amountRaw.toString();
    },
    async nativeBalanceWei(owner, walletRef) {
      const s = await session(owner); await walletOf(owner, walletRef, s);
      return (await usdcOf(s, walletRef)).nativeWei.toString();
    },
    async history(owner, walletRef) {
      const s = await session(owner); await walletOf(owner, walletRef, s);
      const {rows} = await allPages(after => client.listTransactions({userToken: s.userToken, walletIds: [walletRef], blockchain: net.circleChain, pageSize: PAGE_SIZE, ...(after ? {pageAfter: after} : {})}).then(r => r.data?.transactions ?? []), t => t?.id, 'Transaction history', {maxPages: 4, partialOk: true});
      return rows.map(t => ({id: t.id, state: t.state, at: t.createDate, direction: t.transactionType === 'INBOUND' ? 'in' : 'out', amounts: t.amounts, destination: t.destinationAddress, source: t.sourceAddress, tokenId: t.tokenId ?? null, blockchain: t.blockchain ?? null, refId: t.refId ?? null, networkFee: t.networkFee ?? null, txHash: t.txHash ?? null}));
    },
    // Network fee. On this chain the fee is paid in the NATIVE asset (ETH), never in USDC. What the customer is shown is Circle's own
    // ESTIMATE (high tier, its networkFee). It is NOT a chain-enforced total cap: networkFee is not proven to equal gasLimit x maxFee, the
    // units of those two figures are not verified, and Base (an OP-stack chain) can add an L1 data fee that none of them includes. The
    // gas limit and fee values are still sent with the transaction as Circle documents, but the wallet must hold headroom beyond the estimate.
    async estimateFee({owner, walletRef, destination, amountRaw}) {
      if (config.gasModel === 'sponsored') return {asset: 'sponsored', maxFeeNativeWei: '0', gasLimit: null, maxFee: null, priorityFee: null};
      const s = await session(owner); await walletOf(owner, walletRef, s);
      const u = await usdcOf(s, walletRef);
      if (!u.tokenId) throw new Error('This wallet holds no USDC on this network.');
      const est = (await client.estimateTransferFee({userToken: s.userToken, walletId: walletRef, tokenId: u.tokenId, destinationAddress: destination, amount: [units(amountRaw)]})).data;
      const hi = est?.high;
      if (!hi || !/^\d+$/.test(String(hi.gasLimit)) || !/^\d+(\.\d+)?$/.test(String(hi.maxFee)) || !/^\d+(\.\d+)?$/.test(String(hi.priorityFee)) || !/^\d+(\.\d{1,18})?$/.test(String(hi.networkFee))) throw new Error('Circle returned an unreadable fee estimate.');
      return {asset: 'ETH', gasLimit: String(hi.gasLimit), maxFee: String(hi.maxFee), priorityFee: String(hi.priorityFee), maxFeeNativeWei: decimalToRaw(String(hi.networkFee), 18).toString(), basis: 'circle_estimate_high_tier', capEnforcedOnChain: false};
    },
    // The exact USDC token id of this wallet (chain + contract address, never a symbol). Read-only; lets the caller save it BEFORE any payment is created.
    async resolveUsdcTokenId(owner, walletRef) {
      const s = await session(owner); await walletOf(owner, walletRef, s);
      return (await usdcOf(s, walletRef)).tokenId ?? null;
    },
    // Real payment path: Circle returns a challenge; the customer approves it with their PIN in the browser.
    async executeTransfer(payment) {
      const s = await session(payment.owner); await walletOf(payment.owner, payment.walletRef, s);
      const u = await usdcOf(s, payment.walletRef);
      if (!u.tokenId) throw new Error('This wallet holds no USDC on this network.');
      if (payment.tokenId && payment.tokenId !== u.tokenId) throw new Error('The saved USDC token does not match this wallet.');
      const fee = payment.fee && payment.fee.asset === 'ETH'
        ? {type: 'absolute', config: {gasLimit: payment.fee.gasLimit, maxFee: payment.fee.maxFee, priorityFee: payment.fee.priorityFee}}
        : {type: 'level', config: {feeLevel: 'MEDIUM'}};
      const r = (await client.createTransaction({
        userToken: s.userToken, walletId: payment.walletRef, destinationAddress: payment.destination, amounts: [units(payment.amountRaw)],
        tokenId: u.tokenId, fee, refId: payment.id, idempotencyKey: uuidFrom('pay:' + payment.id),
      })).data;
      return {state: 'pending_challenge', tokenId: u.tokenId, ...browserSession(s, {challengeId: r.challengeId})};
    },
    // Resume: a fresh session for a challenge that already exists (page closed mid-approval).
    async resumeSession(owner) { return browserSession(await session(owner)); },
    // Looks for this payment's transaction and returns what Circle reports, for the caller to verify field by field.
    // Never decides success itself. More than one match, or a full page, is reported as uncertain.
    async findTransaction({owner, walletRef, refId, destination}) {
      const s = await session(owner); await walletOf(owner, walletRef, s);
      let rows;
      try {
        rows = (await allPages(after => client.listTransactions({userToken: s.userToken, walletIds: [walletRef], blockchain: net.circleChain, destinationAddress: destination, pageSize: PAGE_SIZE, ...(after ? {pageAfter: after} : {})}).then(r => r.data?.transactions ?? []), t => t?.id, 'Transaction lookup')).rows;
      } catch { return {uncertain: true}; }   // an unreadable or incomplete list can never mean "no such transaction"
      const hits = rows.filter(t => t.refId === refId);
      if (hits.length > 1) return {uncertain: true};
      const t = hits[0];
      if (!t) return {found: false};
      return {found: true, tx: {id: t.id, state: t.state, userId: t.userId ?? null, walletId: t.walletId ?? null, blockchain: t.blockchain, destination: t.destinationAddress ?? null,
        amounts: t.amounts ?? [], tokenId: t.tokenId ?? null, refId: t.refId ?? null, txHash: t.txHash ?? null, networkFee: t.networkFee ?? null, transactionType: t.transactionType}, expectedUserId: userIdFor(owner)};
    },
    // ---- contract execution (used by the Base to Arc move: one USDC approval and one burn, each approved by the customer's PIN) ----
    // Creates the challenge only; nothing happens on chain until the customer completes it in Circle's hosted step.
    async executeContract({owner, walletRef, contractAddress, abiFunctionSignature, abiParameters, refId, idempotencyKey}) {
      const s = await session(owner); await walletOf(owner, walletRef, s);
      const r = (await client.createUserTransactionContractExecutionChallenge({
        userToken: s.userToken, walletId: walletRef, contractAddress, abiFunctionSignature, abiParameters,
        fee: {type: 'level', config: {feeLevel: 'MEDIUM'}}, refId, idempotencyKey: uuidFrom('contract:' + idempotencyKey),
      })).data;
      return {state: 'pending_challenge', ...browserSession(s, {challengeId: r.challengeId})};
    },
    // Circle's own estimate for a contract call, in ETH. An estimate, not a cap (see estimateFee).
    async estimateContractFee({owner, walletRef, contractAddress, abiFunctionSignature, abiParameters}) {
      const s = await session(owner); await walletOf(owner, walletRef, s);
      const est = (await client.estimateContractExecutionFee({userToken: s.userToken, source: {walletId: walletRef}, contractAddress, abiFunctionSignature, abiParameters})).data;
      const hi = est?.high ?? est?.medium;
      if (!hi || !/^\d+(\.\d{1,18})?$/.test(String(hi.networkFee))) throw new Error('Circle returned an unreadable fee estimate.');
      return {estimateNativeWei: decimalToRaw(String(hi.networkFee), 18).toString()};
    },
    // Finds the contract call made for one reference and reports what Circle holds, for the caller to verify. Never decides success.
    async findContractTransaction({owner, walletRef, refId}) {
      const s = await session(owner); await walletOf(owner, walletRef, s);
      let rows;
      try { rows = (await allPages(after => client.listTransactions({userToken: s.userToken, walletIds: [walletRef], blockchain: net.circleChain, pageSize: PAGE_SIZE, ...(after ? {pageAfter: after} : {})}).then(r => r.data?.transactions ?? []), t => t?.id, 'Transaction lookup')).rows; }
      catch { return {uncertain: true}; }
      const hits = rows.filter(t => t.refId === refId);
      if (hits.length > 1) return {uncertain: true};
      const t = hits[0]; if (!t) return {found: false};
      return {found: true, tx: {id: t.id, state: t.state, userId: t.userId ?? null, walletId: t.walletId ?? null, blockchain: t.blockchain, contractAddress: t.contractAddress ?? null, operation: t.operation ?? null, abiFunctionSignature: t.abiFunctionSignature ?? null, abiParameters: t.abiParameters ?? null,
        sourceAddress: t.sourceAddress ?? null, txHash: t.txHash ?? null, networkFee: t.networkFee ?? null, refId: t.refId ?? null}, expectedUserId: userIdFor(owner)};
    },
    readiness: () => ({ready: true, simulated: false, missing: []}),
  });
}

// ---- comparison descriptors (test settings only) -----------------------------------------------------------
export function describeProviders({config, activeId = 'simulated'} = {}) {
  // When the live wallet is not switched on, show what switching it on needs: the full list a bare "live" would lack.
  const asked = validateWalletConfig(config ?? {});
  const v = asked.requested ? asked : {...validateWalletConfig({...(config ?? {}), mode: 'live'}), ready: false};
  const live = activeId === 'circle_ucw';
  return [
    {id: 'simulated', label: 'Simulated wallet', active: activeId === 'simulated', ready: true, customerControlled: true, summary: 'Fake address, test money. Used for the offline preview only. It is never present in a live deployment.', missing: []},
    {id: 'circle_ucw', label: 'Circle user-controlled wallet', active: live, ready: v.ready, customerControlled: true,
      summary: 'The customer sets a PIN and recovery questions in a Circle-hosted step and approves each payment with it. It opens only when every setting below is present and consistent.',
      missing: [...(asked.requested ? [] : [{what: 'Set to exactly "live" to switch the live wallet on. Until then no live wallet exists.', env: walletEnvNames.mode}]), ...v.problems.map(p => ({what: p.why, env: p.env}))]},
    {id: 'privy', label: 'Privy embedded wallet (existing work, comparison only)', active: false, ready: false, customerControlled: true,
      summary: 'The earlier Privy wallet-setup work is kept unchanged for comparison. It is not connected to this screen and no Privy wallet is created.', missing: [{what: 'The existing Privy setup, configuration and durable guard described in docs/privy-wallet-setup-adapter.md.'}]},
  ];
}
