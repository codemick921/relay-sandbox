#!/usr/bin/env node
// Eupova connected-tool test client. A REQUEST-ONLY client: it can ask for a payment and read its status.
// It cannot approve anything: the wallet owner approves every payment in Eupova, and chooses the allowance.
//
//   node scripts/eupova-tool-cli.mjs enrol --url http://127.0.0.1:4322 --name "My CLI"
//   node scripts/eupova-tool-cli.mjs enrol-wait
//   node scripts/eupova-tool-cli.mjs allowance
//   node scripts/eupova-tool-cli.mjs pay --service "Weather API" --to 0x... --amount 1.25 --max-fee 0.05
//   node scripts/eupova-tool-cli.mjs x402 --url https://app.eupova.com/x402-test/premium
//   node scripts/eupova-tool-cli.mjs wait <payment-id>
//   node scripts/eupova-tool-cli.mjs forget            (delete the local credential; the owner revokes in Eupova)
//
// Test network only (Base Sepolia, USDC). The credential is stored in a private file and never printed.
import {mkdir, readFile, writeFile, rm, chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const HOME = process.env.EUPOVA_TOOL_HOME || join(homedir(), '.config', 'eupova-tool');
const CRED = join(HOME, 'credentials.json'), PENDING = join(HOME, 'pending.json');
const [, , cmd, ...rest] = process.argv;
const opts = {}, args = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { opts[rest[i].slice(2)] = rest[i + 1]; i++; } else args.push(rest[i]); }

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const safeUrl = u => {
  let url; try { url = new URL(u); } catch { die('Give --url as a full URL.'); }
  const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loop)) die('Use https, or http only for a local test server.');
  return url.origin;
};
async function save(file, data) { await mkdir(HOME, {recursive: true, mode: 0o700}); await writeFile(file, JSON.stringify(data), {mode: 0o600}); await chmod(file, 0o600); }
const load = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
async function call(base, method, path, {body, token, headers} = {}) {
  const res = await fetch(base + '/api/wallet-tool/v1/' + path, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
  const json = await res.json().catch(() => ({}));
  return {status: res.status, json};
}
const need = async () => { const c = await load(CRED); if (!c) die('Not connected. Run: enrol, then enrol-wait.'); return c; };
const show = p => console.log([`Request ${p.id}`, `  status:      ${p.status}${p.statusLabel ? ' (' + p.statusLabel + ')' : ''}`, p.reason ? `  reason:      ${p.reason}` : null,
  `  service:     ${p.service}`, `  destination: ${p.destination}`, `  amount:      ${p.amountUsdc} USDC on ${p.network}`, `  max fee:     ${p.maxFeeUsdc} USDC (total cap ${p.capUsdc})`,
  p.receipt ? `  receipt:     ${p.receipt.ref ?? 'recorded'} (${p.receipt.simulated ? 'SIMULATION, not a blockchain transaction' : 'provider reported'})` : null].filter(Boolean).join('\n'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (cmd === 'enrol') {
  const base = safeUrl(opts.url ?? die('Missing --url'));
  const r = await call(base, 'POST', 'enrol', {body: {name: opts.name ?? 'Eupova CLI'}});
  if (r.status !== 200) die(`Could not start (${r.status}): ${r.json.error ?? 'error'}`);
  await save(PENDING, {base, enrolmentId: r.json.enrolmentId, deviceSecret: r.json.deviceSecret});
  console.log(`Ask the wallet owner to open Eupova, My wallet, Connected tools, and enter this code:\n\n    ${r.json.userCode}\n\nIt expires in ${Math.round(r.json.expiresInSeconds / 60)} minutes. Then run: enrol-wait`);
} else if (cmd === 'enrol-wait') {
  const p = await load(PENDING) ?? die('Run enrol first.');
  const deadline = Date.now() + Number(opts.timeout ?? 600) * 1000;
  while (Date.now() < deadline) {
    const r = await call(p.base, 'POST', 'enrol/poll', {body: {enrolmentId: p.enrolmentId, deviceSecret: p.deviceSecret}});
    if (r.json.status === 'approved') { await save(CRED, {base: p.base, toolId: r.json.toolId, token: r.json.token}); await rm(PENDING, {force: true}); console.log('Connected. The credential is saved privately. It has no allowance until the owner sets one.'); process.exit(0); }
    if (['expired', 'collected'].includes(r.json.status) || r.status >= 400) { await rm(PENDING, {force: true}); die(`Not connected: ${r.json.status ?? r.json.error}. Run enrol again.`); }
    await sleep(Number(opts.interval ?? 2) * 1000);
  }
  die('Timed out waiting for approval. Run enrol again.');
} else if (cmd === 'allowance') {
  const c = await need(); const r = await call(c.base, 'GET', 'allowance', {token: c.token});
  if (r.status !== 200) die(`Refused (${r.status}): ${r.json.error ?? 'error'}`);
  const a = r.json.allowance;
  console.log(a ? `Allowance: ${a.remainingUsdc} of ${a.amountUsdc} USDC left until ${a.expiresAt}${a.active ? '' : ' (not active)'}\nEvery payment still needs the owner\'s approval.` : 'No allowance. Every request will be refused until the owner sets one.');
} else if (cmd === 'pay') {
  const c = await need(); const key = opts.key ?? randomUUID();
  const body = {service: opts.service, destination: opts.to, amount: opts.amount, ...(opts['max-fee'] !== undefined ? {maxFee: opts['max-fee']} : {})};
  let r;
  try { r = await call(c.base, 'POST', 'payments', {token: c.token, body, headers: {'idempotency-key': key}}); } catch {
    die(`The result is uncertain (no response). Do NOT send a new payment. Check with the same key by repeating this command with --key ${key} and identical details.`, 2);
  }
  if (r.status >= 400) die(`Refused (${r.status}): ${r.json.error ?? 'error'}`);
  show(r.json);
  console.log(r.json.status === 'awaiting_approval' ? `\nWaiting for the owner to approve in Eupova. Check with: wait ${r.json.id}\nIdempotency key: ${key}` : '');
} else if (cmd === 'x402') {
  // Pay for a URL: Eupova reads the 402, checks it, and asks the owner. The tool never sees a price before the
  // request is created, and never sees a signature at all.
  const c = await need(); const key = opts.key ?? randomUUID();
  if (!opts.url) die('Give the resource: x402 --url https://...');
  let r;
  try { r = await call(c.base, 'POST', 'x402', {token: c.token, body: {url: opts.url}, headers: {'idempotency-key': key}}); } catch {
    die(`The result is uncertain (no response). Do NOT repeat with a different key. Check with --key ${key}.`, 2);
  }
  if (r.status >= 400) die(`Refused (${r.status}): ${r.json.error ?? 'error'}${(r.json.problems ?? []).length ? '\n  ' + r.json.problems.join('\n  ') : ''}`);
  if (r.json.free) { console.log(`No payment needed (${r.json.status}). Content-Type: ${r.json.contentType || 'unknown'}`); console.log(r.json.body); }
  else { show(r.json); console.log(`\nWaiting for the owner to approve and sign in Eupova. Check with: wait ${r.json.id}\nIdempotency key: ${key}`); }
} else if (cmd === 'status' || cmd === 'wait') {
  const c = await need(); const id = args[0] ?? die('Give the request id.');
  const deadline = Date.now() + Number(opts.timeout ?? (cmd === 'wait' ? 900 : 0)) * 1000;
  for (;;) {
    const r = await call(c.base, 'GET', 'payments/' + id, {token: c.token});
    if (r.status !== 200) die(`Refused (${r.status}): ${r.json.error ?? 'error'}`);
    if (cmd === 'status' || !['awaiting_approval', 'executing'].includes(r.json.status) || Date.now() >= deadline) { show(r.json); process.exit(r.json.status === 'succeeded' ? 0 : r.json.status === 'awaiting_approval' || r.json.status === 'executing' ? 3 : 4); }
    await sleep(Number(opts.interval ?? 2) * 1000);
  }
} else if (cmd === 'forget') {
  await rm(CRED, {force: true}); await rm(PENDING, {force: true}); console.log('Local credential deleted. To stop it working everywhere, disconnect the tool in Eupova.');
} else {
  console.log('Commands: enrol --url URL --name NAME | enrol-wait | allowance | pay --service S --to ADDR --amount N [--max-fee N] [--key K] | x402 --url URL [--key K] | status ID | wait ID | forget');
  process.exit(cmd ? 1 : 0);
}
