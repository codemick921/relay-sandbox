import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {agentRequestProgress} from '../hosted/agent-request-progress.mjs';
import {comparisonFixture,now} from './fixtures/cost-comparison.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createAccountSecurity} from '../hosted/account-security.mjs';
import {createAgentConnections} from '../hosted/agent-connections.mjs';
import {createAgentFundingRequests} from '../hosted/agent-funding-requests.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {local,remote,payment,rpc} from './fixtures/live-evidence.mjs';
async function sample(){
 const {order}=await comparisonFixture();order.agent={...order.agent,network:'Base',token:'USDC'};order.providerStatus='FULFILLED';order.chargebackStatus='NONE';order.checkedAt=new Date(now).toISOString();
 const draft={id:order.id,owner:'sample',agent:order.agent,agent_revision:1,pence:2500,currency:'GBP',rail:'wise',status:'bound',merchant_id:'merchant',provider_id:order.providerOrderId};
 const request={draft_id:order.id,owner:'sample',agent:order.agent,agent_revision:1};return {order,draft,request};
}
test('final receipt projects exact USDC arrival separately from request preparation',async()=>{
 const {order,draft,request}=await sample(),p=agentRequestProgress(request,draft,order,now);
 assert.equal(p.state,'funds_arrived');assert.equal(p.paymentConfirmed,true);assert.equal(p.deliveryConfirmed,true);assert.equal(p.receivedUsdc,'11.881250');assert.equal(p.nextAction,'none');
});
test('Peer settlement and non-final receipt do not imply arrival',async()=>{
 const {order,draft,request}=await sample();
 for(const status of ['checkout_settled','checkout_confirming']){
  const p=agentRequestProgress(request,draft,{...order,status,delivery:null,verification:{...order.verification,receivedRaw:'0',payments:order.verification.payments.map(x=>({...x,receipt:null,deliveryStatus:status==='checkout_confirming'?'confirming':'pending'}))}},now);
  assert.equal(p.paymentConfirmed,true);assert.equal(p.deliveryConfirmed,false);assert.equal(p.receivedUsdc,null);assert.equal(p.state,status==='checkout_confirming'?'confirming':'payment_confirmed');
 }
});
test('wrong receipt identity, amount, duplicate receipt or missing finality never reports arrival',async()=>{
 const {order,draft,request}=await sample();
 for(const patch of [{chainId:1},{tokenAddress:'0x'+'2'.repeat(40)},{recipient:'0x'+'2'.repeat(40)},{amountRaw:'1'},{finalized:false}]){
  const bad={...order,delivery:{...order.delivery,...patch}};
  assert.equal(agentRequestProgress(request,draft,bad,now).state,'needs_attention');assert.equal(agentRequestProgress(request,draft,bad,now).deliveryConfirmed,false);
 }
 const duplicate={...order,verification:{...order.verification,payments:[...order.verification.payments,...order.verification.payments]}};
 assert.equal(agentRequestProgress(request,draft,duplicate,now).deliveryConfirmed,false);
});
test('stale, future, unavailable, disputed and simulated evidence cannot become success',async()=>{
 const {order,draft,request}=await sample();
 const cases=[{checkedAt:new Date(now-3900001).toISOString()},{checkedAt:new Date(now+6000).toISOString()},{trackingError:'sample outage'},{trackingPending:true},{reviewRequired:true},{chargebackStatus:'CHARGEBACKED'},{fixture:true},{source:'simulation'},{verification:{...order.verification,simulated:true}},{verification:{...order.verification,environment:'SANDBOX'}}];
 for(const patch of cases){const p=agentRequestProgress(request,draft,{...order,...patch},now);assert.equal(p.state,'needs_attention');assert.equal(p.deliveryConfirmed,false);assert.equal(p.paymentConfirmed,false);assert.equal(p.receivedUsdc,null);}
});
test('held payout reports attention and confirmed payment but not arrival',async()=>{
 const {order,draft,request}=await sample();
 const p=agentRequestProgress(request,draft,{...order,status:'checkout_settled',delivery:null,verification:{...order.verification,receivedRaw:'0',payments:order.verification.payments.map(x=>({...x,receipt:null,deliveryStatus:'held',payout:{status:'HELD'}}))}},now);
 assert.equal(p.state,'needs_attention');assert.equal(p.attentionReason,'payout_held');assert.equal(p.paymentConfirmed,true);assert.equal(p.deliveryConfirmed,false);
});
test('request, wallet, draft, provider, fiat and merchant mismatches are withheld',async()=>{
 const {order,draft,request}=await sample();
 for(const patch of [{owner:'other'},{id:randomUUID()},{agent_revision:2},{agent:{...draft.agent,id:'other'}},{provider_id:'other'},{merchant_id:'other'},{pence:1},{currency:'USD'},{rail:'revolut'}]){
  const p=agentRequestProgress(request,{...draft,...patch},order,now);assert.equal(p.state,'needs_attention');assert.equal(p.paymentConfirmed,false);
 }
});
test('missing records and ended drafts do not mean payment cancellation',async()=>{
 const {draft,request}=await sample();
 assert.equal(agentRequestProgress({...request,draft_id:null},null,null,now).state,'not_started');
 assert.equal(agentRequestProgress(request,{...draft,status:'draft',provider_id:null},null,now).state,'prepared');
 assert.equal(agentRequestProgress(request,{...draft,status:'cancelled',provider_id:null},null,now).state,'ended');
 assert.equal(agentRequestProgress(request,draft,null,now).state,'needs_attention');
});

