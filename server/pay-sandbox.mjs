import {createCheckout,getMerchant} from '@zkp2p/pay-sdk';
import {InputError} from './validation.mjs';

const API='https://api.pay.peer.xyz',CHECKOUT='https://pay.peer.xyz';
import {checkoutRequest,validateCheckout,sameUsdc} from './pay-contract.mjs';
export {checkoutRequest,validateCheckout} from './pay-contract.mjs';
export function createSandboxPayService({key=process.env.PEER_PAY_SANDBOX_API_KEY,merchantId=process.env.PEER_PAY_SANDBOX_MERCHANT_ID,fetcher=fetch}={}){
 const options=()=>({apiBaseUrl:API,checkoutBaseUrl:CHECKOUT,apiKey:key,fetcher,
  preselectedMethod:'wise',signal:AbortSignal.timeout(15000)});
 async function merchant(){
  if(!key)throw new InputError('Peer Pay sandbox is not connected yet. Add its sandbox key on the server.',503);
  let m;try{m=await getMerchant(options());}catch{throw new InputError('Peer Pay sandbox access could not be verified.',502);}
  // A live key is never accepted by this prototype checkout adapter.
  if(m?.environment!=='SANDBOX')throw new InputError('A verified sandbox workspace is required. Live checkout is disabled.',409);
  if(typeof m.id!=='string'||m.id!==merchantId||!m.merchantConfig?.enabledRails?.includes('wise'))throw new InputError('Enable Wise in the Peer Pay sandbox workspace first.',409);
  return m;
 }
 return {
  async recover(local,providerId){
   if(local.source!=='sandbox'||typeof providerId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(providerId))throw new InputError('Invalid sandbox recovery hint.',409);
   // A signed hint locates a candidate. Fresh provider data must independently match the immutable local intent.
   const m=await merchant();let aggregate;
   try{const r=await fetcher(`${API}/api/v1/orders/${encodeURIComponent(providerId)}`,{signal:AbortSignal.timeout(15000)});const b=await r.json();if(!r.ok||b.success!==true)throw Error();aggregate=b.responseObject;}catch{throw new InputError('Recovery read is unavailable.',502);}
   if(aggregate?.merchant?.environment!=='SANDBOX'||aggregate.merchant.id!==m.id)throw new InputError('Recovery workspace mismatch.',409);
   validateCheckout(aggregate.order,{...local,providerOrderId:providerId},m.id);
   return {providerOrderId:providerId,merchantId:m.id,checkoutUrl:null,status:'checkout_recovery',providerStatus:aggregate.order.status,requestedUsdcAmount:aggregate.order.requestedUsdcAmount};
  },
  async readiness(){
   if(!key)return {ready:false,mode:'sandbox',reason:'Connect a Peer Pay sandbox workspace to try hosted checkout.',extensionFreeVerified:false};
   try{await merchant();return {ready:true,mode:'sandbox',reason:'Sandbox connected. Test orders are simulated; live seller-only verification is still pending.',extensionFreeVerified:false};}
   catch(e){return {ready:false,mode:'sandbox',reason:e.message,extensionFreeVerified:false};}
  },
  async create(local,origin){
   const m=await merchant();let result;
   try{result=await createCheckout(checkoutRequest(local,origin),options());}
   catch{throw new InputError('Checkout creation is unresolved. Resume this same order; do not start another.',502);}
   validateCheckout(result?.order,local,m.id);
   if(result.checkoutUrl!==null){
    let u;try{u=new URL(result.checkoutUrl);}catch{throw new InputError('Peer returned an invalid checkout link.',502);}
    if(u.origin!==CHECKOUT||u.pathname!=='/'||u.searchParams.get('order')!==result.order.id||!u.searchParams.get('token'))throw new InputError('Peer returned an unexpected checkout link.',502);
   }
   return {providerOrderId:result.order.id,merchantId:m.id,checkoutUrl:result.checkoutUrl,
    status:result.checkoutUrl?'checkout_ready':'checkout_recovery',providerStatus:result.order.status,requestedUsdcAmount:result.order.requestedUsdcAmount};
  },
  async refresh(local){
   if(local.source!=='sandbox')throw new InputError('Only sandbox orders are supported.',409);
   if(!local.providerOrderId)return {};
   let aggregate;
   try{const r=await fetcher(`${API}/api/v1/orders/${encodeURIComponent(local.providerOrderId)}`,{signal:AbortSignal.timeout(15000)});
    const body=await r.json();if(!r.ok||body.success!==true)throw Error();aggregate=body.responseObject;
   }catch{throw new InputError('Peer status is unavailable. The last checked state is unchanged.',502);}
   const environment=local.source==='live'?'LIVE':local.source==='sandbox'?'SANDBOX':null;
   if(!environment||aggregate?.merchant?.environment!==environment||aggregate.merchant.id!==local.merchantId)throw new InputError('Peer returned a different workspace. Status withheld.',502);
   validateCheckout(aggregate.order,local,local.merchantId);
   if(local.requestedUsdcAmount&&!sameUsdc(local.requestedUsdcAmount,aggregate.order.requestedUsdcAmount))throw new InputError('The original USDC order size changed. Reconcile before continuing.',502);
   const common={providerStatus:aggregate.order.status,checkedAt:new Date().toISOString(),trackingError:null};
   if(environment==='SANDBOX'){
    const status={CREATED:local.checkoutUrl?'checkout_ready':'checkout_recovery',PARTIALLY_FULFILLED:'checkout_partial',FULFILLED:'sandbox_complete',CANCELLED:'checkout_cancelled'}[aggregate.order.status];
    return {...common,status,verification:{environment:'SANDBOX',simulated:true,providerFulfilled:aggregate.order.status==='FULFILLED'},delivery:null};
   }
   throw new InputError('Live verification is disabled on this sandbox.',409);
  }
 };
}
