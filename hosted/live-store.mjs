import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {InputError,address,TOKEN} from '../server/validation.mjs';
import {microUsdc} from '../server/pay-delivery.mjs';
import {same,hash} from '../server/receipts.mjs';
import {TrackingReviewError} from '../server/pay-readonly.mjs';

const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const identifier=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);
const uint=v=>typeof v==='string'&&/^\d{1,16}$/.test(v);
const states=new Set(['checkout_ready','checkout_partial','checkout_settled','checkout_confirming','checkout_received','checkout_cancelled','checkout_review']);
const check=(ok,message)=>{if(!ok)throw new TrackingReviewError(message);};
export const liveOrderView=row=>({...row.request,...row.result,id:row.id,createdAt:row.created_at,status:row.status,reviewRequired:row.review_required,source:'live'});

function immutableIntent(input){
 if(input?.source!=='live'||input.kind!=='checkout'||!uuid(input.id)||!identifier(input.providerOrderId)||!identifier(input.merchantId)||
  !Number.isInteger(input.quote?.pence)||input.quote.pence<200||input.quote.pence>100000||input.quote.platform!=='wise'||
  input.agent?.network!=='Base'||input.agent?.token!=='USDC'||!uuid(input.agent.id)||typeof input.agent.name!=='string'||input.agent.name.length>60||!input.agent.name.trim()||microUsdc(input.requestedUsdcAmount)<=0n)throw new InputError('Invalid trusted live intent.');
 // Keep only immutable inputs; never accept prefilled success/receipt/checkout URLs.
 return {id:input.id,kind:'checkout',source:'live',merchantId:input.merchantId,providerOrderId:input.providerOrderId,
  requestedUsdcAmount:input.requestedUsdcAmount,agent:{id:input.agent.id,name:input.agent.name,address:address(input.agent.address).toLowerCase(),network:'Base',token:'USDC'},
  quote:{pence:input.quote.pence,platform:'wise',network:'Base',token:'USDC'}};
}
function checkedResult(order,update){
 const v=update?.verification;
 check(states.has(update?.status)&&v?.environment==='LIVE'&&v.simulated!==true&&Array.isArray(v.payments)&&v.payments.length<100,'Unsupported tracking result.');
 check(['CREATED','PARTIALLY_FULFILLED','FULFILLED','CANCELLED'].includes(update.providerStatus)&&['NONE','PARTIALLY_CHARGEBACKED','CHARGEBACKED'].includes(update.chargebackStatus),'Unsupported provider state.');
 check(v.providerFulfilled===(update.providerStatus==='FULFILLED')&&Number.isFinite(Date.parse(update.checkedAt)),'Invalid verification timestamp or fulfilment state.');
 const settled=v.payments.filter(p=>p.status==='SETTLED'),ids=new Set(),intents=new Set(),transactions=new Set();
 for(const p of v.payments){check(identifier(p.id)&&!ids.has(p.id),'Duplicate payment evidence.');ids.add(p.id);}
 let total=0n,arrived=0n;
 for(const p of settled){
  check(uint(p.amountRaw)&&BigInt(p.amountRaw)>0n,'Invalid net settlement amount.');
  const intent=hash(p.intentHash).toLowerCase(),tx=hash(p.transactionHash).toLowerCase();
  check(!intents.has(intent)&&!transactions.has(tx),'Duplicate settlement evidence.');intents.add(intent);transactions.add(tx);total+=BigInt(p.amountRaw);
  if(p.receipt){const r=p.receipt;
   check(r.chainId===8453&&same(r.tokenAddress,TOKEN)&&same(r.recipient,order.agent.address)&&same(r.transactionHash,tx)&&r.amountRaw===p.amountRaw&&uint(r.blockNumber),'Receipt binding differs from the intent.');
   hash(r.blockHash);check(r.finalized===(p.deliveryStatus==='finalized'),'Inconsistent receipt finality.');
  }
  if(p.deliveryStatus==='finalized'){check(p.receipt?.finalized===true,'Missing finalised receipt.');arrived+=BigInt(p.amountRaw);}
 }
 check(v.expectedNetRaw===String(total)&&v.receivedRaw===String(arrived),'Settlement totals do not match receipt evidence.');
 const completed=v.providerFulfilled&&settled.length>0&&settled.every(p=>p.deliveryStatus==='finalized');
 check((update.status==='checkout_received')===completed,'Completion lacks finalised payment evidence.');
 if(completed){const d=update.delivery;
  check(d?.finalized===true&&d.chainId===8453&&same(d.tokenAddress,TOKEN)&&same(d.recipient,order.agent.address)&&d.amountRaw===String(arrived)&&
   JSON.stringify(d.receipts)===JSON.stringify(settled.map(p=>p.receipt)),'Delivery summary does not match receipts.');
 }else check(update.delivery===null,'Unverified order cannot have a delivery receipt.');
 return {status:update.status,providerStatus:update.providerStatus,checkedAt:update.checkedAt,verification:v,delivery:update.delivery,chargebackStatus:update.chargebackStatus,trackingError:null};
}

