import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {createNativePrivyService,nativeInventory,nativeConsent} from '../server/quote-first/native-privy.mjs';
import {createNativePrivyStore} from '../server/quote-first/native-privy-store.mjs';
import {createNativePrivyHttp,configuredNativePrivy,nativeTestAccess} from '../server/quote-first/native-privy-http.mjs';
import {createNativeRequests,nativeUiConfig,validNativeStatus} from '../src/native-privy-client.mjs';
import {Readable} from 'node:stream';
const appId='nativeapp1234567890',did='did:privy:sampletest',address='0x1111111111111111111111111111111111111111';
const wallet={type:'wallet',address,chainType:'ethereum',walletClientType:'privy',connectorType:'embedded',userCanSign:true,delegated:false,imported:false};
function fixture(store){let active=true;const session={owner:'customer:'+randomUUID(),binding:'b'.repeat(64),expiresAt:Date.now()+600000},access={did,sid:'first-session',expiresAt:Date.now()+3600000},user={id:did,linkedAccounts:[{type:'email'},wallet]};const opts={appId,store,resolveSession:async()=>session,verifyAccessToken:async()=>access,readPrivyUser:async()=>user,enabled:()=>active};return {session,access,user,opts,service:createNativePrivyService(opts),disable:()=>active=false};}
async function review(f){const intent=await f.service.begin('session');await f.service.review('session','privy',intent.nonce);return {nonce:intent.nonce,consent:true,consentVersion:nativeConsent};}
for(const engine of ['pglite',...(process.env.TEST_DATABASE_URL?['postgres']:[])])test('native identity linking with '+engine,async t=>{
 let db,close;
 if(engine==='pglite'){const p=new PGlite();await p.exec(await readFile(new URL('../migrations/manual/native-privy-links.sql',import.meta.url),'utf8'));db={query:(...a)=>p.query(...a),transaction:fn=>p.transaction(tx=>fn(tx))};close=()=>p.close();}
 else{const u=new URL(process.env.TEST_DATABASE_URL);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.pathname,'/relay_test');const pool=new pg.Pool({connectionString:u.href,max:4});await pool.query(await readFile(new URL('../migrations/manual/native-privy-links.sql',import.meta.url),'utf8'));db={query:(...a)=>pool.query(...a),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};close=()=>pool.end();}
 const store=createNativePrivyStore(db);
 try{
 await t.test('explicit dual-auth review links once and restart retains it',async()=>{const f=fixture(store);f.access.did=f.user.id='did:privy:'+randomUUID().replaceAll('-','');const input=await review(f);await f.service.confirm('session','privy',input);assert.equal((await f.service.status('session')).linked,true);assert.equal((await createNativePrivyService(f.opts).status('session')).linked,true);await assert.rejects(f.service.confirm('session','privy',input),/intent_expired/);assert.equal((await f.service.recovery('session','privy')).status,'new_sign_in_needed');f.access.sid='new-session';const r=await f.service.recovery('session','privy');assert.equal(r.status,'reauthentication_checked');assert.equal(r.browserRecoveryProven,false);assert.equal(r.canCreateWallet,false);});
 await t.test('race consumes a reviewed intent only once',async()=>{const f=fixture(store);f.access.did=f.user.id='did:privy:'+randomUUID().replaceAll('-','');const input=await review(f);const results=await Promise.allSettled(Array.from({length:8},()=>f.service.confirm('session','privy',input)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);});
 await t.test('same DID cannot link to another owner even with valid consent',async()=>{const a=fixture(store);a.access.did=a.user.id='did:privy:'+randomUUID().replaceAll('-','');await a.service.confirm('session','privy',await review(a));const b=fixture(store);b.access.did=b.user.id=a.access.did;await assert.rejects(async()=>b.service.confirm('session','privy',await review(b)));assert.equal((await b.service.status('session')).linked,false);});
 await t.test('changed identity or wallet after review cannot be confirmed',async()=>{for(const mutate of [f=>f.access.sid='changed',f=>{f.access.did=f.user.id='did:privy:changed';},f=>f.user.linkedAccounts=[]]){const f=fixture(store),input=await review(f);mutate(f);await assert.rejects(f.service.confirm('session','privy',input));assert.equal((await f.service.status('session')).linked,false);}});
 await t.test('another session cannot consume intent; expiry is database enforced',async()=>{const f=fixture(store),input=await review(f);f.session.binding='c'.repeat(64);await assert.rejects(f.service.confirm('session','privy',input));f.session.binding='b'.repeat(64);await db.query("UPDATE eupova_native_auth.intents SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '5 minutes' WHERE owner=$1",[f.session.owner]);await assert.rejects(f.service.confirm('session','privy',input));});
 await t.test('linking does not create a wallet and cannot claim recovery without one',async()=>{const f=fixture(store);f.access.did=f.user.id='did:privy:'+randomUUID().replaceAll('-','');f.user.linkedAccounts=[{type:'passkey'}];await f.service.confirm('session','privy',await review(f));f.access.sid='new';const r=await f.service.recovery('session','privy');assert.equal(r.status,'no_wallet');assert.equal(r.walletChecked,false);});
 await t.test('missing consent and switched Eupova session fail',async()=>{const f=fixture(store),input=await review(f);await assert.rejects(f.service.confirm('session','privy',{...input,consent:false}));const s=createNativePrivyService({...f.opts,readPrivyUser:async()=>{f.session.binding='e'.repeat(64);return f.user;}});await assert.rejects(s.confirm('session','privy',input),/session_changed/);});
 }finally{await close();}
});
test('wallet evidence rejects custom auth, imported/delegated/external/ambiguous inventories',()=>{for(const edit of [u=>u.linkedAccounts.push({type:'custom_auth'}),u=>u.linkedAccounts.push(wallet),u=>u.linkedAccounts[1]={...wallet,delegated:true},u=>u.linkedAccounts[1]={...wallet,imported:true},u=>u.linkedAccounts[1]={...wallet,connectorType:'external'},u=>u.linkedAccounts[1]={...wallet,userCanSign:undefined}]){const u={id:did,linkedAccounts:[{type:'email'},{...wallet}]};edit(u);assert.throws(()=>nativeInventory(u,did));}});
test('disabled service has no identity or database calls',async()=>{const f=fixture({link:()=>assert.fail()});f.disable();await assert.rejects(f.service.status('session'),/native_disabled/);});
test('unknown commit result is never reported as linked',async()=>{const f=fixture({confirm:async v=>{await v.recheck();throw Error('lost commit acknowledgement');}});await assert.rejects(f.service.confirm('session','privy',{nonce:'a'.repeat(64),consent:true,consentVersion:nativeConsent}));});
async function http(handler,path,{method='GET',headers={},body}={}){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url=path;req.method=method;req.headers={host:'app.eupova.com','x-forwarded-proto':'https','sec-fetch-site':'same-origin',cookie:'__Host-relay_sandbox='+'a'.repeat(64),...headers};const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};await handler(req,res);return res;}
test('disabled HTTP serves signed-in information but rejects all mutations',async()=>{const h=configuredNativePrivy({origin:'https://app.eupova.com',store:{query:async()=>({rows:[]})},staticRoot:'/none',env:{}});assert.equal((await http(h,'/api/native-privy/status')).status,401);const handler=createNativePrivyHttp({origin:'https://app.eupova.com',resolveSession:async()=>({expiresAt:Date.now()+10000}),document:async()=>'native screen'});const r=await http(handler,'/api/native-privy/status');assert.equal(JSON.parse(r.body).enabled,false);assert.equal((await http(handler,'/api/native-privy/confirm',{method:'POST'})).status,404);assert.equal((await http(handler,'/buying-wallet-connect')).body,'native screen');});
test('HTTP blocks cross-origin, wrong method, missing CSRF and browser identity injection',async()=>{const h=createNativePrivyHttp({origin:'https://app.eupova.com',enabled:()=>true,service:{begin:()=>assert.fail()},resolveSession:async()=>({owner:'sample',expiresAt:Date.now()+10000}),rate:async()=>true});assert.equal((await http(h,'/api/native-privy/begin',{method:'POST',headers:{origin:'https://other.example'}})).status,403);assert.equal((await http(h,'/api/native-privy/begin')).status,405);assert.equal((await http(h,'/api/native-privy/begin',{method:'POST'})).status,403);assert.equal((await http(h,'/api/native-privy/begin',{method:'POST',headers:{origin:'https://app.eupova.com','x-eupova-native':'1','content-type':'application/json'},body:{owner:'another'}})).status,400);});
test('client only permits sign-in/link/recovery requests and never automatic wallet creation',async()=>{assert.equal(nativeUiConfig.embeddedWallets.ethereum.createOnLogin,'off');assert.equal(nativeUiConfig.embeddedWallets.solana.createOnLogin,'off');const request=createNativeRequests(()=>assert.fail());for(const action of ['pay','create-wallet','sign','checkout','export'])await assert.rejects(request(action));assert.equal(validNativeStatus({enabled:true,appId,consentVersion:nativeConsent,linked:false,canCreateWallet:false,canCreatePayment:false}),true);});

