import test from 'node:test';
import assert from 'node:assert/strict';
import {fundingOptions,peerMethods} from '../src/funding-options.mjs';
const live=()=>({account:{id:'customer'},agents:[{id:'wallet'}],fundingDrafts:[],orders:[],paymentsDisabled:false,previewMode:true,fundingJourneyEnabled:true,liveFunding:{paymentsEnabled:true,draftsEnabled:true,rails:['revolut','wise']},rampFunding:{mode:'simulation',paymentsEnabled:false,externalConnectionsEnabled:false}});
test('live Peer methods require known configured rails and never turn Ramp into a live option',()=>{
 const s=live(),o=fundingOptions(s);assert.equal(o.live,true);assert.deepEqual(o.methods.map(x=>x.id),['revolut','wise']);assert.equal(o.action.kind,'live-fund');assert.equal(o.peerTest,false);assert.equal(o.rampTest,false);
 s.rampFunding={mode:'live',paymentsEnabled:true,externalConnectionsEnabled:true};assert.equal(fundingOptions(s).rampTest,false);
});
test('missing, unsupported and contradictory configuration cannot advertise live funding',()=>{
 for(const rails of [undefined,null,[],['new-provider'],'wise']){const s=live();s.liveFunding.rails=rails;const o=fundingOptions(s);assert.equal(o.live,false);assert.equal(o.action,null);assert.equal(o.peerTest,false);}
 for(const flag of [true,undefined,null,'false']){const s=live();s.paymentsDisabled=flag;assert.equal(fundingOptions(s).live,false);assert.equal(fundingOptions(s).rampTest,false);}
 assert.deepEqual(peerMethods({liveFunding:{rails:['wise','wise','unknown','revolut']}}).map(x=>x.id),['wise','revolut']);
});
test('signed-out and tester accounts never get new customer funding actions',()=>{
 for(const s of [null,{}, {...live(),account:null}]){const o=fundingOptions(s);assert.equal(o.action,null);assert.equal(o.live,false);assert.equal(o.peerTest,false);assert.equal(o.rampTest,false);}
});
test('disabled payments allow only separately identified preparation and simulations',()=>{
 const s=live();s.liveFunding.paymentsEnabled=false;s.paymentsDisabled=true;
 let o=fundingOptions(s);assert.equal(o.live,false);assert.equal(o.action.kind,'live-fund');assert.equal(o.prepare,true);assert.equal(o.peerTest,true);assert.equal(o.rampTest,true);
 s.previewMode=false;o=fundingOptions(s);assert.equal(o.peerTest,false);assert.equal(o.rampTest,false);
 s.previewMode=true;s.rampFunding.externalConnectionsEnabled=true;assert.equal(fundingOptions(s).rampTest,false);
 s.liveFunding.draftsEnabled=false;assert.equal(fundingOptions(s).action,null);
});
test('existing unpaid drafts and unresolved live orders take precedence even if payments stop',()=>{
 const s=live();s.fundingDrafts=[{id:'saved',status:'bound'}];s.agents=[];
 assert.deepEqual(fundingOptions(s).action,{kind:'funding-draft',id:'saved',label:'Review existing request'});
 s.liveFunding.paymentsEnabled=false;s.liveFunding.draftsEnabled=false;assert.equal(fundingOptions(s).action.id,'saved');
 s.fundingDrafts=[];s.orders=[{kind:'checkout',id:'held',source:'live',status:'checkout_unknown'}];assert.equal(fundingOptions(s).action.id,'held');
});
test('first wallet setup and stopped requests keep their existing lifecycle',()=>{
 const s=live();s.agents=[];s.fundingDrafts=[{id:'old',status:'bound',stoppedAt:'today'}];assert.deepEqual(fundingOptions(s).action,{kind:'wallet',label:'Add a receiving wallet',needsWallet:true});
 s.agents=[{id:'wallet'}];assert.equal(fundingOptions(s).action.kind,'live-fund');
});
test('funding options derive only from supplied state without mutations or external work',()=>{
 const s=live(),before=JSON.stringify(s);fundingOptions(s);peerMethods(s);assert.equal(JSON.stringify(s),before);
 const one=live();one.liveFunding.rails=['wise'];assert.deepEqual(fundingOptions(one).methods.map(x=>x.id),['wise']);assert.equal(fundingOptions(s).methods.length,2);
});
