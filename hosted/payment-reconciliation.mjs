// Pure comparison of persisted evidence. No provider, RPC, clock or write access.
import {paymentRecord} from './payment-records.mjs';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const decimal=v=>typeof v==='string'&&/^\d{1,9}(\.\d{1,6})?$/.test(v)?BigInt(v.split('.')[0])*1000000n+BigInt((v.split('.')[1]??'').padEnd(6,'0')):null;
const raw=v=>typeof v==='string'&&/^\d{1,24}$/.test(v);
const receiptMatches=(a,b)=>!!a&&!!b&&['transactionHash','blockHash','tokenAddress','recipient'].every(k=>same(a[k],b[k]))&&a.chainId===b.chainId&&String(a.blockNumber)===String(b.blockNumber)&&a.amountRaw===b.amountRaw&&a.finalized===b.finalized;
export function reconcileSavedPayment(row,ledger,draft,now=Date.now()){
 const request=row.request??{},result=row.result??{},v=result.verification??{};
 const order={...request,...result,id:row.id,status:row.status,reviewRequired:row.review_required,createdAt:row.created_at};
 const record=paymentRecord(order,null,now),payments=Array.isArray(v.payments)?v.payments:[],settled=payments.filter(p=>p?.status==='SETTLED'),checks=[];
 const add=(code,label,status)=>checks.push({code,label,status});
 add('binding','Saved request and order',request.id===row.id&&request.merchantId===row.merchant_id&&request.providerOrderId===row.provider_id&&request.source==='live'&&request.agent?.network==='Base'&&request.agent?.token==='USDC'?'pass':'mismatch');
 const ids=new Set(),txs=new Set(),intents=new Set();
 const matching=settled.every(p=>{
  if(!p.id||ids.has(p.id)||!/^0x[0-9a-f]{64}$/i.test(p.transactionHash??'')||txs.has(p.transactionHash.toLowerCase())||!/^0x[0-9a-f]{64}$/i.test(p.intentHash??'')||intents.has(p.intentHash.toLowerCase())||!raw(p.amountRaw)||BigInt(p.amountRaw)<=0n)return false;
  ids.add(p.id);txs.add(p.transactionHash.toLowerCase());intents.add(p.intentHash.toLowerCase());
  const l=ledger.find(l=>l.payment_id===p.id);
  return l&&l.order_id===row.id&&l.merchant_id===row.merchant_id&&l.chain_id===8453&&same(l.token_address,record.tokenAddress)&&same(l.recipient,request.agent?.address)&&String(l.amount_raw)===p.amountRaw&&same(l.intent_hash,p.intentHash)&&same(l.transaction_hash,p.transactionHash)&&l.finalized===(p.deliveryStatus==='finalized')&&(!l.receipt&&!p.receipt||receiptMatches(l.receipt,p.receipt));
 });
 const ledgerMatches=matching&&ledger.length===settled.length;
 add('ledger','Settlement ledger and saved verification',!ledgerMatches?'mismatch':settled.length?'pass':'pending');
 const sumsValid=settled.every(p=>raw(p.amountRaw));
 const total=sumsValid?settled.reduce((n,p)=>n+BigInt(p.amountRaw),0n).toString():null;
 const arrived=sumsValid?settled.filter(p=>p.deliveryStatus==='finalized').reduce((n,p)=>n+BigInt(p.amountRaw),0n).toString():null;
 add('totals','Net settlement and arrival totals',!result.verification?'pending':total===v.expectedNetRaw&&arrived===v.receivedRaw?'pass':'mismatch');
 add('receipt','Complete wallet receipt',record.deliveryConfirmed?'pass':row.status==='checkout_received'?'mismatch':'pending');
 const draftMatches=draft&&draft.id===row.id&&draft.owner===row.owner&&draft.merchant_id===row.merchant_id&&draft.provider_id===row.provider_id&&same(draft.agent?.address,request.agent?.address)&&draft.agent_id===request.agent?.id&&draft.pence===request.quote?.pence&&draft.rail===request.quote?.platform&&decimal(draft.requested_usdc)!==null&&decimal(draft.requested_usdc)===decimal(request.requestedUsdcAmount);
 add('draft','Original funding request',!draft?'unavailable':draftMatches?'pass':'mismatch');
 add('closure','Funding request closed after delivery',!draft?'unavailable':record.deliveryConfirmed?(draft.status==='closed'?'pass':'pending'):'pending');
 add('holds','Disputes and review holds',record.chargeback||row.review_required||row.status==='checkout_review'?'attention':'pass');
 const status=checks.some(c=>c.status==='mismatch')?'inconsistent':checks.some(c=>c.status==='attention')?'attention':checks.every(c=>c.status==='pass')?'matched':'incomplete';
 return {savedOnly:true,status,checks,settledPayments:settled.length,ledgerPayments:ledger.length,deliveryConfirmed:record.deliveryConfirmed,checkedAt:record.checkedAt};
}
