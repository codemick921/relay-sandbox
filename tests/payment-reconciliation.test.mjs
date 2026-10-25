import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createLiveStore,liveOrderView} from '../hosted/live-store.mjs';
import {prepareLiveObservation} from '../hosted/live-observation.mjs';
import {reconcileSavedPayment} from '../hosted/payment-reconciliation.mjs';
import {presentTrackedOrder,createLiveTrackingHandler} from '../hosted/live-http.mjs';
import {createCustomerNotifications} from '../hosted/customer-notifications.mjs';
import {paymentRecord,renderRecord} from '../hosted/payment-records.mjs';
import {remote,payment,rpc,receipt} from './fixtures/live-evidence.mjs';
import http from 'node:http';
async function setup(){
 const f=await fixture(),drafts=createFundingDrafts(f.store),tracker=createLiveStore(f.pool,{merchantId:'merchant'});await drafts.migrate();await tracker.migrate();
 const owner='customer:'+randomUUID(),agent={id:randomUUID(),name:'Reconciliation fixture',address:remote().destinationAddress,network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);
 const draft=await drafts.prepare(owner,{requestId:randomUUID(),agentId:agent.id,amount:'25',rail:'wise',confirm:true}),claim=await drafts.claim(owner,draft.id,'merchant');
 // Existing synthetic provider binding. No provider writer is constructed or called.
 await drafts.bind(claim,{merchantId:'merchant',providerOrderId:'peer-order',requestedUsdcAmount:'12.5',checkoutUrl:null},tracker);
 let phase='unpaid',calls=0,fail=false;
 const provider={...remote(),notes:{relayOrderId:draft.id}},p=payment();
 const observation=await prepareLiveObservation({pool:f.pool,base:f.store,drafts,connection:{environment:'LIVE',mode:'receive_only',merchantId:'merchant',apiKey:'synthetic-only'},fetcher:async(url,options)=>{
  calls++;assert.equal(options.method,'GET');if(fail)throw Error('synthetic outage');
  return new Response(JSON.stringify({success:true,responseObject:url.endsWith('/me')?{id:'merchant',environment:'LIVE'}:url.endsWith('/payments')?{payments:phase==='unpaid'?[]:[p]}:{merchant:{id:'merchant',environment:'LIVE'},order:phase==='unpaid'?{...provider,status:'CREATED',remainingUsdcAmount:'12.5'}:provider,currentPayment:phase==='unpaid'?null:p}}));
 },rpc:rpc({getTransactionReceipt:async()=>{if(phase==='missing')throw {name:'TransactionReceiptNotFoundError'};return receipt(p);},getBlock:async({blockTag})=>({hash:receipt(p).blockHash,number:blockTag==='finalized'&&phase==='confirming'?119n:120n})})});
 const read=async()=>({row:await tracker.owned(owner,draft.id),ledger:(await f.store.query('SELECT * FROM relay_live_payments WHERE order_id=$1',[draft.id])).rows,draft:await drafts.review(owner,draft.id)});
 return {...f,drafts,tracker,owner,id:draft.id,observation,read,get calls(){return calls;},set phase(v){phase=v;},set fail(v){fail=v;},advance:async()=>{await f.store.query('UPDATE relay_live_orders SET next_check_at=now() WHERE id=$1',[draft.id]);await observation.tick();},close:async()=>{await observation.stop();await f.close();}};
}
async function complete(f){f.phase='final';await f.advance();}

test('saved journey reconciles payment, finality, ledger, closed draft and downloadable receipt without a provider writer',async()=>{
 const f=await setup();try{
  for(const [phase,status] of [['unpaid','checkout_ready'],['missing','checkout_settled'],['confirming','checkout_confirming'],['final','checkout_received']]){
   f.phase=phase;await f.advance();const x=await f.read(),r=reconcileSavedPayment(x.row,x.ledger,x.draft),record=paymentRecord(liveOrderView(x.row));
   assert.equal(x.row.status,status);assert.equal(record.deliveryConfirmed,phase==='final');assert.equal(r.status,phase==='final'?'matched':'incomplete');
   assert.equal(record.document,phase==='final'?'receipt':'summary');
   if(phase==='final'){assert.equal(x.draft.status,'closed');assert.equal(x.ledger.length,1);assert.equal(record.confirmedUsdc,'12.000000');assert.equal(record.peerFeeUsdc,'0.500000');assert.match(renderRecord(record,'csv'),/12.000000/);}
  }
  const before=await f.read();await f.advance();const after=await f.read();assert.equal(after.ledger.length,1);assert.deepEqual(after.ledger.map(p=>p.transaction_hash),before.ledger.map(p=>p.transaction_hash));
  assert.equal((await f.observation.status()).paymentsEnabled,false);
  const calls=f.calls,health=await f.tracker.paymentHealth({id:f.id});assert.equal(health.detail.reconciliation.status,'matched');assert.equal(f.calls,calls);
  assert.deepEqual((await f.read()).ledger,after.ledger); // Admin read has no payment writes.
 }finally{await f.close();}
});

