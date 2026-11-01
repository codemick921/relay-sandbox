import test from 'node:test';
import assert from 'node:assert/strict';
import {peerHandoffUrl} from '../src/peer-handoff.mjs';
const id='saved-request',url='https://pay.peer.xyz/?order=fixture&token=fake-test-token&method=revolut';
test('direct handoff keeps the exact server-returned saved Peer checkout',()=>{assert.equal(peerHandoffUrl({id,checkoutUrl:url},id),url);});
test('direct handoff rejects another request, missing links and untrusted destinations',()=>{
 for(const checkoutUrl of [null,'','javascript:alert(1)','http://pay.peer.xyz/?order=x&token=y&method=wise','https://pay.peer.xyz.attacker.test/?order=x&token=y&method=wise','https://user:secret@pay.peer.xyz/?order=x&token=y&method=wise','https://pay.peer.xyz/?order=x&token=y&method=wise#unexpected','https://pay.peer.xyz/other?order=x&token=y&method=wise','https://pay.peer.xyz/?order=x','https://example.test/'])assert.throws(()=>peerHandoffUrl({id,checkoutUrl},id));
 assert.throws(()=>peerHandoffUrl({id:'other',checkoutUrl:url},id));
});
