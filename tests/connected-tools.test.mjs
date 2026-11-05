import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup, funded, send, owner, other, DEST} from './fixtures/wallet-helpers.mjs';
import {ALLOWANCE_CONFIRMATION} from '../hosted/wallet-tools.mjs';

const C = ALLOWANCE_CONFIRMATION;
async function connect(f, who = owner, name = 'Test CLI') {
  const e = await f.cw.tools.enrolStart({name, ip: '127.0.0.1'});
  const t = await f.cw.tools.approveEnrolment(who, {userCode: e.userCode});
  const got = await f.cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: e.deviceSecret, ip: '127.0.0.1'});
  return {toolId: t.id, token: got.token, tool: await f.cw.tools.authenticate(got.token)};
}
const allow = (f, who, toolId, over = {}) => f.cw.tools.setAllowance(who, {toolId, amount: '10', hours: 24, confirm: true, confirmation: C, ...over});
const ask = (f, tool, over = {}, key = randomUUID()) => f.cw.tools.requestPayment(tool, key, {service: 'Weather API', destination: DEST, amount: '1', maxFee: '0.05', ...over});
const view = async (f, who, id) => (await f.cw.state(who)).payments.find(p => p.id === id);
const decide = async (f, who, id, decision = 'approve') => f.cw.payments.decide(who, {id, decision, bindingHash: (await view(f, who, id)).fingerprint});
const tool0 = async (f, who) => (await f.cw.state(who)).tools[0];

test('enrolment is a device flow: the tool gets a code, the customer approves it, the credential is collected once and stored hashed', async () => {
  const f = await setup();
  try {
    await funded(f);
    await assert.rejects(f.cw.tools.enrolStart({name: 'x', ip: '1'}), e => e.status === 400);
    const e = await f.cw.tools.enrolStart({name: 'My CLI', ip: '10.0.0.1'});
    assert.match(e.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/); assert.match(e.deviceSecret, /^eds_/);
    assert.deepEqual(await f.cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: e.deviceSecret}), {status: 'pending'});
    await assert.rejects(f.cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: 'eds_wrong'}), x => x.status === 404);
    await assert.rejects(f.cw.tools.approveEnrolment(owner, {userCode: 'AAAA-AAAA'}), x => x.status === 404);
    await assert.rejects(f.cw.tools.approveEnrolment(owner, {userCode: 'nope'}), x => x.status === 400);
    const t = await f.cw.tools.approveEnrolment(owner, {userCode: e.userCode.toLowerCase()});
    const got = await f.cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: e.deviceSecret});
    assert.equal(got.status, 'approved'); assert.match(got.token, /^eut_[A-Za-z0-9_-]{43}$/); assert.equal(got.toolId, t.id);
    assert.deepEqual(await f.cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: e.deviceSecret}), {status: 'collected'}, 'shown once');
    const stored = JSON.stringify((await f.store.query('SELECT * FROM relay_cw_tools')).rows) + JSON.stringify((await f.store.query('SELECT * FROM relay_cw_enrolments')).rows);
    assert.ok(!stored.includes(got.token) && !stored.includes(e.deviceSecret), 'only hashes are stored');
    assert.equal((await f.cw.tools.authenticate(got.token)).id, t.id);
    for (const bad of ['', 'eut_short', 'Bearer x', null, got.token.slice(0, -1) + (got.token.endsWith('A') ? 'B' : 'A')]) await assert.rejects(f.cw.tools.authenticate(bad), x => x.status === 401);
    // An expired code cannot be approved; a used code cannot be reused.
    const e2 = await f.cw.tools.enrolStart({name: 'Late', ip: '1'});
    await f.store.query("UPDATE relay_cw_enrolments SET expires_at=now()-interval '1 minute' WHERE id=$1", [e2.enrolmentId]);
    await assert.rejects(f.cw.tools.approveEnrolment(owner, {userCode: e2.userCode}), x => x.status === 404);
    assert.deepEqual(await f.cw.tools.enrolPoll({enrolmentId: e2.enrolmentId, deviceSecret: e2.deviceSecret}), {status: 'expired'});
    await assert.rejects(f.cw.tools.approveEnrolment(owner, {userCode: e.userCode}), x => x.status === 404);
    // Someone without a wallet cannot approve anything.
    const e3 = await f.cw.tools.enrolStart({name: 'Third', ip: '1'});
    await assert.rejects(f.cw.tools.approveEnrolment(other, {userCode: e3.userCode}), x => x.status === 409);
  } finally { await f.close(); }
});

