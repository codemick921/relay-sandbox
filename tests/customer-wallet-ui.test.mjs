import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {setup, funded, send, owner} from './fixtures/wallet-helpers.mjs';
import {seedWalletFixtures} from '../hosted/wallet-fixtures.mjs';
import {trimUsdc, shortAddress} from '../src/wallet-view.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const root = new URL('..', import.meta.url).pathname;
let shared = null;
async function loader() {
  if (shared) return shared;
  const vite = await createServer({root, configFile: false, logLevel: 'silent', server: {middlewareMode: true, hmr: false, watch: null}, appType: 'custom', optimizeDeps: {noDiscovery: true, include: []}});
  const {default: CustomerWallet} = await vite.ssrLoadModule('/src/CustomerWallet.jsx');
  shared = {vite: {close: async () => {}}, real: vite, render: (state, props = {}) => renderToStaticMarkup(React.createElement(CustomerWallet, {state, act: async () => null, busy: false, error: '', open: () => {}, onBridge: () => {}, ...props}))};
  return shared;
}
test.after(async () => { if (shared) await shared.real.close(); });
const account = {id: 'a', email: 'x@example.invalid'};

test('before a wallet exists: a friendly Create my wallet screen, no external wallet or extension needed', async () => {
  const {vite, render} = await loader(); const f = await setup();
  try {
    const t = text(render({account, agents: [], customerWallet: await f.cw.state(owner)}));
    for (const need of ['Create your Eupova wallet', 'Create my wallet', 'No extra app and no browser extension', 'you approve every payment', 'simulated wallet', 'fake address and test money only', 'Wallet name']) assert.match(t, new RegExp(need, 'i'), need);
    assert.doesNotMatch(t, /metamask|walletconnect|connect (a |your )?wallet|install|browser extension is required|seed phrase/i);
    assert.match(text(render({account, customerWallet: await f.cw.state(owner)}, {busy: true})), /Creating your wallet/);
    assert.match(text(render({account, customerWallet: await f.cw.state(owner)}, {error: 'Something went wrong. Try again.'})), /Something went wrong/);
    assert.match(text(render({account: null, customerWallet: await f.cw.state(owner)})), /Create my wallet/, 'testers without a customer account get the same screen');
    assert.match(text(render({account, customerWallet: undefined})), /not available/);
  } finally { await vite.close(); await f.close(); }
});

test('the wallet screen shows a wallet card with name, balance, network and address, and every action', async () => {
  const {vite, render} = await loader(); const f = await setup();
  try {
    await seedWalletFixtures(f.cw, owner, {tag: 'Bob', full: true});
    const cw = await f.cw.state(owner);
    const html = render({account, agents: [], customerWallet: cw, arcFunding: {enabled: true}});
    const t = text(html);
    assert.match(t, /Bob Eupova wallet/); assert.match(t, /Balance/); assert.match(t, new RegExp(trimUsdc(cw.balance.usdc).replace('.', '\\.') + ' USDC'));
    assert.match(t, /Base Sepolia \(test network\)/); assert.ok(html.includes(shortAddress(cw.wallet.address)), 'address shown');
    assert.match(t, /Simulated · test money/); assert.match(t, /never a real, funded wallet/);
    for (const label of ['Add money', 'Receive', 'Send']) assert.ok(html.includes('>' + label + '<') || t.includes(label), label);
    assert.match(t, /Pending approvals/); assert.match(t, /Activity/); assert.match(t, /Connected tools/); assert.match(t, /Bridge and recovery tools/);
    assert.match(html, /aria-label="Your Eupova wallet"/); assert.match(html, /role="group" aria-label="Wallet actions"/);
  } finally { await vite.close(); await f.close(); }
});

test('every pending request shows service, destination, amount, token and network, max fee, total cap, tool and fingerprint, with Approve and Decline', async () => {
  const {vite, render} = await loader(); const f = await setup();
  try {
    await seedWalletFixtures(f.cw, owner, {tag: 'Bob', full: true});
    const cw = await f.cw.state(owner);
    const t = text(render({account, customerWallet: cw}));
    assert.equal(cw.pendingApprovals.length, 2);
    for (const label of ['Service', 'To', 'Amount', 'Maximum network fee', 'Most that can leave your wallet', 'Token and network', 'Fingerprint']) assert.match(t, new RegExp(label), label);
    assert.match(t, /Weather API \(fixture\)/); assert.match(t, /requested by Bob CLI \(fixture, no credential\)/); assert.match(t, /started by you/);
    assert.match(t, /USDC on Base Sepolia \(test network\)/); assert.match(t, /0\.75 USDC/); assert.match(t, /0\.05 USDC/); assert.match(t, /0\.80 USDC/);
    assert.match(t, /That alone does not pay anything: this payment still needs your approval/);
    assert.match(t, /your approval stops counting/);
    assert.equal((t.match(/Approve payment/g) ?? []).length, 2); assert.equal((t.match(/Decline/g) ?? []).length >= 2, true);
    assert.match(t, /Recent payments and requests \(2\)/); assert.match(t, /simulation, not a blockchain transaction/);
    for (const p of cw.pendingApprovals) assert.ok(t.includes(p.shortFingerprint), 'fingerprint shown');
    assert.doesNotMatch(t, /0x[0-9a-f]{64}/);
  } finally { await vite.close(); await f.close(); }
});

