import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersonalisedQuoteService} from '../server/quote-first/personalised-quote.mjs';
import {personalisationRecord,personalisedSamplePayload,sampleRecipients} from './fixtures/personalised-samples.mjs';
const now=Date.parse('2026-11-02T12:00:00Z'),target={amount:'25',currency:'GBP',method:'wise'},actor='opaque_server_session';
function fixture(options={}){
 const record=personalisationRecord('research',now),calls=[];let resolutions=0;
 const service=createPersonalisedQuoteService({clock:()=>now,resolveContext:async(a,id)=>{assert.equal(a,actor);assert.equal(id,record.recipient.id);resolutions++;return structuredClone(record);},fetchImpl:async(url,o)=>{calls.push({url,options:o});options.onFetch?.(record);const p=personalisedSamplePayload(JSON.parse(o.body),now,options.scenario);return new Response(JSON.stringify(p),{headers:{'Content-Type':'application/json'}});},...options});
 return {service,record,calls,get resolutions(){return resolutions;},async input(){const c=await service.context(actor,{receivingWalletId:'research'});return {...target,receivingWalletId:'research',contextId:c.contextId,shareAddresses:true};}};
}
test('personalised quotes use server-resolved wallets; nothing is signed or reserved',async()=>{
 const f=fixture(),input=await f.input(),r=await f.service.quotes(actor,input),b=JSON.parse(f.calls[0].options.body);
 assert.equal(b.user,f.record.buyer.address);assert.equal(b.recipient,f.record.recipient.address);assert.equal(r.addressBinding,'server_resolved');assert.equal(r.eligibility,'not_verified');assert.equal(r.canCreatePayment,false);
 assert.equal(r.rows[0].offers[0].youReceive.amountRaw,'25000000');assert.equal(r.rows[0].offers[0].conditions.buyerEligibilityVerified,false);assert.equal(r.addressContext.receivingPlatformSupportVerified,false);
 assert.deepEqual(Object.keys(f.calls[0].options.headers).sort(),['Accept','Content-Type']);assert.equal(f.calls[0].url,'https://api.zkp2p.xyz/v3/quote/exact-token?quotesToReturn=3');assert.equal(f.calls[0].options.credentials,'omit');assert.equal(f.calls[0].options.redirect,'error');
 assert.doesNotMatch(JSON.stringify(r),/sample_customer|sample_session_binding|payeeDetails|privateKey|signature/);
 const reviewed=await f.service.review(actor,{...input,offerId:r.rows[0].offers[0].id});assert.equal(reviewed.status,'terms_match');assert.equal(reviewed.reserved,false);assert.equal(reviewed.readiness.buyer,'wallet_link_checked');assert.equal(reviewed.offer.canExecute,false);
});
test('address sharing is explicit and arbitrary browser wallet/identity fields are rejected before network',async()=>{
 const f=fixture(),input=await f.input();
 for(const patch of [{shareAddresses:false},{shareAddresses:undefined},{contextId:'bad'},{buyer:'0x'+'a'.repeat(40)},{recipient:'0x'+'b'.repeat(40)},{owner:'other'},{signature:'forbidden'},{method:'paypal'},{amount:'0'},{walletAddress:'private'}])await assert.rejects(f.service.quotes(actor,{...input,...patch}));
 assert.equal(f.calls.length,0);
});
test('missing buyer, wrong owner, unverified link, wrong chain and expired evidence fail before provider calls',async()=>{
 const edits=[r=>r.buyer=null,r=>r.session.expiresAt=now,r=>r.buyer.owner='someone_else',r=>r.buyer.sessionBinding='other_session',r=>r.buyer.verification='browser_claim',r=>r.buyer.chainId=1,r=>r.buyer.verifiedAt=now+1,r=>r.buyer.verifiedAt=now-300000,r=>r.buyer.expiresAt=now,r=>r.recipient.owner='someone_else',r=>r.recipient.enabled=false,r=>r.recipient.chainId=1,r=>r.recipient.token='0x'+'1'.repeat(40),r=>r.recipient.address='0x'+'0'.repeat(40)];
 for(const edit of edits){const f=fixture(),input=await f.input();edit(f.record);await assert.rejects(f.service.quotes(actor,input));assert.equal(f.calls.length,0);}
 const f=fixture();f.record.buyer=null;assert.equal((await f.service.context(actor,{receivingWalletId:'research'})).status,'buyer_wallet_needed');
});
test('wallet edits or session changes require a new address review before sharing',async()=>{
 for(const edit of [r=>r.recipient.address=sampleRecipients.assistant,r=>r.recipient.revision='2',r=>r.buyer.address='0x'+'3'.repeat(40),r=>{r.session.binding='new_session_binding';r.buyer.sessionBinding=r.session.binding;}]){
  const f=fixture(),input=await f.input();edit(f.record);await assert.rejects(f.service.quotes(actor,input),{code:'address_context_changed'});assert.equal(f.calls.length,0);
 }
});
test('revocation or changed destination during provider response suppresses all results',async()=>{
 for(const edit of [r=>r.recipient.address=sampleRecipients.assistant,r=>r.session.expiresAt=now,r=>r.buyer=null]){
  const f=fixture({onFetch:edit}),input=await f.input();await assert.rejects(f.service.quotes(actor,input));assert.equal(f.calls.length,1);
 }
});
test('offer fingerprint binds buyer and destination and quote expires with wallet evidence',async()=>{
 const f=fixture();f.record.buyer.expiresAt=now+15000;const input=await f.input(),first=await f.service.quotes(actor,input);
 assert.equal(first.rows[0].offers[0].validUntil,now+15000);
 f.record.buyer.address='0x'+'4'.repeat(40);const second=await f.service.quotes(actor,await f.input());assert.notEqual(first.rows[0].offers[0].id,second.rows[0].offers[0].id);
 const r=await f.service.review(actor,{...await f.input(),offerId:first.rows[0].offers[0].id});assert.equal(r.status,'terms_changed');assert.equal(r.offer,null);
});
test('all supported method/currency combinations use the same guarded path',async()=>{
 const {calculatorMethods}=await import('../server/quote-first/target-calculator.mjs');let count=0;
 for(const m of calculatorMethods)for(const currency of m.currencies){const f=fixture(),input={...await f.input(),method:m.id,currency};const r=await f.service.quotes(actor,input);assert.equal(r.rows[0].offers.length,1,m.id+':'+currency);assert.equal(r.canCreatePayment,false);count++;}
 assert.equal(count,60);
});

 test('client rejects responses for a different address context or expired evidence',async()=>{
 const {matchesAddressContext}=await import('../src/personalised-quote-state.mjs');const f=fixture(),input=await f.input(),r=await f.service.quotes(actor,input),c=r.addressContext;
 assert.equal(matchesAddressContext(r,c,now),true);
 for(const edit of [x=>x.addressContext.contextId='other',x=>x.addressContext.buyer.address='other',x=>x.addressContext.recipient.id='other',x=>x.addressContext.validUntil=now,x=>x.eligibility='verified',x=>x.canCreatePayment=true]){const changed=structuredClone(r);edit(changed);assert.equal(matchesAddressContext(changed,c,now),false);}
 });
