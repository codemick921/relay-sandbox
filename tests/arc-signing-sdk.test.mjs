// Conformance of the signing seam with the REAL pinned Circle packages. A stub EIP-1193 provider answers
// only account queries; there are no keys, no signatures, no transactions and no network (the offline
// guard blocks it). Anything that would sign or send makes the stub fail the test.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {approvalBinding, arcQuote, canonicalBinding, units} from '../shared/arc-funding.mjs';
import {SigningGatedError, bridgeParams, createCustomerBridgeSigner, estimateParams, sha256Hex} from '../src/arc-customer-signing.mjs';

const SOURCE = '0x' + 'a'.repeat(40), RECIPIENT = '0x7e57' + '0'.repeat(35) + '1';
const gate = {approved: true, reviewed: {dependencies: true, permissions: true, custody: true, privyConfig: true}};
const SIGNING_METHODS = /send|sign|switchEthereumChain|addEthereumChain|requestPermissions|watchAsset/i;

async function realSdk() {
  const {BridgeKit} = await import('@circle-fin/bridge-kit');
  const {createAdapterFromProvider} = await import('@circle-fin/adapter-viem-v2');
  return {BridgeKit, createAdapterFromProvider};
}
function stubWallet() {
  const requests = [], switched = [];
  const provider = {request: async ({method}) => {
    requests.push(method);
    if (SIGNING_METHODS.test(method)) throw new Error('the stub provider refuses to sign or send: ' + method);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [SOURCE];
    if (method === 'eth_chainId') return '0x14a34';
    throw new Error('unexpected provider call ' + method);
  }};
  return {requests, switched, wallet: {address: SOURCE, walletClientType: 'privy', switchChain: async id => { switched.push(id); }, getEthereumProvider: async () => provider}};
}
function approval(speed = 'fast') {
  const quote = {...arcQuote({pence: 2500, speed}), id: randomUUID()};
  const binding = approvalBinding({
    source: {walletId: randomUUID(), address: SOURCE, chain: 'Base Sepolia'},
    destination: {mode: 'external_test', id: randomUUID(), revision: 1, label: 'Agent', address: RECIPIENT, chain: 'Arc Testnet'}, quote,
  });
  return binding;
}

test('the dependencies are pinned exactly and the seam still imports no SDK itself', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@circle-fin/bridge-kit'], '1.17.0');
  assert.equal(pkg.dependencies['@circle-fin/adapter-viem-v2'], '1.20.0');
  assert.match(pkg.dependencies.viem, /^\d+\.\d+\.\d+$/);
  const src = readFileSync(new URL('../src/arc-customer-signing.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /^\s*import .* from ['"](?!\.\.?\/)/m, 'the seam imports only repo modules; the SDK is injected');
  for (const f of ['App.jsx', 'ArcWallets.jsx', 'main.jsx']) assert.doesNotMatch(readFileSync(new URL('../src/' + f, import.meta.url), 'utf8'), /arc-customer-signing|@circle-fin/, f + ' does not wire signing');
});

test('real Bridge Kit: supported chains, accepted parameters and the documented fee behaviour', async () => {
  const {BridgeKit, createAdapterFromProvider} = await realSdk();
  const kit = new BridgeKit();
  const chains = kit.getSupportedChains();
  for (const id of ['Base_Sepolia', 'Arc_Testnet']) assert.ok(chains.some(c => c.chain === id), id);
  const {wallet, requests} = stubWallet();
  const adapter = await createAdapterFromProvider({provider: await wallet.getEthereumProvider()});
  const binding = approval('fast');
  // Without our cap the SDK asks for live fees. There is no network here, so it reports an error instead of a number.
  const quote = await kit.estimate(estimateParams(binding, adapter));
  assert.ok(quote.fees.length > 0);
  assert.ok(quote.fees.every(f => f.amount === null && f.error), 'no network: the SDK cannot price the transfer, and says so');
  // With a cap, the SDK uses the cap itself as the provider fee (provider-cctp-v2 getMaxFee). This is why the quote
  // request above omits the cap: an estimate that carried it would only echo the cap back and prove nothing.
  const echoed = await kit.estimate(bridgeParams(binding, adapter));
  assert.equal(echoed.fees[0].amount, units(binding.quote.bridgeFeeRaw));
  assert.deepEqual(requests.filter(m => SIGNING_METHODS.test(m)), [], 'estimating never signs or sends');
});

test('real SDK, no network: the signer fails closed before any chain switch, signature or transaction', async () => {
  const {BridgeKit, createAdapterFromProvider} = await realSdk();
  const {wallet, requests, switched} = stubWallet();
  const signer = createCustomerBridgeSigner({gate, wallet, createAdapterFromProvider, kit: new BridgeKit()});
  const binding = approval('standard');
  const signed = {status: 'approved', binding, bindingHash: await sha256Hex(canonicalBinding(binding)), executedAt: null};
  await assert.rejects(signer.estimate(signed), SigningGatedError);
  await assert.rejects(signer.execute(signed), SigningGatedError);
  assert.deepEqual(switched, [], 'the wallet was never asked to switch chain');
  assert.deepEqual(requests.filter(m => SIGNING_METHODS.test(m)), [], 'nothing was signed or sent');
  assert.ok(requests.every(m => ['eth_accounts', 'eth_requestAccounts', 'eth_chainId'].includes(m)), 'only account queries: ' + requests.join(','));
});
