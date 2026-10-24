import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createFundingDrafts,fundingIntent} from '../hosted/funding-drafts.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createLiveFunding} from '../hosted/live-funding.mjs';
import {createLiveCheckoutWriter} from '../server/pay-live-create.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
import {verifyWebhook} from '../server/pay-webhooks.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {prepareLiveObservation} from '../hosted/live-observation.mjs';
import {remote,payment,receipt,rpc} from './fixtures/live-evidence.mjs';
const password='funding fixture river meadow lantern';
const envelope=data=>new Response(JSON.stringify({success:true,responseObject:data}));
async function setup(){const f=await fixture(),drafts=createFundingDrafts(f.store),tracker=createLiveStore(f.pool,{merchantId:'merchant'});await drafts.migrate();await tracker.migrate();const accounts=createAccounts(f.store),account=await accounts.signup({email:'funding@example.test',name:'Funding fixture',password,acceptSandbox:true}),owner=(await accounts.session(account.token)).owner,agent={id:randomUUID(),name:'Agent fixture',address:'0x1111111111111111111111111111111111111111',network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);return {...f,drafts,tracker,accounts,account,owner,agent};}
const input=f=>({agentId:f.agent.id,requestId:randomUUID(),amount:'25',confirm:true});
const draft=async f=>f.drafts.prepare(f.owner,input(f));
const orderFor=id=>({...remote(),notes:{relayOrderId:id},successUrl:'https://relay.example/?checkout='+id});
function service(f,fetcher,authorise=()=>true){return createLiveFunding({drafts:f.drafts,tracker:f.tracker,merchantId:'merchant',origin:'https://relay.example',authorise,writer:createLiveCheckoutWriter({apiKey:'fixture-key',merchantId:'merchant',authorise,fetcher}),reader:createLiveReadService({apiKey:'fixture-read-key',merchantId:'merchant',rpc:rpc(),fetcher})});}

test('local drafts are owner-scoped, immutable, replay-safe, and never represent quotes or receipts',async()=>{const f=await setup();try{
 const b=input(f),a=await f.drafts.prepare(f.owner,b);assert.equal((await f.drafts.prepare(f.owner,b)).id,a.id);await assert.rejects(f.drafts.prepare(f.owner,{...b,amount:'30'}),/another/);
 await assert.rejects(f.drafts.prepare(f.owner,{...b,address:'injected'}),/Unsupported/);await assert.rejects(f.drafts.prepare('customer:'+randomUUID(),b),/saved/);
 assert.equal((await f.tracker.state(f.owner)).orders.length,0);assert.deepEqual((await f.drafts.list(f.owner)).map(x=>[x.status,x.source,x.walletCurrent]),[['draft','draft',true]]);
 await assert.rejects(f.store.query("UPDATE relay_funding_drafts SET pence=5000 WHERE id=$1",[a.id]),/Immutable/);await assert.rejects(f.drafts.cancel('customer:'+randomUUID(),{id:a.id}),/not found/);
 const restarted=createFundingDrafts(f.store);await restarted.migrate();assert.equal((await restarted.list(f.owner))[0].id,a.id);await restarted.cancel(f.owner,{id:a.id});assert.equal((await restarted.list(f.owner))[0].status,'cancelled');
 }finally{await f.close();}});

test('changed wallet blocks creation and disabled policies make zero provider calls',async()=>{const f=await setup();try{const d=await draft(f);let calls=0;const fetcher=async()=>{calls++;throw Error('no network');};
 await assert.rejects(service(f,fetcher,()=>false).start(f.owner,{id:d.id,confirm:true,consent:true}),/disabled/);assert.equal(calls,0);assert.equal((await f.drafts.list(f.owner))[0].status,'draft');
 await f.store.query("UPDATE relay_agents SET data=jsonb_set(data,'{address}','\"0x2222222222222222222222222222222222222222\"') WHERE id=$1",[f.agent.id]);assert.equal((await f.drafts.list(f.owner))[0].walletCurrent,false);await f.store.query('UPDATE relay_agents SET data=$2 WHERE id=$1',[f.agent.id,f.agent]);assert.equal((await f.drafts.list(f.owner))[0].walletCurrent,false);
 await assert.rejects(service(f,fetcher).start(f.owner,{id:d.id,confirm:true,consent:true}),/wallet has changed/);assert.equal(calls,0);
 }finally{await f.close();}});

