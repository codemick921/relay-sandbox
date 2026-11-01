import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeEventTopics,encodeAbiParameters} from 'viem';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {createLiveReadService,TrackingRetryError} from '../server/pay-readonly.mjs';
import {SETTLEMENT_V4} from '../server/settlement-contracts.mjs';
import {validateDelivery,settlementContract,verifySettlementCode} from '../server/receipts.mjs';
import {createPeerlyticsReader} from '../server/peerlytics-readonly.mjs';
import {local,remote,payment,receipt,rpc} from './fixtures/live-evidence.mjs';

test('V4 receipt decoding retains exact recipient, amount, token and event checks',()=>{
 const p=payment(),r=receipt(p),event=SETTLEMENT_V4.abi[0],args={intentHash:p.railIdentifier,fundsTransferredTo:p.quote.signalIntent.toAddress,amount:12000000n,releasedBy:'0x'+'00'.repeat(20)};
 r.logs[0]={address:SETTLEMENT_V4.address,topics:encodeEventTopics({abi:[event],eventName:'IntentFulfilled',args}),data:encodeAbiParameters(event.inputs.filter(x=>!x.indexed),event.inputs.filter(x=>!x.indexed).map(x=>args[x.name]))};
 r.logs[1].topics[1]='0x'+SETTLEMENT_V4.address.slice(2).toLowerCase().padStart(64,'0');
 const order={intentHash:p.railIdentifier,quote:{recipient:local().agent.address},execution:{net:'12000000'}};
 assert.equal(validateDelivery(order,r,SETTLEMENT_V4).amountRaw,'12000000');
 assert.throws(()=>validateDelivery(order,r),/receipt/);
 assert.throws(()=>validateDelivery({...order,quote:{recipient:'0x'+'22'.repeat(20)}},r,SETTLEMENT_V4),/receipt/);
 assert.equal(settlementContract('0x'+'33'.repeat(20)),undefined);
});
test('V4 code verification rejects pre-deployment and changed code',async()=>{
 await assert.rejects(verifySettlementCode({},SETTLEMENT_V4,53251270n),/predates/);
 await assert.rejects(verifySettlementCode({getCode:async()=> '0x1234'},SETTLEMENT_V4,53251271n),/code/);
});
test('held and disputed settlements never claim wallet arrival or read their receipt',async()=>{
 for(const status of ['HELD','DISPUTED']){
  const p={...payment(),payout:{status,releaseEligibleAt:'2026-11-15T00:00:00Z',releasedAt:null}};
  const v=await verifyPayDelivery(local(),remote(),[p],{rpc:rpc({getTransactionReceipt:async()=>{throw Error('must not read held receipt');}})});
  assert.equal(v.delivery,null);assert.equal(v.verification.receivedRaw,'0');assert.equal(v.verification.expectedNetRaw,'12000000');
  assert.equal(v.status,status==='HELD'?'checkout_settled':'checkout_review');
 }
});
test('held payout can move to released only with independently valid final receipt',async()=>{
 const held=await verifyPayDelivery(local(),remote(),[{...payment(),payout:{status:'HELD'}}],{rpc:rpc()});
 const released=await verifyPayDelivery({...local(),verification:held.verification},remote(),[{...payment(),payout:{status:'RELEASED',releasedAt:'2026-11-01T19:00:00Z'}}],{rpc:rpc()});
 assert.equal(released.status,'checkout_received');
 await assert.rejects(verifyPayDelivery(local(),remote(),[{...payment(),payout:{status:'GUESS'}}],{rpc:rpc()}),/payout/);
});
test('unsupported settlement produces a safe specific reason',async()=>{
 const p=payment();p.quote.signalIntent.orchestratorAddress='0x'+'33'.repeat(20);
 await assert.rejects(verifyPayDelivery(local(),remote(),[p],{rpc:rpc()}),e=>e.evidenceCode==='unsupported_contract');
});
test('Peer read-only adapter propagates documented throttling without exposing response text',async()=>{
 const reader=createLiveReadService({apiKey:'fake',merchantId:'merchant',rpc:rpc(),fetcher:async()=>new Response('private',{status:429,headers:{'x-retry-after':'93'}})});
 await assert.rejects(reader.refresh(local()),e=>e instanceof TrackingRetryError&&e.retryAfterSeconds===93&&!e.message.includes('private'));
});
const indexed=(extra={})=>({jsonrpc:'2.0',id:1,result:{structuredContent:{kind:'intent',chainId:8453,receipt:{intentHash:payment().railIdentifier,status:'FULFILLED',fulfillTxHash:payment().fulfillTransaction,...extra}}}});
test('Peerlytics uses only exact public intent and caches a bounded, non-authoritative result',async()=>{
 let calls=0;const reader=createPeerlyticsReader({fetcher:async(url,init)=>{
  calls++;assert.equal(url,'https://peerlytics.xyz/api/mcp');assert.equal(init.redirect,'error');
  const body=JSON.parse(init.body);assert.deepEqual(body.params.arguments,{kind:'intent',id:payment().railIdentifier});assert.equal(init.headers['X-API-Key'],undefined);
  return Response.json(indexed());
 }});
 const results=await Promise.all([reader.lookup(payment().railIdentifier,payment().fulfillTransaction),reader.lookup(payment().railIdentifier,payment().fulfillTransaction)]);
 assert.equal(calls,1);assert.equal(results[0].status,'matched');assert.equal(results[0].amountRaw,undefined);
 assert.equal((await reader.lookup(payment().railIdentifier,payment().fulfillTransaction)).status,'matched');assert.equal(calls,1);
});
test('Peerlytics rejects wrong chain, wrong intent, malformed and oversized results; outages are cached',async()=>{
 for(const response of [()=>Response.json({...indexed(),result:{structuredContent:{...indexed().result.structuredContent,chainId:1}}}),()=>Response.json(indexed({intentHash:'0x'+'00'.repeat(32)})),()=>new Response('x'.repeat(131073)),()=>new Response('oops',{status:503})]){
  let calls=0;const reader=createPeerlyticsReader({fetcher:async()=>{calls++;return response();}});
  assert.equal((await reader.lookup(payment().railIdentifier,payment().fulfillTransaction)).status,'unavailable');
  await reader.lookup(payment().railIdentifier,payment().fulfillTransaction);assert.equal(calls,1);
 }
});
test('Peerlytics mismatch remains separate and SSE responses parse without executing content',async()=>{
 const reader=createPeerlyticsReader({fetcher:async()=>new Response('event: message\ndata: '+JSON.stringify(indexed({fulfillTxHash:'0x'+'33'.repeat(32)}))+'\n\n',{headers:{'content-type':'text/event-stream'}})});
 assert.equal((await reader.lookup(payment().railIdentifier,payment().fulfillTransaction)).status,'mismatch');
});

