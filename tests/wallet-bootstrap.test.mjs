import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {createWalletBootstrapHttp,configuredWalletBootstrapHttp,bootstrapPaths as paths} from '../server/quote-first/wallet-bootstrap-http.mjs';
import {createWalletAuthSession,validWalletAuthStatus,validWalletAuthProof,matchesWalletAuthIdentity,walletAuthConfig} from '../src/wallet-bootstrap-client.mjs';
import {PRIVY_APP_ID,matchesPrivyIdentity} from '../src/privy-connection-client.mjs';
const now=1793629800000,owner='customer:11111111-1111-4111-8111-111111111111',subject='22222222-2222-4222-8222-222222222222',privyDid='did:privy:sample',address='0x1111111111111111111111111111111111111111',cookie='a'.repeat(64);
const session={owner,binding:'s'.repeat(64),expiresAt:now+600000},enrollment={owner,subject,privyDid,buyingAddress:null,consent:true,consentRecordedAt:now-1000,expiresAt:now+300000,environment:'development'};
const serverWallet={type:'wallet',address,chainType:'ethereum',walletClientType:'privy',connectorType:'embedded',userCanSign:true,imported:false,delegated:false};
const serverUser={id:privyDid,linkedAccounts:[{type:'custom_auth',subject}]};
const clientUser={id:privyDid,linkedAccounts:[{type:'custom_auth',customUserId:subject}]};
const base={origin:'https://example.test',enabled:()=>true,resolveSession:async()=>session,resolveEnrollment:async()=>enrollment,issue:async()=>({token:'sample-jwt',expiresAt:now+60000,walletCreated:false}),verifyAccessToken:async()=>({did:privyDid,expiresAt:now+60000}),readPrivyUser:async()=>serverUser,document:async()=>'<html>sample</html>',clock:()=>now};
const headers={host:'example.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin',cookie:'__Host-relay_sandbox='+cookie,origin:'https://example.test','content-type':'application/json','x-eupova-wallet-auth':'1'};
async function request(h,{url=paths.status,method='GET',body='',headers:extra={}}={}){const req=Readable.from([body]);req.url=url;req.method=method;req.headers={...headers,...extra};const res={writeHead(status,h){this.status=status;this.headers=h;},end(text){this.text=text;try{this.body=JSON.parse(text);}catch{}}};res.handled=await h(req,res);return res;}
async function post(h,path,context,extra={}){return request(h,{url:path,method:'POST',body:JSON.stringify({intent:'wallet_auth',consent:true,context}),...extra});}
const initial={visible:true,environment:'development',purpose:'wallet_auth',appId:PRIVY_APP_ID,context:'c'.repeat(64),subject,privyDid,expectedAddress:null,expiresAt:now+300000};
const proof={status:'no_wallet',address:null,context:initial.context,observedAt:now,validUntil:now+15000,canQuote:false,canCreateWallet:false,canCreatePayment:false};
function controller(options={}){return createWalletAuthSession({initial,status:async()=>initial,token:async()=>({token:'sample-token',expiresAt:now+60000,walletCreated:false}),verify:async()=>proof,getAccessToken:async()=> 'sample.access.token',logout:async()=>{},getProviderState:()=>({ready:true,authenticated:false,user:null}),observationMs:1,settleMs:2,clock:()=>now,...options});}
const tick=()=>new Promise(r=>setImmediate(r));
async function connected(c,user=clientUser){await c.start(true);await c.getExternalJwt();c.providerAuthenticated();await c.providerState(true,user);}
test('default disabled: all routes 404, no keys, database or provider accesses',async()=>{const env=new Proxy({},{get(_,k){if(k.endsWith('ENABLED'))return undefined;assert.fail('configuration read');}}),h=configuredWalletBootstrapHttp({env,store:new Proxy({},{get(){assert.fail('db')}})});for(const url of Object.values(paths))assert.equal((await request(h,{url})).status,404);assert.equal((await request(h,{url:'/'})).handled,false);});
test('missing any activation flag stays off; incomplete configuration cannot issue',async()=>{const names=['EUPOVA_WALLET_AUTH_DEV_ENABLED','EUPOVA_BUYER_AUTH_DEV_ENABLED','EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED'];for(const n of names){const env=Object.fromEntries(names.map(k=>[k,k===n?'false':'true']));assert.equal((await request(configuredWalletBootstrapHttp({env}))).status,404);}assert.equal((await request(configuredWalletBootstrapHttp({env:Object.fromEntries(names.map(k=>[k,'true']))}))).status,503);});
test('status and purpose-specific context; page has isolated CSP and no-store',async()=>{const h=createWalletBootstrapHttp(base),r=await request(h);assert.equal(r.status,200);assert.equal(validWalletAuthStatus(r.body,now),true);assert.ok(!r.text.includes(owner));const page=await request(h,{url:paths.page,headers:{'sec-fetch-site':'none'}});assert.equal(page.status,200);assert.match(page.headers['Content-Security-Policy'],/frame-ancestors 'none'/);assert.equal(page.headers['Cache-Control'],'no-store');});
test('reject cross-origin, malformed cookie, wrong verb and query strings',async()=>{for(const h of [{origin:'https://evil.test'},{host:'evil.test'},{'x-forwarded-proto':'http'},{'sec-fetch-site':'cross-site'},{authorization:'Bearer sample'}])assert.equal((await request(createWalletBootstrapHttp(base),{headers:h})).status,403);for(const c of ['',cookie,'__Host-relay_sandbox='+cookie+'; __Host-relay_sandbox='+cookie])assert.equal((await request(createWalletBootstrapHttp(base),{headers:{cookie:c}})).status,404);assert.equal((await request(createWalletBootstrapHttp(base),{method:'POST'})).status,405);assert.equal((await request(createWalletBootstrapHttp(base),{url:paths.status+'?x=1'})).status,403);});
test('consent, purpose and current context required; secret never returned on rotation',async()=>{let current=session,calls=0;const h=createWalletBootstrapHttp({...base,resolveSession:async()=>current,issue:async()=>{calls++;current={...session,binding:'r'.repeat(64)};return {token:'private-jwt',expiresAt:now+60000,walletCreated:false}}}),ctx=(await request(h)).body.context;for(const data of [{intent:'wallet_auth',consent:false,context:ctx},{intent:'privy_connection_test',consent:true,context:ctx},{intent:'wallet_auth',consent:true,context:'old'}])assert.equal((await request(h,{url:paths.token,method:'POST',body:JSON.stringify(data)})).status,409);assert.equal(calls,0);const r=await post(h,paths.token,ctx);assert.equal(r.status,503);assert.ok(!r.text.includes('private-jwt'));});
test('no-wallet and expected-wallet inventories produce recognition only',async()=>{for(const expectedAddress of [null,address]){const h=createWalletBootstrapHttp({...base,resolveEnrollment:async()=>({...enrollment,buyingAddress:expectedAddress}),readPrivyUser:async()=>({...serverUser,linkedAccounts:[...serverUser.linkedAccounts,...expectedAddress?[serverWallet]:[]]})}),s=(await request(h)).body,r=await post(h,paths.verify,s.context,{headers:{authorization:'Bearer sample.token.value'}});assert.equal(r.status,200);assert.equal(validWalletAuthProof(r.body,s,now),true);assert.equal(r.body.canQuote,false);assert.equal(r.body.canCreateWallet,false);assert.ok(!r.text.includes(privyDid));}});
test('wallet absence, mismatch, duplicate, delegation and unknown account types are rejected',async()=>{const users=[serverUser,{...serverUser,id:'did:privy:other'},...[
 [{...serverWallet,address:'0x2222222222222222222222222222222222222222'}],[serverWallet,serverWallet],[{...serverWallet,delegated:true}],[{...serverWallet,imported:true}],[{...serverWallet,userCanSign:false}],[{...serverWallet,userCanSign:undefined}],[{...serverWallet,chainType:'solana'}],[serverWallet,{type:'cross_app'}],[serverWallet,{type:'smart_wallet'}]
 ].map(wallets=>({...serverUser,linkedAccounts:[...serverUser.linkedAccounts,...wallets]}))];for(const user of users){const h=createWalletBootstrapHttp({...base,resolveEnrollment:async()=>({...enrollment,buyingAddress:address}),readPrivyUser:async()=>user}),ctx=(await request(h)).body.context;assert.equal((await post(h,paths.verify,ctx,{headers:{authorization:'Bearer sample'}})).status,409);}});