test('both controls: no allowance refuses even if approved; an allowance alone pays nothing; both together pay once', async () => {
  const f = await setup();
  try {
    await funded(f);
    const {toolId, tool} = await connect(f);
    assert.equal((await tool0(f, owner)).allowance, null, 'default allowance is none');
    const none = await ask(f, tool);
    let p = await view(f, owner, none.id);
    assert.equal(p.status, 'rejected'); assert.equal(p.reasonCode, 'no_allowance');
    await assert.rejects(f.cw.payments.decide(owner, {id: none.id, decision: 'approve', bindingHash: p.fingerprint}), e => e.status === 409, 'approved or not, a refused request never pays');
    const startBalance = (await f.cw.state(owner)).balance.raw;
    // Confirmation is mandatory and exact; amount and time are the customer's choice within limits.
    for (const over of [{confirm: false}, {confirmation: 'ok'}, {amount: '0'}, {amount: '100.000001'}, {amount: '1e1'}, {hours: 0}, {hours: 721}, {hours: 1.5}]) await assert.rejects(allow(f, owner, toolId, over), e => e.status === 400, JSON.stringify(over));
    await assert.rejects(allow(f, other, toolId), e => e.status === 409 || e.status === 404, 'not another customer\'s tool');
    await allow(f, owner, toolId);
    const a = (await tool0(f, owner)).allowance;
    assert.equal(a.amountUsdc, '10.000000'); assert.equal(a.remainingUsdc, '10.000000'); assert.equal(a.active, true); assert.equal(a.revision, 1);
    // Within the allowance but not approved: nothing moves.
    const r = await ask(f, tool);
    p = await view(f, owner, r.id);
    assert.equal(p.status, 'awaiting_approval'); assert.equal(p.tool.name, 'Test CLI'); assert.equal(p.service, 'Weather API'); assert.equal(p.networkId, 'base_sepolia');
    assert.equal(p.amountUsdc, '1.000000'); assert.equal(p.maxFeeUsdc, '0.050000'); assert.equal(p.capUsdc, '1.050000'); assert.equal(p.destination, DEST);
    assert.equal((await f.cw.state(owner)).balance.raw, startBalance, 'allowance alone moves nothing');
    assert.equal((await f.cw.tools.getPayment(tool, r.id)).status, 'awaiting_approval');
    // Approve: paid once, allowance consumed by amount + fee.
    const done = await decide(f, owner, r.id);
    assert.equal(done.status, 'succeeded');
    const after = await f.cw.state(owner);
    assert.equal(BigInt(startBalance) - BigInt(after.balance.raw), 1_010_000n);
    assert.equal(after.tools[0].allowance.spentUsdc, '1.010000'); assert.equal(after.tools[0].allowance.remainingUsdc, '8.990000');
    const toolSees = await f.cw.tools.getPayment(tool, r.id);
    assert.equal(toolSees.status, 'succeeded'); assert.equal(toolSees.receipt.simulated, true); assert.match(toolSees.receipt.ref, /^sim-pay-/);
    assert.deepEqual(Object.keys(await f.cw.tools.allowanceFor(tool)).sort(), ['allowance', 'note', 'tool']);
  } finally { await f.close(); }
});

