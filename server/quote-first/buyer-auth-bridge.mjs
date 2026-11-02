// Disabled-by-default preparation for optional Privy JWT authentication.
// No Privy calls, customer writes, wallet creation or transaction capabilities.
import {createPublicKey, sign, randomUUID} from 'node:crypto';
export class BuyerAuthError extends Error {
 constructor(code){super(code);this.name='BuyerAuthError';this.code=code;}
}
const fail=code=>{throw new BuyerAuthError(code);};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const whole=n=>Number.isSafeInteger(n)&&n>0;
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Keys are injected from the deployment secret store, never generated or saved here.
// Rotating signing keys must NOT change an enrolment's opaque subject.
export function createBuyerAuthBridge({enabled=()=>false,issueEnabled=enabled,origin,issuer,audience,
 keyId,privateKey,retiringPublicKeys=[],resolveSession,resolveEnrollment,
 clock=Date.now,ttlSeconds=60}={}){
 let publicJwk=null,publicKeys=null;
 function configuration(){
  if(publicKeys)return;
  try{
   const site=new URL(origin),iss=new URL(issuer);
   if(site.protocol!=='https:'||site.origin!==origin||site.username||site.password||
      iss.origin!==origin||iss.username||iss.password||iss.search||iss.hash||
      typeof audience!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(audience)||
      typeof keyId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(keyId)||
      !Number.isInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>60||
      privateKey?.type!=='private'||privateKey.asymmetricKeyType!=='rsa'||
      privateKey.asymmetricKeyDetails?.modulusLength<2048||
      typeof resolveSession!=='function'||typeof resolveEnrollment!=='function')fail('buyer_auth_configuration');
   publicJwk={...createPublicKey(privateKey).export({format:'jwk'}),kid:keyId,alg:'RS256',use:'sig'};
   if(!Array.isArray(retiringPublicKeys)||retiringPublicKeys.length>2)fail('buyer_auth_configuration');
   const old=retiringPublicKeys.map(({kid,key})=>{
    if(!/^[a-zA-Z0-9_-]{8,80}$/.test(kid)||key?.type!=='public'||key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails?.modulusLength<2048)fail('buyer_auth_configuration');
    return {...key.export({format:'jwk'}),kid,alg:'RS256',use:'sig'};
   });
   if(new Set([keyId,...old.map(k=>k.kid)]).size!==old.length+1)fail('buyer_auth_configuration');
   publicKeys=[publicJwk,...old];
  }catch{fail('buyer_auth_configuration');}
 }
 const checkEnabled=()=>{if(enabled()!==true)fail('buyer_auth_disabled');};
 const checkIssuance=()=>{checkEnabled();if(issueEnabled()!==true)fail('buyer_auth_disabled');};
 async function identity(session){
  checkIssuance();
  const now=clock();if(!whole(now))fail('buyer_auth_clock');
  const s=await resolveSession(session);
  if(!s||typeof s.owner!=='string'||!s.owner.startsWith('customer:')||
     typeof s.binding!=='string'||s.binding.length<16||!whole(s.expiresAt)||s.expiresAt<=now)fail('sign_in_required');
  const e=await resolveEnrollment(s.owner);
  if(!e||e.owner!==s.owner||e.consent!==true||e.environment!=='development'||
     !uuid.test(e.subject??'')||!whole(e.expiresAt)||e.expiresAt<=now)fail('buyer_auth_not_enrolled');
  return {owner:s.owner,binding:s.binding,sessionExpiresAt:s.expiresAt,subject:e.subject,enrollmentExpiresAt:e.expiresAt};
 }
 return Object.freeze({
  publicKeys(){checkEnabled();configuration();return {keys:structuredClone(publicKeys)};},
  async issue(session,request){
   checkIssuance();configuration();
   if(!request||request.method!=='POST'||request.origin!==origin||request.fetchSite!=='same-origin'||
      request.contentType!=='application/json'||!request.body||
      Object.keys(request.body).length!==1||request.body.intent!=='buyer_wallet_setup')fail('buyer_auth_request_rejected');
   const before=await identity(session),after=await identity(session);
   if(!eq(before,after))fail('buyer_auth_context_changed');
   checkIssuance();
   const now=clock();if(!whole(now))fail('buyer_auth_clock');
   const iat=Math.floor(now/1000),exp=Math.min(iat+ttlSeconds,Math.floor(after.sessionExpiresAt/1000),Math.floor(after.enrollmentExpiresAt/1000));
   if(exp<=iat)fail('sign_in_required');
   const claims={iss:issuer,aud:audience,sub:after.subject,iat,nbf:iat,exp,jti:randomUUID()};
   const signingInput=enc({alg:'RS256',typ:'JWT',kid:keyId})+'.'+enc(claims);
   const signature=sign('RSA-SHA256',Buffer.from(signingInput),privateKey).toString('base64url');
   return {token:signingInput+'.'+signature,expiresAt:exp*1000,cacheControl:'no-store',walletCreated:false};
  }
 });
}
