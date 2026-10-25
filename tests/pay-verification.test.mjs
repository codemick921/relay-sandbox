import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {encodeEventTopics,encodeAbiParameters,erc20Abi} from 'viem';
import {verifyWebhook,createWebhookInbox,atomicJson} from '../server/pay-webhooks.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {createPayService} from '../server/pay.mjs';
import {createApp} from '../server/index.mjs';
import {ORCHESTRATOR,ESCROW} from '../server/live.mjs';
import {TOKEN} from '../server/peer.mjs';
const recipient='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222';
const intent='0x'+'ab'.repeat(32),tx='0x'+'cd'.repeat(32),blockHash='0x'+'ef'.repeat(32);
const now=1792857600000,secret='fixture-only-secret',config={secret,merchantId:'merchant',environment:'LIVE',now};
const local=()=>({id:'relay-order',kind:'checkout',providerOrderId:'peer-order',merchantId:'merchant',source:'live',status:'checkout_ready',agent:{id:'agent',name:'Example agent',address:recipient},quote:{pence:2500,platform:'wise'},events:[]});
const remote=()=>({id:'peer-order',merchantId:'merchant',status:'FULFILLED',requestedUsdcAmount:'12.5',remainingUsdcAmount:'0',amountMode:'FIXED',destinationAddress:recipient,destinationToken:'USDC',destinationChainId:'8453',feePayer:'MERCHANT',enabledRails:['wise'],requestedFiat:{amount:'25',currency:'GBP'},notes:{relayOrderId:'relay-order'},chargebackStatus:'NONE'});
const payment=()=>({id:'payment-1',orderId:'peer-order',status:'SETTLED',rail:'wise',currency:'GBP',chargebackStatus:'NONE',penalties:[],netSettledUsdcAmount:'12',totalUsdcFeeAmount:'0.5',railIdentifier:intent,fulfillTransaction:tx,quote:{intentHash:intent,signalIntent:{processorName:'wise',toAddress:recipient,orchestratorAddress:ORCHESTRATOR.address,escrowAddress:ESCROW,amount:'12500000'}}});
function log(abi,eventName,args,address){const event=abi.find(x=>x.type==='event'&&x.name===eventName);return {address,topics:encodeEventTopics({abi:[event],eventName,args}),data:encodeAbiParameters(event.inputs.filter(i=>!i.indexed),event.inputs.filter(i=>!i.indexed).map(i=>args[i.name]))};}
function receipt(p=payment()){
 return {status:'success',transactionHash:p.fulfillTransaction,blockNumber:120n,blockHash,logs:[log(ORCHESTRATOR.abi,'IntentFulfilled',{intentHash:p.railIdentifier,fundsTransferredTo:recipient,amount:12000000n,isManualRelease:false},ORCHESTRATOR.address),log(erc20Abi,'Transfer',{from:ORCHESTRATOR.address,to:recipient,value:12000000n},TOKEN)]};
}
const rpc=(overrides={})=>({getChainId:async()=>8453,getTransactionReceipt:async()=>receipt(),getBlock:async({blockTag})=>({hash:blockHash,number:blockTag==='finalized'?120n:120n}),...overrides});
const event=(overrides={})=>({id:'event-1',type:'ORDER_FULFILLED',timestamp:new Date(now).toISOString(),data:{order:remote(),payment:payment()},...overrides});
function signed(payload=event(),timestamp=String(Math.floor(now/1000)),id='delivery-1'){
 const raw=Buffer.from(JSON.stringify(payload));return {raw,headers:{'x-webhook-id':id,'x-webhook-timestamp':timestamp,'x-webhook-signature':createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex')}};
}
const envelope=value=>new Response(JSON.stringify({success:true,responseObject:value}),{status:200});

test('raw HMAC rejects changed bytes, old/future timestamps, malformed headers and wrong workspace',()=>{
 const s=signed();assert.equal(verifyWebhook(s.raw,s.headers,config).orderId,'peer-order');
 for(const h of [{...s.headers,'x-webhook-signature':'00'}, {...s.headers,'x-webhook-timestamp':'bad'}, {...s.headers,'x-webhook-id':['a','b']}])assert.throws(()=>verifyWebhook(s.raw,h,config));
 assert.throws(()=>verifyWebhook(Buffer.concat([s.raw,Buffer.from(' ')]),s.headers,config));
 for(const delta of [-301,301]){const q=signed(event(),String(now/1000+delta));assert.throws(()=>verifyWebhook(q.raw,q.headers,config));}
 assert.throws(()=>verifyWebhook(s.raw,s.headers,{...config,secret:'wrong'}));
 assert.throws(()=>verifyWebhook(s.raw,s.headers,{...config,merchantId:'other'}));
 const cross=signed({...event(),data:{order:remote(),payment:{...payment(),orderId:'other'}}});assert.throws(()=>verifyWebhook(cross.raw,cross.headers,config));
});
test('inbox persists before ack, survives restart, deduplicates headers and signed bodies, rejects conflicts',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'relay-hooks-'));
 try{const file=path.join(dir,'inbox.json');let box=createWebhookInbox({file});const s=signed(),e=verifyWebhook(s.raw,s.headers,config);
 assert.equal(box.accept(e,now).duplicate,false);box=createWebhookInbox({file});assert.equal(box.pending(now).length,1);
 assert.equal(box.accept(e,now).duplicate,true);assert.equal(box.accept({...e,deliveryId:'altered-unsigned-id'},now).duplicate,true);
 assert.throws(()=>box.accept({...e,digest:'different'},now));assert.equal(box.pending(now).length,1);
 const row=box.pending(now)[0];box.retry(row.id,now);assert.equal(box.pending(now).length,0);assert.equal(box.pending(now+15000).length,1);box.finish(row.id,now);assert.equal(createWebhookInbox({file}).pending(now).length,0);
 assert.ok(!readFileSync(file,'utf8').includes(secret));
 }finally{rmSync(dir,{recursive:true});}
});
test('synthetic hook is acknowledged without enqueuing settlement and storage failure cannot ack',()=>{
 const s=signed(event({type:'ORDER_CREATED',data:{test:true,order:null,payment:null}}));const box=createWebhookInbox();box.accept(verifyWebhook(s.raw,s.headers,config),now);assert.equal(box.pending(now).length,0);
 assert.throws(()=>createWebhookInbox({capacity:0}).accept(verifyWebhook(s.raw,s.headers,config),now));
});
test('exact native USDC receipt remains confirming until canonical Base finality',async()=>{
 let r=await verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc({getBlock:async({blockTag})=>({hash:blockHash,number:blockTag==='finalized'?119n:120n})}),now});
 assert.equal(r.status,'checkout_confirming');assert.equal(r.delivery,null);assert.equal(r.verification.receivedRaw,'0');
 r=await verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc(),now});assert.equal(r.status,'checkout_received');assert.equal(r.delivery.amountRaw,'12000000');assert.equal(r.delivery.recipient,recipient);
 assert.equal(r.delivery.receipts[0].finalized,true);
});
test('wrong chain, token, recipient, intent, amount or fake receipt never confirms arrival',async()=>{
 await assert.rejects(verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc({getChainId:async()=>1})}));
 for(const edit of [r=>r.logs[1].address=other,r=>r.logs[0].address=other,r=>r.transactionHash=intent,r=>r.logs.pop()]){
  const r=receipt();edit(r);await assert.rejects(verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc({getTransactionReceipt:async()=>r})}));
 }
 for(const edit of [p=>p.netSettledUsdcAmount='11',p=>p.quote.signalIntent.toAddress=other,p=>p.railIdentifier=tx,p=>p.quote.signalIntent.orchestratorAddress=other,p=>p.orderId='other',p=>p.netSettledUsdcAmount='1.0000001',p=>p.quote.signalIntent.amount='1']){
  const p=payment();edit(p);await assert.rejects(verifyPayDelivery(local(),remote(),[p],{rpc:rpc()}));
 }
 await assert.rejects(verifyPayDelivery({...local(),source:'sandbox'},remote(),[payment()],{rpc:rpc()}));
 await assert.rejects(verifyPayDelivery(local(),{...remote(),bridgeInfo:{status:'COMPLETED'}},[payment()],{rpc:rpc()}));
});
test('absent, reverted and reorganised transactions stay unresolved; RPC errors never create success',async()=>{
 const missing=rpc({getTransactionReceipt:async()=>{throw {name:'TransactionReceiptNotFoundError'};}});
 assert.equal((await verifyPayDelivery(local(),remote(),[payment()],{rpc:missing})).status,'checkout_settled');
 assert.equal((await verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc({getTransactionReceipt:async()=>({...receipt(),status:'reverted'})})})).status,'checkout_review');
 assert.equal((await verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc({getBlock:async()=>({hash:tx,number:120n})})})).status,'checkout_settled');
 await assert.rejects(verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc({getBlock:async()=>{throw Error('outage');}})}));
});
test('partial and late settlements track exact net totals without completing early or double counting',async()=>{
 const p2={...payment(),id:'payment-2',railIdentifier:tx,fulfillTransaction:intent,quote:{...payment().quote,intentHash:tx}};
 const chain=rpc({getTransactionReceipt:async({hash})=>receipt(hash===tx?payment():p2)});
 let r=await verifyPayDelivery(local(),{...remote(),status:'PARTIALLY_FULFILLED',remainingUsdcAmount:'12.5'},[payment(),{...p2,status:'EXPIRED'}],{rpc:chain});
 assert.equal(r.status,'checkout_partial');assert.equal(r.verification.receivedRaw,'12000000');assert.equal(r.delivery,null);
 r=await verifyPayDelivery({...local(),verification:r.verification},{...remote(),requestedUsdcAmount:'25'},[payment(),p2],{rpc:chain});assert.equal(r.delivery.amountRaw,'24000000');
 await assert.rejects(verifyPayDelivery(local(),remote(),[payment(),payment()],{rpc:chain}));
 await assert.rejects(verifyPayDelivery(local(),remote(),[payment(),{...payment(),id:'duplicate-intent'}],{rpc:chain}));
 await assert.rejects(verifyPayDelivery({...local(),verification:r.verification},remote(),[payment()],{rpc:chain}));
 await assert.rejects(verifyPayDelivery(local(),remote(),[],{rpc:chain}));
});
test('authenticated read adapter binds LIVE merchant and retains chargebacks separately; sandbox never touches chain',async()=>{
 const calls=[];let env='LIVE';const service=createPayService({liveKey:'fixture-live-key',liveMerchantId:'merchant',fetcher:async(url,init)=>{
  calls.push({url,init});return envelope(url.endsWith('/me')?{id:'merchant',environment:env}:url.endsWith('/payments')?{payments:[payment()]}:{order:{...remote(),chargebackStatus:'CHARGEBACKED'},merchant:{id:'merchant',environment:env},currentPayment:payment()});
 },deliveryVerifier:(...args)=>verifyPayDelivery(...args,{rpc:rpc()})});
 let r=await service.refresh(local());assert.equal(r.status,'checkout_received');assert.equal(r.chargebackStatus,'CHARGEBACKED');assert.ok(calls.find(c=>c.url.endsWith('/payments')).init.headers['X-API-Key']);assert.ok(!JSON.stringify(r).includes('fixture-live-key'));
 env='SANDBOX';await assert.rejects(service.refresh(local()),/workspace/);
 calls.length=0;r=await service.refresh({...local(),source:'sandbox'});assert.equal(r.status,'sandbox_complete');assert.equal(r.delivery,null);assert.equal(calls.length,1);
 await assert.rejects(createPayService({liveKey:'',fetcher:async()=>envelope({order:remote(),merchant:{id:'merchant',environment:'LIVE'}})}).refresh(local()),/server connection/);
});