test('a tool request is refused when it breaks the rules, and is replay-safe', async () => {
  const f = await setup();
  try {
    await funded(f);
    const {toolId, tool} = await connect(f);
    await allow(f, owner, toolId, {amount: '3'});
    for (const over of [{network: 'base'}, {network: 'ethereum'}, {token: 'EURC'}, {amount: '0.0000001'}, {amount: '1e2'}, {destination: '0x0'}, {destination: '0x' + '0'.repeat(40)}, {maxFee: '-1'}, {amount: 1}]) await assert.rejects(ask(f, tool, over), e => e.status === 400, JSON.stringify(over));
    await assert.rejects(f.cw.tools.requestPayment(tool, randomUUID(), {service: 'x', destination: DEST, amount: '1', maxFee: '0', evil: 1}), e => e.status === 400, 'unknown fields');
    await assert.rejects(f.cw.tools.requestPayment(tool, 'short', {service: 'Svc', destination: DEST, amount: '1'}), e => e.status === 400, 'idempotency key required');
    const over = await ask(f, tool, {amount: '3'});
    assert.equal((await view(f, owner, over.id)).reasonCode, 'over_allowance', 'amount plus fee exceeds the allowance');
    const rich = await ask(f, tool, {amount: '2.95', maxFee: '0.05'});
    assert.equal((await view(f, owner, rich.id)).status, 'awaiting_approval', 'exactly the allowance is fine');
    const key = randomUUID();
    const a = await ask(f, tool, {}, key), b = await ask(f, tool, {}, key);
    assert.equal(a.id, b.id); assert.equal(b.replay, true);
    await assert.rejects(ask(f, tool, {amount: '1.5'}, key), e => e.status === 409, 'same key, different details');
    await decide(f, owner, a.id);
    const again = await ask(f, tool, {}, key);
    assert.equal(again.id, a.id, 'a replay after payment returns the same request and never pays again');
    assert.equal((await f.store.query("SELECT count(*) FROM relay_cw_ledger WHERE payment_id=$1 AND kind='payment'", [a.id])).rows[0].count.toString(), '1');
    // Insufficient balance is refused at request time too.
    const f2 = await setup();
    try {
      await funded(f2, owner, 200);
      const c = await connect(f2); await allow(f2, owner, c.toolId, {amount: '10'});
      const poor = await ask(f2, c.tool, {amount: '5'});
      assert.equal((await view(f2, owner, poor.id)).reasonCode, 'insufficient_balance');
    } finally { await f2.close(); }
  } finally { await f.close(); }
});

test('overspend: requests that together exceed the allowance are each approvable only while room remains', async () => {
  const f = await setup();
  try {
    await funded(f, owner, 5000);
    const {toolId, tool} = await connect(f);
    await allow(f, owner, toolId, {amount: '3'});
    const a = await ask(f, tool, {amount: '1.5', maxFee: '0.05'}), b = await ask(f, tool, {amount: '1.5', maxFee: '0.05'});
    assert.equal((await view(f, owner, b.id)).status, 'awaiting_approval', 'both fit on their own');
    assert.equal((await decide(f, owner, a.id)).status, 'succeeded');
    await assert.rejects(decide(f, owner, b.id), e => e.status === 409 && /allowance/.test(e.message));
    const pb = await view(f, owner, b.id);
    assert.equal(pb.status, 'rejected'); assert.equal(pb.reasonCode, 'over_allowance');
    const s = await f.cw.state(owner);
    assert.equal(s.tools[0].allowance.spentUsdc, '1.510000'); assert.equal(s.tools[0].allowance.remainingUsdc, '1.490000');
    assert.equal(BigInt(s.balance.raw), 61_250_000n - 1_510_000n, 'only the first payment left the wallet');
  } finally { await f.close(); }
});

test('concurrency: parallel approvals never exceed the allowance or the balance, and one approval pays once', async () => {
  const f = await setup();
  try {
    await funded(f, owner, 5000); // 61.25 USDC
    const {toolId, tool} = await connect(f);
    await allow(f, owner, toolId, {amount: '5'});
    const reqs = [];
    for (let i = 0; i < 8; i++) reqs.push((await ask(f, tool, {amount: '1', maxFee: '0.05', service: 'Svc ' + i})).id);
    const fp = Object.fromEntries((await f.cw.state(owner)).payments.map(p => [p.id, p.fingerprint]));
    const results = await Promise.allSettled(reqs.map(id => f.cw.payments.decide(owner, {id, decision: 'approve', bindingHash: fp[id]})));
    const ok = results.filter(r => r.status === 'fulfilled' && r.value.status === 'succeeded').length;
    assert.equal(ok, 4, 'four payments of 1.05 fit in 5; the rest are refused');
    const s = await f.cw.state(owner);
    const a = s.tools[0].allowance;
    assert.equal(a.spentUsdc, '4.040000'); assert.equal(a.reservedUsdc, '0.000000');
    assert.equal(BigInt(s.balance.raw), 61_250_000n - 4_040_000n);
    const row = (await f.store.query('SELECT spent_raw::text s, reserved_raw::text r, amount_raw::text a FROM relay_cw_allowances')).rows[0];
    assert.ok(BigInt(row.s) + BigInt(row.r) <= BigInt(row.a));
    assert.equal(s.payments.filter(p => p.status === 'rejected' && p.reasonCode === 'over_allowance').length, 4);
    // The same approval fired six times at once pays exactly once.
    const one = (await ask(f, tool, {amount: '0.5', maxFee: '0'})).id;
    await f.cw.tools.setAllowance(owner, {toolId, amount: '10', hours: 24, confirm: true, confirmation: C, expectedRevision: 1});
    const fresh = await ask(f, tool, {amount: '0.25', maxFee: '0'});
    const h = (await view(f, owner, fresh.id)).fingerprint;
    const par = await Promise.allSettled(Array.from({length: 6}, () => f.cw.payments.decide(owner, {id: fresh.id, decision: 'approve', bindingHash: h})));
    assert.ok(par.every(r => r.status === 'fulfilled'), 'repeats are harmless');
    assert.equal((await f.store.query("SELECT count(*) FROM relay_cw_ledger WHERE payment_id=$1 AND kind='payment'", [fresh.id])).rows[0].count.toString(), '1');
    void one;
  } finally { await f.close(); }
});

