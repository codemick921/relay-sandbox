import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
import {createLiveStore,trackingIntervalSeconds} from '../hosted/live-store.mjs';
import {createLiveWorker} from '../hosted/live-worker.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
const now=Date.now();

test('quiet old attempts back off while live quotes and pending delivery stay fast',()=>{
 const row={status:'checkout_ready',created_at:new Date(now-86400001).toISOString()};
 assert.equal(trackingIntervalSeconds(row,{verification:{currentAttempt:null}},now),3600);
 assert.equal(trackingIntervalSeconds({...row,created_at:new Date(now-1800001).toISOString()},{verification:{currentAttempt:{status:'EXPIRED'}}},now),300);
 for(const status of ['checkout_confirming','checkout_settled','checkout_partial'])assert.equal(trackingIntervalSeconds({...row,status},{},now),30);
 for(const quoteExpiresAt of [null,'invalid',new Date(now+60000).toISOString()])assert.equal(trackingIntervalSeconds(row,{verification:{currentAttempt:{status:'CREATED',quoteExpiresAt}}},now),30);
 assert.equal(trackingIntervalSeconds({...row,created_at:new Date(now).toISOString()},{},now),30);
});

test('manual refresh jumps a 43-order backlog, processes five, preserves FIFO fairness and owner isolation',async()=>{
 const f=await fixture(),store=createLiveStore(f.pool,{merchantId:'merchant'});await store.migrate();
 try{
  const orders=[];
  for(let i=0;i<43;i++){
   const o={...local(),id:randomUUID(),providerOrderId:'order-'+i,requestedUsdcAmount:'12.5',agent:{...local().agent,id:randomUUID(),network:'Base',token:'USDC'}};
   await store.bindTrustedOrder('alice',o);orders.push(o);
  }
  await store.query("UPDATE relay_live_orders SET created_at=now()-interval '2 days',next_check_at=now()-interval '1 hour'");
  for(const o of orders.slice(-5))await store.schedule('alice',o.id);
  await assert.rejects(store.schedule('bob',orders[0].id));
  const seen=[];
  const pay={refresh:async o=>{seen.push(o.id);return {status:'checkout_ready',providerStatus:'CREATED',chargebackStatus:'NONE',checkedAt:new Date().toISOString(),delivery:null,verification:{environment:'LIVE',payments:[],currentAttempt:null,providerFulfilled:false,providerRemainingRaw:'12500000',expectedNetRaw:'0',receivedRaw:'0'}};}};
  const worker=createLiveWorker({store,pay,maxBatch:5});await worker.tick();
  assert.equal(seen.length,5);assert.deepEqual(seen.slice(0,4),orders.slice(-5,-1).map(o=>o.id));assert.ok(!orders.slice(-5).some(o=>o.id===seen[4]));
  const checked=(await store.owned('alice',seen[0]));assert.ok(Date.parse(checked.next_check_at)-now>=3500000);
  // A fresh user refresh overrides the historical cadence and survives a new store instance.
  await store.schedule('alice',seen[0]);const restarted=createLiveStore(f.pool,{merchantId:'merchant'});const c=await restarted.claimNext();assert.equal(c.id,orders.at(-1).id);await restarted.fail(c);
  const next=await restarted.claimNext();assert.equal(next.id,seen[0]);
  await store.schedule('alice',next.id);await store.apply(next,await pay.refresh({...next.request}));
  assert.ok(Date.parse((await store.owned('alice',next.id)).next_check_at)<=Date.now()+1000,'refresh arriving during a read is retained');
  assert.equal(Number((await store.query('SELECT count(*) AS n FROM relay_live_orders')).rows[0].n),43);
  await worker.stop();
 }finally{await f.close();}
});

test('signed wakeup gains priority and finalized receipt remains valid without reading current wallet balance',async()=>{
 const f=await fixture(),store=createLiveStore(f.pool,{merchantId:'merchant'});await store.migrate();
 try{
  const o={...local(),id:randomUUID(),requestedUsdcAmount:'12.5',agent:{...local().agent,id:randomUUID(),network:'Base',token:'USDC'}};await store.bindTrustedOrder('alice',o);
  await store.accept({environment:'LIVE',merchantId:'merchant',orderId:o.providerOrderId,eventId:'event',digest:'a'.repeat(64),deliveryId:'delivery',type:'PAYMENT_SETTLED'});
  assert.ok((await store.owned('alice',o.id)).refresh_requested_at);
  const chain=rpc();chain.getBalance=()=>assert.fail('arrival must not depend on current balance');
  const p=payment();const pay=createLiveReadService({merchantId:'merchant',apiKey:'fixture',rpc:chain,fetcher:async(url,opts)=>{assert.equal(opts.method,'GET');return new Response(JSON.stringify({success:true,responseObject:url.endsWith('/me')?{id:'merchant',environment:'LIVE'}:url.endsWith('/payments')?{payments:[p]}:{merchant:{id:'merchant',environment:'LIVE'},order:{...remote(),notes:{relayOrderId:o.id}},currentPayment:p}}));}});
  const worker=createLiveWorker({store,pay});await worker.tick();let row=await store.owned('alice',o.id);assert.equal(row.status,'checkout_received');assert.equal(row.result.delivery.amountRaw,'12000000');
  await store.schedule('alice',o.id);await worker.tick();assert.equal(Number((await store.query('SELECT count(*) AS n FROM relay_live_payments')).rows[0].n),1);await worker.stop();
 }finally{await f.close();}
});
