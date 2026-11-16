import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {circleOnrampConfig,configuredCircleOnramp,createCircleOnramp,ONRAMP_SANDBOX} from '../hosted/circle-onramp.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {addCustomer} from './fixtures/customers.mjs';
const wallet='0x1111111111111111111111111111111111111111';
const key='TEST_API_KEY:abc:def';
const fakeServer=calls=>({onramp:{createSession:async input=>{calls.push(input);return {sessionToken:'fixture-token',expiresAt:new Date(Date.now()+60000).toISOString(),widgetUrl:'https://onramp-sandbox.arc.io/x'};}}});

test('configuration is off without a key, sandbox only, and never accepts a mainnet key',()=>{
 assert.equal(circleOnrampConfig({}),null);
 assert.deepEqual(circleOnrampConfig({EUPOVA_CIRCLE_ONRAMP_API_KEY:key}),{apiKey:key,...ONRAMP_SANDBOX});
 assert.throws(()=>circleOnrampConfig({EUPOVA_CIRCLE_ONRAMP_API_KEY:'LIVE_API_KEY:abc:def'}),/testnet/);
 assert.throws(()=>circleOnrampConfig({EUPOVA_CIRCLE_ONRAMP_API_KEY:'not-a-key'}),/testnet/);
 assert.throws(()=>circleOnrampConfig({EUPOVA_CIRCLE_ONRAMP_API_KEY:key,EUPOVA_CIRCLE_ONRAMP_ENV:'production'}),/sandbox/);
});

test('startup leaves the feature off on a rejected configuration and never logs the key',async()=>{
 const logs=[];
 assert.equal(await configuredCircleOnramp({store:{},env:{},log:m=>logs.push(m)}),null);
 assert.equal(await configuredCircleOnramp({store:{},env:{EUPOVA_CIRCLE_ONRAMP_API_KEY:'LIVE_API_KEY:secret:secret'},log:m=>logs.push(m)}),null);
 assert.equal(await configuredCircleOnramp({store:{},env:{EUPOVA_CIRCLE_ONRAMP_API_KEY:key},loadKit:async()=>{throw new Error('missing');},log:m=>logs.push(m)}),null);
 assert.ok(logs.length===2&&logs.every(m=>!m.includes('secret')&&!m.includes(key)));
 let received;
 const on=await configuredCircleOnramp({store:{},env:{EUPOVA_CIRCLE_ONRAMP_API_KEY:key},loadKit:async()=>({createAppServerKit:o=>{received=o;return fakeServer([]);}})});
 assert.equal(on.environment,'sandbox');assert.deepEqual(received,{onramp:{apiKey:key,...ONRAMP_SANDBOX}});
});

test('a session is minted only for the signed-in customer, for their own saved Base USDC wallet',async()=>{
 const f=await fixture();
 try{
  const owner='customer:'+randomUUID(),other='customer:'+randomUUID(),calls=[];
  await addCustomer(f,owner);await addCustomer(f,other);
  const agent={id:randomUUID(),name:'Fixture agent',network:'Base',token:'USDC',address:wallet};
  const wrong={id:randomUUID(),name:'Other network',network:'Arc',token:'USDC',address:'0x3333333333333333333333333333333333333333'};
  await f.store.addAgent(owner,agent);await f.store.addAgent(owner,wrong);
  const service=createCircleOnramp({store:f.store,server:fakeServer(calls)});

  const session=await service.createSession(owner,{agentId:agent.id});
  assert.equal(session.sessionToken,'fixture-token');
  assert.deepEqual(calls[0],{appUserId:owner,destinationAddress:wallet,assets:{tokens:['USDC'],chains:['base']}});

  // The address comes from the saved record: the browser cannot supply or override it.
  await assert.rejects(service.createSession(owner,{agentId:agent.id,destinationAddress:'0x2222222222222222222222222222222222222222'}));
  await assert.rejects(service.createSession(owner,{agentId:agent.id,appUserId:other}));
  // Another customer's wallet, an unknown id, a wallet on another network, tester sessions and bad ids are all refused without calling Circle.
  await assert.rejects(service.createSession(other,{agentId:agent.id}),/saved Base USDC wallet/);
  await assert.rejects(service.createSession(owner,{agentId:randomUUID()}),/saved Base USDC wallet/);
  await assert.rejects(service.createSession(owner,{agentId:wrong.id}),/saved Base USDC wallet/);
  await assert.rejects(service.createSession('tester-1',{agentId:agent.id}),/sign-in/);
  await assert.rejects(service.createSession(owner,{agentId:'not-an-id'}));
  await assert.rejects(service.createSession(owner,null));
  assert.equal(calls.length,1);
 }finally{await f.close();}
});

