// Presentation of saved evidence only. No quotes, authorisations or provider calls.
const raw=value=>typeof value==='string'&&/^\d{1,24}$/.test(value)?BigInt(value):null;
const pence=value=>Number.isSafeInteger(value)&&value>=0?BigInt(value):raw(value);
const units=(value,places)=>{const s=value.toString().padStart(places+1,'0');return s.slice(0,-places)+'.'+s.slice(-places);};
export const inputPence=value=>{if(typeof value!=='string'||!/^\d{1,7}(\.\d{1,2})?$/.test(value))return null;const [a,b='']=value.split('.');return Number(BigInt(a)*100n+BigInt(b.padEnd(2,'0')));};
const fiat=s=>s&&['GBP','USD','EUR'].includes(s.currency)&&typeof s.paymentAmount==='string'&&/^\d{1,12}(\.\d{1,2})?$/.test(s.paymentAmount)?`${s.paymentAmount} ${s.currency}`:null;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const sum=values=>values.length&&values.every(v=>raw(v)!==null)?values.reduce((n,v)=>n+raw(v),0n):null;
const statuses={
 awaiting_selection:'Choose an offer in Peer to see its payment amount and fees.',
 within_peer_limit:'This is a saved quote. Review the current amount, recipient and deadline in Peer before paying.',
 stale:'This saved quote is out of date. Review the current quote in Peer before paying.',
 quote_expired:'This quote has expired. Do not pay using its old details.',
 over_limit:'Peer’s recorded amount exceeds your request. Review the difference; do not send another payment to correct it.',
 settled_observation:'Peer has recorded a payment. Wallet arrival is checked separately.',
 settled_other_currency:'Peer recorded the payment in a different currency from your GBP request.',
 paid_amount_changed:'Peer recorded a different amount from the earlier quote. Keep your payment confirmation; do not pay again.',
 multiple_attempts:'Peer has more than one payment attempt. Only amounts confirmed by Peer are included below.'
};
export function fundingCosts({requestedPence,verification,simulated=false,stopped=false,ended=false,review=false,trackingError=false,now=Date.now()}={}){
 const v=verification??{},candidate=v.payIn;
 const e=['peer-wise-gbp-v1','peer-revolut-gbp-v1'].includes(candidate?.schema)?candidate:null;
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
 const rows=[{label:'Requested funding',value:requested===null?'Enter a valid GBP amount':`£${units(requested,2)}`,note:'The amount entered in Eupova.'}];
 if(!settled.length)rows.push({label:'Last saved GBP offer',value:quoted===null?'Not available yet':`£${units(quoted,2)}`,note:quoted===null?'Peer shows the payment amount when you select an offer.':'Saved from Peer. This is not proof of payment.'});
 else rows.push({label:'Payment recorded by Peer',value:recorded??'Not available',note:settled.length>1?'The total paid is not available for these payment attempts.':'Shown in the currency Peer recorded; bank or payment-app charges are separate.'});
 rows.push({label:settled.length?'Peer fee':'Estimated Peer fee',value:fee===null?'Not available yet':`${units(fee,6)} USDC`,note:settled.length?'Deducted from the USDC amount shown below.':'Review Peer’s fee in checkout before paying.'});
 rows.push({label:settled.length?'USDC after Peer fees':'Estimated USDC to your wallet',value:net===null?'Not available yet':`${units(net,6)} USDC`,note:settled.length?'The amount after Peer’s fee and any recorded adjustments. Wallet arrival is checked separately.':'Eupova does not yet have a confirmed estimate after fees. The GBP request does not guarantee a USDC amount.'});
 if(settled.length)rows.push({label:'Confirmed wallet arrival',value:validArrival?`${units(arrived,6)} USDC`:'Not confirmed',note:'Matching transfers confirmed on Base; separate from the current wallet balance.'});
 rows.push({label:'Bank or payment-app fees',value:'Not visible to Eupova',note:'Check your payment app for any extra charge and the total it will take from your account.'});
 const adjustments=!conflict?settled.flatMap(p=>(Array.isArray(p.adjustments)?p.adjustments:[]).filter(a=>a.kind==='CROSS_CURRENCY'&&Number.isInteger(a.penaltyBps)&&a.penaltyBps>=0&&a.penaltyBps<=10000&&/^\d{1,9}\.\d{2}$/.test(a.originalAmount)&&/^\d{1,9}\.\d{2}$/.test(a.attestedAmount)&&['GBP','USD','EUR'].includes(p.currency)).map(a=>`Peer applied a ${a.penaltyBps/100}% currency adjustment: ${a.originalAmount} ${p.currency} became ${a.attestedAmount} ${p.currency}.`)):[];
 const message=stopped?'This request was stopped in Eupova. Do not pay its old checkout. Saved amounts remain here for any late funds.':ended?'This request is closed. These saved figures are for your records; do not pay the old checkout.':review||conflict?'Payment details need review. Do not send another payment to resolve this status.':!e&&settled.length?'Peer has confirmed the USDC amount after fees. The amount paid is not available.':statuses[status]??'Payment details need review. Do not pay using unconfirmed details.';
 return {rows,message,status,simulated,conflict,adjustments,checkedAt:date(e?.checkedAt??v.checkedAt),expiresAt:!settled.length?date(e?.expiresAt):null,trackingUnavailable:!!trackingError};
}
