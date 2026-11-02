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
function controller(options={}){return createConnectionSession({initial,clock:()=>now,status:async()=>initial,token:async()=>'test-token',logout:async()=>{},...options});}
test('identity checks reject mismatches, wallets and missing custom auth',()=>{
 assert.equal(matchesPrivyIdentity(user,subject),true);
 for(const v of [null,{...user,wallet:{}},{...user,linkedAccounts:[]},{...user,linkedAccounts:[...user.linkedAccounts,{type:'wallet'}]}])assert.equal(matchesPrivyIdentity(v,subject),false);
 assert.equal(matchesPrivyIdentity(user,'other'),false);
});
test('client makes no token request before consent/start and single-flights SDK refresh',async()=>{
 let count=0,resolve;const c=controller({token:()=>{count++;return new Promise(r=>resolve=r);}});
 assert.equal(await c.getExternalJwt(),undefined);assert.equal(count,0);await c.start();
 const a=c.getExternalJwt(),b=c.getExternalJwt();assert.equal(a,b);await new Promise(r=>setImmediate(r));assert.equal(count,1);resolve('test-token');assert.equal(await a,'test-token');c.providerState(true,user);assert.equal(c.phase,'connected');await c.end();assert.equal(c.phase,'disconnected');
});
test('cancel discards a late token and ends a late provider authentication',async()=>{
 let release,logouts=0;const c=controller({token:()=>new Promise(r=>release=r),logout:async()=>{logouts++;}});await c.start();const p=c.getExternalJwt();await new Promise(r=>setImmediate(r));await c.end();release('late-token');assert.equal(await p,undefined);c.providerState(true,user);await new Promise(r=>setImmediate(r));assert.ok(logouts>=2);assert.equal(c.active,false);
});
test('session switch, expired lease and refresh failure terminate without additional issuance',async()=>{
 let valid=initial,tokens=0,logouts=0;const c=controller({status:async()=>valid,token:async()=>{tokens++;return 'x';},logout:async()=>{logouts++;}});await c.start();valid={...initial,context:'d'.repeat(64)};await c.refresh();assert.equal(c.active,false);assert.equal(await c.getExternalJwt(),undefined);assert.equal(tokens,0);assert.equal(logouts,1);
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
