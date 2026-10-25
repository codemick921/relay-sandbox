import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createTestInvites} from '../hosted/test-invites.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {digest} from '../hosted/db.mjs';
import {config} from '../hosted/config.mjs';
import {fundingEntry} from '../src/funding-entry.mjs';
const signup=(accounts,inviteCode)=>accounts.signup({email:randomUUID()+'@example.test',name:'Friend test',password:'lantern river meadow fixture',acceptSandbox:true,...inviteCode?{inviteCode}:{}});
const issue=(invites,allowLive=false)=>invites.issue('owner',{label:'Friend fixture',allowLive,days:7,confirmRealAccess:allowLive});

test('invitations store hashes only; signup claims once atomically and defaults to simulation',async()=>{
 const f=await fixture();try{const accounts=createAccounts(f.store),i=createTestInvites(f.store),invite=await issue(i,true);const login=await signup(accounts,invite.code);const who='customer:'+login.account.id;
 assert.deepEqual(await i.status(who),{mode:'simulation',allowLive:true,revoked:false,joinedAt:(await i.status(who)).joinedAt});
 assert.ok(!JSON.stringify(await i.list()).includes(invite.code));assert.equal((await f.store.query('SELECT code_hash FROM relay_test_invites')).rows[0].code_hash,digest(invite.code));
 const n=Number((await f.store.query('SELECT count(*) FROM relay_customers')).rows[0].count);await assert.rejects(signup(accounts,invite.code),/invalid, used or expired/);assert.equal(Number((await f.store.query('SELECT count(*) FROM relay_customers')).rows[0].count),n);
 await f.store.migrate();assert.equal((await i.status(who)).mode,'simulation');await assert.rejects(i.withMode(who,'live',()=>assert.fail('provider call')),/Switch to real/);
 await i.mode(who,{mode:'live',confirmRealMoney:true});let calls=0;await i.withMode(who,'live',()=>calls++);assert.equal(calls,1);
 await assert.rejects(i.withMode(who,'simulation',()=>assert.fail()),/Switch to simulation/);
 await i.mode(who,{mode:'simulation'});await assert.rejects(i.mode(who,{mode:'live'}),/confirmation/);
 }finally{await f.close();}
});

test('concurrent claims have one winner; expired/revoked codes and privilege changes are rejected',async()=>{
 const f=await fixture();try{const a=createAccounts(f.store),i=createTestInvites(f.store),x=await signup(a),y=await signup(a),owners=[x,y].map(x=>'customer:'+x.account.id),v=await issue(i);
 const claims=await Promise.allSettled(owners.map(o=>i.claim(o,{code:v.code})));assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
 const who=owners[claims.findIndex(r=>r.status==='fulfilled')];await assert.rejects(i.mode(who,{mode:'live',confirmRealMoney:true}),/permission/);
 const other=owners.find(o=>o!==who),expired=await issue(i);await f.store.query("UPDATE relay_test_invites SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);await assert.rejects(i.claim(other,{code:expired.code}),/invalid/);
 const revoked=await issue(i,true);await i.revoke('owner',{id:revoked.id});await assert.rejects(i.claim(other,{code:revoked.code}),/invalid/);
 await assert.rejects(i.claim(other,{code:'anything',allowLive:true}),/Invalid/);await assert.rejects(i.issue('owner',{label:'Friend',allowLive:true,days:7}),/Confirm/);
 await i.revoke('owner',{id:v.id});assert.equal((await i.status(who)).revoked,true);await assert.rejects(i.withMode(who,'simulation',()=>assert.fail()),/revoked/);await assert.rejects(i.mode(who,{mode:'simulation'}),/unavailable/);
 assert.ok(await a.session((who===owners[0]?x:y).token));
 }finally{await f.close();}
});

test('revocation blocks subsequent actions while an already-admitted action can finish',async()=>{
 const f=await fixture();try{const a=createAccounts(f.store),i=createTestInvites(f.store),v=await issue(i,true),u=await signup(a,v.code),who='customer:'+u.account.id;await i.mode(who,{mode:'live',confirmRealMoney:true});
 let release,entered;const inside=new Promise(r=>entered=r),hold=new Promise(r=>release=r);const active=i.withMode(who,'live',async()=>{entered();await hold;return 'complete';});await inside;
 await i.revoke('owner',{id:v.id});release();assert.equal(await active,'complete');await assert.rejects(i.withMode(who,'live',()=>assert.fail()),/revoked/);
 }finally{await f.close();}
});

async function httpFixture({live=true}={}){
 const f=await fixture(),accounts=createAccounts(f.store),invites=createTestInvites(f.store),drafts=createFundingDrafts(f.store);await drafts.migrate();
 const user=await signup(accounts),owner='customer:'+user.account.id,token='a'.repeat(64),healthToken='b'.repeat(64);const testers=[{label:'owner',sha256hex:digest('fixture-owner')},{label:'health',sha256hex:digest('fixture-health')}];await f.store.login(token,testers[0]);await f.store.login(healthToken,testers[1]);
 const calls={live:0,simulation:0};const funding={start:async()=>{calls.live++;return {id:randomUUID()};},checkout:async()=>{calls.live++;return {};}};
 const tracker={state:async()=>({orders:[]}),health:async()=>({healthy:true})};
 const server=createHostedServer({store:f.store,config:{origin:'https://eupova.example',host:'eupova.example',testers,testInviteAdmins:['owner'],paymentHealthAdmins:['health']},paymentsDisabled:true,allowHttpForTests:true,fundingDrafts:drafts,
 tracking:{simulated:true,store:tracker,journey:{simulated:true,quote:async()=>{calls.simulation++;return {quote:{simulated:true}};},decorate:async(_,orders)=>orders}},
 liveObservation:live?{simulated:false,store:tracker,status:async()=>({}),policy:{status:async()=>({})},funding}:null});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const req=(path,{auth=user.token,data,origin='https://eupova.example',method=data?'POST':'GET'}={})=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'eupova.example',origin,'content-type':'application/json',cookie:'__Host-relay_sandbox='+auth}},r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(body)}));});q.on('error',reject);q.end(data?JSON.stringify(data):undefined);});
 return {...f,req,accounts,invites,user,owner,token,healthToken,calls,done:async()=>{await new Promise(r=>server.close(r));await f.close();}};
}

