import {validateAgentRequest} from './agent-funding-requests.mjs';
import {hasRecordedPayment} from '../shared/paid-request.mjs';
import {fundingCompatibility} from '../shared/funding-compatibility.mjs';
import {paymentAttemptState} from '../shared/tracking-status.mjs';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {InputError,address,pence} from '../server/validation.mjs';
import {microUsdc} from '../server/pay-delivery.mjs';
import {fundingPence} from '../server/funding-amount.mjs';
export const fundingDisabled=Object.freeze({paymentsEnabled:false,draftsEnabled:true,currency:'GBP',rail:'wise',network:'Base',token:'USDC',extensionFreeVerified:false});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const customer=owner=>{if(!/^customer:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner))throw new InputError('Customer sign-in required.',403);};
const fields=(input,names)=>{if(!input||Object.keys(input).some(k=>!names.includes(k)))throw new InputError('Unsupported funding details.');};
const snapshot=a=>{if(!a||a.network!=='Base'||a.token!=='USDC'||!uuid(a.id)||typeof a.name!=='string'||!a.name.trim()||a.name.length>60)throw new InputError('Choose a saved Base USDC wallet.');return {id:a.id,name:a.name,address:address(a.address).toLowerCase(),network:'Base',token:'USDC'};};
const matches=(a,b)=>JSON.stringify(snapshot(a))===JSON.stringify(snapshot(b));
export const fundingIntent=row=>({id:row.id,kind:'checkout',source:'live',merchantId:row.merchant_id,agent:row.agent,quote:{pence:row.pence,currency:row.currency??'GBP',platform:row.rail??'wise',network:'Base',token:'USDC'}});
export function createFundingDrafts(base,{clock=Date.now}={}){
 async function owned(c,owner,id){customer(owner);if(!uuid(id))throw new InputError('Draft not found.',404);const r=(await c.query('SELECT * FROM relay_funding_drafts WHERE id=$1 AND owner=$2 FOR UPDATE',[id,owner])).rows[0];if(!r)throw new InputError('Draft not found.',404);return r;}
 const lock=(c,owner)=>c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['funding:'+owner]);
 const audit=(c,id,event)=>c.query('INSERT INTO relay_funding_audit(draft_id,event) VALUES($1,$2)',[id,event]);
 return {
  async migrate(){await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431929)');await c.query(readFileSync(new URL('./funding-drafts.sql',import.meta.url),'utf8'));await c.query(readFileSync(new URL('./agent-funding-requests.sql',import.meta.url),'utf8'));});},
  async list(owner){customer(owner);const r=await base.query('SELECT d.id,d.tracking_only_at,d.stopped_at,d.cancellation_requested_at,d.cancellation_state,d.superseded_by,d.rail,d.currency,d.agent,d.pence,d.status,d.created_at,d.agent_revision,a.funding_revision AS current_revision,a.data AS current_agent FROM relay_funding_drafts d LEFT JOIN relay_agents a ON a.id=d.agent_id AND a.owner=d.owner WHERE d.owner=$1 ORDER BY d.created_at DESC LIMIT 100',[owner]);return r.rows.map(d=>({id:d.id,trackingOnlyAt:d.tracking_only_at,stoppedAt:d.stopped_at,cancellationRequestedAt:d.cancellation_requested_at,cancellationState:d.cancellation_state,supersededBy:d.superseded_by,rail:d.rail,currency:d.currency??'GBP',agent:d.agent,pence:d.pence,status:d.status,createdAt:d.created_at,walletCurrent:String(d.agent_revision)===String(d.current_revision)&&!!d.current_agent&&matches(d.agent,d.current_agent),source:'draft'}));},
  async prepare(owner,input){customer(owner);fields(input,['agentId','requestId','amount','confirm','rail','currency','targetAsset','route','fundingRequestId']);if(!uuid(input.agentId)||!uuid(input.requestId)||input.confirm!==true)throw new InputError('Check your amount and saved wallet before saving.');const rail=input.rail??'wise',currency=input.currency===undefined?'GBP':input.currency,amount=fundingPence(input.amount,rail,currency);
   if((input.targetAsset===undefined?'base-usdc':input.targetAsset)!=='base-usdc'||(input.route===undefined?'merchant':input.route)!=='merchant')throw new InputError('This destination or funding route is not connected. No draft was created.');
   return base.tx(async c=>{await lock(c,owner);
    const old=(await c.query('SELECT * FROM relay_funding_drafts WHERE owner=$1 AND request_id=$2',[owner,input.requestId])).rows[0];
    if(old){const linked=(await c.query('SELECT id FROM relay_agent_funding_requests WHERE owner=$1 AND draft_id=$2',[owner,old.id])).rows[0];if((linked?.id??null)!==(input.fundingRequestId??null))throw new InputError('This draft belongs to another funding request.',409);if(old.agent_id!==input.agentId||old.pence!==amount||old.rail!==rail||old.currency!==currency)throw new InputError('This request belongs to another funding draft.',409);return {id:old.id};}
    const a=(await c.query('SELECT data,funding_revision FROM relay_agents WHERE owner=$1 AND id=$2 FOR SHARE',[owner,input.agentId])).rows[0];if(!a)throw new InputError('Choose a saved Base USDC wallet.');
    if(input.fundingRequestId!==undefined)await validateAgentRequest(c,owner,input.fundingRequestId,a.data,a.funding_revision,clock());
    if(!fundingCompatibility({agent:a.data,rail,currency,amountMinor:amount,targetAsset:input.targetAsset,route:input.route}).canSaveDraft)throw new InputError('The funding details do not match a connected wallet and route.');
    if((await c.query("SELECT 1 FROM relay_funding_drafts WHERE owner=$1 AND status NOT IN ('cancelled','closed') AND superseded_by IS NULL AND stopped_at IS NULL AND tracking_only_at IS NULL",[owner])).rows.length)throw new InputError('Review your existing funding draft before starting another.',409);
    if(Number((await c.query('SELECT count(*) FROM relay_funding_drafts WHERE owner=$1',[owner])).rows[0].count)>=100)throw new InputError('Funding draft limit reached.',409);
    const id=randomUUID();await c.query('INSERT INTO relay_funding_drafts(id,owner,request_id,agent_id,agent,pence,agent_revision,rail,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,owner,input.requestId,input.agentId,snapshot(a.data),amount,a.funding_revision,rail,currency]);if(input.fundingRequestId!==undefined)await c.query('UPDATE relay_agent_funding_requests SET draft_id=$3 WHERE owner=$1 AND id=$2',[owner,input.fundingRequestId,id]);await audit(c,id,'draft_saved');return {id};
   });
  },
  async cancel(owner,input){fields(input,['id']);return base.tx(async c=>{await lock(c,owner);const row=await owned(c,owner,input.id);if(row.status==='cancelled')return {id:row.id};if(row.status!=='draft')throw new InputError('This request has been attempted. Keep it for reconciliation.',409);await c.query("UPDATE relay_funding_drafts SET status='cancelled',updated_at=now() WHERE id=$1",[row.id]);await audit(c,row.id,'draft_cancelled');return {id:row.id};});},
  review:(owner,id)=>base.tx(c=>owned(c,owner,id)),
  // These methods are server-only. The deployed HTTP server exposes prepare/cancel/list only.
  async claim(owner,id,merchantId,{guard}={}){if(!/^[-a-zA-Z0-9_]{1,128}$/.test(merchantId??''))throw Error('Pin the live merchant.');return base.tx(async c=>{await lock(c,owner);const row=await owned(c,owner,id);if(row.stopped_at)throw new InputError('This request was stopped in Eupova. Create a new request.',409);if(row.status!=='draft')return null;
   const requested=(await c.query('SELECT expires_at FROM relay_agent_funding_requests WHERE owner=$1 AND draft_id=$2 FOR UPDATE',[owner,id])).rows[0];if(requested&&new Date(requested.expires_at).getTime()<=clock())throw new InputError('The agent funding request expired. Cancel this unsubmitted draft and review a new request.',409);
   const a=(await c.query('SELECT data,funding_revision FROM relay_agents WHERE owner=$1 AND id=$2 FOR SHARE',[owner,row.agent_id])).rows[0];if(!a||String(a.funding_revision)!==String(row.agent_revision)||!matches(row.agent,a.data))throw new InputError('The saved wallet has changed. Cancel this draft and review a new one.',409);
   if(guard)await guard(c,row,merchantId);
   const claim=(await c.query("UPDATE relay_funding_drafts SET status='creating',merchant_id=$2,attempt_token=$3,attempted_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[id,merchantId,randomUUID()])).rows[0];await audit(c,id,'creation_claimed');return claim;
  });},
  async unresolved(claim){await base.tx(async c=>{const r=await c.query("UPDATE relay_funding_drafts SET status='unresolved',updated_at=now() WHERE id=$1 AND attempt_token=$2 AND status='creating' RETURNING id",[claim.id,claim.attempt_token]);if(r.rows.length)await audit(c,claim.id,'creation_unresolved');});},
  async recoverStalled(){await base.tx(async c=>{const rows=await c.query("UPDATE relay_funding_drafts SET status='unresolved',updated_at=now() WHERE status='creating' AND attempted_at<$1 RETURNING id",[new Date(clock()-60000)]);for(const r of rows.rows)await audit(c,r.id,'creation_interrupted');});
   // Recover a process interruption between tracking commit and draft update.
   const ready=await base.query(`SELECT d.id FROM relay_funding_drafts d JOIN relay_live_orders o ON o.id=d.id WHERE d.status='bound' AND (o.status IN ('checkout_received','checkout_cancelled') OR (d.cancellation_state='requested' AND (o.review_required OR jsonb_array_length(o.result->'verification'->'payments')>0))) ORDER BY d.created_at LIMIT 100`);
   for(const row of ready.rows)await this.closeVerified(row.id);
  },
  async attempted(owner,id){return base.tx(async c=>{const row=await owned(c,owner,id);if(!row.attempt_token||!['creating','unresolved','bound'].includes(row.status))throw new InputError('No attempted checkout to reconcile.',409);return row;});},
  async bind(claim,result,tracker,{reconciliation=false}={}){return base.tx(async c=>{
   const row=await owned(c,claim.owner,claim.id);if(row.attempt_token!==claim.attempt_token||row.merchant_id!==result.merchantId)throw new InputError('Funding attempt changed.',409);
   if(row.status==='bound'){if(row.provider_id!==result.providerOrderId||row.requested_usdc!==result.requestedUsdcAmount)throw new InputError('Funding binding differs.',409);return {id:row.id};}
   if(!['creating','unresolved'].includes(row.status))throw new InputError('Funding cannot be bound.',409);
   // A response after the timeout becomes a reconciliation case, never a silent success.
   if(!reconciliation&&(row.status==='unresolved'||new Date(row.attempted_at).getTime()<clock()-60000)){await c.query("UPDATE relay_funding_drafts SET status='unresolved',candidate_provider_id=$2,updated_at=now() WHERE id=$1",[row.id,/^[-a-zA-Z0-9_]{1,128}$/.test(result.providerOrderId??'')?result.providerOrderId:null]);await audit(c,row.id,'late_response_withheld');return {id:row.id,unresolved:true};}
   await tracker.bindTrustedOrder(row.owner,{...fundingIntent(row),providerOrderId:result.providerOrderId,requestedUsdcAmount:result.requestedUsdcAmount},{client:c});
   await c.query("UPDATE relay_funding_drafts SET status='bound',provider_id=$2,requested_usdc=$3,checkout_url=$4,updated_at=now() WHERE id=$1",[row.id,result.providerOrderId,result.requestedUsdcAmount,result.checkoutUrl??null]);await audit(c,row.id,reconciliation?'reconciled_and_bound':'checkout_bound');return {id:row.id};
  });},
  // Called only after the durable tracker accepts fresh authoritative evidence.
  async closeVerified(id){await base.tx(async c=>{
   const row=(await c.query('SELECT owner FROM relay_funding_drafts WHERE id=$1',[id])).rows[0];if(!row)return;
   await lock(c,row.owner);
   const r=await c.query(`UPDATE relay_funding_drafts d SET status=CASE WHEN o.status='checkout_cancelled' THEN 'cancelled' ELSE 'closed' END,
    cancellation_state=CASE WHEN o.status='checkout_cancelled' THEN 'confirmed' WHEN d.cancellation_requested_at IS NOT NULL THEN 'blocked' ELSE d.cancellation_state END,
    checkout_url=NULL,updated_at=now() FROM relay_live_orders o WHERE d.id=$1 AND o.id=d.id AND d.owner=o.owner AND d.merchant_id=o.merchant_id AND d.provider_id=o.provider_id AND d.status='bound' AND NOT o.review_required AND o.result->>'trackingError' IS NULL AND (
     (o.status='checkout_received' AND o.result->'delivery'->>'finalized'='true') OR
     (o.status='checkout_cancelled' AND o.result->>'providerStatus'='CANCELLED' AND o.result->>'chargebackStatus'='NONE' AND o.result->'verification'->'payments'='[]'::jsonb AND (o.result->'verification'->>'providerRemainingRaw')::numeric=d.requested_usdc::numeric*1000000)) RETURNING d.id,d.status`,[id]);
   for(const d of r.rows)await audit(c,id,d.status==='cancelled'?'peer_cancellation_confirmed':'delivery_verified');
   const blocked=await c.query(`UPDATE relay_funding_drafts d SET cancellation_state='blocked',updated_at=now() FROM relay_live_orders o WHERE d.id=$1 AND o.id=d.id AND d.owner=o.owner AND d.merchant_id=o.merchant_id AND d.provider_id=o.provider_id AND d.cancellation_state='requested' AND (o.review_required OR o.result->>'providerStatus' IN ('PARTIALLY_FULFILLED','FULFILLED') OR jsonb_array_length(o.result->'verification'->'payments')>0) RETURNING d.id`,[id]);
   if(blocked.rows.length)await audit(c,id,'cancellation_blocked_by_payment');
  });},
  // Releases only the local drafting slot. Never mutates the payment or tracker.
  async trackSeparately(owner,input){
   fields(input,['id','confirmSeparate']);
   if(input.confirmSeparate!==true)throw new InputError('Confirm this is a separate funding request, not a replacement payment.');
   return base.tx(async c=>{
    await lock(c,owner);const row=await owned(c,owner,input.id);
    if(row.tracking_only_at||row.status==='closed')return {id:row.id};
    if(row.status!=='bound'||row.stopped_at||row.superseded_by)throw new InputError('This request is not available for separate tracking.',409);
    const tracked=(await c.query('SELECT * FROM relay_live_orders WHERE id=$1 AND owner=$2 AND merchant_id=$3 AND provider_id=$4 FOR UPDATE',[row.id,owner,row.merchant_id,row.provider_id])).rows[0];
    if(!tracked||!hasRecordedPayment(tracked.result))throw new InputError('Payment has not been recorded in full yet. Keep tracking this request; if you have not paid, use Stop request.',409);
    const settled=tracked.result.verification.payments.filter(p=>p.status==='SETTLED');
    const receipts=(await c.query('SELECT * FROM relay_live_payments WHERE order_id=$1 AND merchant_id=$2',[row.id,row.merchant_id])).rows;
    if(!settled.every(p=>receipts.some(s=>s.payment_id===p.id&&s.amount_raw.toString()===p.amountRaw&&s.intent_hash===p.intentHash?.toLowerCase()&&s.transaction_hash===p.transactionHash?.toLowerCase()&&s.recipient===row.agent.address.toLowerCase())))throw new InputError('Saved payment evidence is incomplete. Keep tracking this request.',409);
    await c.query('UPDATE relay_funding_drafts SET tracking_only_at=now(),updated_at=now() WHERE id=$1',[row.id]);
    await audit(c,row.id,'paid_request_kept_tracking_customer_started_separately');
    return {id:row.id};
   });
  },
  async stop(owner,id,checked,generation){return base.tx(async c=>{
   await lock(c,owner);const row=await owned(c,owner,id);
   if(row.stopped_at)return {id};
   if(row.status!=='bound'||row.superseded_by)throw new InputError('This request must be reconciled before it can be stopped.',409);
   const tracked=(await c.query('SELECT * FROM relay_live_orders WHERE id=$1 AND owner=$2 AND merchant_id=$3 AND provider_id=$4 FOR UPDATE',[id,owner,row.merchant_id,row.provider_id])).rows[0];
   const unpaid=x=>x?.status==='checkout_ready'&&x?.chargebackStatus==='NONE'&&x.verification?.expectedNetRaw==='0'&&x.verification?.receivedRaw==='0'&&x.verification?.providerRemainingRaw===String(microUsdc(row.requested_usdc))&&Array.isArray(x.verification.payments)&&x.verification.payments.every(p=>['CREATED','EXPIRED','FAILED','CANCELLED'].includes(p.status)&&p.chargebackStatus==='NONE');
   if(!tracked||tracked.review_required||tracked.status!=='checkout_ready'||tracked.result?.delivery||(tracked.result.verification?.payments??[]).some(p=>p.status==='SETTLED')||!unpaid(checked)||checked.providerStatus!=='CREATED'||!Number.isFinite(Date.parse(checked.checkedAt))||Math.abs(clock()-Date.parse(checked.checkedAt))>60000)throw new InputError('Payment may already be in progress or received. Keep tracking this order before starting another.',409);
   if(String(tracked.generation)!==String(generation)){const e=new InputError('Payment tracking changed during this check. Please try again.',409);e.code='TRACKING_GENERATION_CHANGED';throw e;}
   if((await c.query('SELECT 1 FROM relay_live_payments WHERE order_id=$1',[id])).rows.length)throw new InputError('A payment is already linked to this order. Keep tracking it.',409);
   await c.query("UPDATE relay_funding_drafts SET stopped_at=now(),updated_at=now() WHERE id=$1",[id]);
   await audit(c,id,'stopped_locally_customer_confirmed_no_payment');return {id};
  });},
  async requestCancellation(owner,id,checked){return base.tx(async c=>{
   await lock(c,owner);const row=await owned(c,owner,id);
   if(row.status==='cancelled')return {id};
   if(row.status!=='bound'||row.superseded_by||row.stopped_at)throw new InputError('Only an existing, unresolved checkout can be reviewed for cancellation.',409);
   const tracked=(await c.query('SELECT * FROM relay_live_orders WHERE id=$1 AND owner=$2 AND merchant_id=$3 AND provider_id=$4 FOR UPDATE',[id,owner,row.merchant_id,row.provider_id])).rows[0];
   if(!tracked||tracked.review_required||tracked.status!=='checkout_ready'||(tracked.result.verification?.payments?.length??0)>0||!checked||checked.providerStatus!=='CREATED'||checked.status!=='checkout_ready'||checked.chargebackStatus!=='NONE'||checked.verification?.payments?.length!==0||Math.abs(clock()-Date.parse(checked.checkedAt))>60000||!Number.isFinite(Date.parse(checked.checkedAt)))throw new InputError('Peer cannot cancel an order that has a payment attempt. Keep tracking this request; do not pay a replacement.',409);
   if(!row.cancellation_requested_at){await c.query("UPDATE relay_funding_drafts SET cancellation_requested_at=now(),cancellation_state='requested',updated_at=now() WHERE id=$1",[id]);await audit(c,id,'cancellation_requested');}
   return {id};
  });},
  async cancellationQueue(){const r=await base.query(`SELECT d.id,d.tracking_only_at,d.stopped_at,d.provider_id,d.pence,d.rail,d.currency,d.cancellation_requested_at,d.cancellation_state,o.status,o.review_required,o.result->>'checkedAt' AS checked_at FROM relay_funding_drafts d JOIN relay_live_orders o ON o.id=d.id AND o.owner=d.owner AND o.merchant_id=d.merchant_id AND o.provider_id=d.provider_id WHERE d.cancellation_requested_at IS NOT NULL ORDER BY d.cancellation_requested_at DESC LIMIT 100`);return r.rows.map(d=>({id:d.id,providerOrderId:d.provider_id,pence:d.pence,rail:d.rail,currency:d.currency??'GBP',requestedAt:d.cancellation_requested_at,state:d.stopped_at?'stopped_in_relay':d.cancellation_state,status:d.status,reviewRequired:d.review_required,checkedAt:d.checked_at}));},
  async checkout(owner,id){return base.tx(async c=>{const r=await owned(c,owner,id);const tracked=(await c.query("SELECT status,review_required,result FROM relay_live_orders WHERE id=$1 AND owner=$2 AND merchant_id=$3 AND provider_id=$4",[r.id,owner,r.merchant_id,r.provider_id])).rows[0];if(r.tracking_only_at)throw new InputError('This paid request is tracking only. Do not pay its checkout again.',409);if(r.stopped_at||r.superseded_by)throw new InputError('This request was stopped or replaced. Use your new request; do not pay the old checkout.',409);if(r.cancellation_state==='requested')throw new InputError('Cancellation is awaiting merchant review. Do not use the old checkout or send payment.',409);if(tracked&&paymentAttemptState({...tracked.result,status:tracked.status,reviewRequired:tracked.review_required}))throw new InputError('The saved payment attempt or quote has expired. Keep tracking if you paid; if you have not paid, stop this request before starting another.',409);if(r.status!=='bound'||!r.checkout_url||!tracked||tracked.review_required||!['checkout_ready','checkout_partial'].includes(tracked.status)||(tracked.result.chargebackStatus&&tracked.result.chargebackStatus!=='NONE'))throw new InputError('The private checkout link is unavailable. Reconcile this order before continuing.',409);return {id:r.id,checkoutUrl:r.checkout_url};});}
 };
}
