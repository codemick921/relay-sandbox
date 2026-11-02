import React,{useEffect,useRef} from 'react';
import {Button,Icon} from './ui';
import {methodLabel} from '../shared/fiat.mjs';
import {compactAmount} from './target-calculator-state.mjs';
export default function QuotePlanReview({plan,method,now,onBack,onRefresh,sample=false}){
 const heading=useRef(null);useEffect(()=>heading.current?.focus(),[]);
 const offer=plan.offer;
 return <section className="target-review target-plan" aria-label="Funding plan review">
  <button type="button" className="text-button target-back" onClick={onBack}><Icon name="back" size={18}/>Back to estimate</button>
  <h3 ref={heading} tabIndex={-1}>Your funding plan</h3>
  <p className="target-plan-lead">{methodLabel(method)} · USDC on Base</p>
  <div className="target-pair"><div><span>You pay · estimated</span><strong>{offer.youPay.displayAmount} {offer.youPay.currency}</strong></div><Icon name="arrow"/><div><span>You receive · quoted</span><strong>{compactAmount(offer.youReceive.displayAmount)} USDC</strong></div></div>
  <dl className="target-breakdown"><div><dt>Protocol fees included</dt><dd>{compactAmount(offer.fee.displayAmount)} USDC</dd></div><div><dt>{sample?'Sample reviewed':'Rechecked at'}</dt><dd>{new Date(plan.checkedAt).toLocaleTimeString('en-GB')}</dd></div><div><dt>Refresh in</dt><dd>{Math.max(0,Math.ceil((offer.validUntil-now)/1000))} seconds</dd></div></dl>
  <ol className="target-plan-steps">
   <li><span className="target-step-number">1</span><div><strong>{sample?'Sample terms reviewed':'Selected terms rechecked'}</strong><p>{sample?'The example rate and fees match your sample selection. No provider was contacted.':'The same offer, rate and fees were returned. Nothing is reserved.'}</p></div></li>
   <li><span className="target-step-number">2</span>{plan.addressBinding==='server_resolved'?<div className="target-address-summary"><strong>Your wallet details</strong><p>Buying wallet</p><code>{plan.addressContext.buyer.address}</code><p>Receiving wallet · USDC on Base</p><code>{plan.addressContext.recipient.address}</code><p>{sample?'These example addresses are used only in this browser. No address is sent to Peer.':'These addresses were used for the quote. Eligibility and receiving-platform support still need checking.'}</p></div>:<div><strong>Your wallet comes next</strong><p>This comparison uses example addresses. A buyer wallet and your receiving address still need checking.</p></div>}</li>
   <li><span className="target-step-number">3</span><div><strong>Payment is not available here yet</strong><p>Eupova has not verified how to reserve this offer. Payment remains unavailable.</p></div></li>
  </ol>
  <details className="target-evidence"><summary>What still needs checking?</summary>
   <p>{sample?'Real funding still needs wallet verification and an approved payment route.':plan.readiness.contract==='contract_not_verified'?'The quote names a payment contract that does not match the installed integration. Eupova will not submit it.':'The contract is recognised, but its execution path has not been verified.'}</p>
   <p>{offer.conditions.requiresStake?'This offer requires stake; a payout hold may apply. ':''}{offer.conditions.whitelisted?'Access is restricted. ':''}Eligibility, payment verification and network costs must be checked for your wallet. A separate market spread is not supplied.</p>
  </details>
  <p className="fine-print">The quoted USDC already accounts for protocol fees. Your bank or payment app may charge separately. The final payment instructions must confirm the payable amount.</p>
  <Button className="full" type="button" disabled>Payment not available yet</Button>
  <Button secondary className="full" type="button" onClick={onRefresh}>Recheck selected offer</Button>
 </section>;
}
