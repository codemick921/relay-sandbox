import {paymentRecord} from './payment-records.mjs';
import {liveOrderView} from './live-store.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const wallet=(a,b)=>!!a&&!!b&&a.id===b.id&&same(a.address,b.address)&&a.network==='Base'&&b.network==='Base'&&a.token==='USDC'&&b.token==='USDC';
const positive=v=>typeof v==='string'&&/^[0-9]{1,24}$/.test(v)&&BigInt(v)>0n;
const hash=v=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
const empty=(state='not_started')=>({schema:'agent-progress-v1',state,paymentConfirmed:false,deliveryConfirmed:false,receivedUsdc:null,checkedAt:null,freshness:'unknown',attentionReason:null,nextAction:'review_in_eupova'});
const attention=(p,reason)=>({...p,state:'needs_attention',attentionReason:reason,nextAction:'review_in_eupova'});

// Projection of durable evidence only. It cannot create, refresh, stop or pay an order.
export function agentRequestProgress(request,draft,order,now=Date.now()){
 let p=empty(request.draft_id?'prepared':'not_started');
 if(!request.draft_id)return {...p,state:request.cancelled_at?'ended':new Date(request.expires_at).getTime()<=now?'ended':'not_started'};
 if(!draft||draft.id!==request.draft_id||draft.owner!==request.owner||String(draft.agent_revision)!==String(request.agent_revision)||!wallet(request.agent,draft.agent))return attention(p,'binding_mismatch');
 if(!order){
  if(draft.status==='draft')return p;
  if(draft.status==='cancelled'&&!draft.provider_id)return {...p,state:'ended'};
  return attention(p,'tracking_unavailable');
 }
 if(order.id!==draft.id||order.merchantId!==draft.merchant_id||order.providerOrderId!==draft.provider_id||!wallet(request.agent,order.agent)||order.quote?.pence!==draft.pence||order.quote?.currency!==(draft.currency??'GBP')||order.quote?.platform!==draft.rail||order.source!=='live'||order.fixture||order.verification?.environment!=='LIVE'||order.verification?.simulated)return attention(p,'binding_mismatch');
 const v=order.verification;
 const time=Date.parse(order.checkedAt??v.checkedAt);
 p={...p,checkedAt:Number.isFinite(time)?new Date(time).toISOString():null};
 if(!Number.isFinite(time)||time>now+5000)return attention(p,'tracking_unavailable');
 // Finalised orders are normally rechecked hourly; allow the existing five-minute scheduling grace.
 if(now-time>(order.status==='checkout_received'?3900000:900000))return attention({...p,freshness:'stale'},'stale_evidence');
 p.freshness='current';
 const record=paymentRecord(order,{...draft,stoppedAt:draft.stopped_at},now);
 if(record.chargeback||record.code==='review'||order.reviewRequired)return attention(p,'evidence_needs_review');
 if(order.trackingError||order.trackingPending===true||['overdue','retrying','stale','review'].includes(record.tracking?.code))return attention(p,'tracking_unavailable');
 const rows=Array.isArray(v.payments)?v.payments:[],settled=rows.filter(x=>x?.status==='SETTLED');
 const ids=new Set(),txs=new Set(),intents=new Set();
 const valid=settled.length>0&&settled.every(x=>{
  if(typeof x.id!=='string'||!x.id||ids.has(x.id)||!hash(x.transactionHash)||!hash(x.intentHash)||txs.has(x.transactionHash.toLowerCase())||intents.has(x.intentHash.toLowerCase())||!positive(x.amountRaw)||x.chargebackStatus!=='NONE')return false;
  ids.add(x.id);txs.add(x.transactionHash.toLowerCase());intents.add(x.intentHash.toLowerCase());return true;
 });
 const total=valid?settled.reduce((n,x)=>n+BigInt(x.amountRaw),0n).toString():null;
 const confirmed=valid&&v.expectedNetRaw===total&&v.providerFulfilled===true&&order.providerStatus==='FULFILLED'&&order.chargebackStatus==='NONE';
 if((settled.length&&!valid)||(v.providerFulfilled===true&&!confirmed))return attention(p,'evidence_needs_review');
 p.paymentConfirmed=confirmed;
 if(record.deliveryConfirmed&&confirmed&&!record.simulated){
  return {...p,state:'funds_arrived',deliveryConfirmed:true,receivedUsdc:record.confirmedUsdc,nextAction:'none'};
 }
 if(order.status==='checkout_received')return attention({...p,paymentConfirmed:false},'evidence_needs_review');
 if(settled.some(x=>x.payout?.status==='DISPUTED'||x.deliveryStatus==='reverted'))return attention({...p,paymentConfirmed:false},'evidence_needs_review');
 if(settled.some(x=>x.payout?.status==='HELD'||x.deliveryStatus==='held'))return attention(p,'payout_held');
 if(draft.stopped_at||record.attemptExpiry)return attention(p,draft.stopped_at?'request_stopped':'attempt_expired');
 if(order.status==='checkout_cancelled')return rows.length||confirmed?attention({...p,paymentConfirmed:false},'evidence_needs_review'):{...p,state:'ended'};
 if(confirmed)return {...p,state:order.status==='checkout_confirming'?'confirming':'payment_confirmed',nextAction:'wait_for_delivery'};
 return {...p,state:settled.length?'payment_pending':'awaiting_payment',nextAction:'review_in_eupova'};
}

export async function readAgentRequestProgress(base,request,{merchantId=null,now=Date.now()}={}){
 if(!request.draft_id)return agentRequestProgress(request,null,null,now);
 const draft=(await base.query('SELECT id,owner,agent,agent_revision,pence,currency,rail,status,merchant_id,provider_id,stopped_at FROM relay_funding_drafts WHERE owner=$1 AND id=$2',[request.owner,request.draft_id])).rows[0];
 if(!draft||!draft.provider_id||!merchantId)return agentRequestProgress(request,draft,null,now);
 if(draft.merchant_id!==merchantId)return attention(empty('prepared'),'binding_mismatch');
 // Exact immutable binding, including owner and the currently configured live merchant.
 const row=(await base.query('SELECT * FROM relay_live_orders WHERE owner=$1 AND id=$2 AND merchant_id=$3 AND provider_id=$4',[request.owner,draft.id,merchantId,draft.provider_id])).rows[0];
 return agentRequestProgress(request,draft,row?liveOrderView(row):null,now);
}
