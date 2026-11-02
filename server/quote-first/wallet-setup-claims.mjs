// Permanent server claims, not wallet creation. No migration or provider SDK here.
import {createHash} from 'node:crypto';
import {QuoteError} from './direct-quote.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hex=/^[a-f0-9]{64}$/;
const check=(v,code='wallet_setup_claim_rejected')=>{if(!v)throw new QuoteError(code);};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const setupIdentityKeys=({appId,owner,subject,privyDid})=>{
 check(/^[a-z0-9]{10,80}$/.test(appId??'')&&typeof owner==='string'&&owner.startsWith('customer:')&&uuid.test(owner.slice(9))&&uuid.test(subject??'')&&/^did:privy:[a-zA-Z0-9]{1,80}$/.test(privyDid??''));
 return {appId,ownerHash:hash([appId,'owner',owner]),subjectHash:hash([appId,'subject',subject]),didHash:hash([appId,'did',privyDid])};
};
export function createPostgresWalletSetupClaims({db,clock=Date.now}={}){
 check(typeof db?.query==='function'&&typeof db?.tx==='function','wallet_setup_storage_unavailable');
 return {
  async consume(proof,assertCurrent){
   check(typeof assertCurrent==='function');
   const p=structuredClone(proof),keys=setupIdentityKeys(p);
   check(uuid.test(p.leaseId??'')&&hex.test(p.context??'')&&hex.test(p.sessionBinding??'')&&hex.test(p.recoveryHash??'')&&Number.isSafeInteger(p.observedAt)&&Number.isSafeInteger(p.validUntil));
   // db.tx must resolve only after COMMIT acknowledgement. Any exception, including
   // response loss after a successful COMMIT, yields no permit and no retry here.
   const row=await db.tx(async c=>{
    const mode=(await c.query('SHOW synchronous_commit')).rows[0]?.synchronous_commit;
    check(['on','remote_apply'].includes(mode),'wallet_setup_storage_unavailable');
    await c.query("SET LOCAL lock_timeout='2s'");await c.query("SET LOCAL statement_timeout='4s'");
    await assertCurrent();
    const r=await c.query('SELECT * FROM eupova_wallet_setup.consume($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[keys.appId,keys.ownerHash,keys.subjectHash,keys.didHash,p.leaseId,p.context,p.sessionBinding,new Date(p.observedAt),new Date(p.validUntil),p.recoveryHash]);
    await assertCurrent();
    return r.rows[0]??null;
   });
   // No historical row, status read or retry ever reconstructs this response.
   if(!row)return {state:'already_consumed',canRetry:false};
   await assertCurrent();
   const expiresAt=new Date(row.expires_at).getTime();check(Number.isSafeInteger(expiresAt)&&expiresAt>clock()+1000);
   return {state:'consumed',durable:true,leaseId:p.leaseId,context:p.context,maxDispatches:1,recoveryReviewed:true,expiresAt};
  },
  async status(identity){
   const k=setupIdentityKeys(identity),r=await db.query('SELECT * FROM eupova_wallet_setup.status($1,$2)',[k.appId,k.ownerHash]);
   return r.rows.length?{state:'consumed',canRetry:false,consumedAt:new Date(r.rows[0].consumed_at).toISOString()}:{state:'not_attempted',canRetry:false};
  }
 };
}
export function createWalletSetupClaimService({enabled=()=>false,appId,claims,verifyFresh,resolveSession,resolveEnrollment,recoveryEvidence,clock=Date.now}={}){
 const current=async(actor,frame)=>{
  check(enabled()===true,'wallet_setup_disabled');
  const session=await resolveSession(actor.sessionToken),enrollment=session&&await resolveEnrollment(session.owner),recovery=recoveryEvidence();
  check(enabled()===true&&session&&enrollment&&hash(session)===hash(frame.session)&&hash(enrollment)===hash(frame.enrollment)&&session.expiresAt>clock()&&enrollment.expiresAt>clock()&&frame.access.expiresAt>clock()&&frame.validUntil>clock()+1000&&recovery.state==='operator_reviewed'&&recovery.hash===frame.recoveryHash&&recovery.expiresAt>clock(),'wallet_setup_context_changed');
 };
 return {
  async claim(actor,input){
   check(enabled()===true,'wallet_setup_disabled');
   check(input&&Object.keys(input).length===3&&uuid.test(input.leaseId??'')&&hex.test(input.context??'')&&input.consent===true);
   const request=structuredClone(input);
   // Mandatory fresh server-only verification on every request. Browser reports,
   // callback addresses and earlier observer context IDs are never accepted as proof.
   const frame=structuredClone(await verifyFresh(actor));
   check(frame.result?.status==='none','wallet_setup_inventory_changed');
   const recovery=recoveryEvidence();
   check(recovery.state==='operator_reviewed'&&hex.test(recovery.hash??'')&&recovery.expiresAt>clock(),'wallet_setup_recovery_unverified');
   frame.recoveryHash=recovery.hash;
   await current(actor,frame);
   return claims.consume({appId,owner:frame.session.owner,subject:frame.enrollment.subject,privyDid:frame.enrollment.privyDid,leaseId:request.leaseId,context:request.context,sessionBinding:frame.session.binding,recoveryHash:recovery.hash,observedAt:frame.observedAt,validUntil:Math.min(frame.validUntil,recovery.expiresAt)},()=>current(actor,frame));
  },
  async status(actor){
   check(enabled()===true,'wallet_setup_disabled');
   const session=structuredClone(await resolveSession(actor.sessionToken)),enrollment=session&&structuredClone(await resolveEnrollment(session.owner));
   check(session&&enrollment&&session.expiresAt>clock()&&enrollment.expiresAt>clock(),'sign_in_required');
   const before=hash([session,enrollment]),r=await claims.status({appId,owner:session.owner,subject:enrollment.subject,privyDid:enrollment.privyDid});
   const latest=await resolveSession(actor.sessionToken),e=latest&&await resolveEnrollment(latest.owner);
   check(enabled()===true&&latest&&e&&latest.expiresAt>clock()&&e.expiresAt>clock()&&hash([latest,e])===before,'wallet_setup_context_changed');return r;
  }
 };
}
