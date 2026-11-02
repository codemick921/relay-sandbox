// Fixed public read operations only. This module cannot construct an intent or use a wallet.
import {encodeFunctionData, decodeFunctionResult, keccak256, toBytes} from 'viem';
import manifest from './peer-base-v4.json' with {type:'json'};

export const publicReadEndpoints=Object.freeze(['https://mainnet.base.org/','https://base-rpc.publicnode.com/']);
const addr=x=>typeof x==='string'&&/^0x[0-9a-f]{40}$/i.test(x)?x.toLowerCase():null;
const hex=x=>typeof x==='string'&&/^0x(?:[0-9a-f]{2})*$/i.test(x);
const quantity=x=>typeof x==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/i.test(x);
const hash=x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/i.test(x);
const readonlyMethods=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_call']);
const proxySlots=['implementation','admin','beacon'].map(name=>({name,slot:'0x'+(BigInt(keccak256(toBytes('eip1967.proxy.'+name)))-1n).toString(16).padStart(64,'0')}));
const zeroWord='0x'+'0'.repeat(64);
function requireValue(value,reason){if(!value)throw new Error(reason);}

// Recognition means that this deployment is documented, not that a buyer can transact.
export function recogniseQuoteDeployment({chainId,token,escrow,orchestrator}={}){
 const supported=chainId===manifest.chainId&&addr(token)===manifest.token&&addr(escrow)===manifest.contracts.escrow.address;
 const address=addr(orchestrator);
 const version=supported&&address===manifest.contracts.orchestrator.address?'v4':supported&&address===manifest.legacyV3?'v3':null;
 return Object.freeze({contractRecognised:version!==null,contractVersion:version,sdkCompatible:version==='v3',executionVerified:false,canReserve:false});
}

function transport(fetchImpl){
 let id=0;
 return async function read(endpoint,calls){
  requireValue(publicReadEndpoints.includes(endpoint)&&calls.length>0&&calls.length<=10,'invalid_read_batch');
  const requests=calls.map(c=>{requireValue(readonlyMethods.has(c.method),'rpc_method_not_read_only');return {jsonrpc:'2.0',id:++id,method:c.method,params:c.params};});
  const response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'Eupova-readonly-research'},body:JSON.stringify(requests),credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
  requireValue(response.ok&&!response.redirected&&(!response.url||response.url===endpoint),'rpc_transport_failed');
  requireValue(/application\/json/i.test(response.headers.get('content-type')||''),'rpc_invalid_content_type');
  const reader=response.body?.getReader();requireValue(reader,'rpc_missing_body');
  const chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;requireValue(size<=1048576,'rpc_response_too_large');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let values;try{values=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('rpc_invalid_json');}
  requireValue(Array.isArray(values)&&values.length===requests.length,'rpc_invalid_batch');
  const byId=new Map();
  for(const v of values){requireValue(v&&v.jsonrpc==='2.0'&&!v.error&&Object.hasOwn(v,'result')&&requests.some(r=>r.id===v.id)&&!byId.has(v.id),'rpc_invalid_response');byId.set(v.id,v.result);}
  return requests.map(r=>byId.get(r.id));
 };
}

function header(value,number,now){
 requireValue(value&&value.number===number&&hash(value.hash)&&quantity(value.timestamp),'rpc_invalid_block');
 const timestamp=Number(BigInt(value.timestamp))*1000;
 requireValue(Number.isSafeInteger(timestamp)&&timestamp<=now+15000&&timestamp>=now-120000,'rpc_stale_block');
 return {number,hash:value.hash.toLowerCase(),timestamp};
}

