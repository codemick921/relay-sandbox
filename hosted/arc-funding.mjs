// Arc funding: persistent TEST-DATA simulation of a CUSTOMER-CONTROLLED Base-to-Arc transfer.
//
// "The customer approves transfers in their wallet." The source signer is the customer's own wallet
// on Base; the destination is just an address on Arc (the customer's own, or a saved external test
// destination). Nothing is burned until the customer approves, and the approval is bound to the
// source account and chain, destination, amount and quote (see arc-approvals.mjs). No network call,
// key, signature or real wallet exists here; providers are injected and only the simulated set is
// accepted. State lives in PostgreSQL and survives restarts.
import {randomUUID} from 'node:crypto';
import {InputError, pence} from '../server/validation.mjs';
import {
  ARC_CUSTODY, ARC_LIMITS, ARC_ROUTE, NETWORK_CONFIRMATION, arcAddressCheck, arcQuote, speeds, transferStatusLabels, transferTerminal,
  transferScenarios, units, walletScenarios, walletStatusLabels, destinationLabel, POST_BURN_STATUSES,
} from '../shared/arc-funding.mjs';
import {createSimulatedProviders} from './arc-providers.mjs';
import {bindingStatus, createArcApprovals, externalTestDestination, hashBinding, liveBinding, sameAsSourceDestination, snapshotBinding} from './arc-approvals.mjs';
import {createArcDestinations} from './arc-destinations.mjs';

const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
// Integer-only formatting: pence are whole numbers, so no floating point is involved.
const poundsFromPence = n => `£${Math.trunc(n / 100)}.${String(n % 100).padStart(2, '0')}`;
const STATUSES = "'awaiting_payment','payment_failed','payment_recorded','base_received','approval_pending','approval_denied','approval_invalidated','bridge_burn_pending','bridge_attestation_pending','bridge_mint_pending','settled','burn_failed','burned_resume_required','held_on_base','cancelled'";
const PRE_BURN = new Set(['awaiting_payment', 'payment_recorded', 'base_received', 'approval_pending', 'approval_denied', 'approval_invalidated', 'bridge_burn_pending', 'burn_failed']);
const SCENARIOS = "'success','slow','burn_failed','attestation_failed','payment_failed'";
const POST_BURN_SQL = POST_BURN_STATUSES.map(x => `'${x}'`).join(',');

