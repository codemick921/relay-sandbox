// Saved external Arc destinations for the simulation (test data only).
//
// A destination is only somewhere USDC lands on Arc. It needs no signature from anyone, so the
// customer may save any address, clearly labelled as a TEST destination. Rules:
//  - format-only validation: Eupova never claims the address works on Arc or who controls it;
//  - the customer must explicitly confirm the network (Arc Testnet) on every save and edit;
//  - owner-scoped persistence with a revision counter; an edit needs the revision the customer saw;
//  - an edit invalidates every open approval that used the destination (see arc-approvals.mjs).
import {randomUUID} from 'node:crypto';
import {InputError} from '../server/validation.mjs';
import {ARC_LIMITS, ARC_ROUTE, arcAddressCheck} from '../shared/arc-funding.mjs';

const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const TERMINAL = "('payment_failed','settled','held_on_base','cancelled')";

export function createArcDestinations({note, approvals, tx, query, lockOwner}) {
  const view = (r, inUse = 0) => ({
    id: r.id, label: r.label, address: r.address, mode: 'external_test', testLabel: true,
    network: ARC_ROUTE.destination.chain, chainId: ARC_ROUTE.destination.chainId, revision: r.revision,
    formatChecked: true, networkChecked: false, ownershipChecked: false,
    networkConfirmedAt: r.network_confirmed_at, createdAt: r.created_at, updatedAt: r.updated_at, inUse,
  });
  const cleanLabel = value => {
    const label = typeof value === 'string' ? value.trim() : '';
    if (label.length < 2 || label.length > 40 || /[\u0000-\u001f<>]/.test(label)) throw new InputError('Name the destination with 2 to 40 characters.');
    return label;
  };
  const cleanAddress = value => {
    const check = arcAddressCheck(typeof value === 'string' ? value.trim() : '');
    if (!check.valid) throw new InputError(check.message ?? 'Enter a valid 0x address.');
    return value.trim().toLowerCase();
  };
  const requireNetworkConfirmation = input => {
    if (input.confirmNetwork !== true || input.network !== 'arc_testnet') {
      throw new InputError('Confirm the network: this must be an Arc Testnet address, not a mainnet address.');
    }
  };

  return {
    async migrate(c) {
      await c.query(`CREATE TABLE IF NOT EXISTS relay_arc_destinations(
        id uuid PRIMARY KEY, owner text NOT NULL, request_id uuid NOT NULL, label text NOT NULL,
        address text NOT NULL CHECK(address ~ '^0x[a-f0-9]{40}$'),
        network text NOT NULL DEFAULT 'arc_testnet' CHECK(network='arc_testnet'),
        kind text NOT NULL DEFAULT 'external_test' CHECK(kind='external_test'),
        test_label boolean NOT NULL DEFAULT true CHECK(test_label),
        revision int NOT NULL DEFAULT 1, network_confirmed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz,
        UNIQUE(owner,request_id))`);
      await c.query('CREATE UNIQUE INDEX IF NOT EXISTS relay_arc_destinations_owner_address ON relay_arc_destinations(owner,address) WHERE removed_at IS NULL');
    },

    async list(owner) {
      const rows = (await query('SELECT * FROM relay_arc_destinations WHERE owner=$1 AND removed_at IS NULL ORDER BY created_at,id', [owner])).rows;
      if (!rows.length) return [];
      const used = (await query(`SELECT destination_id,count(*) FROM relay_arc_transfers WHERE owner=$1 AND destination_id IS NOT NULL AND status NOT IN ${TERMINAL} GROUP BY destination_id`, [owner])).rows;
      const events = (await query("SELECT * FROM relay_arc_events WHERE owner=$1 AND subject='destination' ORDER BY seq", [owner])).rows;
      return rows.map(r => ({
        ...view(r, Number(used.find(u => u.destination_id === r.id)?.count ?? 0)),
        events: events.filter(e => e.subject_id === r.id).map(e => ({at: e.at, status: e.status, note: e.note})),
      }));
    },

    async save(owner, input) {
      if (!uuid(input.requestId)) throw new InputError('Missing request id.');
      const label = cleanLabel(input.label), address = cleanAddress(input.address);
      requireNetworkConfirmation(input);
      return tx(async c => {
        await lockOwner(c, owner);
        if (input.id !== undefined && input.id !== null) {
          if (!uuid(input.id)) throw new InputError('Not found.', 404);
          const d = (await c.query('SELECT * FROM relay_arc_destinations WHERE id=$1 AND owner=$2 AND removed_at IS NULL FOR UPDATE', [input.id, owner])).rows[0];
          if (!d) throw new InputError('Not found.', 404);
          if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== d.revision) {
            throw new InputError('This destination changed since you opened it. Reload and review it again.', 409);
          }
          if (d.label === label && d.address === address) return {id: d.id, changed: false};
          const clash = (await c.query('SELECT 1 FROM relay_arc_destinations WHERE owner=$1 AND address=$2 AND removed_at IS NULL AND id<>$3', [owner, address, d.id])).rows[0];
          if (clash) throw new InputError('You already saved this address as another destination.', 409);
          await c.query('UPDATE relay_arc_destinations SET label=$2,address=$3,revision=revision+1,network_confirmed_at=now(),updated_at=now() WHERE id=$1', [d.id, label, address]);
          await note(c, owner, 'destination', d.id, 'edited', `Edited (revision ${d.revision + 1}). Network confirmed as Arc Testnet. Format checked only.`);
          const affected = await approvals.invalidate(c, owner, {destinationId: d.id, text: 'You edited the destination after this approval was requested, so the approval was cancelled. Nothing was burned. Review the new destination and approve again, or keep the USDC on Base.'});
          return {id: d.id, changed: true, invalidated: affected.length};
        }
        const old = (await c.query('SELECT * FROM relay_arc_destinations WHERE owner=$1 AND request_id=$2', [owner, input.requestId])).rows[0];
        if (old) {
          if (old.label !== label || old.address !== address) throw new InputError('This request id was already used for a different destination.', 409);
          return {id: old.id, changed: false};
        }
        const count = Number((await c.query('SELECT count(*) FROM relay_arc_destinations WHERE owner=$1 AND removed_at IS NULL', [owner])).rows[0].count);
        if (count >= ARC_LIMITS.destinations) throw new InputError(`You can save up to ${ARC_LIMITS.destinations} test destinations.`, 409);
        const clash = (await c.query('SELECT 1 FROM relay_arc_destinations WHERE owner=$1 AND address=$2 AND removed_at IS NULL', [owner, address])).rows[0];
        if (clash) throw new InputError('You already saved this address as a destination.', 409);
        const id = randomUUID();
        await c.query('INSERT INTO relay_arc_destinations(id,owner,request_id,label,address,network_confirmed_at) VALUES($1,$2,$3,$4,$5,now())', [id, owner, input.requestId, label, address]);
        await note(c, owner, 'destination', id, 'saved', 'Saved as a TEST destination. Network confirmed as Arc Testnet by you. Format checked only: Eupova has not confirmed the address on Arc or who controls it.');
        return {id, changed: true};
      });
    },

    async remove(owner, input) {
      if (!uuid(input?.id)) throw new InputError('Not found.', 404);
      return tx(async c => {
        await lockOwner(c, owner);
        const d = (await c.query('SELECT * FROM relay_arc_destinations WHERE id=$1 AND owner=$2 AND removed_at IS NULL FOR UPDATE', [input.id, owner])).rows[0];
        if (!d) throw new InputError('Not found.', 404);
        const open = Number((await c.query(`SELECT count(*) FROM relay_arc_transfers WHERE owner=$1 AND destination_id=$2 AND status NOT IN ${TERMINAL}`, [owner, d.id])).rows[0].count);
        if (open) throw new InputError('This destination is used by a transfer that is still in progress. Finish or cancel that transfer first.', 409);
        await c.query('UPDATE relay_arc_destinations SET removed_at=now(),updated_at=now() WHERE id=$1', [d.id]);
        await note(c, owner, 'destination', d.id, 'removed', 'Removed from your saved destinations. Past transfers keep their record.');
        return {id: d.id};
      });
    },
  };
}
