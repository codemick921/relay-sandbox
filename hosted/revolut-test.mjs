// Policy and GET-only link release. No provider writer is reachable from HTTP.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {draftFingerprint} from './restricted-test.mjs';
import {liveOrderView} from './live-store.mjs';
import {InputError} from '../server/validation.mjs';
export const revolutFingerprint=row=>createHash('sha256').update(draftFingerprint(row)+':'+row.rail).digest('hex');
export function createRevolutPolicy(base){
 async function checked(c,row,merchantId,lock=false){
  const p=(await c.query(`SELECT *,clock_timestamp()<expires_at AS current FROM relay_revolut_policy WHERE singleton=true ${lock?'FOR UPDATE':''}`)).rows[0];
  const a=(await c.query('SELECT funding_revision,data FROM relay_agents WHERE owner=$1 AND id=$2 FOR SHARE',[row.owner,row.agent_id])).rows[0];
  if(!p||p.revoked||!p.current||p.owner!==row.owner||p.draft_id!==row.id||p.draft_hash!==revolutFingerprint(row)||row.rail!=='revolut'||p.merchant_id!==merchantId||p.wallet_address!==row.agent.address.toLowerCase()||row.agent.network!=='Base'||row.agent.token!=='USDC'||!Number.isSafeInteger(row.pence)||row.pence<200||row.pence>p.max_total_pence||p.max_total_pence>1000||!a||String(a.funding_revision)!==String(row.agent_revision)||a.data.address.toLowerCase()!==p.wallet_address)throw new InputError('This Revolut test is not authorised for the saved account and wallet.',403);
  return p;
 }
 return Object.freeze({
  async migrate(){await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431931)');await c.query(readFileSync(new URL('./revolut-test.sql',import.meta.url),'utf8'));});},
  async permit(row,merchant){try{await checked(base,row,merchant);return true;}catch{return false;}},
  async reserve(c,row,merchant){const p=await checked(c,row,merchant,true);const r=await c.query('INSERT INTO relay_revolut_attempt(singleton,draft_id,reserved_pence) VALUES(true,$1,$2) ON CONFLICT DO NOTHING RETURNING singleton',[row.id,p.max_total_pence]);if(!r.rows.length)throw new InputError('The one test checkout has already been attempted. Do not create another.',409);},
  async status(owner){
   const p=(await base.query('SELECT p.*,d.status,d.agent,d.pence,clock_timestamp()<p.expires_at AS current FROM relay_revolut_policy p JOIN relay_funding_drafts d ON d.id=p.draft_id WHERE p.owner=$1',[owner])).rows[0];
   if(!p)return {approved:false,generalPaymentsEnabled:false};
   return {approved:!p.revoked&&p.current,revoked:p.revoked,expired:!p.current,id:p.draft_id,status:p.status,agent:p.agent,pence:p.pence,maxTotalPence:p.max_total_pence,expiresAt:p.expires_at,generalPaymentsEnabled:false,totalDebitCapEnforced:false,repeatTransfersPreventable:false};
  }
 });
}
export function createRevolutRelease({drafts,policy,reader,store,merchantId}){
 return async(owner,input)=>{
  if(!input||Object.keys(input).some(k=>!['id','confirm'].includes(k))||input.confirm!==true)throw new InputError('Confirm the final payment review before opening Peer.');
  const row=await drafts.attempted(owner,input.id);
  if(!await policy.permit(row,merchantId))throw new InputError('The test approval has expired or the saved wallet has changed.',403);
  const tracked=await store.owned(owner,row.id);
  if(tracked.review_required||tracked.status!=='checkout_ready')throw new InputError('This test needs review. Do not send another payment.',409);
  const result=await reader.refresh(liveOrderView(tracked)),v=result.verification;
  if(result.status!=='checkout_ready'||result.chargebackStatus!=='NONE'||!['awaiting_selection','within_peer_limit'].includes(v.payIn?.status)||v.payments.length>1)throw new InputError('The current payment needs review. Do not pay or start another attempt.',409);
  // Check again after provider I/O. An expired or revoked policy cannot release a link.
  if(!await policy.permit(await drafts.review(owner,row.id),merchantId))throw new InputError('The test approval changed.',403);
  const link=await drafts.checkout(owner,row.id);
  await store.schedule(owner,row.id);
  return {...link,amountPence:row.pence,totalDebitCapEnforced:false,payOnce:true};
 };
}
