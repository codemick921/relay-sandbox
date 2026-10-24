import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {InputError,address,pence} from '../server/validation.mjs';
import {fundingPence} from '../server/funding-amount.mjs';
export const fundingDisabled=Object.freeze({paymentsEnabled:false,draftsEnabled:true,currency:'GBP',rail:'wise',network:'Base',token:'USDC',extensionFreeVerified:false});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const customer=owner=>{if(!/^customer:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner))throw new InputError('Customer sign-in required.',403);};
const fields=(input,names)=>{if(!input||Object.keys(input).some(k=>!names.includes(k)))throw new InputError('Unsupported funding details.');};
const snapshot=a=>{if(!a||a.network!=='Base'||a.token!=='USDC'||!uuid(a.id)||typeof a.name!=='string'||!a.name.trim()||a.name.length>60)throw new InputError('Choose a saved Base USDC wallet.');return {id:a.id,name:a.name,address:address(a.address).toLowerCase(),network:'Base',token:'USDC'};};
const matches=(a,b)=>JSON.stringify(snapshot(a))===JSON.stringify(snapshot(b));
export const fundingIntent=row=>({id:row.id,kind:'checkout',source:'live',merchantId:row.merchant_id,agent:row.agent,quote:{pence:row.pence,platform:row.rail??'wise',network:'Base',token:'USDC'}});
export function createFundingDrafts(base,{clock=Date.now}={}){
 async function owned(c,owner,id){customer(owner);if(!uuid(id))throw new InputError('Draft not found.',404);const r=(await c.query('SELECT * FROM relay_funding_drafts WHERE id=$1 AND owner=$2 FOR UPDATE',[id,owner])).rows[0];if(!r)throw new InputError('Draft not found.',404);return r;}
 const lock=(c,owner)=>c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['funding:'+owner]);
 const audit=(c,id,event)=>c.query('INSERT INTO relay_funding_audit(draft_id,event) VALUES($1,$2)',[id,event]);
 return {
  async migrate(){await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431929)');await c.query(readFileSync(new URL('./funding-drafts.sql',import.meta.url),'utf8'));});},
  async list(owner){customer(owner);const r=await base.query('SELECT d.id,d.rail,d.agent,d.pence,d.status,d.created_at,d.agent_revision,a.funding_revision AS current_revision,a.data AS current_agent FROM relay_funding_drafts d LEFT JOIN relay_agents a ON a.id=d.agent_id AND a.owner=d.owner WHERE d.owner=$1 ORDER BY d.created_at DESC LIMIT 100',[owner]);return r.rows.map(d=>({id:d.id,rail:d.rail,agent:d.agent,pence:d.pence,status:d.status,createdAt:d.created_at,walletCurrent:String(d.agent_revision)===String(d.current_revision)&&!!d.current_agent&&matches(d.agent,d.current_agent),source:'draft'}));},
  async prepare(owner,input){customer(owner);fields(input,['agentId','requestId','amount','confirm','rail']);if(!uuid(input.agentId)||!uuid(input.requestId)||input.confirm!==true)throw new InputError('Check your amount and saved wallet before saving.');const rail=input.rail??'wise',amount=fundingPence(input.amount,rail);if(!['wise','revolut'].includes(rail))throw new InputError('Unsupported payment route.');
   return base.tx(async c=>{await lock(c,owner);
    const old=(await c.query('SELECT * FROM relay_funding_drafts WHERE owner=$1 AND request_id=$2',[owner,input.requestId])).rows[0];
    if(old){if(old.agent_id!==input.agentId||old.pence!==amount||old.rail!==rail)throw new InputError('This request belongs to another funding draft.',409);return {id:old.id};}
    const a=(await c.query('SELECT data,funding_revision FROM relay_agents WHERE owner=$1 AND id=$2 FOR SHARE',[owner,input.agentId])).rows[0];if(!a)throw new InputError('Choose a saved Base USDC wallet.');
    if((await c.query("SELECT 1 FROM relay_funding_drafts WHERE owner=$1 AND status NOT IN ('cancelled','closed') AND superseded_by IS NULL",[owner])).rows.length)throw new InputError('Review your existing funding draft before starting another.',409);
    if(Number((await c.query('SELECT count(*) FROM relay_funding_drafts WHERE owner=$1',[owner])).rows[0].count)>=100)throw new InputError('Funding draft limit reached.',409);
    const id=randomUUID();await c.query('INSERT INTO relay_funding_drafts(id,owner,request_id,agent_id,agent,pence,agent_revision,rail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,owner,input.requestId,input.agentId,snapshot(a.data),amount,a.funding_revision,rail]);await audit(c,id,'draft_saved');return {id};
   });
  },
  async cancel(owner,input){fields(input,['id']);return base.tx(async c=>{await lock(c,owner);const row=await owned(c,owner,input.id);if(row.status==='cancelled')return {id:row.id};if(row.status!=='draft')throw new InputError('This request has been attempted. Keep it for reconciliation.',409);await c.query("UPDATE relay_funding_drafts SET status='cancelled',updated_at=now() WHERE id=$1",[row.id]);await audit(c,row.id,'draft_cancelled');return {id:row.id};});},
  review:(owner,id)=>base.tx(c=>owned(c,owner,id)),
  // These methods are server-only. The deployed HTTP server exposes prepare/cancel/list only.
  async claim(owner,id,merchantId,{guard}={}){if(!/^[-a-zA-Z0-9_]{1,128}$/.test(merchantId??''))throw Error('Pin the live merchant.');return base.tx(async c=>{await lock(c,owner);const row=await owned(c,owner,id);if(row.status!=='draft')return null;
   const a=(await c.query('SELECT data,funding_revision FROM relay_agents WHERE owner=$1 AND id=$2 FOR SHARE',[owner,row.agent_id])).rows[0];if(!a||String(a.funding_revision)!==String(row.agent_revision)||!matches(row.agent,a.data))throw new InputError('The saved wallet has changed. Cancel this draft and review a new one.',409);
   if(guard)await guard(c,row,merchantId);
   const claim=(await c.query("UPDATE relay_funding_drafts SET status='creating',merchant_id=$2,attempt_token=$3,attempted_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[id,merchantId,randomUUID()])).rows[0];await audit(c,id,'creation_claimed');return claim;
  });},
  async unresolved(claim){await base.tx(async c=>{const r=await c.query("UPDATE relay_funding_drafts SET status='unresolved',updated_at=now() WHERE id=$1 AND attempt_token=$2 AND status='creating' RETURNING id",[claim.id,claim.attempt_token]);if(r.rows.length)await audit(c,claim.id,'creation_unresolved');});},
  async recoverStalled(){await base.tx(async c=>{const rows=await c.query("UPDATE relay_funding_drafts SET status='unresolved',updated_at=now() WHERE status='creating' AND attempted_at<$1 RETURNING id",[new Date(clock()-60000)]);for(const r of rows.rows)await audit(c,r.id,'creation_interrupted');});},
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
  async closeVerified(id){await base.tx(async c=>{const r=await c.query("UPDATE relay_funding_drafts d SET status='closed',checkout_url=NULL,updated_at=now() FROM relay_live_orders o WHERE d.id=$1 AND o.id=d.id AND d.owner=o.owner AND d.merchant_id=o.merchant_id AND d.provider_id=o.provider_id AND d.status='bound' AND o.status='checkout_received' AND NOT o.review_required AND o.result->'delivery'->>'finalized'='true' RETURNING d.id",[id]);if(r.rows.length)await audit(c,id,'delivery_verified');});},
  async checkout(owner,id){return base.tx(async c=>{const r=await owned(c,owner,id);const tracked=(await c.query("SELECT status,review_required,result FROM relay_live_orders WHERE id=$1 AND owner=$2 AND merchant_id=$3 AND provider_id=$4",[r.id,owner,r.merchant_id,r.provider_id])).rows[0];if(r.status!=='bound'||!r.checkout_url||!tracked||tracked.review_required||!['checkout_ready','checkout_partial'].includes(tracked.status)||(tracked.result.chargebackStatus&&tracked.result.chargebackStatus!=='NONE'))throw new InputError('The private checkout link is unavailable. Reconcile this order before continuing.',409);return {id:r.id,checkoutUrl:r.checkout_url};});}
 };
}
