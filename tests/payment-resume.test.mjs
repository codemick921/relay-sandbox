import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import QRCode from 'qrcode';
import {resumeLink,resumeTarget,resolveResume,canContinueCheckout} from '../src/payment-resume.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createHostedServer} from '../hosted/server.mjs';

test('phone links contain only a request reference in a fragment, not checkout or login credentials',()=>{
 const id=randomUUID(),link=resumeLink('https://relay.example',id),url=new URL(link);
 assert.equal(link,`https://relay.example/#funding=${id}`);assert.equal(url.search,'');assert.equal(url.pathname,'/');
 assert.deepEqual(resumeTarget(url),{kind:'funding-draft',id});
 for(const origin of ['javascript:alert(1)','http://relay.example','https://user:secret@relay.example','https://relay.example/path','https://relay.example/?token=secret','https://relay.example/#token'])assert.throws(()=>resumeLink(origin,id));
 for(const bad of ['',null,'peer-order-token','https://pay.peer.xyz','../checkout'])assert.throws(()=>resumeLink('https://relay.example',bad));
 assert.match(resumeLink('http://127.0.0.1:4324',id),/^http:\/\/127.0.0.1:4324\/#funding=/);
});
test('resume resolution uses only the signed-in owner state and does not follow external targets',()=>{
 const id=randomUUID(),target={kind:'funding-draft',id};
 assert.deepEqual(resolveResume(target,{account:{id:'alice'},fundingDrafts:[{id}]}),target);
 for(const state of [{account:{id:'bob'},fundingDrafts:[]},{account:null,fundingDrafts:[{id}]}])assert.deepEqual(resolveResume(target,state),{kind:'resume-unavailable'});
 assert.deepEqual(resumeTarget({hash:'#funding=javascript:alert(1)'}),{kind:'invalid'});
 assert.equal(resumeTarget({hash:'#other=value'}),null);
 assert.deepEqual(resumeTarget({search:'?checkout='+id}),{kind:'order',id});
 assert.deepEqual(resolveResume({kind:'order',id},{orders:[{id,kind:'checkout'}]}),{kind:'order',id});
 assert.deepEqual(resolveResume({kind:'order',id},{orders:[]}),{kind:'resume-unavailable'});
});
test('a phone link cannot restore checkout controls for a stopped, expired, completed or held request',()=>{
 const draft={status:'bound'},order={status:'checkout_ready',chargebackStatus:'NONE'};
 assert.equal(canContinueCheckout(draft,order,true),true);assert.equal(canContinueCheckout(draft,{...order,status:'checkout_partial'},true),true);
 for(const update of [{stoppedAt:'now'},{supersededBy:'replacement'},{status:'draft'},{status:'closed'},{status:'cancelled'},{status:'unresolved'},{cancellationState:'requested'}])assert.equal(canContinueCheckout({...draft,...update},order,true),false);
 for(const update of [{status:'checkout_cancelled'},{status:'checkout_received'},{status:'checkout_review'},{status:'checkout_confirming'},{trackingError:'offline'},{reviewRequired:true},{chargebackStatus:'OPEN'}])assert.equal(canContinueCheckout(draft,{...order,...update},true),false);
 assert.equal(canContinueCheckout(draft,order,false),false);
});
test('local QR encoding retains the exact safe Relay URL as a byte segment',()=>{
 const link=resumeLink('https://relay-sandbox-uh1r.onrender.com',randomUUID()),qr=QRCode.create(link,{errorCorrectionLevel:'M'});
 assert.equal(Buffer.concat(qr.segments.map(s=>Buffer.from(s.data))).toString(),link);
 assert.ok(qr.modules.size>=21);assert.equal(qr.errorCorrectionLevel.bit,0);
});
test('a second signed-in device reads the same persisted request without creating orders or calling providers',async()=>{
 const f=await fixture();let server;try{
  const accounts=createAccounts(f.store),password='preview lantern meadow river',alice=await accounts.signup({email:'resume@example.test',name:'Alice',password,acceptSandbox:true}),bob=await accounts.signup({email:'other@example.test',name:'Bob',password,acceptSandbox:true});
  const owner=(await accounts.session(alice.token)).owner,agent={id:randomUUID(),name:'Agent',address:'0x1111111111111111111111111111111111111111',network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);
  const drafts=createFundingDrafts(f.store);await drafts.migrate();const saved=await drafts.prepare(owner,{agentId:agent.id,requestId:randomUUID(),amount:'5',rail:'wise',confirm:true});
  const phone=await accounts.login({email:'resume@example.test',password});let providerCalls=0;
  server=createHostedServer({store:f.store,config:{origin:'https://relay.example',host:'relay.example',testers:[]},fundingDrafts:drafts,paymentsDisabled:true,allowHttpForTests:true,pay:{readiness:async()=>{providerCalls++;}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const read=token=>new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/state',headers:{host:'relay.example',cookie:token?'__Host-relay_sandbox='+token:''}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});req.on('error',reject);});
  assert.equal((await read()).status,401);
  const a=await read(alice.token),p=await read(phone.token),b=await read(bob.token),target=resumeTarget(new URL(resumeLink('https://relay.example',saved.id)));
  assert.equal(resolveResume(target,a.data).id,saved.id);assert.equal(resolveResume(target,p.data).id,saved.id);assert.equal(resolveResume(target,b.data).kind,'resume-unavailable');
  assert.equal(p.data.fundingDrafts[0].pence,500);assert.equal(p.data.fundingDrafts[0].agent.address,agent.address);
  assert.equal(Number((await f.store.query('SELECT count(*) FROM relay_funding_drafts')).rows[0].count),1);
  assert.equal(Number((await f.store.query('SELECT count(*) FROM relay_orders')).rows[0].count),0);assert.equal(providerCalls,0);
  await drafts.cancel(owner,{id:saved.id});assert.equal((await read(phone.token)).data.fundingDrafts[0].status,'cancelled');
  await accounts.logout(phone.token);assert.equal((await read(phone.token)).status,401);assert.equal((await read(alice.token)).status,200);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
