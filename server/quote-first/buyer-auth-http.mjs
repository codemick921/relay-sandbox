import {createPrivateKey} from 'node:crypto';
import {createBuyerAuthBridge,BuyerAuthError} from './buyer-auth-bridge.mjs';
import {createBuyerSessionReader,developmentEnrollment} from './buyer-auth-session.mjs';
export const buyerAuthPaths=Object.freeze({jwks:'/api/buyer-auth/jwks',token:'/api/buyer-auth/token'});
// Exact approved development app. This is a public identifier, not a credential.
export const developmentAppId='cmvypq4k600vm0hjvdqvg7hxn';
const statusFor={buyer_auth_disabled:404,buyer_auth_configuration:503,buyer_auth_clock:503,
 sign_in_required:401,buyer_auth_not_enrolled:403,buyer_auth_request_rejected:403,buyer_auth_context_changed:409};
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
 Pragma:'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Cookie, Origin'};
const send=(res,status,data)=>{res.writeHead(status,headers);res.end(JSON.stringify(data));return true;};
function sessionCookie(value){
 if(typeof value!=='string'||value.length>8192)return null;
 const matches=value.split(';').map(s=>s.trim()).filter(s=>s.startsWith('__Host-relay_sandbox='));
 if(matches.length!==1)return null;
 const token=matches[0].slice('__Host-relay_sandbox='.length);return /^[a-f0-9]{64}$/.test(token)?token:null;
}
async function readBody(req){
 let size=0;const chunks=[];
 // Preserve the stream on an oversize body so the caller can return a bounded
 // error instead of accidentally destroying the socket before its response.
 for await(const part of req.iterator({destroyOnReturn:false})){
  const chunk=Buffer.from(part);size+=chunk.length;
  if(size>512){req.resume();return {oversized:true};}chunks.push(chunk);
 }
 try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));return data&&typeof data==='object'&&!Array.isArray(data)?data:null;}catch{return null;}
}

// No configuration means 404 and zero DB/key/provider access. Endpoint metadata is
// derived here, not accepted from browser JSON. Each token rechecks the actual session.
export function createBuyerAuthHttp({origin,store,enabled=()=>false,issueEnabled=()=>false,bridge,resolveSession}={}){
 return async(req,res)=>{
  const rawPath=String(req.url??'').split('?')[0];
  if(!Object.values(buyerAuthPaths).includes(rawPath))return false;
  if(enabled()!==true)return send(res,404,{error:'buyer_auth_disabled'});
  try{
   const site=new URL(origin);
   if(site.protocol!=='https:'||site.origin!==origin||!bridge||typeof resolveSession!=='function'||typeof store?.rate!=='function')
    throw new BuyerAuthError('buyer_auth_configuration');
   if(req.url!==rawPath||req.headers.host!==site.host||req.headers['x-forwarded-proto']!=='https')
    return send(res,403,{error:'buyer_auth_request_rejected'});
   if(rawPath===buyerAuthPaths.jwks){
    if(req.method!=='GET')return send(res,405,{error:'method_not_allowed'});
    return send(res,200,bridge.publicKeys());
   }
   if(issueEnabled()!==true)return send(res,404,{error:'buyer_auth_disabled'});
   if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
   if(req.headers.origin!==origin||req.headers['sec-fetch-site']!=='same-origin'||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')||
      req.headers.authorization||req.headers['content-encoding'])return send(res,403,{error:'buyer_auth_request_rejected'});
   // Database-backed counters are shared across instances and never touch customer rows.
   await store.rate('buyer-auth:global',60,60);
   const token=sessionCookie(req.headers.cookie),session=token&&await resolveSession(token);
   if(!session)return send(res,401,{error:'sign_in_required'});
   await store.rate('buyer-auth:'+session.owner,6,60);
   const input=await readBody(req);
   if(input?.oversized===true)return send(res,413,{error:'request_too_large'});
   if(!input||Object.keys(input).length!==1||input.intent!=='buyer_wallet_setup')return send(res,400,{error:'invalid_setup_request'});
   // A rotated account/session between the HTTP gate and issuance cannot gain a token.
   const current=await resolveSession(token);
   if(!current||current.owner!==session.owner||current.binding!==session.binding)return send(res,409,{error:'buyer_auth_context_changed'});
   if(enabled()!==true||issueEnabled()!==true)return send(res,404,{error:'buyer_auth_disabled'});
   return send(res,200,await bridge.issue(token,{method:req.method,origin:req.headers.origin,
    fetchSite:req.headers['sec-fetch-site'],contentType:'application/json',body:input}));
  }catch(e){
   const status=e instanceof BuyerAuthError?statusFor[e.code]??503:e.status===429?429:503;
   if(status===429)res.setHeader('Retry-After','60');
   return send(res,status,{error:e instanceof BuyerAuthError?e.code:status===429?'too_many_requests':'buyer_auth_unavailable'});
  }
 };
}

// Reading these NEW flags never changes existing payment flags. No key is parsed
// unless development auth is explicitly enabled; invalid config closes this route only.
export function configuredBuyerAuthHttp({origin,store,env=process.env,clock=Date.now}={}){
 const enabled=()=>env.EUPOVA_BUYER_AUTH_DEV_ENABLED==='true';
 const issueEnabled=()=>enabled()&&env.EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED==='true';
 if(!enabled())return createBuyerAuthHttp({enabled});
 try{
  if(env.EUPOVA_BUYER_AUTH_APP_ID!==developmentAppId||env.EUPOVA_BUYER_AUTH_ENVIRONMENT!=='development')
   throw new BuyerAuthError('buyer_auth_configuration');
  const resolveSession=createBuyerSessionReader(store);
  const resolveEnrollment=developmentEnrollment(JSON.parse(env.EUPOVA_BUYER_AUTH_TEST_ENROLLMENT??''),clock);
  const bridge=createBuyerAuthBridge({enabled,issueEnabled,origin,issuer:origin+'/auth/buyer',audience:developmentAppId,
   keyId:env.EUPOVA_BUYER_AUTH_KEY_ID,privateKey:createPrivateKey(env.EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM??''),
   resolveSession,resolveEnrollment,clock});
  bridge.publicKeys();
  return createBuyerAuthHttp({origin,store,enabled,issueEnabled,bridge,resolveSession});
 }catch{
  return createBuyerAuthHttp({origin,store,enabled});
 }
}
