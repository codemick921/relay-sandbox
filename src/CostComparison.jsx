import React from 'react';
import {Icon} from './ui';
const amount=v=>v===null||v===undefined?'Not available':`${v} USDC`;
const when=v=>v?new Date(v).toLocaleString('en-GB'):'Not available';
export default function CostComparison({comparison:c,record:r}){
 if(!c)return null;
 return <section className={'cost-comparison cost-comparison-'+c.status} aria-label="Selected offer and arrival">
  <header><span className="payments-symbol"><Icon name="wallet" size={24}/></span><div><h3>Selected offer and arrival</h3><p>{c.simulated?'Example figures only':'Compare the saved estimate with this request’s wallet delivery.'}</p></div></header>
  {c.offer&&<div className="cost-comparison-pair"><div className="cost-offer"><span>Saved selected offer</span><strong>{amount(c.offer.netUsdc)}</strong><small>Estimated after the Peer fee</small><dl><div><dt>Offer payment amount</dt><dd>{c.offer.pay}</dd></div><div><dt>Estimated Peer fee</dt><dd>{amount(c.offer.feeUsdc)}</dd></div></dl></div><div className="cost-arrival"><span>{r.deliveryConfirmed?'Confirmed wallet arrival':'Wallet arrival'}</span><strong>{c.actualUsdc===null?'Not yet confirmed':amount(c.actualUsdc)}</strong><small>{r.deliveryConfirmed?'Finalised transfer on Base':c.actualUsdc===null?'Waiting for delivery evidence':'Recorded so far; full confirmation pending'}</small><dl><div><dt>Peer recorded</dt><dd>{c.actualFiat??'Not available'}</dd></div><div><dt>Recorded Peer fee</dt><dd>{amount(r.peerFeeUsdc)}</dd></div></dl></div></div>}
  <div className="cost-comparison-result"><Icon name={c.status==='matched'?'check':'info'} size={20}/><div><h4>{c.title}</h4><p>{c.explanation}</p></div></div>
  {(c.offer||c.breakdown.length>0)&&<details><summary>How these amounts compare</summary>{c.breakdown.length>0&&<ul>{c.breakdown.map(t=><li key={t}>{t}</li>)}</ul>}{c.offer&&<p>Offer saved: {when(c.offer.observedAt)}. This is a historical estimate, not a quote to pay now.</p>}{c.offer&&<p>Saved seller rate: {c.offer.offerRate} {c.offer.currency} per USDC. The rate is already reflected in the estimate.</p>}{c.notes.map(t=><p key={t}>{t}</p>)}</details>}
 </section>;
}
