import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createAccountMail} from '../hosted/account-mail.mjs';
import {createAccountSecurity} from '../hosted/account-security.mjs';
import {emailVerificationState} from '../hosted/email-verification.mjs';
const password='correct horse meadow lantern';
const signup=email=>({email,password,name:'Verification tester',acceptSandbox:true});
const token=m=>m.text.match(/#verify-email=([a-f0-9]{64})/)[1];

test('verification projection distinguishes acceptance, expired links, stalled sends and real verification',()=>{
 const now=Date.parse('2026-10-25T12:00:00Z'),job={created_at:new Date(now-10000),attempted_at:new Date(now-5000),expires_at:new Date(now+3500000),state:'accepted',token_hash:'private',provider_id:'private-provider',email:'private@example.test'};
 const state=overrides=>emailVerificationState({mailEnabled:true,job,now,...overrides});
 assert.equal(state().status,'accepted');assert.equal(state().verified,false);
 assert.equal(state({job:{...job,state:'sending'}}).status,'sending');
 assert.equal(state({job:{...job,state:'sending',attempted_at:new Date(now-60000)}}).status,'unknown');
 assert.equal(state({job:{...job,state:'queued',created_at:new Date(now-3600000),expires_at:null}}).status,'expired');
 assert.equal(state({job:{...job,expires_at:new Date(now)}}).status,'expired');
 assert.equal(state({job:{...job,consumed_at:new Date(now)}}).status,'superseded');
 assert.equal(state({job:{...job,state:'new-unrecognised-state'}}).status,'unknown');
 assert.equal(state({mailEnabled:false}).status,'unavailable');
 assert.equal(state({job:null}).status,'not_requested');
 assert.equal(state({verifiedAt:new Date(now)}).status,'verified');
 assert.equal(state({verifiedAt:new Date(now),mailEnabled:false}).mode,'unavailable');
 assert.equal(state({verifiedAt:new Date(now),mailPreview:true}).mode,'preview');
 assert.ok(!JSON.stringify(state()).includes('private'));assert.ok(!JSON.stringify(state()).includes('token_hash'));
});

test('security status is owned, current-version and verification-only; acceptance cannot verify an email',async()=>{
 const f=await fixture();try{
  const sent=[],mail=createAccountMail(f.store,{enabled:true,origin:'https://relay.example',deliver:async m=>{sent.push(m);return {id:'private-provider-id'};}}),a=createAccounts(f.store,{mail}),security=createAccountSecurity(f.store,a,{mailEnabled:true});
  const alice=await a.signup(signup('alice@example.test')),bob=await a.signup(signup('bob@example.test'));
  assert.equal((await security.security({},alice.token)).emailVerification.status,'queued');await mail.tick();
  const state=await security.security({},alice.token);assert.equal(state.emailVerification.status,'accepted');assert.equal(state.emailRecoveryAvailable,false);assert.equal(state.emailVerification.verified,false);
  assert.ok(!JSON.stringify(state).includes('private-provider-id'));assert.ok(!JSON.stringify(state).includes(token(sent.find(m=>m.to===alice.account.email))));
  await f.store.query("UPDATE relay_account_mail SET state='unknown' WHERE customer_id=$1",[bob.account.id]);
  assert.equal((await security.security({},alice.token)).emailVerification.status,'accepted');assert.equal((await security.security({},bob.token)).emailVerification.status,'unknown');
  const verified=await a.verifyEmail({linkToken:token(sent.find(m=>m.to===alice.account.email))},alice.token);
  assert.equal(verified.account.emailVerified,true);const after=await security.security({},alice.token);assert.equal(after.emailVerification.status,'verified');assert.ok(after.emailVerification.verifiedAt);assert.equal(after.emailRecoveryAvailable,true);
  await a.requestReset({email:alice.account.email});assert.equal((await security.security({},alice.token)).emailVerification.status,'verified');
  const changed=await a.password({currentPassword:password,password:'another long password phrase'},bob.token);
  assert.equal((await security.security({},changed.token)).emailVerification.status,'not_requested');
  await assert.rejects(security.security({},bob.token),e=>e.status===401);
 }finally{await f.close();}
});

test('disabled and preview mail never claim that real email recovery is ready',async()=>{
 const f=await fixture();try{
  const a=createAccounts(f.store),u=await a.signup(signup('preview@example.test'));
  const disabled=createAccountSecurity(f.store,a);assert.equal((await disabled.security({},u.token)).emailVerification.status,'unavailable');
  const mail=createAccountMail(f.store,{enabled:true,preview:true,origin:'http://127.0.0.1:4330',deliver:async()=>({id:'preview'})}),previewAccounts=createAccounts(f.store,{mail});
  await previewAccounts.requestVerification({},u.token);await mail.tick();await previewAccounts.verifyEmail({linkToken:token(mail.previewFor(u.account.id)[0])},u.token);
  const preview=await createAccountSecurity(f.store,previewAccounts,{mailEnabled:true,mailPreview:true}).security({},u.token);
  assert.equal(preview.emailVerification.mode,'preview');assert.equal(preview.emailVerification.status,'verified');assert.equal(preview.emailRecoveryAvailable,false);
  const unavailable=await disabled.security({},u.token);assert.equal(unavailable.emailVerification.mode,'unavailable');assert.equal(unavailable.emailVerification.verified,true);assert.equal(unavailable.emailRecoveryAvailable,false);
 }finally{await f.close();}
});

test('simultaneous verification consumes a link once on PostgreSQL',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const sent=[],mail=createAccountMail(f.store,{enabled:true,origin:'https://relay.example',deliver:async m=>{sent.push(m);return {id:'synthetic'};}}),a=createAccounts(f.store,{mail}),u=await a.signup(signup('race@example.test'));await mail.tick();
  const input={linkToken:token(sent[0])};const results=await Promise.allSettled([a.verifyEmail(input,u.token),a.verifyEmail(input,u.token)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,400);assert.equal((await a.session(u.token)).account.emailVerified,true);
 }finally{await f.close();}
});
