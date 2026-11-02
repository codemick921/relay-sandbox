import {validWalletAuthStatus,matchesWalletAuthIdentity} from './wallet-bootstrap-client.mjs';
const base='/api/buyer-wallet-flow';
export function validWalletFlowStatus(value,now=Date.now()){
 const c=value?.capabilities;
 return validWalletAuthStatus(value,now)&&value.flow===true&&c&&typeof c.creation==='boolean'&&typeof c.quotes==='boolean'&&
  (c.creation?/^[a-f0-9-]{36}$/i.test(c.leaseId??''):c.leaseId===null)&&!(c.creation&&c.quotes);
}
export async function walletFlowRequest(path,{body,bearer,signal,fetchImpl=fetch}={}){
 const r=await fetchImpl(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal,
  headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(path.startsWith(base+'/')&&body!==undefined?{'X-Eupova-Wallet-Auth':'1'}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!r.ok){const error=Error('The restricted request could not be completed.');error.status=r.status;error.code=[401,403,404,409].includes(r.status)?'sign_in_required':'request_unavailable';throw error;}
 return r.json();
}
export const walletFlowStatus=signal=>walletFlowRequest(base+'/status',{signal});
export const walletFlowAuthRequests={status:walletFlowStatus,
 token:(context,signal)=>walletFlowRequest(base+'/token',{signal,body:{intent:'wallet_auth',consent:true,context}}),
 verify:(context,bearer,signal)=>walletFlowRequest(base+'/verify',{signal,bearer,body:{intent:'wallet_auth',consent:true,context}})};
const paths={observe:'/api/buyer-wallet-setup/observe',claim:'/api/buyer-wallet-setup/claim',claimStatus:'/api/buyer-wallet-setup/claim-status',context:'/api/funding-calculator/personalised/context',quotes:'/api/funding-calculator/personalised/quotes',review:'/api/funding-calculator/personalised/review',recipients:base+'/recipients'};
export function createWalletFlowRequests({initial,session,getSdk,fetchImpl=fetch,clock=Date.now}={}){
 const allowed=()=>validWalletFlowStatus(initial,clock())&&session.active&&matchesWalletAuthIdentity(getSdk().user,initial)&&getSdk().authenticated;
 return async(operation,input={},signal)=>{
  if(!Object.hasOwn(paths,operation)||!allowed())throw Error('connection_unavailable');
  if(['claim','claimStatus','observe'].includes(operation)&&!initial.capabilities.creation)throw Error('creation_disabled');
  if(['context','quotes','review','recipients'].includes(operation)&&!initial.capabilities.quotes)throw Error('quotes_disabled');
  await session.refresh();if(!allowed())throw Error('connection_unavailable');
  const bearer=operation==='recipients'?null:await getSdk().getAccessToken();
  if(!allowed()||(operation!=='recipients'&&(typeof bearer!=='string'||bearer.length===0||bearer.length>8192)))throw Error('connection_unavailable');
  const result=await walletFlowRequest(paths[operation],{body:operation==='recipients'?undefined:input,bearer,signal,fetchImpl});
  await session.refresh();if(!allowed())throw Error('connection_changed');
  return result;
 };
}
