import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createLiveStore,liveOrderView} from '../hosted/live-store.mjs';
import {createCustomerFunding} from '../hosted/customer-funding.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
import {createLiveFunding} from '../hosted/live-funding.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
const envelope=data=>new Response(JSON.stringify({success:true,responseObject:data}));
async function setup(){
 const f=await fixture(),drafts=createFundingDrafts(f.store),tracker=createLiveStore(f.pool,{merchantId:'merchant'});await drafts.migrate();await tracker.migrate();
 const accounts=createAccounts(f.store),login=await accounts.signup({email:'cancel@example.test',name:'Cancellation fixture',password:'lantern river meadow fixture',acceptSandbox:true}),owner=(await accounts.session(login.token)).owner;
 const agent={...local().agent,id:randomUUID(),network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);
 const next=amount=>drafts.prepare(owner,{agentId:agent.id,requestId:randomUUID(),amount,confirm:true,rail:'wise'});
 const {id}=await next('25'),claim=await drafts.claim(owner,id,'merchant');
 await drafts.bind(claim,{merchantId:'merchant',providerOrderId:'peer-order',requestedUsdcAmount:'12.5',checkoutUrl:'https://pay.peer.xyz/?order=peer-order&token=fixture'},tracker);
 let status='CREATED',payments=[];const calls=[];
 const fetcher=async(url,options)=>{calls.push(options.method);assert.equal(options.method,'GET');if(url.endsWith('/me'))return envelope({id:'merchant',environment:'LIVE'});if(url.endsWith('/payments'))return envelope({payments});return envelope({merchant:{id:'merchant',environment:'LIVE'},order:{...remote(),id:'peer-order',status,remainingUsdcAmount:status==='FULFILLED'?'0':'12.5',notes:{relayOrderId:id}},currentPayment:payments.at(-1)??null});};
 const reader=createLiveReadService({apiKey:'fixture',merchantId:'merchant',rpc:rpc(),fetcher}),funding=createCustomerFunding({drafts,tracker,reader,connection:{environment:'LIVE',merchantId:'merchant',apiKey:'fixture'},origin:'https://relay.example',fetcher});
 const worker=createLiveFunding({drafts,tracker,reader}).createWorker();
 return {...f,drafts,tracker,accounts,login,owner,agent,id,next,reader,funding,calls,worker,set:(s,p=[])=>{status=s;payments=p;}};
}
const request=f=>f.funding.requestCancellation(f.owner,{id:f.id,confirmNoPayment:true});
test('cancellation request is durable and idempotent, blocks checkout and replacement until Peer confirms cancellation',async()=>{const f=await setup();try{
 await Promise.all([request(f),request(f)]);assert.equal((await f.drafts.list(f.owner))[0].cancellationState,'requested');assert.equal((await f.drafts.cancellationQueue()).length,1);
 assert.equal((await f.pool.query("SELECT * FROM relay_funding_audit WHERE event='cancellation_requested'")).rows.length,1);
 await assert.rejects(f.drafts.checkout(f.owner,f.id),/awaiting/);await assert.rejects(f.next('30'),/existing/);
 const restarted=createFundingDrafts(f.store);await restarted.migrate();assert.equal((await restarted.list(f.owner))[0].cancellationState,'requested');
 f.set('CANCELLED');await f.worker.tick();const d=(await f.drafts.list(f.owner))[0];assert.equal(d.status,'cancelled');assert.equal(d.cancellationState,'confirmed');
 assert.equal((await f.tracker.state(f.owner)).orders[0].status,'checkout_cancelled');assert.equal((await f.drafts.cancellationQueue())[0].state,'confirmed');
 const row=await f.drafts.review(f.owner,f.id);assert.equal(row.checkout_url,null);assert.equal(row.pence,2500);assert.equal(row.provider_id,'peer-order');
 await request(f);const replacement=await f.next('30');assert.notEqual(replacement.id,f.id);assert.equal((await f.drafts.review(f.owner,replacement.id)).pence,3000);assert.ok(f.calls.every(x=>x==='GET'));
 }finally{await f.worker.stop();await f.close();}});