test('HTTP keeps admin access separate and denies direct live routes to simulation-only or revoked friends',async()=>{
 const f=await httpFixture();try{
 for(const auth of ['',f.user.token,f.healthToken])assert.equal((await f.req('/api/operator/test-invites',{auth})).status,auth?403:401);
 assert.equal((await f.req('/api/operator/test-invites/create',{auth:f.token,origin:'https://evil.test',data:{}})).status,403);
 const invite=await f.req('/api/operator/test-invites/create',{auth:f.token,data:{label:'Friend 1',allowLive:false,days:7}});assert.equal(invite.status,200);assert.ok(invite.body.code);
 assert.equal((await f.req('/api/test-access/claim',{data:{code:invite.body.code}})).status,200);
 const state=(await f.req('/api/state')).body;assert.equal(state.testAccess.mode,'simulation');assert.equal(state.liveFunding.paymentsEnabled,false);assert.equal(state.paymentsDisabled,true);assert.equal(state.adminTestInvites,false);
 for(const path of ['/api/funding/checkout','/api/funding/resume'])assert.equal((await f.req(path,{data:{id:randomUUID(),confirm:true,consent:true}})).status,path.endsWith('resume')?400:403);
 assert.equal((await f.req('/api/funding/resume',{data:{id:randomUUID(),confirm:true}})).status,403);
 assert.equal((await f.req('/api/test-access/mode',{data:{mode:'live',confirmRealMoney:true}})).status,403);assert.equal(f.calls.live,0);
 assert.equal((await f.req('/api/test-funding/quote',{data:{}})).status,200);assert.equal(f.calls.simulation,1);
 await f.req('/api/operator/test-invites/revoke',{auth:f.token,data:{id:invite.body.id}});
 assert.equal((await f.req('/api/test-funding/quote',{data:{}})).status,403);assert.equal((await f.req('/api/state')).status,200);assert.equal((await f.req('/api/state')).body.testAccess.revoked,true);
 const listing=(await f.req('/api/operator/test-invites',{auth:f.token})).body;assert.ok(!JSON.stringify(listing).includes(invite.body.code));assert.ok(!JSON.stringify(listing).includes(f.user.account.email));
 assert.equal((await f.req('/healthz')).body.realPaymentsEnabled,true);
 }finally{await f.done();}
});

test('real-eligible friends must switch explicitly and global live-disable still wins; normal customers retain existing state',async()=>{
 const f=await httpFixture();try{assert.equal((await f.req('/api/state')).body.liveFunding.paymentsEnabled,true);const v=await issue(f.invites,true);await f.invites.claim(f.owner,{code:v.code});
 assert.equal((await f.req('/api/funding/checkout',{data:{id:randomUUID(),confirm:true,consent:true}})).status,403);
 assert.equal((await f.req('/api/test-access/mode',{data:{mode:'live'}})).status,403);
 assert.equal((await f.req('/api/test-access/mode',{data:{mode:'live',confirmRealMoney:true}})).status,200);
 assert.equal((await f.req('/api/funding/checkout',{data:{id:randomUUID(),confirm:true,consent:true}})).status,200);assert.equal(f.calls.live,1);
 assert.equal((await f.req('/api/test-funding/quote',{data:{}})).status,403);
 assert.equal((await f.req('/api/test-access/mode',{data:{mode:'simulation'}})).status,200);
 assert.equal((await f.req('/api/funding/checkout',{data:{id:randomUUID(),confirm:true,consent:true}})).status,403);
 }finally{await f.done();}
 const g=await httpFixture({live:false});try{const v=await issue(g.invites,true);await g.invites.claim(g.owner,{code:v.code});assert.equal((await g.req('/api/test-access/mode',{data:{mode:'live',confirmRealMoney:true}})).status,403);assert.equal((await g.invites.status(g.owner)).mode,'simulation');assert.equal(g.calls.live,0);}finally{await g.done();}
});

test('invitation admin configuration is opt-in and UI entry cannot choose real funding while in simulation',()=>{
 const env={RELAY_MODE:'sandbox',PUBLIC_ORIGIN:'https://eupova.example',DATABASE_URL:'fixture',SANDBOX_TESTERS:JSON.stringify([{label:'owner',sha256hex:'a'.repeat(64)}])};assert.deepEqual(config(env).testInviteAdmins,[]);assert.deepEqual(config({...env,RELAY_TEST_INVITE_ADMINS:'["owner"]'}).testInviteAdmins,['owner']);assert.throws(()=>config({...env,RELAY_TEST_INVITE_ADMINS:'["customer:abc"]'}));
 const state={account:{id:'fixture'},agents:[{id:'wallet'}],fundingJourneyEnabled:true,liveFunding:{paymentsEnabled:true},testAccess:{mode:'simulation'}};assert.equal(fundingEntry(state).label,'Try test funding');assert.equal(fundingEntry(state).kind,'peer-fund');assert.equal(fundingEntry({...state,testAccess:{revoked:true}}).disabled,true);
});
