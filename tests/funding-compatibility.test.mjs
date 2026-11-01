import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fundingCompatibility,fundingAssets} from '../shared/funding-compatibility.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
const agent={id:randomUUID(),name:'Local test agent',address:'0x1111111111111111111111111111111111111111',network:'Base',token:'USDC'};
const input={agent,rail:'revolut',currency:'EUR',amountMinor:2500};
test('supported draft separates compatibility from live eligibility and spend readiness',()=>{
 const before=JSON.stringify(input),r=fundingCompatibility(input);
 assert.equal(r.canSaveDraft,true);assert.equal(r.readyForPayment,false);
 assert.equal(r.checks.find(c=>c.id==='spending').status,'unknown');assert.equal(JSON.stringify(input),before);
 assert.equal(r.target.contract.toLowerCase(),fundingAssets[0].contract.toLowerCase());
});
test('same EVM address never makes a Tempo asset compatible with the Base checkout',()=>{
 for(const targetAsset of ['tempo-ousd','tempo-usdce','USDC',null]){const r=fundingCompatibility({...input,targetAsset});assert.equal(r.canSaveDraft,false);assert.equal(r.checks.find(c=>c.id==='asset').status,'blocked');}
 for(const a of [{...agent,network:'Tempo'},{...agent,token:'USDC.e'},{...agent,address:'0x'+'0'.repeat(40)},null])assert.equal(fundingCompatibility({...input,agent:a}).canSaveDraft,false);
 assert.equal(fundingCompatibility({...input,walletCurrent:false}).canSaveDraft,false);
});
test('routes, missing integration, PayPal and invalid amounts cannot be saved',()=>{
 for(const override of [{route:'p2p'},{rail:'paypal'},{rail:'mercadopago',currency:'ARS'},{currency:'XXX'},{amountMinor:0},{amountMinor:100001},{amountMinor:NaN},{amountMinor:1.5}])assert.equal(fundingCompatibility({...input,...override}).canSaveDraft,false);
 const wise=fundingCompatibility({...input,rail:'wise',currency:'GBP'});assert.equal(wise.canSaveDraft,true);assert.equal(wise.checks.find(c=>c.id==='policy').status,'blocked');assert.equal(wise.readyForPayment,false);
});
test('server rejects destination and route substitutions even when the form is bypassed',async()=>{
 const f=await fixture();try{
  const owner='customer:'+randomUUID();await f.store.addAgent(owner,agent);const d=createFundingDrafts(f.store);await d.migrate();
  const request={requestId:randomUUID(),agentId:agent.id,amount:'25',rail:'revolut',currency:'EUR',confirm:true};
  for(const override of [{targetAsset:'tempo-ousd'},{targetAsset:'tempo-usdce'},{route:'p2p'},{targetAsset:null},{route:null}])await assert.rejects(d.prepare(owner,{...request,...override}),/not connected/);
  assert.equal((await d.list(owner)).length,0);
  const created=await d.prepare(owner,{...request,targetAsset:'base-usdc',route:'merchant'});
  assert.equal((await d.list(owner))[0].currency,'EUR');assert.equal((await d.list(owner))[0].agent.network,'Base');
  assert.equal((await d.prepare(owner,request)).id,created.id);
 }finally{await f.close();}
});
