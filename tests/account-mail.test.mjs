import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createAccountMail} from '../hosted/account-mail.mjs';
import {configuredAccountMail} from '../hosted/mail-transport.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {digest} from '../hosted/db.mjs';
const password='correct horse meadow lantern', nextPassword='new meadow lantern ocean phrase';
const signup=email=>({email,password,name:'Email test',acceptSandbox:true});
function setup(store,options={}){const sent=[];const mail=createAccountMail(store,{enabled:true,origin:'https://relay.example',deliver:async m=>{sent.push(m);return {id:'fake-'+m.id};},...options});return {sent,mail,a:createAccounts(store,{mail})};}
const token=m=>m.text.match(/#(?:verify-email|reset-password)=([a-f0-9]{64})/)[1];
async function verified(s,email='alice@example.test'){const u=await s.a.signup(signup(email));await s.mail.tick();await s.a.verifyEmail({linkToken:token(s.sent.at(-1))},u.token);return u;}

test('verification binds account and purpose, stores hashes only, consumes once and survives migration',async()=>{
 const f=await fixture();try{const s=setup(f.store),u=await s.a.signup(signup('alice@example.test')),v=await s.a.signup(signup('bob@example.test'));
 assert.equal(s.sent.length,0);assert.equal(u.account.emailVerified,false);await s.mail.tick();const message=s.sent.find(x=>x.to===u.account.email),t=token(message);
 assert.match(message.text,/https:\/\/relay.example\/#verify-email=/);
 const row=(await f.store.query('SELECT * FROM relay_account_mail WHERE customer_id=$1',[u.account.id])).rows[0];assert.equal(row.token_hash,digest(t));assert.ok(!JSON.stringify(row).includes(t));
 await assert.rejects(s.a.verifyEmail({linkToken:t},v.token),e=>e.status===403);
 await assert.rejects(s.a.resetPassword({linkToken:t,password:nextPassword}),/invalid or has expired/);
 await f.store.migrate();assert.equal((await s.a.verifyEmail({linkToken:t},u.token)).account.emailVerified,true);assert.equal((await s.a.session(u.token)).account.emailVerified,true);
 await assert.rejects(s.a.verifyEmail({linkToken:t},u.token),/invalid or has expired/);
 }finally{await f.close();}
});
test('reset requests conceal account eligibility; reset rotates credentials and revokes sessions while retaining wallets',async()=>{
 const f=await fixture();try{const s=setup(f.store),u=await verified(s),other=await s.a.signup(signup('unverified@example.test'));
 const second=await s.a.login({email:u.account.email,password});const owner=(await s.a.session(u.token)).owner;await f.store.addAgent(owner,{id:randomUUID(),name:'Kept agent',address:'0x1111111111111111111111111111111111111111'});
 const known=await s.a.requestReset({email:u.account.email}),missing=await s.a.requestReset({email:'missing@example.test'}),unverified=await s.a.requestReset({email:other.account.email});assert.deepEqual(known,missing);assert.deepEqual(known,unverified);assert.equal(s.sent.length,1);
 await s.mail.tick();const reset=s.sent.find(x=>x.subject==='Reset your Eupova password');assert.equal(reset.to,u.account.email);const t=token(reset);
 const result=await s.a.resetPassword({linkToken:t,password:nextPassword});assert.ok(result.recovered);assert.notEqual(result.recoveryCode,u.recoveryCode);assert.equal(await s.a.session(u.token),null);assert.equal(await s.a.session(second.token),null);
 await assert.rejects(s.a.resetPassword({linkToken:t,password:nextPassword}),/invalid or has expired/);await assert.rejects(s.a.recover({email:u.account.email,recoveryCode:u.recoveryCode,password}),/not recognised/);await assert.rejects(s.a.login({email:u.account.email,password}),/not recognised/);
 const login=await s.a.login({email:u.account.email,password:nextPassword});assert.equal((await f.store.state((await s.a.session(login.token)).owner)).agents.length,1);await s.mail.tick();assert.ok(s.sent.some(x=>x.subject==='Your Eupova password has changed'));
 }finally{await f.close();}
});
test('expired, replaced, disabled and version-stale links cannot change an account',async()=>{
 const f=await fixture();try{const s=setup(f.store),u=await s.a.signup(signup('alice@example.test'));await s.mail.tick();const first=token(s.sent[0]);
 await f.store.query("UPDATE relay_account_mail SET created_at=now()-interval '2 minutes'");await s.a.requestVerification({},u.token);await s.mail.tick();const second=token(s.sent.at(-1));await assert.rejects(s.a.verifyEmail({linkToken:first},u.token),/invalid or has expired/);
 await f.store.query("UPDATE relay_account_mail SET expires_at=now()-interval '1 second'");await assert.rejects(s.a.verifyEmail({linkToken:second},u.token),/invalid or has expired/);
 await f.store.query("UPDATE relay_account_mail SET created_at=now()-interval '2 minutes'");await s.a.requestVerification({},u.token);await s.mail.tick();const third=token(s.sent.at(-1));const changed=await s.a.password({currentPassword:password,password:nextPassword},u.token);await assert.rejects(s.a.verifyEmail({linkToken:third},changed.token),/invalid or has expired/);
 await f.store.query('UPDATE relay_customers SET disabled=true');await assert.rejects(s.a.verifyEmail({linkToken:third},changed.token),e=>e.status===401);
 }finally{await f.close();}
});
test('disabled mail makes no calls, a failed send is deferred rather than lost, and duplicate queue requests collapse',async()=>{
 const f=await fixture();try{let calls=0;const disabled=configuredAccountMail(f.store,{}, {fetchImpl:()=>{calls++;throw Error('network');}}),a=createAccounts(f.store,{mail:disabled}),u=await a.signup(signup('disabled@example.test'));
 await disabled.tick();assert.equal(calls,0);assert.equal((await f.store.query('SELECT * FROM relay_account_mail')).rows.length,0);await assert.rejects(a.requestReset({email:u.account.email}),e=>e.status===503);
 const s=setup(f.store,{deliver:async()=>{calls++;throw Error('unknown outcome');}});await s.a.requestVerification({},u.token);await s.a.requestVerification({},u.token);await s.mail.tick();await s.mail.tick();assert.equal(calls,1,'a deferred row is not re-sent while it is backing off');const rows=(await f.store.query('SELECT * FROM relay_account_mail')).rows;assert.equal(rows.length,1);assert.equal(rows[0].state,'queued');assert.equal(rows[0].attempts,1);assert.match(rows[0].last_error,/unknown outcome/);assert.ok(rows[0].token_hash);
 }finally{await f.close();}
});
test('concurrent workers send once; simultaneous reset consumes once on PostgreSQL',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const s=setup(f.store),u=await verified(s);await s.a.requestReset({email:u.account.email});const other=createAccountMail(f.store,{enabled:true,origin:'https://relay.example',deliver:async m=>{s.sent.push(m);return {id:'second-'+m.id};}});await Promise.all([s.mail.tick(),other.tick()]);const resets=s.sent.filter(x=>x.subject==='Reset your Eupova password');assert.equal(resets.length,1);const input={linkToken:token(resets[0]),password:nextPassword};const outcomes=await Promise.allSettled([s.a.resetPassword(input),s.a.resetPassword(input)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.find(x=>x.status==='rejected').reason.status,400);
 }finally{await f.close();}
});
test('optional transport requires explicit configuration and uses a fixed endpoint with idempotency',async()=>{
 const f=await fixture();try{assert.throws(()=>configuredAccountMail(f.store,{ACCOUNT_EMAIL_ENABLED:'true'}),/incomplete/);const env={ACCOUNT_EMAIL_ENABLED:'true',PUBLIC_ORIGIN:'https://relay.example',ACCOUNT_EMAIL_FROM:'Eupova <account@example.test>',RESEND_API_KEY:'synthetic-test-key'};assert.throws(()=>configuredAccountMail(f.store,{...env,PUBLIC_ORIGIN:'https://relay.example/path'}),/origin/);
 const calls=[];const mail=configuredAccountMail(f.store,env,{fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'accepted-test'})};}});const a=createAccounts(f.store,{mail});await a.signup(signup('transport@example.test'));assert.equal(calls.length,0);await mail.tick();assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.resend.com/emails');assert.equal(calls[0].options.redirect,'error');assert.ok(calls[0].options.headers['Idempotency-Key']);assert.equal(JSON.parse(calls[0].options.body).from,env.ACCOUNT_EMAIL_FROM);
 assert.throws(()=>createHostedServer({store:f.store,config:{origin:'https://relay.example',testers:[]},paymentsDisabled:true,accountMail:createAccountMail(f.store,{enabled:true,origin:'http://127.0.0.1:4323',preview:true,deliver:async()=>({id:'local'})})}),/local only/);
 }finally{await f.close();}
});

