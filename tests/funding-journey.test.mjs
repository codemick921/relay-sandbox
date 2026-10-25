import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {fixture} from './fixtures/account-store.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createLiveWorker} from '../hosted/live-worker.mjs';
import {createFundingJourney,journeyMerchant} from '../hosted/funding-journey.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createHostedServer} from '../hosted/server.mjs';
const password='correct meadow lantern river';
// Stage assertions require one claim per tick even when portable-disk IO exceeds the retry delay.
async function setup(){const f=await fixture(),store=createLiveStore(f.pool,{merchantId:journeyMerchant});await store.migrate();const journey=createFundingJourney({baseStore:f.store,store});await journey.migrate();const accounts=createAccounts(f.store),u=await accounts.signup({email:'customer@example.test',name:'Customer',password,acceptSandbox:true}),owner=(await accounts.session(u.token)).owner;const agent={id:randomUUID(),name:'Customer agent',address:'0x2222222222222222222222222222222222222222',network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);const worker=createLiveWorker({store:journey.workerStore(),pay:{refresh:o=>journey.refresh(o)},maxBatch:1});return {...f,base:f.store,store,journey,accounts,u,owner,agent,worker};}
async function create(f,amount='25'){const {quote}=await f.journey.quote(f.owner,{agentId:f.agent.id,amount});return {quote,...await f.journey.create(f.owner,{quoteId:quote.id,requestId:randomUUID(),confirm:true})};}
const read=async(f,id)=>(await f.store.state(f.owner)).orders.find(x=>x.id===id);
const tick=async(f,id)=>{await f.store.schedule(f.owner,id);await f.worker.tick();return read(f,id);};

