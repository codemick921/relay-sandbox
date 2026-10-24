import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createCustomerFunding} from '../hosted/customer-funding.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {remote} from './fixtures/live-evidence.mjs';
const envelope=data=>new Response(JSON.stringify({success:true,responseObject:data}));
test('live customer HTTP creates one real-contract checkout above old test limit, keeps tokens private and ownership/CSRF checks',async()=>{
 const f=await fixture();let server;try{
 const drafts=createFundingDrafts(f.store);await drafts.migrate();const tracker=createLiveStore(f.pool,{merchantId:'merchant'});await tracker.migrate();const accounts=createAccounts(f.store),login=await accounts.signup({email:'live-fixture@example.test',password:'correct lantern river meadow',name:'Fixture',acceptSandbox:true}),owner=(await accounts.session(login.token)).owner;
 const agent={id:randomUUID(),name:'Fixture wallet',address:remote().destinationAddress,network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);let posts=0;const connection={environment:'LIVE',merchantId:'merchant',apiKey:'fixture'};
 const funding=createCustomerFunding({drafts,tracker,reader:{refresh:async()=>({status:'checkout_ready',chargebackStatus:'NONE'})},connection,origin:'https://relay.example',fetcher:async(url,options)=>{if(url.endsWith('/me'))return envelope({id:'merchant',environment:'LIVE',merchantConfig:{quotePreference:'PREFER_SAR',feePayer:'MERCHANT',buyerFeeShareBps:0,enabledRails:['wise','revolut']}});posts++;const b=JSON.parse(options.body);assert.equal(b.requestedFiatAmount,'25.00');assert.equal(b.destinationAddress,agent.address);assert.equal(b.dynamicOrdersEnabled,false);return envelope({order:{...remote(),status:'CREATED',enabledRails:['revolut'],buyerFeeShareBps:0,notes:{relayOrderId:b.idempotencyKey},successUrl:b.successUrl},orderToken:'private-test-checkout-token'});}});
 const live={simulated:false,store:tracker,funding,status:async()=>({paymentsEnabled:true}),policy:{status:async()=>({})}};
 server=createHostedServer({store:f.store,fundingDrafts:drafts,liveObservation:live,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(path,data,token=login.token,origin='https://relay.example')=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:data?'POST':'GET',headers:{host:'relay.example',origin,'content-type':'application/json',cookie:'__Host-relay_sandbox='+token}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(b)}));});q.on('error',reject);q.end(data?JSON.stringify(data):undefined);});
 assert.equal((await request('/healthz')).data.realPaymentsEnabled,true);assert.equal(posts,0);
 const created=await request('/api/funding/drafts',{requestId:randomUUID(),agentId:agent.id,amount:'25',rail:'revolut',confirm:true});assert.equal(created.status,200);const id=created.data.selectedFundingDraftId,input={id,confirm:true,consent:true};
 assert.equal((await request('/api/funding/checkout',input,'')).status,401);assert.equal((await request('/api/funding/checkout',input,login.token,'https://evil.example')).status,403);assert.equal(posts,0);
 const result=await Promise.all([request('/api/funding/checkout',input),request('/api/funding/checkout',input)]);assert.ok(result.every(r=>r.status===200));assert.equal(posts,1);
 const state=await request('/api/state');assert.equal(state.data.paymentsDisabled,false);assert.equal(state.data.liveFunding.paymentsEnabled,true);assert.ok(!JSON.stringify(state).includes('private-test-checkout-token'));assert.equal(state.data.orders.length,1);assert.equal(state.data.orders[0].delivery,undefined);
 assert.match((await request('/api/funding/resume',{id,confirm:true})).data.checkoutUrl,/private-test-checkout-token/);
 const other=await accounts.signup({email:'other-live@example.test',password:'correct lantern river meadow',name:'Other',acceptSandbox:true});assert.equal((await request('/api/funding/resume',{id,confirm:true},other.token)).status,404);
 // Unresolved and active-order guards remain business integrity controls, not test limits.
 assert.equal((await request('/api/funding/drafts',{requestId:randomUUID(),agentId:agent.id,amount:'50',rail:'revolut',confirm:true})).status,409);assert.equal(posts,1);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
