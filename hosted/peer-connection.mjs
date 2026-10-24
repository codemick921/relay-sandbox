import {readFileSync} from 'node:fs';
import {InputError} from '../server/validation.mjs';
import {verifyWebhook} from '../server/pay-webhooks.mjs';

export const liveWebhookPath='/api/webhooks/peer/live';
// Deliberately does not import any order store, provider SDK, queue or worker.
export function createPeerConnection({connection,store,fetcher=fetch}){
 if(connection?.mode!=='receive_only'||connection.environment!=='LIVE'||!connection.apiKey||!connection.secret||!connection.merchantId)throw Error('Explicit receive-only connection required.');
 let identity={status:'not_checked',checkedAt:null,wiseEnabled:null};
 return Object.freeze({
  mode:'receive_only',
  async migrate(){await store.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431927)');await c.query(readFileSync(new URL('./peer-notifications.sql',import.meta.url),'utf8'));});},
  async checkIdentity(){
   const checkedAt=new Date().toISOString();
   try{
    // Exactly one fixed GET, no generic request API and no redirect/key forwarding.
    const response=await fetcher('https://api.pay.peer.xyz/api/v1/merchants/me',{method:'GET',headers:{'X-API-Key':connection.apiKey},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok){identity={status:[401,403].includes(response.status)?'auth_failed':'unavailable',checkedAt,wiseEnabled:null};return;}
    const body=await response.json(),merchant=body?.success===true?body.responseObject:null;
    const match=merchant?.id===connection.merchantId&&merchant?.environment==='LIVE';
    identity={status:match?'verified':'mismatch',checkedAt,wiseEnabled:match?merchant.merchantConfig?.enabledRails?.includes('wise')===true:null};
   }catch{identity={status:'unavailable',checkedAt,wiseEnabled:null};}
  },
  async accept(raw,headers){
   if(identity.status!=='verified')throw new InputError('Live connection identity is not verified. No payment was processed.',503);
   const event=verifyWebhook(raw,headers,connection);
   // Neither an order ID nor any customer, amount, wallet or raw body is stored.
   // This inbox is separate from live tracking; nothing polls or acts on it.
   return store.tx(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(431928)');
    const old=(await c.query('SELECT digest FROM relay_peer_connection_notifications WHERE merchant_id=$1 AND(event_id=$2 OR digest=$3)',[connection.merchantId,event.eventId,event.digest])).rows;
    if(old.length){if(old.some(x=>x.digest!==event.digest))throw new InputError('Webhook event conflicts with its original content.',409);return {duplicate:true};}
    const count=Number((await c.query('SELECT count(*) AS n FROM relay_peer_connection_notifications')).rows[0].n);
    if(count>=10000)throw new InputError('Notification inbox needs operator review.',503);
    await c.query('INSERT INTO relay_peer_connection_notifications(merchant_id,event_id,digest,event_type,test) VALUES($1,$2,$3,$4,$5)',[connection.merchantId,event.eventId,event.digest,event.type,event.test]);
    return {duplicate:false};
   });
  },
  async status(){
   const r=(await store.query('SELECT count(*) AS total,count(*) FILTER(WHERE test) AS tests,max(received_at) AS last_received_at FROM relay_peer_connection_notifications WHERE merchant_id=$1',[connection.merchantId])).rows[0];
   return {mode:'receive_only',identity:{...identity},notifications:{total:Number(r.total),tests:Number(r.tests),lastReceivedAt:r.last_received_at},liveOrdersEnabled:false,realPaymentsEnabled:false,liveTrackingEnabled:false};
  }
 });
}
