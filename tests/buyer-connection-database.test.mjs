import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,randomUUID,createPublicKey,verify} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createStore,digest} from '../hosted/db.mjs';
import {configuredBuyerConnectionHttp,connectionPaths} from '../server/quote-first/buyer-connection-http.mjs';
import {configuredBuyerAuthHttp,developmentAppId} from '../server/quote-first/buyer-auth-http.mjs';
const key=generateKeyPairSync('rsa',{modulusLength:2048});
const keyId='fixture-connection-key';
const trustedKeys={keys:[{...key.publicKey.export({format:'jwk'}),kid:keyId,alg:'RS256',use:'sig'}]};
const origin='https://example.test',token='a'.repeat(64);
async function fixture(){
 const db=new PGlite();await db.exec(readFileSync(new URL('../hosted/schema.sql',import.meta.url),'utf8'));
 const id=randomUUID(),now=Date.now();
 await db.query("INSERT INTO relay_customers(id,email,name,password_hash,recovery_hash,email_verified_at) VALUES($1,'fixture@example.test','Fixture','unused','unused',now())",[id]);
 await db.query('INSERT INTO relay_customer_sessions(token_hash,customer_id,version) VALUES($1,$2,1)',[digest(token),id]);
 const queries=[],store=createStore({query:async(sql,args)=>{queries.push(sql);return db.query(sql,args);}});
 const enrollment={owner:'customer:'+id,subject:randomUUID(),consent:true,consentRecordedAt:now-1000,expiresAt:now+600000};
 const env={EUPOVA_BUYER_AUTH_DEV_CONNECTION_ENABLED:'true',EUPOVA_BUYER_AUTH_DEV_ENABLED:'true',EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED:'true',EUPOVA_BUYER_AUTH_APP_ID:developmentAppId,EUPOVA_BUYER_AUTH_ENVIRONMENT:'development',EUPOVA_BUYER_AUTH_KEY_ID:keyId,EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM:key.privateKey.export({type:'pkcs8',format:'pem'}),EUPOVA_BUYER_AUTH_TEST_ENROLLMENT:JSON.stringify(enrollment)};
 const config={origin,store,env,trustedKeys};
 const snapshot=async()=>JSON.stringify([(await db.query('SELECT * FROM relay_customers')).rows,(await db.query('SELECT * FROM relay_customer_sessions')).rows]);
 return{db,id,queries,env,enrollment,config,snapshot,handler:configuredBuyerConnectionHttp(config)};
}
async function request(handler,url=connectionPaths.status,body){
 const req=Readable.from([body?JSON.stringify(body):'']);Object.assign(req,{url,method:body?'POST':'GET',headers:{host:'example.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin',origin,cookie:'__Host-relay_sandbox='+token,'content-type':'application/json','x-eupova-connection':'1'}});
 const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(value){this.body=JSON.parse(value);}};await handler(req,res);return res;
}
test('real adapter signs a session-bound short-lived token without changing customer or session records',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot(),status=await request(f.handler);assert.equal(status.status,200);
  const r=await request(f.handler,connectionPaths.token,{intent:'privy_connection_test',consent:true,context:status.body.context});assert.equal(r.status,200);
  const [h,p,s]=r.body.token.split('.'),claims=JSON.parse(Buffer.from(p,'base64url'));
  assert.equal(verify('RSA-SHA256',Buffer.from(h+'.'+p),createPublicKey({key:trustedKeys.keys[0],format:'jwk'}),Buffer.from(s,'base64url')),true);
  assert.equal(claims.sub,f.enrollment.subject);assert.equal(claims.aud,developmentAppId);assert.equal(claims.iss,origin+'/auth/buyer');assert.ok(claims.exp-claims.iat<=60);assert.equal(r.body.walletCreated,false);
  assert.equal(await f.snapshot(),before);assert.ok(f.queries.filter(q=>!q.trimStart().startsWith('SELECT')).every(q=>q.startsWith('INSERT INTO relay_rate_limits')));
 }finally{await f.db.close();}
});
test('wrong published key or excessive development lease fails before reading customer records',async()=>{
 const f=await fixture();try{
  for(const config of [{...f.config,trustedKeys:{keys:[{...trustedKeys.keys[0],n:'wrong'}]}},{...f.config,env:{...f.env,EUPOVA_BUYER_AUTH_TEST_ENROLLMENT:JSON.stringify({...f.enrollment,expiresAt:f.enrollment.consentRecordedAt+1800001})}}]){
   const count=f.queries.length,r=await request(configuredBuyerConnectionHttp(config));assert.equal(r.status,503);assert.equal(f.queries.length,count);
  }
 }finally{await f.db.close();}
});
test('unverified or revoked customer and the legacy token endpoint remain blocked',async()=>{
 const f=await fixture();try{
  const old=configuredBuyerAuthHttp({...f.config,legacyTokenAllowed:false});assert.equal((await request(old,'/api/buyer-auth/token',{intent:'buyer_wallet_setup'})).status,404);
  await f.db.query('UPDATE relay_customer_sessions SET revoked=true');assert.equal((await request(f.handler)).status,404);
  await f.db.query('UPDATE relay_customer_sessions SET revoked=false');await f.db.query('UPDATE relay_customers SET email_verified_at=NULL');assert.equal((await request(f.handler)).status,404);
 }finally{await f.db.close();}
});
