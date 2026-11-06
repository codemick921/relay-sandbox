import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const SERVER = ['shared/wallet-model.mjs', 'hosted/wallet-providers.mjs', 'hosted/customer-wallet.mjs', 'hosted/wallet-payments.mjs', 'hosted/wallet-tools.mjs', 'hosted/wallet-fixtures.mjs', 'hosted/wallet-bridge.mjs', 'shared/wallet-bridge-route.mjs'];
const BROWSER = ['src/wallet-view.mjs', 'src/circle-challenge.mjs', 'src/CustomerWallet.jsx', 'src/WalletApprovals.jsx', 'src/WalletConnectedTools.jsx', 'src/WalletProviderSettings.jsx'];

test('the wallet code reads no environment, opens no network connection, holds no key, and logs nothing', () => {
  for (const f of [...SERVER, ...BROWSER]) {
    const src = read(f);
    assert.doesNotMatch(src, /process\.env|dotenv|readFileSync|writeFileSync/, f + ' reads environment or files');
    assert.doesNotMatch(src, /\bconsole\.(log|info|debug|warn|error)\b/, f + ' logs');
    assert.doesNotMatch(src, /privateKey|mnemonic|seed phrase|signTransaction|signMessage|eth_sign|personal_sign|new Wallet\(|createWalletClient/i, f + ' touches key material');
    assert.doesNotMatch(src, /from 'node:(http|https|net|tls|dgram)'|require\('(http|https|net)'\)/, f + ' opens connections');
  }
  for (const f of SERVER) {
    const src = read(f);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|axios/, f + ' makes requests itself');
    assert.doesNotMatch(src, /^import .*@circle-fin/m, f + ' imports an SDK at load time: the SDK is injected only through the closed gate');
  }
  for (const f of ['src/wallet-view.mjs', 'src/CustomerWallet.jsx', 'src/WalletApprovals.jsx', 'src/WalletConnectedTools.jsx', 'src/WalletProviderSettings.jsx']) assert.doesNotMatch(read(f), /\bfetch\(|@circle-fin|localStorage|sessionStorage|document\.cookie/, f);
  // The browser SDK is reachable only from the on-demand challenge runner.
  assert.match(read('src/circle-challenge.mjs'), /import\('@circle-fin\/w3s-pw-web-sdk'\)/);
  for (const f of BROWSER.filter(f => f !== 'src/circle-challenge.mjs')) assert.doesNotMatch(read(f), /w3s-pw-web-sdk/, f);
});

test('there is no custodial path: nothing in the wallet code can sign for a customer or move money without their decision', () => {
  const src = SERVER.map(read).join('\n');
  assert.doesNotMatch(src, /createDeveloperControlled|developer-controlled|initiateDeveloperControlledWalletsClient|entitySecret|createWallets\(|walletSetId/i);
  // Every code path that reserves or spends sits behind decide(), which needs the customer's fingerprint.
  const pay = read('hosted/wallet-payments.mjs');
  assert.equal((pay.match(/status='executing'/g) ?? []).length >= 1, true);
  assert.equal((pay.match(/SET status='executing',reserved_raw=/g) ?? []).length, 1, 'only one place ever reserves and starts a payment');
  assert.match(pay, /bindingHash !== p\.binding_hash|input\.bindingHash !== p\.binding_hash/);
  // The tool API cannot reach decide, allowance or revoke.
  const server = read('hosted/server.mjs');
  const toolBlock = server.slice(server.indexOf("/api/wallet-tool/v1/"), server.indexOf("/api/agent/v1/"));
  assert.doesNotMatch(toolBlock, /decide|setAllowance|revoke|approveEnrolment|createWallet|payments\.send/);
  assert.match(toolBlock, /req\.headers\.cookie\|\|req\.headers\.origin\|\|req\.headers\['sec-fetch-site'\]/);
});

test('the preview never contains a live provider: it is built only by the production entry from a validated configuration', () => {
  const preview = read('hosted/tracking-preview.mjs');
  assert.match(preview, /createCustomerWallet\(\{store\}\)/);
  assert.doesNotMatch(preview, /createCircleUserControlledProvider|EUPOVA_CIRCLE|configuredCustomerWallet|live-wallet/);
  for (const f of readdirSync(new URL('../hosted/', import.meta.url)).filter(f => f.endsWith('.mjs') && !['wallet-providers.mjs', 'live-wallet.mjs'].includes(f))) {
    assert.doesNotMatch(readFileSync(new URL('../hosted/' + f, import.meta.url), 'utf8'), /createCircleUserControlledProvider/, f);
  }
  const server = read('hosted/server.mjs');
  assert.match(server, /configuredCustomerWallet\(\{store,env:process\.env\}\)/);
  assert.ok(server.indexOf('configuredCustomerWallet({store') > server.indexOf("process.argv[1]===fileURLToPath(import.meta.url)"), 'wired only in the production entry, never in the exported server factory');
  // No reviewer declaration of any kind can open the provider.
  const providers = read('hosted/wallet-providers.mjs');
  assert.doesNotMatch(providers, /approved:\s*true|reviewed|circleGate|Object\.values\([^)]*\)\.every/);
});

test('docs state the model plainly, list the exact settings and blockers, and do not overclaim', () => {
  const doc = read('docs/customer-wallet.md');
  for (const need of ['Create my wallet', 'both controls', 'individual approval', 'default none', 'Live and simulated are separate', 'EUPOVA_WALLET_MODE', 'EUPOVA_WALLET_NETWORK', 'EUPOVA_CIRCLE_UCW_API_KEY', 'EUPOVA_CIRCLE_UCW_APP_ID', 'EUPOVA_CIRCLE_UCW_USER_ID_SECRET', 'EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE', 'EUPOVA_CIRCLE_UCW_GAS_MODEL', 'Not verified against Circle', 'Owner setup still needed', 'Activation (owner) and read-only readiness', 'node scripts/check-wallet-readiness.mjs', 'https://pw-auth.circle.com', 'EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE=EOA', 'package-lock.json', '10.8.1', '1.1.11', 'paid in **ETH**', 'The move is implemented and wired', 'EUPOVA_CIRCLE_UCW_GAS_DAILY_USD', 'EUPOVA_CIRCLE_UCW_GAS_PER_TX_USD', 'daily cap is the essential limit', 'never "free"', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']) assert.ok(doc.includes(need), need);
  assert.doesNotMatch(doc, /Circle integration is (complete|done|finished)|custody is undecided|go-ahead|reviewer/i);
  const render = read('render.yaml');
  for (const k of ['EUPOVA_WALLET_MODE', 'EUPOVA_WALLET_NETWORK', 'EUPOVA_CIRCLE_UCW_API_KEY', 'EUPOVA_CIRCLE_UCW_APP_ID', 'EUPOVA_CIRCLE_UCW_USER_ID_SECRET']) assert.ok(render.includes(k), k);
  // The mode is owned by the Render dashboard (sync: false), so a blueprint sync cannot switch the wallet on, and no
  // value or key can be committed here. This replaced an earlier assertion that the blueprint carried value: "off".
  assert.match(render, /key: EUPOVA_WALLET_MODE\n\s+sync: false/, 'mode comes from the dashboard, never the blueprint');
  assert.doesNotMatch(render, /key: EUPOVA_WALLET_MODE\n\s+value:/, 'no committed mode value');
  assert.doesNotMatch(render, /API_KEY:\w|LIVE_API_KEY|TEST_API_KEY/);
});