test('empty expectation cannot recognise an unexpected wallet',async()=>{const h=createWalletBootstrapHttp({...base,readPrivyUser:async()=>({...serverUser,linkedAccounts:[...serverUser.linkedAccounts,serverWallet]})}),ctx=(await request(h)).body.context;assert.equal((await post(h,paths.verify,ctx,{headers:{authorization:'Bearer sample'}})).status,409);});
test('upstream failure, changed session/enrolment/flag, stale read and expired token discard success',async()=>{for(const kind of ['failure','session','enrollment','flag','stale','expired','did']){let current=session,e=enrollment,time=now,enabled=true;const h=createWalletBootstrapHttp({...base,clock:()=>time,enabled:()=>enabled,resolveSession:async()=>current,resolveEnrollment:async()=>e,verifyAccessToken:async()=>({did:kind==='did'?'did:privy:other':privyDid,expiresAt:kind==='expired'?now:now+60000}),readPrivyUser:async()=>{if(kind==='failure')throw Error('private-provider-error');if(kind==='session')current={...current,binding:'r'.repeat(64)};if(kind==='enrollment')e={...e,privyDid:'did:privy:other'};if(kind==='flag')enabled=false;return serverUser;}});const ctx=(await request(h)).body.context;if(kind==='stale')time+=300001;const r=await post(h,paths.verify,ctx,{headers:{authorization:'Bearer sample'}});assert.notEqual(r.status,200);assert.ok(!r.text.includes('private-provider-error'));}});
test('body bounds, exact fields, custom header and bearer enforced',async()=>{const h=createWalletBootstrapHttp(base),ctx=(await request(h)).body.context;assert.equal((await post(h,paths.token,ctx,{headers:{'x-eupova-wallet-auth':''}})).status,403);for(const body of ['x'.repeat(513),'{}','[]','null','invalid'])assert.ok([400,409].includes((await request(h,{url:paths.token,method:'POST',body})).status));assert.equal((await post(h,paths.verify,ctx)).status,401);});
test('six token calls per minute then rate limited',async()=>{const h=createWalletBootstrapHttp(base),ctx=(await request(h)).body.context;for(let i=0;i<6;i++)assert.equal((await post(h,paths.token,ctx)).status,200);assert.equal((await post(h,paths.token,ctx)).status,429);});
test('auth-only identity matcher still rejects every wallet; new one checks exact wallet',()=>{const i={...initial,expectedAddress:address},u={...clientUser,linkedAccounts:[...clientUser.linkedAccounts,serverWallet]};assert.equal(matchesPrivyIdentity(u,subject),false);assert.equal(matchesWalletAuthIdentity(u,i),true);assert.equal(matchesWalletAuthIdentity(u,initial),false);assert.equal(matchesWalletAuthIdentity({...u,wallet:{address:'other'}},i),false);assert.equal(matchesWalletAuthIdentity({...u,id:'did:privy:other'},i),false);assert.equal(walletAuthConfig.embeddedWallets.ethereum.createOnLogin,'off');assert.equal(walletAuthConfig.embeddedWallets.solana.createOnLogin,'off');});
test('no JWT before consent; singleflight and cache avoid repeated authentication',async()=>{let calls=0;const c=controller({token:async()=>{calls++;return {token:'sample-token',expiresAt:now+60000,walletCreated:false}}});await c.start(false);assert.equal(await c.getExternalJwt(),undefined);await c.start(true);const results=await Promise.all(Array.from({length:20},()=>c.getExternalJwt()));assert.ok(results.every(x=>x==='sample-token'));assert.equal(calls,1);assert.equal(c.phase,'connecting');c.providerAuthenticated();await c.providerState(true,clientUser);assert.equal(c.phase,'no_wallet');await c.end();});
test('server confirmation is mandatory even if SDK reports expected wallet',async()=>{let release;const i={...initial,expectedAddress:address},u={...clientUser,linkedAccounts:[...clientUser.linkedAccounts,serverWallet]},c=controller({initial:i,status:async()=>i,verify:()=>new Promise(r=>release=r)});await c.start(true);await c.getExternalJwt();c.providerAuthenticated();const p=c.providerState(true,u);await tick();assert.equal(c.phase,'verifying');assert.equal(c.proof,null);release({...proof,status:'wallet_recognised',address});await p;assert.equal(c.phase,'wallet_recognised');await c.end();});
test('cancel during late JWT or observation cannot revive a session',async()=>{for(const stage of ['token','verify']){let release;const c=controller({[stage]:()=>new Promise(r=>release=r)});await c.start(true);let p;if(stage==='token')p=c.getExternalJwt();else{await c.getExternalJwt();c.providerAuthenticated();p=c.providerState(true,clientUser);}await tick();await c.end();release(stage==='token'?{token:'late',expiresAt:now+60000,walletCreated:false}:proof);await p;assert.equal(c.phase,'disconnected');assert.equal(c.proof,null);assert.equal(c.active,false);await c.providerState(true,clientUser);await tick();assert.equal(c.active,false);}});
test('changed server status or SDK wallet invalidates a previous recognition',async()=>{for(const mode of ['status','wallet','disconnect']){let current=initial;const c=controller({status:async()=>current});await connected(c);assert.equal(c.phase,'no_wallet');if(mode==='status'){current={...initial,context:'e'.repeat(64)};await c.refresh();}else if(mode==='wallet'){await c.providerState(true,{...clientUser,linkedAccounts:[...clientUser.linkedAccounts,serverWallet]});await tick();}else{await c.providerState(false,null);await tick();}assert.equal(c.active,false);assert.equal(c.proof,null);assert.equal(await c.getExternalJwt(),undefined);}});
test('proof expiry, wrong context/address or capabilities never produce a recognised state',async()=>{for(const patch of [{validUntil:now},{observedAt:now+1},{validUntil:now+15001},{context:'e'.repeat(64)},{address},{canQuote:true},{canCreateWallet:true},{canCreatePayment:true}]){const c=controller({verify:async()=>({...proof,...patch})});await connected(c);assert.equal(c.phase,'blocked');assert.equal(c.proof,null);}});
test('timeouts end safely and cleanup failure can be retried',async()=>{let fail=true;const c=controller({logout:async()=>{if(fail)throw Error('secret')},timeoutMs:10});await c.start(true);assert.equal(c.phase,'cleanup_failed');fail=false;await c.end();assert.equal(c.phase,'disconnected');const d=controller({verify:()=>new Promise(()=>{}),timeoutMs:5});await connected(d);assert.equal(d.phase,'blocked');assert.equal(d.proof,null);});
test('source boundary: no creation/signing imports',async()=>{for(const f of ['src/wallet-bootstrap-client.mjs','src/PrivyWalletAuthSdk.jsx','server/quote-first/wallet-bootstrap-http.mjs']){const s=await readFile(new URL('../'+f,import.meta.url),'utf8');assert.doesNotMatch(s,/useCreateWallet|useSignMessage|useSendTransaction|useExportWallet|wallet-setup-claims|real-wallet-setup-adapter/);}});
test('permission polling does not automatically refresh expired evidence',async()=>{let time=now,calls=0;const c=controller({clock:()=>time,verify:async()=>{calls++;return {...proof,observedAt:time,validUntil:time+15000}}});await connected(c);time+=16000;await c.refresh();assert.equal(c.phase,'verification_expired');assert.equal(c.proof,null);assert.equal(calls,1);await c.providerState(true,{...clientUser});assert.equal(calls,1);assert.equal(c.phase,'verification_expired');await c.recheck();assert.equal(c.phase,'no_wallet');assert.equal(calls,2);await c.end();});
test('wallet proof expiration during a late local-session recheck cannot escape',async()=>{let time=now,reads=0;const h=createWalletBootstrapHttp({...base,clock:()=>time,resolveSession:async()=>{if(++reads===4)time+=16000;return session;}});const ctx=(await request(h)).body.context;reads=1;const r=await post(h,paths.verify,ctx,{headers:{authorization:'Bearer sample'}});assert.equal(r.status,503);});
test('configured pipeline uses only SELECT and fixed GET with sample keys; flags stay unchanged',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');const {generateKeyPair,exportJWK,SignJWT}=await import('jose');
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048}),kid='sample-key-id',trustedKeys={keys:[{...rsa.publicKey.export({format:'jwk'}),kid,alg:'RS256',use:'sig'}]};
 const ec=await generateKeyPair('ES256',{extractable:true}),jwk={...await exportJWK(ec.publicKey),kid:'sample',alg:'ES256',use:'sig'};
 const {environment,...record}=enrollment;
 const env={EUPOVA_WALLET_AUTH_DEV_ENABLED:'true',EUPOVA_BUYER_AUTH_DEV_ENABLED:'true',EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED:'true',EUPOVA_BUYER_AUTH_APP_ID:PRIVY_APP_ID,EUPOVA_BUYER_AUTH_ENVIRONMENT:'development',EUPOVA_PRIVY_QUOTE_CREDENTIAL_ACCESS:'read-only',EUPOVA_WALLET_AUTH_TEST_ENROLLMENT:JSON.stringify(record),EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM:rsa.privateKey.export({format:'pem',type:'pkcs8'}),EUPOVA_BUYER_AUTH_KEY_ID:kid,EUPOVA_PRIVY_ACCESS_PUBLIC_JWKS:JSON.stringify({keys:[jwk]}),EUPOVA_PRIVY_QUOTE_READONLY_SECRET:'sample-read-only-secret'};
 const before=JSON.stringify(env),sql=[],calls=[];
 const store={query:async(text)=>{sql.push(text);assert.match(text,/^SELECT /);return {rows:[{id:owner.slice(9),session_id:'sample-session',version:1,valid_until:new Date(now+600000)}]};}};
 const h=configuredWalletBootstrapHttp({origin:base.origin,store,env,clock:()=>now,trustedKeys,privyFetch:async(url,options)=>{calls.push({url,method:options.method});assert.equal(options.method,'GET');return Response.json({id:privyDid,is_guest:false,linked_accounts:[{type:'custom_auth',custom_user_id:subject}]});}});
 const status=await request(h);assert.equal(status.status,200);const issued=await post(h,paths.token,status.body.context);assert.equal(issued.status,200);assert.equal(issued.body.walletCreated,false);
 const access=await new SignJWT({iss:'privy.io',aud:PRIVY_APP_ID,sub:privyDid,sid:'sample-session',iat:now/1000,exp:now/1000+3600}).setProtectedHeader({alg:'ES256',kid:'sample'}).sign(ec.privateKey);
 const verified=await post(h,paths.verify,status.body.context,{headers:{authorization:'Bearer '+access}});assert.equal(verified.status,200);assert.equal(verified.body.status,'no_wallet');assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.privy.io/v1/users/did%3Aprivy%3Asample');assert.ok(sql.length>0);assert.equal(JSON.stringify(env),before);
 env.EUPOVA_WALLET_AUTH_DEV_ENABLED='false';const priorReads=sql.length;assert.equal((await request(h)).status,404);assert.equal(sql.length,priorReads);
});

