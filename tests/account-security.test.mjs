import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createAccountSecurity} from '../hosted/account-security.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createHostedServer} from '../hosted/server.mjs';
const password='correct horse meadow lantern';
const signup=email=>({email,name:'Security tester',password,acceptSandbox:true});
const wallet={name:'Research agent',address:'0x1111111111111111111111111111111111111111',network:'base',own:true,currentPassword:password};
const changed='0x2222222222222222222222222222222222222222';
async function setup(){const f=await fixture(),accounts=createAccounts(f.store),a=await accounts.signup(signup('alice@example.test'));return {...f,accounts,a,security:createAccountSecurity(f.store,accounts),owner:'customer:'+a.account.id};}

test('email recovery readiness excludes unverified addresses, disabled mail and preview delivery',async()=>{
 const f=await setup();try{
  const enabled=createAccountSecurity(f.store,f.accounts,{mailEnabled:true});
  assert.equal((await enabled.security({},f.a.token)).emailRecoveryAvailable,false);
  await f.store.query('UPDATE relay_customers SET email_verified_at=now() WHERE id=$1',[f.a.account.id]);
  assert.equal((await enabled.security({},f.a.token)).emailRecoveryAvailable,true);
  assert.equal((await f.security.security({},f.a.token)).emailRecoveryAvailable,false);
  const preview=await createAccountSecurity(f.store,f.accounts,{mailEnabled:true,mailPreview:true}).security({},f.a.token);
  assert.equal(preview.emailRecoveryAvailable,false);assert.equal(preview.emailRecoveryPreview,true);
 }finally{await f.close();}
});

test('session listing exposes public IDs only, survives migrations and restricts revocation to the owner',async()=>{
 const f=await setup();try{
  const b=await f.accounts.signup(signup('bob@example.test'));
  const phone=await f.accounts.login({email:f.a.account.email,password},null,{userAgent:'Mozilla iPhone Safari/1'});
  await f.store.migrate();const state=await f.security.security({},f.a.token);
  assert.equal(state.sessions.length,2);assert.equal(state.sessions.filter(x=>x.current).length,1);assert.match(state.sessions.find(x=>!x.current).label,/iPhone/);
  assert.ok(state.sessions.every(x=>/^[a-f0-9-]{36}$/.test(x.id)));assert.ok(!JSON.stringify(state).includes(f.a.token));assert.ok(!JSON.stringify(state).includes('token_hash'));
  const own=state.sessions.find(x=>x.current),other=state.sessions.find(x=>!x.current),bob=(await f.security.security({},b.token)).sessions[0];
  await assert.rejects(f.security.revokeSession({id:bob.id,currentPassword:password},f.a.token),e=>e.status===404);
  await assert.rejects(f.security.revokeSession({id:own.id,currentPassword:password},f.a.token),/Use Sign out/);
  await assert.rejects(f.security.revokeSession({id:other.id,currentPassword:'wrong'},f.a.token),e=>e.status===403);
  await f.security.revokeSession({id:other.id,currentPassword:password},f.a.token);
  assert.equal(await f.accounts.session(phone.token),null);assert.ok(await f.accounts.session(f.a.token));assert.ok(await f.accounts.session(b.token));
  const p2=await f.accounts.login({email:f.a.account.email,password});await f.security.revokeSession({allOthers:true,currentPassword:password},f.a.token);assert.equal(await f.accounts.session(p2.token),null);
  assert.equal((await f.security.security({},f.a.token)).sessions.length,1);
 }finally{await f.close();}
});

test('recovery checklist verifies the current code, rotation invalidates the old code without killing sessions',async()=>{
 const f=await setup();try{
  assert.equal((await f.security.security({},f.a.token)).recoveryConfirmedAt,null);
  await assert.rejects(f.security.confirmRecovery({recoveryCode:'a'.repeat(64)},f.a.token),e=>e.status===403);
  await f.security.confirmRecovery({recoveryCode:f.a.recoveryCode},f.a.token);assert.ok((await f.security.security({},f.a.token)).recoveryConfirmedAt);
  const rotated=await f.security.rotateRecovery({currentPassword:password},f.a.token);assert.notEqual(rotated.recoveryCode,f.a.recoveryCode);assert.ok(await f.accounts.session(f.a.token));
  assert.equal((await f.security.security({},f.a.token)).recoveryConfirmedAt,null);
  await assert.rejects(f.security.confirmRecovery({recoveryCode:f.a.recoveryCode},f.a.token),e=>e.status===403);
  await assert.rejects(f.accounts.recover({email:f.a.account.email,recoveryCode:f.a.recoveryCode,password}),e=>e.status===401);
  await f.security.confirmRecovery({recoveryCode:rotated.recoveryCode},f.a.token);
  const events=JSON.stringify((await f.store.query('SELECT * FROM relay_security_events')).rows);assert.ok(!events.includes(rotated.recoveryCode));assert.ok(!events.includes(password));
  const reset=await f.accounts.password({currentPassword:password,password:'new distinct forest password'},f.a.token);assert.equal((await f.security.security({},reset.token)).recoveryConfirmedAt,null);
 }finally{await f.close();}
});

