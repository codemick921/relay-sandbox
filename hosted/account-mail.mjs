import {randomUUID,randomBytes} from 'node:crypto';
import {digest} from './db.mjs';

export function accountMessage(purpose,origin,token,setup=false){
 const link=purpose==='changed'?origin+'/':`${origin}/#${purpose==='verify'?'verify-email':'reset-password'}=${token}`;
 const subject={verify:'Verify your Eupova email',reset:'Reset your Eupova password',changed:'Your Eupova password has changed'}[purpose];
 const text={
  verify:`Confirm this email address for your Eupova account. Sign in to the same account, then confirm using this link:\n\n${link}\n\nThis link expires in one hour and can be used once. If you did not request it, ignore this email.`,
  reset:`Use this link to choose a new Eupova password:\n\n${link}\n\nThis link expires in 20 minutes and can be used once. Resetting your password signs out all existing sessions. If you did not request it, ignore this email; your password has not changed.`,
  changed:`Your Eupova password has changed. Your previous sessions and recovery code no longer work.\n\nIf you did not make this change, open Eupova and request a password reset:\n\n${link}`
 }[purpose];
 if(!subject)throw Error('Unsupported account email.');
 if(setup&&purpose==='reset')return {subject:'Set up your Eupova admin account',text:`Your Eupova admin account is ready. Choose your password using this private link:\n\n${link}\n\nThe link confirms your email address and expires in 20 minutes. Save the recovery code shown after setup, then sign in with this email address and open Admin. If the link expires, use Forgot password on Eupova to request another. Never share this link.`,link};
 return {subject,text,link};
}

// Requests are queued independently of delivery: anonymous reset response timing
// never includes a provider call. A failed send is retried a bounded number of times, with the provider's reason kept,
// and only then abandoned as 'unknown'. A verification email that never arrives used to leave no trace at all.
const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [30, 180, 900];
const failureText = e => String(e?.message ?? e ?? 'Delivery failed.').replace(/\s+/g, ' ').slice(0, 240);
export function createAccountMail(store,{enabled=false,origin,deliver,preview=false}={}){
 if(enabled&&typeof deliver!=='function')throw Error('An email transport is required.');
 if(enabled){const u=new URL(origin);if(u.origin!==origin||u.username||u.password||!(u.protocol==='https:'||(preview&&u.protocol==='http:'&&u.hostname==='127.0.0.1')))throw Error('Invalid account email origin.');}
 const previews=new Map();let running=false;
 return {
  enabled,preview,
  async enqueue(c,row,purpose){
   if(!enabled)return;
   // Multiple requests in a short interval collapse into one. New requests do
   // not revoke usable links until a replacement is actually prepared to send.
   await c.query(`INSERT INTO relay_account_mail(id,customer_id,purpose,version)
    SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM relay_account_mail
    WHERE customer_id=$2 AND purpose=$3 AND version=$4 AND created_at>now()-interval '1 minute')`,[randomUUID(),row.id,purpose,row.version]);
  },
  previewFor(id){return previews.get(id)??[];},
  async tick(){
   if(!enabled||running)return;running=true;
   try{
    for(let i=0;i<5;i++){
     const job=await store.tx(async c=>{
      // Lock the customer first, matching token consumption's lock ordering.
      const row=(await c.query(`SELECT c.* FROM relay_customers c WHERE EXISTS(SELECT 1 FROM relay_account_mail m WHERE m.customer_id=c.id AND m.state='queued' AND (m.next_attempt_at IS NULL OR m.next_attempt_at<=now())) ORDER BY c.id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if(!row)return null;
      const m=(await c.query(`SELECT * FROM relay_account_mail WHERE customer_id=$1 AND state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY created_at,id FOR UPDATE LIMIT 1`,[row.id])).rows[0];
      if(!m)return null;
      const eligible=!row.disabled&&m.version===row.version&&(m.purpose!=='reset'||row.email_verified_at||row.setup_pending)&&(m.purpose!=='verify'||!row.email_verified_at)&&Date.now()-new Date(m.created_at).getTime()<3600000;
      if(!eligible){await c.query("UPDATE relay_account_mail SET state='suppressed' WHERE id=$1",[m.id]);return {suppressed:true};}
      const token=m.purpose==='changed'?null:randomBytes(32).toString('hex');
      if(token)await c.query('UPDATE relay_account_mail SET consumed_at=now() WHERE customer_id=$1 AND purpose=$2 AND token_hash IS NOT NULL AND consumed_at IS NULL',[row.id,m.purpose]);
      await c.query(`UPDATE relay_account_mail SET state='sending',attempted_at=now(),token_hash=$2,expires_at=now()+($3::integer*interval '1 minute') WHERE id=$1`,[m.id,token?digest(token):null,m.purpose==='verify'?60:20]);
      return {...m,email:row.email,token,setup:!!row.setup_pending};
     });
     if(!job)break;if(job.suppressed)continue;
     const message=accountMessage(job.purpose,origin,job.token,job.setup);
     const attempt=(job.attempts??0)+1;
     try{
      const result=await deliver({id:job.id,attempt,to:job.email,subject:message.subject,text:message.text});
      if(!result?.id)throw Error('Email acceptance not confirmed.');
      await store.query("UPDATE relay_account_mail SET state='accepted',provider_id=$2,attempts=$3,last_error=NULL,next_attempt_at=NULL WHERE id=$1",[job.id,String(result.id).slice(0,200),attempt]);
      if(job.setup)console.info('Admin setup email accepted by delivery provider.');
      if(preview){const items=previews.get(job.customer_id)??[];previews.set(job.customer_id,[{id:job.id,...message,purpose:job.purpose},...items].slice(0,3));}
     }catch(e){
      const detail=failureText(e);
      if(attempt<MAX_ATTEMPTS){
        // Stay queued and try again later. The row keeps its own reason so the next attempt is explainable.
        const wait=BACKOFF_SECONDS[Math.min(attempt-1,BACKOFF_SECONDS.length-1)];
        await store.query("UPDATE relay_account_mail SET state='queued',attempts=$2,last_error=$3,next_attempt_at=now()+($4::integer*interval '1 second') WHERE id=$1",[job.id,attempt,detail,wait]);
        console.warn(`Account email delivery deferred (attempt ${attempt} of ${MAX_ATTEMPTS}):`,detail);
      }else{
        await store.query("UPDATE relay_account_mail SET state='unknown',attempts=$2,last_error=$3,next_attempt_at=NULL WHERE id=$1",[job.id,attempt,detail]);
        console.warn(`Account email delivery abandoned after ${attempt} attempts:`,detail);
      }
     }
    }
   }finally{running=false;}
  },
  async stop(){while(running)await new Promise(r=>setTimeout(r,50));}
 };
}
