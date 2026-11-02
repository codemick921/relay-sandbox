import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createAccountMail} from '../hosted/account-mail.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {config} from '../hosted/config.mjs';
const password='example admin meadow lantern password';
const email='admin@example.test';
const input=email=>({email,name:'Test person',password,acceptSandbox:true});
const extract=m=>m.text.match(/#reset-password=([a-f0-9]{64})/)[1];
async function setup(){
 const f=await fixture(),sent=[],mail=createAccountMail(f.store,{enabled:true,origin:'https://eupova.example',deliver:async m=>{sent.push(m);return {id:'fixture-'+m.id};}}),a=createAccounts(f.store,{mail,adminEmails:[email]});
 return {...f,sent,mail,a};
}
test('admin setup reserves email, requires single-use inbox proof, sends no password and is restart-safe',async()=>{
 const f=await setup();try{
  assert.deepEqual(await f.a.provisionAdmin(email),{created:true});assert.deepEqual(await f.a.provisionAdmin(email),{created:false});
  await assert.rejects(f.a.signup(input(email)),e=>e.status===409);await assert.rejects(f.a.login({email,password}),e=>e.status===401);
  await f.mail.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].subject,'Set up your Eupova admin account');assert.ok(!f.sent[0].text.includes(password));
  const token=extract(f.sent[0]);let row=(await f.store.query('SELECT * FROM relay_customers WHERE email=$1',[email])).rows[0];assert.equal(row.setup_pending,true);assert.equal(row.email_verified_at,null);
  assert.ok(!JSON.stringify((await f.store.query('SELECT * FROM relay_account_mail')).rows).includes(token));
  const result=await f.a.resetPassword({linkToken:token,password});assert.equal(result.recovered,true);assert.equal(result.recoveryCode.length,64);
  await assert.rejects(f.a.resetPassword({linkToken:token,password}),e=>e.status===400);
  const login=await f.a.login({email,password});assert.equal(login.account.emailVerified,true);assert.ok(await f.a.session(login.token));
  row=(await f.store.query('SELECT * FROM relay_customers WHERE email=$1',[email])).rows[0];assert.equal(row.setup_pending,false);
  await f.store.migrate();assert.deepEqual(await f.a.provisionAdmin(email),{created:false});assert.equal((await f.a.login({email,password})).account.id,login.account.id);
 }finally{await f.close();}
});
test('existing accounts are untouched; expired setup can be requested again; disabled or uncertain setup cannot auto-retry',async()=>{
 const f=await setup();try{
  const u=await f.a.signup(input(email)),before=(await f.store.query('SELECT password_hash,version,email_verified_at FROM relay_customers WHERE id=$1',[u.account.id])).rows[0];
  assert.deepEqual(await f.a.provisionAdmin(email),{created:false});assert.deepEqual((await f.store.query('SELECT password_hash,version,email_verified_at FROM relay_customers WHERE id=$1',[u.account.id])).rows[0],before);
  await assert.rejects(f.a.provisionAdmin('other@example.test'),e=>e.status===403);
 }finally{await f.close();}
 const g=await setup();try{await g.a.provisionAdmin(email);await g.mail.tick();const old=extract(g.sent[0]);await g.store.query("UPDATE relay_account_mail SET expires_at=now()-interval '1 second',created_at=now()-interval '2 minutes'");await assert.rejects(g.a.resetPassword({linkToken:old,password}),e=>e.status===400);await g.a.requestReset({email});await g.mail.tick();assert.equal(g.sent.length,2);await g.a.resetPassword({linkToken:extract(g.sent[1]),password});}finally{await g.close();}
});
test('admin HTTP denies anonymous, normal and unverified users; protects mutations, self access and secrets',async()=>{
 const f=await setup();let server;try{
  await f.a.provisionAdmin(email);await f.mail.tick();await f.a.resetPassword({linkToken:extract(f.sent[0]),password});const admin=await f.a.login({email,password});const customer=await f.a.signup(input('customer@example.test'));
  server=createHostedServer({store:f.store,config:{origin:'https://eupova.example',host:'eupova.example',testers:[],accountAdmins:[email]},accountMail:f.mail,paymentsDisabled:true,allowHttpForTests:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const request=(path,{token=admin.token,data,origin='https://eupova.example',method=data?'POST':'GET'}={})=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'eupova.example',origin,'content-type':'application/json',cookie:'__Host-relay_sandbox='+token}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(b)}));});q.on('error',reject);q.end(data?JSON.stringify(data):undefined);});
  for(const path of ['/api/admin/overview','/api/admin/accounts','/api/admin/audit','/api/operator/test-invites']){
   assert.equal((await request(path,{token:''})).status,401);assert.equal((await request(path,{token:customer.token})).status,403);assert.equal((await request(path)).status,200);
  }
  assert.equal((await request('/api/state')).body.adminDashboard,true);assert.equal((await request('/api/state',{token:customer.token})).body.adminDashboard,false);
  const rows=await request('/api/admin/accounts');for(const secret of ['password_hash','recovery_hash','token_hash'])assert.ok(!JSON.stringify(rows).includes(secret));
  const change={id:customer.account.id,action:'disable',currentPassword:password,confirm:true};
  assert.equal((await request('/api/admin/accounts/change',{data:change,origin:'https://evil.example'})).status,403);
  assert.equal((await request('/api/admin/accounts/change',{data:{...change,currentPassword:'wrong'}})).status,403);
  assert.equal((await request('/api/admin/accounts/change',{data:{...change,id:admin.account.id}})).status,403);
  assert.equal((await request('/api/admin/accounts/change',{data:change})).status,200);assert.equal(await f.a.session(customer.token),null);
  assert.equal((await request('/api/admin/accounts/change',{data:{...change,action:'enable'}})).status,200);const newLogin=await f.a.login({email:customer.account.email,password});assert.ok(newLogin.token);
  assert.equal((await request('/api/admin/accounts/change',{data:{...change,action:'signout'}})).status,200);assert.equal(await f.a.session(newLogin.token),null);
  const issued=await request('/api/operator/test-invites/create',{data:{label:'Friend fixture',allowLive:false,days:7}});assert.equal(issued.status,200);assert.ok(issued.body.code);assert.ok(!JSON.stringify((await request('/api/operator/test-invites')).body).includes(issued.body.code));
  assert.equal((await request('/api/operator/test-invites/revoke',{data:{id:issued.body.id}})).status,200);
  assert.equal((await request('/api/admin/accounts?page=-1')).status,400);assert.equal((await request('/api/admin/overview',{data:{}})).status,405);
  assert.equal((await request('/api/account/provisionAdmin',{data:{email:'attacker@example.test'}})).status,404);
  const audit=(await request('/api/admin/audit')).body;assert.ok(audit.events.some(e=>e.event==='account_disable'));assert.ok(!JSON.stringify(audit).includes(password));
  await f.store.query('UPDATE relay_customers SET email_verified_at=NULL WHERE id=$1',[admin.account.id]);assert.equal((await request('/api/admin/overview')).status,403);assert.equal((await request('/api/operator/test-invites')).status,403);assert.equal((await request('/api/operator/payment-health')).status,403);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