test('public email HTTP routes keep tokens private, preserve sign-in on verification and reject previews, GET and cross-site changes',async()=>{
 const f=await fixture();let server;try{
 const http=await import('node:http'),s=setup(f.store);server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true,accountMail:s.mail});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(path,data,cookie,origin='https://relay.example')=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:data?'POST':'GET',headers:{host:'relay.example',origin,'content-type':'application/json',...(cookie?{cookie}:{})}},r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(body),cookie:r.headers['set-cookie']?.[0].split(';')[0]}));});q.on('error',reject);q.end(data?JSON.stringify(data):undefined);});
 const u=await request('/api/account/signup',signup('httpmail@example.test'));assert.equal(u.data.token,undefined);assert.equal(u.data.emailSendingEnabled,true);await s.mail.tick();const t=token(s.sent[0]);assert.ok(!JSON.stringify(u).includes(t));
 assert.equal((await request('/api/account/verifyEmail')).status,404);assert.equal((await request('/api/account/emailPreview',{},u.cookie)).status,404);assert.equal((await request('/api/account/verifyEmail',{linkToken:t},u.cookie,'https://evil.example')).status,403);
 const verified=await request('/api/account/verifyEmail',{linkToken:t},u.cookie);assert.equal(verified.status,200);assert.equal(verified.cookie,undefined);assert.equal((await request('/api/access',null,u.cookie)).data.account.emailVerified,true);
 assert.equal((await request('/api/checkouts',{},u.cookie)).status,403);assert.equal((await request('/api/webhooks/peer/sandbox',{})).status,403);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});


