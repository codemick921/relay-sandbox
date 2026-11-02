import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT,CompactSign} from 'jose';
import {createPrivyAccessVerifier,createPrivyUserReader} from '../server/quote-first/privy-wallet-reader.mjs';
import {quoteTestEnrollment,createSavedRecipientReader,createBuyerWalletResolver} from '../server/quote-first/buyer-wallet-resolver.mjs';
import {createPersonalisedQuoteService} from '../server/quote-first/personalised-quote.mjs';
import {personalisedSamplePayload} from './fixtures/personalised-samples.mjs';
import {BASE_USDC} from '../server/quote-first/direct-quote.mjs';
const now=Date.parse('2026-11-02T12:00:00Z'),appId='cmvypq4k600vm0hjvdqvg7hxn',did='did:privy:sampleidentity';
const keys=await generateKeyPair('ES256',{extractable:true}),jwk={...await exportJWK(keys.publicKey),kid:'test',alg:'ES256',use:'sig'};
const baseClaims={iss:'privy.io',aud:appId,sub:did,sid:'session-123',iat:now/1000,exp:now/1000+3600};
const token=(patch={},header={})=>new SignJWT({...baseClaims,...patch}).setProtectedHeader({alg:'ES256',kid:'test',typ:'JWT',...header}).sign(keys.privateKey);
const buyer='0x'+'1'.repeat(40),destination='0x'+'2'.repeat(40),owner='customer:11111111-1111-4111-8111-111111111111',subject='22222222-2222-4222-8222-222222222222',walletId='33333333-3333-4333-8333-333333333333';
function rawUser(){return {id:did,is_guest:false,frozen_at:null,email:{address:'private@example.test'},linked_accounts:[{type:'custom_auth',custom_user_id:subject},{type:'wallet',address:buyer,chain_type:'ethereum',chain_id:'eip155:1',wallet_client_type:'privy',connector_type:'embedded',user_can_sign:true,delegated:false,imported:false}]};}
function user(){return {id:did,linkedAccounts:[{type:'custom_auth',subject},{type:'wallet',address:buyer,chainType:'ethereum',walletClientType:'privy',connectorType:'embedded',userCanSign:true,delegated:false,imported:false}]};}
function fixture(){
 let time=now,active=true,reads=0;
 const session={owner,binding:'a'.repeat(64),expiresAt:now+3600000};
 const enrollment={owner,subject,privyDid:did,buyingAddress:buyer,consent:true,consentRecordedAt:now,expiresAt:now+600000,environment:'development'};
 const recipient={id:walletId,owner,address:destination,chainId:8453,token:BASE_USDC,revision:'1',enabled:true};
 const identity=user(),access={did,sid:'sample-session',issuedAt:now,expiresAt:now+3600000},actor={sessionToken:'c'.repeat(64),accessToken:'sample.access.token'};
 const options={clock:()=>time,enabled:()=>active,resolveSession:async()=>structuredClone(session),resolveEnrollment:async()=>structuredClone(enrollment),verifyAccessToken:async()=>structuredClone(access),readRecipient:async(o,id)=>{assert.equal(o,owner);assert.equal(id,walletId);return structuredClone(recipient);},readPrivyUser:async()=>{reads++;return structuredClone(identity);}};
 return {session,enrollment,recipient,identity,access,actor,options,get reads(){return reads;},advance:n=>{time+=n;},disable:()=>{active=false;},resolve:createBuyerWalletResolver(options)};
}
test('ES256 access JWT verifier accepts only the pinned app, session and public key',async()=>{
 const verify=createPrivyAccessVerifier({appId,trustedJwks:{keys:[jwk]},clock:()=>now});
 assert.deepEqual(await verify(await token()),{did,sid:'session-123',issuedAt:now,expiresAt:now+3600000});
 for(const patch of [{iss:'https://privy.io'},{aud:'other'},{aud:[appId,'other']},{sub:'did:privy:../../oops'},{sid:''},{sid:undefined},{exp:now/1000},{iat:now/1000+31},{exp:now/1000+3601},{linked_accounts:'[]'},{custom_metadata:{}},{nbf:now/1000+1}])await assert.rejects(verify(await token(patch)),{code:'privy_access_invalid'});
 for(const header of [{kid:'unknown'},{jku:'https://example.test/keys'},{jwk},{x5u:'https://example.test'},{typ:'identity'}])await assert.rejects(verify(await token({},header)));
 const other=await generateKeyPair('ES256');await assert.rejects(verify(await new SignJWT(baseClaims).setProtectedHeader({alg:'ES256',kid:'test'}).sign(other.privateKey)));
 const hmac=await new SignJWT(baseClaims).setProtectedHeader({alg:'HS256',kid:'test'}).sign(new TextEncoder().encode(JSON.stringify(jwk)));await assert.rejects(verify(hmac));
 for(const raw of ['', 'x'.repeat(8193), 'a.b.c.d.e'])await assert.rejects(verify(raw));
 for(const addition of ['"sub":"did:privy:other",','"s\\u0075b":"did:privy:other",']){
  const body='{'+addition+JSON.stringify(baseClaims).slice(1),signed=await new CompactSign(new TextEncoder().encode(body)).setProtectedHeader({alg:'ES256',kid:'test'}).sign(keys.privateKey);await assert.rejects(verify(signed));
 }
 assert.throws(()=>createPrivyAccessVerifier({appId,trustedJwks:{keys:[{...jwk,d:'private'}]}}));
 assert.throws(()=>createPrivyAccessVerifier({appId,trustedJwks:{keys:[jwk,jwk]}}));
});
test('current-user reader is GET-only, fixed host and returns no unrelated personal data',async()=>{
 const calls=[];const read=createPrivyUserReader({appId,readOnlySecret:'test-only-not-a-real-secret',credentialAccess:'read-only',fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(rawUser());}});
 assert.deepEqual(await read(did),user());assert.equal(calls[0].url,'https://api.privy.io/v1/users/did%3Aprivy%3Asampleidentity');
 assert.equal(calls[0].o.method,'GET');assert.equal(calls[0].o.redirect,'error');assert.equal(calls[0].o.body,undefined);assert.equal(calls[0].o.headers['privy-app-id'],appId);
 assert.doesNotMatch(JSON.stringify(await read(did)),/private@example|secret|Authorization/);
 await assert.rejects(read('did:privy:../../other'));assert.equal(calls.length,2);
 assert.throws(()=>createPrivyUserReader({appId,readOnlySecret:'test-only-not-a-real-secret',credentialAccess:'full'}));
});
test('reader rejects redirects, bad status, oversized, malformed, frozen and unavailable users',async()=>{
 const edits=[()=>new Response('',{status:302,headers:{Location:'https://example.test'}}),()=>new Response('private error',{status:429}),()=>Response.json({...rawUser(),id:'did:privy:wrong'}),()=>Response.json({...rawUser(),is_guest:true}),()=>Response.json({...rawUser(),frozen_at:now/1000}),()=>Response.json({...rawUser(),linked_accounts:[null]}),()=>Response.json({...rawUser(),huge:'x'.repeat(65537)}),()=>new Response('{invalid',{headers:{'content-type':'application/json'}}),()=>new Response('x',{headers:{'content-type':'text/html'}})];
 for(const response of edits){const read=createPrivyUserReader({appId,readOnlySecret:'test-only-not-a-real-secret',credentialAccess:'read-only',fetchImpl:async()=>response()});await assert.rejects(read(did),{code:'privy_user_unavailable'});}
 const read=createPrivyUserReader({appId,readOnlySecret:'test-only-not-a-real-secret',credentialAccess:'read-only',timeoutMs:10,fetchImpl:async()=>new Promise(()=>{})});await assert.rejects(read(did),{code:'privy_user_unavailable'});
});
test('test enrollment is exact-owner, absolute duration and a server-pinned buying address',async()=>{
 const record={owner,subject,privyDid:did,buyingAddress:buyer,consent:true,consentRecordedAt:now,expiresAt:now+600000},read=quoteTestEnrollment(record,()=>now);
 assert.equal((await read(owner)).buyingAddress,buyer);assert.equal(await read('other'),null);
 for(const patch of [{expiresAt:now+1800001},{consent:false},{subject:owner.slice(9)},{consentRecordedAt:now+1},{buyingAddress:'0x123'},{extra:true}])assert.throws(()=>quoteTestEnrollment({...record,...patch},()=>now));
 assert.equal(await quoteTestEnrollment(record,()=>now+600000)(owner),null);
});
test('saved receiving wallet lookup is SELECT only, owner scoped and includes revision',async()=>{
 const row={id:walletId,owner,data:{address:destination,network:'Base',token:'USDC'},address_key:destination,funding_revision:'7'},calls=[];
 const read=createSavedRecipientReader({query:async(sql,args)=>{calls.push([sql,args]);return {rows:[structuredClone(row)]};}});
 assert.equal((await read(owner,walletId)).revision,'7');assert.match(calls[0][0],/^SELECT .* WHERE owner=\$1 AND id=\$2$/);assert.deepEqual(calls[0][1],[owner,walletId]);
 for(const change of [()=>row.owner='other',()=>{row.owner=owner;row.data.network='Ethereum';},()=>{row.data.network='Base';row.address_key=buyer;}]){change();await assert.rejects(read(owner,walletId));}
});
test('unchanged evidence gives stable short proof; renewal and token refresh require review',async()=>{
 const f=fixture(),first=await f.resolve(f.actor,walletId);f.advance(1000);const next=await f.resolve(f.actor,walletId);
 assert.deepEqual(next,first);assert.equal(f.reads,2);assert.equal(first.buyer.expiresAt,now+60000);
 f.advance(59000);const renewed=await f.resolve(f.actor,walletId);assert.notEqual(renewed.buyer.reference,first.buyer.reference);
 const changed=await f.resolve({...f.actor,accessToken:'changed.access.token'},walletId);assert.notEqual(changed.buyer.reference,renewed.buyer.reference);
 assert.doesNotMatch(JSON.stringify(changed),/sample.access.token/);
});
test('disabled, unenrolled or missing wallet stops before any quote',async()=>{
 const f=fixture();f.disable();await assert.rejects(f.resolve(f.actor,walletId));assert.equal(f.reads,0);
 const noPin=fixture();noPin.enrollment.buyingAddress=null;assert.equal((await noPin.resolve(noPin.actor,walletId)).buyer,null);
 const expired=fixture();expired.advance(600000);await assert.rejects(expired.resolve(expired.actor,walletId));assert.equal(expired.reads,0);
});
test('identity, wallet type and signing capability mismatches are rejected',async()=>{
 const changes=[f=>f.access.did='did:privy:other',f=>f.identity.id='did:privy:other',f=>f.identity.linkedAccounts[0].subject='other',f=>f.identity.linkedAccounts.push({type:'custom_auth',subject}),f=>f.identity.linkedAccounts.pop(),f=>f.identity.linkedAccounts[1].chainType='solana',f=>f.identity.linkedAccounts[1].walletClientType='metamask',f=>f.identity.linkedAccounts[1].userCanSign=false,f=>f.identity.linkedAccounts[1].delegated=true,f=>f.identity.linkedAccounts[1].imported=true,f=>f.identity.linkedAccounts.push({...f.identity.linkedAccounts[1]})];
 for(const change of changes){const f=fixture();change(f);await assert.rejects(f.resolve(f.actor,walletId));}
});
test('session, recipient, lease and kill-switch changes during lookup discard context',async()=>{
 const changes=[f=>f.session.binding='new-binding-aaaaaaaa',f=>f.recipient.revision='2',f=>f.enrollment.expiresAt=now,f=>f.disable(),f=>f.advance(3600000)];
 for(const change of changes){const f=fixture(),read=f.options.readPrivyUser;const resolver=createBuyerWalletResolver({...f.options,readPrivyUser:async()=>{const u=await read();change(f);return u;}});await assert.rejects(resolver(f.actor,walletId));}
});
test('a failed concurrent lookup invalidates earlier in-flight proof',async()=>{
 const f=fixture();let release;let failed=false;const gate=new Promise(resolve=>{release=resolve;});
 const resolver=createBuyerWalletResolver({...f.options,readPrivyUser:async()=>{if(failed)throw Error('provider down');await gate;return user();}});
 const pending=resolver(f.actor,walletId);await new Promise(resolve=>setImmediate(resolve));failed=true;await assert.rejects(resolver(f.actor,walletId));release();await assert.rejects(pending);
});
test('personalised service uses verified server addresses and discards quotes after unlink',async()=>{
 const f=fixture();let calls=0,unlink=false;
 const service=createPersonalisedQuoteService({clock:f.options.clock,resolveContext:f.resolve,fetchImpl:async(url,o)=>{calls++;const body=JSON.parse(o.body);assert.equal(body.user,buyer);assert.equal(body.recipient,destination);if(unlink)f.identity.linkedAccounts.pop();return Response.json(personalisedSamplePayload(body,now));}});
 const context=await service.context(f.actor,{receivingWalletId:walletId}),input={amount:'25',currency:'GBP',method:'wise',receivingWalletId:walletId,contextId:context.contextId,shareAddresses:true};
 const quotes=await service.quotes(f.actor,input);assert.equal(quotes.canCreatePayment,false);assert.equal(quotes.reserved,false);assert.equal(quotes.rows[0].offers[0].validUntil,now+60000);
 unlink=true;await assert.rejects(service.quotes(f.actor,input));assert.equal(calls,2);
});
