// Customer approvals for Base-to-Arc transfers (test-data simulation).
//
// Rule: nothing is burned until the customer approves. An approval is bound, by SHA-256, to the
// source account and chain, the destination, the amount and the quote. It is compared again from the
// CURRENT stored rows when the customer decides and again before the (simulated) burn. Editing the
// destination, or any mismatch, invalidates it. Pending, approved, declined and invalidated states
// are all kept, with the exact binding the customer saw.
import {createHash, randomUUID} from 'node:crypto';
import {ARC_ROUTE, approvalBinding, approvalStatusLabels, canonicalBinding} from '../shared/arc-funding.mjs';

export const hashBinding = binding => createHash('sha256').update(canonicalBinding(binding)).digest('hex');

export const sameAsSourceDestination = w => ({
  mode: 'same_as_source', id: null, revision: 0, label: w.label, address: w.address,
  chain: ARC_ROUTE.destination.chain, chainId: ARC_ROUTE.destination.chainId,
});
export const externalTestDestination = d => ({
  mode: 'external_test', id: d.id, revision: d.revision, label: d.label, address: d.address,
  chain: ARC_ROUTE.destination.chain, chainId: ARC_ROUTE.destination.chainId,
});
const sourceOf = w => ({walletId: w.id, address: w.address, chain: ARC_ROUTE.source.chain});

// What the customer was shown when the quote was made.
export const snapshotBinding = t => approvalBinding({
  source: {walletId: t.quote.wallet.id, address: t.quote.wallet.address, chain: ARC_ROUTE.source.chain},
  destination: t.quote.destination, quote: t.quote,
});

// What the stored rows say now. null when the source wallet or destination is no longer usable.
export async function liveBinding(c, owner, t) {
  const w = (await c.query('SELECT * FROM relay_arc_wallets WHERE id=$1 AND owner=$2', [t.wallet_id, owner])).rows[0];
  if (!w || w.status !== 'ready') return null;
  let destination;
  if (t.destination_id) {
    const d = (await c.query('SELECT * FROM relay_arc_destinations WHERE id=$1 AND owner=$2 AND removed_at IS NULL AND network_confirmed_at IS NOT NULL', [t.destination_id, owner])).rows[0];
    if (!d) return null;
    destination = externalTestDestination(d);
  } else destination = sameAsSourceDestination(w);
  return approvalBinding({source: sourceOf(w), destination, quote: t.quote});
}

export async function bindingStatus(c, owner, t) {
  const snapshotHash = hashBinding(snapshotBinding(t));
  const live = await liveBinding(c, owner, t);
  return {ok: !!live && hashBinding(live) === snapshotHash, snapshotHash, liveHash: live ? hashBinding(live) : null};
}

export function createArcApprovals({note}) {
  return {
    hashBinding,
    async migrate(c) {
      await c.query(`CREATE TABLE IF NOT EXISTS relay_arc_approvals(
        id uuid PRIMARY KEY, owner text NOT NULL, transfer_id uuid NOT NULL REFERENCES relay_arc_transfers(id),
        status text NOT NULL CHECK(status IN ('pending','approved','denied','invalidated')),
        binding jsonb NOT NULL, binding_hash text NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),
        decided_by text CHECK(decided_by IS NULL OR decided_by='customer'), reason text,
        created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, executed_at timestamptz)`);
      await c.query('CREATE INDEX IF NOT EXISTS relay_arc_approvals_transfer ON relay_arc_approvals(transfer_id,created_at)');
      // At most one open (pending or approved, not yet executed) approval per transfer.
      await c.query("CREATE UNIQUE INDEX IF NOT EXISTS relay_arc_approvals_one_open ON relay_arc_approvals(transfer_id) WHERE status IN ('pending','approved') AND executed_at IS NULL");
    },

    async open(c, owner, t) {
      const binding = snapshotBinding(t);
      const row = (await c.query('INSERT INTO relay_arc_approvals(id,owner,transfer_id,status,binding,binding_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [randomUUID(), owner, t.id, 'pending', binding, hashBinding(binding)])).rows[0];
      return row;
    },

    async latest(c, owner, transferId, {lock = false} = {}) {
      return (await c.query(`SELECT * FROM relay_arc_approvals WHERE owner=$1 AND transfer_id=$2 ORDER BY created_at DESC, id LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [owner, transferId])).rows[0] ?? null;
    },

    async decide(c, id, status) {
      await c.query("UPDATE relay_arc_approvals SET status=$2,decided_by='customer',decided_at=now() WHERE id=$1", [id, status]);
    },

    async markExecuted(c, transferId) {
      await c.query("UPDATE relay_arc_approvals SET executed_at=now() WHERE transfer_id=$1 AND status='approved' AND executed_at IS NULL", [transferId]);
    },

    // Invalidates every open approval for one transfer, or for every transfer using a destination.
    // Transfers that have not burned anything move to approval_invalidated; ones already burned are
    // untouched (the recipient is fixed once the burn is confirmed).
    async invalidate(c, owner, {transferId = null, destinationId = null, text}) {
      const rows = (await c.query(`UPDATE relay_arc_approvals a SET status='invalidated',decided_at=now(),reason=$3
        WHERE a.owner=$1 AND a.status IN ('pending','approved') AND a.executed_at IS NULL
          AND ($2::uuid IS NULL OR a.transfer_id=$2::uuid)
          AND ($4::uuid IS NULL OR a.transfer_id IN (SELECT id FROM relay_arc_transfers WHERE destination_id=$4::uuid AND owner=$1))
        RETURNING a.transfer_id`, [owner, transferId, text, destinationId])).rows;
      // A transfer asked about directly must not be left waiting on an approval that no longer exists.
      const ids = new Set(rows.map(r => r.transfer_id));
      if (transferId) ids.add(transferId);
      for (const id of ids) {
        const moved = await c.query(`UPDATE relay_arc_transfers SET status='approval_invalidated',failure_code=NULL,updated_at=now()
          WHERE id=$1 AND burn_record IS NULL AND status IN ('approval_pending','bridge_burn_pending','burn_failed') RETURNING id`, [id]);
        if (moved.rowCount) await note(c, owner, 'transfer', id, 'approval_invalidated', text);
      }
      return [...ids];
    },

    view(row) {
      if (!row) return null;
      return {
        id: row.id, status: row.status, statusLabel: approvalStatusLabels[row.status], binding: row.binding, bindingHash: row.binding_hash,
        createdAt: row.created_at, decidedAt: row.decided_at, executedAt: row.executed_at, reason: row.reason, simulated: true,
      };
    },
  };
}
