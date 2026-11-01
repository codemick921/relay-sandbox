import test from 'node:test';
import assert from 'node:assert/strict';
import {fundingCosts} from '../src/funding-costs.mjs';
import {exampleCostQuote} from '../src/funding-quote.mjs';
const now=1792920000000;
const quote={simulated:true,pence:2500,network:'Base',token:'USDC',grossUsdc:'31.250000',feeUsdc:'0.625000',netUsdc:'30.625000',expiresAt:new Date(now+60000).toISOString()};
const options={simulated:true,requestedPence:2500,currency:'GBP',now};
test('example quote accounts for every modelled amount without double charging the fee',()=>{
 const e=exampleCostQuote(quote,options);assert.equal(e.net,'30.625000');assert.equal(e.totalMinor,2500);assert.equal(e.effectiveRate,'1.225000');
 const m=fundingCosts({...options,testQuote:quote});assert.equal(m.allIn.value,'£25.00');assert.equal(m.allIn.complete,true);assert.match(m.allIn.note,/simulated/);assert.equal(m.rows.find(r=>r.label==='Estimated Peer fee').value,'0.625000 USDC');
});
test('simulation evidence cannot become a real quote or apply to another amount or currency',()=>{
 for(const o of [{simulated:false},{currency:'EUR'},{requestedPence:3000}])assert.equal(exampleCostQuote(quote,{...options,...o}),null);
 for(const q of [{...quote,simulated:false},{...quote,netUsdc:'31.25'},{...quote,feeUsdc:'-1'},{...quote,network:'Tempo'},{...quote,expiresAt:'bad'}])assert.equal(exampleCostQuote(q,options),null);
 const m=fundingCosts({requestedPence:2500,testQuote:quote});assert.equal(m.allIn.value,'Not confirmed');assert.equal(m.allIn.complete,false);
});
test('expired examples stay labelled and cannot become current quotes; unknown live costs remain unknown',()=>{
 const m=fundingCosts({...options,testQuote:quote,now:now+60000});assert.equal(m.status,'quote_expired');assert.equal(m.allIn.complete,false);
 const live=fundingCosts({requestedPence:2500,now,verification:{payIn:{schema:'peer-fiat-v2',status:'within_peer_limit',currency:'GBP',totalPence:2500,expiresAt:quote.expiresAt,checkedAt:new Date(now).toISOString()}}});
 assert.equal(live.allIn.complete,false);assert.equal(live.allIn.value,'Not confirmed');assert.match(live.allIn.note,/Unknown costs are not zero/);
});