test('dashboard cancellation without a Eupova request also releases the draft; expiry and all attempts do not',async()=>{const f=await setup();try{
 for(const status of ['CREATED','EXPIRED','FAILED','CANCELLED']){
  f.set('CREATED',[{...payment(),status}]);await assert.rejects(request(f),/cannot cancel/);await f.tracker.schedule(f.owner,f.id);await f.worker.tick();await assert.rejects(f.next('20'),/existing/);assert.equal((await f.drafts.list(f.owner))[0].status,'bound');
 }
 // New fixture represents an independently cancelled order that never had an attempt.
 }finally{await f.worker.stop();await f.close();}
 const g=await setup();try{g.set('CANCELLED');await g.worker.tick();assert.equal((await g.drafts.list(g.owner))[0].cancellationState,'confirmed');await g.next('10');}finally{await g.worker.stop();await g.close();}});

test('payment starting after cancellation request prevents release and remains tracked',async()=>{const f=await setup();try{
 await request(f);f.set('CREATED',[{...payment(),status:'CREATED'}]);await f.worker.tick();assert.equal((await f.drafts.list(f.owner))[0].cancellationState,'blocked');await assert.rejects(f.next('20'),/existing/);
 f.set('FULFILLED',[payment()]);await f.tracker.schedule(f.owner,f.id);await f.worker.tick();assert.equal((await f.tracker.state(f.owner)).orders[0].status,'checkout_received');assert.equal((await f.drafts.list(f.owner))[0].status,'closed');assert.equal((await f.drafts.list(f.owner))[0].cancellationState,'blocked');
 }finally{await f.worker.stop();await f.close();}});

test('contradictory cancellation, missing history, chargebacks and stale eligibility cannot unlock replacement',async()=>{const f=await setup();try{
 await request(f);f.set('CANCELLED',[{...payment(),status:'EXPIRED'}]);await f.worker.tick();assert.equal((await f.tracker.state(f.owner)).orders[0].reviewRequired,true);assert.equal((await f.drafts.list(f.owner))[0].status,'bound');await assert.rejects(f.next('15'),/existing/);
 }finally{await f.worker.stop();await f.close();}
 const g=await setup();try{const checked=await g.reader.refresh(liveOrderView(await g.tracker.owned(g.owner,g.id)));
 for(const change of [{checkedAt:'invalid'},{checkedAt:new Date(Date.now()-120000).toISOString()},{chargebackStatus:'CHARGEBACKED'},{verification:{payments:[{status:'SETTLED'}]}}])await assert.rejects(g.drafts.requestCancellation(g.owner,g.id,{...checked,...change}),/cannot cancel/);
 assert.equal((await g.drafts.cancellationQueue()).length,0);
 }finally{await g.worker.stop();await g.close();}});

