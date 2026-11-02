import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {randomUUID,generateKeyPairSync,createPublicKey,verify} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createStore,digest} from '../hosted/db.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {createBuyerSessionReader,developmentEnrollment} from '../server/quote-first/buyer-auth-session.mjs';
import {configuredBuyerAuthHttp,developmentAppId,buyerAuthPaths} from '../server/quote-first/buyer-auth-http.mjs';

// In-memory sample identities and keys only. No live DB, sockets, Privy or Peer calls.
const key=generateKeyPairSync('rsa',{modulusLength:2048});
const pem=key.privateKey.export({type:'pkcs8',format:'pem'});
const origin='https://example.test',token='a'.repeat(64),cookie='__Host-relay_sandbox='+token;
const baseHeaders={host:'example.test','x-forwarded-proto':'https',origin,
 'sec-fetch-site':'same-origin','content-type':'application/json',cookie};
const now=Date.now();
const record=owner=>({owner,subject:randomUUID(),consent:true,consentRecordedAt:now-1000,expiresAt:now+3600000});
const environment=enrollment=>({EUPOVA_BUYER_AUTH_DEV_ENABLED:'true',EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED:'true',EUPOVA_BUYER_AUTH_ENVIRONMENT:'development',
 EUPOVA_BUYER_AUTH_APP_ID:developmentAppId,EUPOVA_BUYER_AUTH_KEY_ID:'sample-test-key-20261102',
 EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM:pem,EUPOVA_BUYER_AUTH_TEST_ENROLLMENT:JSON.stringify(enrollment)});