test('saved reconciliation detects missing, extra, changed and mismatched ledger/draft evidence',async()=>{
 const f=await setup();try{await complete(f);const x=await f.read();
  for(const mutate of [y=>y.ledger.splice(0),y=>y.ledger.push({...y.ledger[0],payment_id:'extra'}),y=>y.ledger[0].amount_raw='1',y=>y.ledger[0].recipient='0x'+'22'.repeat(20),y=>y.ledger[0].receipt.blockHash='0x'+'33'.repeat(32),y=>y.ledger[0].finalized=false,y=>y.draft.pence=1,y=>y.draft.requested_usdc='12.500001',y=>y.row.request.providerOrderId='different']){
   const y=structuredClone(x);mutate(y);assert.equal(reconcileSavedPayment(y.row,y.ledger,y.draft).status,'inconsistent');
  }
  assert.equal(reconcileSavedPayment(x.row,x.ledger,null).status,'incomplete');
  const y=structuredClone(x);y.draft.requested_usdc='12.500000';assert.equal(reconcileSavedPayment(y.row,y.ledger,y.draft).status,'matched');
  y.draft.status='bound';assert.equal(reconcileSavedPayment(y.row,y.ledger,y.draft).status,'incomplete');
  await f.store.query("UPDATE relay_live_payments SET amount_raw=1 WHERE order_id=$1",[f.id]);
  const before=await f.read(),calls=f.calls;const report=await f.tracker.paymentHealth({id:f.id});assert.equal(report.detail.reconciliation.status,'inconsistent');assert.equal(f.calls,calls);assert.deepEqual(await f.read(),before);
  const text=JSON.stringify(report.detail.reconciliation);for(const forbidden of ['synthetic-only',f.owner,'checkout_url','intent_hash'])assert.ok(!text.includes(forbidden));
 }finally{await f.close();}
});

test('payment-level dispute appears in admin queue and attention notices even when aggregate status is NONE',async()=>{
 const f=await setup();try{await complete(f);await f.store.query("UPDATE relay_live_orders SET result=jsonb_set(result,'{verification,payments,0,chargebackStatus}','\"CHARGEBACKED\"'::jsonb) WHERE id=$1",[f.id]);
  const x=await f.read();assert.equal(x.row.result.chargebackStatus,'NONE');assert.equal(presentTrackedOrder(liveOrderView(x.row)).chargebackRecorded,true);
  const health=await f.tracker.paymentHealth({id:f.id,filter:'review'});assert.equal(health.counts.review,1);assert.equal(health.detail.reconciliation.status,'attention');assert.equal(health.detail.record.code,'disputed');
  const notices=createCustomerNotifications(f.store,{scopes:[{merchantId:'merchant'}]});await notices.sync(f.owner);const list=await notices.list(f.owner);assert.equal(list.total,1);assert.equal(list.items[0].kind,'attention');assert.ok(!list.items.some(n=>n.kind==='arrival'));
 }finally{await f.close();}
});

test('outage preserves dated historical proof; conflicting receipts cannot be exported or presented as delivered',async()=>{
 const f=await setup();let server;try{await complete(f);const before=await f.read();f.fail=true;await f.advance();const after=await f.read();assert.equal(after.row.result.checkedAt,before.row.result.checkedAt);assert.equal(paymentRecord(liveOrderView(after.row)).trackingUnavailable,true);assert.equal(reconcileSavedPayment(after.row,after.ledger,after.draft).status,'matched');
  await f.store.query("UPDATE relay_live_orders SET result=jsonb_set(result,'{delivery,receipts}','[]'::jsonb) WHERE id=$1",[f.id]);
  const corrupt=await f.read();assert.equal(presentTrackedOrder(liveOrderView(corrupt.row)).status,'checkout_review');assert.equal(paymentRecord(liveOrderView(corrupt.row)).document,'summary');
  const handler=createLiveTrackingHandler({store:f.tracker,origin:'https://relay.example',authenticate:async()=>f.owner,rateLimit:async()=>{},allowHttpForTests:true});server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const response=await new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/live-tracking/orders/'+f.id+'/receipt',headers:{host:'relay.example'}},r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>resolve({status:r.statusCode,body}));}).on('error',reject);});assert.equal(response.status,409);assert.ok(!response.body.includes('transactionHash'));
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
