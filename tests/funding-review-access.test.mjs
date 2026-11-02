import test from 'node:test';
import assert from 'node:assert/strict';
import {fundingReviewAccess} from '../src/funding-entry.mjs';
const agent={id:'wallet',address:'0x'+'1'.repeat(40),network:'Base',token:'USDC',revision:1};
const request={id:'agent-request',agent,walletRevision:'1',expiresAt:new Date(2000).toISOString(),connectionAvailable:true,walletCurrent:true};
const draft={id:'existing-request',status:'bound'},state={fundingDrafts:[draft]};
test('an open agent request can be reviewed beside an active draft without changing it',()=>{
 const before=JSON.stringify({state,request});const gate=fundingReviewAccess(state,request,agent,1000);
 assert.equal(gate.intercept,false);assert.equal(gate.reviewOnly,true);assert.equal(gate.existing,draft);assert.equal(JSON.stringify({state,request}),before);
});
test('ordinary funding and invalid agent requests keep the existing-request intercept',()=>{
 for(const r of [null,{...request,expiresAt:new Date(500).toISOString()},{...request,cancelledAt:'sample'},{...request,connectionAvailable:false},{...request,draftId:'linked'},{...request,walletCurrent:false}]){
  const gate=fundingReviewAccess(state,r,agent,1000);assert.equal(gate.intercept,true);assert.equal(gate.reviewOnly,false);assert.equal(gate.existing,draft);
 }
 assert.equal(fundingReviewAccess(state,request,{...agent,address:'0x'+'2'.repeat(40)},1000).intercept,true);
});
test('completed or explicitly separated drafts do not unnecessarily block a new review',()=>{
 for(const change of [{status:'closed'},{status:'cancelled'},{trackingOnlyAt:'sample'},{stoppedAt:'sample'},{supersededBy:'sample'}]){
  const gate=fundingReviewAccess({fundingDrafts:[{...draft,...change}]},request,agent,1000);assert.equal(gate.existing,undefined);assert.equal(gate.reviewOnly,false);assert.equal(gate.intercept,false);
 }
});
