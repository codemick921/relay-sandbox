import {knownCurrency,formatFiat} from '../shared/fiat.mjs';
import {exampleCostQuote} from './funding-quote.mjs';
// Presentation of saved evidence only. No quotes, authorisations or provider calls.
const raw=value=>typeof value==='string'&&/^\d{1,24}$/.test(value)?BigInt(value):null;
const pence=value=>{const n=Number.isSafeInteger(value)&&value>=0?BigInt(value):raw(value);return n!==null&&n<=BigInt(Number.MAX_SAFE_INTEGER)?n:null;};
const units=(value,places)=>{const s=value.toString().padStart(places+1,'0');return s.slice(0,-places)+'.'+s.slice(-places);};
export const inputPence=value=>{if(typeof value!=='string'||!/^\d{1,7}(\.\d{1,2})?$/.test(value))return null;const [a,b='']=value.split('.');return Number(BigInt(a)*100n+BigInt(b.padEnd(2,'0')));};
const fiat=s=>s&&knownCurrency(s.currency)&&typeof s.paymentAmount==='string'&&/^\d{1,12}(\.\d{1,2})?$/.test(s.paymentAmount)?`${s.paymentAmount} ${s.currency}`:null;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const sum=values=>values.length&&values.every(v=>raw(v)!==null)?values.reduce((n,v)=>n+raw(v),0n):null;
const statuses={
 awaiting_selection:'Choose an offer in Peer to see its payment amount and fees.',
 within_peer_limit:'This is a saved quote. Review the current amount, recipient and deadline in Peer before paying.',
 stale:'This saved quote is out of date. Review the current quote in Peer before paying.',
 quote_expired:'This quote has expired. Do not pay using its old details.',
 over_limit:'Peer’s recorded amount exceeds your request. Review the difference; do not send another payment to correct it.',
 settled_observation:'Peer has recorded a payment. Wallet arrival is checked separately.',
 settled_other_currency:'Peer recorded the payment in a different currency from your request.',
 paid_amount_changed:'Peer recorded a different amount from the earlier quote. Keep your payment confirmation; do not pay again.',
 multiple_attempts:'Peer has more than one payment attempt. Only amounts confirmed by Peer are included below.'
};
export function fundingCosts({requestedPence,currency='GBP',verification,simulated=false,testQuote,stopped=false,ended=false,review=false,trackingError=false,now=Date.now()}={}){
 const v=verification??{},candidate=v.payIn;
 const e=['peer-wise-gbp-v1','peer-revolut-gbp-v1','peer-fiat-v2'].includes(candidate?.schema)?candidate:null;
 let status=e?.status??'awaiting_selection';
 if(status==='within_peer_limit'){
  if(!date(e.expiresAt)||Date.parse(e.expiresAt)<=now)status='quote_expired';
  else if(!date(e.checkedAt)||now-Date.parse(e.checkedAt)>30000||Date.parse(e.checkedAt)>now+5000)status='stale';
 }
 const settled=Array.isArray(v.payments)?v.payments.filter(p=>p?.status==='SETTLED'):[];
 const ids=new Set(settled.map(p=>p.id));
 let net=sum(settled.map(p=>p.amountRaw)),fee=sum(settled.map(p=>p.feeRaw));
 const invalid=settled.some(p=>typeof p.id!=='string'||!p.id||raw(p.amountRaw)===null||raw(p.amountRaw)<=0n)||ids.size!==settled.length;
 let conflict=invalid||net!==null&&raw(v.expectedNetRaw)!==net;
 const single=e?.settlement;
 if(single&&settled.length===1&&(e.paymentId!==settled[0].id||raw(single.netUsdcRaw)!==net||raw(single.feeUsdcRaw)!==fee))conflict=true;
 if(conflict){net=null;fee=null;}
 const arrived=raw(v.receivedRaw),validArrival=!conflict&&net!==null&&arrived!==null&&arrived<=net;
 const requested=pence(requestedPence),quoted=e?.settlement?null:pence(e?.totalPence);
 // A single-payment fiat observation cannot stand in for a multi-payment total.
 const recorded=!conflict&&settled.length===1&&single?fiat(single):null;
 const example=!settled.length&&!stopped&&!ended&&!review&&!trackingError?exampleCostQuote(testQuote,{simulated,requestedPence,currency,now}):null;
 const estimate=e?.receiveEstimate;
 const estimateGross=raw(estimate?.grossUsdcRaw),estimateNet=raw(estimate?.netUsdcRaw),estimateFee=raw(estimate?.feeUsdcRaw);
 const quoteReady=!simulated&&!stopped&&!ended&&!review&&!trackingError&&!conflict&&!settled.length&&status==='within_peer_limit'&&e?.currency===currency&&quoted!==null&&quoted>0n&&requested!==null&&quoted<=requested&&typeof e?.paymentId==='string'&&!!e.paymentId&&typeof e.quoteFingerprint==='string'&&!!e.quoteFingerprint;
 const estimateReady=quoteReady&&estimate?.schema==='peer-standard-pro-net-v1'&&estimate.basis==='selected_offer_standard_pro'&&estimate.conditional===true&&estimate.feeBps===495&&/^[a-f0-9]{64}$/.test(estimate.feeConfigFingerprint??'')&&estimateGross!==null&&estimateNet!==null&&estimateFee!==null&&estimateNet>0n&&estimateGross-estimateFee===estimateNet&&estimateNet===estimateGross*9505n/10000n;
 const reviewPair=estimateReady?{kind:'estimate',pay:formatFiat(Number(quoted),currency),receive:`${units(estimateNet,6)} USDC`,fee:`${units(estimateFee,6)} USDC`}:!simulated&&!conflict&&settled.length===1&&recorded&&net!==null?{kind:'settled',pay:recorded,receive:`${units(net,6)} USDC`,fee:fee===null?null:`${units(fee,6)} USDC`,arrived:validArrival&&arrived===net}:null;
 const rows=[{label:'Requested funding',value:requested===null?`Enter a valid ${currency} amount`:formatFiat(Number(requested),currency),note:'The amount entered in Eupova.'}];
 if(example)rows.push({label:'Example converted amount',value:`${example.gross} USDC`,note:'Before the illustrative fee. The fee below is deducted, not charged again.'});
 else if(!settled.length)rows.push({label:`Last saved ${currency} offer`,value:quoted===null?'Not available yet':formatFiat(Number(quoted),e?.currency??currency),note:quoted===null?'Peer shows the payment amount when you select an offer.':'Saved from Peer. This is not proof of payment.'});
 else rows.push({label:'Payment recorded by Peer',value:recorded??'Not available',note:settled.length>1?'The total paid is not available for these payment attempts.':'Shown in the currency Peer recorded; bank or payment-app charges are separate.'});
 rows.push({label:settled.length?'Peer fee':'Estimated Peer fee',value:fee===null?example?`${example.fee} USDC`:'Not available yet':`${units(fee,6)} USDC`,note:example?'Illustrative fee deducted once from the example conversion.':settled.length?'Deducted from the USDC amount shown below.':'Review Peer’s fee in checkout before paying.'});
 rows.push({label:settled.length?'USDC after Peer fees':'Estimated USDC to your wallet',value:net===null?example?`${example.net} USDC`:'Not available yet':`${units(net,6)} USDC`,note:example?'Illustrative receipt on Base, after the example fee.':settled.length?'The amount after Peer’s fee and any recorded adjustments. Wallet arrival is checked separately.':'Eupova does not yet have a confirmed estimate after fees. The requested amount does not guarantee a USDC amount.'});
 if(settled.length)rows.push({label:'Confirmed wallet arrival',value:validArrival?`${units(arrived,6)} USDC`:'Not confirmed',note:'Matching transfers confirmed on Base; separate from the current wallet balance.'});
 rows.push({label:'Bank or payment-app fees',value:example?'Assumed zero for this example':'Not visible to Eupova',note:example?'An explicit demo assumption. Real payment-app charges are not known.':'Check your payment app for any extra charge and the total it will take from your account.'});
 rows.push({label:'Exchange rate and seller markup',value:example?`1 GBP = ${example.rate} USDC`:'Not separately confirmed',note:example?'Example conversion rate. No additional seller markup is modelled.':'A seller rate may include a markup. No independent reference rate or spread is available here.'});
 rows.push({label:'Other network or conversion costs',value:example?'No additional charge in this example':'Not separately confirmed',note:example?'The simulation has no bridge, token conversion or real network charge.':'Do not add these to the Peer fee unless the quote identifies a separate charge. No Tempo transfer is included.'});
 if(example)rows.push({label:'Example effective rate after fees',value:`1 GBP = ${example.effectiveRate} USDC`,note:'Rounded down to six decimal places. This is not a market rate.'});
 const allIn={label:example?'Example total debit':'Total debit from your payment account',value:example?formatFiat(example.totalMinor,currency):'Not confirmed',complete:!!example&&!example.expired,
  note:example?'Assumes no bank or payment-app fees. All figures are simulated; no money is taken.':'The offer amount excludes any unreported charges. Eupova cannot yet confirm an all-in total. Unknown costs are not zero.'};
 const adjustments=!conflict?settled.flatMap(p=>(Array.isArray(p.adjustments)?p.adjustments:[]).filter(a=>a.kind==='CROSS_CURRENCY'&&Number.isInteger(a.penaltyBps)&&a.penaltyBps>=0&&a.penaltyBps<=10000&&/^\d{1,9}\.\d{2}$/.test(a.originalAmount)&&/^\d{1,9}\.\d{2}$/.test(a.attestedAmount)&&knownCurrency(p.currency)).map(a=>`Peer applied a ${a.penaltyBps/100}% currency adjustment: ${a.originalAmount} ${p.currency} became ${a.attestedAmount} ${p.currency}.`)):[];
 const message=stopped?'This request was stopped in Eupova. Do not pay its old checkout. Saved amounts remain here for any late funds.':ended?'This request is closed. These saved figures are for your records; do not pay the old checkout.':review||conflict?'Payment details need review. Do not send another payment to resolve this status.':!e&&settled.length?'Peer has confirmed the USDC amount after fees. The amount paid is not available.':statuses[status]??'Payment details need review. Do not pay using unconfirmed details.';
 return {reviewPair,rows,message:example?(example.expired?'This example quote has expired. Get a new quote before continuing the test.':'Illustrative full-cost example. Review the assumptions below; this is not a live offer.'):message,status:example?(example.expired?'quote_expired':'example'):status,allIn,simulated,conflict,adjustments,checkedAt:date(e?.checkedAt??v.checkedAt),expiresAt:!settled.length?date(example?.expiresAt??e?.expiresAt):null,trackingUnavailable:!!trackingError};
}
