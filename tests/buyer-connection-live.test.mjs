import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createBuyerConnectionHttp,configuredBuyerConnectionHttp,connectionPaths,connectionCsp} from '../server/quote-first/buyer-connection-http.mjs';
import {createConnectionSession,validLiveConnection,matchesPrivyIdentity,PRIVY_APP_ID} from '../src/privy-connection-client.mjs';
const now=Date.now(),cookie='a'.repeat(64),owner='customer:11111111-1111-4111-8111-111111111111',subject='22222222-2222-4222-8222-222222222222';
const session={owner,binding:'b'.repeat(64),expiresAt:now+600000},enrollment={owner,subject,consent:true,environment:'development',expiresAt:now+300000};
const base={origin:'https://example.test',enabled:()=>true,clock:()=>now,resolveSession:async()=>session,resolveEnrollment:async()=>enrollment,issue:async()=>({token:'issued',walletCreated:false}),rate:async()=>{},document:async()=>'<html>test</html>'};
const headers={host:'example.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin',cookie:'__Host-relay_sandbox='+cookie,origin:'https://example.test','content-type':'application/json','x-eupova-connection':'1'};
async function request(handler,{url=connectionPaths.status,method='GET',body='',headers:extra={}}={}){
 const req=Readable.from([body]);req.url=url;req.method=method;req.headers={...headers,...extra};
 const res={status:0,headers:{},writeHead(code,h){this.status=code;this.headers=h;},end(value){this.text=value;try{this.body=JSON.parse(value);}catch{}}};
 res.handled=await handler(req,res);return res;
}
test('real connection default off performs no key, database or enrolment reads',async()=>{
 const env=new Proxy({},{get(_,key){if(key.includes('ENABLED'))return undefined;assert.fail('unexpected configuration read');}});
 const h=configuredBuyerConnectionHttp({env,store:new Proxy({},{get(){assert.fail('DB');}})});
 for(const url of Object.values(connectionPaths))assert.equal((await request(h,{url})).status,404);
 assert.equal((await request(h,{url:'/'})).handled,false);
});
test('authorised status has session-bound context; test document alone has isolated CSP',async()=>{
 const h=createBuyerConnectionHttp(base),r=await request(h);assert.equal(r.status,200);assert.equal(validLiveConnection(r.body,now),true);assert.equal(r.body.subject,subject);assert.ok(!r.text.includes(owner));
 const page=await request(h,{url:connectionPaths.page,headers:{'sec-fetch-site':'none'}});assert.equal(page.status,200);assert.equal(page.headers['Content-Security-Policy'],connectionCsp);assert.ok(!connectionCsp.includes('walletconnect'));assert.equal(page.headers['Cache-Control'],'no-store');
});
test('cross-origin, malformed cookies, expiry and ordinary customers fail closed',async()=>{
 for(const extra of [{'sec-fetch-site':'cross-site'},{host:'other.test'},{authorization:'Bearer rejected'},{origin:'https://other.test'},{'x-forwarded-proto':'http'}])assert.equal((await request(createBuyerConnectionHttp(base),{headers:extra})).status,403);
 for(const c of ['',cookie,'__Host-relay_sandbox='+cookie+'; __Host-relay_sandbox='+cookie])assert.equal((await request(createBuyerConnectionHttp({...base,resolveSession:()=>assert.fail('malformed cookie')}),{headers:{cookie:c}})).status,404);
 for(const patch of [{resolveSession:async()=>null},{resolveSession:async()=>({...session,expiresAt:now})},{resolveEnrollment:async()=>null},{resolveEnrollment:async()=>({...enrollment,consent:false})}])assert.equal((await request(createBuyerConnectionHttp({...base,...patch}))).status,404);
});
test('token requires explicit consent, custom header and matching current session context',async()=>{
 let calls=0;const h=createBuyerConnectionHttp({...base,issue:async()=>{calls++;return {token:'issued',walletCreated:false};}}),status=(await request(h)).body;
 const good={intent:'privy_connection_test',consent:true,context:status.context};
 for(const body of [{...good,context:'wrong'},{...good,consent:false},{...good,extra:true},{}])assert.equal((await request(h,{url:connectionPaths.token,method:'POST',body:JSON.stringify(body)})).status,409);
 assert.equal((await request(h,{url:connectionPaths.token,method:'POST',body:JSON.stringify(good),headers:{'x-eupova-connection':''}})).status,403);assert.equal(calls,0);
 assert.equal((await request(h,{url:connectionPaths.token,method:'POST',body:JSON.stringify(good)})).status,200);assert.equal(calls,1);
 assert.equal((await request(h,{url:connectionPaths.token,method:'POST',body:'x'.repeat(513)})).status,413);
});
test('session rotation or kill switch after signing discards response token',async()=>{
 let current=session,enabled=true;
 for(const kind of ['rotation','disabled']){
  current=session;enabled=true;
  const h=createBuyerConnectionHttp({...base,enabled:()=>enabled,resolveSession:async()=>current,issue:async()=>{if(kind==='rotation')current={...session,binding:'rotated'};else enabled=false;return{token:'do-not-return'};}});
  const status=(await request(h)).body,r=await request(h,{url:connectionPaths.token,method:'POST',body:JSON.stringify({intent:'privy_connection_test',consent:true,context:status.context})});assert.equal(r.status,404);assert.ok(!r.text.includes('do-not-return'));
 }
});
const initial={visible:true,environment:'development',connection:'available',appId:PRIVY_APP_ID,context:'c'.repeat(64),subject,expiresAt:now+300000};
const user={id:'did:privy:sample',linkedAccounts:[{type:'custom_auth',customUserId:subject}]};
function controller(options={}){return createConnectionSession({initial,clock:()=>now,status:async()=>initial,token:async()=>({token:'test-token',expiresAt:now+60000}),logout:async()=>{},...options});}
test('identity checks reject mismatches, wallets and missing custom auth',()=>{
 assert.equal(matchesPrivyIdentity(user,subject),true);
 for(const v of [null,{...user,wallet:{}},{...user,linkedAccounts:[]},{...user,linkedAccounts:[...user.linkedAccounts,{type:'wallet'}]}])assert.equal(matchesPrivyIdentity(v,subject),false);
 assert.equal(matchesPrivyIdentity(user,'other'),false);
});
test('client makes no token request before consent/start and single-flights SDK refresh',async()=>{
 let count=0,resolve;const c=controller({token:()=>{count++;return new Promise(r=>resolve=r);}});
 assert.equal(await c.getExternalJwt(),undefined);assert.equal(count,0);await c.start();
 const a=c.getExternalJwt(),b=c.getExternalJwt();assert.equal(a,b);await new Promise(r=>setImmediate(r));assert.equal(count,1);resolve({token:'test-token',expiresAt:now+60000});assert.equal(await a,'test-token');c.providerState(true,user);assert.equal(c.phase,'connected');await c.end();assert.equal(c.phase,'disconnected');
});
test('cancel discards a late token and ends a late provider authentication',async()=>{
 let release,logouts=0;const c=controller({token:()=>new Promise(r=>release=r),logout:async()=>{logouts++;}});await c.start();const p=c.getExternalJwt();await new Promise(r=>setImmediate(r));await c.end();release({token:'late-token',expiresAt:now+60000});assert.equal(await p,undefined);c.providerState(true,user);await new Promise(r=>setImmediate(r));assert.ok(logouts>=2);assert.equal(c.active,false);
});
test('session switch, expired lease and refresh failure terminate without additional issuance',async()=>{
 let valid=initial,tokens=0,logouts=0;const c=controller({status:async()=>valid,token:async()=>{tokens++;return {token:'x',expiresAt:now+60000};},logout:async()=>{logouts++;}});await c.start();valid={...initial,context:'d'.repeat(64)};await c.refresh();assert.equal(c.active,false);assert.equal(await c.getExternalJwt(),undefined);assert.equal(tokens,0);assert.equal(logouts,1);
 for(const patch of [{expiresAt:now},{appId:'other'},{expiresAt:now+1800001}])assert.equal(validLiveConnection({...initial,...patch},now),false);
});
test('logout failure is visible and can retry; provider identity is never trusted before token issuance',async()=>{
 let failed=true;const c=controller({logout:async()=>{if(failed)throw Error('offline');}});await c.start();await c.end();assert.equal(c.phase,'cleanup_failed');assert.equal(c.active,false);failed=false;await c.end();assert.equal(c.phase,'disconnected');
 const d=controller();await d.start();d.providerState(true,user);await new Promise(r=>setImmediate(r));assert.equal(d.phase,'rejected');
});