test('HTTP signed webhook queues durably; worker reconciles fresh API, retries outage and survives restart',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'relay-tracking-')),persistFile=path.join(dir,'sessions.json');
 const sid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';atomicJson(persistFile,{[sid]:{agents:[],orders:[local()],lastQuote:null}});
 let calls=0,fail=true;
 const payService={readiness:async()=>({ready:false}),refresh:async o=>{calls++;if(fail)throw Error('offline');return {...await verifyPayDelivery(o,remote(),[payment()],{rpc:rpc(),now}),checkedAt:new Date(now).toISOString()};}};
 let clock=now;const options={persistFile,payService,workerIntervalMs:0,now:()=>clock,webhooks:{live:config}};
 let server=createApp(options);const start=async()=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
 let base=await start();const s=signed();
 const send=()=>fetch(base+'/api/webhooks/peer/live',{method:'POST',headers:{'Content-Type':'application/json',...s.headers},body:s.raw});
 try{
  assert.equal((await send()).status,202);assert.equal(calls,0);assert.equal(server.webhookStats().pending,1);
  await server.reconcileCheckouts();assert.equal(calls,1);assert.equal(server.webhookStats().pending,1);
  let st=JSON.parse(readFileSync(persistFile,'utf8'))[sid];assert.equal(st.orders[0].status,'checkout_ready');assert.ok(st.orders[0].trackingError);
  server.close();await once(server,'close');server=createApp(options);base=await start();fail=false;clock+=60001;
  await server.reconcileCheckouts();assert.equal(server.webhookStats().pending,0);
  st=await (await fetch(base+'/api/state',{headers:{Cookie:`relay_peer_session=${sid}`}})).json();assert.equal(st.orders[0].status,'checkout_received');assert.equal(st.orders[0].trackingError,null);
  assert.equal((await send()).status,202);assert.equal(server.webhookStats().processed,1);
  assert.equal((await (await fetch(base+'/api/state')).json()).orders.length,0);
  const forged=await fetch(base+'/api/webhooks/peer/live',{method:'POST',headers:{'Content-Type':'application/json',...s.headers},body:Buffer.from('{}')});assert.equal(forged.status,401);
  assert.equal((await fetch(base+'/api/checkout-refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 }finally{server.close();await once(server,'close');rmSync(dir,{recursive:true});}
});
test('global receipt reuse fails even across sessions and stale webhook snapshots cannot overwrite API truth',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'relay-reuse-')),file=path.join(dir,'sessions.json');const a=local(),b={...local(),id:'other-local'};
 atomicJson(file,{a:{agents:[],orders:[a],lastQuote:null},b:{agents:[],orders:[b],lastQuote:null}});
 const server=createApp({persistFile:file,workerIntervalMs:0,payService:{refresh:o=>verifyPayDelivery(o,remote(),[payment()],{rpc:rpc()})}});
 await server.reconcileCheckouts();const data=JSON.parse(readFileSync(file,'utf8'));
 assert.equal(data.a.orders[0].status,'checkout_received');assert.equal(data.b.orders[0].status,'checkout_ready');assert.match(data.b.orders[0].trackingError,/another Eupova order/);rmSync(dir,{recursive:true});
});

