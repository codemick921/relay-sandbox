import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {configuredPersonalisedQuotes,createPersonalisedQuoteHttp,personalisedPaths} from '../server/quote-first/personalised-quote-http.mjs';
const origin='https://app.eupova.com',now=Date.parse('2026-11-02T12:00:00Z');
function request(input={receivingWalletId:'sample'},patch={}){const req=Readable.from([Buffer.from(JSON.stringify(input))]);Object.assign(req,{method:'POST',url:personalisedPaths.context,headers:{host:'app.eupova.com','x-forwarded-proto':'https',origin,'sec-fetch-site':'same-origin','content-type':'application/json',cookie:'__Host-relay_sandbox='+'a'.repeat(64),authorization:'Bearer sample.access.token'}},patch);return req;}
async function invoke(handler,req){let status,data,headers;const res={writeHead(s,h){status=s;headers=h;},end(body){data=JSON.parse(body);}};const handled=await handler(req,res);return {handled,status,data,headers};}
function fixture(){let active=true,session={owner:'sample',binding:'a'.repeat(64),expiresAt:now+600000};const enrollment={owner:'sample',environment:'development',consent:true,expiresAt:now+600000};const calls=[];const handler=createPersonalisedQuoteHttp({origin,clock:()=>now,enabled:()=>active,resolveSession:async()=>session,resolveEnrollment:async()=>enrollment,service:Object.fromEntries(['context','quotes','review'].map(k=>[k,async(actor,input)=>{calls.push({k,actor,input});return {reserved:false,canCreatePayment:false,status:'sample'};}]))});return {handler,calls,enrollment,disable(){active=false;},ordinary(){session={...session,owner:'ordinary'};}};}
test('disabled configuration reads no secrets, database or network and returns hidden endpoints',async()=>{
 const env=new Proxy({}, {get(_t,key){assert.equal(key,'EUPOVA_PERSONALISED_QUOTE_DEV_ENABLED');return undefined;}}),store=new Proxy({}, {get(){throw Error('database accessed');}});
 const handler=configuredPersonalisedQuotes({env,store,privyFetch:()=>{throw Error('network');}});
 for(const path of Object.values(personalisedPaths)){const r=await invoke(handler,request({}, {url:path}));assert.equal(r.status,404);assert.equal(r.data.error,'personalised_quotes_disabled');}
 assert.equal((await invoke(handler,request({}, {url:'/api/other'}))).handled,false);
});
test('restricted POST routes require same-origin, a session and bearer token',async()=>{
 const f=fixture(),good=request(),r=await invoke(f.handler,good);assert.equal(r.status,200);assert.equal(r.data.canCreatePayment,false);assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(f.calls[0].actor.sessionToken,'a'.repeat(64));assert.equal(f.calls[0].actor.accessToken,'sample.access.token');
 for(const patch of [{origin:'https://bad.test'},{host:'bad.test'},{'x-forwarded-proto':'http'},{'sec-fetch-site':'cross-site'},{authorization:undefined},{authorization:'Basic forbidden'},{cookie:''},{cookie:good.headers.cookie+'; '+good.headers.cookie},{'content-encoding':'gzip'}]){
  const before=f.calls.length;const out=await invoke(f.handler,request({}, {headers:{...good.headers,...patch}}));assert.notEqual(out.status,200);assert.equal(f.calls.length,before);
 }
 f.ordinary();assert.equal((await invoke(f.handler,request())).status,404);
});
test('unknown identity/address fields, methods, query and oversized bodies never reach service',async()=>{
 const f=fixture();for(const req of [request({owner:'other',receivingWalletId:'sample'}),request({}, {method:'GET'}),request({}, {url:personalisedPaths.context+'?owner=other'}),request({receivingWalletId:'x'.repeat(2000)}),request({amount:'25',currency:'GBP',method:'wise',receivingWalletId:'sample',contextId:'b'.repeat(64),shareAddresses:true,buyer:'0x123'}, {url:personalisedPaths.quotes})]){assert.notEqual((await invoke(f.handler,req)).status,200);}assert.equal(f.calls.length,0);
});
test('quotes and review use the same restricted boundary and in-memory rate limit',async()=>{
 const f=fixture(),input={amount:'25',currency:'GBP',method:'wise',receivingWalletId:'sample',contextId:'b'.repeat(64),shareAddresses:true};
 assert.equal((await invoke(f.handler,request(input,{url:personalisedPaths.quotes}))).status,200);
 assert.equal((await invoke(f.handler,request({...input,offerId:'c'.repeat(64)},{url:personalisedPaths.review}))).status,200);
 for(let i=0;i<10;i++)assert.equal((await invoke(f.handler,request())).status,200);
 assert.equal((await invoke(f.handler,request())).status,429);assert.equal(f.calls.length,12);
});
test('configuration is fail closed and never enables token issuance',async()=>{
 const handler=configuredPersonalisedQuotes({origin,env:{EUPOVA_PERSONALISED_QUOTE_DEV_ENABLED:'true'},store:new Proxy({}, {get(){throw Error('database');}})});
 const r=await invoke(handler,request());assert.equal(r.status,503);assert.deepEqual(r.data,{error:'personalised_quotes_unavailable'});
 const {readFile}=await import('node:fs/promises');const source=await readFile(new URL('../server/quote-first/personalised-quote-http.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/createWallet|signMessage|signTypedData|sendTransaction|connect-token|SIGNING_KEY/);
});

test('access is removed if the lease or kill switch changes while a service is running',async()=>{
 let active=true;const session={owner:'sample',binding:'a'.repeat(64),expiresAt:now+60000},enrollment={owner:'sample',environment:'development',consent:true,expiresAt:now+60000};
 const handler=createPersonalisedQuoteHttp({origin,clock:()=>now,enabled:()=>active,resolveSession:async()=>session,resolveEnrollment:async()=>enrollment,service:{context:async()=>{active=false;return {privateResult:true};}}});
 const r=await invoke(handler,request());assert.equal(r.status,404);assert.doesNotMatch(JSON.stringify(r.data),/privateResult/);
});
