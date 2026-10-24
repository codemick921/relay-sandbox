import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import http from 'node:http';
import {createStore,digest} from '../hosted/db.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createHostedServer} from '../hosted/server.mjs';
async function fixture(){
 if(process.env.TEST_DATABASE_URL){
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});const schema='test_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:8});
  const store=createStore(pool);await store.migrate();return {store,close:async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
 }
 const db=new PGlite();let tail=Promise.resolve();
 async function connect(){let release;const old=tail;tail=new Promise(r=>release=r);await old;return {query:async(sql,args=[])=>sql.includes('CREATE TABLE')?(await db.exec(sql)).at(-1):db.query(sql,args),release};}
 const pool={connect,query:async(sql,args)=>{const c=await connect();try{return await c.query(sql,args);}finally{c.release();}},end:()=>db.close()};const store=createStore(pool);await store.migrate();return {store,close:()=>pool.end()};
}
const password='correct horse meadow lantern';
const signup=email=>({email,password,name:'Customer example',acceptSandbox:true});
test('customer sign-up normalises email, salts passwords, isolates wallets and preserves sessions across migration',async()=>{
 const f=await fixture();try{
  const a=createAccounts(f.store),alice=await a.signup(signup('Alice@Example.test')),bob=await a.signup(signup('bob@example.test'));
  assert.equal(alice.account.email,'alice@example.test');assert.equal(alice.account.emailVerified,false);
  const rows=(await f.store.query('SELECT * FROM relay_customers')).rows;assert.notEqual(rows[0].password_hash,rows[1].password_hash);assert.ok(rows.every(r=>!r.password_hash.includes(password)));assert.equal(rows.find(r=>r.id===alice.account.id).recovery_hash,digest(alice.recoveryCode));
  const owner=(await a.session(alice.token)).owner,other=(await a.session(bob.token)).owner;assert.match(owner,/^customer:/);
  const wallet={id:randomUUID(),name:'Saved agent',address:'0x1111111111111111111111111111111111111111',network:'Base',token:'USDC',ownership:'self_declared_unverified'};
  await f.store.addAgent(owner,wallet);assert.equal((await f.store.state(other)).agents.length,0);assert.equal((await f.store.state('alice')).agents.length,0);
  await f.store.migrate();const restarted=createAccounts(createStore({query:f.store.query}));assert.equal((await restarted.session(alice.token)).owner,owner);
  await a.logout(alice.token);assert.equal(await a.session(alice.token),null);const login=await a.login({email:'ALICE@example.test',password});assert.equal((await f.store.state((await a.session(login.token)).owner)).agents[0].id,wallet.id);
  await assert.rejects(a.signup(signup('alice@example.test')),/Unable to create/);await assert.rejects(a.login({email:'absent@example.test',password}),/Email or password/);await assert.rejects(a.login({email:'bob@example.test',password:'incorrect'}),/Email or password/);
 }finally{await f.close();}
});
test('recovery rotates one-use code, revokes every old session and preserves saved wallet',async()=>{
 const f=await fixture();try{
  const a=createAccounts(f.store),s=await a.signup(signup('reset@example.test')),second=await a.login({email:s.account.email,password});
  const owner=(await a.session(s.token)).owner;await f.store.addAgent(owner,{id:randomUUID(),name:'Retained',address:'0x1111111111111111111111111111111111111111'});
  await assert.rejects(a.recover({email:s.account.email,recoveryCode:'a'.repeat(64),password}),/not recognised/);
  const changed=await a.recover({email:s.account.email,recoveryCode:s.recoveryCode,password:'new meadow lantern ocean'});
  assert.notEqual(changed.recoveryCode,s.recoveryCode);assert.equal(await a.session(s.token),null);assert.equal(await a.session(second.token),null);
  await assert.rejects(a.recover({email:s.account.email,recoveryCode:s.recoveryCode,password}),/not recognised/);
  await assert.rejects(a.login({email:s.account.email,password}),/not recognised/);
  const next=await a.login({email:s.account.email,password:'new meadow lantern ocean'});assert.equal((await f.store.state((await a.session(next.token)).owner)).agents.length,1);
  const changedAgain=await a.password({currentPassword:'new meadow lantern ocean',password:'another distinct meadow phrase'},next.token);
  assert.equal(await a.session(next.token),null);assert.ok(await a.session(changedAgain.token));
  await assert.rejects(a.recover({email:s.account.email,recoveryCode:changed.recoveryCode,password}),/not recognised/);
 }finally{await f.close();}
});
test('accounts enforce bounded passwords, expiry, disabled accounts and durable attempt limits',async()=>{
 const f=await fixture();try{
  const a=createAccounts(f.store);await assert.rejects(a.signup({...signup('weak@example.test'),password:'short'}),/15 to 128/);await assert.rejects(a.signup({...signup('bad@example.test'),acceptSandbox:false}),/confirm/);
  const s=await a.signup(signup('expiry@example.test'));await f.store.query("UPDATE relay_customer_sessions SET last_seen_at=now()-interval '3 hours'");assert.equal(await a.session(s.token),null);
  await f.store.query('UPDATE relay_customers SET disabled=true WHERE id=$1',[s.account.id]);await assert.rejects(a.login({email:s.account.email,password}),/not recognised/);
  for(let i=0;i<10;i++)await assert.rejects(a.login({email:'limited@example.test',password}),e=>e.status===401);
  await assert.rejects(a.login({email:'limited@example.test',password}),e=>e.status===429);
 }finally{await f.close();}
});
test('simultaneous recovery consumes a code once with real PostgreSQL',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const a=createAccounts(f.store),s=await a.signup(signup('race@example.test'));const results=await Promise.allSettled([a.recover({email:s.account.email,password,recoveryCode:s.recoveryCode}),a.recover({email:s.account.email,password,recoveryCode:s.recoveryCode})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,401);}finally{await f.close();}
});
test('HTTP account flow keeps provider routes disabled, rotates cookies and scopes wallets to the authenticated customer',async()=>{
 const f=await fixture();let server;try{
  const principal={label:'oldtester',sha256hex:digest('tester-code')};let providerCalls=0;
  server=createHostedServer({store:f.store,config:{origin:'https://sandbox.example',host:'sandbox.example',testers:[principal]},paymentsDisabled:true,pay:{readiness:async()=>{providerCalls++;}},allowHttpForTests:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const request=(path,data,cookie,headers={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:data?'POST':'GET',headers:{host:'sandbox.example',origin:'https://sandbox.example','content-type':'application/json',...cookie?{cookie}:{},...headers}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body),cookie:res.headers['set-cookie']?.[0].split(';')[0],cookieHeader:res.headers['set-cookie']?.[0]}));});r.on('error',reject);r.end(data?JSON.stringify(data):undefined);});
  assert.equal((await request('/api/access')).data.customerAccounts,true);
  assert.equal((await request('/api/account/signup',signup('http@example.test'),null,{origin:'https://evil.example'})).status,403);
  const one=await request('/api/account/signup',signup('http@example.test'));assert.equal(one.status,200);assert.match(one.cookieHeader,/Secure; HttpOnly; SameSite=Strict/);assert.equal(one.data.token,undefined);
  const wallet={name:'My agent',address:'0x1111111111111111111111111111111111111111',network:'base',own:true,owner:'oldtester',currentPassword:password};
  const saved=await request('/api/agents',wallet,one.cookie);assert.equal(saved.status,200);assert.equal(saved.data.account.id,one.data.account.id);assert.equal((await request('/api/agents',wallet,one.cookie)).status,409);
  const two=await request('/api/account/signup',signup('other@example.test'),one.cookie);assert.equal((await request('/api/state',null,one.cookie)).status,401);assert.equal((await request('/api/state',null,two.cookie)).data.agents.length,0);
  assert.equal((await request('/api/checkouts',{},two.cookie)).status,403);assert.equal((await request('/api/webhooks/peer/sandbox',{})).status,403);assert.equal((await request('/api/checkout-setup',null,two.cookie)).data.ready,false);assert.equal(providerCalls,0);
  const login=await request('/api/account/login',{email:'http@example.test',password},two.cookie);assert.equal((await request('/api/state',null,login.cookie)).data.agents[0].ownership,'self_declared_unverified');assert.equal((await request('/api/state',null,two.cookie)).status,401);
  assert.equal((await request('/api/logout',{},login.cookie)).status,200);assert.equal((await request('/api/state',null,login.cookie)).status,401);
  const tester=await request('/api/login',{code:'tester-code'});assert.equal(tester.status,200);assert.equal((await request('/api/state',null,tester.cookie)).data.agents.length,0);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