test('HTTP status reads exact bound sample tracking and never writes business records or invokes providers',async()=>{
 if(process.env.TEST_DATABASE_URL){const u=new URL(process.env.TEST_DATABASE_URL);if(u.hostname!=='127.0.0.1'||u.pathname!=='/relay_test')throw Error('Use the dedicated loopback relay_test database only.');}
 const f=await fixture();let server;try{
  const drafts=createFundingDrafts(f.store);await drafts.migrate();const accounts=createAccounts(f.store),password='sample only river meadow lantern';
  const account=await accounts.signup({email:'status@example.test',name:'Sample',password,acceptSandbox:true}),owner=(await accounts.session(account.token)).owner;
  const agent={id:randomUUID(),name:'Sample agent',address:'0x'+'1'.repeat(40),network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);
  const security=createAccountSecurity(f.store,accounts),connections=createAgentConnections(f.store,security,{merchantId:'merchant'}),requests=createAgentFundingRequests(f.store);
  const settings={agentId:agent.id,name:'Sample status',maxTargetUsdc:'25',dailyLimit:5,expiresInDays:7,confirm:true,currentPassword:password};
  const key=await connections.create(settings,account.token),r=await connections.submit(key.key,randomUUID(),{purpose:'Sample request only',targetUsdc:'12',expiresInHours:24});
  const d=await drafts.prepare(owner,{requestId:randomUUID(),agentId:agent.id,amount:'25',rail:'wise',currency:'GBP',confirm:true,fundingRequestId:r.id});
  const tracker=createLiveStore(f.pool,{merchantId:'merchant'});await tracker.migrate();
  // All below are synthetic records in this disposable database; no provider or checkout writer.
  const claim=await drafts.claim(owner,d.id,'merchant');await drafts.bind(claim,{merchantId:'merchant',providerOrderId:'peer-order',requestedUsdcAmount:'12.5'},tracker);
  const intent={...local(),id:d.id,agent,quote:{pence:2500,currency:'GBP',platform:'wise'}};
  server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true,fundingDrafts:drafts,liveObservation:{simulated:false,store:tracker},pay:{readiness:()=>{throw Error('Provider forbidden');}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const get=()=>new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/agent/v1/funding-requests/'+r.id,headers:{host:'relay.example',authorization:'Bearer '+key.key}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));}).on('error',reject);});
  for(const [state,sampleRpc] of [['payment_confirmed',rpc({getTransactionReceipt:async()=>{const e=Error();e.name='TransactionReceiptNotFoundError';throw e;}})],['confirming',rpc({getBlock:async({blockTag})=>({...await rpc().getBlock({blockTag}),number:blockTag==='finalized'?119n:120n})})],['funds_arrived',rpc()]]){
   const update=await verifyPayDelivery(intent,remote(),[payment()],{rpc:sampleRpc});
   await tracker.apply(await tracker.claimNext({orderId:d.id}),{...update,checkedAt:update.verification.checkedAt,providerStatus:'FULFILLED',chargebackStatus:'NONE'});
   const before={requests:await requests.list(owner),drafts:await drafts.list(owner),orders:await tracker.state(owner)};
   const response=await get();assert.equal(response.status,200);assert.equal(response.data.status,'funding_prepared');assert.equal(response.data.progress.state,state);assert.equal(response.data.progress.deliveryConfirmed,state==='funds_arrived');assert.equal(response.data.progress.receivedUsdc,state==='funds_arrived'?'12.000000':null);
   assert.deepEqual({requests:await requests.list(owner),drafts:await drafts.list(owner),orders:await tracker.state(owner)},before);
   assert.ok(!JSON.stringify(response.data).includes('checkout_url'));assert.ok(!JSON.stringify(response.data).includes(key.key));
  }
  const other=await connections.create({...settings,name:'Other'},account.token);await assert.rejects(connections.status(other.key,r.id),e=>e.status===404);
  assert.equal((await createAgentConnections(f.store,security,{merchantId:'wrong'}).status(key.key,r.id)).progress.state,'needs_attention');
  await connections.revoke({id:key.id,currentPassword:password},account.token);assert.equal((await get()).status,401);
  assert.equal((await f.store.state(owner)).orders.length,0);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});

test('freshness matches hourly final-receipt checks and shorter unfinished checks',async()=>{
 const {order,draft,request}=await sample();
 assert.equal(agentRequestProgress(request,draft,order,now+30*60*1000).state,'funds_arrived');
 const pending={...order,status:'checkout_settled',delivery:null};
 const p=agentRequestProgress(request,draft,pending,now+16*60*1000);assert.equal(p.state,'needs_attention');assert.equal(p.attentionReason,'stale_evidence');assert.equal(p.paymentConfirmed,false);
});
