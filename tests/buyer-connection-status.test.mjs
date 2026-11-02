import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createStore,digest} from '../hosted/db.mjs';
import {createHostedServer} from '../hosted/server.mjs';
import {developmentAppId,configuredBuyerAuthHttp} from '../server/quote-first/buyer-auth-http.mjs';
import {buyerStatusPath,createBuyerStatusHttp,configuredBuyerStatusHttp} from '../server/quote-first/buyer-auth-status.mjs';
import {validBuyerConnectionStatus} from '../src/buyer-connection.mjs';
const origin='https://example.test',token='a'.repeat(64),owner='customer:'+randomUUID(),now=Date.now();
const session={owner,binding:'same-session',expiresAt:now+60000};
const enrolment={owner,subject:randomUUID(),consent:true,environment:'development',expiresAt:now+30000};
const headers={host:'example.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin',cookie:'__Host-relay_sandbox='+token};
const make=(options={})=>createBuyerStatusHttp({origin,enabled:()=>true,resolveSession:async()=>session,resolveEnrollment:async()=>enrolment,clock:()=>now,...options});
async function request(handler,patch={}){
 const req={url:buyerStatusPath,method:'GET',headers:{...headers,...patch.headers},...patch};req.headers={...headers,...patch.headers};
 const res={headers:{},statusCode:200,setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(code,h){this.statusCode=code;for(const[k,v]of Object.entries(h))this.setHeader(k,v);},end(body){this.body=body?JSON.parse(body):null;}};
 const handled=await handler(req,res);return {...res,handled};
}
test('panel default is hidden without reading keys, enrolment, DB or session',async()=>{
 const env={get EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM(){assert.fail('key read');},get EUPOVA_BUYER_AUTH_TEST_ENROLLMENT(){assert.fail('enrolment read');}};
 const h=configuredBuyerStatusHttp({origin,env,store:new Proxy({},{get(){assert.fail('DB read');}})});
 for(const method of ['GET','POST','HEAD']){const r=await request(h,{method});assert.equal(r.statusCode,404);assert.equal(r.headers['cache-control'],'no-store');}
 assert.equal((await request(h,{url:'/api/state'})).handled,false);
});
test('only approved live development enrolment returns bounded disabled status without identity',async()=>{
 const r=await request(make());assert.equal(r.statusCode,200);
 assert.deepEqual(r.body,{visible:true,environment:'development',connection:'disabled',tokenIssuanceEnabled:false,expiresAt:enrolment.expiresAt});
 assert.equal(validBuyerConnectionStatus(r.body,now),true);
 assert.ok(!JSON.stringify(r.body).includes(owner));assert.ok(!JSON.stringify(r.body).includes(enrolment.subject));
 for(const value of [null,{...enrolment,owner:'other'},{...enrolment,consent:false},{...enrolment,environment:'production'},{...enrolment,expiresAt:now}])assert.equal((await request(make({resolveEnrollment:async()=>value}))).statusCode,404);
});
test('cross-origin, host, method, query, bearer and malformed/duplicate cookie attempts fail closed',async()=>{
 for(const patch of [{url:buyerStatusPath+'?preview=true'},{headers:{host:'wrong.test'}},{headers:{'x-forwarded-proto':'http'}},{headers:{'sec-fetch-site':'cross-site'}},{headers:{origin:'https://wrong.test'}},{headers:{authorization:'Bearer forbidden'}}])assert.equal((await request(make(),patch)).statusCode,403);
 assert.equal((await request(make(),{method:'POST'})).statusCode,405);
 for(const value of [undefined,'__Host-relay_sandbox=bad','__Host-relay_sandbox='+token+'; __Host-relay_sandbox='+token])assert.equal((await request(make({resolveSession:async()=>assert.fail('bad cookie must not query DB')}),{headers:{cookie:value}})).statusCode,404);
});
test('expiry, account switch, revocation and kill switch during lookup hide controls',async()=>{
 for(const replacement of [null,{...session,owner:'other'},{...session,binding:'rotated'},{...session,expiresAt:now}]){let calls=0;assert.equal((await request(make({resolveSession:async()=>++calls===1?session:replacement}))).statusCode,404);}
 let active=true;assert.equal((await request(make({enabled:()=>active,resolveEnrollment:async()=>{active=false;return enrolment;}}))).statusCode,404);
 assert.equal((await request(make({tokensEnabled:()=>true}))).statusCode,503);
 assert.equal((await request(make({resolveSession:async()=>{throw Error('private detail');}}))).body.error,'buyer_connection_unavailable');
});
test('invalid browser status never permits a connection',()=>{
 const v={visible:true,environment:'development',connection:'disabled',tokenIssuanceEnabled:false,expiresAt:now+1000};
 for(const patch of [{visible:false},{environment:'production'},{connection:'connected'},{tokenIssuanceEnabled:true},{expiresAt:now},{expiresAt:now+86400001},{expiresAt:'tomorrow'}])assert.equal(validBuyerConnectionStatus({...v,...patch},now),false);
});
test('real session status uses SELECT only, does not require key and preserves sample customer/session rows',async()=>{
 const db=new PGlite();try{
  await db.exec(readFileSync(new URL('../hosted/schema.sql',import.meta.url),'utf8'));
  const id=randomUUID();await db.query("INSERT INTO relay_customers(id,email,name,password_hash,recovery_hash,email_verified_at) VALUES($1,'sample@example.test','Sample','unused','unused',now())",[id]);
  await db.query('INSERT INTO relay_customer_sessions(token_hash,customer_id,version) VALUES($1,$2,1)',[digest(token),id]);
  const sql=[],store=createStore({query:async(q,a)=>{sql.push(q);return db.query(q,a);}});
  const env={EUPOVA_BUYER_AUTH_DEV_PANEL_ENABLED:'true',EUPOVA_BUYER_AUTH_APP_ID:developmentAppId,EUPOVA_BUYER_AUTH_ENVIRONMENT:'development',EUPOVA_BUYER_AUTH_TEST_ENROLLMENT:JSON.stringify({owner:'customer:'+id,subject:randomUUID(),consent:true,consentRecordedAt:now-1000,expiresAt:now+3600000}),get EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM(){assert.fail('private key read');}};
  const snapshot=async()=>JSON.stringify([(await db.query('SELECT * FROM relay_customers')).rows,(await db.query('SELECT * FROM relay_customer_sessions')).rows]);
  const before=await snapshot(),handler=configuredBuyerStatusHttp({origin,store,env});
  assert.equal((await request(handler)).statusCode,200);assert.ok(sql.every(q=>q.trimStart().startsWith('SELECT')));assert.equal(await snapshot(),before);
  assert.equal((await request(configuredBuyerAuthHttp({origin,store,env}),{url:'/api/buyer-auth/token',method:'POST'})).statusCode,404);
  await db.query('UPDATE relay_customer_sessions SET revoked=true');assert.equal((await request(handler)).statusCode,404);
 }finally{await db.close();}
});
test('hosted server routes disabled panel before customer handlers with no DB side effects',async()=>{
 const store={query:async()=>assert.fail('DB call')};const handler=configuredBuyerStatusHttp({origin,store,env:{}});
 const server=createHostedServer({store,config:{origin,host:'example.test',testers:[]},buyerStatus:handler});
 const listener=server.listeners('request')[0];const r=await request(listener);assert.equal(r.statusCode,404);assert.equal(r.body.error,'buyer_auth_disabled');
});
