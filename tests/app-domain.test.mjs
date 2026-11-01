import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {config} from '../hosted/config.mjs';
import {digest} from '../hosted/db.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {createPeerConnection,liveWebhookPath} from '../hosted/peer-connection.mjs';
import {configuredAccountMail} from '../hosted/mail-transport.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {checkoutRequest} from '../server/pay-contract.mjs';
const old='https://old.example',app='https://app.example';
const env={RELAY_MODE:'sandbox',PUBLIC_ORIGIN:old,APP_ORIGIN:app,DATABASE_URL:'postgres://fixture',SANDBOX_TESTERS:JSON.stringify([{label:'tester',sha256hex:digest('private-test-code')}])};
const live={RELAY_PEER_CONNECTION_MODE:'receive_only',PEER_PAY_LIVE_API_KEY:'fixture-key',PEER_PAY_LIVE_WEBHOOK_SECRET:'fixture-secret',PEER_PAY_LIVE_MERCHANT_ID:'fixture-merchant'};
test('domain migration separates app and payment origins and validates both',()=>{
 const c=config(env);assert.equal(c.origin,app);assert.equal(c.host,'app.example');assert.equal(c.paymentOrigin,old);assert.equal(c.legacyOrigin,old);
 const unchanged=config({...env,APP_ORIGIN:undefined});assert.equal(unchanged.origin,old);assert.equal(unchanged.legacyOrigin,null);
 for(const bad of ['http://app.example','https://user@app.example','https://app.example/path','https://app.example/?q=1'])assert.throws(()=>config({...env,APP_ORIGIN:bad}),/HTTPS/);
 assert.throws(()=>config({...env,PUBLIC_ORIGIN:'http://old.example'}),/HTTPS/);
 const intent={id:randomUUID(),agent:{address:'0x1111111111111111111111111111111111111111'},quote:{pence:1000,currency:'GBP',platform:'wise'}};
 assert.equal(checkoutRequest(intent,c.paymentOrigin).successUrl,old+'/?checkout='+intent.id);
});
test('new-domain login, old browser redirects, exact host checks and signed legacy callbacks',async()=>{
 const f=await fixture();let server;
 try{
  const c=config({...env,...live});
  const peer=createPeerConnection({connection:c.liveConnection,store:f.store,fetcher:async()=>new Response(JSON.stringify({success:true,responseObject:{id:'fixture-merchant',environment:'LIVE'}}))});
  await peer.migrate();await peer.checkIdentity();
  server=createHostedServer({store:f.store,config:c,paymentsDisabled:true,peerConnection:peer});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const req=(path,{host='app.example',method='GET',headers={},body=''}={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host,'x-forwarded-proto':'https',...headers}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});r.on('error',reject);r.end(body);});
  const post={method:'POST',headers:{origin:app,'content-type':'application/json'},body:JSON.stringify({code:'private-test-code'})};
  const login=await req('/api/login',post);assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Strict/);assert.doesNotMatch(login.headers['set-cookie'][0],/Domain=/);
  assert.equal((await req('/api/login',{...post,headers:{...post.headers,origin:old}})).status,403);
  assert.equal((await req('/api/login',{...post,host:'old.example'})).status,409);
  assert.equal((await req('/api/access',{host:'unknown.example'})).status,421);
  assert.equal((await req('/api/state',{headers:{cookie:login.headers['set-cookie'][0].split(';')[0]}})).status,200);
  const redirect=await req('/?checkout=existing-id',{host:'old.example'});assert.equal(redirect.status,307);assert.equal(redirect.headers.location,app+'/?checkout=existing-id');
  assert.equal((await req('//evil.example/path',{host:'old.example'})).status,421);
  assert.equal((await req('/api/access',{host:'old.example'})).status,409);
  const payload=JSON.stringify({id:randomUUID(),type:'ORDER_CREATED',data:{test:true,order:null,payment:null}}),stamp=String(Math.floor(Date.now()/1000));
  const hook={host:'old.example',method:'POST',body:payload,headers:{'content-type':'application/json','x-webhook-timestamp':stamp,'x-webhook-id':randomUUID(),'x-webhook-signature':createHmac('sha256',live.PEER_PAY_LIVE_WEBHOOK_SECRET).update(stamp+'.').update(payload).digest('hex')}};
  assert.equal((await req(liveWebhookPath,hook)).status,202);
  assert.equal((await req(liveWebhookPath,{...hook,headers:{...hook.headers,'x-webhook-signature':'invalid'}})).status,401);
  assert.equal((await req(liveWebhookPath,{...hook,host:'evil.example'})).status,421);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
test('new account emails use APP_ORIGIN without changing payment configuration',async()=>{
 const f=await fixture();try{const sent=[];const mail=configuredAccountMail(f.store,{...env,ACCOUNT_EMAIL_ENABLED:'true',ACCOUNT_EMAIL_FROM:'Eupova <accounts@example.test>',RESEND_API_KEY:'fixture-only'},{fetchImpl:async(u,o)=>{sent.push(JSON.parse(o.body));return {ok:true,json:async()=>({id:'fixture-sent'})};}});
 const a=createAccounts(f.store,{mail});await a.signup({email:'migration@example.test',password:'correct horse meadow lantern',name:'Migration test',acceptSandbox:true});await mail.tick();assert.equal(sent.length,1);assert.ok(sent[0].text.includes(app+'/#verify-email='));assert.ok(!sent[0].text.includes(old));assert.equal(config(env).paymentOrigin,old);
 }finally{await f.close();}
});
