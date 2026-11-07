import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup, funded, send, owner, other, DEST} from './fixtures/wallet-helpers.mjs';

test('a customer creates a wallet inside Eupova and sees a recognisable wallet, clearly simulated', async () => {
  const f = await setup();
  try {
    const empty = await f.cw.state(owner);
    assert.equal(empty.wallet, null); assert.equal(empty.enabled, true); assert.equal(empty.simulated, true);
    assert.match(empty.label, /Test money only/);
    for (const bad of ['', 'x', 'a'.repeat(41), '<b>x</b>']) await assert.rejects(f.cw.createWallet(owner, {label: bad, requestId: randomUUID()}), e => e.status === 400);
    const requestId = randomUUID();
    const {id} = await f.cw.createWallet(owner, {label: ' My   Eupova wallet ', requestId});
    assert.deepEqual(await f.cw.createWallet(owner, {label: 'My Eupova wallet', requestId}), {id}, 'same request id is idempotent');
    await assert.rejects(f.cw.createWallet(owner, {label: 'Another', requestId: randomUUID()}), e => e.status === 409, 'one wallet per customer');
    const s = await f.cw.state(owner);
    assert.equal(s.wallet.label, 'My Eupova wallet');
    assert.match(s.wallet.address, /^0x51ed[0-9a-f]{36}$/, 'a clearly fake address');
    assert.equal(s.wallet.simulated, true); assert.match(s.wallet.addressNote, /exists on no network/);
    assert.equal(s.wallet.network, 'Base Sepolia (test network)'); assert.equal(s.wallet.token, 'USDC');
    assert.equal(s.balance.usdc, '0.000000'); assert.equal(s.balance.simulated, true);
    assert.equal(s.provider.id, 'simulated'); assert.match(s.provider.custody, /Nothing here can sign/);
    // The same address is saved as a receiving wallet so the existing Pay on Eupova flow funds this wallet.
    const agent = (await f.store.query('SELECT data FROM relay_agents WHERE owner=$1', [owner])).rows[0].data;
    assert.equal(agent.address, s.wallet.address); assert.equal(agent.ownership, 'eupova_customer_wallet'); assert.equal(agent.network, 'Base');
    assert.equal((await f.cw.state(other)).wallet, null, 'another customer sees nothing');
  } finally { await f.close(); }
});

test('adding money lands in the same wallet: simulated Pay credits and test money, each counted once', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.cw.addTestMoney(owner, {requestId: randomUUID(), pence: 2500}), e => e.status === 409, 'no wallet yet');
    const wid = await funded(f, owner, 2500);
    const s = await f.cw.state(owner);
    assert.equal(s.balance.usdc, '30.625000');
    assert.match(s.activity[0].label, /Pay on Eupova \(simulated\)/); assert.equal(s.activity[0].simulated, true);
    const rid = randomUUID();
    await f.cw.addTestMoney(owner, {requestId: rid, pence: 1000}); await f.cw.addTestMoney(owner, {requestId: rid, pence: 1000});
    assert.equal((await f.cw.state(owner)).balance.usdc, '42.875000', 'a repeated request id adds once');
    await assert.rejects(f.cw.addTestMoney(owner, {requestId: rid, pence: 1100}), e => e.status === 409);
    for (const pence of [199, 100001, 12.5, '2500', NaN]) await assert.rejects(f.cw.addTestMoney(owner, {requestId: randomUUID(), pence}), e => e.status === 400);
    // The existing Pay flow's received simulated order credits the same wallet exactly once.
    await f.store.query('CREATE TABLE IF NOT EXISTS relay_live_orders(id uuid PRIMARY KEY, owner text, status text, request jsonb, result jsonb)');
    const agentId = (await f.store.query('SELECT agent_id FROM relay_cw_wallets WHERE id=$1', [wid])).rows[0].agent_id;
    const oid = randomUUID();
    await f.store.query("INSERT INTO relay_live_orders VALUES($1,$2,'checkout_received',$3,$4)", [oid, owner, {agent: {id: agentId}}, {delivery: {amountRaw: '12000000'}}]);
    await f.store.query("INSERT INTO relay_live_orders VALUES($1,$2,'checkout_received',$3,$4)", [randomUUID(), owner, {agent: {id: randomUUID()}}, {delivery: {amountRaw: '99000000'}}]);
    await f.store.query("INSERT INTO relay_live_orders VALUES($1,$2,'checkout_confirming',$3,$4)", [randomUUID(), owner, {agent: {id: agentId}}, {delivery: {amountRaw: '77000000'}}]);
    await f.cw.state(owner);
    assert.equal((await f.cw.state(owner)).balance.usdc, '54.875000', 'only the received order for this wallet counted, once');
    assert.equal((await f.cw.state(other)).wallet, null);
  } finally { await f.close(); }
});

