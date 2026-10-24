import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createPayService,checkoutRequest,validateCheckout} from '../server/pay.mjs';
import {createApp} from '../server/index.mjs';
const agent={id:'agent',address:'0x1111111111111111111111111111111111111111',name:'Example agent'};
const local={source:'sandbox',id:'11111111-1111-1111-1111-111111111111',agent,quote:{pence:10000,platform:'wise'}};
const merchant={id:'merchant',environment:'SANDBOX',merchantConfig:{enabledRails:['wise']}};
const remote=()=>({id:'peer-order',merchantId:'merchant',status:'CREATED',amountMode:'FIXED',destinationAddress:agent.address,destinationChainId:'8453',destinationToken:'USDC',feePayer:'MERCHANT',enabledRails:['wise'],requestedFiat:{amount:'100',currency:'GBP'},notes:{relayOrderId:local.id}});
const response=x=>new Response(JSON.stringify({success:true,responseObject:x}),{status:200});
test('checkout requires no payer address and fixes destination, GBP, Wise, fee deduction and no resize',()=>{
 const req=checkoutRequest(local,'http://127.0.0.1:4319');assert.equal(req.requestedFiatAmount,'100.00');assert.equal(req.feePayer,'MERCHANT');assert.equal(req.dynamicOrdersEnabled,false);assert.deepEqual(req.enabledRails,['wise']);assert.equal(req.destinationAddress,agent.address);assert.equal(req.idempotencyKey,local.id);assert.equal(req.user,undefined);assert.equal(req.payer,undefined);
});
test('missing key makes no requests; live key rejected before creating any checkout',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return response({...merchant,environment:'LIVE'});};
 assert.equal((await createPayService({key:'',fetcher}).readiness()).ready,false);assert.equal(calls,0);
 await assert.rejects(createPayService({key:'fixture',fetcher}).create(local,'http://127.0.0.1:4319'),/sandbox workspace/);assert.equal(calls,1);
});
test('uses official SDK server-side and validates returned order before exposing hosted URL',async()=>{
 const calls=[];const service=createPayService({key:'fixture-secret',fetcher:async(url,init)=>{calls.push({url,init});return response(url.endsWith('/me')?merchant:{order:remote(),orderToken:'fixture-token'});}});
 const result=await service.create(local,'http://127.0.0.1:4319');assert.equal(result.status,'checkout_ready');assert.equal(new URL(result.checkoutUrl).origin,'https://pay.peer.xyz');assert.equal(JSON.parse(calls[1].init.body).enabledRails[0],'wise');assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});
test('destination, merchant, currency, amount, rail and fee mismatches fail closed',()=>{
 for(const edit of [o=>o.destinationAddress='0x2222222222222222222222222222222222222222',o=>o.merchantId='other',o=>o.destinationChainId='4217',o=>o.requestedFiat.amount='101',o=>o.requestedFiat.currency='USD',o=>o.enabledRails.push('revolut'),o=>o.feePayer='PAYEE',o=>o.notes.relayOrderId='other']){const r=remote();edit(r);assert.throws(()=>validateCheckout(r,local,'merchant'));}
});
test('current creation metadata preserves exact GBP input and rejects resized or conflicting values',()=>{
 const o=remote();delete o.requestedFiat;o.requestedUsdcAmount='133.76';o.metadata={requestAmountInputMode:'fiat',requestedFiatAmount:'100.00',requestedFiatCurrency:'GBP',requestedUsdcAmountAtCreation:'133.76'};
 validateCheckout(o,local,'merchant');
 assert.throws(()=>validateCheckout({...o,requestedUsdcAmount:'140'},local,'merchant'));
 assert.throws(()=>validateCheckout({...o,requestedFiat:{amount:'99',currency:'GBP'}},local,'merchant'));
 assert.throws(()=>validateCheckout({...o,metadata:{...o.metadata,requestedFiatCurrency:'USD'}},local,'merchant'));
});
test('lost checkout link on idempotent replay is explicit and cannot create a replacement',async()=>{
 const service=createPayService({key:'fixture',fetcher:async url=>response(url.endsWith('/me')?merchant:{order:remote(),orderToken:null,idempotentReplay:true})});
 const result=await service.create(local,'http://127.0.0.1:4319');assert.equal(result.status,'checkout_recovery');assert.equal(result.checkoutUrl,null);
});
test('sandbox success never becomes a real receipt; live or mismatched status responses fail',async()=>{
 let value={order:{...remote(),status:'FULFILLED'},merchant};const service=createPayService({key:'fixture',fetcher:async()=>response(value)});
 const tracked={...local,providerOrderId:'peer-order',merchantId:'merchant'};
 const result=await service.refresh(tracked);assert.equal(result.status,'sandbox_complete');assert.equal(result.delivery,null);
 value={...value,merchant:{...merchant,environment:'LIVE'}};await assert.rejects(service.refresh(tracked),/workspace/);
 value={order:{...remote(),id:'wrong-order'},merchant};await assert.rejects(service.refresh(tracked),/match/);
});
test('HTTP checkout is private, idempotent and preserves unknown creation for recovery',async()=>{
 let calls=0,orderId;const payService={readiness:async()=>({ready:true}),create:async o=>{calls++;if(orderId)assert.equal(o.id,orderId);orderId=o.id;if(calls===1)throw Error('timeout');return {providerOrderId:'peer-order',merchantId:'merchant',status:'checkout_ready',checkoutUrl:'https://pay.peer.xyz/?order=peer-order&token=fixture'};},refresh:async()=>({status:'sandbox_complete'})};
 const server=createApp({payService,initialSession:()=>({agents:[agent],orders:[],lastQuote:null})});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const initial=await fetch(base+'/api/state'),cookie=initial.headers.get('set-cookie').split(';')[0];
  const post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  const body={agentId:agent.id,amount:'100',requestId:local.id,confirm:true,consent:true};
  assert.equal((await post('checkouts',{...body,consent:false})).status,400);assert.equal(calls,0);
  assert.equal((await post('checkouts',body)).status,500);
  const state=await (await fetch(base+'/api/state',{headers:{Cookie:cookie}})).json();assert.equal(state.orders[0].status,'checkout_unknown');
  assert.equal((await post('checkouts',{...body,requestId:'22222222-2222-2222-2222-222222222222'})).status,409);
  assert.equal((await post('checkout-resume',{id:orderId})).status,200);assert.equal(calls,2);
  assert.equal((await post('checkouts',body)).status,200);assert.equal(calls,2);
  assert.equal((await post('checkouts',{...body,amount:'101'})).status,409);
  assert.equal((await post('advance',{id:orderId,expected:'checkout_ready'})).status,409);
  const other=await (await fetch(base+'/api/state?status=success&tx_hash=fake')).json();assert.equal(other.orders.length,0);
  assert.equal((await post('checkout-refresh',{id:orderId})).status,200);
 }finally{server.close();await once(server,'close');}
});