test('out-of-order expiry notification only requests fresh reconciliation and never erases arrival',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'relay-ordering-')),file=path.join(dir,'sessions.json');
 const confirmed={...local(),...await verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc(),now}),nextCheckAt:now+3600000};
 atomicJson(file,{owner:{agents:[],orders:[confirmed],lastQuote:null}});
 const server=createApp({persistFile:file,workerIntervalMs:0,now:()=>now,webhooks:{live:config},payService:{refresh:o=>verifyPayDelivery(o,remote(),[payment()],{rpc:rpc(),now})}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const stale=signed(event({id:'older-expiry',type:'PAYMENT_EXPIRED',data:{order:{...remote(),status:'CREATED'},payment:{...payment(),status:'EXPIRED'}}}));
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/peer/live`,{method:'POST',headers:{'Content-Type':'application/json',...stale.headers},body:stale.raw});assert.equal(r.status,202);
  assert.equal(JSON.parse(readFileSync(file)).owner.orders[0].status,'checkout_received');
  await server.reconcileCheckouts();assert.equal(JSON.parse(readFileSync(file)).owner.orders[0].status,'checkout_received');assert.equal(server.webhookStats().pending,0);
 }finally{server.close();await once(server,'close');rmSync(dir,{recursive:true});}
});

test('failed durable inbox write returns retryable failure without marking a webhook accepted',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'relay-disk-')),parent=path.join(dir,'blocked');
 const server=createApp({inboxFile:path.join(parent,'inbox.json'),workerIntervalMs:0,now:()=>now,webhooks:{live:config}});
 // Turn the not-yet-created directory into a regular file after startup.
 atomicJson(parent,{});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const s=signed();const r=await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/peer/live`,{method:'POST',headers:{'Content-Type':'application/json',...s.headers},body:s.raw});assert.equal(r.status,500);assert.equal(server.webhookStats().pending,0);}
 finally{server.close();await once(server,'close');rmSync(dir,{recursive:true});}
});

