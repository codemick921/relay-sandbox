import React, {useState} from 'react';
import {Button, Check, Field, Icon, Notice} from './ui';
import {api, gbp} from './api';
import {units} from '../shared/arc-funding.mjs';
import './arc-wallets.css';

const usdc = text => Number(text).toLocaleString('en-GB', {minimumFractionDigits: 3, maximumFractionDigits: 6}) + ' USDC';
const when = iso => new Date(iso).toLocaleString('en-GB', {dateStyle: 'medium', timeStyle: 'short'});
const ATTENTION = ['burn_failed', 'burned_resume_required', 'payment_failed', 'approval_pending', 'approval_denied', 'approval_invalidated'];

function Pill({tone = '', children}) {
  return <span className={`arc-pill ${tone}`}>{children}</span>;
}

// Pay and receive figures. The same rows render in the quote, the live transfer and the history.
export function ArcFigures({quote, transfer}) {
  const settled = transfer?.settled;
  return (
    <table className="arc-figures">
      <caption className="visually-hidden">Pay and receive figures</caption>
      <tbody>
        <tr><th scope="row">You pay (simulated)</th><td>{gbp(quote.pence)}</td></tr>
        <tr><th scope="row">Converted at the example rate (£1 = {quote.rate} USDC)</th><td>{usdc(quote.grossUsdc)}</td></tr>
        <tr><th scope="row">Example checkout fee (2%, deducted)</th><td>−{usdc(quote.peerFeeUsdc)}</td></tr>
        <tr className="arc-sum"><th scope="row">{transfer?.baseReceivedUsdc ? 'USDC received on Base (verified in simulation)' : 'USDC on Base (estimate)'}</th><td>{usdc(transfer?.baseReceivedUsdc ?? quote.baseReceiveUsdc)}</td></tr>
        <tr><th scope="row">Bridge: protocol fee, {quote.speed} ({quote.speed === 'fast' ? 'illustrative' : 'no protocol fee'})</th><td>−{usdc(units(settled?.protocolFeeRaw ?? quote.bridge.protocolFeeRaw))}</td></tr>
        <tr><th scope="row">Bridge: forwarding service fee</th><td>−{usdc(units(settled?.serviceFeeRaw ?? quote.bridge.serviceFeeRaw))}</td></tr>
        <tr><th scope="row">Bridge: destination gas allowance{settled ? '' : ' (illustrative)'}</th><td>−{usdc(units(settled?.gasFeeRaw ?? quote.bridge.gasFeeRaw))}</td></tr>
        <tr className="arc-sum"><th scope="row">Arc USDC, estimated before settlement</th><td>{usdc(quote.estimatedArcUsdc)}</td></tr>
        {settled
          ? <tr className="arc-settled"><th scope="row">Arc USDC, settled (simulation)</th><td>{usdc(settled.arcOutputUsdc)}</td></tr>
          : <tr className="arc-muted"><th scope="row">Arc USDC, settled</th><td>Not settled yet</td></tr>}
      </tbody>
    </table>
  );
}

// Exactly what an approval covers. The same fields are hashed on the server.
export function ApprovalBinding({binding, hash}) {
  return (
    <dl className="details arc-binding" aria-label="What you are approving">
      <div><dt>Source account</dt><dd>Your wallet {binding.source.address} on {binding.source.chain} (you sign; Eupova holds no key)</dd></div>
      <div><dt>Destination</dt><dd>{binding.destination.mode === 'external_test' ? 'TEST destination: ' : ''}{binding.destination.label}<br/><code>{binding.destination.address}</code> on {binding.destination.chain}</dd></div>
      <div><dt>Amount to burn</dt><dd>{usdc(units(binding.amountRaw))} on Base</dd></div>
      <div><dt>Quote</dt><dd>{binding.quote.speed === 'fast' ? 'Fast' : 'Standard'} · bridge fees about {usdc(units(binding.quote.bridgeFeeRaw))} · about {usdc(units(binding.quote.estimatedArcRaw))} arrives (estimate)</dd></div>
      <div><dt>Approval fingerprint</dt><dd><code>{hash.slice(0, 16)}…</code> Any change to the above cancels this approval.</dd></div>
    </dl>
  );
}