test('concurrency: parallel customer sends cannot overdraw the wallet', async () => {
  const f = await setup();
  try {
    await funded(f, owner, 200); // 2.45 USDC
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await send(f, owner, {amount: '0.8', maxFee: '0.01', service: 'S' + i})).id);
    const fp = Object.fromEntries((await f.cw.state(owner)).payments.map(p => [p.id, p.fingerprint]));
    const res = await Promise.allSettled(ids.map(id => f.cw.payments.decide(owner, {id, decision: 'approve', bindingHash: fp[id]})));
    assert.equal(res.filter(r => r.status === 'fulfilled').length, 3, '3 x 0.81 = 2.43 fits in 2.45');
    const ids2 = [];
    await f.cw.addTestMoney(owner, {requestId: randomUUID(), pence: 200});
    for (let i = 0; i < 4; i++) ids2.push((await send(f, owner, {amount: '0.8', maxFee: '0.01', service: 'T' + i})).id);
    const fp2 = Object.fromEntries((await f.cw.state(owner)).payments.map(p => [p.id, p.fingerprint]));
    const r2 = await Promise.allSettled(ids2.map(id => f.cw.payments.decide(owner, {id, decision: 'approve', bindingHash: fp2[id]})));
    const paid = r2.filter(r => r.status === 'fulfilled').length;
    const s = await f.cw.state(owner);
    assert.ok(BigInt(s.balance.raw) >= 0n, 'the balance never goes negative');
    assert.equal(paid, 3, 'only as many as the balance covers');
    assert.equal(paid + r2.filter(r => r.status === 'rejected').length, 4);
  } finally { await f.close(); }
});

test('stale details: editing, expiring or revoking an allowance or tool cancels approvals; nothing pays', async () => {
  const f = await setup();
  try {
    await funded(f);
    const {toolId, tool, token} = await connect(f);
    await allow(f, owner, toolId);
    const bal = () => f.cw.state(owner).then(s => s.balance.raw);
    const start = await bal();
    // 1. Editing the allowance cancels the waiting request.
    const r1 = await ask(f, tool);
    const old = (await view(f, owner, r1.id)).fingerprint;
    await f.cw.tools.setAllowance(owner, {toolId, amount: '5', hours: 12, confirm: true, confirmation: C, expectedRevision: 1});
    assert.equal((await view(f, owner, r1.id)).status, 'invalidated');
    await assert.rejects(f.cw.payments.decide(owner, {id: r1.id, decision: 'approve', bindingHash: old}), e => e.status === 409);
    await assert.rejects(f.cw.tools.setAllowance(owner, {toolId, amount: '5', hours: 12, confirm: true, confirmation: C, expectedRevision: 1}), e => e.status === 409, 'stale revision');
    // The allowance cannot drop below what is already used or sending.
    const r2 = await ask(f, tool); await decide(f, owner, r2.id);
    await assert.rejects(f.cw.tools.setAllowance(owner, {toolId, amount: '1', hours: 1, confirm: true, confirmation: C, expectedRevision: 2}), e => e.status === 409);
    // 2. An allowance that expires after the request was made refuses the approval.
    const r3 = await ask(f, tool); const h3 = (await view(f, owner, r3.id)).fingerprint;
    await f.store.query("UPDATE relay_cw_allowances SET expires_at=now()-interval '1 second' WHERE status='active'");
    await assert.rejects(f.cw.payments.decide(owner, {id: r3.id, decision: 'approve', bindingHash: h3}), e => e.status === 409);
    assert.equal((await view(f, owner, r3.id)).status, 'invalidated');
    const r4 = await ask(f, tool);
    assert.equal((await view(f, owner, r4.id)).reasonCode, 'allowance_expired');
    // 3. Revoking the allowance cancels waiting requests and refuses new ones.
    await f.store.query("UPDATE relay_cw_allowances SET expires_at=now()+interval '1 day' WHERE status='active'");
    const r5 = await ask(f, tool);
    await f.cw.tools.revokeAllowance(owner, {toolId});
    assert.equal((await view(f, owner, r5.id)).status, 'invalidated');
    assert.equal((await view(f, owner, (await ask(f, tool)).id)).reasonCode, 'no_allowance');
    await assert.rejects(f.cw.tools.revokeAllowance(owner, {toolId}), e => e.status === 404);
    // 4. A new allowance after revocation is a fresh, separate permission.
    await allow(f, owner, toolId, {amount: '2'});
    const r6 = await ask(f, tool);
    // 5. Revoking the tool: the credential stops working and its waiting request is cancelled.
    await f.cw.tools.revokeTool(owner, {toolId});
    await assert.rejects(f.cw.tools.authenticate(token), e => e.status === 401);
    await assert.rejects(ask(f, tool), e => e.status === 401, 'an in-flight tool object is re-checked against the database');
    assert.equal((await view(f, owner, r6.id)).status, 'invalidated');
    await assert.rejects(decide(f, owner, r6.id), e => e.status === 409);
    assert.equal(BigInt(start) - BigInt(await bal()), 1_010_000n, 'only the one approved payment ever left the wallet');
    await f.cw.tools.revokeTool(owner, {toolId}); // idempotent
  } finally { await f.close(); }
});

