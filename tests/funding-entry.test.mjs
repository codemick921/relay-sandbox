import test from 'node:test';
import assert from 'node:assert/strict';
import {fundingEntry,activeFundingDraft} from '../src/funding-entry.mjs';
const state=()=>({account:{id:'customer'},agents:[{id:'wallet'}],orders:[],fundingDrafts:[],liveFunding:{paymentsEnabled:true,draftsEnabled:true}});
test('funding entry does not expose a customer action to signed-out or tester state',()=>{
 assert.equal(fundingEntry(null),null);assert.equal(fundingEntry({...state(),account:null}),null);
});
test('first wallet routes to protected wallet setup, then to funding selection',()=>{
 const s=state();s.agents=[];assert.deepEqual(fundingEntry(s),{kind:'wallet',label:'Fund a wallet',needsWallet:true});
 s.agents.push({id:'wallet'});assert.deepEqual(fundingEntry(s),{kind:'fund',label:'Fund a wallet'});
});
test('existing draft takes precedence over new funding and missing wallet',()=>{
 const s={...state(),agents:[],fundingDrafts:[{id:'saved',status:'draft'}]};
 assert.deepEqual(fundingEntry(s),{kind:'funding-draft',id:'saved',label:'Review existing request',existing:true});
});
test('stopped, superseded and terminal drafts do not hijack the new funding entry',()=>{
 const s={...state(),fundingDrafts:[{id:'a',status:'bound',stoppedAt:'today'},{id:'b',status:'draft',supersededBy:'new'},{id:'c',status:'cancelled'},{id:'d',status:'closed'}]};
 assert.equal(activeFundingDraft(s),undefined);assert.equal(fundingEntry(s).kind,'fund');
 s.fundingDrafts.push({id:'pending',status:'bound',cancellationState:'requested'});assert.equal(fundingEntry(s).id,'pending');
});
test('unresolved live orders without a draft lead to their existing tracking screen',()=>{
 for(const status of ['checkout_unknown','checkout_ready','checkout_partial','checkout_review','checkout_settled','checkout_confirming']){
  const s={...state(),orders:[{id:'existing',kind:'checkout',source:'live',status}]};assert.equal(fundingEntry(s).id,'existing');
 }
});
test('historical, stopped and simulated orders do not block the next funding entry',()=>{
 const s={...state(),orders:[...['checkout_received','checkout_cancelled'].map(status=>({kind:'checkout',source:'live',status})),{kind:'checkout',source:'live',status:'checkout_ready',stoppedInRelay:true},{kind:'checkout',source:'live',status:'checkout_review',fixture:true},{kind:'checkout',source:'live',status:'checkout_ready',journey:true},{kind:'checkout',source:'sandbox',status:'checkout_ready'}]};assert.equal(fundingEntry(s).kind,'fund');
});
test('payment mode is reflected in the entry without changing server flags',()=>{
 const s={...state(),liveFunding:{paymentsEnabled:false,draftsEnabled:true}};
 assert.equal(fundingEntry(s).kind,'live-fund');assert.equal(fundingEntry(s).label,'Prepare funding');
 s.fundingJourneyEnabled=true;assert.equal(fundingEntry(s).label,'Try test funding');assert.equal(fundingEntry(s).kind,'fund');
 s.liveFunding.draftsEnabled=false;s.fundingJourneyEnabled=false;assert.equal(fundingEntry(s).disabled,true);assert.equal(fundingEntry(s).kind,null);
 assert.equal(s.liveFunding.paymentsEnabled,false);
});
test('entry derivation is read-only and uses only the supplied account state',()=>{
 const s=state(),before=JSON.stringify(s);fundingEntry(s);assert.equal(JSON.stringify(s),before);
 const other={...state(),fundingDrafts:[{id:'other',status:'draft'}]};assert.equal(fundingEntry(other).id,'other');assert.equal(fundingEntry(s).kind,'fund');
});

test('paid tracking-only requests retain history but no longer hijack new funding; unacknowledged paid requests still do',()=>{
 const s=state();s.fundingDrafts=[{id:'paid',status:'bound'}];s.orders=[{id:'paid',kind:'checkout',source:'live',status:'checkout_confirming'}];
 assert.equal(fundingEntry(s).id,'paid');s.fundingDrafts[0].trackingOnlyAt='today';s.orders[0].trackingOnly=true;
 assert.equal(activeFundingDraft(s),undefined);assert.equal(fundingEntry(s).kind,'fund');assert.equal(s.orders[0].status,'checkout_confirming');
 s.fundingDrafts.push({id:'new',status:'draft'});assert.equal(fundingEntry(s).id,'new');
});