export function createLiveStore(pool,{merchantId}={}){
 if(!identifier(merchantId))throw Error('Pin a live merchant before creating the tracking store.');
 const query=(sql,args=[])=>pool.query(sql,args);
 async function tx(fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 async function owned(c,owner,id){const r=await c.query('SELECT * FROM relay_live_orders WHERE id=$1 AND owner=$2 AND merchant_id=$3',[id,owner,merchantId]);if(!r.rows[0])throw new InputError('Order not found.',404);return r.rows[0];}
 const current=async(c,claim)=>{const r=(await c.query('SELECT * FROM relay_live_orders WHERE id=$1 AND merchant_id=$2 FOR UPDATE',[claim.id,merchantId])).rows[0];return r&&String(r.generation)===String(claim.generation)&&r.lease_token===claim.lease_token?r:null;};
 return {
  query,tx,
  async migrate(){return tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431925)');await c.query(readFileSync(new URL('./live-schema.sql',import.meta.url),'utf8'));});},
  // SERVER-ONLY boundary for the future authorised checkout creation transaction.
  // Never expose this as arbitrary order import, webhook discovery or browser input.
  async bindTrustedOrder(owner,input,{client}={}){
   if(!identifier(owner)&&!/^customer:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner))throw new InputError('A verified owner is required.');
   const request=immutableIntent(input);if(request.merchantId!==merchantId)throw new InputError('Wrong merchant.');
   const bind=async c=>{
    const row=(await c.query(`INSERT INTO relay_live_orders(id,owner,merchant_id,provider_id,request) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,[request.id,owner,merchantId,request.providerOrderId,request])).rows[0];
    if(row){await c.query("INSERT INTO relay_live_audit(order_id,event) VALUES($1,'bound')",[row.id]);return row;}
    const old=await owned(c,owner,request.id);
    check(JSON.stringify(immutableIntent(old.request))===JSON.stringify(request),'Existing live intent cannot change.');return old;
   };return client?bind(client):tx(bind);
  },
  owned:(owner,id)=>owned(pool,owner,id),
  async state(owner){const orders=await query('SELECT * FROM relay_live_orders WHERE owner=$1 AND merchant_id=$2 ORDER BY created_at DESC LIMIT 100',[owner,merchantId]);return {orders:orders.rows.map(liveOrderView)};},
  async schedule(owner,id){await owned(pool,owner,id);await query('UPDATE relay_live_orders SET next_check_at=now() WHERE id=$1 AND owner=$2 AND merchant_id=$3',[id,owner,merchantId]);},
  async claimNext(){return tx(async c=>{
   const row=(await c.query(`SELECT * FROM relay_live_orders WHERE merchant_id=$1 AND next_check_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_check_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,[merchantId])).rows[0];
   return row?(await c.query(`UPDATE relay_live_orders SET generation=generation+1,lease_token=$2,lease_until=now()+interval '60 seconds',claimed_at=clock_timestamp(),claimed_event_ids=ARRAY(SELECT event_id FROM relay_live_webhooks WHERE merchant_id=$3 AND provider_id=$4 AND processed_at IS NULL ORDER BY received_at LIMIT 1000) WHERE id=$1 RETURNING *`,[row.id,randomUUID(),merchantId,row.provider_id])).rows[0]:null;
  });},
  async apply(claim,update){return tx(async c=>{
   const row=await current(c,claim);if(!row)return false;
   const order=liveOrderView(row),result=checkedResult(order,update);
   // Retain the original settlement bindings even if a later API history is stale.
   for(const prior of row.result.verification?.payments??[]){if(prior.status!=='SETTLED')continue;
    const next=result.verification.payments.find(p=>p.id===prior.id&&p.status==='SETTLED');
    check(next&&same(prior.intentHash,next.intentHash)&&same(prior.transactionHash,next.transactionHash)&&prior.amountRaw===next.amountRaw,'Previously settled payment changed or disappeared.');
    if(prior.receipt?.finalized)check(next.receipt?.finalized&&same(prior.receipt.blockHash,next.receipt.blockHash)&&prior.receipt.blockNumber===next.receipt.blockNumber,'Previously finalised receipt changed or disappeared.');
   }
   if(row.result.delivery?.finalized)check(result.delivery?.finalized,'Previously completed delivery lost its evidence.');
   // Reserve every settled transaction/intent, including partial or pending receipts.
   // Database uniqueness makes concurrent cross-owner credit impossible.
   for(const p of result.verification.payments.filter(p=>p.status==='SETTLED')){
    const values=[merchantId,p.id,row.id,8453,TOKEN.toLowerCase(),order.agent.address.toLowerCase(),p.amountRaw,p.intentHash.toLowerCase(),p.transactionHash.toLowerCase()];
    const inserted=await c.query(`INSERT INTO relay_live_payments(merchant_id,payment_id,order_id,chain_id,token_address,recipient,amount_raw,intent_hash,transaction_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING payment_id`,values);
    if(!inserted.rows.length){const old=(await c.query('SELECT * FROM relay_live_payments WHERE merchant_id=$1 AND payment_id=$2 FOR UPDATE',[merchantId,p.id])).rows[0];
     check(old&&old.order_id===row.id&&old.intent_hash===values[7]&&old.transaction_hash===values[8]&&String(old.amount_raw)===p.amountRaw&&old.recipient===values[5],'Receipt is already bound to another payment or order.');
    }
    await c.query('UPDATE relay_live_payments SET receipt=$3,finalized=$4 WHERE merchant_id=$1 AND payment_id=$2',[merchantId,p.id,p.receipt??null,p.deliveryStatus==='finalized']);
   }
   // Snapshot exact signed event IDs at claim time, not timestamps: two arrivals
   // can share one clock tick. A notification arriving mid-read needs another read.
   await c.query('UPDATE relay_live_webhooks SET processed_at=now() WHERE merchant_id=$1 AND provider_id=$2 AND event_id=ANY($3::text[]) AND processed_at IS NULL',[merchantId,row.provider_id,row.claimed_event_ids]);
   const pending=(await c.query('SELECT 1 FROM relay_live_webhooks WHERE merchant_id=$1 AND provider_id=$2 AND processed_at IS NULL LIMIT 1',[merchantId,row.provider_id])).rows.length>0;
   // Review holds require an explicit operator resolution; successful polling alone
   // cannot erase a collision or conflicting finalised history.
   const status=row.review_required?'checkout_review':result.status;
   await c.query(`UPDATE relay_live_orders SET result=$2,status=$3,generation=generation+1,lease_token=NULL,lease_until=NULL,attempts=0,next_check_at=now()+$4*interval '1 second',updated_at=now() WHERE id=$1`,[row.id,result,status,pending?0:status==='checkout_received'||status==='checkout_cancelled'||row.review_required?3600:30]);
   if(row.status!==status||JSON.stringify(row.result.delivery)!==JSON.stringify(result.delivery)||row.result.chargebackStatus!==result.chargebackStatus)await c.query("INSERT INTO relay_live_audit(order_id,event,data) VALUES($1,'verified',$2)",[row.id,{from:row.status,to:status,receivedRaw:result.verification.receivedRaw,chargebackStatus:result.chargebackStatus}]);
   return true;
  });},
  async fail(claim,{review=false}={}){return tx(async c=>{
   const row=await current(c,claim);if(!row)return false;
   const message=review?'Payment evidence needs operator review. Do not send another payment.':'Verification is temporarily unavailable. Your last verified result is retained.';
   await c.query(`UPDATE relay_live_orders SET result=result||jsonb_build_object('trackingError',$2::text,'trackingAttemptedAt',now()),status=CASE WHEN $3 THEN 'checkout_review' ELSE status END,review_required=review_required OR $3,generation=generation+1,lease_token=NULL,lease_until=NULL,attempts=attempts+1,next_check_at=now()+least(3600,30*power(2,least(attempts,7)))*interval '1 second',updated_at=now() WHERE id=$1`,[row.id,message,review]);
   if(review&&!row.review_required)await c.query("INSERT INTO relay_live_audit(order_id,event) VALUES($1,'review_required')",[row.id]);return true;
  });},
  async accept(event){
   if(event.environment!=='LIVE'||event.merchantId!==merchantId)throw new InputError('Wrong webhook environment or merchant.',403);
   return tx(async c=>{
    const r=await c.query(`INSERT INTO relay_live_webhooks(merchant_id,event_id,digest,delivery_id,provider_id,event_type,processed_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() ELSE NULL END) ON CONFLICT DO NOTHING RETURNING event_id`,[merchantId,event.eventId,event.digest,event.deliveryId,event.orderId,event.type,event.test]);
    if(!r.rows.length){const old=(await c.query('SELECT digest FROM relay_live_webhooks WHERE merchant_id=$1 AND(event_id=$2 OR digest=$3)',[merchantId,event.eventId,event.digest])).rows;check(!old.some(x=>x.digest!==event.digest),'Signed event identifier was reused with different content.');return {duplicate:true};}
    if(!event.test)await c.query('UPDATE relay_live_orders SET next_check_at=now() WHERE merchant_id=$1 AND provider_id=$2',[merchantId,event.orderId]);
    return {duplicate:false};
   });
  },
  async heartbeat(id){await query('INSERT INTO relay_live_workers(merchant_id,id) VALUES($1,$2) ON CONFLICT(merchant_id,id) DO UPDATE SET beat_at=now()',[merchantId,id]);},
  async health(){const r=await query("SELECT extract(epoch FROM(now()-max(beat_at))) AS age FROM relay_live_workers WHERE merchant_id=$1",[merchantId]);return {healthy:r.rows[0].age!==null&&Number(r.rows[0].age)<90};}
 };
}
