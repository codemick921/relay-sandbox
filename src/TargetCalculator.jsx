import React,{useEffect,useReducer,useRef,useState} from 'react';
import {Button,Field,Icon,Notice} from './ui';
import {fundingCatalog,methodLabel} from '../shared/fiat.mjs';
import {initialCalculatorState,calculatorReducer,calculatorMessage,compactAmount} from './target-calculator-state.mjs';
import {api} from './api';
import './target-calculator.css';
import QuotePlanReview from './QuotePlanReview';
import {matchesAddressContext} from './personalised-quote-state.mjs';
const liveReview=input=>api('funding-calculator/review',input);
const methods=fundingCatalog.methods.filter(m=>m.checkoutSupported);
const liveSearch=input=>api('funding-calculator/quotes',input);
export default function TargetCalculator({searchQuotes=liveSearch,reviewQuote=liveReview,sample=false,addressContext=null}){
 const [amount,setAmount]=useState('25'),[currency,setCurrency]=useState('GBP'),[method,setMethod]=useState('all');
 const [state,dispatch]=useReducer(calculatorReducer,undefined,initialCalculatorState),[now,setNow]=useState(Date.now());
 const seq=useRef(0),alive=useRef(true),offset=useRef(0),results=useRef(null),review=useRef(null);
 useEffect(()=>{alive.current=true;const timer=setInterval(()=>{const n=Date.now()-offset.current;setNow(n);dispatch({type:'expire',now:n});},1000);return()=>{alive.current=false;seq.current++;clearInterval(timer);};},[]);
 useEffect(()=>{if(state.selected)review.current?.focus();},[state.selected]);
 const edit=fn=>{fn();seq.current++;dispatch({type:'edit'});};
 const available=methods.filter(m=>m.currencies.includes(currency));
 async function search(e){
  e?.preventDefault();if(['loading','reviewing'].includes(state.phase))return;
  const call=++seq.current,generation=state.generation+1;dispatch({type:'search'});
  try{const r=await searchQuotes({amount,currency,method});if(!alive.current||call!==seq.current)return;
   if((addressContext&&!matchesAddressContext(r,addressContext,r.checkedAt))||r.canCreatePayment!==false||r.route!=='peer_direct'||!Array.isArray(r.rows)||!Number.isFinite(r.checkedAt))throw Error('invalid_response');
   offset.current=Date.now()-r.checkedAt;setNow(r.checkedAt);dispatch({type:'result',generation,rows:r.rows,checkedAt:r.checkedAt});requestAnimationFrame(()=>results.current?.focus());
  }catch(e){if(alive.current&&call===seq.current)dispatch({type:'failure',generation,message:addressContext&&['sample_context_changed','address_context_changed','buyer_verification_expired','sign_in_required','buyer_wallet_needed'].includes(e.code)?'Your wallet details could not be confirmed. Recheck the wallet details before comparing prices.':e.status===429?'Please wait a minute before checking again.':e.status===400?'Enter a target from 0.01 to 10,000 USDC, with up to six decimal places.':'Prices could not be checked. Please try again shortly.'});}
 }
 async function reviewSelected(){
  if(!state.selected||['loading','reviewing'].includes(state.phase))return;
  const call=++seq.current,generation=state.generation+1;dispatch({type:'review'});
  try{const r=await reviewQuote({amount,currency,method:state.selected.method,offerId:state.selected.offer.id});
   if(!alive.current||call!==seq.current)return;
   if(r.canCreatePayment!==false||r.reserved!==false||r.route!=='peer_direct'||(addressContext?!matchesAddressContext(r,addressContext,r.checkedAt):r.eligibility!=='example_addresses')||!Array.isArray(r.rows)||!Number.isFinite(r.checkedAt)||!r.readiness)throw Error('invalid_review');
   offset.current=Date.now()-r.checkedAt;setNow(r.checkedAt);dispatch({type:'reviewed',generation,result:r});
  }catch{if(alive.current&&call===seq.current)dispatch({type:'failure',generation,message:'The selected offer could not be rechecked. Refresh prices to try again.'});}
 }
 const chosen=state.selected?.offer,loading=['loading','reviewing'].includes(state.phase);
 return <section className="target-calculator" aria-labelledby="calculator-title">
  <div className="target-intro"><span className="target-kicker">Plan your funding</span><h2 id="calculator-title">Start with the USDC you need.</h2><p>{sample?'Try an example target and review sample rates and fees.':'Compare current direct Peer prices for your target, before making a funding decision.'}</p></div>
  {sample&&<Notice>Sample scenario · these figures are for testing only.</Notice>}
  <div className="target-grid">
   <form className="target-form" onSubmit={search}>
    <h3><Icon name="wallet"/>Your USDC target</h3>
    <Field label="I want to receive" hint="USDC on Base · after the quoted protocol fees"><div className="target-amount"><input required aria-label="USDC target" inputMode="decimal" maxLength={16} pattern="[0-9]+([.][0-9]{1,6})?" value={amount} onChange={e=>edit(()=>setAmount(e.target.value))}/><span>USDC</span></div></Field>
    <div className="target-presets" aria-label="Quick USDC targets">{['25','50','100'].map(v=><button type="button" key={v} aria-pressed={amount===v} onClick={()=>edit(()=>setAmount(v))}>{v} USDC</button>)}</div>
    <Field label="Pay in"><select value={currency} onChange={e=>edit(()=>{setCurrency(e.target.value);setMethod('all');})}>{fundingCatalog.currencies.filter(c=>methods.some(m=>m.currencies.includes(c.code))).map(c=><option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</select></Field>
    <Field label="Payment method"><select value={method} onChange={e=>edit(()=>setMethod(e.target.value))}><option value="all">Compare available methods</option>{available.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
    <Button className="full" disabled={loading}>{loading?(sample?'Checking sample prices…':'Checking current prices…'):state.rows.length?'Refresh prices':'Compare prices'}<Icon name="arrow" size={18}/></Button>
    <p className="fine-print">{addressContext?'Uses the wallet details you reviewed. Buyer eligibility still needs checking.':'Uses example addresses. Your wallet details are not shared and your eligibility is not checked.'}</p>
   </form>
   <div className="target-results" ref={results} tabIndex={-1} aria-busy={loading}>
    <div className="target-results-heading"><h3>Payment estimates</h3><span className="target-pill">Direct Peer · Base</span></div>
    <p className="target-route-note">{sample?'These invented prices demonstrate direct Peer funding. They are not merchant checkout offers.':'These prices are for direct Peer funding. Merchant checkout has its own offer and fees.'}</p>
    {state.message&&<div role="status"><Notice error={state.phase==='error'}>{state.message}</Notice></div>}
    {loading?<p role="status" className="target-empty">{state.phase==='reviewing'?(sample?'Reviewing the sample offer…':'Rechecking the selected offer…'):(sample?'Preparing sample estimates…':'Checking the selected methods…')}</p>:state.plan&&chosen?.validUntil>now?<QuotePlanReview sample={sample} plan={state.plan} method={state.selected.method} now={now} onBack={()=>dispatch({type:'review-back'})} onRefresh={reviewSelected}/>:chosen&&chosen.validUntil>now?<section ref={review} tabIndex={-1} className="target-review" aria-label="Estimate details">
     <button className="text-button target-back" type="button" onClick={()=>dispatch({type:'back'})}><Icon name="back" size={18}/>Back to estimates</button>
     <h3>{methodLabel(state.selected.method)}</h3>
     <div className="target-pair"><div><span>You pay · estimated</span><strong>{chosen.youPay.displayAmount} {chosen.youPay.currency}</strong></div><Icon name="arrow"/><div><span>You receive · quoted</span><strong>{compactAmount(chosen.youReceive.displayAmount)} USDC</strong></div></div>
     <dl className="target-breakdown"><div><dt>Protocol fees included</dt><dd>{compactAmount(chosen.fee.displayAmount)} USDC</dd></div><div><dt>{sample?'Sample generated':'Quote checked'}</dt><dd>{new Date(state.checkedAt).toLocaleTimeString('en-GB')}</dd></div><div><dt>Refresh in</dt><dd>{Math.max(0,Math.ceil((chosen.validUntil-now)/1000))} seconds</dd></div></dl>
     <p className="fine-print">The fee is already accounted for in the quoted USDC. Your bank or payment app may charge separately. Seller pricing is reflected in the rate; a separate market spread is not supplied.</p>
     {chosen.conditions.requiresStake&&<Notice>This route reports a stake requirement. A payout hold may apply without sufficient stake.</Notice>}
     {chosen.conditions.whitelisted&&<Notice>This offer has restricted access. Your eligibility has not been checked.</Notice>}
     <details className="target-evidence"><summary>How this estimate is checked</summary><p>{sample?'This sample uses invented rates and fees. It does not check Peer, eligibility or wallet ownership.':'Peer returned the amount, USDC target, fees, receiving asset and expiry together. Eupova checks that the figures reconcile. The fiat estimate is rounded up for display; payment instructions must confirm the payable amount.'}</p><p>{chosen.verification==='seller_release'?'This offer uses seller release.':'This offer requires buyer payment verification. Device support still needs checking.'} This is not a reserved offer and does not confirm wallet delivery.</p></details>
     <Button type="button" className="full" onClick={reviewSelected}>Review funding plan<Icon name="arrow" size={18}/></Button>
     <Button secondary type="button" className="full target-review-refresh" onClick={search}>Recheck this target</Button>
     <p className="target-no-pay">Reviewing a plan only rechecks prices. It does not reserve funds or create a payment.</p>
    </section>:<>
     {!state.rows.length&&state.phase!=='error'&&<div className="target-empty"><Icon name="convert" size={32}/><h3>A clearer view before you fund.</h3><p>Enter a target to compare the fiat estimate and quoted USDC side by side.</p></div>}
     {state.rows.map(row=><section className="target-method" key={row.method}><h4>{methodLabel(row.method)}</h4>{row.offers?.length?row.offers.map(offer=><button className="target-offer" type="button" key={offer.id} disabled={offer.validUntil<=now} onClick={()=>dispatch({type:'select',method:row.method,id:offer.id,now:Date.now()-offset.current})}><span><small>You pay · estimated</small><strong>{offer.youPay.displayAmount} {offer.youPay.currency}</strong></span><Icon name="arrow" size={20}/><span><small>You receive · quoted</small><strong>{compactAmount(offer.youReceive.displayAmount)} USDC</strong></span><span className="target-offer-foot">{offer.validUntil<=now?'Expired · refresh prices':`${compactAmount(offer.fee.displayAmount)} USDC fees included${offer.conditions.requiresStake?' · Stake required':''}${offer.conditions.whitelisted?' · Restricted access':''} · View estimate`}</span></button>):<p className="target-unavailable">{calculatorMessage(row)}</p>}</section>)}
    </>}
   </div>
  </div>
 </section>;
}