test('concurrent start sends one fixed GBP/Wise POST, binds tracking atomically, then verifies final wallet arrival',async()=>{const f=await setup();try{const {id}=await draft(f),calls=[];let finalized=false;const p=payment(),remoteOrder=orderFor(id);let post;
 const fetcher=async(url,options)=>{calls.push([url,options.method??'GET']);assert.equal(options.redirect,'error');if(url.endsWith('/me'))return envelope({id:'merchant',environment:'LIVE',merchantConfig:{enabledRails:['wise']}});if(options.method==='POST'){post=JSON.parse(options.body);return envelope({order:{...remoteOrder,status:'CREATED'},orderToken:'private-fixture-token'});}if(url.endsWith('/payments'))return envelope({payments:[p]});return envelope({merchant:{id:'merchant',environment:'LIVE'},order:remoteOrder,currentPayment:p});};
 const flow=service(f,fetcher);const results=await Promise.all([flow.start(f.owner,{id,confirm:true,consent:true}),flow.start(f.owner,{id,confirm:true,consent:true})]);assert.equal(results.length,2);assert.equal(calls.filter(x=>x[1]==='POST').length,1);
 assert.equal(post.requestedFiatAmount,'25.00');assert.equal(post.requestedFiatCurrency,'GBP');assert.deepEqual(post.enabledRails,['wise']);assert.equal(post.dynamicOrdersEnabled,false);assert.equal(post.destinationAddress,f.agent.address);assert.equal(post.idempotencyKey,id);assert.equal(post.feePayer,'MERCHANT');
 assert.equal((await f.tracker.state(f.owner)).orders[0].id,id);assert.equal((await f.tracker.state(f.owner)).orders[0].delivery,undefined);assert.ok(!(JSON.stringify(await f.drafts.list(f.owner))).includes('private-fixture-token'));
 assert.match((await flow.checkout(f.owner,id)).checkoutUrl,/private-fixture-token/);await assert.rejects(flow.checkout('customer:'+randomUUID(),id),/not found/);
 const raw=Buffer.from(JSON.stringify({id:'event1',type:'PAYMENT_SETTLED',data:{order:remoteOrder,payment:p}})),timestamp=String(Math.floor(Date.now()/1000)),headers={'x-webhook-id':'delivery1','x-webhook-timestamp':timestamp,'x-webhook-signature':createHmac('sha256','fixture-secret').update(timestamp+'.').update(raw).digest('hex')};const event=verifyWebhook(raw,headers,{secret:'fixture-secret',merchantId:'merchant',environment:'LIVE'});assert.equal((await flow.acceptVerifiedEvent(event)).duplicate,false);assert.equal((await flow.acceptVerifiedEvent(event)).duplicate,true);
 const readOnly=createLiveReadService({apiKey:'fixture-read-key',merchantId:'merchant',fetcher,rpc:rpc({getBlock:async({blockTag})=>({hash:receipt().blockHash,number:blockTag==='finalized'&&!finalized?119n:120n})})});
 const connected=createLiveFunding({drafts:f.drafts,tracker:f.tracker,reader:readOnly});const worker=connected.createWorker();const before=calls.length;await worker.tick();assert.equal((await f.tracker.state(f.owner)).orders[0].status,'checkout_confirming');assert.equal((await f.drafts.list(f.owner))[0].status,'bound');finalized=true;await f.tracker.schedule(f.owner,id);await worker.tick();const arrived=(await f.tracker.state(f.owner)).orders[0];assert.equal(arrived.status,'checkout_received');assert.equal(arrived.delivery.amountRaw,'12000000');assert.equal(arrived.delivery.recipient,f.agent.address);assert.equal((await f.drafts.list(f.owner))[0].status,'closed');assert.ok(calls.slice(before).every(x=>x[1]==='GET'));
 }finally{await f.close();}});

