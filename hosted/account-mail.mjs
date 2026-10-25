import {randomUUID,randomBytes} from 'node:crypto';
import {digest} from './db.mjs';

export function accountMessage(purpose,origin,token){
 const link=purpose==='changed'?origin+'/':`${origin}/#${purpose==='verify'?'verify-email':'reset-password'}=${token}`;
 const subject={verify:'Verify your Eupova email',reset:'Reset your Eupova password',changed:'Your Eupova password has changed'}[purpose];
 const text={
  verify:`Confirm this email address for your Eupova account. Sign in to the same account, then confirm using this link:\n\n${link}\n\nThis link expires in one hour and can be used once. If you did not request it, ignore this email.`,
  reset:`Use this link to choose a new Eupova password:\n\n${link}\n\nThis link expires in 20 minutes and can be used once. Resetting your password signs out all existing sessions. If you did not request it, ignore this email; your password has not changed.`,
  changed:`Your Eupova password has changed. Your previous sessions and recovery code no longer work.\n\nIf you did not make this change, open Eupova and request a password reset:\n\n${link}`
 }[purpose];
 if(!subject)throw Error('Unsupported account email.');
 return {subject,text,link};
}

// Requests are queued independently of delivery: anonymous reset response timing
// never includes a provider call. A crashed/uncertain send is never auto-retried.
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
      const row=(await c.query(`SELECT c.* FROM relay_customers c WHERE EXISTS(SELECT 1 FROM relay_account_mail m WHERE m.customer_id=c.id AND m.state='queued') ORDER BY c.id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if(!row)return null;
      const m=(await c.query(`SELECT * FROM relay_account_mail WHERE customer_id=$1 AND state='queued' ORDER BY created_at,id FOR UPDATE LIMIT 1`,[row.id])).rows[0];
      const eligible=!row.disabled&&m.version===row.version&&(m.purpose!=='reset'||row.email_verified_at)&&(m.purpose!=='verify'||!row.email_verified_at)&&Date.now()-new Date(m.created_at).getTime()<3600000;
      if(!eligible){await c.query("UPDATE relay_account_mail SET state='suppressed' WHERE id=$1",[m.id]);return {suppressed:true};}
      const token=m.purpose==='changed'?null:randomBytes(32).toString('hex');
      if(token)await c.query('UPDATE relay_account_mail SET consumed_at=now() WHERE customer_id=$1 AND purpose=$2 AND token_hash IS NOT NULL AND consumed_at IS NULL',[row.id,m.purpose]);
      await c.query(`UPDATE relay_account_mail SET state='sending',attempted_at=now(),token_hash=$2,expires_at=now()+($3::integer*interval '1 minute') WHERE id=$1`,[m.id,token?digest(token):null,m.purpose==='verify'?60:20]);
      return {...m,email:row.email,token};
     });
     if(!job)break;if(job.suppressed)continue;
     const message=accountMessage(job.purpose,origin,job.token);
     try{
      const result=await deliver({id:job.id,to:job.email,subject:message.subject,text:message.text});
      if(!result?.id)throw Error('Email acceptance not confirmed.');
      await store.query("UPDATE relay_account_mail SET state='accepted',provider_id=$2 WHERE id=$1",[job.id,String(result.id).slice(0,200)]);
      if(preview){const items=previews.get(job.customer_id)??[];previews.set(job.customer_id,[{id:job.id,...message,purpose:job.purpose},...items].slice(0,3));}
     }catch{
      await store.query("UPDATE relay_account_mail SET state='unknown' WHERE id=$1",[job.id]);
     }
    }
   }finally{running=false;}
  },
  async stop(){while(running)await new Promise(r=>setTimeout(r,50));}
 };
}
