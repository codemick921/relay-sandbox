import {randomUUID} from 'node:crypto';
import {fixture} from './account-store.mjs';
import {createCustomerWallet} from '../../hosted/customer-wallet.mjs';
import {createSimulatedWalletProvider} from '../../hosted/wallet-providers.mjs';

export const owner = 'customer:' + randomUUID();
export const other = 'customer:' + randomUUID();
export const DEST = '0x' + 'd'.repeat(40);
export async function setup(opts = {}) {
  const f = await fixture();
  const cw = createCustomerWallet({store: f.store, provider: opts.provider ?? createSimulatedWalletProvider({outcome: opts.outcome}), clock: opts.clock});
  await cw.migrate();
  return {...f, cw};
}
export async function funded(f, who = owner, pence = 5000) {
  const w = await f.cw.createWallet(who, {label: 'My Eupova wallet', requestId: randomUUID()});
  await f.cw.addTestMoney(who, {requestId: randomUUID(), pence});
  return w.id;
}
export const send = (f, who, over = {}) => f.cw.payments.send(who, {requestId: randomUUID(), destination: DEST, amount: '2.50', maxFee: '0.05', service: 'Send', ...over});
export const pending = async (f, who) => (await f.cw.state(who)).pendingApprovals;
export const approve = async (f, who, id) => {
  const p = (await f.cw.state(who)).payments.find(x => x.id === id);
  return f.cw.payments.decide(who, {id, decision: 'approve', bindingHash: p.fingerprint});
};
