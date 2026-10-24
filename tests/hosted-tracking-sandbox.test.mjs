import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {prepareTrackingSandbox} from '../hosted/tracking-sandbox.mjs';
import {createStore,digest} from '../hosted/db.mjs';
import {config} from '../hosted/config.mjs';

test('hosted release hard-disables payment/provider access and needs no Peer credentials',()=>{
 const env={RELAY_MODE:'sandbox',PUBLIC_ORIGIN:'https://sandbox.example',DATABASE_URL:'postgres://example',SANDBOX_TESTERS:JSON.stringify([{label:'owner',sha256hex:digest('private-code')}])};
 for(const extra of [{},{RELAY_PAYMENTS_ENABLED:'true',PEER_PAY_SANDBOX_API_KEY:'unused'}]){const c=config({...env,...extra});assert.equal(c.paymentsDisabled,true);assert.equal(c.providerConnectionsEnabled,false);assert.equal(c.trackingSandbox,true);}
 assert.throws(()=>config({...env,PEER_PAY_LIVE_READ_API_KEY:'forbidden'}),/Live credentials/);
});

test('persistent hosted simulations preserve sign-in, old orders and receipt state across restarts (real PostgreSQL)',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const unique=randomUUID().replaceAll('-',''),baseSchema='test_'+unique,schema='relay_tracking_sandbox_test_'+unique;
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});let pool,tracking,again;
 try{
  await admin.query(`CREATE SCHEMA ${baseSchema}`);pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${baseSchema}`});const base=createStore(pool);await base.migrate();
  const testers=['alice','bob'].map(label=>({label,sha256hex:digest('private-'+label)}));
  const token='a'.repeat(64);await base.login(token,testers[0]);
  const agent={id:randomUUID(),name:'Existing saved agent',address:'0x'+'22'.repeat(20),network:'Base',token:'USDC'};await base.addAgent('alice',agent);
  const original=await base.createOrder('alice',{agentId:agent.id,requestId:randomUUID(),amount:1000});
  const options={connectionString:process.env.TEST_DATABASE_URL,schema};
  tracking=await prepareTrackingSandbox(base,testers,options);
  assert.equal(await base.session(token,testers),'alice');assert.equal((await base.state('alice')).orders[0].id,original.id);assert.equal((await base.state('alice')).agents[0].address,agent.address);
  const alice=(await tracking.store.state('alice')).orders,bob=(await tracking.store.state('bob')).orders;assert.equal(alice.length,4);assert.equal(bob.length,4);assert.ok(alice.every(a=>!bob.some(b=>a.id===b.id)));
  assert.ok(alice.every(o=>o.agent.address==='0x'+'11'.repeat(20)));
  const pending=alice.find(o=>o.status==='checkout_confirming');assert.ok(pending);assert.equal(pending.delivery,null);
  await tracking.store.schedule('alice',pending.id);const worker=tracking.createWorker();await worker.tick();await worker.stop();
  assert.equal((await tracking.store.owned('alice',pending.id)).status,'checkout_received');
  const saved=(await tracking.store.owned('alice',pending.id)).result.delivery;
  await tracking.close();tracking=null;
  again=await prepareTrackingSandbox(base,testers,options);
  assert.equal((await again.store.state('alice')).orders.length,4);assert.deepEqual((await again.store.owned('alice',pending.id)).result.delivery,saved);
  assert.equal(await base.session(token,testers),'alice');assert.equal((await base.state('alice')).orders.length,1);
  assert.equal((await again.store.state('unknown-owner')).orders.length,0);
  await assert.rejects(again.store.owned('bob',pending.id),/not found/);
 }finally{if(tracking)await tracking.close();if(again)await again.close();if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP SCHEMA IF EXISTS ${baseSchema} CASCADE`);await admin.end();}
});
