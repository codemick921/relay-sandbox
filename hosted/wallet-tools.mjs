// Connected tools (for example a command-line client) that may REQUEST payments from a customer's wallet.
//
// Both controls are required, always:
//   1. an allowance the customer chose (amount and expiry, default none), and
//   2. the customer's individual approval of every payment.
// A tool credential can only create and read its own payment requests and read its own allowance. It cannot
// approve, edit an allowance, revoke itself back in, or read the browser session. Enrolment is a device flow:
// the tool shows a short code, the signed-in customer approves it, and the tool collects its credential once.
import {rejectReasons} from '../shared/wallet-model.mjs';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {InputError} from '../server/validation.mjs';
import {WALLET_LIMITS, parseUsdc, units} from '../shared/wallet-model.mjs';
import {fetchPaidResource} from './x402-fetch.mjs';
import {prepareApproval} from './x402-approval.mjs';
import {formatUsdc6} from './x402-challenge.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { const b = randomBytes(8); const c = [...b].map(x => CODE_ALPHABET[x % 32]).join(''); return c.slice(0, 4) + '-' + c.slice(4); };
const normCode = t => (typeof t === 'string' ? t.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const idemOk = k => typeof k === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(k);
const REQUEST_KEYS = new Set(['service', 'destination', 'amount', 'maxFee', 'network', 'token']);
export const ALLOWANCE_CONFIRMATION = 'I allow this tool to ask for payments up to this amount until this time. I will still approve every payment myself.';

// Canonical lock order, everywhere: owner lock, then the wallet's advisory lock, then rows. The advisory lock is taken BEFORE any wallet row lock.
async function lockedReadyWith(readyWallet, lockWallet, c, owner) {
  const w0 = await readyWallet(c, owner, false);
  await lockWallet(c, w0.id);
  return readyWallet(c, owner, true);
}
export function createWalletTools({tx, query, rate, simulated, clock, note, lockWallet, lockOwner, balanceOf, reservedTotal, readyWallet, big, uuid, payments, net, fetchImpl = fetch, resolver = null}) {
  const lockedReady = (c, owner) => lockedReadyWith(readyWallet, lockWallet, c, owner);
  const allowanceView = (a, now) => a && ({
    id: a.id, status: a.status, revision: a.revision, amountUsdc: units(a.amt), spentUsdc: units(a.spent), reservedUsdc: units(a.res),
    remainingUsdc: units(big(a.amt) - big(a.spent) - big(a.res)), expiresAt: a.expires_at, confirmedAt: a.confirmed_at,
    active: a.status === 'active' && new Date(a.expires_at) > now,
  });
  const ALLOW_SQL = "SELECT *, amount_raw::text AS amt, spent_raw::text AS spent, reserved_raw::text AS res FROM relay_cw_allowances";

  return {
    async migrate(c) {
      await c.query(`CREATE TABLE IF NOT EXISTS relay_cw_tools(
        id uuid PRIMARY KEY, owner text NOT NULL, wallet_id uuid NOT NULL REFERENCES relay_cw_wallets(id), name text NOT NULL,
        status text NOT NULL CHECK(status IN ('active','revoked')), token_hash text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
        collected_at timestamptz, last_seen_at timestamptz, revoked_at timestamptz)`);
      await c.query(`CREATE TABLE IF NOT EXISTS relay_cw_enrolments(
        id uuid PRIMARY KEY, name text NOT NULL, user_code text NOT NULL, device_hash text NOT NULL,
        status text NOT NULL CHECK(status IN ('pending','approved','collected','expired')), owner text, tool_id uuid REFERENCES relay_cw_tools(id),
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL)`);
      await c.query("CREATE UNIQUE INDEX IF NOT EXISTS relay_cw_enrol_code ON relay_cw_enrolments(user_code) WHERE status='pending'");
      await c.query(`CREATE TABLE IF NOT EXISTS relay_cw_allowances(
        id uuid PRIMARY KEY, owner text NOT NULL, wallet_id uuid NOT NULL REFERENCES relay_cw_wallets(id), tool_id uuid NOT NULL REFERENCES relay_cw_tools(id),
        amount_raw numeric(38,0) NOT NULL CHECK(amount_raw>0), spent_raw numeric(38,0) NOT NULL DEFAULT 0 CHECK(spent_raw>=0),
        reserved_raw numeric(38,0) NOT NULL DEFAULT 0 CHECK(reserved_raw>=0), revision integer NOT NULL DEFAULT 1,
        expires_at timestamptz NOT NULL, status text NOT NULL CHECK(status IN ('active','revoked')), confirmed_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK(spent_raw+reserved_raw<=amount_raw))`);
      await c.query("CREATE UNIQUE INDEX IF NOT EXISTS relay_cw_allow_active ON relay_cw_allowances(tool_id) WHERE status='active'");
    },

    // ---- tool side (bearer credential, request-only) -------------------------------------------------------
    async enrolStart({name, ip}) {
      const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
      if (n.length < 2 || n.length > 40 || /[<>\u0000-\u001f]/.test(n)) throw new InputError('Give the tool a name of 2 to 40 characters.');
      await rate('toolenrol:' + (ip || 'unknown'), 10, 60);
      const id = randomUUID(), deviceSecret = 'eds_' + randomBytes(24).toString('base64url'), userCode = newCode();
      await tx(async c => {
        await c.query("UPDATE relay_cw_enrolments SET status='expired' WHERE status='pending' AND expires_at<=now()");
        await c.query("INSERT INTO relay_cw_enrolments(id,name,user_code,device_hash,status,expires_at) VALUES($1,$2,$3,$4,'pending', now() + ($5 || ' minutes')::interval)", [id, n, normCode(userCode), sha(deviceSecret), String(WALLET_LIMITS.enrolWindowMinutes)]);
      });
      return {enrolmentId: id, deviceSecret, userCode, expiresInSeconds: WALLET_LIMITS.enrolWindowMinutes * 60, next: 'Ask the wallet owner to enter this code in Eupova under My wallet, Connected tools.'};
    },
    async enrolPoll({enrolmentId, deviceSecret, ip}) {
      if (!uuid(enrolmentId) || typeof deviceSecret !== 'string') throw new InputError('Not found.', 404);
      await rate('toolpoll:' + (ip || 'unknown'), 60, 60);
      return tx(async c => {
        const e = (await c.query('SELECT * FROM relay_cw_enrolments WHERE id=$1 FOR UPDATE', [enrolmentId])).rows[0];
        if (!e || !safeEq(e.device_hash, sha(deviceSecret))) throw new InputError('Not found.', 404);
        if (e.status === 'pending' && new Date(e.expires_at) <= clock()) { await c.query("UPDATE relay_cw_enrolments SET status='expired' WHERE id=$1", [e.id]); return {status: 'expired'}; }
        if (e.status !== 'approved') return {status: e.status};
        if (!(await this.customerOk(e.owner, (a, b) => c.query(a, b)))) throw new InputError('This account cannot connect tools right now.', 403);
        const token = 'eut_' + randomBytes(32).toString('base64url');
        await c.query("UPDATE relay_cw_tools SET token_hash=$2, collected_at=now() WHERE id=$1 AND token_hash IS NULL", [e.tool_id, sha(token)]);
        await c.query("UPDATE relay_cw_enrolments SET status='collected' WHERE id=$1", [e.id]);
        return {status: 'approved', toolId: e.tool_id, token, note: 'Shown once. Store it privately; Eupova keeps only a hash.'};
      });
    },
    // A live tool belongs to a customer who is still allowed to use the wallet: not disabled, setup finished, email verified. The same boundary as the
    // browser session. The simulation (tester codes) is scoped separately and is never reachable on a live deployment.
    async customerOk(owner, q = query) {
      if (simulated) return true;
      if (typeof owner !== 'string' || !owner.startsWith('customer:')) return false;
      return (await q('SELECT 1 FROM relay_customers WHERE id=$1 AND NOT disabled AND NOT setup_pending AND email_verified_at IS NOT NULL', [owner.slice(9)])).rows.length > 0;
    },
    async authenticate(token) {
      if (typeof token !== 'string' || !/^eut_[A-Za-z0-9_-]{43}$/.test(token)) throw new InputError('Unauthorised.', 401);
      const t = (await query("SELECT id,owner,wallet_id,name FROM relay_cw_tools WHERE token_hash=$1 AND status='active'", [sha(token)])).rows[0];
      if (!t || !(await this.customerOk(t.owner))) throw new InputError('Unauthorised.', 401);
      query('UPDATE relay_cw_tools SET last_seen_at=now() WHERE id=$1', [t.id]).catch(() => {});
      return t;
    },
    // One allowance rule for every request a tool can make, whether it is asked to send USDC or to pay for a call.
    // Two copies of spent + reserved <= amount is how accounting drifts apart, so there is exactly one.
    async assess(c, tool, w, n, feeProblem) {
      const a = (await c.query(ALLOW_SQL + " WHERE tool_id=$1 AND status='active'", [tool.id])).rows[0] ?? null;
      let reason = null;
      if (!a) reason = 'no_allowance';
      else if (new Date(a.expires_at) <= clock()) reason = 'allowance_expired';
      else if (big(a.spent) + big(a.res) + n.capRaw > big(a.amt)) reason = 'over_allowance';
      else if (feeProblem) reason = feeProblem;
      else if ((await balanceOf(c, w)) - (await reservedTotal(c, w.id)) < n.capRaw) reason = 'insufficient_balance';
      return {a, reason};
    },

    async requestPayment(tool, idemKey, input) {
      if (!idemOk(idemKey)) throw new InputError('Send an Idempotency-Key header of 8 to 64 letters, digits or . _ : -', 400);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !REQUEST_KEYS.has(k))) throw new InputError('Unknown or missing fields in the request.');
      if (!(await this.customerOk(tool.owner))) throw new InputError('Unauthorised.', 401);
      await rate('toolpay:' + tool.id, 30, 60);
      // Read-only preparation first (tool still active, wallet ready, input valid, network fee worked out). Nothing is saved yet.
      const stillActive = (await query("SELECT status FROM relay_cw_tools WHERE id=$1", [tool.id])).rows[0];
      if (!stillActive || stillActive.status !== 'active') throw new InputError('Unauthorised.', 401);
      const w0 = (await query('SELECT * FROM relay_cw_wallets WHERE id=$1', [tool.wallet_id])).rows[0];
      if (!w0 || w0.status !== 'ready') throw new InputError('The wallet is not ready.', 409);
      let n0; try { n0 = payments.normalise(input, w0); } catch (e) { throw new InputError(e.message); }
      const dup = (await query("SELECT id,details_hash FROM relay_cw_payments WHERE owner=$1 AND origin='tool' AND tool_id=$2 AND request_id=$3", [tool.owner, tool.id, idemKey])).rows[0];
      let fee = null, feeProblem = null;
      if (!dup) { try { fee = await payments.estimate(tool.owner, w0, n0); } catch (e) { if (!(e instanceof InputError)) throw e; feeProblem = e.message === rejectReasons.insufficient_gas ? 'insufficient_gas' : 'fee_unavailable'; if (feeProblem === 'fee_unavailable') throw e; } }
      return tx(async c => {
        await lockWallet(c, w0.id);
        const w = (await c.query('SELECT * FROM relay_cw_wallets WHERE id=$1 FOR UPDATE', [tool.wallet_id])).rows[0];
        if (!w || w.status !== 'ready') throw new InputError('The wallet is not ready.', 409);
        const live = (await c.query("SELECT status FROM relay_cw_tools WHERE id=$1", [tool.id])).rows[0];
        if (!live || live.status !== 'active') throw new InputError('Unauthorised.', 401);
        const n = n0;
        const old = (await c.query("SELECT id,details_hash FROM relay_cw_payments WHERE owner=$1 AND origin='tool' AND tool_id=$2 AND request_id=$3", [tool.owner, tool.id, idemKey])).rows[0];
        if (old) { if (old.details_hash !== payments.detailsHash(n)) throw new InputError('This Idempotency-Key was already used for different details.', 409); return {id: old.id, replay: true}; }
        const open = Number((await c.query("SELECT count(*) FROM relay_cw_payments WHERE tool_id=$1 AND status='awaiting_approval'", [tool.id])).rows[0].count);
        if (open >= WALLET_LIMITS.maxOpenRequestsPerTool) throw new InputError('Too many requests are waiting for approval.', 429);
        const {a, reason} = await this.assess(c, tool, w, n, feeProblem);
        const id = await payments.insertForTool(c, tool.owner, w, n, {origin: 'tool', requestId: idemKey, status: reason ? 'rejected' : 'awaiting_approval', reason, tool, allowance: a, fee: reason ? null : fee});
        return {id};
      });
    },
    // Ask Eupova to pay for a URL on this tool's behalf. The tool never sees a price, a signature or a key: Eupova
    // reads the 402, checks it, saves a request, and the customer decides. Off unless the deployment switches it on.
    async requestX402(tool, idemKey, input) {
      if (!idemOk(idemKey)) throw new InputError('Send an Idempotency-Key header of 8 to 64 letters, digits or . _ : -', 400);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['url', 'method', 'body'].includes(k))) throw new InputError('Unknown or missing fields in the request.');
      if (!(await this.customerOk(tool.owner))) throw new InputError('Unauthorised.', 401);
      if (simulated) throw new InputError('Paying for services is not part of the simulated wallet.', 404);
      await rate('toolx402:' + tool.id, 20, 60);
      const w = (await query('SELECT * FROM relay_cw_wallets WHERE id=$1', [tool.wallet_id])).rows[0];
      if (!w || w.status !== 'ready') throw new InputError('The wallet is not ready.', 409);
      // The allowance bounds what may be asked for, so the fetch cannot be used to discover prices above it.
      const allowance = (await query(ALLOW_SQL + " WHERE tool_id=$1 AND status='active'", [tool.id])).rows[0] ?? null;
      if (!allowance) throw new InputError('This tool has no allowance. Ask the wallet owner for one first.', 403);
      const remaining = big(allowance.amt) - big(allowance.spent) - big(allowance.res);
      const paid = await fetchPaidResource({url: input.url, method: input.method, body: input.body, maxAmountRaw: remaining > 0n ? remaining : 0n, headers: {'X-Eupova-Payer': w.address}, fetchImpl, ...(resolver ? {resolver} : {})});
      if (!paid.ok) throw new InputError(paid.reason, paid.status === 402 ? 409 : 422);
      if (paid.free) return {free: true, status: paid.status, body: paid.body, contentType: paid.contentType};
      const req = paid.requirement;
      let n0; try { n0 = payments.normalise({destination: req.payTo, amount: formatUsdc6(req.amountRaw), service: paid.host}, w); } catch (e) { throw new InputError(e.message); }
      const prepared = prepareApproval({requirement: req, walletAddress: w.address, nowSeconds: Math.floor(clock().getTime() / 1000), chainId: net.chainId});
      return tx(async c => {
        await lockWallet(c, w.id);
        const live = (await c.query('SELECT * FROM relay_cw_wallets WHERE id=$1 FOR UPDATE', [w.id])).rows[0];
        if (!live || live.status !== 'ready') throw new InputError('The wallet is not ready.', 409);
        const active = (await c.query('SELECT status FROM relay_cw_tools WHERE id=$1', [tool.id])).rows[0];
        if (!active || active.status !== 'active') throw new InputError('Unauthorised.', 401);
        const old = (await c.query("SELECT id,x402 FROM relay_cw_payments WHERE owner=$1 AND origin='tool' AND tool_id=$2 AND request_id=$3", [tool.owner, tool.id, idemKey])).rows[0];
        if (old) {
          if (old.x402?.requirementRef !== prepared.requirementRef) throw new InputError('This Idempotency-Key was already used for a different call.', 409);
          return {id: old.id, replay: true};
        }
        const same = (await c.query("SELECT id FROM relay_cw_payments WHERE wallet_id=$1 AND kind='x402' AND x402->>'requirementRef'=$2 AND status IN ('awaiting_approval','approved','executing')", [w.id, prepared.requirementRef])).rows[0];
        if (same) throw new InputError('There is already a pending request for this exact call.', 409);
        const {a, reason} = await this.assess(c, tool, live, n0, null);
        const id = await payments.insertForTool(c, tool.owner, live, n0, {
          origin: 'tool', requestId: idemKey, status: reason ? 'rejected' : 'awaiting_approval', reason, tool, allowance: a,
          // No Eupova-side fee exists here: in the x402 exact scheme the service's facilitator pays the network fee, and
          // the customer authorises only the amount. Recording it as sponsored with a zero cap says exactly that.
          fee: {asset: 'sponsored', maxFeeNativeWei: '0'},
          kind: 'x402', x402: {...prepared, step: 'prepared', host: paid.host},
        });
        return {id};
      });
    },

    async getPayment(tool, id) {
      if (!uuid(id)) throw new InputError('Not found.', 404);
      if (!(await this.customerOk(tool.owner))) throw new InputError('Unauthorised.', 401);
      let p = await payments.get(tool.owner, id).catch(() => null);
      if (!p || p.tool?.id !== tool.id) throw new InputError('Not found.', 404);
      // A status read also catches up with the network (bounded and throttled), so a tool sees COMPLETE without the customer pressing anything.
      if (['executing', 'outcome_unknown'].includes(p.status) && (await payments.reconcileOpen(tool.owner).catch(() => 0)) >= 0) p = await payments.get(tool.owner, id);
      // The tool sees status and its own receipt, never the approval fingerprint's binding internals beyond what it sent.
      return {id: p.id, status: p.status, statusLabel: p.statusLabel, reason: p.reason, reasonCode: p.reasonCode, service: p.service, destination: p.destination, network: p.network, token: p.token,
        amountUsdc: p.amountUsdc, maxFeeUsdc: p.maxFeeUsdc, capUsdc: p.capUsdc, fee: p.fee, environment: p.environment, expiresAt: p.expiresAt, receipt: p.receipt, simulated: p.simulated};
    },
    async allowanceFor(tool) {
      const a = (await query(ALLOW_SQL + " WHERE tool_id=$1 AND status='active'", [tool.id])).rows[0] ?? null;
      return {tool: tool.name, allowance: allowanceView(a, clock()) ?? null, note: 'Every payment still needs the wallet owner\'s approval.'};
    },

    // ---- customer side (signed-in browser session) ----------------------------------------------------------
    async approveEnrolment(owner, input) {
      await rate('toolcode:' + owner, 10, 60);
      const code = normCode(input?.userCode);
      if (code.length !== 8) throw new InputError('Enter the 8-character code shown by the tool.');
      return tx(async c => {
        await lockOwner(c, owner);
        const w = await lockedReady(c, owner);
        const e = (await c.query("SELECT * FROM relay_cw_enrolments WHERE user_code=$1 AND status='pending' FOR UPDATE", [code])).rows[0];
        if (!e || new Date(e.expires_at) <= clock()) throw new InputError('That code was not found or has expired. Ask the tool for a new one.', 404);
        const count = Number((await c.query("SELECT count(*) FROM relay_cw_tools WHERE owner=$1 AND status='active'", [owner])).rows[0].count);
        if (count >= WALLET_LIMITS.maxTools) throw new InputError('Disconnect a tool before connecting another.', 409);
        const toolId = randomUUID();
        await c.query("INSERT INTO relay_cw_tools(id,owner,wallet_id,name,status) VALUES($1,$2,$3,$4,'active')", [toolId, owner, w.id, e.name]);
        await c.query("UPDATE relay_cw_enrolments SET status='approved',owner=$2,tool_id=$3 WHERE id=$1", [e.id, owner, toolId]);
        await note(c, owner, w.id, null, 'tool_connected', `"${e.name}" was connected. It has no allowance yet, so it cannot be paid anything.`);
        return {id: toolId};
      });
    },
    async list(owner, walletId) {
      const tools = (await query("SELECT id,name,status,created_at,collected_at,last_seen_at,revoked_at FROM relay_cw_tools WHERE owner=$1 AND wallet_id=$2 ORDER BY created_at DESC", [owner, walletId])).rows;
      const now = clock();
      const out = [];
      for (const t of tools) {
        const a = (await query(ALLOW_SQL + " WHERE tool_id=$1 ORDER BY (status='active') DESC, created_at DESC LIMIT 1", [t.id])).rows[0];
        out.push({id: t.id, name: t.name, status: t.status, connectedAt: t.created_at, credentialCollected: !!t.collected_at, lastSeenAt: t.last_seen_at, revokedAt: t.revoked_at, allowance: allowanceView(a, now) ?? null});
      }
      return out;
    },
    async setAllowance(owner, input) {
      if (!uuid(input?.toolId)) throw new InputError('Choose a tool.');
      if (input.confirm !== true || input.confirmation !== ALLOWANCE_CONFIRMATION) throw new InputError('Confirm the allowance to continue.');
      let amount; try { amount = parseUsdc(input.amount, {max: WALLET_LIMITS.maxAllowanceRaw}); } catch (e) { throw new InputError(e.message); }
      const hours = input.hours;
      if (!Number.isInteger(hours) || hours < WALLET_LIMITS.minAllowanceHours || hours > WALLET_LIMITS.maxAllowanceHours) throw new InputError(`Choose a time between ${WALLET_LIMITS.minAllowanceHours} hour and ${WALLET_LIMITS.maxAllowanceHours / 24} days.`);
      return tx(async c => {
        await lockOwner(c, owner);
        const w = await lockedReady(c, owner);
        const t = (await c.query("SELECT * FROM relay_cw_tools WHERE id=$1 AND owner=$2 AND status='active' FOR UPDATE", [input.toolId, owner])).rows[0];
        if (!t) throw new InputError('Not found.', 404);
        const a = (await c.query(ALLOW_SQL + " WHERE tool_id=$1 AND status='active' FOR UPDATE", [t.id])).rows[0];
        const expires = new Date(clock().getTime() + hours * 3600_000);
        if (!a) {
          const id = randomUUID();
          await c.query("INSERT INTO relay_cw_allowances(id,owner,wallet_id,tool_id,amount_raw,expires_at,status,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,'active',now())", [id, owner, w.id, t.id, amount.toString(), expires]);
          await note(c, owner, w.id, null, 'allowance_set', `"${t.name}" may ask for up to ${units(amount)} USDC until ${expires.toISOString()}. You still approve each payment.`);
          return {id: t.id};
        }
        if (input.expectedRevision !== a.revision) throw new InputError('The allowance changed. Review it and try again.', 409);
        if (amount < big(a.spent) + big(a.res)) throw new InputError('The allowance cannot be lower than what has already been used or is being sent.', 409);
        await c.query('UPDATE relay_cw_allowances SET amount_raw=$2,expires_at=$3,revision=revision+1,confirmed_at=now(),updated_at=now() WHERE id=$1', [a.id, amount.toString(), expires]);
        const n = await payments.invalidateOpen(c, owner, {column: 'allowance_id', value: a.id, reason: 'allowance_changed'}, 'the allowance was edited, so the earlier approval screen no longer counts. Ask the tool again.');
        await note(c, owner, w.id, null, 'allowance_changed', `"${t.name}" allowance is now up to ${units(amount)} USDC until ${expires.toISOString()}. ${n} waiting request(s) were cancelled.`);
        return {id: t.id};
      });
    },
    async revokeAllowance(owner, input) {
      if (!uuid(input?.toolId)) throw new InputError('Choose a tool.');
      return tx(async c => {
        const w = await lockedReady(c, owner);
        const a = (await c.query(ALLOW_SQL + " WHERE tool_id=$1 AND owner=$2 AND status='active' FOR UPDATE", [input.toolId, owner])).rows[0];
        if (!a) throw new InputError('This tool has no active allowance.', 404);
        await c.query("UPDATE relay_cw_allowances SET status='revoked',updated_at=now() WHERE id=$1", [a.id]);
        const n = await payments.invalidateOpen(c, owner, {column: 'allowance_id', value: a.id, reason: 'no_allowance'}, 'the allowance was ended, so this request was cancelled.');
        await note(c, owner, w.id, null, 'allowance_revoked', `Allowance ended. ${n} waiting request(s) were cancelled. Anything already sending is not affected.`);
        return {id: input.toolId};
      });
    },
    async revokeTool(owner, input) {
      if (!uuid(input?.toolId)) throw new InputError('Choose a tool.');
      return tx(async c => {
        const w = await lockedReady(c, owner);
        const t = (await c.query("SELECT * FROM relay_cw_tools WHERE id=$1 AND owner=$2 FOR UPDATE", [input.toolId, owner])).rows[0];
        if (!t) throw new InputError('Not found.', 404);
        if (t.status === 'revoked') return {id: t.id};
        await c.query("UPDATE relay_cw_tools SET status='revoked',revoked_at=now() WHERE id=$1", [t.id]);
        await c.query("UPDATE relay_cw_allowances SET status='revoked',updated_at=now() WHERE tool_id=$1 AND status='active'", [t.id]);
        const n = await payments.invalidateOpen(c, owner, {column: 'tool_id', value: t.id, reason: 'tool_revoked'}, 'the tool was disconnected, so this request was cancelled.');
        await note(c, owner, w.id, null, 'tool_revoked', `"${t.name}" was disconnected. Its credential no longer works. ${n} waiting request(s) were cancelled.`);
        return {id: t.id};
      });
    },
  };
}
