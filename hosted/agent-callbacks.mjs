import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {InputError} from '../server/validation.mjs';
import {validateRequestConnection} from './agent-connections.mjs';
import {readAgentRequestProgress} from './agent-request-progress.mjs';
import {callbackUrl,callbackSecret,deliverCallback} from './callback-transport.mjs';
export function callbackSnapshot(r,progress,now){return {requestId:r.id,requestStatus:r.cancelled_at?'dismissed':r.draft_id?'funding_prepared':new Date(r.expires_at).getTime()<=now?'expired':'awaiting_review',progress};}
export function snapshotDigest(snapshot){const {checkedAt,...progress}=snapshot.progress;return createHash('sha256').update(JSON.stringify({...snapshot,progress})).digest('hex');}
export function createAgentCallbacks(base,{allowed=[],merchantId=null,clock=Date.now,deliver=deliverCallback}={}){
 let running=false,timer;
 async function owned(c,k,id){const r=(await c.query('SELECT * FROM relay_agent_funding_requests WHERE owner=$1 AND source_connection_id=$2 AND id=$3',[k.owner,k.id,id])).rows[0];if(!r)throw new InputError('Request unavailable.',404);return r;}
 const view=r=>r?{id:r.id,url:r.url,enabled:r.enabled,sequence:Number(r.sequence),attempts:r.attempts,pendingEventId:r.pending?.id??null,deliveredAt:r.delivered_at,lastError:r.last_error}:null;
 const api={
  async migrate(){await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431947)');await c.query(readFileSync(new URL('./agent-callbacks.sql',import.meta.url),'utf8'));});},
  async manage(k,id,input,method){return base.tx(async c=>{
   await validateRequestConnection(c,k.owner,k.id,clock());await owned(c,k,id);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['callback:'+id]);
   const old=(await c.query('SELECT * FROM relay_agent_callbacks WHERE request_id=$1 FOR UPDATE',[id])).rows[0];
   if(method==='GET')return {callback:view(old),registrationAvailable:allowed.length>0};
   if(method==='DELETE'){if(old)await c.query('UPDATE relay_agent_callbacks SET enabled=false WHERE id=$1',[old.id]);return {disabled:true};}
   if(!input||Object.keys(input).some(x=>!['url','confirmOwnership'].includes(x))||input.confirmOwnership!==true)throw new InputError('Confirm that you control the callback endpoint.');
   const url=callbackUrl(input.url,allowed).href;
   if(old&&old.url!==url)throw new InputError('Callback URL is pinned to this request. Contact Eupova to change it.',409);
   const sid=old?.id??randomUUID();
   if(old)await c.query('UPDATE relay_agent_callbacks SET enabled=true,attempts=0,last_error=NULL,next_at=$2 WHERE id=$1',[sid,new Date(clock())]);
   else await c.query('INSERT INTO relay_agent_callbacks(id,request_id,connection_id,url,next_at) VALUES($1,$2,$3,$4,$5)',[sid,id,k.id,url,new Date(clock())]);
   return {id:sid,signingSecret:callbackSecret(k.secret_hash,sid),enabled:true};
  });},
  async tick(){if(running)return;running=true;try{await base.tx(async c=>{
   const row=(await c.query('SELECT * FROM relay_agent_callbacks WHERE enabled AND next_at<=$1 ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED',[new Date(clock())])).rows[0];if(!row)return;
   const r=(await c.query('SELECT * FROM relay_agent_funding_requests WHERE id=$1',[row.request_id])).rows[0];
   let k;try{k=await validateRequestConnection(c,r.owner,row.connection_id,clock());}catch(e){if(!(e instanceof InputError))throw e;await c.query("UPDATE relay_agent_callbacks SET enabled=false,last_error='connection_inactive' WHERE id=$1",[row.id]);return;}
   if(!allowed.includes(row.url)){await c.query("UPDATE relay_agent_callbacks SET enabled=false,last_error='destination_not_approved' WHERE id=$1",[row.id]);return;}
   let event=row.pending,digest=row.pending_digest;
   if(!event){const snapshot=callbackSnapshot(r,await readAgentRequestProgress(c,r,{merchantId,now:clock()}),clock());digest=snapshotDigest(snapshot);
    if(digest===row.last_digest){await c.query('UPDATE relay_agent_callbacks SET next_at=$2 WHERE id=$1',[row.id,new Date(clock()+30000)]);return;}
    event={schema:'eupova-funding-callback-v1',id:randomUUID(),type:'funding_request.status',sequence:Number(row.sequence)+1,createdAt:new Date(clock()).toISOString(),data:snapshot};
    // Commit the event before network delivery. A process crash must retain its stable ID.
    await c.query('UPDATE relay_agent_callbacks SET pending=$2,pending_digest=$3,sequence=$4,next_at=$5 WHERE id=$1',[row.id,event,digest,event.sequence,new Date(clock())]);return;
   }
   try{await deliver(row.url,event,callbackSecret(k.secret_hash,row.id),{allowed,now:clock()});
    await c.query('UPDATE relay_agent_callbacks SET last_digest=$2,pending=NULL,pending_digest=NULL,attempts=0,last_error=NULL,delivered_at=$3,next_at=$4 WHERE id=$1',[row.id,digest,new Date(clock()),new Date(clock()+30000)]);
   }catch{const attempts=row.attempts+1;await c.query("UPDATE relay_agent_callbacks SET attempts=$2,enabled=$3,last_error='delivery_failed',next_at=$4 WHERE id=$1",[row.id,attempts,attempts<8,new Date(clock()+Math.min(3600000,30000*2**(attempts-1)))]);}
  });}finally{running=false;}},
  start(){if(!timer){timer=setInterval(()=>api.tick().catch(()=>console.error('Callback dispatch temporarily unavailable.')),15000);timer.unref();}},
  async stop(){clearInterval(timer);timer=null;while(running)await new Promise(r=>setTimeout(r,25));}
 };return api;
}