test('HTTP cancellation requires ownership, same-origin and no-payment confirmation; queue is not exposed to customers or testers',async()=>{const f=await setup();let server;try{
 const live={store:f.tracker,funding:f.funding,simulated:false,status:async()=>({paymentsEnabled:true}),policy:{status:async()=>({})}};
 server=createHostedServer({store:f.store,fundingDrafts:f.drafts,liveObservation:live,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const req=(data,token=f.login.token,origin='https://relay.example',path='/api/funding/request-cancellation')=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:data?'POST':'GET',headers:{host:'relay.example',origin,'content-type':'application/json',cookie:'__Host-relay_sandbox='+token}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(b)}));});q.on('error',reject);q.end(data?JSON.stringify(data):undefined);});
 const input={id:f.id,confirmNoPayment:true};assert.equal((await req(input,'')).status,401);assert.equal((await req(input,f.login.token,'https://evil.example')).status,403);assert.equal((await req({id:f.id})).status,400);
 const other=await f.accounts.signup({email:'other-cancel@example.test',name:'Other',password:'lantern river meadow fixture',acceptSandbox:true});assert.equal((await req(input,other.token)).status,404);assert.equal(f.calls.length,0);
 const result=await req(input);assert.equal(result.status,200);assert.equal(result.data.fundingDrafts[0].cancellationState,'requested');assert.equal(result.data.cancellationQueue,undefined);assert.ok(!JSON.stringify(result).includes('token=fixture'));
 assert.equal((await req(null,other.token,'https://relay.example','/api/state')).data.fundingDrafts.length,0);assert.equal((await req(null,f.login.token,'https://relay.example','/api/operator/cancellations')).status,404);
 assert.equal((await req(input,'','https://relay.example','/api/funding/stop')).status,401);
 assert.equal((await req({id:f.id},f.login.token,'https://relay.example','/api/funding/stop')).status,400);
 assert.equal((await req(input,other.token,'https://relay.example','/api/funding/stop')).status,404);
 assert.equal((await req(input,f.login.token,'https://evil.example','/api/funding/stop')).status,403);
 const stopped=await req(input,f.login.token,'https://relay.example','/api/funding/stop');assert.equal(stopped.status,200);assert.ok(stopped.data.fundingDrafts[0].stoppedAt);assert.equal(stopped.data.orders[0].stoppedInRelay,true);await f.next('10');
 }finally{if(server)await new Promise(r=>server.close(r));await f.worker.stop();await f.close();}});

 test('restart repairs a committed cancellation whose draft update was interrupted',async()=>{const f=await setup();try{
 f.set('CANCELLED');const claim=await f.tracker.claimNext();await f.tracker.apply(claim,await f.reader.refresh(liveOrderView(claim)));assert.equal((await f.drafts.list(f.owner))[0].status,'bound');
 const restarted=createFundingDrafts(f.store);await restarted.recoverStalled();await restarted.recoverStalled();assert.equal((await restarted.list(f.owner))[0].status,'cancelled');
 assert.equal((await f.pool.query("SELECT * FROM relay_funding_audit WHERE event='peer_cancellation_confirmed'")).rows.length,1);
 }finally{await f.worker.stop();await f.close();}});

test('customers can stop unpaid attempts immediately, preserve old evidence and create a separate checkout',async()=>{const f=await setup();try{
 f.set('CREATED',[{...payment(),status:'CREATED'}]);await f.worker.tick();
 await Promise.all([f.funding.stop(f.owner,{id:f.id,confirmNoPayment:true}),f.funding.stop(f.owner,{id:f.id,confirmNoPayment:true})]);
 const old=await f.drafts.review(f.owner,f.id);assert.ok(old.stopped_at);assert.equal(old.status,'bound');assert.equal(old.provider_id,'peer-order');assert.equal(old.pence,2500);
 await assert.rejects(f.funding.checkout(f.owner,f.id),/stopped/);await assert.rejects(f.drafts.checkout(f.owner,f.id),/stopped/);await assert.rejects(f.funding.start(f.owner,{id:f.id,confirm:true,consent:true}),/stopped/);
 const choices=await Promise.allSettled([f.next('30'),f.next('40')]);assert.equal(choices.filter(x=>x.status==='fulfilled').length,1);const next=choices.find(x=>x.status==='fulfilled').value;const newRow=await f.drafts.review(f.owner,next.id);let posts=0;
 const funding=createCustomerFunding({drafts:f.drafts,tracker:f.tracker,reader:f.reader,connection:{environment:'LIVE',merchantId:'merchant',apiKey:'fixture'},origin:'https://relay.example',fetcher:async(url,opts)=>{
 if(url.endsWith('/me'))return envelope({id:'merchant',environment:'LIVE',merchantConfig:{enabledRails:['wise']}});
 assert.equal(opts.method,'POST');posts++;const b=JSON.parse(opts.body);assert.equal(b.idempotencyKey,next.id);assert.equal(b.requestedFiatAmount,(newRow.pence/100).toFixed(2));
 return envelope({order:{...remote(),id:'new-peer-order',status:'CREATED',remainingUsdcAmount:'12.5',requestedFiat:{amount:b.requestedFiatAmount,currency:'GBP'},notes:{relayOrderId:next.id},successUrl:b.successUrl},orderToken:'new-fixture-token'});
 }});
 await funding.start(f.owner,{id:next.id,confirm:true,consent:true});assert.equal(posts,1);assert.equal((await f.drafts.review(f.owner,next.id)).status,'bound');
 // A late payment still arrives on its original order, never the replacement.
 f.set('FULFILLED',[payment()]);const lateClaim=await f.tracker.claimNext({orderId:f.id});assert.ok(lateClaim);await f.tracker.apply(lateClaim,await f.reader.refresh(liveOrderView(lateClaim)));await f.drafts.closeVerified(f.id);const orders=(await f.tracker.state(f.owner)).orders;
 assert.equal(orders.find(x=>x.id===f.id).status,'checkout_received');assert.equal(orders.find(x=>x.id===next.id).status,'checkout_ready');assert.equal(orders.find(x=>x.id===next.id).delivery,undefined);
 assert.equal((await f.pool.query("SELECT * FROM relay_funding_audit WHERE event='stopped_locally_customer_confirmed_no_payment'")).rows.length,1);
 }finally{await f.worker.stop();await f.close();}});