test('disabled customers are refused, provider failures hide details, and requests are rate limited',async()=>{
 const f=await fixture();
 try{
  const owner='customer:'+randomUUID(),calls=[];
  await addCustomer(f,owner);
  const agent={id:randomUUID(),name:'Fixture agent',network:'Base',token:'USDC',address:wallet};
  await f.store.addAgent(owner,agent);
  const failing=createCircleOnramp({store:f.store,server:{onramp:{createSession:async()=>{throw new Error('provider said: TEST_API_KEY:abc:def rejected');}}}});
  await assert.rejects(failing.createSession(owner,{agentId:agent.id}),e=>e.status===502&&!/TEST_API_KEY|provider said/.test(e.message));
  await addCustomer(f,owner,{disabled:true});
  const service=createCircleOnramp({store:f.store,server:fakeServer(calls)});
  await assert.rejects(service.createSession(owner,{agentId:agent.id}),/sign-in/);
  await addCustomer(f,owner);
  for(let i=0;i<8;i++)await service.createSession(owner,{agentId:agent.id});
  await assert.rejects(service.createSession(owner,{agentId:agent.id}),e=>e.status===429);
 }finally{await f.close();}
});

test('HTTP: the session route needs a customer sign-in and same-origin JSON, returns only the session, and state advertises the sandbox',async()=>{
 const {default:http}=await import('node:http');
 const {createHostedServer}=await import('../hosted/server.mjs');
 const {digest}=await import('../hosted/db.mjs');
 const f=await fixture();let server;
 try{
  const calls=[];
  const circleOnramp=createCircleOnramp({store:f.store,server:fakeServer(calls)});
  server=createHostedServer({store:f.store,config:{origin:'https://sandbox.example',host:'sandbox.example',testers:[{label:'oldtester',sha256hex:digest('tester-code')}]},paymentsDisabled:true,pay:{readiness:async()=>({ready:false})},allowHttpForTests:true,circleOnramp});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const request=(path,data,cookie,headers={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:data?'POST':'GET',headers:{host:'sandbox.example',origin:'https://sandbox.example','content-type':'application/json',...cookie?{cookie}:{},...headers}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body),cookie:res.headers['set-cookie']?.[0].split(';')[0]}));});r.on('error',reject);r.end(data?JSON.stringify(data):undefined);});
  const password='correct horse meadow lantern';
  const customer=await request('/api/account/signup',{email:'onramp-buyer@example.test',password,name:'Onramp buyer',acceptSandbox:true});assert.equal(customer.status,200);
  assert.equal((await request('/api/onramp/session',{agentId:randomUUID()})).status,401);
  const saved=await request('/api/agents',{name:'My agent',address:wallet,network:'base',own:true,owner:'oldtester',currentPassword:password},customer.cookie);assert.equal(saved.status,200);
  const state=(await request('/api/state',null,customer.cookie)).data;
  assert.deepEqual(state.circleOnramp,{enabled:true,environment:'sandbox',widgetBaseUrl:ONRAMP_SANDBOX.widgetBaseUrl});
  const agentId=state.agents[0].id;
  assert.equal((await request('/api/onramp/session',{agentId},customer.cookie,{origin:'https://evil.example'})).status,403);
  assert.equal((await request('/api/onramp/session',{agentId},customer.cookie,{'content-type':'text/plain'})).status,403);
  assert.ok([403,404].includes((await request('/api/onramp/session',null,customer.cookie)).status));
  const ok=await request('/api/onramp/session',{agentId},customer.cookie);
  assert.equal(ok.status,200);assert.equal(ok.data.sessionToken,'fixture-token');assert.equal(calls.length,1);assert.equal(calls[0].destinationAddress,wallet);
  assert.equal((await request('/api/onramp/session',{agentId,destinationAddress:'0x2222222222222222222222222222222222222222'},customer.cookie)).status,400);
  assert.equal(calls.length,1);
  // A server without the feature neither advertises nor serves it.
  const bare=createHostedServer({store:f.store,config:{origin:'https://sandbox.example',host:'sandbox.example',testers:[{label:'oldtester',sha256hex:digest('tester-code')}]},paymentsDisabled:true,pay:{readiness:async()=>({ready:false})},allowHttpForTests:true});
  await new Promise(r=>bare.listen(0,'127.0.0.1',r));
  try{
   const req2=(path,data,cookie)=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:bare.address().port,path,method:data?'POST':'GET',headers:{host:'sandbox.example',origin:'https://sandbox.example','content-type':'application/json',cookie}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body)}));});r.on('error',reject);r.end(data?JSON.stringify(data):undefined);});
   assert.equal((await req2('/api/state',null,customer.cookie)).data.circleOnramp,undefined);
   assert.equal((await req2('/api/onramp/session',{agentId},customer.cookie)).status,403);
  }finally{await new Promise(r=>bare.close(r));}
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
