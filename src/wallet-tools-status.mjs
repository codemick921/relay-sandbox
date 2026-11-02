// Read status only. Rendering this page must never issue a token or initialise Privy.
const paths={connection:'/api/buyer-auth/connection',wallet:'/api/buyer-wallet-auth/status',flow:'/api/buyer-wallet-flow/status'};
export async function readWalletToolsStatus({fetchImpl=fetch,signal,now=Date.now()}={}){
 const entries=await Promise.all(Object.entries(paths).map(async([key,path])=>{
  try{
   const r=await fetchImpl(path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
   if([401,403,404].includes(r.status))return[key,{status:'disabled'}];
   if(!r.ok)return[key,{status:'unavailable'}];
   const v=await r.json();
   const valid=v.visible===true&&v.environment==='development'&&v.appId==='cmvypq4k600vm0hjvdqvg7hxn'&&Number.isSafeInteger(v.expiresAt)&&v.expiresAt>now&&v.expiresAt<=now+1800000&&/^[a-f0-9]{64}$/.test(v.context??'')&&(key==='connection'?v.connection==='available':v.purpose==='wallet_auth'&&(key!=='flow'||v.flow===true));
   // Return no account identity, token, address or raw response to the overview.
   return[key,valid?{status:'available',expiresAt:v.expiresAt}:{status:'unavailable'}];
  }catch{return[key,{status:'unavailable'}];}
 }));
 return Object.fromEntries(entries);
}