test('admin configuration defaults off and rejects malformed or duplicate email addresses',()=>{
 const env={RELAY_MODE:'sandbox',PUBLIC_ORIGIN:'https://eupova.example',DATABASE_URL:'fixture',SANDBOX_TESTERS:JSON.stringify([{label:'owner',sha256hex:'a'.repeat(64)}])};
 assert.deepEqual(config(env).accountAdmins,[]);assert.deepEqual(config({...env,EUPOVA_ACCOUNT_ADMINS:JSON.stringify([email])}).accountAdmins,[email]);
 for(const value of ['{}','["admin"]','["Admin@example.test"]',JSON.stringify([email,email])])assert.throws(()=>config({...env,EUPOVA_ACCOUNT_ADMINS:value}));
});

test('setup delivery failure is retained without automatic retry; expired or disabled setup cannot activate',async()=>{
 const f=await fixture();try{
  let attempts=0;const mail=createAccountMail(f.store,{enabled:true,origin:'https://eupova.example',deliver:async()=>{attempts++;throw Error('uncertain');}}),a=createAccounts(f.store,{mail,adminEmails:[email]});
  await a.provisionAdmin(email);await mail.tick();await mail.tick();await a.provisionAdmin(email);await mail.tick();assert.equal(attempts,1);assert.equal((await f.store.query('SELECT state FROM relay_account_mail')).rows[0].state,'unknown');
 }finally{await f.close();}
 const g=await setup();try{await g.a.provisionAdmin(email);await g.mail.tick();await g.store.query('UPDATE relay_customers SET disabled=true WHERE email=$1',[email]);await assert.rejects(g.a.resetPassword({linkToken:extract(g.sent[0]),password}),e=>e.status===400);}finally{await g.close();}
});
