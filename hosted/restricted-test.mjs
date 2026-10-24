import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {InputError} from '../server/validation.mjs';
// No env override. This release contains no live checkout route or writer composition.
export const restrictedTestCapabilities=Object.freeze({paymentsEnabled:false,sourceDisabled:true,maxTotalPence:1000,currency:'GBP',rail:'wise',maxAttempts:1});
export const draftFingerprint=row=>createHash('sha256').update(JSON.stringify([row.id,row.owner,row.agent_id,String(row.agent_revision),row.agent.address.toLowerCase(),row.agent.network,row.agent.token,row.pence])).digest('hex');
const denied=()=>new InputError('The controlled test is not authorised for this draft. Payments remain disabled.',403);
export function createRestrictedTestPolicy(base){
 async function checked(c,row,merchantId,{lock=false}={}){
  const p=(await c.query(`SELECT *,clock_timestamp()<expires_at AS current FROM relay_restricted_policy WHERE singleton=true ${lock?'FOR UPDATE':''}`)).rows[0];
  if(!p||p.revoked||!p.current||p.owner!==row.owner||p.draft_id!==row.id||p.draft_hash!==draftFingerprint(row)||p.merchant_id!==merchantId||p.wallet_address!==row.agent.address.toLowerCase()||row.agent.network!=='Base'||row.agent.token!=='USDC'||!Number.isSafeInteger(row.pence)||row.pence<200||row.pence>p.max_total_pence||p.max_total_pence>1000)throw denied();
  return p;
 }
 return Object.freeze({
  async migrate(){await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431930)');await c.query(readFileSync(new URL('./restricted-test.sql',import.meta.url),'utf8'));});},
  // Server-only callback, invoked inside the same transaction that locks the draft and claims creation.
  async reserve(c,row,merchantId){const p=await checked(c,row,merchantId,{lock:true});const r=await c.query('INSERT INTO relay_restricted_attempt(singleton,draft_id,reserved_pence) VALUES(true,$1,$2) ON CONFLICT DO NOTHING RETURNING singleton',[row.id,p.max_total_pence]);if(!r.rows.length)throw new InputError('The single test attempt is already reserved. Do not retry payment.',409);},
  async permit(row,merchantId){try{await checked(base,row,merchantId);return true;}catch{return false;}},
  async status(owner){const p=(await base.query('SELECT owner,draft_id,expires_at,revoked,clock_timestamp()<expires_at AS current FROM relay_restricted_policy WHERE singleton=true')).rows[0];const used=(await base.query('SELECT 1 FROM relay_restricted_attempt')).rows.length>0;const own=!!p&&p.owner===owner;return {...restrictedTestCapabilities,approval:own?(p.revoked?'revoked':!p.current?'expired':'recorded_but_disabled'):'not_approved',targetDraftId:own?p.draft_id:null,expiresAt:own?p.expires_at:null,attemptReserved:own?used:false};}
 });
}
