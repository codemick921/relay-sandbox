import FundingTerms from './FundingTerms';
import React,{useEffect,useState} from 'react';
import {fundingCosts} from './funding-costs.mjs';
import './funding-costs.css';
export default function FundingCosts(props){
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const costs=fundingCosts({...props,now});
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
