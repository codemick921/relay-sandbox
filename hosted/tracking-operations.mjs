import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
export async function migrateTrackingOperations(base){await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431951)');await c.query(readFileSync(new URL('./tracking-operations.sql',import.meta.url),'utf8'));});}
export function trackingIssues({heartbeatAge,overdue=0,repeated=0}){return {worker_stalled:heartbeatAge===null||heartbeatAge>180,checks_overdue:Number(overdue)>0,repeated_failures:Number(repeated)>0};}
const labels={worker_stalled:'Tracking worker missed its heartbeat',checks_overdue:'Payment checks are overdue',repeated_failures:'Payment checks repeatedly failed'};
export function createTrackingOperations(base,{merchantId,to,from,fetcher=fetch,key,enabled=false}={}){
 if(enabled&&(!merchantId||!key||!/^Eupova <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(from??'')||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to??'')))throw Error('Tracking alert configuration is incomplete.');
 async function sample(){return (await base.query(`SELECT extract(epoch FROM(now()-coalesce(r.beat_at,r.started_at))) AS age,r.beat_at,
 (SELECT count(*) FROM relay_live_orders WHERE merchant_id=$1 AND NOT review_required AND next_check_at<now()-interval '5 minutes' AND status NOT IN ('checkout_received','checkout_cancelled')) AS overdue,
 (SELECT count(*) FROM relay_live_orders WHERE merchant_id=$1 AND attempts>=3 AND NOT review_required AND status NOT IN ('checkout_received','checkout_cancelled')) AS repeated
 FROM eupova_tracking_runtime r WHERE r.merchant_id=$1`,[merchantId])).rows[0];}
 async function observe(){
  const s=await sample();if(!s)return; // Wait for the dedicated worker to register before monitoring it.
  const issues=trackingIssues({heartbeatAge:s.age===null?null:Number(s.age),overdue:s.overdue,repeated:s.repeated});
  await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['tracking-alerts:'+merchantId]);
   for(const [kind,active] of Object.entries(issues)){
    const old=(await c.query('SELECT * FROM eupova_tracking_incidents WHERE merchant_id=$1 AND kind=$2 FOR UPDATE',[merchantId,kind])).rows[0];
    if(!!old?.active===active)continue;
    const id=randomUUID(),recovery=!active;
    const payload={from,to:[to],subject:'Eupova tracking: '+(recovery?'recovered — ':'attention — ')+labels[kind],text:(recovery?'This tracking condition has cleared.':'This tracking condition needs review.')+'\n'+labels[kind]+'\nOverdue checks: '+s.overdue+'\nRepeated failures: '+s.repeated+'\nRecorded at: '+new Date().toISOString()+'\nOpen Eupova and review payment health: https://app.eupova.com/\nThis alert does not confirm payment or wallet delivery. No payment has been created.'};
    await c.query('INSERT INTO eupova_tracking_alerts(id,merchant_id,kind,recovery,payload) VALUES($1,$2,$3,$4,$5)',[id,merchantId,kind,recovery,payload]);
    await c.query('INSERT INTO eupova_tracking_incidents(merchant_id,kind,active,episode) VALUES($1,$2,$3,$4) ON CONFLICT(merchant_id,kind) DO UPDATE SET active=$3,episode=$4,updated_at=now()',[merchantId,kind,active,id]);
   }
  });
 }
 async function deliver(){
  const token=randomUUID();const row=await base.tx(async c=>{
   // Resend only retains idempotency for 24 hours. Do not risk duplicate mail after that window.
   await c.query("UPDATE eupova_tracking_alerts SET abandoned_at=now() WHERE merchant_id=$1 AND sent_at IS NULL AND abandoned_at IS NULL AND first_attempt_at<now()-interval '23 hours'",[merchantId]);
   return (await c.query(`UPDATE eupova_tracking_alerts SET lease_token=$2,lease_until=now()+interval '60 seconds',first_attempt_at=coalesce(first_attempt_at,now()),attempts=attempts+1 WHERE id=(SELECT id FROM eupova_tracking_alerts WHERE merchant_id=$1 AND sent_at IS NULL AND abandoned_at IS NULL AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[merchantId,token])).rows[0];
  });if(!row)return;
  try{const r=await fetcher('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':'eupova-tracking/'+row.id},body:JSON.stringify(row.payload)});if(!r.ok)throw Error('Alert not accepted');const data=await r.json();if(typeof data.id!=='string'||!data.id)throw Error('Alert receipt unavailable');await base.query('UPDATE eupova_tracking_alerts SET sent_at=now(),provider_id=$3,lease_until=NULL WHERE id=$1 AND lease_token=$2',[row.id,token,data.id]);}
  catch{await base.query("UPDATE eupova_tracking_alerts SET lease_until=NULL,next_attempt_at=now()+least(3600,60*power(2,least(attempts,6)))*interval '1 second' WHERE id=$1 AND lease_token=$2",[row.id,token]);console.error('Tracking alert delivery not confirmed; durable retry retained.');}
 }
 let timer=null,active=null,stopping=false;
 async function tick(){if(!enabled||active||stopping)return;active=(async()=>{await observe();await deliver();})().catch(()=>console.error('Tracking monitor temporarily unavailable.')).finally(()=>{active=null;});await active;}
 async function loop(){await tick();if(!stopping)timer=setTimeout(loop,60000);}
 return {observe,deliver,tick,async start(){if(enabled&&!timer&&!active)await loop();},async stop(){stopping=true;clearTimeout(timer);await active;}};
}
export function configuredTrackingOperations(base,env=process.env){return createTrackingOperations(base,{enabled:env.EUPOVA_TRACKING_ALERTS_ENABLED==='true',merchantId:env.EUPOVA_TRACKING_MERCHANT_ID,to:env.EUPOVA_TRACKING_ALERT_TO,from:env.ACCOUNT_EMAIL_FROM,key:env.RESEND_API_KEY});}
