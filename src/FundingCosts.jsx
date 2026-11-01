import FundingTerms from './FundingTerms';
import React,{useEffect,useState} from 'react';
import {fundingCosts} from './funding-costs.mjs';
import './funding-costs.css';
export default function FundingCosts(props){
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const costs=fundingCosts({...props,ended:props.ended||!!props.expiry,now});
 if(costs.reviewPair){const pair=costs.reviewPair,estimated=pair.kind==='estimate';return <section className="funding-costs funding-costs--review" aria-label="Payment and USDC review">
  <h3>{estimated?'Review your funding':'Your funding receipt'}</h3>
  <dl className="costs-pair"><div><dt>{estimated?'You pay':'Payment recorded'}</dt><dd>{pair.pay}</dd></div><div><dt>{estimated?'You receive (estimate)':pair.arrived?'Received in your wallet':'USDC after fees'}</dt><dd>{pair.receive}</dd></div></dl>
  <p className="costs-guidance">{estimated?'USDC on Base, after the estimated Peer fee. Pay the exact amount and currency shown in Peer. Currency changes, underpayment or provider adjustments can reduce the final receipt.':pair.arrived?'Matching USDC arrival has been confirmed on Base.':'Peer has recorded this settlement. Wallet arrival is checked separately.'}</p>
  {costs.trackingUnavailable&&<p className="costs-status">The latest check is unavailable. These are the last saved figures.</p>}
  {!estimated&&(props.stopped||props.ended||props.expiry||props.review)&&<p className="costs-status">Saved receipt for reference. Do not pay this checkout again.</p>}
  <details className="costs-breakdown"><summary>{estimated?'Quote details':'Payment details'}</summary>
   {pair.fee&&<p>{estimated?'Estimated Peer fee':'Recorded Peer fee'}: {pair.fee}. Already deducted from the USDC shown above.</p>}
   <p>Your bank or payment app may charge separately.</p>
   {costs.adjustments.map((text,i)=><p key={i}>{text}</p>)}
   {costs.checkedAt&&<p>Last checked: {new Date(costs.checkedAt).toLocaleString('en-GB')}.</p>}
   {estimated&&costs.expiresAt&&<p>Offer expires: {new Date(costs.expiresAt).toLocaleString('en-GB')}.</p>}
  </details>
 </section>;}
 // Compact presentation is only for a new request, never for tracked or simulated funds.
 if(props.setupOnly&&!props.verification&&!props.simulated&&!props.expiry&&!props.stopped&&!props.ended&&!props.review&&!props.trackingError)return <section className="funding-costs funding-costs--compact" aria-label="Funding summary">
  <h3>Funding summary</h3>
  <dl className="costs-request"><dt>Requested funding</dt><dd>{costs.rows[0].value}</dd></dl>
  <p className="costs-guidance">Review Peer’s offer and fees before paying. Your bank or payment app may charge separately.</p>
 </section>;
 return <section className="funding-costs" aria-label="Funding amount and fees">
  <h3>{costs.simulated?'Example amounts and fees':'Your funding amount and fees'}</h3>
  {costs.simulated&&<p className="costs-status">Simulation only. These figures do not represent a real quote, payment or wallet arrival.</p>}
  <p className="costs-status">{props.expiry?(props.expiry==='quote_elapsed'?'The quote has expired. These are saved figures for reference.':'The payment attempt has expired. These are saved figures for reference.'):props.reviewNoticeShown&&props.review?'Amounts need review. Use these saved figures for reference only.':costs.message}</p>
  {costs.trackingUnavailable&&<p className="costs-status">The latest check is unavailable. These are the last saved figures.</p>}
  <div className="costs-total"><span>{costs.allIn.label}</span><strong>{costs.allIn.value}</strong><p>{costs.allIn.note}</p></div>
  <dl className="costs-rows">{costs.rows.map(row=><div key={row.label}><dt>{row.label}<small>{row.note}</small></dt><dd>{row.value}</dd></div>)}</dl>
  {costs.adjustments.map((text,i)=><p className="fine-print" key={i}>{text}</p>)}
  {(costs.checkedAt||costs.expiresAt)&&<p className="fine-print">{costs.checkedAt&&<>Saved check: {new Date(costs.checkedAt).toLocaleString('en-GB')}. </>}{costs.expiresAt&&<>Quote deadline: {new Date(costs.expiresAt).toLocaleString('en-GB')}.</>}</p>}
  <p className="fine-print">The seller’s exchange rate can include a markup, separate from the Peer fee. Check your payment app for the total taken from your account.</p>
  <FundingTerms/>
 </section>;
}