function AddressCheck() {
  const [value, setValue] = useState('');
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState('');
  async function check(e) {
    e.preventDefault();
    setProblem('');
    try { setResult((await api('arc/address-check', {address: value.trim()})).check); } catch (err) { setProblem(err.message); }
  }
  return (
    <section className="panel arc-section" aria-labelledby="arc-address-title">
      <h2 id="arc-address-title">Check an Arc address format</h2>
      <p className="arc-lede">Pasting an address here only checks its format. Saved test destinations use the same format-only check, so a saved address is never described as verified, supported or owned.</p>
      <form onSubmit={check} className="arc-inline-form">
        <Field label="Address"><input value={value} spellCheck="false" autoComplete="off" onChange={e => { setValue(e.target.value); setResult(null); }} placeholder="0x…"/></Field>
        <Button disabled={!value.trim()}>Check format</Button>
      </form>
      {problem && <Notice error>{problem}</Notice>}
      {result && (
        <div className={`arc-check ${result.valid ? 'ok' : 'bad'}`} role="status">
          <strong>{result.valid ? 'Format looks right' : 'Format problem'}</strong>
          <p>{result.message}</p>
          <ul>
            <li>Network support on Arc: not checked</li>
            <li>Ownership: not checked</li>
          </ul>
        </div>
      )}
    </section>
  );
}

function WalletCard({wallet, act, busy}) {
  return (
    <article className="arc-card" aria-label={wallet.label}>
      <header>
        <div><h3>{wallet.label}</h3><span className="arc-sub">Customer-controlled wallet · you approve every transfer · simulated</span></div>
        <Pill tone={wallet.status}>{wallet.statusLabel}</Pill>
      </header>
      {wallet.address
        ? <div className="arc-address"><span>Simulated address (exists on no network)</span><code tabIndex={0}>{wallet.address}</code></div>
        : <p className="arc-muted-text">No address yet. It is assigned when the simulated setup finishes.</p>}
      {wallet.status === 'failed' && <Notice error>Simulated setup failed ({wallet.failureCode}). Nothing was created, and nothing was charged.</Notice>}
      <div className="arc-actions">
        {wallet.canAdvance && <Button secondary disabled={busy} onClick={() => act('arc/wallets/action', {id: wallet.id, action: 'advance'})}>Run next simulated setup step</Button>}
        {wallet.canRetry && <Button disabled={busy} onClick={() => act('arc/wallets/action', {id: wallet.id, action: 'retry'})}>Retry setup</Button>}
      </div>
      <details><summary>History ({wallet.events.length})</summary>
        <ol className="arc-events">{wallet.events.map((e, i) => <li key={i}><time>{when(e.at)}</time> {e.note}</li>)}</ol>
      </details>
    </article>
  );
}