test('unresponsive provider logout times out visibly without re-enabling tokens',async()=>{
 const c=controller({logout:()=>new Promise(()=>{}),logoutTimeoutMs:5});await c.start();await c.end();
 assert.equal(c.phase,'cleanup_failed');assert.equal(c.active,false);assert.equal(await c.getExternalJwt(),undefined);
});

// Repeated SDK callbacks must not generate fresh jti values and reauthenticate in a loop.
test('repeated provider callbacks reuse one JWT and stay below the unchanged issuance limit',async()=>{
 let calls=0,checks=0;const diagnostics=[];
 const c=controller({status:async()=>{checks++;return initial;},token:async()=>{if(++calls>6)throw Error('rate limited');return {token:'unique-'+calls,expiresAt:now+60000};},onDiagnostic:e=>diagnostics.push(e)});
 await c.start();for(let i=0;i<100;i++){assert.equal(await c.getExternalJwt(),'unique-1');c.providerState(true,{...user});}
 assert.equal(calls,1);assert.equal(checks,101);assert.equal(c.phase,'connected');
 assert.deepEqual(diagnostics.map(e=>e.code),['token_received','connected']);await c.end();
});
test('JWT refresh is single-flight at expiry margin and cannot extend the test lease',async()=>{
 let time=now,calls=0;const c=controller({clock:()=>time,token:async()=>({token:'unique-'+(++calls),expiresAt:time+60000})});
 await c.start();assert.equal(await c.getExternalJwt(),'unique-1');time+=54999;assert.equal(await c.getExternalJwt(),'unique-1');time++;
 const values=await Promise.all(Array.from({length:10},()=>c.getExternalJwt()));assert.ok(values.every(v=>v==='unique-2'));assert.equal(calls,2);
 time=initial.expiresAt-5000;assert.equal(await c.getExternalJwt(),undefined);await new Promise(r=>setImmediate(r));assert.equal(c.active,false);assert.equal(c.phase,'expired');assert.equal(calls,2);
});
test('cached tokens are withheld when permission or session context changes',async()=>{
 for(const invalid of [null,{...initial,context:'d'.repeat(64)},{...initial,subject:'33333333-3333-4333-8333-333333333333'}]){
  let current=initial,calls=0;const c=controller({status:async()=>current,token:async()=>{calls++;return{token:'cached',expiresAt:now+60000}}});
  await c.start();assert.equal(await c.getExternalJwt(),'cached');current=invalid;assert.equal(await c.getExternalJwt(),undefined);await new Promise(r=>setImmediate(r));assert.equal(c.active,false);assert.equal(calls,1);
 }
});
test('a shortened lease invalidates a token whose expiry is now too late',async()=>{
 let current=initial,calls=0;const c=controller({status:async()=>current,token:async()=>({token:'token-'+(++calls),expiresAt:Math.min(now+60000,current.expiresAt)})});
 await c.start();assert.equal(await c.getExternalJwt(),'token-1');current={...initial,expiresAt:now+30000};assert.equal(await c.getExternalJwt(),'token-2');assert.equal(calls,2);await c.end();
});
test('malformed, expired, overlong or over-lease token responses fail closed',async()=>{
 for(const value of ['old-string-shape',null,{}, {token:'',expiresAt:now+60000},{token:'x'.repeat(8193),expiresAt:now+60000},{token:'x',expiresAt:now},{token:'x',expiresAt:now+5000},{token:'x',expiresAt:now+61001}]){
  const events=[],c=controller({token:async()=>value,onDiagnostic:e=>events.push(e)});await c.start();assert.equal(await c.getExternalJwt(),undefined);await new Promise(r=>setImmediate(r));assert.equal(c.active,false);assert.ok(events.some(e=>e.code==='token_response_invalid'));
 }
 const short={...initial,expiresAt:now+30000},c=controller({initial:short,status:async()=>short});await c.start();assert.equal(await c.getExternalJwt(),undefined);await new Promise(r=>setImmediate(r));assert.equal(c.active,false);
});
test('provider session loss clears connected state and cannot silently reconnect',async()=>{
 let calls=0;const events=[],c=controller({token:async()=>{calls++;return{token:'sample',expiresAt:now+60000}},onDiagnostic:e=>events.push(e)});await c.start();c.providerState(false,null);assert.equal(c.active,true);
 await c.getExternalJwt();c.providerState(true,user);assert.equal(c.phase,'connected');c.providerState(false,null);await new Promise(r=>setImmediate(r));
 assert.equal(c.phase,'error');assert.equal(c.active,false);assert.equal(await c.getExternalJwt(),undefined);assert.equal(calls,1);assert.ok(events.some(e=>e.code==='provider_disconnected'));
});
test('diagnostics contain only allowlisted codes and relative times, never error payloads',async()=>{
 const secret='private-token-and-customer-data',events=[];
 const c=controller({token:async()=>{throw Object.assign(Error(secret),{code:secret,body:secret})},onDiagnostic:e=>events.push(e)});
 await c.start();await c.getExternalJwt();await new Promise(r=>setImmediate(r));await c.end('error',secret);
 assert.ok(events.some(e=>e.code==='token_request_failed'));assert.ok(!JSON.stringify(events).includes(secret));assert.ok(events.every(e=>Object.keys(e).sort().join(',')==='code,elapsedMs'));
});
test('late status failure after manual disconnect cannot replace the completed state',async()=>{
 let reject,hold=false;const c=controller({status:()=>hold?new Promise((_,r)=>reject=r):Promise.resolve(initial)});await c.start();await c.getExternalJwt();c.providerState(true,user);hold=true;const refreshing=c.refresh();await c.end();reject(Error('offline'));await refreshing;assert.equal(c.phase,'disconnected');assert.equal(c.active,false);
});