test('cross-owner: another customer cannot approve, read, edit or revoke; a tool cannot read another tool\'s requests', async () => {
  const f = await setup();
  try {
    await funded(f); await funded(f, other);
    const a = await connect(f, owner, 'A tool'), b = await connect(f, other, 'B tool');
    await allow(f, owner, a.toolId); await allow(f, other, b.toolId);
    const ra = await ask(f, a.tool);
    const fp = (await view(f, owner, ra.id)).fingerprint;
    await assert.rejects(f.cw.payments.decide(other, {id: ra.id, decision: 'approve', bindingHash: fp}), e => e.status === 404);
    await assert.rejects(f.cw.tools.setAllowance(other, {toolId: a.toolId, amount: '1', hours: 1, confirm: true, confirmation: C}), e => e.status === 404);
    await assert.rejects(f.cw.tools.revokeTool(other, {toolId: a.toolId}), e => e.status === 404);
    await assert.rejects(f.cw.tools.revokeAllowance(other, {toolId: a.toolId}), e => e.status === 404);
    await assert.rejects(f.cw.tools.getPayment(b.tool, ra.id), e => e.status === 404, 'tool B cannot see tool A\'s request');
    assert.equal((await f.cw.tools.allowanceFor(b.tool)).tool, 'B tool');
    assert.equal((await f.cw.state(other)).payments.length, 0);
    assert.equal((await view(f, owner, ra.id)).status, 'awaiting_approval', 'untouched');
    // The same idempotency key is independent per tool.
    const key = randomUUID();
    const x = await ask(f, a.tool, {}, key), y = await ask(f, b.tool, {}, key);
    assert.notEqual(x.id, y.id);
  } finally { await f.close(); }
});

test('unknown outcome fails closed: funds stay reserved, nothing retries, the customer decides what happened', async () => {
  const calls = [];
  const f = await setup({outcome: p => { calls.push(p.id); return 'unknown'; }});
  try {
    await funded(f);
    const {toolId, tool} = await connect(f); await allow(f, owner, toolId);
    const start = (await f.cw.state(owner)).balance;
    const r = await ask(f, tool);
    const out = await decide(f, owner, r.id);
    assert.equal(out.status, 'outcome_unknown');
    assert.equal(calls.length, 1);
    let s = await f.cw.state(owner);
    assert.equal(s.balance.raw, start.raw, 'no ledger entry was invented'); assert.equal(s.balance.reservedUsdc, '1.050000');
    assert.equal(BigInt(start.raw) - BigInt(s.balance.raw), 0n);
    assert.equal(s.tools[0].allowance.reservedUsdc, '1.050000'); assert.equal(s.tools[0].allowance.remainingUsdc, '8.950000');
    assert.equal(s.pendingApprovals.some(p => p.id === r.id && p.canCheckOutcome), true);
    // Repeated approvals, polls and state reads never call the provider again.
    await decide(f, owner, r.id); await f.cw.tools.getPayment(tool, r.id); await f.cw.state(owner);
    assert.equal(calls.length, 1, 'no automatic retry');
    await assert.rejects(f.cw.payments.reconcile(other, {id: r.id, outcome: 'not_sent'}), e => e.status === 404);
    await assert.rejects(f.cw.payments.reconcile(owner, {id: r.id, outcome: 'maybe'}), e => e.status === 400);
    await f.cw.payments.reconcile(owner, {id: r.id, outcome: 'not_sent'});
    s = await f.cw.state(owner);
    assert.equal(s.balance.reservedUsdc, '0.000000'); assert.equal(s.tools[0].allowance.reservedUsdc, '0.000000'); assert.equal(s.balance.raw, start.raw);
    await assert.rejects(f.cw.payments.reconcile(owner, {id: r.id, outcome: 'sent'}), e => e.status === 409, 'decided once');
    // "Sent" posts the full cap (the exact fee is not known) and consumes the allowance.
    const r2 = await ask(f, tool); await decide(f, owner, r2.id);
    await f.cw.payments.reconcile(owner, {id: r2.id, outcome: 'sent'});
    s = await f.cw.state(owner);
    assert.equal(BigInt(start.raw) - BigInt(s.balance.raw), 1_050_000n); assert.equal(s.tools[0].allowance.spentUsdc, '1.050000'); assert.equal(s.balance.reservedUsdc, '0.000000');
  } finally { await f.close(); }
});

