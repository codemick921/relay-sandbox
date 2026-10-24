// Read-only, allowlisted customer records. No provider calls or payment mutations.
const TOKEN='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const raw=v=>typeof v==='string'&&/^\d{1,24}$/.test(v)?v:null;
const date=v=>(typeof v==='string'||v instanceof Date)&&Number.isFinite(new Date(v).getTime())?new Date(v).toISOString():null;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const text=(v,max=160)=>typeof v==='string'?v.slice(0,max):null;
export const units=(value,decimals=6)=>{if(raw(value)===null)return null;const s=BigInt(value).toString().padStart(decimals+1,'0');return s.slice(0,-decimals)+'.'+s.slice(-decimals);};
const sum=values=>values.length&&values.every(v=>raw(v)!==null)?values.reduce((a,v)=>a+BigInt(v),0n).toString():null;
function evidence(order){
 const v=order.verification??{},payments=Array.isArray(v.payments)?v.payments.filter(p=>p.status==='SETTLED'):[];
 const seen=new Set();const receipts=[];let valid=payments.length>0;
 for(const p of payments){const r=p.receipt;
  if(!r)continue;
  const key=String(r.transactionHash).toLowerCase();
  if(r.chainId!==8453||!same(r.tokenAddress,TOKEN)||!same(r.recipient,order.agent?.address)||!/^0x[0-9a-f]{64}$/i.test(r.transactionHash??'')||!same(r.transactionHash,p.transactionHash)||raw(r.amountRaw)===null||r.amountRaw!==p.amountRaw||seen.has(key)||!/^0x[0-9a-f]{64}$/i.test(r.blockHash??'')||raw(String(r.blockNumber))===null){valid=false;continue;}
  seen.add(key);
  if(r.finalized===true&&p.deliveryStatus==='finalized')receipts.push({transactionHash:r.transactionHash,blockNumber:String(r.blockNumber),blockHash:r.blockHash,amountUsdc:units(r.amountRaw)});
 }
 const expected=sum(payments.map(p=>p.amountRaw));
 const confirmed=sum(payments.filter(p=>receipts.some(r=>same(r.transactionHash,p.transactionHash))).map(p=>p.amountRaw));
 const complete=valid&&order.status==='checkout_received'&&!order.reviewRequired&&v.providerFulfilled===true&&receipts.length===payments.length&&expected===v.expectedNetRaw&&confirmed===v.receivedRaw&&order.delivery?.finalized===true&&order.delivery.chainId===8453&&same(order.delivery.tokenAddress,TOKEN)&&same(order.delivery.recipient,order.agent?.address)&&order.delivery.amountRaw===confirmed;
 return {complete,receipts:valid?receipts:[],net:units(expected),confirmed:valid?units(confirmed):null,fee:units(sum(payments.map(p=>p.feeRaw)))};
}
export function paymentRecord(order,draft,now=Date.now()){
 const o=order??{},d=draft??{},v=o.verification??{},e=evidence(o),simulated=!!o.fixture||!!v.simulated||['fixture','simulation','practice','sandbox'].includes(o.source)||o.kind==='ramp';
 const stopped=!!(o.stoppedInRelay||d.stoppedAt),chargeback=typeof o.chargebackStatus==='string'&&!['NONE',''].includes(o.chargebackStatus);
 let code='awaiting',title='Waiting for payment verification',next='Open your existing request to review its current instructions. If you have already paid, do not pay again; keep your bank confirmation while Relay checks the payment.';
 if(!order&&d.status==='draft'){code='draft';title='Saved draft';next='Nothing has been sent to Peer for this draft. Review the amount and saved wallet in your existing request before continuing.';}
 if(['checkout_unknown','checkout_recovery'].includes(o.status)||(!order&&!['draft','cancelled','closed'].includes(d.status))){code='uncertain';title='Checkout needs recovery';next='Open the existing request to recover its checkout. Do not create or pay a duplicate while the first attempt is uncertain.';}
 if(o.status==='checkout_partial'){code='partial';title='Part payment recorded';next='Review the existing request and the amount still outstanding. Do not repeat the original payment; a full wallet receipt is not yet available.';}
 if(o.status==='checkout_settled'){code='settled';title=v.providerFulfilled?'Payment verified · checking wallet':'Payment transfer being checked';next=v.providerFulfilled?'Relay is checking the USDC transfer to this request’s saved address. Keep your payment confirmation; no further bank payment is needed.':'Relay is checking a transfer for this request. The full payment has not been confirmed. Keep your bank confirmation and do not send a duplicate while this check is pending.';}
 if(o.status==='checkout_confirming'){code='confirming';title='Transfer detected · awaiting finality';next=v.providerFulfilled?'Relay is waiting for the matching Base transfer to become final. No further bank payment is needed.':'Relay is waiting for a matching Base transfer to become final. The full payment has not been confirmed. Do not send a duplicate while this check is pending.';}
 if(stopped){code='stopped';title='Stopped in Relay · watching for late funds';next='Do not pay the old checkout. Stopping in Relay does not cancel Peer’s order. Relay keeps checking for late funds; check your bank history before funding again.';}
 if(o.status==='checkout_cancelled'||!order&&['cancelled','closed'].includes(d.status)){code='ended';title=order?'Peer checkout cancelled':'Draft closed';next='Review your bank history before starting another request. If you sent money or a transfer is pending, keep the confirmation and follow this request instead of paying again.';}
 if(o.reviewRequired||o.status==='checkout_review'||o.status==='checkout_received'&&!e.complete){code='review';title='Payment evidence needs review';next='Do not send another payment to resolve this status. Keep your bank confirmation and request ID. Relay has not confirmed a complete wallet receipt for this request.';}
 if(e.complete){code='received';title=simulated?'Simulated wallet delivery confirmed':'Funds arrived in the agent wallet';next='You can download the wallet delivery receipt below. It records this transfer and does not show the wallet’s current balance.';}
 if(chargeback){code='disputed';title='Payment dispute recorded';next='A chargeback or dispute is recorded for this payment. Any confirmed wallet arrival is historical evidence, not proof that the dispute is resolved. Do not pay again to clear this status.';}
 const checkedAt=date(o.checkedAt??v.checkedAt),stale=!!checkedAt&&now-Date.parse(checkedAt)>15*60*1000;
 const settlement=v.payIn?.settlement;
 const paid=settlement&&['GBP','USD','EUR'].includes(settlement.currency)&&typeof settlement.paymentAmount==='string'&&/^\d{1,12}(\.\d{1,2})?$/.test(settlement.paymentAmount)?`${settlement.paymentAmount} ${settlement.currency}`:null;
 const amount=o.quote?.pence??d.pence;
 return {id:o.id??d.id,provider:'Peer',providerOrderId:text(o.providerOrderId),agentName:text(o.agent?.name??d.agent?.name,60)??'Agent wallet',address:text(o.agent?.address??d.agent?.address,42),network:'Base',token:'USDC',tokenAddress:TOKEN,
  createdAt:date(o.createdAt??d.createdAt),checkedAt,generatedAt:new Date(now).toISOString(),stale,trackingUnavailable:!!o.trackingError,simulated,stopped,chargeback,code,title,next,
  document:e.complete?'receipt':'summary',requestedGbp:Number.isSafeInteger(amount)&&amount>=0?units(String(amount),2):null,recordedFiat:paid,netUsdc:e.net,confirmedUsdc:e.confirmed,peerFeeUsdc:e.fee,receipts:e.receipts,
  hasOrder:!!order,hasDraft:!!draft,providerFulfilled:v.providerFulfilled===true,deliveryConfirmed:e.complete};
}
export function paymentRecords(state,now=Date.now()){
 const drafts=new Map((state.fundingDrafts??[]).map(d=>[d.id,d])),seen=new Set(),out=[];
 for(const o of state.orders??[]){if(!uuid(o.id)||o.kind!=='checkout'||seen.has(o.id))continue;seen.add(o.id);out.push(paymentRecord(o,drafts.get(o.id),now));}
 for(const d of drafts.values())if(uuid(d.id)&&!seen.has(d.id))out.push(paymentRecord(null,d,now));
 return out.sort((a,b)=>(b.createdAt??'').localeCompare(a.createdAt??''));
}
export function recordRows(r){return [
 ['Document',`${r.simulated?'SIMULATED · ':''}${r.document==='receipt'?'Wallet delivery receipt':'Funding status summary'}`],['Request ID',r.id],['Peer order ID',r.providerOrderId],['Status',r.title],['Next step',r.next],['Agent',r.agentName],['Receiving address',r.address],['Network',r.network],['Token','USDC'],['Token contract',r.tokenAddress],['Requested amount (GBP)',r.requestedGbp],['Fiat payment recorded by Peer',r.recordedFiat],['Net settled (USDC)',r.netUsdc],['Arrival confirmed (USDC)',r.confirmedUsdc],['Peer fees (USDC)',r.peerFeeUsdc],['Other fees','Bank/payment-app fees and exchange-rate spread are not included.'],['Stopped in Relay',r.stopped?'Yes · does not cancel Peer’s order':'No'],['Dispute recorded',r.chargeback?'Yes':'No'],['Created',r.createdAt],['Last successful check',r.checkedAt],['Tracking freshness',r.trackingUnavailable?'Latest check unavailable':r.stale?'Saved check is over 15 minutes old':'See last successful check'],['Downloaded',r.generatedAt],...r.receipts.flatMap((x,i)=>[[`Transfer ${i+1}`,x.transactionHash],[`Transfer ${i+1} USDC`,x.amountUsdc],[`Transfer ${i+1} Base block`,x.blockNumber]]),['Note',r.simulated?'Simulation only. No real payment or wallet arrival is confirmed.':'This is a saved funding record, not a bank receipt, tax invoice or current wallet balance.']
 ].map(([key,value])=>[key,value??'Not available']);}
const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderRecord(r,format){
 const rows=recordRows(r);
 if(format==='csv')return '\ufeff'+[['Field','Value'],...rows].map(row=>row.map(v=>'"'+(/^[\s]*[=+\-@]/.test(String(v))?"'":'')+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
 return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Relay '+escape(rows[0][1])+'</title><style>body{font:16px/1.6 system-ui;color:#17271f;max-width:850px;margin:32px auto;padding:0 20px}h1{line-height:1.2}table{border-collapse:collapse;width:100%}th,td{padding:12px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{width:35%}@media print{body{margin:0;font-size:11pt}tr{break-inside:avoid}}</style><h1>Relay · '+escape(rows[0][1])+'</h1><p>Save this file for your records. Open it in a browser to print or save as PDF.</p><table>'+rows.slice(1).map(([k,v])=>'<tr><th>'+escape(k)+'</th><td>'+escape(v)+'</td></tr>').join('')+'</table></html>';
}
