import http from 'node:http';
import {createHostedServer} from '../hosted/server.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createAccountSecurity} from '../hosted/account-security.mjs';
import {createAgentConnections} from '../hosted/agent-connections.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createAgentCallbacks,snapshotDigest} from '../hosted/agent-callbacks.mjs';
import {callbackUrl,publicIpv4,callbackSignature,verifyCallback,deliverCallback} from '../hosted/callback-transport.mjs';
const url='https://agent.example.test/eupova',password='sample only meadow river lantern';
async function setup(){const f=await fixture(),drafts=createFundingDrafts(f.store);await drafts.migrate();const accounts=createAccounts(f.store),a=await accounts.signup({email:'callbacks@example.test',name:'Tester',password,acceptSandbox:true}),owner=(await accounts.session(a.token)).owner,agent={id:randomUUID(),name:'Research',address:'0x'+'1'.repeat(40),network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);let now=Date.now(),fail=false;const sent=[],connections=createAgentConnections(f.store,createAccountSecurity(f.store,accounts),{clock:()=>now});const key=await connections.create({agentId:agent.id,name:'Research agent',maxTargetUsdc:'25',dailyLimit:2,expiresInDays:7,confirm:true,currentPassword:password},a.token),k=await connections.authenticateCallback(key.key),r=await connections.submit(key.key,randomUUID(),{purpose:'Sample research',targetUsdc:'20',expiresInHours:24});const cb=createAgentCallbacks(f.store,{allowed:[url],clock:()=>now,deliver:async(u,event,secret)=>{sent.push({u,event,secret});if(fail)throw Error('timeout');}});await cb.migrate();return {...f,a,owner,agent,k,r,cb,connections,key,sent,advance:ms=>now+=ms,fail:v=>fail=v};}
test('callback destinations are exact approved HTTPS URLs and public IPv4 only',()=>{
 assert.equal(callbackUrl(url,[url]).href,url);
 for(const value of ['http://agent.example.test/eupova','https://user:pass@agent.example.test/eupova','https://agent.example.test/eupova?q=secret','https://127.0.0.1/','https://[::1]/','https://agent.example.test:8443/'])assert.throws(()=>callbackUrl(value,[value]),/approved/);
 assert.throws(()=>callbackUrl(url,[]),/approved/);
 for(const ip of ['127.0.0.1','10.2.3.4','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','198.18.0.1','203.0.113.1','192.0.2.1','0.0.0.0','224.0.0.1','::1','::ffff:8.8.8.8'])assert.equal(publicIpv4(ip),false,ip);
 assert.equal(publicIpv4('8.8.8.8'),true);
});
test('signature authenticates exact bytes and enforces replay age',()=>{const secret='a'.repeat(64),raw='{"test":1}',t='1793640000',header=`t=${t},v1=${callbackSignature(secret,t,raw)}`;assert.equal(verifyCallback(secret,raw,header,Number(t)*1000),true);assert.equal(verifyCallback(secret,raw+' ',header,Number(t)*1000),false);assert.equal(verifyCallback(secret,raw,header,Number(t)*1000+301000),false);assert.equal(verifyCallback(secret,raw,'invalid'),false);});
test('transport blocks DNS rebinding/private addresses, pins public address and rejects redirects',async()=>{
 let calls=0;await assert.rejects(deliverCallback(url,{},'a'.repeat(64),{allowed:[url],resolve:async()=>[{address:'8.8.8.8'},{address:'10.0.0.1'}],request:()=>{calls++;}}),/blocked/);assert.equal(calls,0);
 const request=(_u,options,receive)=>{calls++;assert.equal(options.agent,false);options.lookup('agent.example.test',{},(err,ip,family)=>{assert.equal(ip,'8.8.8.8');assert.equal(family,4);});const req=new EventEmitter();req.end=()=>{receive({statusCode:302,destroy(){}});req.emit('close');};return req;};
 await assert.rejects(deliverCallback(url,{id:'event'},'a'.repeat(64),{allowed:[url],resolve:async()=>[{address:'8.8.8.8'}],request}),/http_302/);assert.equal(calls,1);
});
test('registration is owned, opt-in, pinned and does not alter customer or payment records',async()=>{const f=await setup();try{
 await f.cb.tick();assert.equal(f.sent.length,0);assert.equal((await f.cb.manage(f.k,f.r.id,{},'GET')).callback,null);
 await assert.rejects(f.cb.manage({...f.k,owner:'customer:'+randomUUID()},f.r.id,{url,confirmOwnership:true},'POST'));
 await assert.rejects(f.cb.manage(f.k,f.r.id,{url},'POST'),/Confirm/);
 const a=await f.cb.manage(f.k,f.r.id,{url,confirmOwnership:true},'POST'),b=await f.cb.manage(f.k,f.r.id,{url,confirmOwnership:true},'POST');assert.deepEqual(a,b);
 assert.ok(!JSON.stringify(await f.cb.manage(f.k,f.r.id,{},'GET')).includes(a.signingSecret));
 assert.equal(Number((await f.store.query('SELECT count(*) FROM relay_funding_drafts')).rows[0].count),0);
 await f.cb.tick();assert.equal(f.sent.length,0);await f.cb.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].event.data.progress.paymentConfirmed,false);assert.equal(f.sent[0].event.data.progress.deliveryConfirmed,false);assert.equal(f.sent[0].event.data.requestStatus,'awaiting_review');assert.equal(f.sent[0].secret,a.signingSecret);
 const raw=JSON.stringify(f.sent[0].event);assert.ok(!raw.includes('address'));assert.ok(!raw.includes('purpose'));assert.ok(!raw.includes('owner'));
 f.advance(30000);await f.cb.tick();assert.equal(f.sent.length,1);
 f.advance(86400000);await f.cb.tick();await f.cb.tick();assert.equal(f.sent[1].event.sequence,2);assert.equal(f.sent[1].event.data.requestStatus,'expired');
 }finally{await f.close();}});