test('unknown creation survives restart, blocks duplicate and cancellation, and reconciles with reads only',async()=>{const f=await setup();try{const {id}=await draft(f);let posts=0;const fetcher=async(url,options)=>{if(url.endsWith('/me'))return envelope({id:'merchant',environment:'LIVE',merchantConfig:{enabledRails:['wise']}});if(options.method==='POST'){posts++;throw Error('Response lost after provider accepted');}return envelope({merchant:{id:'merchant',environment:'LIVE'},order:orderFor(id)});};const flow=service(f,fetcher);assert.equal((await flow.start(f.owner,{id,confirm:true,consent:true})).unresolved,true);
 const restarted=service({...f,drafts:createFundingDrafts(f.store)},fetcher);await restarted.start(f.owner,{id,confirm:true,consent:true});assert.equal(posts,1);await assert.rejects(draft(f),/existing/);await assert.rejects(f.drafts.cancel(f.owner,{id}),/attempted/);assert.equal((await f.tracker.state(f.owner)).orders.length,0);
 await restarted.reconcile(f.owner,id,'peer-order');assert.equal(posts,1);assert.equal((await f.tracker.state(f.owner)).orders.length,1);await assert.rejects(restarted.checkout(f.owner,id),/unavailable/);
 }finally{await f.close();}});

test('provider mismatch cannot bind; DB binding failure rolls back both tables; late reply needs read reconciliation',async()=>{const f=await setup();try{const {id}=await draft(f);let changed=true;const fetcher=async(url,options)=>url.endsWith('/me')?envelope({id:'merchant',environment:'LIVE',merchantConfig:{enabledRails:['wise']}}):options.method==='POST'?envelope({order:{...orderFor(id),destinationAddress:'0x2222222222222222222222222222222222222222'},orderToken:'fixture'}):envelope({merchant:{id:'merchant',environment:'LIVE'},order:orderFor(id)});
 const flow=service(f,fetcher);assert.equal((await flow.start(f.owner,{id,confirm:true,consent:true})).unresolved,true);assert.equal((await f.tracker.state(f.owner)).orders.length,0);
 const claim=await f.drafts.attempted(f.owner,id),result={merchantId:'merchant',providerOrderId:'peer-order',requestedUsdcAmount:'12.5',checkoutUrl:null};const failing={bindTrustedOrder:async(owner,intent,{client})=>{await f.tracker.bindTrustedOrder(owner,intent,{client});throw Error('storage failure');}};await assert.rejects(f.drafts.bind(claim,result,failing,{reconciliation:true}),/storage/);assert.equal((await f.tracker.state(f.owner)).orders.length,0);assert.equal((await f.drafts.list(f.owner))[0].status,'unresolved');
 // Make an aged claim with an injectable read delay rather than rewriting immutable timestamps.
 const aged=createFundingDrafts(f.store,{clock:()=>Date.now()+61000});assert.equal((await aged.bind(claim,result,f.tracker)).unresolved,true);
 assert.equal((await f.tracker.state(f.owner)).orders.length,0);await flow.reconcile(f.owner,id,'peer-order');assert.equal((await f.tracker.state(f.owner)).orders.length,1);
 }finally{await f.close();}});