async function fixture(){
 const db=new PGlite();await db.exec(readFileSync(new URL('../hosted/schema.sql',import.meta.url),'utf8'));
 const id=randomUUID(),owner='customer:'+id;
 await db.query(`INSERT INTO relay_customers(id,email,name,password_hash,recovery_hash,email_verified_at)
 VALUES($1,'sample@example.test','Sample','unused','unused',now())`,[id]);
 await db.query('INSERT INTO relay_customer_sessions(token_hash,customer_id,version) VALUES($1,$2,1)',[digest(token),id]);
 const queries=[];const store=createStore({query:async(sql,args)=>{queries.push(sql);return db.query(sql,args);}});
 const enrollment=record(owner),env=environment(enrollment),handler=configuredBuyerAuthHttp({origin,store,env});
 const snapshot=async()=>JSON.stringify([(await db.query('SELECT * FROM relay_customers')).rows,(await db.query('SELECT * FROM relay_customer_sessions')).rows]);
 return {db,store,id,owner,enrollment,env,handler,queries,snapshot,close:()=>db.close()};
}
async function request(handler,{path=buyerAuthPaths.token,method='POST',headers={},body={intent:'buyer_wallet_setup'},raw}={}){
 const req=Readable.from([Buffer.from(raw??JSON.stringify(body))]);Object.assign(req,{url:path,method,headers:{...baseHeaders,...headers}});
 const res={headers:{},statusCode:200,setHeader(k,v){this.headers[k.toLowerCase()]=v;},
  writeHead(status,h){this.statusCode=status;for(const [k,v]of Object.entries(h))this.setHeader(k,v);},
  end(value){this.body=value?JSON.parse(value):null;this.ended=true;}};
 const handled=await handler(req,res);return {...res,handled};
}
test('disabled adapter returns 404 without reading configuration, keys, DB or request body',async()=>{
 const env={get EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM(){assert.fail('key read');}};
 const handler=configuredBuyerAuthHttp({origin,env,store:new Proxy({},{get(){assert.fail('DB access');}})});
 for(const path of Object.values(buyerAuthPaths)){const r=await request(handler,{path});assert.equal(r.statusCode,404);assert.equal(r.headers['cache-control'],'no-store');}
 assert.equal((await request(handler,{path:'/api/state'})).handled,false);
});
test('development enrolment is explicit, bounded and keeps its subject stable',async()=>{
 const owner='customer:'+randomUUID(),r=record(owner),resolve=developmentEnrollment(r);
 r.subject=randomUUID();const a=await resolve(owner),b=await resolve(owner);assert.deepEqual(a,b);assert.equal(await resolve('customer:'+randomUUID()),null);
 for(const patch of [{consent:false},{owner:'operator'},{subject:owner.slice(9)},{consentRecordedAt:Date.now()+10000},
 {expiresAt:now+86400001},{subject:'email@example.test'},{extra:'claim'}])assert.throws(()=>developmentEnrollment({...record(owner),...patch}),{code:'buyer_auth_configuration'});
 const expired=developmentEnrollment({...record(owner),consentRecordedAt:now-10000,expiresAt:now-1});assert.equal(await expired(owner),null);
});
test('public key publication can be tested while token issuance remains disabled',async()=>{
 const f=await fixture();try{
  delete f.env.EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED;
  assert.equal((await request(f.handler)).statusCode,404);
  assert.equal((await request(f.handler,{path:buyerAuthPaths.jwks,method:'GET'})).statusCode,200);
  assert.equal(f.queries.length,0);
 }finally{await f.close();}
});
test('session reader uses SELECT only and preserves customer/session rows exactly',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot(),read=createBuyerSessionReader(f.store),a=await read(token),b=await read(token);
  assert.equal(a.owner,f.owner);assert.equal(a.binding,b.binding);assert.equal(a.expiresAt,b.expiresAt);
  assert.match(a.binding,/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(a),['owner','binding','expiresAt']);
  assert.ok(f.queries.every(q=>q.trimStart().startsWith('SELECT')));assert.equal(await f.snapshot(),before);
  const count=f.queries.length;assert.equal(await read('bad'),null);assert.equal(f.queries.length,count);
 }finally{await f.close();}
});
test('read-only session rejects revoked, version-mismatched, disabled, expired, idle and unverified accounts',async()=>{
 const f=await fixture();try{
  const read=createBuyerSessionReader(f.store);
  for(const sql of ["UPDATE relay_customer_sessions SET revoked=true","UPDATE relay_customer_sessions SET version=2",
   "UPDATE relay_customers SET disabled=true","UPDATE relay_customers SET version=2",
   "UPDATE relay_customer_sessions SET expires_at=now()-interval '1 second'",
   "UPDATE relay_customer_sessions SET last_seen_at=now()-interval '2 hours'",
   "UPDATE relay_customers SET email_verified_at=NULL"]){
   await f.db.exec('BEGIN');await f.db.exec(sql);assert.equal(await read(token),null);await f.db.exec('ROLLBACK');
  }
  await f.db.exec("UPDATE relay_customer_sessions SET last_seen_at=now()-interval '119 minutes'");
  assert.ok((await read(token)).expiresAt<=Date.now()+61000);
 }finally{await f.close();}
});
test('HTTP issuance verifies against public JWKS and changes only rate counters',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot(),r=await request(f.handler);assert.equal(r.statusCode,200);assert.equal(r.body.walletCreated,false);
  assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['set-cookie'],undefined);
  const jwks=await request(f.handler,{path:buyerAuthPaths.jwks,method:'GET',headers:{cookie:undefined,origin:undefined}});
  assert.equal(jwks.statusCode,200);const publicKey=jwks.body.keys[0];assert.equal(publicKey.d,undefined);
  const [h,p,s]=r.body.token.split('.'),claims=JSON.parse(Buffer.from(p,'base64url'));
  assert.equal(verify('RSA-SHA256',Buffer.from(h+'.'+p),createPublicKey({key:publicKey,format:'jwk'}),Buffer.from(s,'base64url')),true);
  assert.equal(claims.aud,developmentAppId);assert.equal(claims.sub,f.enrollment.subject);assert.equal(claims.iss,origin+'/auth/buyer');
  assert.equal(claims.exp-claims.iat,60);assert.equal(JSON.stringify(claims).includes(f.id),false);
  assert.equal(await f.snapshot(),before);assert.ok(f.queries.filter(q=>!q.trimStart().startsWith('SELECT')).every(q=>q.startsWith('INSERT INTO relay_rate_limits')));
 }finally{await f.close();}
});
test('cross-site, host/proto spoofing, non-JSON and bearer requests fail before database access',async()=>{
 const f=await fixture();try{
  for(const patch of [{origin:'https://evil.test'},{origin:undefined},{host:'evil.test'},{'x-forwarded-proto':'http'},
   {'sec-fetch-site':'cross-site'},{'sec-fetch-site':undefined},{'content-type':'text/plain'},{authorization:'Bearer fake'}, {'content-encoding':'gzip'}]){
   const r=await request(f.handler,{headers:patch});assert.equal(r.statusCode,403);
  }
  assert.equal((await request(f.handler,{method:'GET'})).statusCode,405);
  assert.equal((await request(f.handler,{path:buyerAuthPaths.token+'?owner=other'})).statusCode,403);
  assert.equal(f.queries.length,0);
 }finally{await f.close();}
});
test('ambiguous cookies and foreign/unverified sessions never receive tokens',async()=>{
 const f=await fixture();try{
  for(const value of [undefined,cookie+'; '+cookie,'relay_local_preview='+token,'__Host-relay_sandbox='+'b'.repeat(64)])
   assert.equal((await request(f.handler,{headers:{cookie:value}})).statusCode,401);
  const unlisted=configuredBuyerAuthHttp({origin,store:f.store,env:environment(record('customer:'+randomUUID()))});
  assert.equal((await request(unlisted)).statusCode,403);
 }finally{await f.close();}
});
test('bounded body rejects arbitrary claims and malformed JSON',async()=>{
 const f=await fixture();try{
  for(const raw of ['null','[]','{',JSON.stringify({intent:'buyer_wallet_setup',sub:'other'})])
   assert.equal((await request(f.handler,{raw})).statusCode,400);
  assert.equal((await request(f.handler,{raw:' '.repeat(513)})).statusCode,413);
 }finally{await f.close();}
});
test('shared database counter bounds concurrent requests across two adapter instances',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot(),other=configuredBuyerAuthHttp({origin,store:f.store,env:f.env});
  const results=await Promise.all(Array.from({length:10},(_,i)=>request(i%2?other:f.handler)));
  assert.equal(results.filter(r=>r.statusCode===200).length,6);assert.equal(results.filter(r=>r.statusCode===429).length,4);
  assert.ok(results.filter(r=>r.statusCode===429).every(r=>r.headers['retry-after']==='60'));
  assert.equal(await f.snapshot(),before);
 }finally{await f.close();}
});
test('misconfiguration and database failure are contained and expose no secrets',async()=>{
 const f=await fixture();try{
  for(const patch of [{EUPOVA_BUYER_AUTH_APP_ID:'wrong-app'},{EUPOVA_BUYER_AUTH_ENVIRONMENT:'production'},
   {EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM:'secret-invalid-key'},{EUPOVA_BUYER_AUTH_TEST_ENROLLMENT:'invalid'}]){
   const handler=configuredBuyerAuthHttp({origin,store:f.store,env:{...f.env,...patch}}),r=await request(handler);
   assert.equal(r.statusCode,503);assert.deepEqual(r.body,{error:'buyer_auth_configuration'});
  }
  const handler=configuredBuyerAuthHttp({origin,env:f.env,store:{rate:async()=>{throw Error('secret connection string');},query:f.store.query}});
  assert.deepEqual((await request(handler)).body,{error:'buyer_auth_unavailable'});
 }finally{await f.close();}
});
test('logout and kill switch during asynchronous issuance prevent a token',async()=>{
 const f=await fixture();try{
  let reads=0;const store={...f.store,query:async(sql,args)=>{if(sql.startsWith('SELECT')&&++reads===2)await f.db.query('UPDATE relay_customer_sessions SET revoked=true');return f.store.query(sql,args);}};
  assert.equal((await request(configuredBuyerAuthHttp({origin,store,env:f.env}))).statusCode,409);
  await f.db.query('UPDATE relay_customer_sessions SET revoked=false');
  const changed={...f.store,rate:async(...args)=>{await f.store.rate(...args);f.env.EUPOVA_BUYER_AUTH_DEV_ENABLED='false';}};
  assert.equal((await request(configuredBuyerAuthHttp({origin,store:changed,env:f.env}))).statusCode,404);
  f.env.EUPOVA_BUYER_AUTH_DEV_ENABLED='true';reads=0;
  const tokenSwitch={...f.store,query:async(sql,args)=>{
   if(sql.startsWith('SELECT')&&++reads===4)f.env.EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED='false';
   return f.store.query(sql,args);
  }};
  assert.equal((await request(configuredBuyerAuthHttp({origin,store:tokenSwitch,env:f.env}))).statusCode,404);
 }finally{await f.close();}
});
test('hosted request listener integrates routes without a socket or existing customer-session mutation',async()=>{
 const f=await fixture();let server;try{
  const before=await f.snapshot();server=createHostedServer({store:f.store,config:{origin,host:'example.test',testers:[]},
   paymentsDisabled:true,customerAccountsEnabled:false,pay:{readiness:()=>assert.fail('provider called')},buyerAuth:f.handler});
  const listener=server.listeners('request')[0];
  assert.equal((await request(listener)).statusCode,200);
  assert.equal((await request(listener,{headers:{host:'evil.test'}})).statusCode,421);
  const health=await request(listener,{path:'/healthz',method:'GET'});assert.equal(health.body.paymentsDisabled,true);
  assert.equal(await f.snapshot(),before);
 }finally{server?.close();await f.close();}
});
