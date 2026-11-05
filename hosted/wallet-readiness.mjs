// Read-only readiness report for the live customer wallet. It reports which settings are present and consistent and,
// when asked, makes ONE read-only Circle call (list users, page size 1) to prove the API key is accepted.
// It never prints a value that came from the environment other than the non-secret choices (mode, network, account type,
// gas model, allowed origins) and the key's environment kind (TEST/LIVE). It creates nothing and moves nothing.
import {walletConfigFromEnv, validateWalletConfig} from './wallet-providers.mjs';
import {WALLET_NETWORKS} from '../shared/wallet-model.mjs';
import {CIRCLE_WEB_SDK_FRAME_ORIGINS} from './wallet-csp.mjs';

const SETTINGS = [
  ['EUPOVA_WALLET_MODE', 'mode'], ['EUPOVA_WALLET_NETWORK', 'network'], ['EUPOVA_CIRCLE_UCW_API_KEY', 'apiKey'],
  ['EUPOVA_CIRCLE_UCW_APP_ID', 'appId'], ['EUPOVA_CIRCLE_UCW_USER_ID_SECRET', 'userIdSecret'],
  ['EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE', 'accountType'], ['EUPOVA_CIRCLE_UCW_GAS_MODEL', 'gasModel'],
];
const SECRET = new Set(['apiKey', 'appId', 'userIdSecret']);

export async function runReadiness({env, online = false, loadSdk = () => import('@circle-fin/user-controlled-wallets')}) {
  const config = walletConfigFromEnv(env);
  const check = validateWalletConfig(config);
  const problems = new Map((check.problems ?? []).map(p => [p.env, p.what ?? p.why ?? 'invalid']));
  const lines = [];
  for (const [name, key] of SETTINGS) {
    const present = typeof env[name] === 'string' && env[name].trim() !== '';
    let status = !present ? 'MISSING' : problems.has(name) ? 'INVALID' : 'ok';
    let shown = '';
    if (present && !SECRET.has(key)) shown = String(config[key]);
    if (key === 'apiKey' && present) shown = /^LIVE_API_KEY:/.test(env[name]) ? 'LIVE key' : /^TEST_API_KEY:/.test(env[name]) ? 'TEST key' : 'unrecognised kind';
    if (SECRET.has(key) && present && key !== 'apiKey') shown = 'set (value hidden)';
    lines.push({name, status, shown, note: problems.get(name) ?? ''});
  }
  const net = WALLET_NETWORKS[config.network];
  const report = {
    requested: check.requested, ready: check.ready === true, lines,
    network: net ? {id: net.id, label: net.label, environment: net.environment, chainId: net.chainId, usdc: net.usdc} : null,
    realMoney: net?.environment === 'mainnet', online: null,
  };
  if (online) {
    if (!report.ready) report.online = {ran: false, why: 'Fix the settings above first; no Circle call was made.'};
    else {
      try {
        const sdk = await loadSdk();
        const client = sdk.initiateUserControlledWalletsClient({apiKey: config.apiKey, ...(config.baseUrl ? {baseUrl: config.baseUrl} : {})});
        await client.listUsers({pageSize: 1});
        report.online = {ran: true, ok: true, what: 'Circle accepted the API key for a read-only list of users (page size 1).'};
      } catch (e) {
        const r = e?.response;
        report.online = {ran: true, ok: false, httpStatus: r?.status ?? null, circleCode: r?.data?.code ?? null, what: 'Circle did not accept the read-only call. Check the key type, its permissions and that its environment matches the network.'};
      }
    }
  }
  return report;
}

export function formatReadiness(r) {
  const out = [];
  out.push(r.requested ? 'Live wallet is REQUESTED (EUPOVA_WALLET_MODE=live).' : 'Live wallet is NOT requested: EUPOVA_WALLET_MODE is not exactly "live". The wallet stays off.');
  for (const l of r.lines) out.push(`  ${l.status.padEnd(8)} ${l.name}${l.shown ? '  = ' + l.shown : ''}${l.note ? '  <- ' + l.note : ''}`);
  out.push(`Page policy: frame-src gets exactly ${CIRCLE_WEB_SDK_FRAME_ORIGINS.join(' ')} (built in, no wildcard, nothing to set).`);
  if (r.network) out.push(`Network: ${r.network.label}, chain ${r.network.chainId}, USDC ${r.network.usdc}${r.realMoney ? '  ** REAL MONEY **' : '  (test network)'}`);
  out.push(r.ready ? 'READY: every setting is present and consistent.' : 'NOT READY: the wallet will not be offered until the items above are fixed.');
  if (r.online) out.push(r.online.ran ? `Online read-only check: ${r.online.ok ? 'OK. ' : 'FAILED (HTTP ' + r.online.httpStatus + ', code ' + r.online.circleCode + '). '}${r.online.what}` : `Online read-only check skipped. ${r.online.why}`);
  out.push('Not checked here: the Console application id, PIN setup, the Circle step in a browser, fee estimates, or any transaction. Test those with the owner flow.');
  return out.join('\n');
}
