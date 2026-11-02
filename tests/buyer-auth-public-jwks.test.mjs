import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createPublicKey,createHash} from 'node:crypto';
import {createHostedServer} from '../hosted/server.mjs';
import {configuredBuyerAuthHttp} from '../server/quote-first/buyer-auth-http.mjs';
import {createPublicBuyerJwksHandler,publicBuyerJwksPath} from '../server/quote-first/buyer-auth-public-jwks.mjs';
import publicKeys from '../server/quote-first/buyer-auth-public-jwks.json' with {type:'json'};

test('public buyer JWKS is the approved verification key and rejects private or unexpected fields',()=>{
 const key=publicKeys.keys[0];
 assert.deepEqual(Object.keys(key).sort(),['alg','e','kid','kty','n','use']);
 const publicKey=createPublicKey({key,format:'jwk'});
 assert.equal(publicKey.asymmetricKeyDetails.modulusLength,3072);
 assert.equal(key.kid,'eupova-dev-20261102-01');
 assert.equal(createHash('sha256').update(publicKey.export({format:'der',type:'spki'})).digest('hex'),'3de9b56e7881cd170db6a27a952edb205e0d2bc7ac74512cceb317defbb4e792');
 for(const field of ['d','p','q','dp','dq','qi','oth','x5u','jku','email','sub'])
  assert.throws(()=>createPublicBuyerJwksHandler({keys:[{...key,[field]:'forbidden'}]}));
 for(const invalid of [{keys:[]},{keys:[key,key]},{keys:[key],extra:true},{keys:[{...key,alg:'HS256'}]},{keys:[{...key,use:'enc'}]}])
  assert.throws(()=>createPublicBuyerJwksHandler(invalid));
});

test('public JWKS is read-only and separate from disabled token issuance, database and provider access',async()=>{
 const store=new Proxy({},{get:()=>()=>{throw Error('Public JWKS must not access the database');}});
 const pay=new Proxy({},{get:()=>()=>{throw Error('Public JWKS must not access a payment provider');}});
 const origin='https://jwks.example';
 const buyerAuth=configuredBuyerAuthHttp({origin,store,env:{}});
 const server=createHostedServer({store,config:{origin,host:'jwks.example',testers:[]},customerAccountsEnabled:false,pay,buyerAuth});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(url,method='GET',headers={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:url,method,headers:{host:'jwks.example','x-forwarded-proto':'https',...headers}},res=>{
   let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
  });req.on('error',reject);req.end();
 });
 try{
  const r=await request(publicBuyerJwksPath);
  assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body),publicKeys);
  assert.equal(r.headers['content-type'],'application/json; charset=utf-8');
  assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-content-type-options'],'nosniff');
  assert.equal(r.headers['set-cookie'],undefined);assert.equal(Number(r.headers['content-length']),Buffer.byteLength(r.body));
  const head=await request(publicBuyerJwksPath,'HEAD');assert.equal(head.status,200);assert.equal(head.body,'');
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']){
   const rejected=await request(publicBuyerJwksPath,method);assert.equal(rejected.status,405);assert.equal(rejected.headers.allow,'GET, HEAD');
  }
  for(const url of [publicBuyerJwksPath+'?key=other',publicBuyerJwksPath+'/private','/.well-known/buyer-auth-signing-key.pem'])
   assert.equal((await request(url)).status,404);
  assert.equal((await request(publicBuyerJwksPath,'GET',{host:'other.example'})).status,421);
  assert.notEqual((await request(publicBuyerJwksPath,'GET',{'x-forwarded-proto':'http'})).status,200);
  for(const [url,method] of [['/api/buyer-auth/jwks','GET'],['/api/buyer-auth/token','POST']]){
   const disabled=await request(url,method);assert.equal(disabled.status,404);assert.equal(JSON.parse(disabled.body).error,'buyer_auth_disabled');
  }
 }finally{await new Promise(r=>server.close(r));}
});
