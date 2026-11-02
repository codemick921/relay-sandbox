import test from 'node:test';
import assert from 'node:assert/strict';
import {createOverview,addOverviewRecord,overviewGroup} from '../shared/funding-overview.mjs';
test('overview separates actionable records from ordinary waiting without promoting evidence',()=>{
 for(const code of ['review','uncertain','partial','disputed','attempt_expired'])assert.equal(overviewGroup({code}),'attention');
 for(const code of ['draft','awaiting','settled','confirming','stopped','future_status'])assert.equal(overviewGroup({code}),'progress');
 assert.equal(overviewGroup({code:'received',deliveryConfirmed:false}),'attention');
 assert.equal(overviewGroup({code:'received',deliveryConfirmed:true}),null);
 assert.equal(overviewGroup({code:'ended'}),null);
 assert.equal(overviewGroup({code:'awaiting',providerFulfilled:true,netUsdc:'100',confirmedUsdc:'100'}),'progress');
 assert.equal(overviewGroup({code:'awaiting',trackingUnavailable:true,stale:true}),'progress');
 for(const code of ['review','received','awaiting'])assert.equal(overviewGroup({code,simulated:true}),null);
});
test('overview counts all records but retains three per group with only display-safe evidence',()=>{
 const data=createOverview();for(let i=0;i<550;i++)addOverviewRecord(data,{id:String(i),code:i<540?'received':i<545?'review':'settled',deliveryConfirmed:i<540,checkoutUrl:'SECRET',providerFulfilled:true});
 addOverviewRecord(data,{id:'sim',code:'review',simulated:true});
 assert.equal(data.total,550);assert.equal(data.attention.total,5);assert.equal(data.progress.total,5);
 assert.deepEqual(data.attention.records.map(x=>x.id),['540','541','542']);assert.equal(data.progress.records.length,3);
 assert.ok(!JSON.stringify(data).includes('SECRET'));assert.ok(!JSON.stringify(data).includes('sim'));
 assert.equal(data.progress.records[0].providerFulfilled,true);assert.equal(data.progress.records[0].checkedAt,null);
});
