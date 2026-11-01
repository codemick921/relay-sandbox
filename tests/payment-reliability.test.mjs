import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
import {createLiveStore,liveOrderView} from '../hosted/live-store.mjs';
import {createLiveReadService,TrackingReviewError} from '../server/pay-readonly.mjs';
import {createLiveWorker} from '../hosted/live-worker.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {EvidencePendingError} from '../server/pay-delivery.mjs';
import {paymentAttemptState,trackingState} from '../shared/tracking-status.mjs';
import {paymentRecord,renderRecord} from '../hosted/payment-records.mjs';
import {canContinueCheckout} from '../src/payment-resume.mjs';
const now=Date.now(),iso=n=>new Date(n).toISOString();
const ready=(payments,currentAttempt)=>({status:'checkout_ready',checkedAt:iso(now),verification:{payments,currentAttempt,providerFulfilled:false}});

test('attempt expiry never invents an expired checkout, refund, cancellation or receipt',()=>{
 const p={id:'p',status:'EXPIRED'},o=ready([p],p);assert.equal(paymentAttemptState(o),'expired');
 assert.equal(paymentRecord(o).code,'attempt_expired');assert.equal(paymentRecord(o).deliveryConfirmed,false);
 assert.equal(canContinueCheckout({status:'bound'},o,true),false);
 for(const status of ['checkout_partial','checkout_settled','checkout_confirming','checkout_received','checkout_cancelled','checkout_review'])assert.equal(paymentAttemptState({...o,status}),null);
 assert.equal(paymentAttemptState({...o,reviewRequired:true}),null);
 assert.equal(paymentAttemptState(ready([p,{id:'new',status:'CREATED'}],{id:'new',status:'CREATED'})),null);
 assert.equal(paymentAttemptState(ready([p,{id:'settled',status:'SETTLED'}],p)),null);
 assert.equal(paymentAttemptState(ready([p],null)),'expired');
});
test('elapsed saved quotes are distinct from provider expiry and malformed dates are not expiry evidence',()=>{
 const p={id:'p',status:'CREATED',quoteExpiresAt:iso(now-1)},o=ready([p],p);
 assert.equal(paymentAttemptState(o,now),'quote_elapsed');assert.equal(paymentAttemptState(o,now-2),null);
 for(const value of [null,undefined,'bad',false,{}])assert.equal(paymentAttemptState(ready([p],{...p,quoteExpiresAt:value}),now),null);
 assert.equal(o.status,'checkout_ready');
});
test('tracking delays do not replace payment or receipt state and recover on fresh evidence',()=>{
 const o={status:'checkout_received',checkedAt:iso(now-3600000)};
 assert.equal(trackingState(o,now).code,'current');
 assert.equal(trackingState({...o,trackingError:'unavailable'},now).code,'retrying');
 assert.equal(trackingState({...o,trackingPending:true},now).code,'evidence_pending');
 assert.equal(trackingState({...o,trackingSchedule:{nextCheckAt:iso(now-300001)}},now).code,'overdue');
 assert.equal(trackingState({...o,status:'checkout_ready'},now).code,'stale');
 assert.equal(trackingState({status:'checkout_ready'},now).code,'waiting');
 assert.equal(trackingState({...o,status:'checkout_review',trackingError:'error'},now).code,'review');
 assert.equal(trackingState({...o,status:'checkout_ready',checkedAt:iso(now+60000)},now).code,'stale');
 assert.equal(o.status,'checkout_received');
});
async function setup(owner='alice'){const f=await fixture(),s=createLiveStore(f.pool,{merchantId:'merchant'});await s.migrate();
 const o={...local(),id:randomUUID(),providerOrderId:'provider-'+randomUUID(),requestedUsdcAmount:'12.5',agent:{...local().agent,id:randomUUID(),network:'Base',token:'USDC'}};await s.bindTrustedOrder(owner,o);
 let current={...payment(),orderId:o.providerOrderId,status:'EXPIRED',quoteExpiresAt:iso(now-1000)},provider={...remote(),id:o.providerOrderId,status:'CREATED',remainingUsdcAmount:'12.5',notes:{relayOrderId:o.id}},mode='ok';
 const pay=createLiveReadService({apiKey:'synthetic-key',merchantId:'merchant',rpc:rpc(),fetcher:async(url,options)=>{
  assert.equal(options.method,'GET');if(mode==='outage')throw Error('PRIVATE TRANSPORT');
  const selected=mode==='converging'?{...current,status:'CREATED'}:mode==='expiry-drift'?{...current,quoteExpiresAt:iso(now+60000)}:current;
  const responseObject=url.endsWith('/merchants/me')?{id:'merchant',environment:'LIVE'}:url.endsWith('/payments')?{payments:[current]}:{merchant:{id:'merchant',environment:'LIVE'},order:provider,currentPayment:selected};
  return {ok:true,json:async()=>({success:true,responseObject})};
 }});
 return {...f,s,o,pay,setMode:m=>mode=m,settle:()=>{current={...payment(),orderId:o.providerOrderId};provider={...provider,status:'FULFILLED',remainingUsdcAmount:'0'};}};
}
test('expired attempt survives restart, outage and convergence, then late funds receive one exact receipt',async()=>{
 const f=await setup();try{
  let worker=createLiveWorker({store:f.s,pay:f.pay,maxBatch:1});await worker.tick();
  let o=(await f.s.state('alice')).orders[0];assert.equal(paymentAttemptState(o),'expired');assert.equal(o.status,'checkout_ready');assert.equal(o.verification.currentAttempt.status,'EXPIRED');assert.equal(paymentRecord(o).deliveryConfirmed,false);
  await worker.stop();const s=createLiveStore(f.pool,{merchantId:'merchant'});await s.migrate();worker=createLiveWorker({store:s,pay:f.pay,maxBatch:1});
  f.setMode('outage');await s.schedule('alice',o.id);await worker.tick();o=(await s.state('alice')).orders[0];assert.equal(trackingState(o).code,'retrying');assert.equal(paymentAttemptState(o),'expired');assert.ok(!JSON.stringify(o).includes('PRIVATE'));
  f.setMode('converging');await s.schedule('alice',o.id);await worker.tick();o=(await s.state('alice')).orders[0];assert.equal(trackingState(o).code,'evidence_pending');assert.equal(o.reviewRequired,false);assert.equal(paymentAttemptState(o),'expired');
  f.setMode('ok');f.settle();await s.schedule('alice',o.id);await worker.tick();o=(await s.state('alice')).orders[0];assert.equal(o.status,'checkout_received');assert.equal(paymentAttemptState(o),null);assert.equal(trackingState(o).code,'current');assert.equal(paymentRecord(o).deliveryConfirmed,true);
  await s.schedule('alice',o.id);await worker.tick();assert.equal(Number((await s.query('SELECT count(*) FROM relay_live_payments')).rows[0].count),1);
  assert.match(renderRecord(paymentRecord(o),'html'),/Wallet delivery receipt/);await worker.stop();
 }finally{await f.close();}
});
test('expiry projection cannot clear a security hold or accept an unknown checkout status',async()=>{
 const f=await setup();try{
  let claim=await f.s.claimNext();await f.s.fail(claim,{review:true});claim=await f.s.claimNext({orderId:f.o.id});await f.s.apply(claim,await f.pay.refresh(liveOrderView(claim)));
  const o=(await f.s.state('alice')).orders[0];assert.equal(o.status,'checkout_review');assert.equal(o.reviewRequired,true);assert.equal(paymentRecord(o).code,'review');
  const next=await f.s.claimNext({orderId:f.o.id}),result=await f.pay.refresh(liveOrderView(next));result.providerStatus='EXPIRED';await assert.rejects(()=>f.s.apply(next,result),TrackingReviewError);
 }finally{await f.close();}
});
test('expired attempt prevents checkout-link return without cancelling or releasing the request',async()=>{
 const owner='customer:'+randomUUID(),f=await setup(owner);try{
  const drafts=createFundingDrafts(f.store);await drafts.migrate();const o=f.o;
  await f.store.query("INSERT INTO relay_funding_drafts(id,owner,request_id,agent_id,agent_revision,agent,pence,status,merchant_id,attempt_token,attempted_at,provider_id,requested_usdc,checkout_url) VALUES($1,$7,$2,$3,1,$4,2500,'bound','merchant',$5,now(),$6,'12.5','https://private.invalid/token')",[o.id,randomUUID(),o.agent.id,o.agent,randomUUID(),o.providerOrderId,owner]);
  const claim=await f.s.claimNext();await f.s.apply(claim,await f.pay.refresh(liveOrderView(claim)));
  const before=(await f.store.query('SELECT * FROM relay_funding_drafts')).rows;await assert.rejects(()=>drafts.checkout(owner,o.id),e=>e.status===409&&/expired/.test(e.message));
  assert.deepEqual((await f.store.query('SELECT * FROM relay_funding_drafts')).rows,before);
  await assert.rejects(()=>drafts.checkout('customer:'+randomUUID(),o.id),e=>e.status===404);
 }finally{await f.close();}
});
test('notification diagnostics are bounded, merchant-scoped, redacted and read-only',async()=>{
 const f=await setup();try{
  for(let i=0;i<28;i++)await f.s.accept({environment:'LIVE',merchantId:'merchant',eventId:'e'+i,digest:i.toString(16).padStart(64,'0'),deliveryId:'PRIVATE-DELIVERY',orderId:i===0?f.o.providerOrderId:'foreign-'+i,type:i===0?'PAYMENT_EXPIRED':'PRIVATE_RAW_TYPE'},{matchedOnly:true});
  // A notification can predate a trusted local binding. Diagnose only; do not replay it.
  await f.s.query("UPDATE relay_live_webhooks SET unmatched=true,processed_at=now(),received_at=now()+interval '1 second' WHERE event_id='e0'");
  await f.s.query("INSERT INTO relay_live_webhooks(merchant_id,event_id,digest,delivery_id,event_type,unmatched) VALUES('other','HIDDEN',$1,'PRIVATE','PAYMENT_EXPIRED',true)",['f'.repeat(64)]);
  const before=(await f.s.query('SELECT * FROM relay_live_webhooks ORDER BY merchant_id,event_id')).rows;
  const x=await f.s.paymentHealth({filter:'all'});assert.equal(x.notifications.diagnostics.length,25);assert.equal(x.notifications.diagnosticsTruncated,true);assert.equal(x.notifications.unmatched,28);
  assert.equal(x.notifications.diagnostics[0].reason,'linked_since_receipt');assert.equal(x.notifications.diagnostics[0].relayOrderId,f.o.id);
  assert.ok(x.notifications.diagnostics.some(n=>n.reason==='no_saved_order'));for(const secret of ['PRIVATE','HIDDEN','foreign-','digest','deliveryId'])assert.ok(!JSON.stringify(x).includes(secret));
  assert.deepEqual((await f.s.query('SELECT * FROM relay_live_webhooks ORDER BY merchant_id,event_id')).rows,before);
 }finally{await f.close();}
});