function CreateWallet({arc, act, busy}) {
  const [label, setLabel] = useState('');
  const [scenario, setScenario] = useState('success');
  const full = arc.wallets.length >= arc.limits.wallets;
  return (
    <form className="arc-form" onSubmit={async e => { e.preventDefault(); if (await act('arc/wallets/create', {label, scenario, requestId: crypto.randomUUID()})) setLabel(''); }}>
      <Field label="Wallet name" hint="2 to 40 characters. This creates a simulated record only. No real wallet, key or permission exists, and none is requested."><input required minLength={2} maxLength={40} value={label} onChange={e => setLabel(e.target.value)} placeholder="My Base wallet"/></Field>
      <Field label="Test outcome"><select value={scenario} onChange={e => setScenario(e.target.value)}>{Object.entries(arc.walletScenarios).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Button disabled={busy || full || label.trim().length < 2}>Create simulated wallet</Button>
      {full && <p className="arc-muted-text">You have reached the limit of {arc.limits.wallets} simulated wallets.</p>}
    </form>
  );
}

// Save, edit and remove external TEST destinations. Format-only validation, explicit network confirmation.
function Destinations({arc, act, busy}) {
  const [editing, setEditing] = useState(null);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const full = !editing && arc.destinations.length >= arc.limits.destinations;
  const reset = () => { setEditing(null); setLabel(''); setAddress(''); setConfirmed(false); };
  const begin = d => { setEditing(d); setLabel(d.label); setAddress(d.address); setConfirmed(false); };
  async function save(e) {
    e.preventDefault();
    const body = {requestId: crypto.randomUUID(), label, address: address.trim(), confirmNetwork: confirmed, network: 'arc_testnet', ...(editing ? {id: editing.id, expectedRevision: editing.revision} : {})};
    if (await act('arc/destinations/save', body)) reset();
  }
  return (
    <section className="panel arc-section" aria-labelledby="arc-dest-title">
      <h2 id="arc-dest-title">Where the USDC lands on Arc</h2>
      <p className="arc-lede">The destination only receives. It needs no signature, so it can be your wallet's own address on Arc or any address you save here. Saved destinations are test data on Arc Testnet and are always labelled TEST.</p>
      <div className="arc-grid">
        {arc.destinations.map(d => (
          <article className="arc-card" key={d.id} aria-label={`Test destination ${d.label}`}>
            <header><div><h3>{d.label}</h3><span className="arc-sub">TEST destination · {d.network} · revision {d.revision}</span></div><Pill tone="provisioning">Test</Pill></header>
            <div className="arc-address"><span>Address (format checked only)</span><code tabIndex={0}>{d.address}</code></div>
            <ul className="arc-checks"><li>Network confirmed by you: Arc Testnet ({when(d.networkConfirmedAt)})</li><li>Network support, ability to receive, ownership: not checked</li></ul>
            {d.inUse > 0 && <p className="arc-muted-text">{d.inUse} transfer{d.inUse === 1 ? ' is' : 's are'} still using this destination. Editing it cancels any approval you gave them that has not burned yet.</p>}
            <div className="arc-actions">
              <Button secondary disabled={busy} onClick={() => begin(d)}>Edit</Button>
              <Button secondary disabled={busy || d.inUse > 0} onClick={() => act('arc/destinations/remove', {id: d.id})}>Remove</Button>
            </div>
            <details><summary>History ({d.events.length})</summary><ol className="arc-events">{d.events.map((e, i) => <li key={i}><time>{when(e.at)}</time> {e.note}</li>)}</ol></details>
          </article>
        ))}
      </div>
      {!arc.destinations.length && <p className="arc-muted-text">No saved destinations yet. Without one, funds go to your own wallet's address on Arc.</p>}
      <form className="arc-form" onSubmit={save} aria-label={editing ? 'Edit test destination' : 'Save a test destination'}>
        <h3>{editing ? `Edit “${editing.label}”` : 'Save an external test destination'}</h3>
        <Field label="Name" hint="2 to 40 characters"><input required minLength={2} maxLength={40} value={label} onChange={e => setLabel(e.target.value)} placeholder="Agent test wallet"/></Field>
        <Field label="Arc address" hint="Format check only (0x and 40 hex characters)."><input required value={address} spellCheck="false" autoComplete="off" onChange={e => setAddress(e.target.value)} placeholder="0x…"/></Field>
        <Check checked={confirmed} onChange={e => setConfirmed(e.target.checked)}>{arc.networkConfirmation}</Check>
        <div className="arc-actions">
          <Button disabled={busy || full || !confirmed || label.trim().length < 2 || !address.trim()}>{editing ? 'Save changes' : 'Save test destination'}</Button>
          {editing && <Button type="button" secondary disabled={busy} onClick={reset}>Cancel edit</Button>}
        </div>
        {full && <p className="arc-muted-text">You have reached the limit of {arc.limits.destinations} saved destinations.</p>}
      </form>
    </section>
  );
}

function FundForm({arc, act, busy}) {
  const ready = arc.wallets.filter(w => w.status === 'ready');
  const [walletId, setWalletId] = useState(ready[0]?.id ?? '');
  const [destinationId, setDestinationId] = useState('');
  const [amount, setAmount] = useState('25');
  const [speed, setSpeed] = useState('fast');
  const [quote, setQuote] = useState(null);
  const [requestId, setRequestId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const effective = ready.some(w => w.id === walletId) ? walletId : ready[0]?.id ?? '';
  const effectiveDest = arc.destinations.some(d => d.id === destinationId) ? destinationId : '';
  async function review(e) {
    e.preventDefault();
    setLoading(true); setProblem('');
    try { setQuote((await api('arc/quote', {walletId: effective, destinationId: effectiveDest || null, amount, speed})).quote); setRequestId(crypto.randomUUID()); setConfirmed(false); }
    catch (err) { setProblem(err.message); } finally { setLoading(false); }
  }
  if (!ready.length) return <p className="arc-muted-text">Create a wallet and finish its simulated setup to fund it.</p>;
  return (
    <>
      {problem && <Notice error>{problem}</Notice>}
      {!quote
        ? (
          <form className="arc-form" onSubmit={review}>
            <Field label="Pay from (your wallet on Base)" hint="You approve the transfer from this wallet. Eupova cannot move its funds."><select value={effective} onChange={e => setWalletId(e.target.value)}>{ready.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}</select></Field>
            <Field label="Deliver to (on Arc)" hint="Separate from the wallet that signs. Choosing your own address only reuses it on Arc: Eupova has not checked anything on Arc, and the address matching does not show that a wallet is set up or usable there."><select value={effectiveDest} onChange={e => setDestinationId(e.target.value)}>
              <option value="">Same address as my wallet, on Arc</option>
              {arc.destinations.map(d => <option key={d.id} value={d.id}>TEST destination: {d.label}</option>)}
            </select></Field>
            <Field label="Amount to pay" hint="£2 to £1,000. An example amount, not a payment request."><div className="money-input"><span>£</span><input inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" required value={amount} onChange={e => setAmount(e.target.value)} aria-label="Amount in pounds"/></div></Field>
            <Field label="Bridge speed" hint={arc.speeds[speed].timing}><select value={speed} onChange={e => setSpeed(e.target.value)}>{Object.entries(arc.speeds).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
            <Button disabled={loading || busy}>{loading ? 'Preparing example…' : 'Review test quote'}</Button>
          </form>
        )
        : (
          <>
            <ArcFigures quote={quote}/>
            <dl className="details">
              <div><dt>Route</dt><dd>{quote.route.from} → {quote.route.to} (simulated)</dd></div>
              <div><dt>Signs and approves (source)</dt><dd>{quote.wallet.label}, your wallet on {quote.wallet.chain}</dd></div>
              <div><dt>Receives (destination)</dt><dd>{quote.destination.mode === 'external_test' ? 'TEST destination: ' : ''}{quote.destination.label} on {quote.destination.chain}</dd></div>
            </dl>
            <code className="arc-address-code">{quote.destination.address}</code>
            <p className="arc-muted-text">Fee amounts are illustrative. Real fees come from Circle at transfer time and the settled amount can differ from this estimate. Valid until {new Date(quote.expiresAt).toLocaleTimeString('en-GB')}. Creating the transfer burns nothing: you approve the burn later, after the USDC reaches your wallet on Base.</p>
            <Check checked={confirmed} onChange={e => setConfirmed(e.target.checked)}>I understand this is a simulation: no money moves and no real wallet or bridge is used.</Check>
            <div className="arc-actions">
              <Button disabled={busy || !confirmed} onClick={async () => { if (await act('arc/transfers/create', {quoteId: quote.id, requestId, confirm: true})) setQuote(null); }}>Create test transfer</Button>
              <Button secondary disabled={busy} onClick={() => setQuote(null)}>Change amount, destination or get a new quote</Button>
            </div>
          </>
        )}
    </>
  );
}

// The customer's decision. Approve and Decline are both always offered while the request is open.
function ApprovalPanel({t, act, busy}) {
  const a = t.approval;
  if (!a) return null;
  const tone = {pending: 'provisioning', approved: 'ready', denied: 'failed', invalidated: 'failed'}[a.status];
  return (
    <section className="arc-approval" aria-label="Your approval">
      <div className="arc-approval-head"><strong>Your approval</strong><Pill tone={tone}>{a.statusLabel}</Pill></div>
      <ApprovalBinding binding={a.binding} hash={a.bindingHash}/>
      {t.destinationChanged && <Notice error>This destination changed after the quote. Approving is blocked until you review the updated details.</Notice>}
      {t.canApprove && (
        <div className="arc-actions">
          <Button disabled={busy} onClick={() => act('arc/approvals/decide', {id: t.id, approvalId: a.id, bindingHash: a.bindingHash, decision: 'approve'})}>Approve in my wallet (simulated)</Button>
          <Button secondary disabled={busy} onClick={() => act('arc/approvals/decide', {id: t.id, approvalId: a.id, bindingHash: a.bindingHash, decision: 'deny'})}>Decline</Button>
        </div>
      )}
      {a.status === 'approved' && !a.executedAt && <p className="arc-muted-text">Approved {when(a.decidedAt)}. Simulated: a live route would ask your wallet for a real signature here.</p>}
      {a.status === 'denied' && <p className="arc-muted-text">You declined {when(a.decidedAt)}. This is kept in your history.</p>}
      {a.status === 'invalidated' && a.reason && <p className="arc-muted-text">{a.reason}</p>}
    </section>
  );
}

function TransferCard({t, arc, act, busy, open, toggle}) {
  const [scenario, setScenario] = useState('success');
  const tone = t.status === 'settled' ? 'ready' : ['payment_failed', 'burn_failed', 'burned_resume_required', 'approval_denied', 'approval_invalidated'].includes(t.status) ? 'failed' : t.terminal ? '' : 'provisioning';
  const go = action => act('arc/transfers/action', {id: t.id, action});
  return (
    <article className="arc-card" aria-label={`Transfer ${gbp(t.quote.pence)} to ${t.destination.displayLabel}`}>
      <header>
        <div><h3>{gbp(t.quote.pence)} → {t.destination.displayLabel}</h3><span className="arc-sub">{when(t.createdAt)} · from {t.walletLabel} on {t.route.from} to {t.destination.chain} · simulated</span></div>
        <Pill tone={tone}>{t.statusLabel}</Pill>
      </header>
      <p className="arc-hint" role="status">{t.hint}</p>
      <div className="arc-summary">
        <div><span>Funds are on</span><strong>{t.fundsLocation}</strong></div>
        {(t.burn || t.spendableOnBase) && <div><span>Spendable on Base</span><strong>{t.burn ? 'No: already burned' : 'Yes: nothing burned'}</strong></div>}
        <div><span>Arc USDC {t.settled ? 'settled' : 'estimated'}</span><strong>{usdc(t.settled?.arcOutputUsdc ?? t.estimatedArcUsdc)}</strong></div>
        {t.settled && <div><span>Estimated before</span><strong>{usdc(t.estimatedArcUsdc)}</strong></div>}
      </div>
      {t.failureKind === 'pre_burn' && <Notice error>Failure before the burn. No burn record exists, so nothing left your Base wallet. You can try the burn again under your approval, or keep the USDC on Base.</Notice>}
      {t.failureKind === 'post_burn' && <Notice error>Failure after the burn. The burn on Base is confirmed and cannot be undone, so this USDC is not spendable on Base and cannot be kept there. Resume from the attestation using the burn record below. Do not start another transfer.</Notice>}
      {t.burn && (
        <div className="arc-approval" aria-label="Burn record">
          <strong>Burn record (simulated, permanent)</strong>
          <dl className="details arc-binding">
            <div><dt>Reference</dt><dd><code>{t.burn.ref}</code></dd></div>
            <div><dt>Burned on {t.burn.chain}</dt><dd>{usdc(t.burn.amountUsdc)} from <code>{t.burn.sourceAddress}</code></dd></div>
            <div><dt>Mints on {t.burn.destinationChain}</dt><dd><code>{t.burn.destinationAddress}</code> (fixed at the burn)</dd></div>
            <div><dt>Confirmed</dt><dd>{when(t.burn.confirmedAt)}</dd></div>
          </dl>
          <p className="arc-muted-text">A confirmed burn cannot be undone. Resuming continues from the attestation for this record; it never burns again.</p>
        </div>
      )}
      {t.destinationChanged && !t.approval?.status?.startsWith('pending') && <Notice>The saved destination changed after this quote. You will be asked to approve the updated destination before anything is burned.</Notice>}
      {t.canSubmit && (
        <div className="arc-sim">
          <Field label="Simulated payment outcome"><select value={scenario} onChange={e => setScenario(e.target.value)}>{Object.entries(arc.transferScenarios).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Button disabled={busy} onClick={() => act('arc/transfers/action', {id: t.id, action: 'submit', scenario})}>Record simulated payment</Button>
        </div>
      )}
      {t.expired && <Notice>This test quote expired before a payment was recorded. Cancel it and get a new quote.</Notice>}
      <ApprovalPanel t={t} act={act} busy={busy}/>
      <div className="arc-actions">
        {t.canAdvance && <Button secondary disabled={busy} onClick={() => go('advance')}>{t.advanceLabel ?? 'Run next simulated network step'}</Button>}
        {t.canRequestApproval && <Button disabled={busy} onClick={() => go('request_approval')}>Ask for approval again</Button>}
        {t.canReapprove && <Button disabled={busy} onClick={() => go('reapprove')}>Review updated details and ask again</Button>}
        {t.canRetry && <Button disabled={busy} onClick={() => go('retry')}>{t.retryLabel ?? 'Resume bridge'}</Button>}
        {t.canHold && <Button secondary disabled={busy} onClick={() => go('hold')}>Keep USDC on Base</Button>}
        {t.canCancel && <Button secondary disabled={busy} onClick={() => go('cancel')}>Cancel</Button>}
        <button type="button" className="text-button" aria-expanded={open} onClick={toggle}>{open ? 'Hide figures and history' : 'Show figures and history'}</button>
      </div>
      {open && (
        <>
          <ArcFigures quote={t.quote} transfer={t}/>
          {t.approvals.length > 1 && (
            <details open><summary>Approval history ({t.approvals.length})</summary>
              <ol className="arc-events">{t.approvals.map(a => <li key={a.id}><time>{when(a.createdAt)}</time> <strong>{a.statusLabel}.</strong> Fingerprint {a.bindingHash.slice(0, 12)}…{a.reason ? ' ' + a.reason : ''}</li>)}</ol>
            </details>
          )}
          <ol className="arc-events">{t.events.map((e, i) => <li key={i}><time>{when(e.at)}</time> <strong>{e.label}.</strong> {e.note}</li>)}</ol>
        </>
      )}
    </article>
  );
}

export default function ArcWallets({state, act, busy, error}) {
  const arc = state.arcFunding;
  const [openId, setOpenId] = useState(null);
  const [filter, setFilter] = useState('all');
  if (!arc?.enabled) return <Notice>Arc agentic wallets are not available in this environment.</Notice>;
  const transfers = arc.transfers.filter(t => filter === 'all' || (filter === 'open' && !t.terminal) || (filter === 'attention' && ATTENTION.includes(t.status)) || (filter === 'settled' && t.status === 'settled'));
  return (
    <div className="arc-hub">
      <Notice><span><strong>Test-data simulation.</strong> Every wallet, address, payment, approval and bridge step on this page is simulated and stored only as test records. No real wallet or key is created, no signature or permission is requested, no money moves, and nothing is sent to Circle, Privy or any chain.</span><span className="arc-env-badge"> <strong>TEST NETWORKS ONLY:</strong> Base Sepolia to Arc Testnet. Arc also has a mainnet in Circle's current documentation, but this build does not offer it and never presents test funds as real.</span></Notice>
      {error && <Notice error>{error}</Notice>}

      <section className="panel arc-section" aria-labelledby="arc-custody-title">
        <h2 id="arc-custody-title">{arc.custody.headline}</h2>
        <ul className="arc-status-list">{arc.custody.statements.map(s => <li key={s}>{s}</li>)}</ul>
      </section>

      <section className="panel arc-section" aria-labelledby="arc-route-title">
        <h2 id="arc-route-title">The route</h2>
        <ol className="arc-route">
          <li><strong>Pay in pounds</strong><span>Simulated Wise-style checkout</span></li>
          <li><strong>USDC in your wallet on {arc.route.source.chain}</strong><span>Your wallet is the source</span></li>
          <li><strong>You approve the burn</strong><span>Source, destination, amount and quote are bound</span></li>
          <li><strong>Bridge (CCTP forwarding)</strong><span>Burn, attestation, forwarded mint</span></li>
          <li><strong>USDC on {arc.route.destination.chain}</strong><span>At your chosen destination</span></li>
        </ol>
        <details>
          <summary>What is simulated, and what is not available</summary>
          <ul className="arc-status-list">
            <li><Pill tone="ready">Implemented</Pill> Saved state, quotes, approvals, destinations, histories, recovery and owner isolation.</li>
            <li><Pill tone="provisioning">Simulated</Pill> Wallet setup, the customer's approval, Base receipt, the bridge steps and every fee amount.</li>
            <li><Pill tone="failed">Not available</Pill> Live wallets, live signing and live bridging.</li>
          </ul>
          <ul>{arc.route.live.reasons.map(r => <li key={r}>{r}</li>)}</ul>
        </details>
      </section>

      <section className="panel arc-section" aria-labelledby="arc-wallets-title">
        <div className="section-head"><h2 id="arc-wallets-title">Your wallets (source, you approve)</h2></div>
        <div className="arc-grid">{arc.wallets.map(w => <WalletCard key={w.id} wallet={w} act={act} busy={busy}/>)}</div>
        {!arc.wallets.length && <p className="arc-muted-text">No wallets yet.</p>}
        <CreateWallet arc={arc} act={act} busy={busy}/>
      </section>

      <Destinations arc={arc} act={act} busy={busy}/>

      <section className="panel arc-section" aria-labelledby="arc-fund-title">
        <h2 id="arc-fund-title">Fund an agent on Arc</h2>
        <FundForm arc={arc} act={act} busy={busy}/>
      </section>

      <section className="panel arc-section" aria-labelledby="arc-history-title">
        <div className="section-head">
          <h2 id="arc-history-title">Transfers, approvals and recovery</h2>
          <label className="filter-label">Show
            <select value={filter} onChange={e => setFilter(e.target.value)}>
              <option value="all">All</option><option value="open">In progress</option><option value="attention">Needs attention</option><option value="settled">Settled</option>
            </select>
          </label>
        </div>
        {!transfers.length && <p className="arc-muted-text">No transfers to show.</p>}
        <div className="arc-grid">
          {transfers.map(t => <TransferCard key={t.id} t={t} arc={arc} act={act} busy={busy} open={openId === t.id} toggle={() => setOpenId(openId === t.id ? null : t.id)}/>)}
        </div>
      </section>

      <AddressCheck/>
      <p className="arc-foot"><Icon name="info" size={16}/> Simulated Arc records are kept apart from your real Base funding, receipts and statements.</p>
    </div>
  );
}
