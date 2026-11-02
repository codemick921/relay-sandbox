import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData,encodeFunctionResult} from 'viem';
import {readFileSync} from 'node:fs';
import manifest from '../server/quote-first/peer-base-v4.json' with {type:'json'};
import codes from './fixtures/public-deployment-code.json' with {type:'json'};
import {checkPeerDeployment,recogniseQuoteDeployment,publicReadEndpoints} from '../server/quote-first/deployment-readiness.mjs';
const now=Date.parse('2026-11-02T12:00:00Z'),block='0x32f0850',blockHash='0x'+'ab'.repeat(32),zeroWord='0x'+'0'.repeat(64);
function fixture({mutate=(v)=>v,failResponse,clock=()=>now}={}){
 const calls=[];const headerCalls=new Map();
 const fetchImpl=async(url,options)=>{
  assert.ok(publicReadEndpoints.includes(url));assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.method,'POST');
  const messages=JSON.parse(options.body);assert.ok(messages.length<=10);
  const results=messages.map(msg=>{
   calls.push({url,...msg});let value;
   switch(msg.method){
    case 'eth_chainId':value='0x2105';break;
    case 'eth_blockNumber':value=block;break;
    case 'eth_getBlockByNumber':{assert.deepEqual(msg.params,[block,false]);const n=(headerCalls.get(url)||0)+1;headerCalls.set(url,n);value={number:block,hash:blockHash,timestamp:'0x'+Math.floor((now-1000)/1000).toString(16)};break;}
    case 'eth_getCode':assert.equal(msg.params[1],block);value=codes[msg.params[0]];assert.ok(value);break;
    case 'eth_getStorageAt':assert.equal(msg.params[2],block);assert.match(msg.params[1],/^0x[0-9a-f]{64}$/);value=zeroWord;break;
    case 'eth_call':{
     assert.equal(msg.params[1],block);assert.deepEqual(Object.keys(msg.params[0]).sort(),['data','to']);
     const view=manifest.views.find(v=>{const c=manifest.contracts[v.contract];return c.address===msg.params[0].to&&encodeFunctionData({abi:c.readAbi,functionName:v.functionName,args:v.args})===msg.params[0].data;});assert.ok(view,'Only fixed manifest view calls are allowed');
     const abi=manifest.contracts[view.contract].readAbi;const output=abi.find(x=>x.name===view.functionName).outputs[0].type;
     value=encodeFunctionResult({abi,functionName:view.functionName,result:output.startsWith('uint')?BigInt(view.expected):view.expected});break;
    }
    default:assert.fail('Forbidden RPC method '+msg.method);
   }
   value=mutate(value,{url,msg,headerCount:headerCalls.get(url)||0});return {jsonrpc:'2.0',id:msg.id,result:value};
  });
  if(failResponse)return failResponse(results);
  return new Response(JSON.stringify(results.reverse()),{headers:{'Content-Type':'application/json'}});
 };
 return {calls,run:()=>checkPeerDeployment({fetchImpl,clock})};
}
test('recognition binds contract, chain, escrow and exact native token, without granting execution',()=>{
 const context={chainId:8453,token:manifest.token,escrow:manifest.contracts.escrow.address,orchestrator:manifest.contracts.orchestrator.address};
 const v4=recogniseQuoteDeployment(context);assert.equal(v4.contractVersion,'v4');assert.equal(v4.contractRecognised,true);assert.equal(v4.sdkCompatible,false);
 assert.equal(recogniseQuoteDeployment({...context,orchestrator:manifest.legacyV3}).contractVersion,'v3');
 for(const patch of [{chainId:1},{token:'0x'+'11'.repeat(20)},{escrow:'0x'+'22'.repeat(20)},{orchestrator:'0x'+'33'.repeat(20)}])assert.equal(recogniseQuoteDeployment({...context,...patch}).contractRecognised,false);
 assert.equal(recogniseQuoteDeployment().contractRecognised,false);assert.equal(v4.canReserve,false);assert.equal(v4.executionVerified,false);
});
test('two matching RPC snapshots preserve the source-verification gap and all disabled capabilities',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.status,'matches_snapshot');assert.equal(r.checks.length,42);assert.equal(r.sourceEvidenceComplete,false);assert.deepEqual(r.unverifiedSources,['signalPolicy']);
 assert.equal(r.canReserve,false);assert.equal(r.canExecute,false);assert.equal(r.buyerEligibilityVerified,false);assert.equal(r.scope,'deployment_snapshot_only');assert.equal(r.validUntil,now+60000);assert.equal(r.blockHash,blockHash);
 assert.equal(new Set(f.calls.map(c=>c.url)).size,2);assert.equal(f.calls.filter(c=>c.method==='eth_getStorageAt').length,42);
});
test('wrong chain or stale/future block fails before contract reads',async()=>{
 for(const which of ['chain','stale','future']){
  const f=fixture({mutate:(v,{msg})=>which==='chain'&&msg.method==='eth_chainId'?'0x1':msg.method==='eth_getBlockByNumber'?{...v,timestamp:'0x'+Math.floor((now+(which==='future'?60000:-180000))/1000).toString(16)}:v});
  const r=await f.run();assert.equal(r.status,'unavailable');assert.deepEqual(r.checks,[]);assert.equal(f.calls.some(c=>c.method==='eth_getCode'),false);
 }
});
test('changed code, pause state, registry membership and proxy slots cannot pass',async()=>{
 for(const which of ['code','pause','registry','proxy']){
  const f=fixture({mutate:(v,{msg})=>{
   if(which==='code'&&msg.method==='eth_getCode')return '0x00';
   if(which==='proxy'&&msg.method==='eth_getStorageAt')return '0x'+'0'.repeat(63)+'1';
   if(which==='pause'&&msg.method==='eth_call'&&msg.params[0].data==='0x5c975abb')return '0x'+'0'.repeat(63)+'1';
   if(which==='registry'&&msg.method==='eth_call'&&msg.params[0].to===manifest.contracts.orchestratorRegistry.address)return zeroWord;
   return v;
  }});const r=await f.run();assert.equal(r.status,'changed',which);assert.ok(r.checks.some(c=>!c.matches));assert.equal(r.canExecute,false);
 }
});
test('RPC disagreement and reorganisation produce no partial success',async()=>{
 for(const which of ['reads','initialHeader','laterHeader']){
  const r=await fixture({mutate:(v,{url,msg,headerCount})=>url===publicReadEndpoints[1]&&((which==='reads'&&msg.method==='eth_getCode')||(which==='initialHeader'&&msg.method==='eth_getBlockByNumber')||(which==='laterHeader'&&msg.method==='eth_getBlockByNumber'&&headerCount===2))?(which==='reads'?'0x00':{...v,hash:'0x'+'ef'.repeat(32)}):v}).run();
  assert.equal(r.status,'unavailable');assert.equal(r.validUntil,null);assert.deepEqual(r.checks,[]);
 }
});
test('malformed, duplicated, redirected, excessive and failed RPC responses fail closed',async()=>{
 const responses=[r=>new Response(JSON.stringify([...r.slice(1),r[1]]),{headers:{'Content-Type':'application/json'}}),r=>new Response(JSON.stringify(r.map(v=>({...v,error:{code:-32000,message:'private data'}}))),{headers:{'Content-Type':'application/json'}}),()=>new Response('broken',{headers:{'Content-Type':'application/json'}}),()=>new Response('x'.repeat(1048577),{headers:{'Content-Type':'application/json'}}),()=>new Response('Unavailable',{status:503}),()=>({ok:true,redirected:true})];
 for(const failResponse of responses){const r=await fixture({failResponse}).run();assert.equal(r.status,'unavailable');assert.equal(r.canReserve,false);assert.equal(JSON.stringify(r).includes('private data'),false);}
});
test('a check taking over sixty seconds or a backwards clock cannot become fresh evidence',async()=>{
 for(const end of [now+61000,now-1]){let n=0;const r=await fixture({clock:()=>++n>5?end:now}).run();assert.equal(r.status,'unavailable');}
});
test('manifest contains view-only ABI fragments and checker imports no signing SDK or customer storage',()=>{
 for(const c of Object.values(manifest.contracts))assert.ok(c.readAbi.every(x=>x.type==='function'&&x.stateMutability==='view'));
 const source=readFileSync(new URL('../server/quote-first/deployment-readiness.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/@zkp2p|@privy|eth_send|eth_sign|\/v3\/sign|createWallet|database|process\.env/);
});
