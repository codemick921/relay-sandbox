import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import http from 'node:http';
import {createStore,digest,orderView} from '../hosted/db.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {createWorker} from '../hosted/worker.mjs';
import {config} from '../hosted/config.mjs';
async function fixture(){
 if(process.env.TEST_DATABASE_URL){
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});const schema='test_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:8});
  const store=createStore(pool);await store.migrate();return {store,close:async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
 }
 const db=new PGlite();let tail=Promise.resolve();
 async function connect(){let release;const old=tail;tail=new Promise(r=>release=r);await old;return {query:async(sql,args=[])=>sql.includes('CREATE TABLE')?(await db.exec(sql)).at(-1):db.query(sql,args),release};}
 const pool={connect,query:async(sql,args)=>{const c=await connect();try{return await c.query(sql,args);}finally{c.release();}},end:()=>db.close()};const store=createStore(pool);await store.migrate();return {store,close:()=>pool.end()};
}
const wallet=()=>({id:randomUUID(),name:'Test agent',address:'0x1111111111111111111111111111111111111111',network:'Base',token:'USDC'});
async function order(store,owner='alice'){const a=wallet();await store.addAgent(owner,a);return store.createOrder(owner,{requestId:randomUUID(),agentId:a.id,amount:1000});}
const ready=id=>({providerOrderId:id,status:'checkout_ready',checkoutUrl:'https://pay.peer.xyz/test',requestedUsdcAmount:'12'});
const event=(o,id='event1')=>({eventId:id,digest:digest(id),deliveryId:'delivery1',orderId:'peer1',relayOrderId:o.id,type:'order.completed',test:false});
test('durable intent, owner isolation, idempotency, immutable destination and hashed sessions',async()=>{
 const f=await fixture();try{const s=f.store,o=await order(s);const again=await s.createOrder('alice',{requestId:o.request_id,agentId:o.request.agent.id,amount:1000});assert.equal(again.id,o.id);
 await assert.rejects(s.createOrder('alice',{requestId:o.request_id,agentId:o.request.agent.id,amount:2000}),/different order/);
 await assert.rejects(s.owned('bob',o.id),/not found/);assert.equal((await s.state('bob')).orders.length,0);
 await assert.rejects(s.query("UPDATE relay_orders SET request=request||'{\"source\":\"live\"}' WHERE id=$1",[o.id]),/Immutable/);
 const token='a'.repeat(64),p={label:'alice',sha256hex:digest('code')};await s.login(token,p);assert.equal(await s.session(token,[p]),'alice');assert.equal(await s.session(token,[{...p,sha256hex:digest('rotated')}]),null);await s.logout(token);assert.equal(await s.session(token,[p]),null);
 const c=await s.claimCreate('alice',o.id);assert.ok(c);assert.equal(await s.claimCreate('alice',o.id),null);await s.apply(c,ready('peer1'),{creation:true});
 }finally{await f.close();}
});
test('signed event deduplication, early delivery, fenced leases and terminal status',async()=>{
 const f=await fixture();try{const s=f.store,o=await order(s),c=await s.claimCreate('alice',o.id);assert.deepEqual(await s.accept(event(o)),{duplicate:false});assert.deepEqual(await s.accept({...event(o),deliveryId:'changed-unsigned-header'}),{duplicate:true});await assert.rejects(s.accept({...event(o),digest:digest('different')}),/differs/);
 await s.apply(c,ready('peer1'),{creation:true});const stale=await s.claimNext('worker-a');assert.ok(stale);
 await s.query("UPDATE relay_orders SET lease_until=now()-interval '1 second' WHERE id=$1",[o.id]);const current=await s.claimNext('worker-b');assert.ok(current);assert.notEqual(current.lease_token,stale.lease_token);
 assert.equal(await s.apply(stale,{status:'sandbox_complete'}),false);assert.equal(await s.apply(current,{status:'sandbox_complete'}),true);
 assert.equal((await s.owned('alice',o.id)).status,'sandbox_complete');await s.schedule('alice',o.id);const next=await s.claimNext('worker-c');await assert.rejects(s.apply(next,{status:'checkout_partial'}),/conflicts/);await s.fail(next);assert.equal((await s.owned('alice',o.id)).status,'sandbox_complete');
 assert.equal(Number((await s.query('SELECT count(*) FROM relay_webhooks WHERE processed_at IS NULL')).rows[0].count),0);
 }finally{await f.close();}
});
test('unknown create is recovered from signed hint without another create; worker survives provider outage',async()=>{
 const f=await fixture();try{const s=f.store,o=await order(s),c=await s.claimCreate('alice',o.id);await s.fail(c);assert.equal(await s.claimCreate('alice',o.id),null);assert.equal(await s.claimNext('w'),null);await s.accept(event(o));let recovered=0,reads=0;
 const worker=createWorker({store:s,pay:{recover:async(local,id)=>{recovered++;assert.equal(id,'peer1');assert.equal(local.agent.address,o.request.agent.address);return ready(id);},refresh:async()=>{reads++;throw Error('provider down');}}});await worker.tick();assert.equal(recovered,1);assert.equal(reads,1);const saved=await s.owned('alice',o.id);assert.equal(saved.provider_id,'peer1');assert.equal(saved.status,'checkout_ready');assert.ok(saved.result.trackingError);assert.equal((await s.state('alice')).worker.healthy,true);await worker.stop();
 }finally{await f.close();}
});
test('real PostgreSQL concurrent workers claim different orders', {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const s=f.store;for(const owner of ['alice','bob']){const o=await order(s,owner);await s.apply(await s.claimCreate(owner,o.id),ready(owner),{creation:true});await s.schedule(owner,o.id);}const [a,b]=await Promise.all([s.claimNext('a'),s.claimNext('b')]);assert.ok(a);assert.ok(b);assert.notEqual(a.id,b.id);
 }finally{await f.close();}
});
test('HTTP private access, cookie policy, origins, sandbox-only routes and sign-out',async()=>{
 const f=await fixture();let server;try{const s=f.store,principal={label:'alice',sha256hex:digest('private-test-code')};server=createHostedServer({store:s,config:{origin:'https://sandbox.example',host:'sandbox.example',testers:[principal]},pay:{readiness:async()=>({configured:true})},allowHttpForTests:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const req=(url,options={})=>new Promise((resolve,reject)=>{const r=http.request(base+url,{method:options.method??'GET',headers:{host:'sandbox.example',...options.headers}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:{get:key=>Array.isArray(res.headers[key])?res.headers[key].join('; '):res.headers[key]},json:()=>JSON.parse(body)}));});r.on('error',reject);r.end(options.body);});
 assert.equal((await req('/healthz')).status,200);assert.equal((await req('/api/state')).status,401);assert.equal((await req('/api/rpc')).status,404);
 const post=(url,data,headers={})=>req(url,{method:'POST',headers:{origin:'https://sandbox.example','content-type':'application/json',...headers},body:JSON.stringify(data)});
 assert.equal((await post('/api/login',{code:'private-test-code'},{origin:'https://evil.example'})).status,403);
 const login=await post('/api/login',{code:'private-test-code'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie');assert.match(cookie,/Secure; HttpOnly; SameSite=Strict/);const auth={cookie:cookie.split(';')[0]};assert.equal((await req('/api/state',{headers:auth})).status,200);
 assert.equal((await post('/api/logout',{},auth)).status,200);assert.equal((await req('/api/state',{headers:auth})).status,401);
 assert.equal((await req('/api/access',{headers:{host:'evil.example'}})).status,421);
 }finally{if(server)await new Promise(r=>server.close(r));await f.close();}
});
test('configuration rejects live credentials and insecure origins',()=>{const e={RELAY_MODE:'sandbox',PUBLIC_ORIGIN:'https://sandbox.example',SANDBOX_TESTERS:JSON.stringify([{label:'tester',sha256hex:digest('code')}]),DATABASE_URL:'postgres://example',PEER_PAY_SANDBOX_API_KEY:'test',PEER_PAY_SANDBOX_MERCHANT_ID:'test',PEER_PAY_SANDBOX_WEBHOOK_SECRET:'test'};assert.equal(config(e).host,'sandbox.example');assert.throws(()=>config({...e,PEER_PAY_LIVE_API_KEY:'not-allowed'}),/Live credentials/);assert.throws(()=>config({...e,PUBLIC_ORIGIN:'http://sandbox.example'}),/HTTPS/);});
