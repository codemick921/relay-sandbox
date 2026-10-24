// Dormant writer. No env discovery; deployed server/worker do not import this module.
import {createCheckout,getMerchant} from '@zkp2p/pay-sdk';
import {InputError} from './validation.mjs';
import {checkoutRequest,validateCheckout,sameUsdc} from './pay-contract.mjs';
const API='https://api.pay.peer.xyz',CHECKOUT='https://pay.peer.xyz';
export function checkedLiveCheckoutUrl(value,providerId,rail='wise'){
 if(value===null)return null;
 let u;try{u=new URL(value);}catch{throw new InputError('Checkout link could not be verified.',502);}
 if(!['wise','revolut'].includes(rail)||typeof value!=='string'||value.length>4096||u.origin!==CHECKOUT||u.pathname!=='/'||u.username||u.password||u.hash||u.searchParams.get('order')!==providerId||!u.searchParams.get('token')||u.searchParams.get('method')!==rail||[...u.searchParams.keys()].some(k=>!['order','token','method'].includes(k))||[...u.searchParams.keys()].length!==3)throw new InputError('Checkout link could not be verified.',502);
 return u.href;
}
export function createLiveCheckoutWriter({apiKey,merchantId,authorise,fetcher=fetch,rail='wise',maxPence=rail==='revolut'?1000:100000}={}){
 if(!Number.isSafeInteger(maxPence)||maxPence<1||maxPence>100000)throw Error('Invalid funding limit.');
 if(!['wise','revolut'].includes(rail))throw Error('Unsupported live rail.');
 if(typeof apiKey!=='string'||!apiKey||!/^[-a-zA-Z0-9_]{1,128}$/.test(merchantId??'')||typeof authorise!=='function')throw Error('Live creation needs an explicit credential, merchant and approval policy.');
 const safeFetch=(url,options)=>fetcher(url,{...options,redirect:'error'});
 const opts=()=>({apiBaseUrl:API,checkoutBaseUrl:CHECKOUT,apiKey,fetcher:safeFetch,preselectedMethod:rail,signal:AbortSignal.timeout(15000)});
 async function allowed(local){if(local?.source!=='live'||local.merchantId!==merchantId||!Number.isSafeInteger(local.quote?.pence)||local.quote.pence<(rail==='revolut'?1:200)||local.quote.pence>maxPence||local.quote.platform!==rail||local.agent?.network!=='Base'||local.agent.token!=='USDC'||await authorise(local)!==true)throw new InputError('Live payment creation is disabled.',403);}
 async function merchant(){let m;try{m=await getMerchant(opts());}catch{throw new InputError('Live merchant verification unavailable.',503);}const cfg=m.merchantConfig;if(m.id!==merchantId||m.environment!=='LIVE'||(rail==='wise'?!cfg?.enabledRails?.includes('wise'):cfg?.quotePreference!=='PREFER_SAR'||cfg?.feePayer!=='MERCHANT'||cfg?.buyerFeeShareBps!==0))throw new InputError('The configured live '+(rail==='wise'?'Wise':'Revolut')+' workspace could not be verified.',409);}
 // dynamicOrdersEnabled is a creation input, not a CheckoutOrder response field.
 // validateCheckout requires FIXED, the exact original fiat/USDC values and rail.
 function result(remote,local,url,origin){validateCheckout(remote,local,merchantId);if(!sameUsdc(remote.requestedUsdcAmount,remote.requestedUsdcAmount)||Number(remote.requestedUsdcAmount)<=0||Number(remote.requestedUsdcAmount)>10000||remote.successUrl!==origin+'/?checkout='+encodeURIComponent(local.id)||remote.dynamicOrdersEnabled===true||(remote.buyerFeeShareBps!==undefined&&remote.buyerFeeShareBps!==0)||(rail==='revolut'&&remote.buyerFeeShareBps!==0))throw new InputError('The original order amount could not be verified.',502);return {merchantId,providerOrderId:remote.id,requestedUsdcAmount:remote.requestedUsdcAmount,checkoutUrl:checkedLiveCheckoutUrl(url,remote.id,rail)};}
 return Object.freeze({
  async create(local,origin){await allowed(local);const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin||u.username||u.password)throw new InputError('A fixed HTTPS return origin is required.');await merchant();await allowed(local);
   let response;try{response=await createCheckout(checkoutRequest(local,origin),opts());}catch{throw new InputError('Checkout creation is unresolved. Do not start another payment.',502);}
   return result(response?.order,local,response?.checkoutUrl,origin);
  },
  // Server-only recovery from a trusted operator candidate; no repeat POST or public import route.
  async reconcile(local,providerId,origin){await allowed(local);if(!/^[-a-zA-Z0-9_]{1,128}$/.test(providerId??''))throw new InputError('Invalid recovery reference.');await merchant();let aggregate;
   try{const r=await safeFetch(API+'/api/v1/orders/'+encodeURIComponent(providerId),{headers:{'X-API-Key':apiKey},signal:AbortSignal.timeout(15000)});const b=await r.json();if(!r.ok||b.success!==true)throw Error();aggregate=b.responseObject;}catch{throw new InputError('Recovery verification is unavailable.',503);}
   if(aggregate?.merchant?.environment!=='LIVE'||aggregate.merchant.id!==merchantId)throw new InputError('Recovery workspace mismatch.',409);
   return result(aggregate.order,{...local,providerOrderId:providerId},null,origin);
  }
 });
}