import {createCustomerFunding} from '../hosted/customer-funding.mjs';
test('stop retries a generation race only after a new provider read, retaining payment guards',async()=>{
 for(const becamePaid of [false,true]){
  let reads=0,stops=0,scheduled=0;
  const drafts={review:async()=>({status:'bound'}),stop:async(owner,id,checked,generation)=>{stops++;if(stops===1){const e=Error('changed');e.code='TRACKING_GENERATION_CHANGED';throw e;}assert.equal(generation,2);if(checked.paid)throw Error('Payment may have happened');return {id};}};
  const funding=createCustomerFunding({drafts,tracker:{owned:async()=>({generation:reads+1}),schedule:async()=>scheduled++},reader:{refresh:async()=>({paid:++reads===2&&becamePaid})},connection:{environment:'LIVE',apiKey:'fixture',merchantId:'merchant'},origin:'https://eupova.example',fetcher:async()=>{throw Error('no payment requests');}});
  if(becamePaid)await assert.rejects(funding.stop('owner',{id:'order',confirmNoPayment:true}),/Payment may/);
  else assert.deepEqual(await funding.stop('owner',{id:'order',confirmNoPayment:true}),{id:'order'});
  assert.equal(reads,2);assert.equal(stops,2);assert.equal(scheduled,becamePaid?0:1);
 }
});
test('a later dispute cannot erase a previously finalised wallet receipt',async()=>{
 const first=await verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc()});
 const second=await verifyPayDelivery({...local(),verification:first.verification},remote(),[{...payment(),payout:{status:'DISPUTED'}}],{rpc:rpc()});
 assert.equal(second.delivery.amountRaw,first.delivery.amountRaw);assert.equal(second.verification.payments[0].payout.status,'DISPUTED');
});
test('optional indexer failure does not block exact chain delivery',async()=>{
 const l={...local(),requestedUsdcAmount:'12.5'};
 const reader=createLiveReadService({apiKey:'fake',merchantId:'merchant',rpc:rpc(),corroborator:{lookup:async()=>{throw Error('offline');}},fetcher:async url=>Response.json({success:true,responseObject:url.endsWith('/me')?{id:'merchant',environment:'LIVE'}:url.endsWith('/payments')?{payments:[payment()]}:{merchant:{id:'merchant',environment:'LIVE'},order:remote(),currentPayment:payment()}})});
 const result=await reader.refresh(l);assert.equal(result.status,'checkout_received');assert.equal(result.verification.payments[0].indexer.status,'unavailable');
});
import {createHmac} from 'node:crypto';
import {verifyWebhook} from '../server/pay-webhooks.mjs';
test('documented payout release webhook is authenticated and remains only a re-read hint',()=>{
 const now=Date.now(),timestamp=String(Math.floor(now/1000)),raw=Buffer.from(JSON.stringify({id:'released-event',type:'PAYMENT_PAYOUT_RELEASED',data:{order:remote(),payment:payment()}}));
 const headers={'x-webhook-id':'delivery','x-webhook-timestamp':timestamp,'x-webhook-signature':createHmac('sha256','fixture').update(timestamp+'.').update(raw).digest('hex')};
 const event=verifyWebhook(raw,headers,{secret:'fixture',merchantId:'merchant',environment:'LIVE',now});
 assert.equal(event.type,'PAYMENT_PAYOUT_RELEASED');assert.equal(event.delivery,undefined);
 assert.throws(()=>verifyWebhook(raw,{...headers,'x-webhook-signature':'00'.repeat(32)},{secret:'fixture',merchantId:'merchant',environment:'LIVE',now}),/signature/);
});
test('a delivered payout cannot silently regress to held',async()=>{
 const first=await verifyPayDelivery(local(),remote(),[payment()],{rpc:rpc()});
 await assert.rejects(verifyPayDelivery({...local(),verification:first.verification},remote(),[{...payment(),payout:{status:'HELD'}}],{rpc:rpc()}),e=>e.evidenceCode==='payout_regressed');
});