test('Send needs the customer\'s approval: wrong fingerprint refuses, approve pays, decline does not, receipt is a simulation', async () => {
  const f = await setup();
  try {
    await funded(f);
    const {id} = await send(f, owner);
    let s = await f.cw.state(owner);
    const p = s.pendingApprovals[0];
    assert.equal(p.id, id); assert.equal(p.status, 'awaiting_approval'); assert.equal(p.amountUsdc, '2.500000'); assert.equal(p.maxFeeUsdc, '0.050000'); assert.equal(p.capUsdc, '2.550000');
    assert.equal(p.destination, DEST); assert.equal(p.networkId, 'base_sepolia'); assert.equal(p.token, 'USDC'); assert.equal(s.balance.usdc, '61.250000');
    assert.match(p.fingerprint, /^[0-9a-f]{64}$/);
    const before = s.balance.raw;
    await assert.rejects(f.cw.payments.decide(owner, {id, decision: 'approve', bindingHash: '0'.repeat(64)}), e => e.status === 409);
    assert.equal((await f.cw.state(owner)).balance.raw, before, 'nothing moved on a wrong fingerprint');
    const done = await f.cw.payments.decide(owner, {id, decision: 'approve', bindingHash: p.fingerprint});
    assert.equal(done.status, 'succeeded');
    s = await f.cw.state(owner);
    assert.equal(BigInt(before) - BigInt(s.balance.raw), 2_510_000n, 'amount plus the simulated fee, nothing more');
    const r = s.payments.find(x => x.id === id).receipt;
    assert.equal(r.simulated, true); assert.match(r.ref, /^sim-pay-[0-9a-f]{12}$/); assert.match(r.note, /not a blockchain transaction/);
    assert.doesNotMatch(JSON.stringify(s), /0x[0-9a-fA-F]{64}/, 'no fabricated transaction hash');
    // A repeated approve is harmless and does not pay twice.
    await f.cw.payments.decide(owner, {id, decision: 'approve', bindingHash: p.fingerprint});
    assert.equal((await f.cw.state(owner)).balance.raw, s.balance.raw);
    // Decline.
    const d = await send(f, owner, {amount: '1'});
    const dp = (await f.cw.state(owner)).pendingApprovals[0];
    await f.cw.payments.decide(owner, {id: d.id, decision: 'decline', bindingHash: dp.fingerprint});
    const after = await f.cw.state(owner);
    assert.equal(after.balance.raw, s.balance.raw); assert.equal(after.payments.find(x => x.id === d.id).status, 'declined');
    await assert.rejects(f.cw.payments.decide(owner, {id: d.id, decision: 'approve', bindingHash: dp.fingerprint}), e => e.status === 409, 'a declined request cannot be approved later');
    // Not the customer's: another owner cannot see or decide it.
    await assert.rejects(f.cw.payments.decide(other, {id, decision: 'approve', bindingHash: p.fingerprint}), e => e.status === 404);
  } finally { await f.close(); }
});

test('Send refuses bad input, precision problems and overspend, and is idempotent', async () => {
  const f = await setup();
  try {
    await funded(f, owner, 200); // £2 -> 2.45 USDC
    for (const over of [{amount: '0'}, {amount: '-1'}, {amount: '1e3'}, {amount: '0.0000001'}, {amount: '1,5'}, {amount: ' 1'}, {amount: 2.5}, {maxFee: '1.0000001'}, {destination: '0x123'}, {destination: '0x' + '0'.repeat(40)}, {network: 'base'}, {network: 'ethereum'}, {token: 'EURC'}, {service: '<x>'}]) {
      await assert.rejects(send(f, owner, over), e => e.status === 400, JSON.stringify(over));
    }
    const w = (await f.cw.state(owner)).wallet;
    await assert.rejects(send(f, owner, {destination: w.address}), e => e.status === 400, 'cannot pay itself');
    await assert.rejects(send(f, owner, {amount: '2.5', maxFee: '0'}), e => e.status === 409, 'more than the balance');
    const requestId = randomUUID();
    const a = await send(f, owner, {requestId, amount: '1'}), b = await send(f, owner, {requestId, amount: '1'});
    assert.equal(a.id, b.id);
    await assert.rejects(send(f, owner, {requestId, amount: '1.000001'}), e => e.status === 409, 'same request id, different details');
    // Exact precision: one base unit is representable and paid exactly.
    const tiny = await send(f, owner, {amount: '0.000001', maxFee: '0'});
    const tp = (await f.cw.state(owner)).payments.find(x => x.id === tiny.id);
    assert.equal(tp.capUsdc, '0.000001');
  } finally { await f.close(); }
});
