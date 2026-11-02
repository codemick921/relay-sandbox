// Experimental server-only read adapter. No keys, checkout creation or signing methods.
import {buildQuoteRequest,normaliseQuoteResponse,QuoteError} from './direct-quote.mjs';
import {quoteIntegration} from './quote-review.mjs';
const ORIGIN='https://api.zkp2p.xyz';
const LIMIT=512*1024;
export function createQuoteReader({policy,fetchImpl=globalThis.fetch,clock=Date.now}){
 if(typeof fetchImpl!=='function')throw new QuoteError('missing_transport');
 return Object.freeze({async getQuotes(input){
  const built=buildQuoteRequest(input,policy),{amount,isExactFiat,quotesToReturn,...fields}=built.request;
  const url=new URL(isExactFiat?'/v3/quote/exact-fiat':'/v3/quote/exact-token',ORIGIN);
  url.searchParams.set('quotesToReturn',String(quotesToReturn));
  const body={...fields,[isExactFiat?'exactFiatAmount':'exactTokenAmount']:amount};
  // Whitelist exactly the quote operation; never follow an origin-changing redirect.
  const response=await fetchImpl(url.href,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body),redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(12000)});
  if(!response.ok&&response.status!==404)throw new QuoteError(response.status===429?'quote_rate_limited':[401,403].includes(response.status)?'provider_authentication_required':'quote_provider_unavailable');
  if(response.redirected||(response.url&&response.url!==url.href))throw new QuoteError('unexpected_response_origin');
  if(!/\bapplication\/json\b/i.test(response.headers.get('content-type')||''))throw new QuoteError('invalid_content_type');
  const reader=response.body?.getReader();
  if(!reader)throw new QuoteError('missing_response_body');
  const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>LIMIT)throw new QuoteError('response_too_large');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new QuoteError('invalid_json');}
  if(response.status===404){
   if(payload.success===false&&payload.errorCode==='no_quotes_found')return Object.freeze({result:{status:'no_quotes',context:built.context,offers:[],rejections:[],checkedAt:clock(),canCreatePayment:false},source:{origin:ORIGIN,operation:'quote'},canCreatePayment:false});
   throw new QuoteError('quote_endpoint_unavailable');
  }
  const result=normaliseQuoteResponse(payload,built,policy,{now:clock()});
  // Raw seller identities remain internal; customer DTO contains no payment instructions.
  return Object.freeze({result,source:{origin:ORIGIN,operation:'quote',apiContract:'documented-public-v3',checkedAt:result.checkedAt},canCreatePayment:false});
 }});
}
// PREFER_SAR can return only the SAR pool across a combined request. Query each
// supported method independently so one method's offers do not hide another's.
export async function getQuotesByMethod(reader,input,methods){
 if(!Array.isArray(methods)||methods.length<1||methods.length>7||new Set(methods).size!==methods.length)throw new QuoteError('invalid_method_list');
 const results=await Promise.allSettled(methods.map(method=>reader.getQuotes({...input,method})));
 return results.map((r,index)=>r.status==='fulfilled'?{method:methods[index],...customerQuoteView(r.value)}:{method:methods[index],status:'unavailable',reason:r.reason instanceof QuoteError?r.reason.code:'quote_provider_unavailable',offers:[],canCreatePayment:false});
}
export function customerQuoteView(read){
 return {status:read.result.status,checkedAt:read.result.checkedAt,offers:read.result.offers.map(q=>({id:q.fingerprint,integration:quoteIntegration({chainId:q.terms.context.chainId,token:q.terms.context.token,escrow:q.terms.quote.intent.escrowAddress,orchestrator:q.terms.orchestrator}),youPay:q.youPay,youReceive:q.youReceive,fee:q.fee,exchangeRate:q.exchangeRate,spreadBps:q.spreadBps,validUntil:q.validUntil,conditions:q.conditions,verification:q.verification,reserved:false,canExecute:false})),canCreatePayment:false};
}