export function createArcFunding({store, providers = createSimulatedProviders()}) {
  if (providers?.mode !== 'simulated' || providers.wallet?.mode !== 'simulated' || providers.bridge?.mode !== 'simulated') {
    throw new Error('Arc funding accepts simulated providers only in this build.');
  }
  const {tx, query} = store;

  async function note(c, owner, subject, id, status, text, detail = {}) {
    await c.query('INSERT INTO relay_arc_events(owner,subject,subject_id,status,note,detail) VALUES($1,$2,$3,$4,$5,$6)', [owner, subject, id, status, text, detail]);
  }
  const lockOwner = (c, owner) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['arc:' + owner]);
  const approvals = createArcApprovals({note});
  const destinations = createArcDestinations({note, approvals, tx, query, lockOwner});

  const walletView = r => ({
    id: r.id, label: r.label, provider: r.provider, simulated: true, custody: 'customer-controlled', network: ARC_ROUTE.source.chain + ' / ' + ARC_ROUTE.destination.chain,
    status: r.status, statusLabel: walletStatusLabels[r.status], address: r.address, attempt: r.attempt,
    failureCode: r.failure_code, createdAt: r.created_at, updatedAt: r.updated_at,
    canAdvance: r.status === 'provisioning', canRetry: r.status === 'failed',
  });

  const hints = {
    awaiting_payment: 'Record a simulated payment to continue. No money moves.',
    payment_recorded: 'Run the next simulated network step to verify the Base receipt.',
    base_received: 'USDC is in your wallet on Base. Next step: ask for your approval. Nothing is burned without it.',
    approval_pending: 'Nothing has been burned. Review exactly what you are approving below, then approve or decline in your wallet (simulated here).',
    approval_denied: 'You declined. Nothing was burned and the USDC is still in your wallet on Base. You can ask for approval again, or keep the USDC on Base.',
    approval_invalidated: 'The details you approved changed, so that approval no longer counts. Nothing was burned. Review the updated details and approve again, or keep the USDC on Base.',
    bridge_burn_pending: 'You approved. The simulated burn on Base is not confirmed yet, so the USDC is still in your wallet on Base until it is.',
    burn_failed: 'The burn did not happen: no burn record exists and the USDC is still in your wallet on Base. Try the burn again under your existing approval, or keep the USDC on Base.',
    bridge_attestation_pending: 'The burn on Base is confirmed (see the burn record) and cannot be undone. The USDC is no longer spendable on Base. Waiting for the simulated Circle attestation.',
    burned_resume_required: 'The burn on Base is confirmed and cannot be undone, so this USDC is not spendable on Base and cannot be kept there. The stall is after the burn. Resume to fetch the attestation and mint on Arc using the burn record. Do not start another transfer.',
    bridge_mint_pending: 'The burn is confirmed (see the burn record). The simulated mint on Arc is pending.',
    settled: 'Complete. The settled Arc amount below is final for this simulation.',
    held_on_base: 'You chose to keep the USDC on Base. No bridge fee was charged.',
    payment_failed: 'The simulated payment failed. No money moved. Start again with a new quote.',
    cancelled: 'Cancelled before any payment. No money moved.',
  };
  const fundsLocation = r => {
    if (r.status === 'settled') return 'Arc';
    if (['held_on_base', 'base_received', 'approval_pending', 'approval_denied', 'approval_invalidated', 'bridge_burn_pending'].includes(r.status)) return 'Base';
    if (r.status === 'burn_failed') return 'Base';
    if (['bridge_attestation_pending', 'bridge_mint_pending', 'burned_resume_required'].includes(r.status)) return 'In transit (already burned on Base)';
    return 'Not paid yet';
  };

  const transferView = (r, events, nowMs, ctx) => {
    const quote = r.quote, dest = quote.destination;
    const expired = r.status === 'awaiting_payment' && Date.parse(quote.expiresAt) <= nowMs;
    const open = ctx.approvals.filter(a => a.transfer_id === r.id);
    const latest = open.at(-1) ?? null;
    const live = r.destination_id ? ctx.destinations.get(r.destination_id) : null;
    // The saved destination no longer matches what this quote showed (edited or removed).
    const destinationChanged = PRE_BURN.has(r.status) && !!r.destination_id && (!live || live.revision !== dest.revision || live.address !== dest.address || live.label !== dest.label);
    const awaiting = r.status === 'approval_pending' && latest?.status === 'pending';
    return {
      id: r.id, walletId: r.wallet_id, walletLabel: quote.wallet.label, walletAddress: quote.wallet.address, simulated: true,
      fundsLocation: fundsLocation(r),
      route: {from: ARC_ROUTE.source.chain, to: ARC_ROUTE.destination.chain},
      destination: {...dest, displayLabel: destinationLabel(dest), testLabel: dest.mode === 'external_test'}, destinationChanged,
      quote, status: r.status, statusLabel: transferStatusLabels[r.status], hint: hints[r.status], terminal: transferTerminal.has(r.status),
      scenario: r.scenario, scenarioLabel: transferScenarios[r.scenario] ?? null, attempt: r.attempt, failureCode: r.failure_code,
      baseReceivedRaw: r.base_received_raw, baseReceivedUsdc: r.base_received_raw ? units(r.base_received_raw) : null,
      estimatedArcRaw: quote.estimatedArcRaw, estimatedArcUsdc: quote.estimatedArcUsdc,
      settled: r.settled, expired, createdAt: r.created_at, updatedAt: r.updated_at,
      approval: approvals.view(latest), approvals: open.map(a => approvals.view(a)),
      canSubmit: r.status === 'awaiting_payment' && !expired, canCancel: r.status === 'awaiting_payment',
      canAdvance: ['payment_recorded', 'base_received', 'bridge_burn_pending', 'bridge_attestation_pending', 'bridge_mint_pending'].includes(r.status),
      advanceLabel: r.status === 'base_received' ? 'Ask for my approval' : null,
      canApprove: awaiting && !destinationChanged, canDecline: awaiting,
      canRequestApproval: r.status === 'approval_denied', canReapprove: r.status === 'approval_invalidated',
      // Pre-burn failure: nothing burned, USDC spendable on Base, may keep it there. Post-burn failure: the burn
      // record exists, the burn cannot be undone, so the only way forward is attestation and mint.
      failureKind: r.status === 'burn_failed' ? 'pre_burn' : r.status === 'burned_resume_required' ? 'post_burn' : null,
      burn: r.burn_record ? {...r.burn_record, amountUsdc: units(r.burn_record.amountRaw), irreversible: true} : null,
      spendableOnBase: r.burn_record ? false : ['base_received', 'approval_pending', 'approval_denied', 'approval_invalidated', 'bridge_burn_pending', 'burn_failed', 'held_on_base'].includes(r.status),
      canRetry: r.status === 'burn_failed' || r.status === 'burned_resume_required',
      retryLabel: r.status === 'burned_resume_required' ? 'Resume attestation and mint (no new burn)' : r.status === 'burn_failed' ? 'Try the burn again (uses your approval)' : null,
      canHold: !r.burn_record && ['approval_pending', 'approval_denied', 'approval_invalidated', 'burn_failed'].includes(r.status),
      events: events.map(e => ({at: e.at, status: e.status, label: transferStatusLabels[e.status] ?? e.status, note: e.note})),
    };
  };

  async function ownedRow(c, table, owner, id) {
    if (!uuid(id)) throw new InputError('Not found.', 404);
    const row = (await c.query(`SELECT * FROM ${table} WHERE id=$1 AND owner=$2 FOR UPDATE`, [id, owner])).rows[0];
    if (!row) throw new InputError('Not found.', 404);
    return row;
  }

  return {
    simulated: true,
    route: ARC_ROUTE,
    custody: ARC_CUSTODY,
    async migrate() {
      await tx(async c => {
        await c.query('SELECT pg_advisory_xact_lock(431930)');
        await c.query(`CREATE TABLE IF NOT EXISTS relay_arc_wallets(
          id uuid PRIMARY KEY, owner text NOT NULL, request_id uuid NOT NULL, label text NOT NULL,
          provider text NOT NULL DEFAULT 'simulated' CHECK(provider='simulated'),
          simulated boolean NOT NULL DEFAULT true CHECK(simulated),
          network text NOT NULL DEFAULT 'arc_testnet' CHECK(network='arc_testnet'),
          status text NOT NULL CHECK(status IN ('provisioning','ready','failed')),
          scenario text NOT NULL CHECK(scenario IN ('success','slow','failure')),
          progress int NOT NULL DEFAULT 0, attempt int NOT NULL DEFAULT 1, address text, provider_ref text, failure_code text,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_id))`);
        // The wallet is the customer's own; Eupova has no signing authority over it.
        await c.query("ALTER TABLE relay_arc_wallets ADD COLUMN IF NOT EXISTS custody text NOT NULL DEFAULT 'customer' CHECK(custody='customer')");
        await c.query('CREATE INDEX IF NOT EXISTS relay_arc_wallets_owner ON relay_arc_wallets(owner,created_at)');
        await c.query(`CREATE TABLE IF NOT EXISTS relay_arc_quotes(
          id uuid PRIMARY KEY, owner text NOT NULL, wallet_id uuid NOT NULL REFERENCES relay_arc_wallets(id), quote jsonb NOT NULL,
          expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
        await destinations.migrate(c);
        await c.query(`CREATE TABLE IF NOT EXISTS relay_arc_transfers(
          id uuid PRIMARY KEY, owner text NOT NULL, request_id uuid NOT NULL, quote_id uuid NOT NULL UNIQUE REFERENCES relay_arc_quotes(id),
          wallet_id uuid NOT NULL REFERENCES relay_arc_wallets(id), quote jsonb NOT NULL, status text NOT NULL, scenario text,
          progress int NOT NULL DEFAULT 0, attempt int NOT NULL DEFAULT 1, failure_code text, base_received_raw text, settled jsonb,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_id))`);
        await c.query('ALTER TABLE relay_arc_transfers ADD COLUMN IF NOT EXISTS destination_id uuid REFERENCES relay_arc_destinations(id)');
        // The simulated burn record. Set once, when the burn is confirmed; never changed or removed afterwards.
        await c.query('ALTER TABLE relay_arc_transfers ADD COLUMN IF NOT EXISTS burn_record jsonb');
        for (const name of ['status_check', 'scenario_check', 'burn_record_matches_status']) await c.query(`ALTER TABLE relay_arc_transfers DROP CONSTRAINT IF EXISTS relay_arc_transfers_${name}`);
        // Older rows used one 'bridge_failed' status for both kinds of failure. Split by the failure code they stored.
        await c.query("UPDATE relay_arc_transfers SET status='burned_resume_required' WHERE status='bridge_failed' AND failure_code='attestation_timeout'");
        await c.query("UPDATE relay_arc_transfers SET status='burn_failed' WHERE status='bridge_failed'");
        await c.query("UPDATE relay_arc_transfers SET scenario='burn_failed' WHERE scenario='bridge_failed'");
        await c.query(`UPDATE relay_arc_transfers SET burn_record=jsonb_build_object('simulated',true,'legacy',true,'ref','sim-burn-legacy','amountRaw',COALESCE(base_received_raw,'0'),'sourceChain',quote->'wallet'->>'chain','confirmedAt',to_jsonb(updated_at))
          WHERE status IN (${POST_BURN_SQL}) AND burn_record IS NULL`);
        await c.query(`ALTER TABLE relay_arc_transfers ADD CONSTRAINT relay_arc_transfers_status_check CHECK(status IN (${STATUSES}))`);
        await c.query(`ALTER TABLE relay_arc_transfers ADD CONSTRAINT relay_arc_transfers_scenario_check CHECK(scenario IS NULL OR scenario IN (${SCENARIOS}))`);
        // Database-level guard: a burn record exists exactly when the transfer is past the burn. A burned transfer can
        // never be marked kept on Base or failed-before-burn, and a pre-burn status can never carry a burn record.
        await c.query(`ALTER TABLE relay_arc_transfers ADD CONSTRAINT relay_arc_transfers_burn_record_matches_status CHECK((status IN (${POST_BURN_SQL})) = (burn_record IS NOT NULL))`);
        await c.query(`CREATE OR REPLACE FUNCTION relay_arc_burn_record_immutable() RETURNS trigger AS $$
          BEGIN
            IF OLD.burn_record IS NOT NULL AND NEW.burn_record IS DISTINCT FROM OLD.burn_record THEN
              RAISE EXCEPTION 'A confirmed burn record cannot be changed or removed' USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql`);
        await c.query('DROP TRIGGER IF EXISTS relay_arc_burn_record_immutable ON relay_arc_transfers');
        await c.query('CREATE TRIGGER relay_arc_burn_record_immutable BEFORE UPDATE ON relay_arc_transfers FOR EACH ROW EXECUTE FUNCTION relay_arc_burn_record_immutable()');
        await c.query('CREATE INDEX IF NOT EXISTS relay_arc_transfers_owner ON relay_arc_transfers(owner,created_at)');
        await c.query(`CREATE TABLE IF NOT EXISTS relay_arc_events(
          seq bigserial PRIMARY KEY, owner text NOT NULL, subject text NOT NULL, subject_id uuid NOT NULL,
          status text NOT NULL, note text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb, at timestamptz NOT NULL DEFAULT now())`);
        await c.query('ALTER TABLE relay_arc_events DROP CONSTRAINT IF EXISTS relay_arc_events_subject_check');
        await c.query("ALTER TABLE relay_arc_events ADD CONSTRAINT relay_arc_events_subject_check CHECK(subject IN ('wallet','transfer','destination'))");
        await c.query('CREATE INDEX IF NOT EXISTS relay_arc_events_subject ON relay_arc_events(subject_id,seq)');
        await approvals.migrate(c);
      });
    },

    addressCheck: arcAddressCheck,
    saveDestination: (owner, input) => destinations.save(owner, input),
    removeDestination: (owner, input) => destinations.remove(owner, input),

    async state(owner) {
      const [w, t, e, d, a, dl] = await Promise.all([
        query('SELECT * FROM relay_arc_wallets WHERE owner=$1 ORDER BY created_at,id', [owner]),
        query('SELECT * FROM relay_arc_transfers WHERE owner=$1 ORDER BY created_at DESC,id LIMIT $2', [owner, ARC_LIMITS.transfers]),
        query('SELECT * FROM relay_arc_events WHERE owner=$1 AND subject=$2 ORDER BY seq', [owner, 'transfer']),
        destinations.list(owner),
        query('SELECT * FROM relay_arc_approvals WHERE owner=$1 ORDER BY created_at,id', [owner]),
        query('SELECT * FROM relay_arc_destinations WHERE owner=$1 AND removed_at IS NULL', [owner]),
      ]);
      const byId = new Map();
      for (const ev of e.rows) { if (!byId.has(ev.subject_id)) byId.set(ev.subject_id, []); byId.get(ev.subject_id).push(ev); }
      const walletEvents = (await query('SELECT * FROM relay_arc_events WHERE owner=$1 AND subject=$2 ORDER BY seq', [owner, 'wallet'])).rows;
      const ctx = {approvals: a.rows, destinations: new Map(dl.rows.map(r => [r.id, externalTestDestination(r)]))};
      const nowMs = Date.now();
      return {
        enabled: true, simulated: true, mode: 'simulation', route: ARC_ROUTE, limits: ARC_LIMITS, custody: ARC_CUSTODY,
        networkConfirmation: NETWORK_CONFIRMATION,
        speeds, walletScenarios, transferScenarios,
        providers: {wallet: 'simulated', bridge: 'simulated', signing: 'customer wallet (simulated approval)', live: 'gated'},
        wallets: w.rows.map(r => ({...walletView(r), events: walletEvents.filter(x => x.subject_id === r.id).map(x => ({at: x.at, status: x.status, note: x.note}))})),
        destinations: d,
        transfers: t.rows.map(r => transferView(r, byId.get(r.id) ?? [], nowMs, ctx)),
      };
    },

    async createWallet(owner, input) {
      const label = typeof input.label === 'string' ? input.label.trim() : '';
      if (label.length < 2 || label.length > 40 || /[\u0000-\u001f<>]/.test(label)) throw new InputError('Name your wallet with 2 to 40 characters.');
      if (!uuid(input.requestId)) throw new InputError('Missing request id.');
      const scenario = input.scenario ?? 'success';
      if (!Object.hasOwn(walletScenarios, scenario)) throw new InputError('Choose a test outcome.');
      return tx(async c => {
        await lockOwner(c, owner);
        const old = (await c.query('SELECT * FROM relay_arc_wallets WHERE owner=$1 AND request_id=$2', [owner, input.requestId])).rows[0];
        if (old) {
          if (old.label !== label || old.scenario !== scenario) throw new InputError('This request id was already used for a different wallet.', 409);
          return {id: old.id};
        }
        const count = Number((await c.query('SELECT count(*) FROM relay_arc_wallets WHERE owner=$1', [owner])).rows[0].count);
        if (count >= ARC_LIMITS.wallets) throw new InputError(`You can create up to ${ARC_LIMITS.wallets} simulated wallets.`, 409);
        const id = randomUUID();
        await c.query("INSERT INTO relay_arc_wallets(id,owner,request_id,label,status,scenario) VALUES($1,$2,$3,$4,'provisioning',$5)", [id, owner, input.requestId, label, scenario]);
        await note(c, owner, 'wallet', id, 'provisioning', 'Simulated customer-controlled wallet requested. No real wallet, key or permission is created or requested.');
        return {id};
      });
    },

    async walletAction(owner, id, input) {
      return tx(async c => {
        const w = await ownedRow(c, 'relay_arc_wallets', owner, id);
        if (input.action === 'advance') {
          if (w.status !== 'provisioning') throw new InputError('This wallet is not waiting for a setup step.', 409);
          if (w.scenario === 'failure' && w.attempt === 1) {
            await c.query("UPDATE relay_arc_wallets SET status='failed',failure_code='provider_unavailable',updated_at=now() WHERE id=$1", [id]);
            await note(c, owner, 'wallet', id, 'failed', 'Simulated setup failed (provider unavailable). Nothing was created. You can retry.');
          } else if (w.scenario === 'slow' && w.progress < 1) {
            await c.query('UPDATE relay_arc_wallets SET progress=progress+1,updated_at=now() WHERE id=$1', [id]);
            await note(c, owner, 'wallet', id, 'provisioning', 'Simulated setup is still pending.');
          } else {
            const made = providers.wallet.provision({owner, label: w.label});
            await c.query("UPDATE relay_arc_wallets SET status='ready',address=$2,provider_ref=$3,failure_code=NULL,updated_at=now() WHERE id=$1", [id, made.address, made.providerRef]);
            await note(c, owner, 'wallet', id, 'ready', 'Simulated wallet ready. Its address is synthetic and exists on no network. You would approve transfers from it; Eupova holds no key.');
          }
        } else if (input.action === 'retry') {
          if (w.status !== 'failed') throw new InputError('Only a failed setup can be retried.', 409);
          await c.query("UPDATE relay_arc_wallets SET status='provisioning',attempt=attempt+1,progress=0,failure_code=NULL,updated_at=now() WHERE id=$1", [id]);
          await note(c, owner, 'wallet', id, 'provisioning', `Retry ${w.attempt + 1} started (simulated).`);
        } else throw new InputError('Unknown wallet action.');
        return {id};
      });
    },

    async quote(owner, input) {
      if (!uuid(input.walletId)) throw new InputError('Choose one of your wallets.');
      const amount = pence(input.amount);
      const speed = input.speed ?? 'fast';
      if (!Object.hasOwn(speeds, speed)) throw new InputError('Choose Fast or Standard.');
      const wanted = input.destinationId === undefined || input.destinationId === null || input.destinationId === '' ? null : input.destinationId;
      if (wanted !== null && !uuid(wanted)) throw new InputError('Choose one of your saved destinations.', 404);
      return tx(async c => {
        await lockOwner(c, owner);
        const w = (await c.query('SELECT * FROM relay_arc_wallets WHERE id=$1 AND owner=$2', [input.walletId, owner])).rows[0];
        if (!w) throw new InputError('Choose one of your wallets.', 404);
        if (w.status !== 'ready') throw new InputError('This wallet is not ready yet, so it cannot be funded.', 409);
        let destination;
        if (wanted) {
          const d = (await c.query('SELECT * FROM relay_arc_destinations WHERE id=$1 AND owner=$2 AND removed_at IS NULL AND network_confirmed_at IS NOT NULL', [wanted, owner])).rows[0];
          if (!d) throw new InputError('Choose one of your saved destinations.', 404);
          destination = externalTestDestination(d);
        } else destination = sameAsSourceDestination(w);
        const id = randomUUID();
        const quote = {
          id, wallet: {id: w.id, label: w.label, address: w.address, chain: ARC_ROUTE.source.chain}, destination,
          ...arcQuote({pence: amount, speed}), route: {from: ARC_ROUTE.source.chain, to: ARC_ROUTE.destination.chain},
          expiresAt: new Date(Date.now() + ARC_LIMITS.quoteSeconds * 1000).toISOString(),
        };
        await c.query('DELETE FROM relay_arc_quotes q WHERE owner=$1 AND expires_at<now() AND NOT EXISTS(SELECT 1 FROM relay_arc_transfers t WHERE t.quote_id=q.id)', [owner]);
        await c.query('INSERT INTO relay_arc_quotes(id,owner,wallet_id,quote,expires_at) VALUES($1,$2,$3,$4,$5)', [id, owner, w.id, quote, quote.expiresAt]);
        return {quote};
      });
    },

    async createTransfer(owner, input) {
      if (!uuid(input.quoteId) || !uuid(input.requestId) || input.confirm !== true) throw new InputError('Review and confirm the test quote.');
      return tx(async c => {
        await lockOwner(c, owner);
        const old = (await c.query('SELECT * FROM relay_arc_transfers WHERE owner=$1 AND (request_id=$2 OR quote_id=$3)', [owner, input.requestId, input.quoteId])).rows[0];
        if (old) {
          if (old.quote_id !== input.quoteId) throw new InputError('This request belongs to another test quote.', 409);
          return {id: old.id};
        }
        const q = (await c.query('SELECT * FROM relay_arc_quotes WHERE id=$1 AND owner=$2 AND expires_at>now()', [input.quoteId, owner])).rows[0];
        if (!q) throw new InputError('This test quote has expired. Get a new quote.', 409);
        const w = (await c.query('SELECT status FROM relay_arc_wallets WHERE id=$1 AND owner=$2', [q.wallet_id, owner])).rows[0];
        if (w?.status !== 'ready') throw new InputError('This wallet is not ready, so it cannot be funded.', 409);
        const destinationId = q.quote.destination.mode === 'external_test' ? q.quote.destination.id : null;
        if (destinationId) {
          const d = (await c.query('SELECT revision,address,label FROM relay_arc_destinations WHERE id=$1 AND owner=$2 AND removed_at IS NULL', [destinationId, owner])).rows[0];
          if (!d || d.revision !== q.quote.destination.revision) throw new InputError('This destination changed after the quote was made. Get a new quote.', 409);
        }
        const count = Number((await c.query('SELECT count(*) FROM relay_arc_transfers WHERE owner=$1', [owner])).rows[0].count);
        if (count >= ARC_LIMITS.transfers) throw new InputError('Test transfer limit reached.', 409);
        const id = randomUUID();
        await c.query("INSERT INTO relay_arc_transfers(id,owner,request_id,quote_id,wallet_id,quote,status,destination_id) VALUES($1,$2,$3,$4,$5,$6,'awaiting_payment',$7)", [id, owner, input.requestId, q.id, q.wallet_id, q.quote, destinationId]);
        await note(c, owner, 'transfer', id, 'awaiting_payment', `Test quote accepted: pay ${poundsFromPence(q.quote.pence)}, expect ${q.quote.baseReceiveUsdc} USDC on Base, about ${q.quote.estimatedArcUsdc} USDC on Arc (estimate), delivered to ${destinationLabel(q.quote.destination)}.`);
        return {id};
      });
    },

    async decideApproval(owner, input) {
      if (!uuid(input.id) || !uuid(input.approvalId)) throw new InputError('Not found.', 404);
      if (!['approve', 'deny'].includes(input.decision)) throw new InputError('Choose Approve or Decline.');
      if (typeof input.bindingHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.bindingHash)) throw new InputError('Missing the approval details you reviewed.');
      const result = await tx(async c => {
        await lockOwner(c, owner);
        const t = await ownedRow(c, 'relay_arc_transfers', owner, input.id);
        const a = (await c.query('SELECT * FROM relay_arc_approvals WHERE id=$1 AND owner=$2 AND transfer_id=$3 FOR UPDATE', [input.approvalId, owner, t.id])).rows[0];
        if (!a) throw new InputError('Not found.', 404);
        const target = input.decision === 'approve' ? 'approved' : 'denied';
        if (a.status === target && a.binding_hash === input.bindingHash) return {id: t.id}; // repeat of the same decision
        if (a.status !== 'pending' || t.status !== 'approval_pending') throw new InputError(a.status === 'invalidated' ? 'This approval was cancelled because details changed. Review and approve again.' : 'This approval is no longer waiting for a decision.', 409);
        if (a.binding_hash !== input.bindingHash) throw new InputError('The details on your screen are out of date. Reload and review them before deciding.', 409);
        if (input.decision === 'deny') {
          await approvals.decide(c, a.id, 'denied');
          await c.query("UPDATE relay_arc_transfers SET status='approval_denied',updated_at=now() WHERE id=$1", [t.id]);
          await note(c, owner, 'transfer', t.id, 'approval_denied', 'You declined to approve the burn. Nothing was burned; the USDC stays in your wallet on Base.');
          return {id: t.id};
        }
        // Approve: the binding must still match the stored rows right now.
        const check = await bindingStatus(c, owner, t);
        if (!check.ok || check.snapshotHash !== a.binding_hash) {
          await approvals.invalidate(c, owner, {transferId: t.id, text: 'The source wallet or destination changed before you approved, so this approval was cancelled. Nothing was burned. Review the updated details and approve again.'});
          return {id: t.id, invalidated: true};
        }
        await approvals.decide(c, a.id, 'approved');
        await c.query("UPDATE relay_arc_transfers SET status='bridge_burn_pending',updated_at=now() WHERE id=$1", [t.id]);
        await note(c, owner, 'transfer', t.id, 'bridge_burn_pending', `You approved moving ${t.quote.baseReceiveUsdc} USDC from your wallet on ${ARC_ROUTE.source.chain} to ${destinationLabel(t.quote.destination)} on ${ARC_ROUTE.destination.chain}. Simulated: no real signature exists.`, {approvalId: a.id, bindingHash: a.binding_hash});
        return {id: t.id};
      });
      if (result.invalidated) throw new InputError('The source wallet or destination changed, so this approval was cancelled. Nothing was burned. Review the updated details and approve again.', 409);
      return result;
    },

    async transferAction(owner, id, input) {
      return tx(async c => {
        const t = await ownedRow(c, 'relay_arc_transfers', owner, id);
        const set = (status, text, extra = '', args = []) => c.query(`UPDATE relay_arc_transfers SET status='${status}',updated_at=now()${extra} WHERE id=$1`, [id, ...args]).then(() => note(c, owner, 'transfer', id, status, text));
        // True when the approval is still valid for the current rows; otherwise cancels it.
        const stillBound = async () => {
          const open = (await c.query("SELECT * FROM relay_arc_approvals WHERE transfer_id=$1 AND status='approved' AND executed_at IS NULL", [id])).rows[0];
          const check = await bindingStatus(c, owner, t);
          if (open && check.ok && check.snapshotHash === open.binding_hash) return true;
          await approvals.invalidate(c, owner, {transferId: id, text: 'The source wallet or destination changed (or the approval was missing), so the approval was cancelled before anything was burned. Review and approve again.'});
          return false;
        };
        const action = input.action;
        if (action === 'cancel') {
          if (t.status !== 'awaiting_payment') throw new InputError('Only an unpaid test transfer can be cancelled.', 409);
          await set('cancelled', 'Cancelled before any simulated payment.');
        } else if (action === 'submit') {
          if (!Object.hasOwn(transferScenarios, input.scenario)) throw new InputError('Choose a test outcome.');
          if (t.scenario) {
            if (t.scenario !== input.scenario) throw new InputError('This transfer already has a different test payment.', 409);
            return {id};
          }
          if (t.status !== 'awaiting_payment') throw new InputError('This transfer can no longer take a payment.', 409);
          if (Date.parse(t.quote.expiresAt) <= Date.now()) throw new InputError('This test quote has expired. Cancel it and get a new quote.', 409);
          if (input.scenario === 'payment_failed') {
            await set('payment_failed', 'Simulated payment declined. No money moved.', ",scenario='payment_failed',failure_code='payment_declined'");
          } else {
            await set('payment_recorded', `Simulated payment of ${poundsFromPence(t.quote.pence)} recorded. No money moved.`, ',scenario=$2', [input.scenario]);
          }
        } else if (action === 'advance') {
          const q = t.quote;
          switch (t.status) {
            case 'payment_recorded':
              await set('base_received', `Simulated Base receipt verified: ${q.baseReceiveUsdc} USDC at your wallet's Base address.`, ',base_received_raw=$2', [q.baseReceiveRaw]); break;
            case 'base_received': {
              const check = await bindingStatus(c, owner, t);
              if (!check.ok) {
                await set('approval_invalidated', 'The destination or wallet changed after this quote was made, so no approval was requested. Nothing was burned. Review the updated details and approve again.');
                break;
              }
              await approvals.open(c, owner, t);
              await set('approval_pending', `Approval requested: move ${q.baseReceiveUsdc} USDC from your wallet on ${ARC_ROUTE.source.chain} to ${destinationLabel(q.destination)} on ${ARC_ROUTE.destination.chain}. Nothing is burned until you approve.`);
              break;
            }
            case 'bridge_burn_pending':
              if (!await stillBound()) break;
              if (t.scenario === 'burn_failed' && t.attempt === 1) {
                // PRE-burn failure: no burn record is created, the USDC stays spendable in the customer's Base wallet.
                await set('burn_failed', 'Simulated burn submission failed before anything was burned. No burn record exists and the USDC is still in your wallet on Base. Try the burn again under your approval, or keep it on Base.', ",failure_code='burn_submission_failed'");
              } else {
                const approved = (await c.query("SELECT id FROM relay_arc_approvals WHERE transfer_id=$1 AND status='approved' AND executed_at IS NULL", [id])).rows[0];
                const burn = {
                  simulated: true, ref: 'sim-burn-' + randomUUID().slice(0, 12), chain: ARC_ROUTE.source.chain, amountRaw: String(q.baseReceiveRaw),
                  sourceAddress: q.wallet.address, destinationAddress: q.destination.address, destinationChain: ARC_ROUTE.destination.chain,
                  approvalId: approved?.id ?? null, confirmedAt: new Date().toISOString(),
                };
                await approvals.markExecuted(c, id);
                await set('bridge_attestation_pending', `Simulated burn confirmed on Base (record ${burn.ref}). The burn cannot be undone and the USDC is no longer spendable on Base. Waiting for the Circle attestation. The destination is now fixed for this transfer.`, ',burn_record=$2', [burn]);
              }
              break;
            case 'bridge_attestation_pending':
              if (t.scenario === 'attestation_failed' && t.attempt === 1) {
                // POST-burn failure: the burn record stays; the funds cannot return to Base, so the only path is resume.
                await set('burned_resume_required', `Simulated attestation timed out AFTER the burn (record ${t.burn_record.ref}). The burn cannot be undone and the USDC is not spendable on Base. Resume to fetch the attestation and mint on Arc.`, ",failure_code='attestation_timeout'");
              } else if (t.scenario === 'slow' && t.progress < 1) {
                await c.query('UPDATE relay_arc_transfers SET progress=progress+1,updated_at=now() WHERE id=$1', [id]);
                await note(c, owner, 'transfer', id, 'bridge_attestation_pending', 'Simulated attestation is still pending.');
              } else {
                await set('bridge_mint_pending', 'Simulated attestation received. Minting on Arc.');
              }
              break;
            case 'bridge_mint_pending': {
              const fin = providers.bridge.settle(q);
              await set('settled', `Simulated mint final on Arc Testnet at ${destinationLabel(q.destination)}. Settled output ${fin.arcOutputUsdc} USDC (estimate was ${q.estimatedArcUsdc}).`, ',settled=$2,failure_code=NULL', [fin]);
              break;
            }
            default: throw new InputError('There is no simulated network step to run in this state.', 409);
          }
        } else if (action === 'retry') {
          if (t.status === 'burn_failed') {
            if (t.burn_record) throw new InputError('A burn record exists, so this transfer cannot be treated as unburned.', 409);
            if (!await stillBound()) return {id};
            await set('bridge_burn_pending', `Retry ${t.attempt + 1}: submitting the burn again under your existing approval. Nothing had been burned.`, ',attempt=attempt+1,progress=0,failure_code=NULL');
          } else if (t.status === 'burned_resume_required') {
            // Resume from the attestation using the stored burn record. No second burn, no new approval, no hold.
            if (!t.burn_record) throw new InputError('The burn record is missing, so this transfer cannot be resumed safely. Contact support; do not start another transfer.', 409);
            await set('bridge_attestation_pending', `Resume ${t.attempt + 1}: continuing from the attestation for burn ${t.burn_record.ref}. The burn is not repeated, so nothing is double-spent.`, ',attempt=attempt+1,progress=0,failure_code=NULL');
          } else throw new InputError('Only a stopped bridge can be resumed.', 409);
        } else if (action === 'hold') {
          if (t.burn_record) throw new InputError('The burn on Base is already confirmed and cannot be undone, so the USDC cannot be kept on Base. Resume the transfer instead.', 409);
          const nothingBurned = ['approval_pending', 'approval_denied', 'approval_invalidated', 'burn_failed'].includes(t.status);
          if (!nothingBurned) throw new InputError('USDC can be kept on Base only when nothing was burned.', 409);
          if (t.status === 'approval_pending') await approvals.invalidate(c, owner, {transferId: id, text: 'You chose to keep the USDC on Base, so the approval request was withdrawn.'});
          await set('held_on_base', 'Kept on Base by you. Nothing was burned: the USDC stays in your wallet on Base and no bridge fee is charged.');
        } else if (action === 'request_approval') {
          if (t.status !== 'approval_denied') throw new InputError('Approval can be requested again only after you declined.', 409);
          const check = await bindingStatus(c, owner, t);
          if (!check.ok) { await set('approval_invalidated', 'The destination or wallet changed, so a new approval is needed. Nothing was burned.'); return {id}; }
          await approvals.open(c, owner, t);
          await set('approval_pending', 'New approval requested after you declined earlier. Nothing is burned until you approve.');
        } else if (action === 'reapprove') {
          if (t.status !== 'approval_invalidated') throw new InputError('There is no cancelled approval to renew.', 409);
          const live = await liveBinding(c, owner, t); // null when the wallet or destination is unusable
          if (!live) throw new InputError('The source wallet or destination is no longer available. Keep the USDC on Base or restore the destination.', 409);
          const w = (await c.query('SELECT * FROM relay_arc_wallets WHERE id=$1 AND owner=$2', [t.wallet_id, owner])).rows[0];
          const destination = t.destination_id
            ? externalTestDestination((await c.query('SELECT * FROM relay_arc_destinations WHERE id=$1 AND owner=$2', [t.destination_id, owner])).rows[0])
            : sameAsSourceDestination(w);
          const quote = {...t.quote, destination};
          await c.query('UPDATE relay_arc_transfers SET quote=$2,updated_at=now() WHERE id=$1', [id, quote]);
          const fresh = {...t, quote};
          await approvals.open(c, owner, fresh);
          await set('approval_pending', `Fresh approval requested for the updated destination ${destinationLabel(destination)}. Nothing is burned until you approve. Binding ${hashBinding(snapshotBinding(fresh)).slice(0, 12)}.`);
        } else throw new InputError('Unknown test action.');
        return {id};
      });
    },
  };
}