test('pending event survives restart and retries retain ID; exhaustion pauses, DELETE stops',async()=>{const f=await setup();try{
 await f.cb.manage(f.k,f.r.id,{url,confirmOwnership:true},'POST');await f.cb.tick();f.fail(true);
 for(let i=0;i<8;i++){await f.cb.tick();f.advance(3600000);}
 assert.equal(f.sent.length,8);assert.equal(new Set(f.sent.map(x=>x.event.id)).size,1);assert.equal((await f.cb.manage(f.k,f.r.id,{},'GET')).callback.enabled,false);
 f.fail(false);await f.cb.manage(f.k,f.r.id,{url,confirmOwnership:true},'POST');await f.cb.tick();assert.equal(f.sent[8].event.id,f.sent[0].event.id);
 await f.cb.manage(f.k,f.r.id,{},'DELETE');f.advance(86400000);await f.cb.tick();assert.equal(f.sent.length,9);
 }finally{await f.close();}});
test('revocation disables queued delivery without contacting endpoint',async()=>{const f=await setup();try{await f.cb.manage(f.k,f.r.id,{url,confirmOwnership:true},'POST');await f.cb.tick();await f.connections.revoke({id:f.k.id,currentPassword:password},f.a.token);await f.cb.tick();assert.equal(f.sent.length,0);assert.equal((await f.store.query('SELECT last_error FROM relay_agent_callbacks')).rows[0].last_error,'connection_inactive');}finally{await f.close();}});
test('routine check timestamps do not create repeat events, evidence changes do',()=>{const a={requestId:'id',requestStatus:'funding_prepared',progress:{state:'payment_confirmed',checkedAt:'a',deliveryConfirmed:false}};assert.equal(snapshotDigest(a),snapshotDigest({...a,progress:{...a.progress,checkedAt:'b'}}));assert.notEqual(snapshotDigest(a),snapshotDigest({...a,progress:{...a.progress,state:'funds_arrived',deliveryConfirmed:true}}));});

test('HTTP callback API authenticates, isolates browser access and is disabled without approval',async()=>{const f=await setup();let server;try{
 const callbacks=createAgentCallbacks(f.store),drafts=createFundingDrafts(f.store);server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},paymentsDisabled:true,allowHttpForTests:true,fundingDrafts:drafts,agentCallbacks:callbacks});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=(method,headers={},payload={url,confirmOwnership:true})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:`/api/agent/v1/funding-requests/${f.r.id}/callback`,method,headers:{host:'relay.example',authorization:'Bearer '+f.key.key,'content-type':'application/json',...headers}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(method==='POST'?JSON.stringify(payload):undefined);});
 assert.equal((await call('GET',{authorization:'Bearer invalid'})).status,401);assert.equal((await call('GET',{origin:'https://relay.example'})).status,403);assert.equal((await call('GET',{cookie:'session=sample'})).status,403);
 const state=await call('GET');assert.equal(state.status,200);assert.equal(state.body.registrationAvailable,false);assert.equal((await call('POST')).status,403);assert.equal(Number((await f.store.query('SELECT count(*) FROM relay_agent_callbacks')).rows[0].count),0);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}});
test('restart preserves pending ID and empty allowlist prevents dispatch',async()=>{const f=await setup();try{
 await f.cb.manage(f.k,f.r.id,{url,confirmOwnership:true},'POST');await f.cb.tick();const pending=(await f.store.query('SELECT pending FROM relay_agent_callbacks')).rows[0].pending;
 const resumed=createAgentCallbacks(f.store,{allowed:[url],deliver:async(u,event)=>{assert.equal(event.id,pending.id);f.sent.push(event);}});await resumed.tick();assert.equal(f.sent.length,1);
 await f.cb.manage(f.k,f.r.id,{url,confirmOwnership:true},'POST');await createAgentCallbacks(f.store,{deliver:async()=>assert.fail('must not deliver')}).tick();assert.equal((await f.store.query('SELECT enabled FROM relay_agent_callbacks')).rows[0].enabled,false);
 }finally{await f.close();}});
