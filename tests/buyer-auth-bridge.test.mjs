import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createPublicKey,verify} from 'node:crypto';
import {createBuyerAuthBridge} from '../server/quote-first/buyer-auth-bridge.mjs';
// Ephemeral fixture keys: never persisted, uploaded, or accepted by any live service.
const current=generateKeyPairSync('rsa',{modulusLength:2048}),old=generateKeyPairSync('rsa',{modulusLength:2048});
const origin='https://example.test';
const request={method:'POST',origin,fetchSite:'same-origin',contentType:'application/json',body:{intent:'buyer_wallet_setup'}};
function fixture(overrides={}){
 let now=1000000,active=true,enrolled=true,enabled=true,calls=0,change=()=>{};
 const config={enabled:()=>enabled,origin,issuer:origin+'/auth/buyer',audience:'sample-privy-app',keyId:'sample-key-20261102',privateKey:current.privateKey,
  clock:()=>now,resolveSession:async()=>{calls++;change(calls);return active?{owner:'customer:sample',binding:'opaque-session-version-123',expiresAt:now+3600000}:null;},
  resolveEnrollment:async owner=>enrolled?{owner,subject:'4e87f9b8-69c9-4a0c-8e49-cb66ac4b805e',consent:true,environment:'development',expiresAt:now+3600000}:null,...overrides};
 return {bridge:createBuyerAuthBridge(config),config,get calls(){return calls;},logout:()=>active=false,revoke:()=>enrolled=false,disable:()=>enabled=false,advance:n=>now+=n,onCheck:fn=>change=fn};
}
const decode=token=>{const [h,p,s]=token.split('.');return {header:JSON.parse(Buffer.from(h,'base64url')),claims:JSON.parse(Buffer.from(p,'base64url')),signature:Buffer.from(s,'base64url'),input:h+'.'+p};};
test('default disabled bridge cannot resolve users, publish keys or mint tokens',async()=>{
 const bridge=createBuyerAuthBridge({resolveSession:()=>assert.fail('must not resolve')});
 assert.throws(()=>bridge.publicKeys(),{code:'buyer_auth_disabled'});
 await assert.rejects(bridge.issue('session',request),{code:'buyer_auth_disabled'});
 assert.deepEqual(Object.keys(bridge),['publicKeys','issue']);
});
test('JWT has verified RS256 signature, app audience, opaque subject and max60second expiry',async()=>{
 const f=fixture(),r=await f.bridge.issue('session',request),d=decode(r.token);
 assert.equal(verify('RSA-SHA256',Buffer.from(d.input),current.publicKey,d.signature),true);
 assert.deepEqual(d.header,{alg:'RS256',typ:'JWT',kid:'sample-key-20261102'});
 assert.equal(d.claims.iss,origin+'/auth/buyer');assert.equal(d.claims.aud,'sample-privy-app');
 assert.equal(d.claims.exp-d.claims.iat,60);assert.equal(d.claims.nbf,d.claims.iat);
 assert.equal(d.claims.sub,'4e87f9b8-69c9-4a0c-8e49-cb66ac4b805e');
 assert.deepEqual(Object.keys(d.claims).sort(),['aud','exp','iat','iss','jti','nbf','sub']);
 assert.equal(JSON.stringify(d).includes('customer:sample'),false);assert.equal(r.cacheControl,'no-store');assert.equal(r.walletCreated,false);
});
test('rotation publishes only public verification material with distinct key IDs',async()=>{
 const f=fixture({retiringPublicKeys:[{kid:'sample-prior-key',key:old.publicKey}]});const jwks=f.bridge.publicKeys();
 assert.equal(jwks.keys.length,2);for(const key of jwks.keys){assert.deepEqual(Object.keys(key).sort(),['alg','e','kid','kty','n','use']);assert.equal(key.alg,'RS256');}
 const r=decode((await f.bridge.issue('session',request)).token);
 assert.equal(verify('RSA-SHA256',Buffer.from(r.input),createPublicKey({key:jwks.keys[0],format:'jwk'}),r.signature),true);
 jwks.keys[0].n='mutated';assert.notEqual(f.bridge.publicKeys().keys[0].n,'mutated');
});
test('rejects insecure configuration before resolving an account',async()=>{
 const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 for(const patch of [{origin:'http://example.test'},{issuer:'https://evil.test/auth'},{audience:''},{ttlSeconds:61},{ttlSeconds:0},{privateKey:ec.privateKey},{privateKey:current.publicKey},{keyId:'bad\nkey'},
 {retiringPublicKeys:[{kid:'sample-key-20261102',key:old.publicKey}]},{retiringPublicKeys:[{kid:'sample-old-key',key:old.privateKey}]}]){
  const f=fixture(patch);await assert.rejects(f.bridge.issue('session',request),{code:'buyer_auth_configuration'});assert.equal(f.calls,0);
 }
});
test('rejects cross-site, missingorigin, wrongmethod and arbitrary client claims',async()=>{
 for(const patch of [{method:'GET'},{origin:undefined},{origin:'https://evil.test'},{fetchSite:'cross-site'},{contentType:'text/plain'},{body:{intent:'buyer_wallet_setup',sub:'attacker'}},{body:{intent:'payment'}}]){
  const f=fixture();await assert.rejects(f.bridge.issue('session',{...request,...patch}),{code:'buyer_auth_request_rejected'});assert.equal(f.calls,0);
 }
});
test('rejects absent, expired and noncustomer sessions',async()=>{
 for(const s of [null,{owner:'operator',binding:'opaque-session-version-123',expiresAt:4600000},{owner:'customer:sample',binding:'opaque-session-version-123',expiresAt:1000000}])
  await assert.rejects(fixture({resolveSession:async()=>s}).bridge.issue('session',request),{code:'sign_in_required'});
});
test('only an owner-matched, consented development enrolment gets a token',async()=>{
 const base={owner:'customer:sample',subject:'4e87f9b8-69c9-4a0c-8e49-cb66ac4b805e',consent:true,environment:'development',expiresAt:4600000};
 for(const e of [null,{...base,owner:'customer:other'},{...base,consent:false},{...base,environment:'production'},{...base,subject:'email@example.test'},{...base,expiresAt:1000000}])
  await assert.rejects(fixture({resolveEnrollment:async()=>e}).bridge.issue('session',request),{code:'buyer_auth_not_enrolled'});
});
test('logout, revoked consent and kill switch during issuance discard it',async()=>{
 for(const [action,code] of [['logout','sign_in_required'],['revoke','buyer_auth_not_enrolled'],['disable','buyer_auth_disabled']]){
  const f=fixture();f.onCheck(n=>{if(n===2)f[action]();});await assert.rejects(f.bridge.issue('session',request),{code});
 }
});
test('changed session binding cannot receive an in-flight token',async()=>{
 let checks=0;const f=fixture({resolveSession:async()=>({owner:'customer:sample',binding:'opaque-session-version-'+(++checks),expiresAt:4600000})});
 await assert.rejects(f.bridge.issue('session',request),{code:'buyer_auth_context_changed'});
});
test('JWT lifetime is bounded by session and enrolment expiry',async()=>{
 const f=fixture({resolveSession:async()=>({owner:'customer:sample',binding:'opaque-session-version-123',expiresAt:1025000})});
 assert.equal(decode((await f.bridge.issue('session',request)).token).claims.exp,1025);
});
test('repeated tokens retain subject and rotate jti; logout blocks fresh issuance',async()=>{
 const f=fixture(),a=decode((await f.bridge.issue('session',request)).token),b=decode((await f.bridge.issue('session',request)).token);
 assert.equal(a.claims.sub,b.claims.sub);assert.notEqual(a.claims.jti,b.claims.jti);
 f.logout();await assert.rejects(f.bridge.issue('session',request),{code:'sign_in_required'});
 // Already issued tokens are NOT remotely revoked by this helper; provider-session revocation is a separate gate.
});
