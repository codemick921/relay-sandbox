import {useState} from 'react';
import {Button, Check, Field, Notice} from './ui';
import {runCircleChallenge} from './circle-challenge.mjs';

const OPEN = new Set(['executing_burn', 'burn_confirmed', 'awaiting_attestation', 'awaiting_destination', 'outcome_unknown', 'destination_unconfirmed']);

// Move USDC from the customer's Base wallet to Arc. Live wallets only. The page never decides that a move happened:
// every status shown here comes from the server, which accepts a step only when the network's own record matches the approval.
export default function WalletBridge({cw, act, busy, error}) {
  const b = cw.bridge ?? {available: false, items: []};
  const [form, setForm] = useState({recipient: '', amount: '', confirmed: false});
  const [msg, setMsg] = useState('');
  if (cw.simulated || !cw.wallet || cw.wallet.status !== 'ready') return null;
  const mainnet = b.route?.environment === 'mainnet';
  async function review(e) {
    e.preventDefault(); setMsg('');
    await act('wallet/bridge/request', {requestId: crypto.randomUUID(), recipient: form.recipient.trim(), amount: form.amount, confirmDestination: form.confirmed === true});
  }
  async function decide(item, decision) {
    setMsg('');
    const s = await act('wallet/bridge/decide', {id: item.id, decision, bindingHash: item.fingerprint});
    if (s?.walletChallenge) {
      try { await runCircleChallenge(s.walletChallenge); await act('wallet/bridge/refresh', {id: item.id}); }
      catch (err) { setMsg(err.message || 'The wallet step was not completed. Nothing has been sent. Use "Check status" to see what happened.'); }
    }
  }
  async function resume(item) {
    setMsg('');
    const s = await act('wallet/bridge/continue', {id: item.id});
    if (s?.walletChallenge) {
      try { await runCircleChallenge(s.walletChallenge); await act('wallet/bridge/refresh', {id: item.id}); }
      catch (err) { setMsg(err.message || 'The wallet step was not completed. Use "Check status" to see what happened.'); }
    }
  }
  return (
    <section className="panel cw-panel" aria-labelledby="cw-bridge">
      <header className="cw-panel-head">
        <h2 id="cw-bridge">Move USDC to Arc</h2>
        {b.route && <span className={mainnet ? 'cw-pill cw-pill-live' : 'cw-pill'}>{mainnet ? 'Real money · Base to Arc mainnet' : 'Test network · Base Sepolia to Arc Testnet'}</span>}
      </header>
      {!b.available ? (
        <Notice><strong>Not available yet.</strong> {b.reason} Nothing has been changed, and your wallet works as usual.</Notice>
      ) : (
        <form className="cw-form" onSubmit={review}>
          <Field label="Arc address you control" hint="Check it carefully: USDC sent to an Arc address you do not control cannot be recovered. A smart-account wallet's Base address is not automatically yours on Arc."><input value={form.recipient} onChange={e => setForm({...form, recipient: e.target.value})} placeholder="0x…" spellCheck="false" autoComplete="off" /></Field>
          <p className="cw-hint"><strong>Destination network:</strong> {b.route?.destination} {mainnet ? '(mainnet, real money)' : '(test network)'} · chain {b.route?.chainId}. This is where the USDC will arrive, and it is a different network from your Base wallet.</p>
          <Check checked={form.confirmed} onChange={e => setForm({...form, confirmed: e.target.checked})}>I control this address on {b.route?.destination ?? 'Arc'} and have checked every character. I understand USDC sent to an address I do not control cannot be recovered.</Check>
          <Field label="Amount in USDC"><input inputMode="decimal" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} placeholder="10.00" /></Field>
          <p className="cw-hint">You approve the exact move first, then confirm each step in your wallet. The USDC fee is taken from the amount and shown before you approve. {cw.fees?.asset === 'sponsored' ? "The network fee is covered by Eupova through Circle's Gas Station while today's sponsorship lasts; if it runs out the move is not started." : `The network fee is paid in ${cw.network.nativeSymbol} from your wallet, as an estimate.`}</p>
          <Button type="submit" disabled={busy || !form.amount || !/^0x[0-9a-fA-F]{40}$/.test(form.recipient.trim()) || !form.confirmed}>{busy ? 'Working…' : 'Review move'}</Button>
        </form>
      )}
      {(msg || error) && <Notice error>{msg || error}</Notice>}
      {b.items.length === 0 ? <p className="cw-empty">No moves yet.</p> : (
        <ul className="cw-list">
          {b.items.map(i => (
            <li key={i.id} className="cw-row">
              <div>
                <strong>{i.amountUsdc} USDC to {i.recipient.slice(0, 8)}…{i.recipient.slice(-6)}</strong>
                <span className="cw-sub">{i.statusLabel} · {i.route}</span>
                {i.status === 'awaiting_approval' && (
                  <dl className="cw-detail">
                    <dt>From</dt><dd>Your wallet on Base (chain {i.binding.source.chainId})</dd>
                    <dt>To</dt><dd>{i.recipient} on Arc (chain {i.binding.destination.chainId})</dd>
                    <dt>Largest USDC fee</dt><dd>{(Number(i.binding.fees.maxUsdcFeeRaw) / 1e6).toFixed(6)} USDC taken from the amount</dd>
                    <dt>Fingerprint</dt><dd><code>{i.fingerprint.slice(0, 8)}…{i.fingerprint.slice(-6)}</code></dd>
                  </dl>
                )}
              </div>
              <div className="cw-actions">
                {i.canApprove && <><Button disabled={busy} onClick={() => decide(i, 'approve')}>Approve move</Button><Button secondary disabled={busy} onClick={() => decide(i, 'decline')}>Decline</Button></>}
                {i.canContinue && <Button disabled={busy} onClick={() => resume(i)}>Continue</Button>}
                {OPEN.has(i.status) && <Button secondary disabled={busy} onClick={() => act('wallet/bridge/refresh', {id: i.id})}>Check status</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