test('customer quote to checkout to exact wallet receipt uses persistent staged verification without external calls',async()=>{
 const f=await setup();try{const {id,quote}=await create(f);assert.equal(quote.grossUsdc,'31.250000');assert.equal(quote.feeUsdc,'0.625000');assert.equal(quote.netUsdc,'30.625000');assert.equal((await read(f,id)).agent.address,f.agent.address);assert.equal((await tick(f,id)).status,'checkout_ready');
 await f.journey.action(f.owner,id,{action:'submit',scenario:'success',amount:1,recipient:'evil'});assert.equal((await read(f,id)).status,'checkout_ready');
 assert.equal((await tick(f,id)).status,'checkout_settled');assert.equal((await tick(f,id)).status,'checkout_confirming');const done=await tick(f,id);assert.equal(done.status,'checkout_received');assert.equal(done.delivery.amountRaw,'30625000');assert.equal(done.delivery.recipient,f.agent.address);assert.equal(done.delivery.finalized,true);assert.equal(done.delivery.receipts.length,1);
 // Restart objects/migrate without resetting order, quote or receipt.
 const restarted=createFundingJourney({baseStore:f.base,store:f.store});await restarted.migrate();const decorated=await restarted.decorate(f.owner,(await f.store.state(f.owner)).orders);assert.equal(decorated[0].journey,true);assert.equal(decorated[0].testSubmitted,true);assert.equal(decorated[0].journeyQuote.id,quote.id);
 const next=await f.accounts.password({currentPassword:password,password:'a different meadow lantern phrase'},f.u.token);assert.equal((await f.accounts.session(next.token)).owner,f.owner);assert.equal((await f.store.state(f.owner)).orders.length,1);
 }finally{await f.close();}
});
test('quote ownership, replay protection, expiry and cancellation guard immutable orders',async()=>{
 const f=await setup();try{const other='customer:'+randomUUID();await assert.rejects(f.journey.quote(other,{agentId:f.agent.id,amount:'25'}),/saved agent/);await assert.rejects(f.journey.quote(f.owner,{agentId:f.agent.id,amount:'1'}),/£2/);
 const {quote}=await f.journey.quote(f.owner,{agentId:f.agent.id,amount:'13.37'}),requestId=randomUUID(),input={quoteId:quote.id,requestId,confirm:true};await assert.rejects(f.journey.create(other,input),/expired/);const one=await f.journey.create(f.owner,input),two=await f.journey.create(f.owner,input);assert.equal(one.id,two.id);
 assert.equal((await f.journey.create(f.owner,{...input,requestId:randomUUID()})).id,one.id);assert.equal((await f.store.state(other)).orders.length,0);await assert.rejects(f.journey.action(other,one.id,{action:'submit',scenario:'success'}),e=>e.status===404);
 const newer=await f.journey.quote(f.owner,{agentId:f.agent.id,amount:'50'});await assert.rejects(f.journey.create(f.owner,{...input,quoteId:newer.quote.id}),/another test quote/);await assert.rejects(f.journey.create(f.owner,{...input,requestId:randomUUID(),quoteId:newer.quote.id}),/existing test order/);
 await f.journey.action(f.owner,one.id,{action:'cancel'});await assert.rejects(f.journey.action(f.owner,one.id,{action:'submit',scenario:'success'}),/ended/);assert.equal((await tick(f,one.id)).status,'checkout_cancelled');
 await f.store.query("UPDATE relay_fixture_quotes SET expires_at=now()-interval '1 second' WHERE id=$1",[newer.quote.id]);await assert.rejects(f.journey.create(f.owner,{...input,requestId:randomUUID(),quoteId:newer.quote.id}),/expired/);
 const fresh=await create(f);await f.store.query("UPDATE relay_fixture_checkouts SET expires_at=now()-interval '1 second' WHERE id=$1",[fresh.id]);assert.equal((await tick(f,fresh.id)).status,'checkout_cancelled');assert.equal((await f.journey.decorate(f.owner,[await read(f,fresh.id)]))[0].checkoutExpired,true);await assert.rejects(f.journey.action(f.owner,fresh.id,{action:'submit',scenario:'success'}),/ended/);
 }finally{await f.close();}
});
test('partial settlement retains first receipt and reaches completion only after the simulated remainder',async()=>{
 const f=await setup();try{const {id}=await create(f,'13.37');await f.journey.action(f.owner,id,{action:'submit',scenario:'partial'});const partial=await tick(f,id);assert.equal(partial.status,'checkout_partial');assert.equal(partial.delivery,null);assert.ok(BigInt(partial.verification.receivedRaw)>0n);const first=partial.verification.payments[0];
 await assert.rejects(f.journey.action(f.owner,id,{action:'cancel'}),/cannot be cancelled/);await assert.rejects(f.journey.action(f.owner,id,{action:'submit',scenario:'success'}),/different test payment/);
 await f.journey.action(f.owner,id,{action:'remainder'});await f.journey.action(f.owner,id,{action:'remainder'});const complete=await tick(f,id);assert.equal(complete.status,'checkout_received');assert.equal(complete.verification.payments[0].transactionHash,first.transactionHash);assert.equal(complete.delivery.receipts.length,2);assert.equal(complete.delivery.amountRaw,'16378250');
 }finally{await f.close();}
});
test('conflicting evidence remains held for review and cannot produce a receipt or replacement order',async()=>{
 const f=await setup();try{const {id}=await create(f);await f.journey.action(f.owner,id,{action:'submit',scenario:'review'});const review=await tick(f,id);assert.equal(review.status,'checkout_review');assert.equal(review.reviewRequired,true);assert.equal(review.delivery,undefined);await assert.rejects(create(f),/existing test order/);await assert.rejects(f.journey.action(f.owner,id,{action:'cancel'}),/cannot be cancelled/);
 }finally{await f.close();}
});
test('concurrent creates and submit/cancel cannot produce duplicate or contradictory orders',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await setup();try{const {quote}=await f.journey.quote(f.owner,{agentId:f.agent.id,amount:'25'}),input={quoteId:quote.id,requestId:randomUUID(),confirm:true};const results=await Promise.all([f.journey.create(f.owner,input),f.journey.create(f.owner,input)]);assert.equal(results[0].id,results[1].id);assert.equal((await f.store.state(f.owner)).orders.length,1);
 const id=results[0].id,outcomes=await Promise.allSettled([f.journey.action(f.owner,id,{action:'submit',scenario:'success'}),f.journey.action(f.owner,id,{action:'cancel'})]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);const row=(await f.store.query('SELECT * FROM relay_fixture_checkouts WHERE id=$1',[id])).rows[0];assert.ok(!!row.submitted_at!==!!row.cancelled_at);
 }finally{await f.close();}
});
test('connected HTTP journey scopes quotes, orders, refresh and receipt to the signed-in customer; provider endpoints remain blocked',async()=>{
 const f=await setup();let server;try{let calls=0;server=createHostedServer({store:f.base,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true,tracking:{store:f.store,journey:f.journey,simulated:true},pay:{readiness:()=>{calls++;throw Error('external');}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(path,data,cookie='__Host-relay_sandbox='+f.u.token,origin='https://relay.example')=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:data?'POST':'GET',headers:{host:'relay.example',origin,'content-type':'application/json',cookie}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(b)}));});q.on('error',reject);q.end(data?JSON.stringify(data):undefined);});
 assert.equal((await request('/api/state')).data.fundingJourneyEnabled,true);assert.equal((await request('/api/test-funding/quote',{agentId:f.agent.id,amount:'25'},'')).status,401);assert.equal((await request('/api/test-funding/quote',{agentId:f.agent.id,amount:'25'},undefined,'https://evil.example')).status,403);
 const q=await request('/api/test-funding/quote',{agentId:f.agent.id,amount:'25'});const c=await request('/api/test-funding/create',{quoteId:q.data.quote.id,requestId:randomUUID(),confirm:true,owner:'injected'});assert.equal(c.status,200);const id=c.data.selectedOrderId;assert.equal(c.data.orders[0].source,'fixture');assert.equal(c.data.orders[0].journey,true);
 const v=await f.accounts.signup({email:'other@example.test',name:'Other',password,acceptSandbox:true}),cookie='__Host-relay_sandbox='+v.token;assert.equal((await request('/api/state',null,cookie)).data.orders.length,0);assert.equal((await request('/api/test-funding/action',{id,action:'submit',scenario:'success'},cookie)).status,404);assert.equal((await request(`/api/live-tracking/orders/${id}/receipt`,null,cookie)).status,404);
 assert.equal((await request(`/api/live-tracking/orders/${id}/receipt`)).status,409);await request('/api/test-funding/action',{id,action:'submit',scenario:'success'});await tick(f,id);await tick(f,id);await tick(f,id);const proof=await request(`/api/live-tracking/orders/${id}/receipt`);assert.equal(proof.status,200);assert.equal(proof.data.environment,'SIMULATED');assert.equal(proof.data.delivery.recipient,f.agent.address);
 for(const path of ['/api/checkouts','/api/checkout-refresh','/api/webhooks/peer/sandbox'])assert.equal((await request(path,{})).status,403);assert.equal(calls,0);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});

