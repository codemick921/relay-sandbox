import {createRestrictedSetupDatabase} from './wallet-setup-database.mjs';
// Disabled-by-default preparation. Requires a separately supplied restricted DB.
import {createBuyerSessionReader} from './buyer-auth-session.mjs';
import {developmentAppId} from './buyer-auth-http.mjs';
import {createPrivyAccessVerifier,createPrivyUserReader} from './privy-wallet-reader.mjs';
import {setupTestEnrollment,createWalletSetupVerification,recoveryEvidenceState} from './wallet-setup-observer.mjs';
import {createPostgresWalletSetupClaims,createWalletSetupClaimService} from './wallet-setup-claims.mjs';
export const walletSetupClaimPaths={claim:'/api/buyer-wallet-setup/claim',status:'/api/buyer-wallet-setup/claim-status'};
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache',Vary:'Cookie, Origin, Authorization','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));return true;};
export function createWalletSetupClaimHttp({enabled=()=>false,origin,service,clock=Date.now,bodyTimeoutMs=5000}={}){
 const buckets=new Map();
 return async(req,res)=>{
  const path=String(req.url??'').split('?')[0],action=Object.entries(walletSetupClaimPaths).find(([,value])=>path===value)?.[0];
  if(!action)return false;
  if(enabled()!==true)return send(res,404,{error:'wallet_setup_disabled'});
  try{
   if(!service||new URL(origin).origin!==origin||!origin.startsWith('https://'))return send(res,503,{error:'wallet_setup_unavailable'});
   if(req.url!==path||req.headers.host!==new URL(origin).host||req.headers['x-forwarded-proto']!=='https'||req.headers.origin!==origin||req.headers['sec-fetch-site']!=='same-origin'||req.headers['content-encoding'])return send(res,403,{error:'request_rejected'});
   if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
   if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))return send(res,415,{error:'invalid_content_type'});
   const cookies=typeof req.headers.cookie==='string'&&req.headers.cookie.length<=8192?req.headers.cookie.split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-relay_sandbox=')):[];
   const sessionToken=cookies.length===1?cookies[0].slice(21):'',auth=req.headers.authorization;
   if(!/^[a-f0-9]{64}$/.test(sessionToken)||typeof auth!=='string'||auth.length>8200||!/^Bearer [a-zA-Z0-9_.-]+$/.test(auth))return send(res,401,{error:'sign_in_required'});
   for(const[k,v]of buckets)if(v.until<=clock())buckets.delete(k);
   for(const key of ['global',sessionToken]){let b=buckets.get(key);if(!b){if(buckets.size>=128)return send(res,429,{error:'too_many_requests'});b={count:0,until:clock()+60000};buckets.set(key,b);}if(++b.count>(key==='global'?60:8))return send(res,429,{error:'too_many_requests'});}
   let timer,input;const read=async()=>{let size=0,chunks=[];for await(const part of req.iterator({destroyOnReturn:false})){const b=Buffer.from(part);size+=b.length;if(size>256)throw Error();chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
   try{input=await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>{req.destroy();reject(Error());},bodyTimeoutMs);})]);}catch{req.resume();return send(res,400,{error:'invalid_request'});}finally{clearTimeout(timer);}
   const keys=action==='claim'?['leaseId','context','consent']:[];
   if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length!==keys.length||Object.keys(input).some(k=>!keys.includes(k)))return send(res,400,{error:'invalid_request'});
   if(!enabled())return send(res,404,{error:'wallet_setup_disabled'});
   const actor={sessionToken,accessToken:auth.slice(7)};
   const result=await service[action](actor,input);
   if(!enabled())return send(res,404,{error:'wallet_setup_disabled'});
   return send(res,result?.state==='already_consumed'?409:200,result);
  }catch{return send(res,503,{error:'wallet_setup_unavailable',canRetry:false});}
 };
}
export function configuredWalletSetupClaims({origin,store,claimDb=null,env=process.env,clock=Date.now,privyFetch=globalThis.fetch}={}){
 const enabled=()=>env.EUPOVA_WALLET_SETUP_CLAIMS_ENABLED==='true';
 if(!enabled())return createWalletSetupClaimHttp({enabled});
 try{
  if(!claimDb&&env.EUPOVA_WALLET_SETUP_DATABASE_URL)claimDb=createRestrictedSetupDatabase(env.EUPOVA_WALLET_SETUP_DATABASE_URL);
  if(!claimDb||env.EUPOVA_PRIVY_QUOTE_APP_ID!==developmentAppId||env.EUPOVA_PRIVY_QUOTE_ENVIRONMENT!=='development'||env.EUPOVA_PRIVY_QUOTE_CREDENTIAL_ACCESS!=='read-only')throw Error();
  const resolveSession=createBuyerSessionReader(store),resolveEnrollment=setupTestEnrollment(JSON.parse(env.EUPOVA_WALLET_SETUP_TEST_ENROLLMENT??''),clock);
  const evidence=JSON.parse(env.EUPOVA_WALLET_RECOVERY_EVIDENCE??'null'),evidenceHash=env.EUPOVA_WALLET_RECOVERY_EVIDENCE_HASH;
  const recoveryEvidence=()=>({state:recoveryEvidenceState(evidence,evidenceHash,clock(),developmentAppId),hash:evidenceHash,expiresAt:evidence?.expiresAt});
  const verifyFresh=createWalletSetupVerification({enabled,resolveSession,resolveEnrollment,clock,
   verifyAccessToken:createPrivyAccessVerifier({appId:developmentAppId,trustedJwks:JSON.parse(env.EUPOVA_PRIVY_ACCESS_PUBLIC_JWKS??''),clock}),
   readPrivyUser:createPrivyUserReader({appId:developmentAppId,readOnlySecret:env.EUPOVA_PRIVY_QUOTE_READONLY_SECRET,credentialAccess:'read-only',includeInventory:true,fetchImpl:privyFetch})});
  const claims=createPostgresWalletSetupClaims({db:claimDb,clock});
  const handler=createWalletSetupClaimHttp({origin,enabled,clock,service:createWalletSetupClaimService({enabled,appId:developmentAppId,claims,verifyFresh,resolveSession,resolveEnrollment,recoveryEvidence,clock})});
  handler.available=()=>enabled()&&recoveryEvidence().state==='operator_reviewed';return handler;
 }catch{return createWalletSetupClaimHttp({origin,enabled});}
}
