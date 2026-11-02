import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createAccountSecurity} from '../hosted/account-security.mjs';
import {createAgentConnections} from '../hosted/agent-connections.mjs';
import {createAgentFundingRequests} from '../hosted/agent-funding-requests.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createHostedServer} from '../hosted/server.mjs';
const password='sample only meadow river lantern';
async function setup(){const f=await fixture(),drafts=createFundingDrafts(f.store);await drafts.migrate();const accounts=createAccounts(f.store),account=await accounts.signup({email:'agent@example.test',name:'Test customer',password,acceptSandbox:true}),session=await accounts.session(account.token),owner=session.owner,agent={id:randomUUID(),name:'Research assistant',address:'0x'+'1'.repeat(40),network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);const security=createAccountSecurity(f.store,accounts);let now=Date.now();return {...f,drafts,accounts,account,owner,agent,connections:createAgentConnections(f.store,security,{clock:()=>now}),requests:createAgentFundingRequests(f.store),advance:ms=>now+=ms};}
const settings=f=>({agentId:f.agent.id,name:'Research agent',maxTargetUsdc:'25',dailyLimit:2,expiresInDays:7,confirm:true,currentPassword:password});
const request={purpose:'Weekly industry research',targetUsdc:'20.000001',expiresInHours:24};
const draft=(f,r)=>({requestId:randomUUID(),agentId:f.agent.id,amount:'25',rail:'revolut',currency:'GBP',confirm:true,fundingRequestId:r.id});
test('keys require current password, reveal only once and cannot choose another customer wallet',async()=>{const f=await setup();try{
 await assert.rejects(f.connections.create({...settings(f),currentPassword:'wrong'},f.account.token),/password/);
 await assert.rejects(f.connections.create({...settings(f),agentId:randomUUID()},f.account.token),/saved/);
 const k=await f.connections.create(settings(f),f.account.token);assert.match(k.key,/^eupova_agent_/);
 const list=await f.connections.list(f.owner);assert.equal(list.length,1);assert.equal(list[0].active,true);assert.ok(!JSON.stringify(list).includes(k.key));assert.ok(!JSON.stringify(list).includes('secret_hash'));
 const stored=(await f.store.query('SELECT secret_hash FROM relay_agent_connections WHERE id=$1',[k.id])).rows[0];assert.equal(stored.secret_hash.length,64);assert.notEqual(stored.secret_hash,k.key);
 assert.deepEqual(await f.connections.list('customer:'+randomUUID()),[]);
 await f.drafts.migrate();assert.equal((await f.connections.list(f.owner)).length,1);
 }finally{await f.close();}});
