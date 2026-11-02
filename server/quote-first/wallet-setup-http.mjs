// Read-only observer only. No token, creation, lease-write or pin-write endpoints.
import {createBuyerSessionReader} from './buyer-auth-session.mjs';
import {developmentAppId} from './buyer-auth-http.mjs';
import {createPrivyAccessVerifier,createPrivyUserReader} from './privy-wallet-reader.mjs';
import {setupTestEnrollment,createWalletSetupObserver,recoveryEvidenceState} from './wallet-setup-observer.mjs';
export const walletSetupObservePath='/api/buyer-wallet-setup/observe';
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache',Vary:'Cookie, Origin, Authorization','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));return true;};
function cookie(value){if(typeof value!=='string'||value.length>8192)return null;const parts=value.split(';').map(s=>s.trim()).filter(s=>s.startsWith('__Host-relay_sandbox='));const token=parts.length===1?parts[0].slice(21):'';return /^[a-f0-9]{64}$/.test(token)?token:null;}
export function createWalletSetupHttp({origin,enabled=()=>false,resolveSession,resolveEnrollment,observe,clock=Date.now,bodyTimeoutMs=5000}={}){
 const buckets=new Map();
 const allow=key=>{for(const[k,v]of buckets)if(v.until<=clock())buckets.delete(k);let b=buckets.get(key);if(!b){if(buckets.size>=128)return false;b={count:0,until:clock()+60000};buckets.set(key,b);}return ++b.count<=(key==='global'?60:8);};
 return async(req,res)=>{
  const path=String(req.url??'').split('?')[0];if(path!==walletSetupObservePath)return false;
  const hidden=()=>send(res,404,{error:'wallet_setup_disabled'});if(enabled()!==true)return hidden();
  try{
   const site=new URL(origin);
   if(site.protocol!=='https:'||site.origin!==origin||![resolveSession,resolveEnrollment,observe].every(f=>typeof f==='function'))return send(res,503,{error:'wallet_setup_unavailable'});
   if(req.url!==path||req.headers.host!==site.host||req.headers['x-forwarded-proto']!=='https'||req.headers.origin!==origin||req.headers['sec-fetch-site']!=='same-origin'||req.headers['content-encoding'])return send(res,403,{error:'request_rejected'});
   if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
   if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))return send(res,415,{error:'invalid_content_type'});
   if(!allow('global'))return send(res,429,{error:'too_many_requests'});
   const sessionToken=cookie(req.headers.cookie),session=sessionToken&&await resolveSession(sessionToken);
   const valid=s=>s&&Number.isSafeInteger(s.expiresAt)&&s.expiresAt>clock();
   const enrollment=valid(session)&&await resolveEnrollment(session.owner);
   if(!valid(session)||!enrollment||enrollment.owner!==session.owner||enrollment.environment!=='development'||enrollment.consent!==true||enrollment.expiresAt<=clock())return hidden();
   const before=JSON.stringify([session,enrollment]);
   if(!allow(session.owner))return send(res,429,{error:'too_many_requests'});
   const auth=req.headers.authorization;if(typeof auth!=='string'||auth.length>8200||!/^Bearer [a-zA-Z0-9_.-]+$/.test(auth))return send(res,401,{error:'privy_sign_in_required'});
   let timer,input;const read=async()=>{let size=0,chunks=[];for await(const part of req.iterator({destroyOnReturn:false})){const b=Buffer.from(part);size+=b.length;if(size>128)throw Error('size');chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
   try{input=await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>{req.destroy();reject(Error('timeout'));},bodyTimeoutMs);})]);}catch{req.resume();return send(res,400,{error:'invalid_request'});}finally{clearTimeout(timer);}
   if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length!==0)return send(res,400,{error:'invalid_request'});
   if(!enabled())return hidden();
   const result=await observe({sessionToken,accessToken:auth.slice(7)});
   const current=await resolveSession(sessionToken),latest=await resolveEnrollment(session.owner);
   if(!enabled()||!valid(current)||!latest||latest.expiresAt<=clock()||JSON.stringify([current,latest])!==before)return hidden();
   return send(res,200,result);
  }catch{return send(res,503,{error:'wallet_setup_unavailable'});}
 };
}
export function configuredWalletSetupObserver({origin,store,env=process.env,clock=Date.now,privyFetch=globalThis.fetch}={}){
 const enabled=()=>env.EUPOVA_WALLET_SETUP_OBSERVE_ENABLED==='true';
 if(!enabled())return createWalletSetupHttp({enabled});
 try{
  if(env.EUPOVA_PRIVY_QUOTE_APP_ID!==developmentAppId||env.EUPOVA_PRIVY_QUOTE_ENVIRONMENT!=='development'||env.EUPOVA_PRIVY_QUOTE_CREDENTIAL_ACCESS!=='read-only')throw Error('configuration');
  const resolveSession=createBuyerSessionReader(store),resolveEnrollment=setupTestEnrollment(JSON.parse(env.EUPOVA_WALLET_SETUP_TEST_ENROLLMENT??''),clock);
  const verifyAccessToken=createPrivyAccessVerifier({appId:developmentAppId,trustedJwks:JSON.parse(env.EUPOVA_PRIVY_ACCESS_PUBLIC_JWKS??''),clock});
  const readPrivyUser=createPrivyUserReader({appId:developmentAppId,readOnlySecret:env.EUPOVA_PRIVY_QUOTE_READONLY_SECRET,credentialAccess:'read-only',includeInventory:true,fetchImpl:privyFetch});
  const evidence=JSON.parse(env.EUPOVA_WALLET_RECOVERY_EVIDENCE??'null');
  const recoveryState=()=>recoveryEvidenceState(evidence,env.EUPOVA_WALLET_RECOVERY_EVIDENCE_HASH,clock(),developmentAppId);
  return createWalletSetupHttp({origin,enabled,resolveSession,resolveEnrollment,clock,observe:createWalletSetupObserver({enabled,resolveSession,resolveEnrollment,verifyAccessToken,readPrivyUser,clock,recoveryState})});
 }catch{return createWalletSetupHttp({origin,enabled});}
}