test('completed foreign-currency settlement retains adjustments and residual without weakening receipt proof',async()=>{
 const p={...payment(),currency:'USD',penalties:[{kind:'CROSS_CURRENCY',penaltyBps:300,originalAmount:'6.67',attestedAmount:'6.46'}]};
 const r=await verifyPayDelivery(local(),{...remote(),remainingUsdcAmount:'0.02'},[p],{rpc:rpc()});
 assert.equal(r.status,'checkout_received');assert.equal(r.verification.providerRemainingRaw,'20000');
 assert.equal(r.verification.payments[0].currency,'USD');assert.equal(r.verification.payments[0].adjustments[0].penaltyBps,300);
 assert.equal(r.delivery.amountRaw,'12000000');
 for(const edit of [p=>p.penalties[0].kind='unknown',p=>p.penalties[0].attestedAmount='9.00',p=>p.penalties[0].penaltyBps=-1,p=>p.penalties[0].originalAmount='NaN',p=>p.currency='BAD',p=>p.quote.signalIntent.toAddress=other,p=>p.netSettledUsdcAmount='11']){
  const bad=structuredClone(p);edit(bad);await assert.rejects(verifyPayDelivery(local(),remote(),[bad],{rpc:rpc()}));
 }
 await assert.rejects(verifyPayDelivery(local(),{...remote(),remainingUsdcAmount:'99'},[p],{rpc:rpc()}));
});
