// Verification only: no Privy SDK, wallet creation, signing or mutations.
import {createLocalJWKSet,jwtVerify} from 'jose';
import {QuoteError} from './direct-quote.mjs';
const check=(value,code)=>{if(!value)throw new QuoteError(code);};
export const validPrivyDid=value=>typeof value==='string'&&/^did:privy:[a-zA-Z0-9]{1,80}$/.test(value);
// Access-token objects are flat. Reject duplicate (including escaped) names rather
// than letting JSON.parse silently choose the last value of a security claim.
function flatObject(part,allowed){
 check(/^[a-zA-Z0-9_-]+$/.test(part),'privy_access_invalid');
 const source=Buffer.from(part,'base64url').toString('utf8'),result=JSON.parse(source);
 check(result&&typeof result==='object'&&!Array.isArray(result)&&Object.entries(result).every(([k,v])=>allowed.includes(k)&&v!==null&&['string','number','boolean'].includes(typeof v)),'privy_access_invalid');
 const names=new Set();
 for(let i=0;i<source.length;i++)if(source[i]==='"'){
  const start=i++;while(i<source.length){if(source[i]==='\\'){i+=2;continue;}if(source[i]==='"')break;i++;}
  const value=JSON.parse(source.slice(start,i+1));let j=i+1;while(/\s/.test(source[j]??'')&&j<source.length)j++;
  if(source[j]===':'){check(!names.has(value),'privy_access_invalid');names.add(value);}
 }
 return result;
}
export function createPrivyAccessVerifier({appId,trustedJwks,clock=Date.now,maxLifetimeSeconds=3600}={}){
 check(typeof appId==='string'&&/^[a-z0-9]{10,80}$/.test(appId)&&Number.isInteger(maxLifetimeSeconds)&&maxLifetimeSeconds>0&&maxLifetimeSeconds<=3600,'privy_verifier_configuration');
 const keys=structuredClone(trustedJwks?.keys);
 check(Array.isArray(keys)&&keys.length>0&&keys.length<=2&&new Set(keys.map(k=>k.kid)).size===keys.length&&keys.every(k=>
  k.kty==='EC'&&k.crv==='P-256'&&k.alg==='ES256'&&k.use==='sig'&&typeof k.kid==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(k.kid)&&
  /^[a-zA-Z0-9_-]{43}$/.test(k.x??'')&&/^[a-zA-Z0-9_-]{43}$/.test(k.y??'')&&Object.keys(k).every(n=>['kty','crv','alg','use','kid','x','y','key_ops'].includes(n))&&(!k.key_ops||JSON.stringify(k.key_ops)==='["verify"]')),'privy_verifier_configuration');
 const keySet=createLocalJWKSet({keys});
 return async token=>{
  try{
   check(typeof token==='string'&&token.length<=8192,'privy_access_invalid');
   const parts=token.split('.');check(parts.length===3,'privy_access_invalid');
   const header=flatObject(parts[0],['alg','kid','typ']),claims=flatObject(parts[1],['iss','aud','sub','sid','iat','exp','nbf','jti']);
   check(header.alg==='ES256'&&keys.some(k=>k.kid===header.kid)&&(!header.typ||['JWT','at+jwt'].includes(header.typ)),'privy_access_invalid');
   const now=clock();
   check(claims.iss==='privy.io'&&claims.aud===appId&&validPrivyDid(claims.sub)&&typeof claims.sid==='string'&&/^[a-zA-Z0-9:_-]{1,160}$/.test(claims.sid),'privy_access_invalid');
   check(Number.isSafeInteger(claims.iat)&&Number.isSafeInteger(claims.exp)&&claims.iat>0&&claims.iat*1000<=now+30000&&claims.exp*1000>now&&claims.exp>claims.iat&&claims.exp-claims.iat<=maxLifetimeSeconds,'privy_access_invalid');
   await jwtVerify(token,keySet,{algorithms:['ES256'],issuer:'privy.io',audience:appId,currentDate:new Date(now),requiredClaims:['sub','sid','iat','exp']});
   check(claims.exp*1000>clock(),'privy_access_invalid');
   return Object.freeze({did:claims.sub,sid:claims.sid,issuedAt:claims.iat*1000,expiresAt:claims.exp*1000});
  }catch{throw new QuoteError('privy_access_invalid');}
 };
}
export function createPrivyUserReader({appId,readOnlySecret,credentialAccess,fetchImpl=globalThis.fetch,timeoutMs=4000,maxBytes=65536,includeInventory=false}={}){
 // credentialAccess is an operator assertion. Verify the secret's access level in
 // Privy's dashboard before installation; the code cannot infer it from the key.
 check(/^[a-z0-9]{10,80}$/.test(appId??'')&&credentialAccess==='read-only'&&typeof readOnlySecret==='string'&&readOnlySecret.length>=16&&readOnlySecret.length<=512&&!/[\r\n:]/.test(readOnlySecret)&&Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=5000&&Number.isInteger(maxBytes)&&maxBytes>0&&maxBytes<=65536,'privy_reader_configuration');
 return async did=>{
  check(validPrivyDid(did),'privy_user_unavailable');
  const abort=new AbortController();let timer;
  const work=async()=>{
   const response=await fetchImpl('https://api.privy.io/v1/users/'+encodeURIComponent(did),{
    method:'GET',headers:{Accept:'application/json',Authorization:'Basic '+Buffer.from(appId+':'+readOnlySecret).toString('base64'),'privy-app-id':appId},
    credentials:'omit',redirect:'error',cache:'no-store',signal:abort.signal
   });
   check(response.ok&&!response.redirected&&/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')&&response.body,'privy_user_unavailable');
   const length=response.headers.get('content-length');check(length===null||(/^\d+$/.test(length)&&Number(length)<=maxBytes),'privy_user_unavailable');
   const reader=response.body.getReader();let size=0;const chunks=[];
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;check(size<=maxBytes,'privy_user_unavailable');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
   const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   check(data&&data.id===did&&Array.isArray(data.linked_accounts)&&data.linked_accounts.length<=100&&data.linked_accounts.every(a=>a&&typeof a==='object'&&!Array.isArray(a)&&typeof a.type==='string'),'privy_user_unavailable');
   check(data.is_guest===false&&(data.frozen_at===undefined||data.frozen_at===null),'privy_user_unavailable');
   // Do not retain email, phone, MFA methods, metadata or unrelated account data.
   return {id:data.id,linkedAccounts:data.linked_accounts.filter(a=>includeInventory||['custom_auth','wallet'].includes(a.type)).map(a=>!['custom_auth','wallet'].includes(a.type)?{type:a.type}:a.type==='custom_auth'?{type:a.type,subject:a.custom_user_id}:{type:a.type,address:a.address,chainType:a.chain_type,walletClientType:a.wallet_client_type,connectorType:a.connector_type,userCanSign:a.user_can_sign,delegated:a.delegated,imported:a.imported})};
  };
  try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new QuoteError('privy_user_unavailable'));},timeoutMs);})]);}
  catch{throw new QuoteError('privy_user_unavailable');}finally{clearTimeout(timer);abort.abort();}
 };
}
