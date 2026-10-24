import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {rampDemoUrl,rampQuoteRequest,stableJSON,verifyRampWebhook,verifyRampDelivery,createRampDemoReader} from '../server/ramp.mjs';
import {createRampSimulation} from '../hosted/ramp-simulation.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {receipt,rpc} from './fixtures/live-evidence.mjs';
import {TOKEN} from '../server/validation.mjs';
const recipient='0x1111111111111111111111111111111111111111';
const expected={purchaseId:'purchase1',recipient,pence:2500,cryptoAmount:'12000000'};
const purchase=()=>({id:'purchase1',status:'RELEASED',receiverAddress:recipient,fiatCurrency:'GBP',fiatValue:25,cryptoAmount:'12000000',appliedFee:.5,paymentMethodType:'MANUAL_BANK_TRANSFER',asset:{chain:'BASE',symbol:'BASE_USDC',address:TOKEN,decimals:6},finalTxHash:receipt().transactionHash,purchaseViewToken:'private-fixture-only'});

test('Ramp config uses GBP minor units, fixed Base asset and demo only; disconnected reader makes no request',async()=>{
 const u=new URL(rampDemoUrl({hostApiKey:'fixture-key',hostAppName:'Fixture',hostLogoUrl:'https://example.test/logo.svg',recipient,amount:'25.01',returnUrl:'https://example.test/return'}));
 assert.equal(u.origin,'https://app.demo.rampnetwork.com');assert.equal(u.searchParams.get('inAssetValue'),'2501');assert.equal(u.searchParams.get('outAsset'),'BASE_USDC');assert.equal(u.searchParams.get('userAddress'),recipient);assert.equal(u.searchParams.get('enabledFlows'),'ONRAMP');assert.equal(rampQuoteRequest('25.01').fiatValue,25.01);
 let calls=0;assert.throws(()=>createRampDemoReader({fetcher:()=>calls++}),/not enabled/);assert.equal(calls,0);
 const r=createRampDemoReader({enabled:true,fetcher:async(url,options)=>{calls++;assert.equal(new URL(url).origin,'https://api.demo.rampnetwork.com');assert.equal(new URL(url).searchParams.get('secret'),'private-fixture');assert.equal(options.redirect,'error');return new Response(JSON.stringify({id:'purchase1'}));}});await r.purchase('purchase1','private-fixture');assert.equal(calls,1);
});
test('Ramp signature verifies sorted JSON and rejects tampering, foreign keys, unsupported event types',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'secp256k1'}),event={purchase:purchase(),type:'RELEASED'},sig=sign('sha256',Buffer.from(stableJSON(event)),privateKey).toString('base64');
 assert.equal(verifyRampWebhook(Buffer.from(JSON.stringify(event,null,2)),sig,publicKey).type,'RELEASED');
 assert.throws(()=>verifyRampWebhook(Buffer.from(JSON.stringify({...event,type:'CREATED'})),sig,publicKey));assert.throws(()=>verifyRampWebhook(Buffer.from(JSON.stringify(event)),sig,generateKeyPairSync('ec',{namedCurve:'secp256k1'}).publicKey));
});
test('Ramp RELEASED is not wallet proof: exact native USDC receipt, chain, canonical block and finality required',async()=>{
 const good=await verifyRampDelivery(purchase(),expected,rpc());assert.equal(good.status,'received');assert.equal(good.delivery.amountRaw,'12000000');assert.ok(!JSON.stringify(good).includes('private-fixture'));
 assert.equal((await verifyRampDelivery({...purchase(),status:'FIAT_RECEIVED'},expected,{getChainId:()=>assert.fail('no RPC before release')})).status,'waiting');
 assert.equal((await verifyRampDelivery(purchase(),expected,rpc({getBlock:async({blockTag})=>({hash:receipt().blockHash,number:blockTag==='finalized'?119n:120n})}))).status,'confirming');
 for(const p of [{...purchase(),receiverAddress:'0x2222222222222222222222222222222222222222'},{...purchase(),cryptoAmount:'11999999'},{...purchase(),fiatValue:26},{...purchase(),fiatCurrency:'USD'},{...purchase(),asset:{...purchase().asset,address:'0x2222222222222222222222222222222222222222'}}])await assert.rejects(verifyRampDelivery(p,expected,rpc()));
 for(const chain of [rpc({getChainId:async()=>1}),rpc({getTransactionReceipt:async()=>({...receipt(),status:'reverted'})}),rpc({getTransactionReceipt:async()=>({...receipt(),logs:[]})}),rpc({getBlock:async()=>({hash:'0x'+'11'.repeat(32),number:120n})})])await assert.rejects(verifyRampDelivery(purchase(),expected,chain));
});
test('Ramp simulation persists, isolates customers and replays create/advance without duplicating stages',async()=>{
 const f=await fixture();try{const owner='customer:'+randomUUID(),other='customer:'+randomUUID(),agent={id:randomUUID(),name:'Fixture agent',network:'Base',token:'USDC',address:recipient};await f.store.addAgent(owner,agent);
 const service=createRampSimulation(f.store);await service.migrate();const input={requestId:randomUUID(),agentId:agent.id,amount:'25',confirm:true};
 const [a,b]=await Promise.all([service.create(owner,input),service.create(owner,input)]);assert.equal(a.id,b.id);await assert.rejects(service.create(other,input));await assert.rejects(service.create(owner,{...input,amount:'26'}));assert.equal((await service.state(other)).length,0);
 const restarted=createRampSimulation(f.store);await restarted.migrate();await assert.rejects(restarted.advance(other,{id:a.id,stage:0}),/not found/);
 await Promise.all([restarted.advance(owner,{id:a.id,stage:0}),restarted.advance(owner,{id:a.id,stage:0})]);assert.equal((await restarted.state(owner))[0].stage,1);
 await restarted.advance(owner,{id:a.id,stage:1});assert.equal((await restarted.state(owner))[0].status,'confirming');await restarted.advance(owner,{id:a.id,stage:2});const done=(await restarted.state(owner))[0];assert.equal(done.status,'received');assert.equal(done.source,'simulation');assert.equal(done.delivery.finalized,true);
 }finally{await f.close();}
});
