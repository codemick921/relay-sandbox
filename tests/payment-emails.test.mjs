import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {planPaymentEmail,defaultPaymentEmailPreferences,updatePaymentEmailPreferences,PAYMENT_EMAIL_SENDING_ENABLED} from '../hosted/payment-email-policy.mjs';
import {paymentEmailMessage,paymentDetailLink} from '../shared/payment-email-message.mjs';
import {resumeTarget,resolveResume} from '../src/payment-resume.mjs';
import {comparisonFixture,now} from './fixtures/cost-comparison.mjs';
const account={id:'email-fixture',email:'sample@example.test',emailVerified:true},owner='customer:'+account.id;
async function fixture(){
 const f=await comparisonFixture();f.order.owner=owner;
 const prefs=updatePaymentEmailPreferences(defaultPaymentEmailPreferences(),{arrival:true,attention:true},now-2000);
 const pending=structuredClone(f.order);pending.status='checkout_ready';pending.delivery=null;pending.verification={};
 const base={order:f.order,owner,account,preferences:prefs,now};
 const previous=planPaymentEmail({...base,order:pending,now:now-1000}).snapshot;
 return {base,previous,pending,run:updates=>planPaymentEmail({...base,previous,...updates})};
}
test('sending is disabled, opt-ins default off and opt-in time is stable until disabled',()=>{
 assert.equal(PAYMENT_EMAIL_SENDING_ENABLED,false);
 const off=defaultPaymentEmailPreferences();assert.equal(off.arrival,false);assert.equal(off.attention,false);
 const on=updatePaymentEmailPreferences(off,{arrival:true,attention:false},now);assert.equal(on.arrivalSince,new Date(now).toISOString());
 assert.deepEqual(updatePaymentEmailPreferences(on,{arrival:true,attention:false},now+1000),on);
 const stopped=updatePaymentEmailPreferences(on,{arrival:false,attention:false},now+2000);assert.equal(stopped.arrivalSince,null);
 assert.equal(updatePaymentEmailPreferences(stopped,{arrival:true,attention:false},now+3000).arrivalSince,new Date(now+3000).toISOString());
 for(const invalid of [{arrival:true},null,{arrival:'yes',attention:false},{arrival:true,attention:true,recipient:'other@example.test'}])assert.throws(()=>updatePaymentEmailPreferences(off,invalid));
});
test('a verified native USDC arrival prepares an exact-amount event without changing the input order',async()=>{
 const f=await fixture(),before=structuredClone(f.base.order),result=f.run();
 assert.equal(result.decision,'preview_ready');assert.equal(result.event.amountUsdc,'11.881250');assert.equal(result.event.kind,'arrival');assert.equal(result.event.owner,owner);assert.deepEqual(f.base.order,before);
});
test('paid status, wrong token, wrong recipient and unfinalized receipts cannot trigger arrival mail',async()=>{
 for(const mutate of [o=>{o.status='checkout_settled';o.delivery=null;},o=>o.verification.payments[0].receipt.tokenAddress='0x'+'1'.repeat(40),o=>o.verification.payments[0].receipt.recipient='0x'+'2'.repeat(40),o=>o.verification.payments[0].receipt.finalized=false]){
  const f=await fixture();mutate(f.base.order);assert.notEqual(f.run().event?.kind,'arrival');
 }
});
test('attention takes priority over historical arrival on a dispute and carries no misleading amount',async()=>{
 const f=await fixture();f.base.order.chargebackStatus='OPEN';const result=f.run();
 assert.equal(result.event.kind,'attention');assert.equal(result.event.code,'disputed');assert.equal(result.event.amountUsdc,null);
});
test('review, part payment and uncertain checkout create distinct attention events',async()=>{
 for(const [status,code] of [['checkout_review','review'],['checkout_partial','partial'],['checkout_unknown','uncertain']]){
  const f=await fixture();Object.assign(f.base.order,{status,delivery:null});const result=f.run();assert.equal(result.event.kind,'attention');assert.equal(result.event.code,code);
 }
});
test('a routine pending payment or tracking outage alone does not generate an attention email',async()=>{
 const f=await fixture();const result=f.run({order:{...f.pending,checkedAt:new Date(now).toISOString(),trackingError:'offline'}});assert.equal(result.event,null);
});
test('duplicate observations and changed arrival receipt details do not send a second arrival',async()=>{
 const f=await fixture(),first=f.run();assert.equal(f.run({previous:first.snapshot}).decision,'duplicate');
 const changed={...first.snapshot,fingerprint:'old receipt fingerprint'};assert.equal(f.run({previous:changed}).decision,'arrival_already_recorded');
});
test('event keys are stable for repeated transitions and isolated by account',async()=>{
 const f=await fixture(),a=f.run(),b=f.run();assert.equal(a.event.key,b.event.key);
 const other='customer:another';const next=f.run({owner:other,account:{...account,id:'another'},order:{...f.base.order,owner:other},previous:{...f.previous,owner:other}});assert.notEqual(a.event.key,next.event.key);
});
test('initial baselines and pre-opt-in changes never create a backlog',async()=>{
 const f=await fixture();assert.equal(f.run({previous:null}).decision,'baseline');
 const prefs=updatePaymentEmailPreferences(defaultPaymentEmailPreferences(),{arrival:true,attention:true},now);assert.equal(f.run({preferences:prefs}).decision,'before_opt_in');
});
test('disabled preference, disabled account, unverified email and another owner suppress mail',async()=>{
 const f=await fixture();assert.equal(f.run({preferences:defaultPaymentEmailPreferences()}).decision,'opted_out');
 for(const change of [{emailVerified:false},{disabled:true},{email:null}])assert.equal(f.run({account:{...account,...change}}).decision,'account_unavailable');
 assert.equal(f.run({owner:'customer:other'}).decision,'wrong_account');assert.equal(f.run({order:{...f.base.order,owner:'customer:other'}}).decision,'wrong_account');
});
test('simulations are excluded; missing or stale evidence waits without losing the transition',async()=>{
 const f=await fixture();assert.equal(f.run({order:{...f.base.order,fixture:true}}).decision,'simulation');
 for(const change of [{checkedAt:new Date(now-3600000).toISOString()},{checkedAt:new Date(now+120000).toISOString()},{trackingError:'unavailable'}]){
  const result=f.run({order:{...f.base.order,...change}});assert.equal(result.decision,'evidence_unavailable');assert.deepEqual(result.snapshot,f.previous);
  assert.equal(f.run({previous:result.snapshot}).decision,'preview_ready');
 }
});
test('HTML and text templates preserve exact amount and escape wallet content without external assets',async()=>{
 const f=await fixture(),event={...f.run().event,walletName:'A <img src=x onerror=alert(1)> & wallet'};
 const message=paymentEmailMessage(event,{sample:true});
 assert.match(message.text,/11\.88125 USDC/);assert.ok(message.html.includes('&lt;img'));assert.ok(!message.html.includes('<img'));assert.ok(!message.html.includes('<a '));assert.match(message.html,/Sample email. Not sent/);
 const liveTemplate=paymentEmailMessage(event);assert.equal(liveTemplate.link,`https://app.eupova.com/#payment=${event.requestId}`);assert.ok(liveTemplate.html.includes('<a href="https://app.eupova.com/'));
});
test('attention messages distinguish review, dispute, part payment and checkout uncertainty',async()=>{
 const f=await fixture();for(const code of ['review','disputed','partial','uncertain']){
  const message=paymentEmailMessage({...f.run().event,kind:'attention',code,amountUsdc:null});assert.match(message.text,/do not send the payment again/);assert.doesNotMatch(message.text,/11\.88125|Funds arrived/);
 }
});
test('malformed amounts and unsafe or credential-bearing links are rejected',async()=>{
 const f=await fixture(),event=f.run().event;
 for(const amountUsdc of ['0.000000','-1.000000','1e6','1.1',null])assert.throws(()=>paymentEmailMessage({...event,amountUsdc}));
 for(const origin of ['javascript:alert(1)','http://eupova.com','https://user:secret@app.eupova.com','https://app.eupova.com/?token=x','https://app.eupova.com/path'])assert.throws(()=>paymentDetailLink(origin,event.requestId));
 assert.throws(()=>paymentDetailLink('https://app.eupova.com','not-an-id'));
});
test('email deep links open read-only payment details, require sign-in and contain no provider tokens',async()=>{
 const f=await fixture(),event=f.run().event,link=paymentDetailLink('https://app.eupova.com',event.requestId),target=resumeTarget(new URL(link));
 assert.deepEqual(target,{kind:'payment-help',id:event.requestId});assert.deepEqual(resolveResume(target,{account}),target);assert.deepEqual(resolveResume(target,{}),{kind:'resume-unavailable'});
 assert.deepEqual(resumeTarget({hash:'#payment=https://evil.test'}),{kind:'invalid'});
 assert.equal(new URL(link).search,'');
});
test('production worker and server do not register sample endpoints, a mail transport or payment email planner',async()=>{
 for(const file of ['hosted/server.mjs','hosted/worker.mjs','hosted/mail-transport.mjs']){const source=await readFile(new URL('../'+file,import.meta.url),'utf8');assert.doesNotMatch(source,/payment-email-preview|payment-email-policy|paymentEmailMessage/);}
});

test('resolving a dispute does not reannounce an arrival already present in the baseline',async()=>{
 const f=await fixture(),baseline=planPaymentEmail({...f.base,order:{...f.base.order,chargebackStatus:'OPEN'},previous:null});
 assert.equal(baseline.snapshot.arrived,true);assert.equal(f.run({previous:baseline.snapshot}).decision,'arrival_already_recorded');
});
