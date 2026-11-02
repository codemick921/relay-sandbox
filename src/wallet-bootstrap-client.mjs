// A separate lifecycle: the existing auth-only controller remains unchanged.
import {WalletAuthFailure,safeWalletAuthDiagnostic} from '../shared/wallet-auth-diagnostics.mjs';
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
async function jsonRequest(path,stage,signal,options={}){
 const r=await fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal,...options});
 if(!r.ok){let detail=null;try{detail=safeWalletAuthDiagnostic((await r.json())?.diagnostic);}catch{}
  throw new WalletAuthFailure(detail?.stage??stage,detail?.code??(r.status===429?'rate_limited':'unavailable'));}
 return r.json();
}
export const walletAuthStatus=signal=>jsonRequest('/api/buyer-wallet-auth/status','eligibility',signal);
export const walletAuthToken=(context,signal)=>jsonRequest('/api/buyer-wallet-auth/token','token_issuance',signal,{method:'POST',headers:{'Content-Type':'application/json','X-Eupova-Wallet-Auth':'1'},body:JSON.stringify({intent:'wallet_auth',consent:true,context})});
export const walletAuthVerify=(context,accessToken,signal)=>jsonRequest('/api/buyer-wallet-auth/verify','server_inventory',signal,{method:'POST',headers:{'Content-Type':'application/json','X-Eupova-Wallet-Auth':'1',Authorization:'Bearer '+accessToken},body:JSON.stringify({intent:'wallet_auth',consent:true,context})});
export function createWalletAuthSession({initial,status=walletAuthStatus,token=walletAuthToken,verify=walletAuthVerify,getAccessToken,logout,getProviderState=()=>({ready:false}),onChange=()=>{},clock=Date.now,timeoutMs=10000,observationMs=25,settleMs=1000}={}){
 initial=Object.freeze({...initial});
 let phase='idle',active=false,generation=0,cached=null,tokenFlight=null,proofFlight=null,ending=null,authenticated=false,issued=false,proof=null,proofTimer=null,providerUser=null;
 let exchangePending=false,exchangeConfirmed=false,failure=null,cleanup='not_checked',lateCleanups=0;
 const history=[],controllers=new Set();
 const snapshot=()=>({phase,proof:proof?{...proof}:null,diagnostics:{failure:failure?{...failure}:null,cleanup,remoteSession:'unconfirmed',steps:history.map(x=>({...x}))}});
 const emit=p=>{phase=p;onChange(snapshot());};
 const record=(stage,result)=>{history.push({stage,result});if(history.length>24)history.shift();onChange(snapshot());};
 const noteFailure=(error,stage)=>{const d=error instanceof WalletAuthFailure?safeWalletAuthDiagnostic(error.diagnostic):null;if(!failure)failure=d??{stage,code:'failed'};record(failure.stage,'failed');};
 const clearProof=()=>{proof=null;clearTimeout(proofTimer);};
 async function bounded(stage,fn){
  const c=new AbortController();controllers.add(c);let timer;
  try{return await Promise.race([Promise.resolve().then(()=>fn(c.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{c.abort();reject(new WalletAuthFailure(stage,'timeout'));},timeoutMs);})]);}
  catch(e){throw e instanceof WalletAuthFailure?e:new WalletAuthFailure(stage);}
  finally{clearTimeout(timer);controllers.delete(c);}
 }
 async function step(stage,fn){const g=generation;record(stage,'checking');const v=await bounded(stage,fn);if(g===generation)record(stage,'passed');return v;}
 async function check(){const v=await step('eligibility',status);if(!validWalletAuthStatus(v,clock())||JSON.stringify(v)!==JSON.stringify(initial)||v.expiresAt<=clock()+5000)throw new WalletAuthFailure('eligibility','access_changed');}
 async function disconnectBrowser(stage){
  const g=generation;
  cleanup='checking';record(stage,'checking');
  await bounded(stage,()=>logout());
  // SDK logout resolution does not prove browser state changed or remote revocation.
  await bounded(stage,async signal=>{
   let consecutive=0,retries=0;
   while(!signal.aborted){
    await new Promise(r=>setTimeout(r,observationMs));if(signal.aborted)break;
    const v=getProviderState();
    if(v?.ready===true&&v.authenticated===false&&v.user===null&&!exchangePending){if(++consecutive>=Math.max(2,Math.ceil(settleMs/observationMs)))return;}
    else{consecutive=0;if(v?.ready===true&&v.authenticated===true&&retries<2){retries++;await logout();}}
   }
   throw new WalletAuthFailure(stage,'local_state_unconfirmed');
  });
  if(g!==generation)throw new WalletAuthFailure(stage,'access_changed');
  cleanup='browser_signed_out';record(stage,'passed');
 }
 async function end(reason='disconnected'){
  active=false;generation++;cached=null;issued=false;exchangeConfirmed=false;authenticated=false;providerUser=null;clearProof();for(const c of controllers)c.abort();
  if(ending)return ending;emit('disconnecting');
  ending=(async()=>{try{await disconnectBrowser('disconnect');emit(reason);}catch(e){cleanup=exchangePending?'authentication_pending':'unconfirmed';noteFailure(e,'disconnect');emit('cleanup_failed');}finally{ending=null;}})();return ending;
 }
 async function block(error,stage){noteFailure(error,stage);await end('blocked');}
 const live=g=>active&&generation===g&&initial.expiresAt>clock()+5000;
 async function confirm(force=false){
  if(!active||!authenticated||!issued)return;
  if(proofFlight)return proofFlight;
  if(!force&&proof&&proof.validUntil>clock())return;
  clearProof();emit('verifying');const g=generation;
  proofFlight=(async()=>{try{
   await check();if(!live(g))return;
   const access=await step('access_token',()=>getAccessToken());if(!live(g))return;
   if(typeof access!=='string'||access.length===0||access.length>8192)throw new WalletAuthFailure('access_token','invalid');
   const result=await step('server_inventory',signal=>verify(initial.context,access,signal));if(!live(g))return;
   await check();if(!live(g))return;
   if(!authenticated||!matchesWalletAuthIdentity(providerUser,initial)||!validWalletAuthProof(result,initial,clock()))throw new WalletAuthFailure('proof_validation','invalid');
   record('proof_validation','passed');proof={status:result.status,address:result.address,observedAt:result.observedAt,validUntil:result.validUntil};emit(result.status);
   proofTimer=setTimeout(()=>{if(live(g)){clearProof();emit('verification_expired');}},Math.max(0,result.validUntil-clock()));proofTimer.unref?.();
  }catch(e){if(live(g))await block(e,'proof_validation');}finally{proofFlight=null;}})();return proofFlight;
 }
 const api={
  get phase(){return phase;},get active(){return active;},get diagnostics(){return snapshot().diagnostics;},get proof(){if(proof&&proof.validUntil<=clock())clearProof();return proof?{...proof}:null;},
  async start(consent=false){
   if(phase!=='idle'||consent!==true)return;
   const g=++generation;emit('preparing');
   try{if(!validWalletAuthStatus(initial,clock()))throw new WalletAuthFailure('eligibility','invalid');await check();await disconnectBrowser('session_reset');if(g!==generation)return;await check();if(g!==generation)return;active=true;cleanup='not_checked';emit('connecting');}catch(e){if(g===generation)await block(e,'session_reset');}
  },
  getExternalJwt(){
   if(!active)return Promise.resolve(undefined);if(tokenFlight)return tokenFlight;const g=generation;
   tokenFlight=(async()=>{try{
    await check();if(!live(g))return;
    if(cached&&validToken(cached,clock(),initial.expiresAt))return cached.token;
    cached=null;const v=await step('token_issuance',signal=>token(initial.context,signal));if(!live(g))return;
    await check();if(!live(g))return;
    if(!validToken(v,clock(),initial.expiresAt)||v.walletCreated!==false)throw new WalletAuthFailure('token_issuance','invalid');
    cached={token:v.token,expiresAt:v.expiresAt};issued=true;exchangePending=true;record('provider_authentication','checking');return cached.token;
   }catch(e){if(active&&generation===g)void block(e,'token_issuance');return undefined;}finally{tokenFlight=null;}})();return tokenFlight;
  },
  providerAuthenticated(){
   // Privy calls this BEFORE committing its user/authenticated state. Do not verify here.
   exchangePending=false;
   if(active&&issued){exchangeConfirmed=true;record('provider_authentication','callback_received');}
   else if(!active){cleanup='unconfirmed';if(!ending&&lateCleanups++<2)void end('disconnected');else if(!ending){noteFailure(new WalletAuthFailure('disconnect','local_state_unconfirmed'),'disconnect');emit('cleanup_failed');}}
  },
  providerError(){exchangePending=false;if(active)void block(new WalletAuthFailure('provider_authentication'),'provider_authentication');},
  providerState(isAuthenticated,user){
   if(!isAuthenticated){if(authenticated||['verifying','no_wallet','wallet_recognised','verification_expired'].includes(phase))void block(new WalletAuthFailure('provider_authentication','unexpected_session'),'provider_authentication');return Promise.resolve();}
   if(!active){
    if(!['idle','preparing'].includes(phase)){
     cleanup='unconfirmed';
     if(!ending&&lateCleanups++<2)void end('disconnected');
     else if(!ending){noteFailure(new WalletAuthFailure('disconnect','local_state_unconfirmed'),'disconnect');emit('cleanup_failed');}
    }
    return Promise.resolve();
   }
   exchangePending=false;
   if(!issued||!exchangeConfirmed||!matchesWalletAuthIdentity(user,initial)){void block(new WalletAuthFailure('client_identity','not_recognised'),'client_identity');return Promise.resolve();}
   record('provider_authentication','passed');const alreadyAuthenticated=authenticated;authenticated=true;providerUser=structuredClone(user);record('client_identity','passed');return alreadyAuthenticated?Promise.resolve():confirm();
  },
  async refresh(){if(!active)return;const g=generation;try{await check();if(live(g)&&proof&&proof.validUntil<=clock()){clearProof();emit('verification_expired');}}catch(e){if(active&&generation===g)await block(e,'eligibility');}},
  timeout(){return block(new WalletAuthFailure(phase==='connecting'?'provider_authentication':phase==='verifying'?'server_inventory':'session_reset','timeout'),'provider_authentication');},
  recheck(){return confirm(true);},end,close:()=>end('disconnected')
 };
 return api;
}