test('separate web and worker startup share a durable isolated journey and restart without duplicating orders',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture(),schema='relay_tracking_sandbox_test_'+randomUUID().replaceAll('-','');let web,worker;
 try{const {prepareTrackingSandbox}=await import('../hosted/tracking-sandbox.mjs');[web,worker]=await Promise.all([prepareTrackingSandbox(f.store,[],{connectionString:process.env.TEST_DATABASE_URL,schema}),prepareTrackingSandbox(f.store,[],{connectionString:process.env.TEST_DATABASE_URL,schema})]);
 const owner='customer:'+randomUUID(),agent={id:randomUUID(),name:'Restart test',address:'0x3333333333333333333333333333333333333333',network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);
 const q=await web.journey.quote(owner,{agentId:agent.id,amount:'10'}),input={quoteId:q.quote.id,requestId:randomUUID(),confirm:true},o=await web.journey.create(owner,input);await web.journey.action(owner,o.id,{action:'submit',scenario:'success'});
 const bg=worker.createWorker();await bg.tick();assert.equal((await web.store.state(owner)).orders[0].status,'checkout_settled');await bg.stop();await web.close();web=null;
 web=await prepareTrackingSandbox(f.store,[],{connectionString:process.env.TEST_DATABASE_URL,schema});assert.equal((await web.journey.create(owner,input)).id,o.id);assert.equal((await web.store.state(owner)).orders.length,1);assert.equal((await web.journey.decorate(owner,(await web.store.state(owner)).orders))[0].testSubmitted,true);
 }finally{await web?.close();await worker?.close();await f.store.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await f.close();}
});