test('detailed server failures identify stages only after current development authorisation',async()=>{
 for(const [method,stage] of [['verifyAccessToken','server_access_token'],['readPrivyUser','server_inventory']]){
  const h=createWalletBootstrapHttp({...base,[method]:async()=>{throw Error('secret-jwt-did-provider-payload');}}),ctx=(await request(h)).body.context;
  const response=await post(h,paths.verify,ctx,{headers:{authorization:'Bearer sample'}});
  assert.equal(response.status,503);assert.deepEqual(response.body.diagnostic,{stage,code:'failed'});assert.doesNotMatch(response.text,/secret-jwt|provider-payload/);
 }
 for(const changed of ['session','enrolment','flag']){
  let current=session,allowed=true,record=enrollment;
  const h=createWalletBootstrapHttp({...base,enabled:()=>allowed,resolveSession:async()=>current,resolveEnrollment:async()=>record,readPrivyUser:async()=>{
   if(changed==='session')current=null;if(changed==='enrolment')record=null;if(changed==='flag')allowed=false;throw Error('private');
  }}),ctx=(await request(h)).body.context,response=await post(h,paths.verify,ctx,{headers:{authorization:'Bearer sample'}});
  assert.equal(response.status,503);assert.equal(response.body.diagnostic,undefined);assert.doesNotMatch(response.text,/private/);
 }
});
test('client diagnostics are bounded fixed values without raw exceptions or identities',async()=>{
 const c=controller({verify:async()=>{throw Error('email@example.com secret-token 0x123 did:privy:private');}});await connected(c);
 assert.equal(c.diagnostics.failure.stage,'server_inventory');assert.equal(c.diagnostics.cleanup,'browser_signed_out');assert.equal(c.diagnostics.remoteSession,'unconfirmed');
 assert.doesNotMatch(JSON.stringify(c.diagnostics),/email@|secret-token|0x123|did:privy|sample-token|22222222/);assert.ok(c.diagnostics.steps.length<=24);
});
test('logout promise resolution alone cannot confirm browser disconnect',async()=>{
 let observed={ready:true,authenticated:false,user:null};
 const c=controller({getProviderState:()=>observed,timeoutMs:20});await c.start(true);observed={ready:true,authenticated:true,user:clientUser};await c.end();
 assert.equal(c.phase,'cleanup_failed');assert.equal(c.diagnostics.cleanup,'unconfirmed');assert.equal(c.active,false);assert.equal(c.proof,null);
 observed={ready:true,authenticated:false,user:null};await c.end();assert.equal(c.phase,'disconnected');assert.equal(c.diagnostics.cleanup,'browser_signed_out');assert.equal(c.diagnostics.remoteSession,'unconfirmed');
});
test('ready false or a leftover user never counts as browser sign-out',async()=>{
 for(const observed of [{ready:false,authenticated:false,user:null},{ready:true,authenticated:false,user:clientUser}]){
  const c=controller({getProviderState:()=>observed,timeoutMs:10});await c.start(true);assert.equal(c.phase,'cleanup_failed');assert.equal(c.active,false);
 }
});
test('callback-before-state is not verification; missing callback cannot verify',async()=>{
 let calls=0;const c=controller({verify:async()=>{calls++;return proof;}});await c.start(true);await c.getExternalJwt();c.providerAuthenticated();await c.providerState(false,null);
 assert.equal(c.phase,'connecting');assert.equal(calls,0);await c.providerState(true,clientUser);assert.equal(c.phase,'no_wallet');await c.end();
 const d=controller({verify:async()=>{assert.fail('unrelated SDK state must not verify');}});await d.start(true);await d.getExternalJwt();await d.providerState(true,clientUser);await new Promise(r=>setTimeout(r,10));assert.equal(d.active,false);assert.equal(d.proof,null);d.providerError();await d.end();
});
test('late uncancellable authentication after stop is cleaned without a recognised state',async()=>{
 let observed={ready:true,authenticated:false,user:null},logoutCalls=0;const views=[];
 const c=controller({getProviderState:()=>observed,logout:async()=>{logoutCalls++;observed={ready:true,authenticated:false,user:null};},onChange:v=>views.push(v.phase),timeoutMs:50});
 await c.start(true);await c.getExternalJwt();const stop=c.end();
 setTimeout(()=>{c.providerAuthenticated();observed={ready:true,authenticated:true,user:clientUser};void c.providerState(true,clientUser);},8);
 await stop;assert.equal(c.phase,'disconnected');assert.equal(c.active,false);assert.equal(c.proof,null);assert.equal(logoutCalls,3);assert.ok(!views.includes('no_wallet'));assert.equal(c.diagnostics.remoteSession,'unconfirmed');
});
test('pending SDK authentication and repeated stale users keep cleanup bounded',async()=>{
 let observed={ready:true,authenticated:false,user:null};const c=controller({getProviderState:()=>observed,timeoutMs:10});await c.start(true);await c.getExternalJwt();await c.end();assert.equal(c.phase,'cleanup_failed');assert.equal(c.diagnostics.cleanup,'authentication_pending');
 c.providerError();await c.end();assert.equal(c.phase,'disconnected');
 observed={ready:true,authenticated:true,user:clientUser};for(let i=0;i<5;i++){await c.providerState(true,clientUser);await new Promise(r=>setTimeout(r,15));}
 assert.equal(c.phase,'cleanup_failed');assert.equal(c.active,false);assert.equal(await c.getExternalJwt(),undefined);
});

 test('idle-session renewal beyond the approved lease preserves context; effective shortening and rotation invalidate it',async()=>{
  let current={...session};
  const h=createWalletBootstrapHttp({...base,resolveSession:async()=>({...current})});
  const first=(await request(h)).body;
  current.expiresAt+=60000;
  assert.deepEqual((await request(h)).body,first);
  assert.equal((await post(h,paths.verify,first.context,{headers:{authorization:'Bearer sample'}})).status,200);
  current.expiresAt=now+120000;
  assert.notEqual((await request(h)).body.context,first.context);
  assert.equal((await post(h,paths.token,first.context)).status,409);
  current={...session,binding:'r'.repeat(64)};
  assert.equal((await post(h,paths.token,first.context)).status,409);
  current=null;
  assert.equal((await request(h)).status,404);
 });
