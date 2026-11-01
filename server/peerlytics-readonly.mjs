// Optional public evidence only: fixed endpoint, exact intent, no credentials,
// customer details, activity guessing, payments, tool discovery or remote URLs.
const ENDPOINT='https://peerlytics.xyz/api/mcp';
const validHash=x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/i.test(x);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
async function boundedJson(response){
 if(!response.ok||!response.body)throw Error('Unavailable');
 const reader=response.body.getReader();let text='',size=0;const decoder=new TextDecoder();
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072)throw Error('Oversized');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
 finally{await reader.cancel().catch(()=>{});}
 if(response.headers.get('content-type')?.includes('text/event-stream')){
  const messages=text.split(/\r?\n\r?\n/).map(block=>block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n')).filter(Boolean);
  if(messages.length!==1)throw Error('Ambiguous');text=messages[0];
 }
 return JSON.parse(text);
}
export function createPeerlyticsReader({fetcher=fetch,clock=Date.now,maxEntries=250}={}){
 const cache=new Map(),pending=new Map();let pauseUntil=0;
 return Object.freeze({async lookup(intentHash,transactionHash){
  if(!validHash(intentHash)||!validHash(transactionHash))return {status:'unavailable'};
  const key=intentHash.toLowerCase()+':'+transactionHash.toLowerCase(),hit=cache.get(key);
  if(hit&&hit.until>clock())return hit.value;
  if(pending.has(key))return pending.get(key);
  if(clock()<pauseUntil)return {status:'unavailable'};
  const work=(async()=>{let value;
   try{
    const response=await fetcher(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(4000),headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'peerlytics_receipt',arguments:{kind:'intent',id:intentHash}}})});
    const b=await boundedJson(response),s=b?.result?.structuredContent,r=s?.receipt;
    if(b.id!==1||b.error||b.result?.isError||s?.kind!=='intent'||s?.chainId!==8453||!same(r?.intentHash,intentHash)||!['FULFILLED','SIGNALED','PRUNED','CANCELLED','EXPIRED'].includes(r?.status))throw Error('Invalid');
    // No amounts or URLs are accepted from the indexer. It is not a delivery proof.
    value={status:r.status==='FULFILLED'&&validHash(r.fulfillTxHash)?same(r.fulfillTxHash,transactionHash)?'matched':'mismatch':'pending',checkedAt:new Date(clock()).toISOString()};
   }catch{pauseUntil=clock()+60000;value={status:'unavailable',checkedAt:new Date(clock()).toISOString()};}
   cache.delete(key);cache.set(key,{until:clock()+(value.status==='matched'?300000:60000),value});
   while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
   return value;
  })();pending.set(key,work);
  try{return await work;}finally{pending.delete(key);}
 }});
}