test('inconsistent expiry reads wait for convergence and forged attempt metadata cannot be saved',async()=>{
 const f=await setup();try{
  f.setMode('expiry-drift');await assert.rejects(()=>f.pay.refresh(f.o),EvidencePendingError);
  f.setMode('ok');const claim=await f.s.claimNext(),result=await f.pay.refresh(liveOrderView(claim));
  result.verification.currentAttempt.id='unknown-payment';await assert.rejects(()=>f.s.apply(claim,result),TrackingReviewError);
  assert.equal((await f.s.state('alice')).orders[0].verification,undefined);
 }finally{await f.close();}
});
test('diagnostics distinguish absent order references from queued matched notifications',async()=>{
 const f=await setup();try{
  await f.s.accept({environment:'LIVE',merchantId:'merchant',eventId:'missing',digest:'a'.repeat(64),deliveryId:'a',type:'ORDER_CREATED'},{matchedOnly:true});
  await f.s.accept({environment:'LIVE',merchantId:'merchant',eventId:'queued',digest:'b'.repeat(64),deliveryId:'b',orderId:f.o.providerOrderId,type:'PAYMENT_EXPIRED'},{matchedOnly:true});
  const x=await f.s.paymentHealth();assert.deepEqual(new Set(x.notifications.diagnostics.map(n=>n.reason)),new Set(['no_order_reference','queued']));
  assert.equal(x.notifications.diagnostics.find(n=>n.reason==='queued').relayOrderId,f.o.id);
 }finally{await f.close();}
});
