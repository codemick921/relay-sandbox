import test from 'node:test';
import assert from 'node:assert/strict';
import {receivingGuidance,destinationProfiles} from '../src/destination-profiles.mjs';
test('receiving answers cannot imply provider verification or enable a route',()=>{
 for(const id of ['base','hosted']){
  for(const network of [undefined,'yes','no','unexpected'])for(const simple of [undefined,'yes','no'])for(const conditions of [undefined,'yes','no']){
   const r=receivingGuidance(id,{network,simple,conditions});
   assert.equal(r.kind==='reviewed',network==='yes'&&simple==='yes'&&conditions==='yes');
   assert.equal('canPay' in r,false);
  }
  assert.equal(receivingGuidance(id,{network:'no'}).kind,'unsupported');
  assert.equal(receivingGuidance(id,{simple:'no'}).kind,'unsupported');
 }
 assert.equal(receivingGuidance('tempo',{network:'yes',simple:'yes',conditions:'yes'}).kind,'unsupported');
 assert.equal(receivingGuidance('invented',{network:'yes',simple:'yes',conditions:'yes'}).kind,'pending');
 assert.equal(destinationProfiles.length,3);
});
