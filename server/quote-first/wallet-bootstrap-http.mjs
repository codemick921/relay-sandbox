// Separate read-only wallet authentication. No wallet creation/pinning/claim imports.
import {createHash,createPrivateKey} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createBuyerAuthBridge} from './buyer-auth-bridge.mjs';
import {createBuyerSessionReader} from './buyer-auth-session.mjs';
import {developmentAppId} from './buyer-auth-http.mjs';
import {connectionCsp} from './buyer-connection-http.mjs';
import {quoteTestEnrollment} from './buyer-wallet-resolver.mjs';
import {classifySetupWallet} from './wallet-setup-observer.mjs';
import {createPrivyAccessVerifier,createPrivyUserReader} from './privy-wallet-reader.mjs';
import publishedKeys from './buyer-auth-public-jwks.json' with {type:'json'};
export const bootstrapPaths=Object.freeze({status:'/api/buyer-wallet-auth/status',token:'/api/buyer-wallet-auth/token',verify:'/api/buyer-wallet-auth/verify',page:'/buyer-wallet-auth-test'});
const fingerprint=(s,e)=>createHash('sha256').update(JSON.stringify(['wallet-auth-v1',s,e])).digest('hex');
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',Pragma:'no-cache',Vary:'Cookie, Origin, Authorization','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const send=(res,code,body)=>{res.writeHead(code,headers);res.end(JSON.stringify(body));return true;};
const fail=()=>{throw Error('wallet_auth_unavailable');};
const cookie=value=>{if(typeof value!=='string'||value.length>8192)return null;const parts=value.split(';').map(p=>p.trim()).filter(p=>p.startsWith('__Host-relay_sandbox='));const token=parts.length===1?parts[0].slice(21):'';return /^[a-f0-9]{64}$/.test(token)?token:null;};
export function createWalletBootstrapHttp({origin,enabled=()=>false,resolveSession,resolveEnrollment,issue,verifyAccessToken,readPrivyUser,document,clock=Date.now,timeoutMs=5000}={}){
 const buckets=new Map();
 const allow=key=>{for(const[k,v]of buckets)if(v.until<=clock())buckets.delete(k);let b=buckets.get(key);if(!b){if(buckets.size>=256)return false;b={count:0,until:clock()+60000};buckets.set(key,b);}return ++b.count<=(key==='global'?120:key.startsWith('token:')?6:40);};
 async function identity(token){
  if(enabled()!==true)fail();const s=structuredClone(await resolveSession(token));
  if(!s||typeof s.owner!=='string'||typeof s.binding!=='string'||s.binding.length<16||!Number.isSafeInteger(s.expiresAt)||s.expiresAt<=clock())fail();
  const raw=structuredClone(await resolveEnrollment(s.owner));if(!raw)fail();
  const {environment,...record}=raw;if(environment!=='development')fail();
  const e=await quoteTestEnrollment(record,clock)(s.owner);if(!e||enabled()!==true||s.expiresAt<=clock())fail();
  return {session:s,enrollment:e,context:fingerprint(s,e),expiresAt:Math.min(s.expiresAt,e.expiresAt)};
 }
 async function unchanged(token,previous){const next=await identity(token);if(next.context!==previous.context)fail();return next;}
 return async(req,res)=>{
  const route=String(req.url??'').split('?')[0];if(!Object.values(bootstrapPaths).includes(route))return false;
  const hidden=()=>send(res,404,{error:'wallet_auth_disabled'});if(enabled()!==true)return hidden();
  let timer;
  try{
   const site=new URL(origin),page=route===bootstrapPaths.page,post=[bootstrapPaths.token,bootstrapPaths.verify].includes(route),verify=route===bootstrapPaths.verify;
   if(site.protocol!=='https:'||site.origin!==origin||![resolveSession,resolveEnrollment,issue,verifyAccessToken,readPrivyUser,document].every(f=>typeof f==='function'))fail();
   if(req.url!==route||req.headers.host!==site.host||req.headers['x-forwarded-proto']!=='https'||req.headers['content-encoding']||(!verify&&req.headers.authorization)||(req.headers.origin&&req.headers.origin!==origin)||!(page?['none','same-origin']:['same-origin']).includes(req.headers['sec-fetch-site']))return send(res,403,{error:'request_rejected'});
   if(req.method!==(post?'POST':'GET'))return send(res,405,{error:'method_not_allowed'});
   if(post&&(req.headers.origin!==origin||req.headers['x-eupova-wallet-auth']!=='1'||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')))return send(res,403,{error:'request_rejected'});
   if(!allow('global'))return send(res,429,{error:'too_many_requests'});
   const sessionToken=cookie(req.headers.cookie);if(!sessionToken)return hidden();
   let before;try{before=await identity(sessionToken);}catch{return hidden();}
   const {enrollment:e,session:s}=before;
   if(!allow((route===bootstrapPaths.token?'token:':'read:')+s.owner))return send(res,429,{error:'too_many_requests'});
   const status={visible:true,environment:'development',purpose:'wallet_auth',appId:developmentAppId,context:before.context,subject:e.subject,privyDid:e.privyDid,expectedAddress:e.buyingAddress,expiresAt:before.expiresAt};
   if(page){const html=await document();await unchanged(sessionToken,before);res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':connectionCsp});res.end(html);return true;}
   if(!post){await unchanged(sessionToken,before);return send(res,200,status);}
   const read=async()=>{let size=0,chunks=[];for await(const part of req.iterator({destroyOnReturn:false})){const b=Buffer.from(part);size+=b.length;if(size>512)throw Error('size');chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
   let input;try{input=await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>{req.destroy();reject(Error('timeout'));},timeoutMs);})]);}catch{req.resume();return send(res,400,{error:'invalid_request'});}finally{clearTimeout(timer);}
   if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='consent,context,intent'||input.intent!=='wallet_auth'||input.consent!==true||input.context!==before.context)return send(res,409,{error:'context_changed'});
   await unchanged(sessionToken,before);
   if(!verify){const result=await issue(sessionToken,before.context);await unchanged(sessionToken,before);if(!result||typeof result.token!=='string'||result.token.length>8192||result.walletCreated!==false||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=clock()||result.expiresAt>Math.min(clock()+61000,before.expiresAt))fail();return send(res,200,{token:result.token,expiresAt:result.expiresAt,walletCreated:false});}
   const auth=req.headers.authorization;if(typeof auth!=='string'||auth.length>8200||!/^Bearer [a-zA-Z0-9_.-]+$/.test(auth))return send(res,401,{error:'sign_in_required'});
   const access=await verifyAccessToken(auth.slice(7));if(access.did!==e.privyDid||access.expiresAt<=clock())fail();
   const user=await readPrivyUser(access.did),observedAt=clock(),result=classifySetupWallet(user,e);
   const matches=e.buyingAddress===null?result.status==='none':result.status==='candidate'&&result.candidate.address.toLowerCase()===e.buyingAddress;
   await unchanged(sessionToken,before);
   if(!matches||access.expiresAt<=clock())return send(res,409,{error:'wallet_not_recognised'});
   const validUntil=Math.min(observedAt+15000,access.expiresAt,before.expiresAt);if(validUntil<=clock())fail();
   return send(res,200,{status:e.buyingAddress===null?'no_wallet':'wallet_recognised',context:before.context,address:e.buyingAddress,observedAt,validUntil,canQuote:false,canCreateWallet:false,canCreatePayment:false});
  }catch{return send(res,503,{error:'wallet_auth_unavailable'});}finally{clearTimeout(timer);}
 };
}
export function configuredWalletBootstrapHttp({origin,store,staticRoot,env=process.env,clock=Date.now,privyFetch=globalThis.fetch,trustedKeys=publishedKeys}={}){
 const enabled=()=>['EUPOVA_WALLET_AUTH_DEV_ENABLED','EUPOVA_BUYER_AUTH_DEV_ENABLED','EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED'].every(k=>env[k]==='true');
 if(!enabled())return createWalletBootstrapHttp({enabled});
 try{
  if(env.EUPOVA_BUYER_AUTH_APP_ID!==developmentAppId||env.EUPOVA_BUYER_AUTH_ENVIRONMENT!=='development'||env.EUPOVA_PRIVY_QUOTE_CREDENTIAL_ACCESS!=='read-only')fail();
  const resolveSession=createBuyerSessionReader(store),resolveEnrollment=quoteTestEnrollment(JSON.parse(env.EUPOVA_WALLET_AUTH_TEST_ENROLLMENT??''),clock);
  const privateKey=createPrivateKey(env.EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM??'');
  const options={enabled,issueEnabled:enabled,origin,issuer:origin+'/auth/buyer',audience:developmentAppId,keyId:env.EUPOVA_BUYER_AUTH_KEY_ID,privateKey,resolveSession,resolveEnrollment,clock};
  const key=createBuyerAuthBridge(options).publicKeys().keys[0];if(trustedKeys.keys.length!==1||!['kid','kty','alg','use','n','e'].every(k=>key[k]===trustedKeys.keys[0][k]))fail();
  return createWalletBootstrapHttp({origin,enabled,resolveSession,resolveEnrollment,clock,
   document:()=>readFile(path.join(staticRoot,'buyer-wallet-auth.html')),
   verifyAccessToken:createPrivyAccessVerifier({appId:developmentAppId,trustedJwks:JSON.parse(env.EUPOVA_PRIVY_ACCESS_PUBLIC_JWKS??''),clock}),
   readPrivyUser:createPrivyUserReader({appId:developmentAppId,readOnlySecret:env.EUPOVA_PRIVY_QUOTE_READONLY_SECRET,credentialAccess:'read-only',includeInventory:true,fetchImpl:privyFetch}),
   issue:async(token,context)=>{
    const bound=async t=>{const s=await resolveSession(t),e=s&&await resolveEnrollment(s.owner);return s&&e&&fingerprint(s,e)===context?s:null;};
    return createBuyerAuthBridge({...options,resolveSession:bound}).issue(token,{method:'POST',origin,fetchSite:'same-origin',contentType:'application/json',body:{intent:'buyer_wallet_setup'}});
   }
  });
 }catch{return createWalletBootstrapHttp({origin,enabled});}
}
