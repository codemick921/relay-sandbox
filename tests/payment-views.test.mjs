import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesPaymentStatus,paymentTone,paymentMilestones} from '../shared/payment-views.mjs';
import {historyOptions} from '../hosted/funding-history.mjs';
test('in-progress group retains unresolved, stopped, disputed and expired requests; completion stays separate',()=>{
 for(const code of ['draft','awaiting','uncertain','partial','settled','confirming','stopped','review','disputed','attempt_expired','future_unknown'])assert.equal(matchesPaymentStatus({code},'in_progress'),true,code);
 for(const code of ['received','ended'])assert.equal(matchesPaymentStatus({code},'in_progress'),false,code);
 assert.equal(matchesPaymentStatus({code:'disputed',deliveryConfirmed:true},'received'),false);
 assert.equal(matchesPaymentStatus({code:'received',stopped:true},'received'),true);
 assert.equal(historyOptions(new URLSearchParams('status=in_progress')).status,'in_progress');
 assert.equal(historyOptions(new URLSearchParams('status=attempt_expired')).status,'attempt_expired');
});
test('progress never promotes payment evidence or an amount into confirmed wallet delivery',()=>{
 const r={id:'sample',providerFulfilled:true,deliveryConfirmed:false,confirmedUsdc:'10.000000',netUsdc:'10.000000',createdAt:'2026-11-01T10:00:00Z',code:'review'};
 const before=structuredClone(r),steps=paymentMilestones(r);
 assert.equal(steps[1].confirmed,true);assert.equal(steps[2].confirmed,false);
 assert.equal(steps[2].detail,'Arrival recorded; full confirmation pending');assert.equal(paymentTone(r),'attention');assert.deepEqual(r,before);
 for(const v of [null,undefined,'0.000000'])assert.equal(paymentMilestones({confirmedUsdc:v,netUsdc:v})[2].detail,'Not yet confirmed');
});
test('simulated and disputed receipts keep their explicit presentation states',()=>{
 assert.equal(paymentTone({simulated:true,deliveryConfirmed:true,code:'received'}),'simulation');
 assert.equal(paymentTone({deliveryConfirmed:true,code:'disputed'}),'attention');
 assert.equal(paymentTone({deliveryConfirmed:true,code:'received'}),'received');
});