test('expired and failed attempts, including pending cancellation requests, can be stopped without provider writes',async()=>{
 for(const status of ['EXPIRED','FAILED','CANCELLED']){const f=await setup();try{
 await request(f);f.set('CREATED',[{...payment(),status}]);await f.funding.stop(f.owner,{id:f.id,confirmNoPayment:true});
 const restarted=createFundingDrafts(f.store);await restarted.migrate();assert.ok((await restarted.list(f.owner))[0].stoppedAt);assert.equal((await restarted.cancellationQueue())[0].state,'stopped_in_relay');await f.next('10');
 await assert.rejects(f.pool.query('UPDATE relay_funding_drafts SET stopped_at=NULL WHERE id=$1',[f.id]),/cannot be reopened/);assert.ok(f.calls.every(x=>x==='GET'));
 }finally{await f.worker.stop();await f.close();}}
});

test('stopping rejects known settlement, disputes, review holds and changed observations',async()=>{const f=await setup();try{
 await assert.rejects(f.funding.stop('customer:'+randomUUID(),{id:f.id,confirmNoPayment:true}),/not found/);await assert.rejects(f.funding.stop(f.owner,{id:f.id,confirmNoPayment:false}),/Confirm/);assert.equal(f.calls.length,0);
 const row=await f.tracker.owned(f.owner,f.id),checked=await f.reader.refresh(liveOrderView(row));
 await assert.rejects(f.drafts.stop(f.owner,f.id,checked,Number(row.generation)+1),/changed/);
 await assert.rejects(f.drafts.stop(f.owner,f.id,{...checked,verification:{...checked.verification,providerRemainingRaw:'1'}},row.generation),/Payment may/);
 await assert.rejects(f.drafts.stop(f.owner,f.id,{...checked,chargebackStatus:'CHARGEBACKED'},row.generation),/Payment may/);
 await assert.rejects(f.drafts.stop(f.owner,f.id,{...checked,checkedAt:new Date(Date.now()-120000).toISOString()},row.generation),/Payment may/);
 f.set('FULFILLED',[payment()]);await assert.rejects(f.funding.stop(f.owner,{id:f.id,confirmNoPayment:true}),/Payment may/);assert.equal((await f.drafts.review(f.owner,f.id)).stopped_at,null);await assert.rejects(f.next('10'),/existing/);
 }finally{await f.worker.stop();await f.close();}});


test('provider outage leaves the existing request active and unknown creation cannot be stopped',async()=>{const f=await setup();try{
 const unavailable=createCustomerFunding({drafts:f.drafts,tracker:f.tracker,reader:{refresh:async()=>{throw Error('Provider unavailable');}},connection:{environment:'LIVE',merchantId:'merchant',apiKey:'fixture'},origin:'https://relay.example'});
 await assert.rejects(unavailable.stop(f.owner,{id:f.id,confirmNoPayment:true}),/unavailable/);assert.equal((await f.drafts.review(f.owner,f.id)).stopped_at,null);await assert.rejects(f.next('10'),/existing/);
 await f.funding.stop(f.owner,{id:f.id,confirmNoPayment:true});const next=await f.next('10'),claim=await f.drafts.claim(f.owner,next.id,'merchant');await f.drafts.unresolved(claim);
 await assert.rejects(f.funding.stop(f.owner,{id:next.id,confirmNoPayment:true}),/reconciled/);await assert.rejects(f.next('12'),/existing/);
 }finally{await f.worker.stop();await f.close();}});