test('live writer rejects sandbox identity, unsupported route, foreign checkout URLs and never auto-retries',async()=>{let calls=0;const local={id:randomUUID(),merchantId:'merchant',source:'live',agent:{id:randomUUID(),name:'Agent',address:remote().destinationAddress,network:'Base',token:'USDC'},quote:{pence:2500,platform:'wise'}};
 const writer=createLiveCheckoutWriter({apiKey:'fixture',merchantId:'merchant',authorise:()=>true,fetcher:async()=>{calls++;return envelope({id:'merchant',environment:'SANDBOX',merchantConfig:{enabledRails:['wise']}});}});await assert.rejects(writer.create(local,'https://relay.example'),/live Wise/);assert.equal(calls,1);await assert.rejects(writer.create({...local,quote:{...local.quote,platform:'revolut'}},'https://relay.example'),/disabled/);assert.equal(calls,1);
 const {checkedLiveCheckoutUrl}=await import('../server/pay-live-create.mjs');for(const url of ['https://evil.example/?order=x&token=y&method=wise','https://pay.peer.xyz/?order=x&token=y&method=wise&token=z','https://pay.peer.xyz/?order=x&token=y&method=wise#secret'])assert.throws(()=>checkedLiveCheckoutUrl(url,'x'),/verified/);
});