test('existing sender settings remain compatible after rebranding without changing the mailbox',async()=>{
 const f=await fixture();try{
  const calls=[];const env={ACCOUNT_EMAIL_ENABLED:'true',PUBLIC_ORIGIN:'https://relay.example',ACCOUNT_EMAIL_FROM:'Relay <account@example.test>',RESEND_API_KEY:'synthetic-test-key'};
  const mail=configuredAccountMail(f.store,env,{fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:'local-test'})};}});
  await createAccounts(f.store,{mail}).signup(signup('legacy-sender@example.test'));await mail.tick();
  assert.equal(calls.length,1);assert.equal(calls[0].from,'Eupova <account@example.test>');assert.equal(env.ACCOUNT_EMAIL_FROM,'Relay <account@example.test>');
  assert.throws(()=>configuredAccountMail(f.store,{...env,ACCOUNT_EMAIL_FROM:'Eupova <account@example.test>\r\nBcc: stolen@example.test'}),/incomplete/);
 }finally{await f.close();}
});

test('a rejected send is retried a bounded number of times, keeps the provider reason, then stops',async()=>{
 const f=await fixture();try{
  const seen=[];let calls=0;
  const mail=createAccountMail(f.store,{enabled:true,origin:'https://relay.example',deliver:async m=>{calls++;seen.push(m);throw Error('Email acceptance not confirmed: HTTP 403 {"message":"The eupova.com domain is not verified"}');}});
  const a=createAccounts(f.store,{mail});
  const u=await a.signup(signup('retry@example.test'));
  const row=async()=>(await f.store.query('SELECT * FROM relay_account_mail WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1',[u.account.id])).rows[0];
  await mail.tick();                                   // attempt 1 fails and is deferred, not abandoned
  let r=await row();assert.equal(calls,1);assert.equal(r.state,'queued');assert.equal(r.attempts,1);assert.match(r.last_error,/HTTP 403/);assert.ok(r.next_attempt_at);
  await mail.tick();                                   // still backing off: no second call
  assert.equal(calls,1);
  await f.store.query("UPDATE relay_account_mail SET next_attempt_at=now()-interval '1 second'");
  await mail.tick();r=await row();assert.equal(calls,2);assert.equal(r.attempts,2);assert.equal(r.state,'queued');
  await f.store.query("UPDATE relay_account_mail SET next_attempt_at=now()-interval '1 second'");
  await mail.tick();r=await row();assert.equal(calls,3);assert.equal(r.attempts,3);assert.equal(r.state,'unknown');assert.match(r.last_error,/not verified/);
  await f.store.query("UPDATE relay_account_mail SET next_attempt_at=now()-interval '1 second'");
  await mail.tick();assert.equal(calls,3,'an abandoned send is never retried again');
  // a later request still works and clears the failure record
  await f.store.query("UPDATE relay_account_mail SET created_at=now()-interval '2 minutes'");
  const ok=createAccountMail(f.store,{enabled:true,origin:'https://relay.example',deliver:async m=>({id:'accepted-'+m.id})});
  const a2=createAccounts(f.store,{mail:ok});await a2.requestVerification({},u.token);await ok.tick();
  const after=(await f.store.query("SELECT * FROM relay_account_mail WHERE customer_id=$1 AND state='accepted' ORDER BY created_at DESC LIMIT 1",[u.account.id])).rows[0];
  assert.ok(after);assert.equal(after.last_error,null);assert.equal(after.attempts,1);
 }finally{await f.close();}
});