test('native production test access is account-specific, read-only and expires',async()=>{
 const owner='customer:'+randomUUID();let now=Date.now(),queries=0;
 const env={EUPOVA_PRIVY_NATIVE_TEST_EMAIL:'approved@example.com',EUPOVA_PRIVY_NATIVE_TEST_UNTIL:new Date(now+600000).toISOString()};
 const store={query:async(sql,args)=>{queries++;assert.match(sql,/^SELECT id FROM relay_customers/);assert.deepEqual(args,[owner.slice(9),'approved@example.com']);return {rows:[{id:owner.slice(9)}]};}};
 const allow=nativeTestAccess(store,env,()=>now);assert.equal(await allow({owner}),true);
 now+=600001;assert.equal(await allow({owner}),false);assert.equal(queries,1);
 assert.equal(await nativeTestAccess(store,{},()=>now)({owner}),false);
 assert.equal(await nativeTestAccess(store,{...env,EUPOVA_PRIVY_NATIVE_TEST_UNTIL:new Date(now+3600000).toISOString()},()=>now)({owner}),false);
 assert.equal(await nativeTestAccess({query:async()=>({rows:[]})},{...env,EUPOVA_PRIVY_NATIVE_TEST_UNTIL:new Date(now+600000).toISOString()},()=>now)({owner:'customer:'+randomUUID()}),false);
});
test('non-test customers cannot invoke native service even when global switch is on',async()=>{
 const h=createNativePrivyHttp({origin:'https://app.eupova.com',enabled:()=>true,accessAllowed:async()=>false,service:{begin:()=>assert.fail()},resolveSession:async()=>({owner:'other',expiresAt:Date.now()+10000}),document:async()=>'information',rate:async()=>assert.fail()});
 assert.equal(JSON.parse((await http(h,'/api/native-privy/status')).body).enabled,false);
 for(const route of ['begin','review','confirm','recovery'])assert.equal((await http(h,'/api/native-privy/'+route,{method:'POST'})).status,404);
 assert.equal((await http(h,'/buying-wallet-connect')).body,'information');
});

test('native HTTP accepts the hosted limiter success contract and preserves rate failures',async()=>{
 let calls=0;
 const make=rate=>createNativePrivyHttp({origin:'https://app.eupova.com',enabled:()=>true,resolveSession:async()=>({owner:'sample',expiresAt:Date.now()+10000}),service:{status:async()=>{calls++;return {enabled:true};}},rate});
 const success=await http(make(async()=>{}),'/api/native-privy/status');
 assert.equal(success.status,200);assert.equal(JSON.parse(success.body).enabled,true);assert.equal(calls,1);
 for(const rate of [async()=>false,async()=>{throw Object.assign(Error('limited'),{status:429});}]){
 const r=await http(make(rate),'/api/native-privy/status');assert.equal(r.status,429);assert.deepEqual(JSON.parse(r.body),{error:'too_many_requests'});
 }
 assert.equal((await http(make(async()=>{throw Error('database unavailable');}),'/api/native-privy/status')).status,503);assert.equal(calls,1);
});