test('hosted HTTP permits local drafts only; all live actions and cross-account access stay blocked',async()=>{const f=await setup();let server;try{let external=0;server=createHostedServer({store:f.store,fundingDrafts:f.drafts,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true,pay:{create:()=>external++,readiness:()=>external++}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const request=(path,data,token=f.account.token,origin='https://relay.example')=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:data?'POST':'GET',headers:{host:'relay.example',origin,'content-type':'application/json',cookie:'__Host-relay_sandbox='+token}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(b)}));});q.on('error',reject);q.end(data?JSON.stringify(data):undefined);});
 assert.equal((await request('/api/funding/drafts',input(f),'')).status,401);assert.equal((await request('/api/funding/drafts',input(f),undefined,'https://evil.example')).status,403);
 const created=await request('/api/funding/drafts',input(f));assert.equal(created.status,200);assert.equal(created.data.liveFunding.paymentsEnabled,false);assert.equal(created.data.orders.length,0);assert.equal(created.data.fundingDrafts[0].source,'draft');const id=created.data.selectedFundingDraftId;
 const other=await f.accounts.signup({email:'other@example.test',name:'Other',password,acceptSandbox:true});assert.equal((await request('/api/state',null,other.token)).data.fundingDrafts.length,0);assert.equal((await request('/api/funding/cancel',{id},other.token)).status,404);
 for(const route of ['funding/checkout','funding/resume','funding/availability','checkouts','checkout-refresh'])assert.equal((await request('/api/'+route,{id,enabled:true,confirm:true,consent:true})).status,403);assert.equal(external,0);assert.equal((await request('/api/state')).data.fundingDrafts[0].status,'draft');
 for(const file of ['hosted/server.mjs','hosted/worker.mjs','hosted/tracking-preview.mjs'])assert.doesNotMatch(readFileSync(new URL('../'+file,import.meta.url),'utf8'),/from ['"].*(?:pay-live-create|live-funding)\.mjs/);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}});

test('crashed create claims become unresolved after restart, and late completions cannot publish checkout links',async()=>{const f=await setup();try{const {id}=await draft(f),claim=await f.drafts.claim(f.owner,id,'merchant');const restarted=createFundingDrafts(f.store,{clock:()=>Date.now()+61000});await restarted.recoverStalled();assert.equal((await restarted.list(f.owner))[0].status,'unresolved');assert.equal(await restarted.claim(f.owner,id,'merchant'),null);
 const r=await restarted.bind(claim,{merchantId:'merchant',providerOrderId:'peer-order',requestedUsdcAmount:'12.5',checkoutUrl:'https://pay.peer.xyz/?order=peer-order&token=hidden&method=wise'},f.tracker);assert.equal(r.unresolved,true);assert.equal((await f.tracker.state(f.owner)).orders.length,0);const row=(await f.store.query('SELECT candidate_provider_id,checkout_url FROM relay_funding_drafts WHERE id=$1',[id])).rows[0];assert.equal(row.candidate_provider_id,'peer-order');assert.equal(row.checkout_url,null);
 }finally{await f.close();}});

test('validated duplicate provider IDs cannot bind across customers or erase the original order',async()=>{const f=await setup();try{const a=await draft(f),ac=await f.drafts.claim(f.owner,a.id,'merchant'),result={merchantId:'merchant',providerOrderId:'same-peer-order',requestedUsdcAmount:'12.5',checkoutUrl:null};await f.drafts.bind(ac,result,f.tracker);const owner='customer:'+randomUUID(),agent={...f.agent,id:randomUUID()};await f.store.addAgent(owner,agent);const b=await f.drafts.prepare(owner,{agentId:agent.id,requestId:randomUUID(),amount:'25',confirm:true}),bc=await f.drafts.claim(owner,b.id,'merchant');await assert.rejects(f.drafts.bind(bc,result,f.tracker));assert.equal((await f.tracker.state(owner)).orders.length,0);assert.equal((await f.tracker.state(f.owner)).orders[0].id,a.id);assert.equal((await f.drafts.list(owner))[0].status,'creating');
 }finally{await f.close();}});

test('live creation validates the complete returned payment contract before exposing the checkout',async()=>{const id=randomUUID(),local={id,merchantId:'merchant',source:'live',agent:{id:randomUUID(),name:'Agent',address:remote().destinationAddress,network:'Base',token:'USDC'},quote:{pence:2500,platform:'wise'}},base=orderFor(id);
 const changes=[{merchantId:'other'},{requestedFiat:{amount:'26',currency:'GBP'}},{requestedFiat:{amount:'25',currency:'EUR'}},{enabledRails:['wise','revolut']},{feePayer:'BUYER'},{destinationChainId:'1'},{destinationToken:'USDT'},{destinationAddress:'0x2222222222222222222222222222222222222222'},{notes:{relayOrderId:randomUUID()}},{amountMode:'OPEN'},{dynamicOrdersEnabled:true},{successUrl:'https://evil.example'},{requestedUsdcAmount:'0'},{requestedUsdcAmount:'10001'},{buyerFeeShareBps:1}];
 for(const change of changes){let posts=0;const writer=createLiveCheckoutWriter({apiKey:'fixture',merchantId:'merchant',authorise:()=>true,fetcher:async(url,opts)=>{if(url.endsWith('/me'))return envelope({id:'merchant',environment:'LIVE',merchantConfig:{enabledRails:['wise']}});posts++;return envelope({order:{...base,...change},orderToken:'hidden'});}});await assert.rejects(writer.create(local,'https://relay.example'));assert.equal(posts,1);}
});


test('automatic hosted tracking retries convergence, survives restart and updates customer receipt without refresh or review',async()=>{
 const f=await setup();let observation,server;try{
  const {id}=await draft(f);let phase='empty',orderReads=0,posts=0;
  const p={...payment(),currency:'USD',paymentAmount:'12.50',penalties:[{kind:'CROSS_CURRENCY',penaltyBps:300,originalAmount:'12.50',attestedAmount:'12.12'}]};
  const provider={...orderFor(id),remainingUsdcAmount:'0.02'};
  const fetcher=async(url,options)=>{
   if(options.method==='POST'){posts++;return envelope({order:{...provider,status:'CREATED'},orderToken:'fixture-private-token'});}
   assert.equal(options.method,'GET');
   if(url.endsWith('/me'))return envelope({id:'merchant',environment:'LIVE',merchantConfig:{enabledRails:['wise']}});
   if(url.endsWith('/payments'))return envelope({payments:['empty','lag'].includes(phase)?[]:[p]});
   orderReads++;
   return envelope({merchant:{id:'merchant',environment:'LIVE'},order:phase==='snapshot'&&orderReads%2===1?{...provider,status:'PARTIALLY_FULFILLED'}:provider,currentPayment:phase==='empty'?null:p});
  };
  await service(f,fetcher).start(f.owner,{id,confirm:true,consent:true});assert.equal(posts,1);
  const chain=rpc({getBlock:async({blockTag})=>blockTag==='finalized'&&phase==='finality'?null:({hash:receipt(p).blockHash,number:blockTag==='finalized'&&phase!=='final'?119n:120n}),getTransactionReceipt:async()=>{if(phase==='missing')throw {name:'TransactionReceiptNotFoundError'};return receipt(p);}});
  const prepare=()=>prepareLiveObservation({pool:f.pool,base:f.store,drafts:f.drafts,connection:{environment:'LIVE',mode:'receive_only',merchantId:'merchant',apiKey:'fixture'},fetcher,rpc:chain});
  observation=await prepare();
  // A signed fulfilment hint starts the work; no customer refresh or resolution API is used.
  const raw=Buffer.from(JSON.stringify({id:'automatic-event',type:'ORDER_FULFILLED',data:{order:provider}})),timestamp=String(Math.floor(Date.now()/1000));
  const headers={'x-webhook-id':'automatic-delivery','x-webhook-timestamp':timestamp,'x-webhook-signature':createHmac('sha256','fixture-secret').update(timestamp+'.').update(raw).digest('hex')};
  const hint=verifyWebhook(raw,headers,{secret:'fixture-secret',merchantId:'merchant',environment:'LIVE'});
  await observation.store.accept(hint);assert.equal((await observation.store.accept(hint)).duplicate,true);
  server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},fundingDrafts:f.drafts,liveObservation:observation,paymentsDisabled:true,allowHttpForTests:true});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const get=route=>new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path:route,headers:{host:'relay.example',cookie:'__Host-relay_sandbox='+f.account.token}},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(b)}));}).on('error',reject);});
  await observation.start();
  // More than five normal waits must not trip the outage circuit breaker.
  for(const step of ['empty','empty','lag','lag','snapshot','finality','missing','confirming','final']){
   phase=step;orderReads=0;
   if(step==='confirming'){await observation.stop();observation=await prepare();}
   await f.pool.query('UPDATE relay_live_orders SET next_check_at=now() WHERE id=$1',[id]);
   await observation.tick();
   const state=(await get('/api/state')).data,o=state.orders.find(o=>o.id===id);
   assert.equal(o.reviewRequired,false,step);assert.equal(state.orders.length,1);
   if(['empty','lag','snapshot','finality'].includes(step)){
    assert.equal(o.status,'checkout_ready',step);assert.equal(o.delivery,undefined);
    const r=(await f.pool.query('SELECT attempts,extract(epoch FROM(next_check_at-now())) AS delay FROM relay_live_orders WHERE id=$1',[id])).rows[0];
    assert.equal(r.attempts,0);assert.ok(Number(r.delay)>0&&Number(r.delay)<=15);
   }else assert.equal(o.status,step==='missing'?'checkout_settled':step==='confirming'?'checkout_confirming':'checkout_received');
   const exported=await get('/api/wallet-tracking/orders/'+id+'/receipt');
   assert.equal(exported.status,step==='final'?200:409,step);
   if(step==='final'){assert.equal(exported.data.delivery.amountRaw,'12000000');assert.equal(exported.data.delivery.recipient,f.agent.address);assert.equal(exported.data.delivery.finalized,true);assert.equal(exported.data.payIn.settlement.currency,'USD');}
  }
  assert.equal((await f.drafts.list(f.owner))[0].status,'closed');assert.equal(posts,1);
  assert.equal((await f.pool.query('SELECT * FROM relay_live_payments')).rows.length,1);
  assert.equal((await f.pool.query("SELECT * FROM relay_live_audit WHERE event IN ('review_required','operator_review_resolved')")).rows.length,0);
  assert.equal((await f.pool.query('SELECT * FROM relay_live_webhooks WHERE processed_at IS NULL')).rows.length,0);
 }finally{await observation?.stop();if(server)await new Promise(r=>server.close(r));await f.close();}
});
