import {createHmac,createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,openSync,fsyncSync,closeSync} from 'node:fs';
import path from 'node:path';
import {InputError} from './validation.mjs';

export function atomicJson(file,value){
 mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(value),{mode:0o600});
 const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(temp,file);
 const dir=openSync(path.dirname(file),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,256}$/.test(v);
const TYPES=new Set(['ORDER_CREATED','ORDER_FULFILLED','ORDER_CANCELLED','ORDER_RESIZED','ORDER_AMOUNT_SET','PAYMENT_CREATED','PAYMENT_SETTLED','PAYMENT_FAILED','PAYMENT_EXPIRED','PAYMENT_CANCELLED','PAYMENT_CHARGEBACKED','ORDER_PARTIALLY_CHARGEBACKED','ORDER_CHARGEBACKED','REFUND_PENDING','REFUND_COMPLETED','PAYMENT_BRIDGE_PENDING','PAYMENT_BRIDGE_SUBMITTED','PAYMENT_BRIDGE_COMPLETED','PAYMENT_BRIDGE_FAILED']);
export function verifyWebhook(raw,headers,{secret,merchantId,environment,now=Date.now()}){
 if(!secret||!merchantId||!['SANDBOX','LIVE'].includes(environment))throw new InputError('Webhook connection is not configured.',503);
 const timestamp=headers['x-webhook-timestamp'],signature=headers['x-webhook-signature'],deliveryId=headers['x-webhook-id'];
 if(!Buffer.isBuffer(raw)||raw.length>262144)throw new InputError('Invalid webhook body.',413);
 if(typeof timestamp!=='string'||!/^\d{10}$/.test(timestamp)||Math.abs(Math.floor(now/1000)-Number(timestamp))>300||typeof signature!=='string'||!/^([a-f0-9]{64})$/i.test(signature)||!validId(deliveryId))throw new InputError('Invalid webhook signature or timestamp.',401);
 const expected=createHmac('sha256',secret).update(timestamp+'.').update(raw).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new InputError('Invalid webhook signature or timestamp.',401);
 let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{throw new InputError('Invalid webhook JSON.');}
 if(!validId(payload?.id)||!TYPES.has(payload.type)||!payload.data||typeof payload.data!=='object')throw new InputError('Unsupported webhook event.');
 const test=payload.data.test===true;
 if(test){if(payload.type!=='ORDER_CREATED'||payload.data.order!==null||payload.data.payment!==null)throw new InputError('Invalid test event.');}
 else if(!validId(payload.data.order?.id)||payload.data.order.merchantId!==merchantId||
   (payload.data.payment&&payload.data.payment.orderId!==payload.data.order.id))throw new InputError('Webhook belongs to a different order or merchant.',403);
 // The signed body is also deduplicated: X-Webhook-Id is not part of Peer's HMAC.
 const hint=payload.data.order?.notes?.relayOrderId;
 const relayOrderId=typeof hint==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(hint)?hint:null;
 return {environment,merchantId,deliveryId,eventId:payload.id,type:payload.type,orderId:test?null:payload.data.order.id,relayOrderId,test,digest:createHash('sha256').update(raw).digest('hex')};
}
export function createWebhookInbox({file=null,capacity=10000}={}){
 let entries=file&&existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];
 if(!Array.isArray(entries))throw Error('Invalid webhook inbox.');
 const commit=next=>{if(file)atomicJson(file,next);entries=next;};
 return {
  accept(event,now=Date.now()){
   const old=entries.find(x=>x.environment===event.environment&&(x.deliveryId===event.deliveryId||x.eventId===event.eventId||x.digest===event.digest));
   if(old){if(old.digest!==event.digest)throw new InputError('Webhook replay differs from its original body.',409);return {duplicate:true};}
   if(entries.length>=capacity)throw new InputError('Webhook inbox is full. Operator review required.',503);
   commit([...entries,{...event,id:randomUUID(),state:event.test?'processed':'pending',attempts:0,receivedAt:now,nextAttemptAt:now}]);return {duplicate:false};
  },
  pending:(now=Date.now())=>entries.filter(x=>x.state==='pending'&&x.nextAttemptAt<=now).slice(0,10).map(x=>({...x})),
  finish(id,now=Date.now()){commit(entries.map(x=>x.id===id?{...x,state:'processed',processedAt:now}:x));},
  retry(id,now=Date.now()){commit(entries.map(x=>x.id===id?{...x,attempts:x.attempts+1,nextAttemptAt:now+Math.min(3600000,15000*2**Math.min(x.attempts,8))}:x));},
  stats:()=>({pending:entries.filter(x=>x.state==='pending').length,processed:entries.filter(x=>x.state==='processed').length})
 };
}
export function webhookConnections(env=process.env){return {
 sandbox:{environment:'SANDBOX',secret:env.PEER_PAY_SANDBOX_WEBHOOK_SECRET,merchantId:env.PEER_PAY_SANDBOX_MERCHANT_ID},
 live:{environment:'LIVE',secret:env.PEER_PAY_LIVE_WEBHOOK_SECRET,merchantId:env.PEER_PAY_LIVE_MERCHANT_ID}
};}
