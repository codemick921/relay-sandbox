// Separate from the sample controller and the authentication-only connection test.
// No SDK imported here. The React boundary injects only createWallet and read state.
export const realWalletSetupAvailable=false; // Legacy sample/preparation flag; real flow uses its separate server capability.
const unknown=()=>({phase:'unknown',canRetry:false});
const fail=code=>Object.assign(new Error(code),{code});
const uuid=/^[a-f0-9-]{36}$/i;
function identityMatches(s,lease,{empty=false}={}){
 if(!s?.ready||!s.authenticated||s.user?.id!==lease.privyDid||!Array.isArray(s.user.linkedAccounts))return false;
 const accounts=s.user.linkedAccounts,ids=accounts.filter(a=>a.type==='custom_auth');
 if(ids.length!==1||ids[0].customUserId!==lease.subject||accounts.some(a=>!['custom_auth','wallet'].includes(a.type)))return false;
 const wallets=accounts.filter(a=>a.type==='wallet');
 return empty?wallets.length===0:wallets.length<=1;
}
function validLease(v,now){return v&&v.environment==='development'&&uuid.test(v.id??'')&&/^did:privy:[a-zA-Z0-9]{1,80}$/.test(v.privyDid??'')&&uuid.test(v.subject??'')&&/^[a-f0-9]{64}$/.test(v.context??'')&&Number.isSafeInteger(v.expiresAt)&&v.expiresAt>now+5000&&v.expiresAt<=now+1800000;}
export function createRealWalletSetupAdapter({enabled=()=>false,getLease,getSdkState,createWallet,observe,claimDispatch,withLock,journal,onChange=()=>{},clock=Date.now,timeoutMs=30000}={}){
 let active=true,flight=null,generation=0,attempted=false,state={phase:'idle',canRetry:false};
 const change=v=>{state=v;onChange(v);return v;};
 const bounded=async fn=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}};
 const valid=l=>active&&enabled()===true&&validLease(l,clock());
 const leaseNow=expected=>{const l=getLease();if(!valid(l)||JSON.stringify(l)!==JSON.stringify(expected)||!identityMatches(getSdkState(),l))throw fail('access_changed');return l;};
 async function inspectResult(lease,g){
  leaseNow(lease);
  const r=await bounded(()=>observe());leaseNow(lease);
  if(g!==generation||!active)return state;
  if(!r||!Number.isSafeInteger(r.validUntil)||r.validUntil<=clock()||r.validUntil>clock()+30000||r.pinned!==false||r.canQuote!==false||r.canCreateWallet!==false||r.canCreatePayment!==false)throw fail('invalid_observation');
  if(r.status==='candidate'&&/^0x[0-9a-f]{40}$/i.test(r.candidate?.address??'')&&r.candidate.chainType==='ethereum'&&r.candidate.userCanSign===true&&r.candidate.delegated===false&&r.candidate.imported===false)return change({phase:'observed',candidate:r.candidate,validUntil:r.validUntil,canRetry:false});
  if(r.status==='none')return change(attempted||journal?.has(lease.id)?unknown():{phase:'empty',canRetry:false});
  return change({phase:'blocked',canRetry:false});
 }
 function single(work){if(flight)return flight;flight=work().finally(()=>{flight=null;});return flight;}
 return {
  get state(){return state;},
  inspect(){return single(async()=>{const g=++generation;try{const l=structuredClone(getLease());if(!valid(l))throw fail('disabled');change({phase:'checking',canRetry:false});return await inspectResult(l,g);}catch{if(g===generation&&active)return change(attempted?unknown():{phase:'blocked',canRetry:false});return state;}});},
  create({consent=false}={}){return single(async()=>{
   const g=++generation;let dispatched=false;
   try{
    const l=structuredClone(getLease());
    if(!valid(l)||consent!==true||attempted||typeof claimDispatch!=='function'||typeof withLock!=='function'||!journal||typeof journal.has!=='function'||typeof journal.mark!=='function')throw fail('creation_unavailable');
    return await withLock(async held=>{
     if(!held)throw fail('busy');leaseNow(l);
     if(journal.has(l.id))return change(unknown());
     change({phase:'checking',canRetry:false});
     const observed=await inspectResult(l,g);
     if(observed.phase!=='empty')return observed;
     leaseNow(l);if(!identityMatches(getSdkState(),l,{empty:true}))throw fail('identity_changed');
     // Durable, server-owned CAS must consume the one-attempt permit BEFORE dispatch.
     // Browser journal/lock are only advisory; no in-memory production substitute.
     journal.mark(l.id);attempted=true;
     const permit=await bounded(()=>claimDispatch({leaseId:l.id,context:l.context,consent:true}));
     leaseNow(l);
     if(g!==generation||!identityMatches(getSdkState(),l,{empty:true})||permit?.state!=='consumed'||permit.durable!==true||permit.leaseId!==l.id||permit.context!==l.context||permit.maxDispatches!==1||permit.recoveryReviewed!==true||!Number.isSafeInteger(permit.expiresAt)||permit.expiresAt<=clock()+1000||permit.expiresAt>l.expiresAt)throw fail('permit_unavailable');
     change({phase:'creating',canRetry:false});dispatched=true;
     // Immediate identity guard above; callback address is deliberately ignored.
     await bounded(()=>{leaseNow(l);if(g!==generation||permit.expiresAt<=clock()+1000||!identityMatches(getSdkState(),l,{empty:true}))throw fail('access_changed');return createWallet({createAdditional:false});});
     if(g!==generation||!active)return state;
     return await inspectResult(l,g);
    });
   }catch{if(active&&g===generation)return change(dispatched||attempted?unknown():{phase:'blocked',canRetry:false});return state;}
  });},
  stop(){active=false;generation++;return change(attempted?unknown():{phase:'stopped',canRetry:false});}
 };
}
// Same-browser coordination, not a security boundary. Storage errors fail closed.
export function browserWalletSetupGuards({locks,storage}){
 const key=id=>'eupova-wallet-setup-attempt:'+id;
 return {withLock:fn=>{
  if(typeof locks?.request!=='function')throw fail('lock_unavailable');
  return locks.request('eupova-buying-wallet-setup',{ifAvailable:true},lock=>fn(!!lock));
 },journal:{has:id=>storage.getItem(key(id))!==null,mark:id=>{storage.setItem(key(id),'attempted');if(storage.getItem(key(id))!=='attempted')throw fail('journal_unavailable');}}};
}
