export const PRIVY_APP_ID='cmvypq4k600vm0hjvdqvg7hxn';
export function validLiveConnection(v,now=Date.now()){
 return !!v&&v.visible===true&&v.environment==='development'&&v.connection==='available'&&v.appId===PRIVY_APP_ID&&/^[a-f0-9]{64}$/.test(v.context??'')&&/^[a-f0-9-]{36}$/i.test(v.subject??'')&&Number.isSafeInteger(v.expiresAt)&&v.expiresAt>now&&v.expiresAt<=now+1800000;
}
export async function liveConnectionStatus(signal){
 const r=await fetch('/api/buyer-auth/connection',{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 if([401,403,404].includes(r.status))return null;
 if(!r.ok)throw Error('unavailable');const v=await r.json();if(!validLiveConnection(v))throw Error('unavailable');return v;
}
export async function connectionToken(context,signal){
 const r=await fetch('/api/buyer-auth/connect-token',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers:{'Content-Type':'application/json','X-Eupova-Connection':'1'},body:JSON.stringify({intent:'privy_connection_test',consent:true,context})});
 if(!r.ok)throw Error('connection_failed');const v=await r.json();
 if(typeof v.token!=='string'||v.token.length>8192||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=Date.now()||v.expiresAt>Date.now()+61000||v.walletCreated!==false)throw Error('connection_failed');
 return v.token;
}
export function matchesPrivyIdentity(user,subject){
 if(!user||typeof user.id!=='string'||!user.id.startsWith('did:privy:')||!Array.isArray(user.linkedAccounts)||user.wallet)return false;
 const identities=user.linkedAccounts.filter(a=>a.type==='custom_auth');
 return identities.length===1&&identities[0].customUserId===subject&&!user.linkedAccounts.some(a=>['wallet','smart_wallet','cross_app'].includes(a.type));
}
// No token is persisted or reported. The SDK receives it only while this lease is current.
export function createConnectionSession({initial,status=liveConnectionStatus,token=connectionToken,logout,onChange=()=>{},clock=Date.now,logoutTimeoutMs=15000}){
 let active=false,generation=0,flight=null,ending=null,issued=false,phase='preparing',closed=false,starting=false;
 const controllers=new Set();
 function change(next){phase=next;onChange(next);}
 async function bounded(fn){const c=new AbortController();controllers.add(c);const t=setTimeout(()=>c.abort(),10000);try{return await fn(c.signal);}finally{clearTimeout(t);controllers.delete(c);}}
 async function end(reason='disconnected'){
  active=false;generation++;for(const c of controllers)c.abort();
  if(ending)return ending;
  change('disconnecting');ending=(async()=>{let timer;try{await Promise.race([Promise.resolve().then(logout),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('logout_timeout')),logoutTimeoutMs);})]);change(reason);}catch{change('cleanup_failed');}finally{clearTimeout(timer);ending=null;}})();return ending;
 }
 async function check(){
  const v=await bounded(status);
  if(!validLiveConnection(v,clock())||v.context!==initial.context||v.subject!==initial.subject||v.expiresAt>initial.expiresAt)throw Error('context');
  return v;
 }
 return {
  get phase(){return phase;},get active(){return active;},
  async start(){
   if(starting||closed||phase!=='preparing')return;starting=true;
   const g=++generation;
   try{await check();if(g!==generation||closed)return;active=true;issued=false;change('connecting');}catch{await end('expired');}
  },
  getExternalJwt(){
   if(!active||closed||initial.expiresAt<=clock())return Promise.resolve(undefined);
   if(flight)return flight;
   const g=generation;
   flight=(async()=>{try{await check();if(!active||g!==generation)return undefined;const value=await bounded(signal=>token(initial.context,signal));if(!active||g!==generation||initial.expiresAt<=clock())return undefined;issued=true;return value;}catch{if(active&&g===generation)void end('error');return undefined;}finally{flight=null;}})();return flight;
  },
  async refresh(){if(!active)return;try{await check();}catch{await end('expired');}},
  providerState(authenticated,user){
   if(!authenticated)return;
   if(!active||closed){void end(phase==='cleanup_failed'?'cleanup_failed':'disconnected');return;}
   if(!issued||!matchesPrivyIdentity(user,initial.subject)){void end('rejected');return;}
   change('connected');
  },
  end,
  close(){closed=true;return end('disconnected');}
 };
}