test('provider crashes, definite refusals and over-limit fees are handled without moving money wrongly', async () => {
  for (const [name, outcome, expect] of [['crash', () => 'throw', 'outcome_unknown'], ['refusal', () => 'definite_failure', 'failed']]) {
    const f = await setup({outcome});
    try {
      await funded(f);
      const {toolId, tool} = await connect(f); await allow(f, owner, toolId);
      const start = (await f.cw.state(owner)).balance.raw;
      const r = await ask(f, tool);
      assert.equal((await decide(f, owner, r.id)).status, expect, name);
      const s = await f.cw.state(owner);
      assert.equal(s.balance.raw, start);
      assert.equal(s.tools[0].allowance.spentUsdc, '0.000000');
      assert.equal(s.tools[0].allowance.reservedUsdc, expect === 'failed' ? '0.000000' : '1.050000');
    } finally { await f.close(); }
  }
  // A provider that reports a fee above the customer's maximum is not trusted: fail closed.
  const base = (await import('../hosted/wallet-providers.mjs')).createSimulatedWalletProvider();
  const greedy = {...base, executeTransfer: async p => ({state: 'confirmed', ref: 'sim-pay-aaaaaaaaaaaa', feeRaw: (BigInt(p.maxFeeRaw) + 1n).toString()})};
  const f = await setup({provider: greedy});
  try {
    await funded(f); const {toolId, tool} = await connect(f); await allow(f, owner, toolId);
    const start = (await f.cw.state(owner)).balance.raw;
    const r = await ask(f, tool);
    assert.equal((await decide(f, owner, r.id)).status, 'outcome_unknown');
    assert.equal((await f.cw.state(owner)).balance.raw, start);
  } finally { await f.close(); }
});

test('request expiry: a request nobody approved lapses and cannot be approved later', async () => {
  const f = await setup();
  try {
    await funded(f);
    const {toolId, tool} = await connect(f); await allow(f, owner, toolId);
    const r = await ask(f, tool); const h = (await view(f, owner, r.id)).fingerprint;
    await f.store.query("UPDATE relay_cw_payments SET expires_at=now()-interval '1 second' WHERE id=$1", [r.id]);
    await assert.rejects(f.cw.payments.decide(owner, {id: r.id, decision: 'approve', bindingHash: h}), e => e.status === 409);
    assert.equal((await view(f, owner, r.id)).status, 'expired');
    assert.equal((await f.cw.tools.getPayment(tool, r.id)).status, 'expired');
  } finally { await f.close(); }
});

test('concurrent requests with one idempotency key create one request', async () => {
  const f = await setup();
  try {
    await funded(f);
    const {toolId, tool} = await connect(f); await allow(f, owner, toolId);
    const key = randomUUID();
    const res = await Promise.allSettled(Array.from({length: 8}, () => ask(f, tool, {}, key)));
    assert.ok(res.every(r => r.status === 'fulfilled'));
    assert.equal(new Set(res.map(r => r.value.id)).size, 1);
    assert.equal((await f.store.query('SELECT count(*) FROM relay_cw_payments WHERE tool_id=$1', [toolId])).rows[0].count.toString(), '1');
  } finally { await f.close(); }
});
