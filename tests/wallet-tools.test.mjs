import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleQuote,createWalletToolsSample} from '../src/wallet-tools-samples.mjs';
import {readWalletToolsStatus} from '../src/wallet-tools-status.mjs';
import {matchesAddressContext} from '../src/personalised-quote-state.mjs';
import {calculatorReducer,initialCalculatorState} from '../src/target-calculator-state.mjs';
test('visible tools read access only and discard identity',async()=>{
 const calls=[],now=Date.now();const status=await readWalletToolsStatus({now,fetchImpl:async(path,options)=>{
  calls.push({path,options});return new Response(JSON.stringify({visible:true,environment:'development',appId:'cmvypq4k600vm0hjvdqvg7hxn',context:'c'.repeat(64),purpose:'wallet_auth',connection:'available',expiresAt:now+60000,secret:'do-not-return'}));
 }});
 assert.deepEqual(Object.keys(status),['connection','wallet']);assert.equal(status.wallet.status,'available');assert.ok(!JSON.stringify(status).includes('do-not-return'));assert.ok(calls.every(c=>!c.options.method&&c.options.credentials==='same-origin'));
});
test('disabled, malformed and failed status never grants access',async()=>{
 for(const response of[()=>new Response('{}',{status:404}),()=>new Response('{}'),()=>{throw Error('network')}]){
  const s=await readWalletToolsStatus({fetchImpl:response});assert.notEqual(s.connection.status,'available');assert.notEqual(s.wallet.status,'available');
 }
});
test('sample quote can review a target but never reserve or pay',()=>{
 const input={amount:'25',currency:'GBP',method:'revolut'},q=sampleQuote(input,{now:1000}),o=q.rows[0].offers[0];
 assert.equal(q.sample,true);assert.equal(q.canCreatePayment,false);assert.equal(o.youReceive.displayAmount,'25.000000');assert.equal(o.fee.displayAmount,'0.250000');
 const review=sampleQuote({...input,offerId:o.id},{now:1100,review:true});assert.equal(review.status,'terms_match');assert.equal(review.reserved,false);
 let state=calculatorReducer(initialCalculatorState(),{type:'search'});state=calculatorReducer(state,{type:'result',generation:state.generation,rows:q.rows,checkedAt:1000});state=calculatorReducer(state,{type:'select',method:'revolut',id:o.id,now:1000});state=calculatorReducer(state,{type:'review'});state=calculatorReducer(state,{type:'reviewed',generation:state.generation,result:review});assert.equal(state.plan.status,'terms_match');
 assert.equal(calculatorReducer(state,{type:'expire',now:70000}).plan,null);
 for(const amount of['0','10001','NaN','-1','1.0000001'])assert.throws(()=>sampleQuote({...input,amount}));
});
test('browser wallet sample has isolated state and expired address checks block quotes',async()=>{
 let now=1000;const one=createWalletToolsSample({now:()=>now}),two=createWalletToolsSample({now:()=>now});assert.equal((await one('inspect')).status,'none');await one('create');const v=await one('verify');assert.equal(v.sample,true);assert.equal((await two('inspect')).status,'none');
 const q=await one('quotes',{amount:'10',currency:'GBP',method:'revolut',contextId:v.context.contextId,shareAddresses:true});assert.ok(matchesAddressContext(q,v.context,now));assert.equal(q.canCreatePayment,false);now=70000;await assert.rejects(one('quotes',{amount:'10',currency:'GBP',method:'revolut',contextId:v.context.contextId,shareAddresses:true}));
});
