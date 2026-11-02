import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {nativeRegistryConnection,nativeRegistryRole} from '../server/quote-first/native-privy-database.mjs';
import {provisionNativeRegistry} from '../scripts/provision-native-registry.mjs';
import {createNativePrivyStore} from '../server/quote-first/native-privy-store.mjs';
const samplePassword='b'.repeat(64);
test('registry connection replaces owner credentials and rejects unsafe generated values',()=>{
 const v=new URL(nativeRegistryConnection({DATABASE_URL:'postgres://owner:sample@127.0.0.1/relay_test',EUPOVA_PRIVY_NATIVE_DB_PASSWORD:samplePassword}));
 assert.equal(v.username,nativeRegistryRole);assert.equal(v.password,samplePassword);assert.equal(v.pathname,'/relay_test');
 for(const password of ['',"x' unsafe",'short'])assert.throws(()=>nativeRegistryConnection({DATABASE_URL:v.href,EUPOVA_PRIVY_NATIVE_DB_PASSWORD:password}));
});
test('provisioning refuses enabled native access before opening a connection',async()=>{
 await assert.rejects(provisionNativeRegistry({env:{EUPOVA_PRIVY_NATIVE_ENABLED:'true'},Client:class {constructor(){assert.fail();}}}),/disable_native/);
});
test('native registry runtime has only the intended privileges',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/relay_test');
 const env={DATABASE_URL:url.href,EUPOVA_PRIVY_NATIVE_DB_PASSWORD:samplePassword,EUPOVA_PRIVY_NATIVE_ENABLED:'false'};
 const admin=new pg.Client({connectionString:url.href});await admin.connect();let pool;
 try{
  await admin.query("CREATE TABLE native_registry_permission_probe (id integer PRIMARY KEY, marker text); INSERT INTO native_registry_permission_probe VALUES (1, 'untouched'); GRANT SELECT ON native_registry_permission_probe TO PUBLIC");
  await assert.rejects(provisionNativeRegistry({env}),/runtime_has_unrelated_data_access/);
  await admin.query('REVOKE SELECT ON native_registry_permission_probe FROM PUBLIC');
  assert.equal((await provisionNativeRegistry({env})).runtimeConnection,true);
  assert.equal((await provisionNativeRegistry({env})).runtimeConnection,true);
  pool=new pg.Pool({connectionString:nativeRegistryConnection(env),max:2});
  for(const q of ['SELECT * FROM native_registry_permission_probe',"UPDATE native_registry_permission_probe SET marker='changed'",'DELETE FROM eupova_native_auth.links',"UPDATE eupova_native_auth.links SET did='changed'",'CREATE TABLE public.forbidden_native (id int)','CREATE TABLE eupova_native_auth.forbidden_native (id int)',"UPDATE eupova_native_auth.intents SET owner='changed'"])await assert.rejects(pool.query(q),e=>e.code==='42501');
  const store=createNativePrivyStore({query:(...a)=>pool.query(...a),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}});
  const v={appId:'registrytest',owner:'customer:'+randomUUID(),binding:'a'.repeat(64),nonceHash:createHash('sha256').update(randomUUID()).digest('hex'),expiresAt:Date.now()+60000,did:'did:privy:'+randomUUID(),sidHash:'d'.repeat(64),fingerprint:'none',address:null,consentVersion:'native-wallet-link-v1',recheck:async()=>{}};
  await store.begin(v);await store.review(v);await store.confirm(v);assert.equal((await store.link(v.appId,v.owner)).did,v.did);await assert.rejects(store.confirm(v),/intent_expired/);
  assert.deepEqual((await admin.query('SELECT * FROM native_registry_permission_probe')).rows,[{id:1,marker:'untouched'}]);
 }finally{await pool?.end();await admin.query('DROP TABLE IF EXISTS native_registry_permission_probe');await admin.end();}
});
