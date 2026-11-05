import {freePort} from './free-port.mjs';
import {fixture} from './account-store.mjs';
import {digest} from '../../hosted/db.mjs';
import {createCustomerWallet} from '../../hosted/customer-wallet.mjs';
import {liveProvider, FEE} from './live-provider.mjs';

export const PW = 'synthetic harbour lantern 4821', DEST = '0x' + 'd'.repeat(40);

// A PRODUCTION-shaped server: not the local preview, no tracking sandbox, a live wallet only if one is passed in.
export async function prod({live = true, status = null, netId = 'base_sepolia'} = {}) {
  const {createHostedServer} = await import('../../hosted/server.mjs');
  const f = await fixture();
  const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}};
  const cw = live ? createCustomerWallet({store: f.store, provider: liveProvider(netId, st)}) : null;
  if (cw) await cw.migrate();
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const config = {origin, host: `127.0.0.1:${port}`, testers: [{label: 'alice', sha256hex: digest('code-alice')}]};
  const server = createHostedServer({store: f.store, config, allowHttpForTests: true, paymentsDisabled: true, customerWallet: cw, customerWalletStatus: status, pay: {readiness: async () => ({ready: false})}});
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const call = async (path, body, cookie, headers = {}) => {
    const r = await fetch(origin + '/api/' + path, body === undefined ? {headers: {cookie: cookie ?? '', ...headers}} : {method: 'POST', headers: {'content-type': 'application/json', origin, cookie: cookie ?? '', ...headers}, body: JSON.stringify(body)});
    const text = await r.text();
    return {status: r.status, headers: r.headers, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]};
  };
  // A live wallet needs a signed-in customer with a VERIFIED email. signup() gives one; signupUnverified() does not.
  const signupUnverified = async email => (await call('account/signup', {email, name: 'Prod Tester', password: PW, acceptSandbox: true})).cookie;
  const signup = async email => { const c = await signupUnverified(email); await f.store.query('UPDATE relay_customers SET email_verified_at=now() WHERE lower(email)=lower($1)', [email]); return c; };
  return {f, cw, st, call, signup, signupUnverified, origin, close: async () => { await new Promise(r => server.close(r)); await f.close(); }};
}
