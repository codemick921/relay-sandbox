export const PRIVY_APP_ID='cmvypq4k600vm0hjvdqvg7hxn';
export function validLiveConnection(v,now=Date.now()){
 return !!v&&v.visible===true&&v.environment==='development'&&v.connection==='available'&&v.appId===PRIVY_APP_ID&&/^[a-f0-9]{64}$/.test(v.context??'')&&/^[a-f0-9-]{36}$/i.test(v.subject??'')&&Number.isSafeInteger(v.expiresAt)&&v.expiresAt>now&&v.expiresAt<=now+1800000;
}
export async function liveConnectionStatus(signal){
 const r=await fetch('/api/buyer-auth/connection',{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 if([401,403,404].includes(r.status))return null;
 if(!r.ok)throw connectionError('status_request_failed');const v=await r.json();if(!validLiveConnection(v))throw connectionError('access_unavailable');return v;
}
export async function connectionToken(context,signal){
 const r=await fetch('/api/buyer-auth/connect-token',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers:{'Content-Type':'application/json','X-Eupova-Connection':'1'},body:JSON.stringify({intent:'privy_connection_test',consent:true,context})});
 if(!r.ok)throw connectionError(r.status===429?'token_rate_limited':'token_request_failed');const v=await r.json();
 if(!validToken(v,Date.now())||v.walletCreated!==false)throw connectionError('token_response_invalid');
 return {token:v.token,expiresAt:v.expiresAt};
}
export function matchesPrivyIdentity(user,subject){
 if(!user||typeof user.id!=='string'||!user.id.startsWith('did:privy:')||!Array.isArray(user.linkedAccounts)||user.wallet)return false;
 const identities=user.linkedAccounts.filter(a=>a.type==='custom_auth');
 return identities.length===1&&identities[0].customUserId===subject&&!user.linkedAccounts.some(a=>['wallet','smart_wallet','cross_app'].includes(a.type));
}
// Codes are fixed here: never retain provider errors, tokens, account IDs or response bodies.
const diagnosticCodes=new Set(['access_unavailable','access_changed','status_request_failed','token_rate_limited','token_request_failed','token_response_invalid','token_received','connected','provider_disconnected','provider_error','identity_rejected','test_expired','connection_timeout','cleanup_failed','logout_timeout','disconnected']);
function connectionError(code){return Object.assign(new Error(code),{code});}
function validToken(value,now){return !!value&&typeof value.token==='string'&&value.token.length>0&&value.token.length<=8192&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>now&&value.expiresAt<=now+61000;}
// Keep the same valid JWT in memory for the SDK's equality check. Nothing is persisted.
export function createConnectionSession({initial,status=liveConnectionStatus,token=connectionToken,logout,onChange=()=>{},onDiagnostic=()=>{},clock=Date.now,logoutTimeoutMs=15000}){
 let active=false,generation=0,flight=null,ending=null,issued=false,phase='preparing',closed=false,starting=false,cached=null,leaseExpiresAt=initial.expiresAt;
 const startedAt=clock(),controllers=new Set();
 function diagnostic(code){if(diagnosticCodes.has(code))onDiagnostic({code,elapsedMs:Math.max(0,clock()-startedAt)});}
 function errorCode(error,fallback){return diagnosticCodes.has(error?.code)?error.code:fallback;}
 function change(next){if(phase===next)return;phase=next;onChange(next);}
 async function bounded(fn){const c=new AbortController();controllers.add(c);const t=setTimeout(()=>c.abort(),10000);try{return await fn(c.signal);}finally{clearTimeout(t);controllers.delete(c);}}
 async function end(reason='disconnected',code){
  active=false;cached=null;issued=false;generation++;for(const c of controllers)c.abort();
  if(ending)return ending;
  if(code)diagnostic(code);else if(reason==='disconnected')diagnostic('disconnected');
  change('disconnecting');ending=(async()=>{let timer;try{await Promise.race([Promise.resolve().then(logout),new Promise((_,reject)=>{timer=setTimeout(()=>reject(connectionError('logout_timeout')),logoutTimeoutMs);})]);change(reason);}catch(error){diagnostic(errorCode(error,'cleanup_failed'));change('cleanup_failed');}finally{clearTimeout(timer);ending=null;}})();return ending;
 }
 async function check(){
  const v=await bounded(status);
  if(!validLiveConnection(v,clock()))throw connectionError('access_unavailable');
  if(v.context!==initial.context||v.subject!==initial.subject||v.expiresAt>initial.expiresAt)throw connectionError('access_changed');
  leaseExpiresAt=Math.min(leaseExpiresAt,v.expiresAt);
  if(leaseExpiresAt<=clock()+5000)throw connectionError('test_expired');
  return v;
 }
 return {
  get phase(){return phase;},get active(){return active;},
  async start(){
   if(starting||closed||phase!=='preparing')return;starting=true;
   const g=++generation;
   try{await check();if(g!==generation||closed)return;active=true;issued=false;change('connecting');}catch(error){if(g===generation&&!closed)await end('expired',errorCode(error,'status_request_failed'));}
  },
  getExternalJwt(){
   if(!active||closed)return Promise.resolve(undefined);
   if(leaseExpiresAt<=clock()+5000){void end('expired','test_expired');return Promise.resolve(undefined);}
   if(flight)return flight;
   const g=generation;
   flight=(async()=>{
    let stage='status_request_failed';
    try{
     // Recheck permission even when a cached token is available; revocation still fails closed.
     await check();if(!active||g!==generation)return undefined;
     if(cached&&cached.expiresAt>clock()+5000&&cached.expiresAt<=leaseExpiresAt)return cached.token;
     cached=null;stage='token_request_failed';
     const value=await bounded(signal=>token(initial.context,signal));
     if(!active||g!==generation)return undefined;
     if(leaseExpiresAt<=clock()+5000){await end('expired','test_expired');return undefined;}
     if(!validToken(value,clock())||value.expiresAt>leaseExpiresAt||value.expiresAt<=clock()+5000)throw connectionError('token_response_invalid');
     cached={token:value.token,expiresAt:value.expiresAt};issued=true;diagnostic('token_received');return cached.token;
    }catch(error){if(active&&g===generation)void end('error',errorCode(error,stage));return undefined;}
    finally{flight=null;}
   })();return flight;
  },
  async refresh(){if(!active)return;const g=generation;try{await check();}catch(error){if(active&&g===generation)await end('expired',errorCode(error,'status_request_failed'));}},
  providerState(authenticated,user){
   if(!authenticated){if(active&&phase==='connected')void end('error','provider_disconnected');return;}
   if(!active||closed){void end(phase==='cleanup_failed'?'cleanup_failed':'disconnected');return;}
   if(!issued||!matchesPrivyIdentity(user,initial.subject)){void end('rejected','identity_rejected');return;}
   if(phase!=='connected')diagnostic('connected');change('connected');
  },
  end,
  close(){closed=true;return end('disconnected');}
 };
}
