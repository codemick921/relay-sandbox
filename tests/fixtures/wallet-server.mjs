import {randomUUID} from 'node:crypto';
import {freePort} from './free-port.mjs';
import {fixture} from './account-store.mjs';
import {digest} from '../../hosted/db.mjs';
import {createCustomerWallet} from '../../hosted/customer-wallet.mjs';

export const DEST = '0x' + 'd'.repeat(40), PW = 'synthetic harbour lantern 4821';
export async function server(opts = {}) {
  const {createLiveStore} = await import('../../hosted/live-store.mjs');
  const {createFundingJourney, journeyMerchant} = await import('../../hosted/funding-journey.mjs');
  const {createHostedServer} = await import('../../hosted/server.mjs');
  const f = await fixture();
  const live = createLiveStore(f.pool, {merchantId: journeyMerchant}); await live.migrate();
  const journey = createFundingJourney({baseStore: f.store, store: live}); await journey.migrate();
  const cw = opts.cw ?? createCustomerWallet({store: f.store}); await cw.migrate();
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const config = {origin, host: `127.0.0.1:${port}`, testers: [{label: 'alice', sha256hex: digest('code-alice')}]};
  const srv = createHostedServer({store: f.store, config, paymentsDisabled: true, localPreview: true, tracking: {store: live, journey, simulated: true}, customerWallet: cw, pay: {readiness: async () => ({ready: false})}});
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  // Browser-style call: same-origin JSON with the session cookie.
  const web = async (path, body, cookie, headers = {}) => {
    const r = await fetch(origin + '/api/' + path, body === undefined ? {headers: {cookie: cookie ?? '', ...headers}} : {method: 'POST', headers: {'content-type': 'application/json', origin, cookie: cookie ?? '', ...headers}, body: JSON.stringify(body)});
    const text = await r.text();
    return {status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]};
  };
  // Tool-style call: bearer only, no cookie, no origin.
  const tool = async (method, path, body, token, headers = {}) => {
    const r = await fetch(origin + '/api/wallet-tool/v1/' + path, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await r.text();
    return {status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text};
  };
  const signup = async (email) => (await web('account/signup', {email, name: 'Wallet Tester', password: PW, acceptSandbox: true})).cookie;
  return {f, cw, web, tool, signup, origin, close: async () => { await new Promise(r => srv.close(r)); await f.close(); }};
}