test('wallet changes require password, reject stale or foreign edits and preserve existing order and draft destinations',async()=>{
 const f=await setup();try{
  const drafts=createFundingDrafts(f.store);await drafts.migrate();
  await assert.rejects(f.security.saveWallet({...wallet,currentPassword:'wrong'},f.a.token),e=>e.status===403);
  const saved=await f.security.saveWallet(wallet,f.a.token);const before=(await f.store.state(f.owner)).agents[0];
  const draft=await drafts.prepare(f.owner,{requestId:randomUUID(),agentId:saved.id,amount:'5',rail:'wise',confirm:true});
  const order=await f.store.createOrder(f.owner,{requestId:randomUUID(),agentId:saved.id,amount:500});
  const input={...wallet,id:saved.id,name:'Updated agent',address:changed,expectedName:wallet.name,expectedAddress:wallet.address};
  const b=await f.accounts.signup(signup('bob@example.test'));await assert.rejects(f.security.saveWallet(input,b.token,{update:true}),e=>e.status===404);
  await f.security.saveWallet(input,f.a.token,{update:true});assert.equal((await f.store.state(f.owner)).agents[0].address.toLowerCase(),changed);
  const oldDraft=(await drafts.list(f.owner))[0];assert.equal(oldDraft.walletCurrent,false);assert.equal(oldDraft.agent.address,before.address.toLowerCase());
  assert.equal((await f.store.owned(f.owner,order.id)).request.agent.address,before.address);
  await assert.rejects(f.security.saveWallet(input,f.a.token,{update:true}),e=>e.status===409);
  await assert.rejects(f.security.saveWallet({...wallet,address:changed},f.a.token),e=>e.status===409);
  assert.equal((await f.store.query('SELECT count(*) FROM relay_security_events WHERE event=$1',["wallet_updated"])).rows[0].count,process.env.TEST_DATABASE_URL?'1':1);
  assert.equal((await drafts.list(f.owner)).find(d=>d.id===draft.id).agent.address,before.address.toLowerCase());
 }finally{await f.close();}
});

test('two concurrent edits cannot silently overwrite the same reviewed destination',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await setup();try{
  const saved=await f.security.saveWallet(wallet,f.a.token),base={...wallet,id:saved.id,expectedAddress:wallet.address,expectedName:wallet.name};
  const results=await Promise.allSettled([f.security.saveWallet({...base,address:changed},f.a.token,{update:true}),f.security.saveWallet({...base,address:'0x3333333333333333333333333333333333333333'},f.a.token,{update:true})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,409);
 }finally{await f.close();}
});

test('revocation between password verification and commit blocks a wallet mutation',async()=>{
 const f=await setup();try{
  const raced={...f.store,tx:async fn=>{await f.accounts.logout(f.a.token);return f.store.tx(fn);}};
  await assert.rejects(createAccountSecurity(raced,f.accounts).saveWallet(wallet,f.a.token),e=>e.status===401);
  assert.equal((await f.store.state(f.owner)).agents.length,0);
 }finally{await f.close();}
});

test('expired sessions and durable failed-password limits cannot bypass security',async()=>{
 const f=await setup();try{
  for(let i=0;i<10;i++)await assert.rejects(f.security.rotateRecovery({currentPassword:'wrong'},f.a.token),e=>e.status===403);
  await assert.rejects(f.security.rotateRecovery({currentPassword:password},f.a.token),e=>e.status===429);
  await f.store.query("UPDATE relay_customer_sessions SET last_seen_at=now()-interval '3 hours'");
  await assert.rejects(f.security.security({},f.a.token),e=>e.status===401);await assert.rejects(f.security.confirmRecovery({recoveryCode:f.a.recoveryCode},f.a.token),e=>e.status===401);
 }finally{await f.close();}
});

test('HTTP security endpoints enforce same-origin and ownership, preserve the session and never call providers',async()=>{
 const f=await setup();let server;try{
  let calls=0;server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},allowHttpForTests:true,paymentsDisabled:true,pay:{readiness:async()=>{calls++;}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const req=(path,data,token=f.a.token,origin='https://relay.example')=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:data?'POST':'GET',headers:{host:'relay.example',origin,'content-type':'application/json',cookie:token?'__Host-relay_sandbox='+token:''}},res=>{let s='';res.on('data',x=>s+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(s),cookie:res.headers['set-cookie'],cache:res.headers['cache-control']}));});r.on('error',reject);r.end(data?JSON.stringify(data):undefined);});
  assert.equal((await req('/api/account/security',{},null)).status,401);assert.equal((await req('/api/account/security',{},f.a.token,'https://evil.example')).status,403);
  const list=await req('/api/account/security',{});assert.equal(list.status,200);assert.equal(list.cookie,undefined);assert.equal(list.cache,'no-store');assert.equal((await req('/api/state')).status,200);
  assert.equal((await req('/api/agents',{...wallet,currentPassword:undefined})).status,403);
  const saved=await req('/api/agents',wallet);assert.equal(saved.status,200);assert.equal(saved.data.account.id,f.a.account.id);
  const a=saved.data.agents[0];assert.equal((await req('/api/agents/update',{...wallet,id:a.id,address:changed,expectedName:a.name,expectedAddress:a.address})).status,200);
  assert.equal((await req('/api/account/confirmRecovery',{recoveryCode:f.a.recoveryCode})).status,200);assert.equal((await req('/api/state')).status,200);
  assert.equal((await req('/api/checkouts',{})).status,403);assert.equal((await req('/healthz')).data.realPaymentsEnabled,false);assert.equal(calls,0);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
