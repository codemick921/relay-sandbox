import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {server, DEST} from './fixtures/wallet-server.mjs';
import {ALLOWANCE_CONFIRMATION} from '../hosted/wallet-tools.mjs';

const CLI = new URL('../scripts/eupova-tool-cli.mjs', import.meta.url).pathname;
const run = (home, ...args) => new Promise(resolve => execFile(process.execPath, [CLI, ...args], {env: {PATH: process.env.PATH, EUPOVA_TOOL_HOME: home}, timeout: 20000}, (err, stdout, stderr) => resolve({code: err?.code ?? 0, stdout, stderr})));

test('the CLI client enrols by code, stores its credential privately, never prints it, and cannot approve its own payments', async () => {
  const s = await server(), home = await mkdtemp(join(tmpdir(), 'eupova-cli-'));
  try {
    const cookie = await s.signup('cli@example.invalid');
    await s.web('wallet/create', {label: 'CLI wallet', requestId: randomUUID()}, cookie);
    await s.web('wallet/add-money', {requestId: randomUUID(), pence: 2500}, cookie);
    assert.equal((await run(home, 'enrol', '--url', 'http://example.com', '--name', 'x')).code, 1, 'plain http is refused except on loopback');
    assert.equal((await run(home, 'pay', '--service', 'x')).code, 1, 'not connected');
    const e = await run(home, 'enrol', '--url', s.origin, '--name', 'Test CLI');
    assert.equal(e.code, 0);
    const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(e.stdout)[1];
    assert.ok(!e.stdout.includes((JSON.parse(await readFile(join(home, 'pending.json'), 'utf8'))).deviceSecret), 'the device secret is not printed');
    const pre = await run(home, 'enrol-wait', '--timeout', '1', '--interval', '1');
    assert.equal(pre.code, 1); assert.match(pre.stderr, /Timed out/);
    // Timed out: start again, approve as the customer, then collect.
    const e2 = await run(home, 'enrol', '--url', s.origin, '--name', 'Test CLI');
    const code2 = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(e2.stdout)[1];
    const approved = (await s.web('wallet/tools/approve-enrolment', {userCode: code2}, cookie)).json;
    const toolId = approved.customerWallet.tools.find(t => t.name === 'Test CLI').id;
    const w = await run(home, 'enrol-wait', '--interval', '1');
    assert.equal(w.code, 0); assert.match(w.stdout, /Connected/);
    const cred = JSON.parse(await readFile(join(home, 'credentials.json'), 'utf8'));
    assert.match(cred.token, /^eut_/);
    assert.equal((await stat(join(home, 'credentials.json'))).mode & 0o777, 0o600, 'private file'); assert.equal((await stat(home)).mode & 0o777, 0o700, 'private folder');
    const outputs = [e, e2, w];
    // No allowance: refused, and the owner cannot even be asked.
    assert.match((await run(home, 'allowance')).stdout, /No allowance/);
    const refused = await run(home, 'pay', '--service', 'Weather API', '--to', DEST, '--amount', '1', '--max-fee', '0.05');
    outputs.push(refused);
    assert.match(refused.stdout, /rejected/); assert.match(refused.stdout, /no active allowance/);
    // The owner chooses an allowance (modest example: 10 USDC for 24 hours). Allowance alone pays nothing.
    await s.web('wallet/tools/allowance', {toolId, amount: '10', hours: 24, confirm: true, confirmation: ALLOWANCE_CONFIRMATION}, cookie);
    const al = await run(home, 'allowance'); outputs.push(al);
    assert.match(al.stdout, /10\.000000 of 10\.000000/); assert.match(al.stdout, /still needs the owner/);
    const key = randomUUID();
    const paid = await run(home, 'pay', '--service', 'Weather API', '--to', DEST, '--amount', '1.25', '--max-fee', '0.05', '--key', key);
    outputs.push(paid);
    assert.equal(paid.code, 0); assert.match(paid.stdout, /awaiting_approval/); assert.match(paid.stdout, /max fee:\s+0\.050000 USDC \(total cap 1\.300000\)/); assert.match(paid.stdout, /Base Sepolia/);
    const id = /Request ([a-f0-9-]{36})/.exec(paid.stdout)[1];
    const waiting = await run(home, 'status', id); outputs.push(waiting);
    assert.equal(waiting.code, 3, 'exit code 3: still waiting for the owner');
    const same = await run(home, 'pay', '--service', 'Weather API', '--to', DEST, '--amount', '1.25', '--max-fee', '0.05', '--key', key);
    assert.match(same.stdout, new RegExp(id), 'repeating with the same key is a replay, not a second payment');
    const changed = await run(home, 'pay', '--service', 'Weather API', '--to', DEST, '--amount', '1.30', '--max-fee', '0.05', '--key', key);
    assert.equal(changed.code, 1); assert.match(changed.stderr, /different details/);
    // Only the owner approves.
    const st = (await s.web('state', undefined, cookie)).json.customerWallet;
    assert.equal(st.balance.usdc, '30.625000');
    const p = st.pendingApprovals[0];
    await s.web('wallet/payments/decide', {id: p.id, decision: 'approve', bindingHash: p.fingerprint}, cookie);
    const done = await run(home, 'wait', id, '--interval', '1'); outputs.push(done);
    assert.equal(done.code, 0); assert.match(done.stdout, /succeeded/); assert.match(done.stdout, /SIMULATION, not a blockchain transaction/);
    for (const o of outputs) assert.ok(!(o.stdout + o.stderr).includes(cred.token), 'the credential is never printed');
    // Disconnecting in Eupova ends it; forget removes the local copy.
    await s.web('wallet/tools/revoke', {toolId}, cookie);
    const gone = await run(home, 'allowance'); assert.equal(gone.code, 1); assert.match(gone.stderr, /401/);
    assert.equal((await run(home, 'forget')).code, 0);
    assert.match((await run(home, 'allowance')).stderr, /Not connected/);
  } finally { await rm(home, {recursive: true, force: true}); await s.close().catch(() => {}); }
});

test('a dropped connection on pay is reported as uncertain, shows the idempotency key, and is never retried automatically', async () => {
  const home = await mkdtemp(join(tmpdir(), 'eupova-cli-'));
  try {
    const {mkdir, writeFile} = await import('node:fs/promises');
    await mkdir(home, {recursive: true});
    await writeFile(join(home, 'credentials.json'), JSON.stringify({base: 'http://127.0.0.1:9', toolId: randomUUID(), token: 'eut_' + 'A'.repeat(43)}), {mode: 0o600});
    const r = await run(home, 'pay', '--service', 'Svc', '--to', DEST, '--amount', '1', '--key', 'fixed-key-12345');
    assert.equal(r.code, 2); assert.match(r.stderr, /uncertain/); assert.match(r.stderr, /Do NOT send a new payment/); assert.match(r.stderr, /--key fixed-key-12345/);
    assert.ok(!r.stderr.includes('eut_AAAA'));
  } finally { await rm(home, {recursive: true, force: true}); }
});