export async function checkPeerDeployment({fetchImpl=globalThis.fetch,clock=Date.now}={}){
 const startedAt=clock();
 const base={chainId:manifest.chainId,manifestId:manifest.id,checkedAt:startedAt,scope:'deployment_snapshot_only',canReserve:false,canExecute:false,buyerEligibilityVerified:false,
  sourceEvidenceComplete:Object.values(manifest.contracts).every(c=>c.sourceVerified),unverifiedSources:Object.entries(manifest.contracts).filter(([,c])=>!c.sourceVerified).map(([name])=>name)};
 try{
  requireValue(Number.isSafeInteger(startedAt)&&startedAt>=0,'invalid_clock');
  const read=transport(fetchImpl);
  const starts=await Promise.all(publicReadEndpoints.map(e=>read(e,[{method:'eth_chainId',params:[]},{method:'eth_blockNumber',params:[]}])));
  for(const [chain,block]of starts)requireValue(quantity(chain)&&BigInt(chain)===BigInt(manifest.chainId)&&quantity(block),'rpc_wrong_chain');
  const height=starts.map(x=>BigInt(x[1])).reduce((a,b)=>a<b?a:b);
  const block='0x'+height.toString(16);
  const headers=await Promise.all(publicReadEndpoints.map(async e=>header((await read(e,[{method:'eth_getBlockByNumber',params:[block,false]}]))[0],block,clock())));
  requireValue(headers[0].hash===headers[1].hash,'rpc_block_disagreement');
  const checks=[];
  for(const [name,c]of Object.entries(manifest.contracts)){
   checks.push({key:name+'.runtime',method:'eth_getCode',params:[c.address,block],validate:v=>hex(v)&&v!=='0x',normalise:keccak256,expected:c.runtimeCodeHash});
   for(const s of proxySlots)checks.push({key:name+'.'+s.name+'Slot',method:'eth_getStorageAt',params:[c.address,s.slot,block],validate:hash,normalise:v=>v.toLowerCase(),expected:zeroWord});
  }
  for(const view of manifest.views){
   const c=manifest.contracts[view.contract],abi=c.readAbi.filter(x=>x.name===view.functionName);
   requireValue(abi.length===1&&abi[0].stateMutability==='view','non_view_abi');
   checks.push({key:view.contract+'.'+view.functionName,method:'eth_call',params:[{to:c.address,data:encodeFunctionData({abi,functionName:view.functionName,args:view.args})},block],validate:hex,
    normalise:v=>{const d=decodeFunctionResult({abi,functionName:view.functionName,data:v});return typeof d==='bigint'?d.toString():typeof d==='string'?d.toLowerCase():d;},expected:view.expected});
  }
  const results=await Promise.all(publicReadEndpoints.map(async endpoint=>{
   const all=[];for(let i=0;i<checks.length;i+=10)all.push(...await read(endpoint,checks.slice(i,i+10)));
   return all.map((v,i)=>{requireValue(checks[i].validate(v),'rpc_malformed_result');return checks[i].normalise(v);});
  }));
  requireValue(JSON.stringify(results[0])===JSON.stringify(results[1]),'rpc_read_disagreement');
  const endHeaders=await Promise.all(publicReadEndpoints.map(async e=>header((await read(e,[{method:'eth_getBlockByNumber',params:[block,false]}]))[0],block,clock())));
  requireValue(endHeaders.every(h=>h.hash===headers[0].hash),'rpc_block_changed');
  const endedAt=clock();requireValue(endedAt>=startedAt&&endedAt-startedAt<=60000,'rpc_check_took_too_long');
  const details=checks.map((c,i)=>({check:c.key,matches:results[0][i]===c.expected,observed:results[0][i],expected:c.expected}));
  return {...base,status:details.every(c=>c.matches)?'matches_snapshot':'changed',blockNumber:height.toString(),blockHash:headers[0].hash,blockTime:headers[0].timestamp,checkedAt:endedAt,validUntil:Math.min(endedAt+60000,headers[0].timestamp+120000),sources:publicReadEndpoints,checks:details};
 }catch(error){
  // No partial green state or raw provider errors, which might contain URLs or credentials.
  const safe=/^(rpc_[a-z_]+|invalid_clock|non_view_abi|invalid_read_batch)$/.test(error?.message??'')?error.message:'rpc_check_failed';
  return {...base,status:'unavailable',reason:safe,checks:[],validUntil:null};
 }
}
