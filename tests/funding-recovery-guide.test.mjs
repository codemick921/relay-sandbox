import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryPlan,recoverySummary} from '../shared/funding-recovery.mjs';
const record={id:'example-request',providerOrderId:'example-provider',code:'awaiting',title:'Waiting',currency:'EUR',requestedAmount:'25.00',hasOrder:true,providerFulfilled:false,deliveryConfirmed:false,confirmedUsdc:'0.000000',netUsdc:null};
test('self-reported no-payment cannot override uncertain, disputed, stale or received evidence',()=>{
 for(const override of [{code:'uncertain'},{code:'review'},{code:'disputed'},{trackingUnavailable:true},{stale:true},{tracking:{code:'evidence_pending'}}]){
  const r={...record,...override},before=JSON.stringify(r),plan=recoveryPlan(r,'no');assert.equal(plan.mayReplace,false);assert.match(plan.action,/Do not (send|pay)/i);assert.equal(JSON.stringify(r),before);
 }
 const p=recoveryPlan({...record,providerFulfilled:true,netUsdc:'10.000000'},'no');assert.match(p.action,/Do not send a replacement/);
});
test('arrival is historical delivery, never agent spending readiness',()=>{
 const p=recoveryPlan({...record,code:'received',providerFulfilled:true,deliveryConfirmed:true,confirmedUsdc:'10'},'no');
 assert.equal(p.steps[2].status,'Confirmed');assert.equal(p.steps[3].status,'Not checked');assert.match(p.action,/does not prove that a task was paid for/);
});
test('expiry and local stop never claim cancellation or return; zero is not partial delivery',()=>{
 const p=recoveryPlan({...record,stopped:true,code:'attempt_expired'},'no');assert.match(p.action,/not a refund or provider cancellation/);assert.equal(p.steps[2].status,'Not confirmed');
 assert.match(recoveryPlan({...record,code:'draft'},'yes').action,/sent money separately/);
});
test('copyable summary is allowlisted, labelled and cannot leak raw checkout data',()=>{
 const r={...record,simulated:true,checkoutUrl:'SECRET_CHECKOUT',rawProvider:{token:'SECRET_TOKEN'},address:'PRIVATE_ADDRESS',title:'Waiting\nInjected line'};
 const summary=recoverySummary(r,'yes');assert.match(summary,/SIMULATION/);assert.match(summary,/self-reported/);assert.ok(!summary.includes('SECRET'));assert.ok(!summary.includes('PRIVATE_ADDRESS'));assert.ok(!summary.includes('Waiting\n'));assert.match(summary,/25.00 EUR/);
});
