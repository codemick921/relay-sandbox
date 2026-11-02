export const nativeUiConfig=Object.freeze({loginMethods:['email','passkey'],embeddedWallets:{ethereum:{createOnLogin:'off'},solana:{createOnLogin:'off'},disableAutomaticMigration:true},externalWallets:{disableAllExternalWallets:true,walletConnect:{enabled:false}},appearance:{theme:'light',accentColor:'#254f3b'}});
const methods=new Set(['status','begin','review','confirm','recovery']);
export function createNativeRequests(fetchImpl=globalThis.fetch){return async(operation,input={},token=null)=>{
 if(!methods.has(operation))throw Error('unsupported_operation');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{
  const response=await fetchImpl('/api/native-privy/'+operation,{method:operation==='status'?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(operation!=='status'?{'Content-Type':'application/json','X-Eupova-Native':'1'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(operation!=='status'?{body:JSON.stringify(input)}:{})});
  const value=await response.json();if(!response.ok)throw Error(value.error??'native_unavailable');return value;
 }finally{clearTimeout(timer);}
};}
export function validNativeStatus(v){return v?.enabled===true&&/^[a-z0-9]{10,80}$/.test(v.appId??'')&&v.consentVersion==='native-wallet-link-v1'&&typeof v.linked==='boolean'&&v.canCreateWallet===false&&v.canCreatePayment===false;}
export const nativeMessage=code=>({disconnect_unconfirmed:'Privy sign-out could not be confirmed. Try disconnecting again.',identity_conflict:'This Privy account does not match your saved connection. Sign out of Privy and use the account you linked.',intent_expired:'Your review expired. Check the account again before linking.',session_changed:'Your Eupova session changed. Return to Eupova and sign in again.',sign_in_required:'Please sign in to Eupova again.',native_disabled:'Native sign-in is not enabled yet.',wallet_review_required:'The wallet details need review. Your saved connection has not been changed.',native_identity_required:'Use the native email or passkey account for this connection.',consent_required:'Review the account and confirm your choice before linking.'}[code]??'We could not verify the connection. Recheck your sign-in and try again.');