test('connected tools: allowance is chosen and confirmed by the customer, pairing needs a code, tools can be disconnected', async () => {
  const {vite, render} = await loader(); const f = await setup();
  try {
    await seedWalletFixtures(f.cw, owner, {tag: 'Bob', full: true});
    const cw = await f.cw.state(owner);
    const t = text(render({account, customerWallet: cw}));
    assert.match(t, /It needs two things from you every time: an allowance you chose, and your approval of each payment/);
    assert.match(t, /10\.00 of 10\.00 USDC left until/); assert.match(t, /Every payment still needs your approval/);
    assert.match(t, /I allow this tool to ask for payments up to this amount until this time\. I will still approve every payment myself\./);
    assert.match(t, /Change allowance/); assert.match(t, /End allowance/); assert.match(t, /Disconnect tool/); assert.match(t, /Connect tool/); assert.match(t, /enrol/);
    // A tool with no allowance says so and offers to give one; a fresh wallet has no tools.
    const bare = await setup();
    try {
      await funded(bare, owner);
      const e = await bare.cw.tools.enrolStart({name: 'Bare CLI', ip: '1'}); await bare.cw.tools.approveEnrolment(owner, {userCode: e.userCode});
      const t2 = text(render({account, customerWallet: await bare.cw.state(owner)}));
      assert.match(t2, /No allowance\. This tool cannot be paid anything until you give it one/); assert.match(t2, /Give allowance/); assert.match(t2, /Waiting to finish connecting/);
      assert.match(text(render({account, customerWallet: await (await setup().then(async x => { await funded(x, owner); return x; })).cw.state(owner)})), /No tools are connected/);
    } finally { await bare.close(); }
  } finally { await vite.close(); await f.close(); }
});

test('an unknown outcome is explained plainly with the two honest answers; empty states are friendly', async () => {
  const {vite, render} = await loader(); const f = await setup({outcome: () => 'unknown'});
  try {
    await funded(f);
    const {id} = await send(f, owner, {amount: '1'});
    const p = (await f.cw.state(owner)).payments[0];
    await f.cw.payments.decide(owner, {id, decision: 'approve', bindingHash: p.fingerprint});
    const t = text(render({account, customerWallet: await f.cw.state(owner)}));
    assert.match(t, /Outcome unknown: needs your check/); assert.match(t, /could not confirm whether this payment was sent/); assert.match(t, /nothing will be retried for you/);
    assert.match(t, /It was not sent/); assert.match(t, /It was sent/);
    const fresh = await setup();
    try {
      await funded(fresh, owner, 200);
      const e = text(render({account, customerWallet: await fresh.cw.state(owner)}));
      assert.match(e, /Nothing is waiting for you/); assert.match(e, /No tools are connected/);
    } finally { await fresh.close(); }
  } finally { await vite.close(); await f.close(); }
});

test('test settings compare providers without creating anything: Circle and Privy stay closed and list what they need by name', async () => {
  const {vite, render} = await loader(); const f = await setup();
  try {
    await funded(f);
    const t = text(render({account, customerWallet: await f.cw.state(owner)}));
    assert.match(t, /Test settings: wallet providers/); assert.match(t, /Simulated wallet/); assert.match(t, /Circle user-controlled wallet/); assert.match(t, /Privy embedded wallet \(existing work, comparison only\)/);
    assert.match(t, /In use/); assert.match(t, /Not available/);
    for (const env of ['EUPOVA_WALLET_MODE', 'EUPOVA_WALLET_NETWORK', 'EUPOVA_CIRCLE_UCW_API_KEY', 'EUPOVA_CIRCLE_UCW_APP_ID', 'EUPOVA_CIRCLE_UCW_USER_ID_SECRET', 'EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE']) assert.ok(t.includes(env), env);
    assert.doesNotMatch(t, /go-ahead|reviewed|approved by/i, 'there is no reviewer switch to explain');
    assert.doesNotMatch(t, /sk_|(TEST|LIVE)_API_KEY:[A-Za-z0-9-]{4,}:/, 'format hints only, never a key');
  } finally { await vite.close(); await f.close(); }
});

