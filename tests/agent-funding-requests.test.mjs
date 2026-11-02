import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createAgentFundingRequests} from '../hosted/agent-funding-requests.mjs';
import {targetRaw,targetUnits,requestState,compareTarget} from '../shared/funding-request.mjs';
import {createHostedServer} from '../hosted/server.mjs';
async function setup(){
 const f=await fixture(),drafts=createFundingDrafts(f.store);await drafts.migrate();let now=Date.now();
 const accounts=createAccounts(f.store),account=await accounts.signup({email:'request@example.test',name:'Sample user',password:'sample request password river lantern',acceptSandbox:true});
 const owner=(await accounts.session(account.token)).owner,agent={id:randomUUID(),name:'Research assistant',address:'0x'+'1'.repeat(40),network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);
 return {...f,drafts,account,owner,agent,requests:createAgentFundingRequests(f.store,{clock:()=>now}),advance:ms=>now+=ms};
}
const input=f=>({requestKey:randomUUID(),agentId:f.agent.id,purpose:'Research for the week',targetUsdc:'25.000001',expiresInHours:24,confirmDestination:true});
const draft=(f,r,extra={})=>({requestId:randomUUID(),agentId:f.agent.id,amount:'25',rail:'revolut',currency:'GBP',confirm:true,fundingRequestId:r.id,...extra});

test('target precision and bounded inputs; request expiry and wallet revision',()=>{
 assert.equal(targetRaw('25.000001'),'25000001');assert.equal(targetUnits('25000001'),'25.000001');assert.equal(targetUnits('10000000'),'10');assert.equal(targetUnits('0'),'0');
 for(const v of ['0','-1','1e3',' 1','1.0000001','100000.000001',null,1])assert.equal(targetRaw(v),null);
 assert.deepEqual(compareTarget('25000001','25000000'),{met:false,differenceRaw:'-1',shortfall:'0.000001'});
 const a={id:'1',address:'0xabc',network:'Base',token:'USDC',revision:1},r={agent:a,walletRevision:'1',expiresAt:new Date(2000).toISOString()};
 assert.equal(requestState(r,a,1000),'open');assert.equal(requestState(r,a,2000),'expired');assert.equal(requestState(r,{...a,revision:2},1000),'wallet_changed');assert.equal(requestState({...r,draftId:'draft'},a,3000),'linked');
});
test('owner-bound immutable requests, exact idempotency and no payment creation',async()=>{const f=await setup();try{
 const b=input(f),created=await f.requests.create(f.owner,b);assert.equal((await f.requests.create(f.owner,{...b,targetUsdc:'025.000001'})).id,created.id);
 await assert.rejects(f.requests.create(f.owner,{...b,targetUsdc:'30'}),/different/);
 await assert.rejects(f.requests.create(f.owner,{...b,address:'0x'+'2'.repeat(40)}),/Unsupported/);
 await assert.rejects(f.requests.create(f.owner,{...b,confirmDestination:false}),/confirm/);
 const stranger='customer:'+randomUUID();assert.deepEqual(await f.requests.list(stranger),[]);await assert.rejects(f.requests.cancel(stranger,{id:created.id}),/not found/);await assert.rejects(f.requests.create(stranger,input(f)),/saved/);
 await assert.rejects(f.store.query("UPDATE relay_agent_funding_requests SET target_raw=1 WHERE id=$1",[created.id]),/Immutable/);
 assert.equal((await f.drafts.list(f.owner)).length,0);assert.equal((await f.store.state(f.owner)).orders.length,0);
 await f.drafts.migrate();assert.equal((await f.requests.list(f.owner)).length,1);
 }finally{await f.close();}});
test('cancel, expiry and changed-wallet checks cannot be bypassed by submitting a draft',async()=>{const f=await setup();try{
 const cancelled=await f.requests.create(f.owner,input(f));await f.requests.cancel(f.owner,{id:cancelled.id});await f.requests.cancel(f.owner,{id:cancelled.id});await assert.rejects(f.drafts.prepare(f.owner,draft(f,cancelled)),/expired or was cancelled/);
 const expired=await f.requests.create(f.owner,{...input(f),expiresInHours:1});const later=createFundingDrafts(f.store,{clock:()=>Date.now()+3601000});await assert.rejects(later.prepare(f.owner,draft(f,expired)),/expired/);
 const changed=await f.requests.create(f.owner,input(f));await f.store.query("UPDATE relay_agents SET data=jsonb_set(data,'{address}','\"0x2222222222222222222222222222222222222222\"') WHERE id=$1",[f.agent.id]);await assert.rejects(f.drafts.prepare(f.owner,draft(f,changed)),/destination changed/);
 assert.equal((await f.drafts.list(f.owner)).length,0);
 const list=await f.requests.list(f.owner);assert.equal(list.find(r=>r.id===changed.id).walletCurrent,false);
 const fresh=await f.requests.create(f.owner,input(f)),current=(await f.store.state(f.owner)).agents[0];assert.equal(requestState(fresh,current),'open');assert.equal(requestState((await f.requests.list(f.owner)).find(r=>r.id===fresh.id),current),'open');
 }finally{await f.close();}});
test('request and draft link atomically, replay once and retain expiry at checkout boundary',async()=>{const f=await setup();try{
 const request=await f.requests.create(f.owner,{...input(f),expiresInHours:1}),b=draft(f,request),[a,duplicate]=await Promise.all([f.drafts.prepare(f.owner,b),f.drafts.prepare(f.owner,b)]);assert.equal(a.id,duplicate.id);
 assert.equal((await f.requests.list(f.owner))[0].draftId,a.id);assert.equal((await f.drafts.list(f.owner)).length,1);
 await assert.rejects(f.requests.cancel(f.owner,{id:request.id}),/already been prepared/);
 const noLink={...b};delete noLink.fundingRequestId;await assert.rejects(f.drafts.prepare(f.owner,noLink),/another funding request/);
 await assert.rejects(f.drafts.prepare(f.owner,draft(f,request)),/already has/);
 const late=createFundingDrafts(f.store,{clock:()=>Date.now()+3601000});let called=false;await assert.rejects(late.claim(f.owner,a.id,'merchant',{guard:()=>{called=true;}}),/expired/);assert.equal(called,false);assert.equal((await f.drafts.list(f.owner))[0].status,'draft');
 }finally{await f.close();}});
test('HTTP routes require authenticated customer and same-origin requests',async()=>{const f=await setup();let server;try{
 const config={origin:'https://relay.example',host:'relay.example',testers:[]};server=createHostedServer({store:f.store,config,paymentsDisabled:true,allowHttpForTests:true,fundingDrafts:f.drafts});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 const post=(path,body,headers={})=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{host:'relay.example',origin:'https://relay.example','content-type':'application/json',...headers}},res=>{let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(data)}));});q.on('error',reject);q.end(JSON.stringify(body));});
 assert.equal((await post('/api/agent-funding-requests/create',input(f))).status,401);
 const cookie='__Host-relay_sandbox='+f.account.token;
 assert.equal((await post('/api/agent-funding-requests/create',input(f),{cookie,origin:'https://evil.example'})).status,403);
 const response=await post('/api/agent-funding-requests/create',input(f),{cookie});assert.equal(response.status,200);const state=await response.json();assert.equal(state.agentFundingRequests.length,1);assert.equal(state.paymentsDisabled,true);assert.equal(state.orders.length,0);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await f.close();}});
