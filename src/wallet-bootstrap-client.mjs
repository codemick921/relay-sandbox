// A separate lifecycle: the existing auth-only controller remains unchanged.
import {PRIVY_APP_ID} from './privy-connection-client.mjs';
export const walletAuthConfig=Object.freeze({embeddedWallets:{ethereum:{createOnLogin:'off'},solana:{createOnLogin:'off'},disableAutomaticMigration:true},externalWallets:{disableAllExternalWallets:true,walletConnect:{enabled:false}},appearance:{theme:'light',accentColor:'#254f3b'}});
const addr=v=>typeof v==='string'&&/^0x[0-9a-f]{40}$/.test(v)&&!/^0x0{40}$/.test(v);
export function validWalletAuthStatus(v,now=Date.now()){
 return !!v&&v.visible===true&&v.environment==='development'&&v.purpose==='wallet_auth'&&v.appId===PRIVY_APP_ID&&/^[a-f0-9]{64}$/.test(v.context??'')&&/^[a-f0-9-]{36}$/i.test(v.subject??'')&&/^did:privy:[a-zA-Z0-9]{1,80}$/.test(v.privyDid??'')&&(v.expectedAddress===null||addr(v.expectedAddress))&&Number.isSafeInteger(v.expiresAt)&&v.expiresAt>now&&v.expiresAt<=now+1800000;
}
export function matchesWalletAuthIdentity(user,initial){
 if(!user||user.id!==initial.privyDid||!Array.isArray(user.linkedAccounts)||user.linkedAccounts.some(a=>!a||!['custom_auth','wallet'].includes(a.type)))return false;
 const ids=user.linkedAccounts.filter(a=>a.type==='custom_auth'),wallets=user.linkedAccounts.filter(a=>a.type==='wallet');
 if(ids.length!==1||ids[0].customUserId!==initial.subject)return false;
 if(initial.expectedAddress===null)return wallets.length===0&&!user.wallet;
 if(wallets.length!==1)return false;
 const w=wallets[0];
 if(w.address?.toLowerCase()!==initial.expectedAddress||w.chainType!=='ethereum'||w.walletClientType!=='privy'||w.connectorType!=='embedded'||w.delegated===true||w.imported===true)return false;
 // SDK may omit server-only capability fields. Server confirmation remains mandatory.
 return !user.wallet||(user.wallet.address?.toLowerCase()===initial.expectedAddress&&user.wallet.chainType==='ethereum');
}
const validToken=(v,now,expiry)=>v&&typeof v.token==='string'&&v.token.length>0&&v.token.length<=8192&&Number.isSafeInteger(v.expiresAt)&&v.expiresAt>now+5000&&v.expiresAt<=Math.min(now+61000,expiry);
export function validWalletAuthProof(v,initial,now=Date.now()){
 return !!v&&v.context===initial.context&&v.address===initial.expectedAddress&&v.status===(initial.expectedAddress===null?'no_wallet':'wallet_recognised')&&v.canQuote===false&&v.canCreateWallet===false&&v.canCreatePayment===false&&Number.isSafeInteger(v.observedAt)&&v.observedAt<=now&&Number.isSafeInteger(v.validUntil)&&v.validUntil>now&&v.validUntil<=Math.min(v.observedAt+15000,initial.expiresAt);
}
async function jsonRequest(path,signal,options={}){const r=await fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal,...options});if(!r.ok)throw Error('request_unavailable');return r.json();}
export const walletAuthStatus=signal=>jsonRequest('/api/buyer-wallet-auth/status',signal);
export const walletAuthToken=(context,signal)=>jsonRequest('/api/buyer-wallet-auth/token',signal,{method:'POST',headers:{'Content-Type':'application/json','X-Eupova-Wallet-Auth':'1'},body:JSON.stringify({intent:'wallet_auth',consent:true,context})});
export const walletAuthVerify=(context,accessToken,signal)=>jsonRequest('/api/buyer-wallet-auth/verify',signal,{method:'POST',headers:{'Content-Type':'application/json','X-Eupova-Wallet-Auth':'1',Authorization:'Bearer '+accessToken},body:JSON.stringify({intent:'wallet_auth',consent:true,context})});
export function createWalletAuthSession({initial,status=walletAuthStatus,token=walletAuthToken,verify=walletAuthVerify,getAccessToken,logout,onChange=()=>{},clock=Date.now,timeoutMs=10000}={}){
 initial=Object.freeze({...initial});
 let phase='idle',active=false,generation=0,cached=null,tokenFlight=null,proofFlight=null,ending=null,authenticated=false,issued=false,proof=null,proofTimer=null,providerUser=null;
 const controllers=new Set();
 const emit=p=>{phase=p;onChange({phase:p,proof:proof?{...proof}:null});};
 const clearProof=()=>{proof=null;clearTimeout(proofTimer);};
 async function bounded(fn){const c=new AbortController();controllers.add(c);let timer;try{return await Promise.race([Promise.resolve().then(()=>fn(c.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{c.abort();reject(Error('timeout'));},timeoutMs);})]);}finally{clearTimeout(timer);controllers.delete(c);}}
 async function check(){const v=await bounded(status);if(!validWalletAuthStatus(v,clock())||JSON.stringify(v)!==JSON.stringify(initial)||v.expiresAt<=clock()+5000)throw Error('access_changed');}
 async function end(reason='disconnected'){
  active=false;generation++;cached=null;issued=false;authenticated=false;providerUser=null;clearProof();for(const c of controllers)c.abort();
  if(ending)return ending;emit('disconnecting');ending=(async()=>{try{await bounded(()=>logout());emit(reason);}catch{emit('cleanup_failed');}finally{ending=null;}})();return ending;
 }
 const live=g=>active&&generation===g&&initial.expiresAt>clock()+5000;
 async function confirm(force=false){
  if(!active||!authenticated||!issued)return;
  if(proofFlight)return proofFlight;
  if(!force&&proof&&proof.validUntil>clock())return;
  clearProof();emit('verifying');const g=generation;
  proofFlight=(async()=>{try{
   await check();if(!live(g))return;
   const access=await bounded(()=>getAccessToken());if(!live(g))return;
   if(typeof access!=='string'||access.length===0||access.length>8192)throw Error('access_invalid');
   const result=await bounded(signal=>verify(initial.context,access,signal));if(!live(g))return;
   await check();if(!live(g))return;
   if(!authenticated||!matchesWalletAuthIdentity(providerUser,initial)||!validWalletAuthProof(result,initial,clock()))throw Error('proof_invalid');
   proof={status:result.status,address:result.address,observedAt:result.observedAt,validUntil:result.validUntil};emit(result.status);
   proofTimer=setTimeout(()=>{if(live(g)){clearProof();emit('verification_expired');}},Math.max(0,result.validUntil-clock()));proofTimer.unref?.();
  }catch{if(live(g))await end('blocked');}finally{proofFlight=null;}})();return proofFlight;
 }
 return {
  get phase(){return phase;},get active(){return active;},get proof(){if(proof&&proof.validUntil<=clock())clearProof();return proof?{...proof}:null;},
  async start(consent=false){
   if(phase!=='idle'||consent!==true)return;
   const g=++generation;emit('preparing');
   try{if(!validWalletAuthStatus(initial,clock()))throw Error();await check();await bounded(()=>logout());if(g!==generation)return;await check();if(g!==generation)return;active=true;emit('connecting');}catch{if(g===generation)await end('blocked');}
  },
  getExternalJwt(){
   if(!active)return Promise.resolve(undefined);if(tokenFlight)return tokenFlight;const g=generation;
   tokenFlight=(async()=>{try{
    await check();if(!live(g))return;
    if(cached&&validToken(cached,clock(),initial.expiresAt))return cached.token;
    cached=null;const v=await bounded(signal=>token(initial.context,signal));if(!live(g))return;
    await check();if(!live(g))return;
    if(!validToken(v,clock(),initial.expiresAt)||v.walletCreated!==false)throw Error('token_invalid');cached={token:v.token,expiresAt:v.expiresAt};issued=true;return cached.token;
   }catch{if(active&&generation===g)void end('blocked');return undefined;}finally{tokenFlight=null;}})();return tokenFlight;
  },
  providerState(isAuthenticated,user){
   if(!isAuthenticated){if(authenticated||['verifying','no_wallet','wallet_recognised','verification_expired'].includes(phase))void end('disconnected');return Promise.resolve();}
   if(!active){if(!['idle','preparing','disconnecting','cleanup_failed'].includes(phase))void end('disconnected');return Promise.resolve();}
   if(!issued||!matchesWalletAuthIdentity(user,initial)){void end('blocked');return Promise.resolve();}
   const alreadyAuthenticated=authenticated;authenticated=true;providerUser=structuredClone(user);return alreadyAuthenticated?Promise.resolve():confirm();
  },
  async refresh(){if(!active)return;const g=generation;try{await check();if(live(g)&&proof&&proof.validUntil<=clock()){clearProof();emit('verification_expired');}}catch{if(active&&generation===g)await end('blocked');}},
  recheck(){return confirm(true);},
  end,close:()=>end('disconnected')
 };
}