test('wallet styles are isolated, mobile-ready and the original app shell is intact', () => {
  const css = readFileSync(new URL('../src/customer-wallet.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...css.matchAll(/(?:^|})\s*([^{}@]+)\{/g)].map(m => m[1].trim()).flatMap(s => s.split(',').map(x => x.trim())).filter(Boolean);
  const stray = selectors.filter(s => !/^\.cw-/.test(s) && !/^\.cw-[\w-]+ \.|^\.cw-/.test(s));
  assert.deepEqual(stray, [], 'every selector starts with .cw-');
  assert.match(css, /@media \(max-width:640px\)[\s\S]*\.cw-card/); assert.match(css, /min-height:46px/);
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  for (const original of ["import MyAgents from './MyAgents'", "import ArcWallets from './ArcWallets'", "import Payments from './Payments'", "import WalletTools from './WalletTools'", "'Wallet & quotes'", "'Friend testing'", "'Notifications'", "'My agents'"]) assert.ok(app.includes(original), original);
  assert.match(app, /\.\.\.\(state\?\.customerWallet\?\.enabled\?\[\['My wallet','wallet'\]\]:\[\]\)/, 'the navigation item depends only on the wallet being enabled, not on a customer account');
  assert.doesNotMatch(app, /customerWallet\?\.enabled&&state\?\.account/); assert.match(app, /onBridge=\{\(\)=>setPage\('Arc agentic wallets'\)\}/);
  assert.ok(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').length > 1000, 'original styles untouched');
});

test('activity shows an amount only for money that moved; waiting, declined and lapsed requests show their status', async () => {
  const {vite, render} = await loader(); const f = await setup();
  try {
    await seedWalletFixtures(f.cw, owner, {tag: 'Bob', full: true});
    const cw = await f.cw.state(owner);
    const rows = cw.activity;
    for (const r of rows.filter(r => /Declined example|Waiting example|Weather API/.test(r.label))) { assert.equal(r.moved, false, r.label); assert.equal(r.amountUsdc, null, r.label); }
    const html = render({account, agents: [], customerWallet: cw, arcFunding: {enabled: true}});
    const activity = html.slice(html.indexOf('id="cw-activity-title"'), html.indexOf('id="cw-tools-title"'));
    const text2 = text(activity);
    assert.match(text2, /Declined example: You declined/); assert.match(text2, /declined/);
    assert.doesNotMatch(text2, /−\s*3(\.00)?\b/, 'a declined 3 USDC request is not shown as spent');
    assert.doesNotMatch(text2, /−\s*2\.4/, 'a waiting request is not shown as spent');
    assert.match(text2, /−\s*1\.25/, 'the payment that really went shows its amount');
    // The bridge entry exists only where the bridge does, and says it is the test networks.
    assert.match(text(render({account, agents: [], customerWallet: cw, arcFunding: {enabled: true}})), /Test-network simulation: move test USDC from Base Sepolia to Arc Testnet/);
    assert.doesNotMatch(text(render({account, agents: [], customerWallet: cw})), /Bridge and recovery tools/);
  } finally { await vite.close(); await f.close(); }
});

test('Move USDC to Arc: no default destination (never the Base wallet\'s own address), an explicit network review and a confirmation before anything can be sent', async () => {
  const {render} = await loader(); const f = await setup();
  try {
    await funded(f, owner, 5000);
    const base = await f.cw.state(owner);
    const live = {...base, simulated: false, live: true, wallet: {...base.wallet, simulated: false, status: 'ready', address: '0x' + 'ab'.repeat(20)},
      bridge: {available: true, reason: null, route: {label: 'Base to Arc (mainnet, real money)', environment: 'mainnet', destination: 'Arc', chainId: 5042}, items: []}};
    const html = render({account, agents: [], customerWallet: live});
    const t = text(html);
    assert.match(t, /Move USDC to Arc/); assert.match(t, /Destination network: Arc \(mainnet, real money\) · chain 5042/);
    assert.match(t, /I control this address on Arc and have checked every character/);
    const form = html.slice(html.indexOf('id="cw-bridge"'), html.indexOf('</form>', html.indexOf('id="cw-bridge"')));
    assert.ok(!form.includes('ab'.repeat(20)), 'the wallet\'s own Base address is not offered, prefilled or used as a placeholder');
    assert.match(form, /<input[^>]*type="checkbox"[^>]*>/); assert.doesNotMatch(form, /checked=""/, 'not pre-confirmed');
    assert.match(form, /<button[^>]*disabled=""[^>]*>Review move<\/button>/, 'cannot be submitted until an address is typed and confirmed');
    assert.match(readFileSync(new URL('../src/WalletBridge.jsx', import.meta.url), 'utf8'), /confirmDestination: form\.confirmed === true/);
    // An unavailable move says why and offers no form at all.
    const off = text(render({account, agents: [], customerWallet: {...live, bridge: {available: false, reason: 'The live Base to Arc transport is not installed in this deployment.', items: []}}}));
    assert.match(off, /Not available yet/); assert.doesNotMatch(off, /I control this address/);
  } finally { await f.close(); }
});