test('external requests are idempotent, destination pinned, capped atomically and create no payments',async()=>{const f=await setup();try{
 const k=await f.connections.create(settings(f),f.account.token),key=randomUUID(),[a,b]=await Promise.all([f.connections.submit(k.key,key,request),f.connections.submit(k.key,key,request)]);assert.equal(a.id,b.id);assert.equal(a.targetUsdc,'20.000001');assert.equal(a.reviewUrl,'https://app.eupova.com/#request='+a.id);assert.equal(b.reviewUrl,a.reviewUrl);const mapped=createAgentFundingRequests(f.store,{partnerReturns:{[k.id]:{name:'Approved partner',url:'https://partner.example/funding'}}});assert.deepEqual((await mapped.list(f.owner))[0].partnerReturn,{name:'Approved partner',url:'https://partner.example/funding'});assert.deepEqual(await mapped.list('customer:'+randomUUID()),[]);assert.equal((await f.requests.list(f.owner))[0].partnerReturn,null);
 await assert.rejects(f.connections.submit(k.key,key,{...request,purpose:'Changed purpose'}),/different/);
 await assert.rejects(f.connections.submit(k.key,randomUUID(),{...request,targetUsdc:'25.000001'}),/exceeds/);
 await assert.rejects(f.connections.submit(k.key,randomUUID(),{...request,address:'0x'+'2'.repeat(40)}),/Unsupported/);
 const attempts=await Promise.allSettled([f.connections.submit(k.key,randomUUID(),request),f.connections.submit(k.key,randomUUID(),request)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.match(attempts.find(x=>x.status==='rejected').reason.message,/24 hours/);
 const rows=await f.requests.list(f.owner);assert.equal(rows.length,2);assert.equal(rows[0].source,'agent');assert.equal(rows[0].sourceName,'Research agent');assert.equal(rows[0].agent.address,f.agent.address);assert.equal(rows[0].connectionAvailable,true);
 await assert.rejects(f.store.query('UPDATE relay_agent_funding_requests SET source_name=$2 WHERE id=$1',[a.id,'Someone else']),/Immutable/);
 assert.equal((await f.drafts.list(f.owner)).length,0);assert.equal((await f.store.state(f.owner)).orders.length,0);
 await assert.rejects(f.connections.status(k.key,randomUUID()),/unavailable/);
 const other=await f.connections.create({...settings(f),name:'Another agent'},f.account.token);await assert.rejects(f.connections.status(other.key,a.id),/unavailable/);
 await assert.rejects(f.requests.create(f.owner,{requestKey:key,agentId:f.agent.id,...request,confirmDestination:true}),/different/);
 }finally{await f.close();}});
test('revocation blocks submission, request preparation and checkout while preserving existing records',async()=>{const f=await setup();try{
 const k=await f.connections.create(settings(f),f.account.token),r=await f.connections.submit(k.key,randomUUID(),request),second=await f.connections.submit(k.key,randomUUID(),request),d=await f.drafts.prepare(f.owner,draft(f,r));
 await f.connections.revoke({id:k.id,currentPassword:password},f.account.token);
 await assert.rejects(f.connections.submit(k.key,randomUUID(),request),/unavailable/);await assert.rejects(f.connections.status(k.key,r.id),/unavailable/);
 await assert.rejects(f.drafts.prepare(f.owner,draft(f,second)),/no longer active/);
 let called=false;await assert.rejects(f.drafts.claim(f.owner,d.id,'merchant',{guard:()=>{called=true;}}),/no longer active/);assert.equal(called,false);
 assert.equal((await f.drafts.list(f.owner))[0].status,'draft');assert.equal((await f.requests.list(f.owner)).length,2);assert.equal((await f.requests.list(f.owner))[0].connectionAvailable,false);
 }finally{await f.close();}});
test('expiry, password reset and wallet revision disable credentials',async()=>{const f=await setup();try{
 const k=await f.connections.create({...settings(f),expiresInDays:1},f.account.token);f.advance(86400001);await assert.rejects(f.connections.submit(k.key,randomUUID(),request),/unavailable/);assert.equal((await f.connections.list(f.owner))[0].active,false);
 f.advance(-86400001);await f.store.query('UPDATE relay_agents SET data=jsonb_set(data,\'{address}\',\'"0x2222222222222222222222222222222222222222"\') WHERE id=$1',[f.agent.id]);await assert.rejects(f.connections.submit(k.key,randomUUID(),request),/unavailable/);
 const next=await f.connections.create(settings(f),f.account.token);await f.store.query('UPDATE relay_customers SET version=version+1 WHERE id=$1',[f.owner.slice(9)]);await assert.rejects(f.connections.submit(next.key,randomUUID(),request),/unavailable/);
 }finally{await f.close();}});
test('machine HTTP API is isolated from cookies, browser requests, owner data and payment endpoints',async()=>{const f=await setup();let server;try{
 const k=await f.connections.create(settings(f),f.account.token);server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true,fundingDrafts:f.drafts});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const call=(path,method='POST',payload=request,headers={})=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'relay.example','content-type':'application/json',authorization:'Bearer '+k.key,'idempotency-key':randomUUID(),...headers}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});q.on('error',reject);q.end(method==='POST'?JSON.stringify(payload):undefined);});
 const path='/api/agent/v1/funding-requests';assert.equal((await call(path,'POST',request,{authorization:'Bearer invalid'})).status,401);
 assert.equal((await call(path,'POST',request,{origin:'https://relay.example'})).status,403);assert.equal((await call(path,'POST',request,{cookie:'__Host-relay_sandbox='+f.account.token})).status,403);
 const result=await call(path);assert.equal(result.status,200);assert.equal(result.body.status,'awaiting_review');assert.equal(result.body.reviewUrl,'https://relay.example/#request='+result.body.id);assert.equal((await call(path+'/'+result.body.id,'GET')).status,200);
 assert.equal((await call('/api/state','GET')).status,401);assert.equal((await call('/api/funding/checkout','POST',{id:randomUUID()},{origin:'https://relay.example'})).status,401);
 assert.equal((await call('/api/agent-connections/create','POST',settings(f),{origin:'https://relay.example'})).status,401);
 assert.equal((await f.store.state(f.owner)).orders.length,0);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await f.close();}});
