// Separate, opt-in development authentication. No wallet or payment capabilities.
import {createHash,createPrivateKey} from 'node:crypto';
import {createBuyerAuthBridge} from './buyer-auth-bridge.mjs';
import {createBuyerSessionReader,developmentEnrollment} from './buyer-auth-session.mjs';
import {developmentAppId} from './buyer-auth-http.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import publishedKeys from './buyer-auth-public-jwks.json' with {type:'json'};
export const connectionPaths=Object.freeze({status:'/api/buyer-auth/connection',token:'/api/buyer-auth/connect-token',page:'/buyer-connection-test'});
export const connectionCsp="default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://auth.privy.io; frame-src https://auth.privy.io https://challenges.cloudflare.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
const responseHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',Pragma:'no-cache',Vary:'Cookie, Origin','Referrer-Policy':'no-referrer'};
const send=(res,status,data)=>{res.writeHead(status,responseHeaders);res.end(JSON.stringify(data));return true;};
const context=(s,e)=>createHash('sha256').update(JSON.stringify([s.owner,s.binding,e.subject,e.expiresAt])).digest('hex');
function cookie(value){
 if(typeof value!=='string'||value.length>8192)return null;
 const parts=value.split(';').map(s=>s.trim()).filter(s=>s.startsWith('__Host-relay_sandbox='));
 const token=parts.length===1?parts[0].slice(21):'';
 return /^[a-f0-9]{64}$/.test(token)?token:null;
}
export function createBuyerConnectionHttp({origin,enabled=()=>false,resolveSession,resolveEnrollment,issue,rate,document,clock=Date.now}={}){
 return async(req,res)=>{
  const raw=String(req.url??'').split('?')[0];
  if(!Object.values(connectionPaths).includes(raw))return false;
  const hidden=()=>send(res,404,{error:'buyer_connection_disabled'});
  if(!enabled())return hidden();
  try{
   const site=new URL(origin),isPage=raw===connectionPaths.page,isToken=raw===connectionPaths.token;
   if(site.protocol!=='https:'||site.origin!==origin||!resolveSession||!resolveEnrollment||!issue)throw Error('configuration');
   if(req.url!==raw||req.headers.host!==site.host||req.headers['x-forwarded-proto']!=='https'||req.headers.authorization||
      (req.headers.origin&&req.headers.origin!==origin)||!((isPage?['same-origin','none']:['same-origin']).includes(req.headers['sec-fetch-site'])))return send(res,403,{error:'request_rejected'});
   if(req.method!==(isToken?'POST':'GET'))return send(res,405,{error:'method_not_allowed'});
   if(isToken&&(req.headers.origin!==origin||req.headers['x-eupova-connection']!=='1'||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')||req.headers['content-encoding']))return send(res,403,{error:'request_rejected'});
   const token=cookie(req.headers.cookie),session=token&&await resolveSession(token);
   const valid=s=>s&&typeof s.owner==='string'&&typeof s.binding==='string'&&s.binding.length>=16&&Number.isSafeInteger(s.expiresAt)&&s.expiresAt>clock();
   if(!valid(session))return hidden();
   const e=await resolveEnrollment(session.owner);
   if(!e||e.owner!==session.owner||e.consent!==true||e.environment!=='development'||typeof e.subject!=='string'||!Number.isSafeInteger(e.expiresAt)||e.expiresAt<=clock())return hidden();
   const current=await resolveSession(token);
   if(!valid(current)||current.owner!==session.owner||current.binding!==session.binding||!enabled()||e.expiresAt<=clock())return hidden();
   const value={visible:true,environment:'development',connection:'available',appId:developmentAppId,context:context(current,e),subject:e.subject,expiresAt:Math.min(current.expiresAt,e.expiresAt)};
   if(isPage){
    const html=await document();
    if(!enabled()||value.expiresAt<=clock())return hidden();
    res.writeHead(200,{...responseHeaders,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':connectionCsp});res.end(html);return true;
   }
   if(!isToken)return send(res,200,value);
   await rate(session.owner);
   let size=0,chunks=[];
   for await(const part of req.iterator({destroyOnReturn:false})){const b=Buffer.from(part);size+=b.length;if(size>512){req.resume();return send(res,413,{error:'request_too_large'});}chunks.push(b);}
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(res,400,{error:'invalid_request'});}
   if(!input||Object.keys(input).length!==3||input.intent!=='privy_connection_test'||input.consent!==true||input.context!==value.context)return send(res,409,{error:'connection_context_changed'});
   // Recheck after body/rate awaits; issuance also checks the session before and after signing preparation.
   const latest=await resolveSession(token),enrolled=await resolveEnrollment(session.owner);
   if(!valid(latest)||!enrolled||context(latest,enrolled)!==value.context||!enabled()||enrolled.expiresAt<=clock())return hidden();
   const result=await issue(token,value.context);
   const finalSession=await resolveSession(token),finalEnrollment=await resolveEnrollment(session.owner);
   if(!valid(finalSession)||!finalEnrollment||context(finalSession,finalEnrollment)!==value.context||!enabled()||finalEnrollment.expiresAt<=clock())return hidden();
   return send(res,200,result);
  }catch(e){return send(res,e?.status===429?429:503,{error:e?.status===429?'too_many_requests':'buyer_connection_unavailable'});}
 };
}
export function configuredBuyerConnectionHttp({origin,store,staticRoot,env=process.env,clock=Date.now,trustedKeys=publishedKeys}={}){
 const enabled=()=>['EUPOVA_BUYER_AUTH_DEV_CONNECTION_ENABLED','EUPOVA_BUYER_AUTH_DEV_ENABLED','EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED'].every(k=>env[k]==='true');
 if(!enabled())return createBuyerConnectionHttp({enabled});
 try{
  if(env.EUPOVA_BUYER_AUTH_APP_ID!==developmentAppId||env.EUPOVA_BUYER_AUTH_ENVIRONMENT!=='development')throw Error('configuration');
  const record=JSON.parse(env.EUPOVA_BUYER_AUTH_TEST_ENROLLMENT??'');
  // Real connection tests get a tighter, absolute 30-minute lease, never renewed by polling.
  if(record.expiresAt-record.consentRecordedAt>1800000)throw Error('lease');
  const resolveSession=createBuyerSessionReader(store),resolveEnrollment=developmentEnrollment(record,clock);
  const privateKey=createPrivateKey(env.EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM??'');
  const bridge=createBuyerAuthBridge({enabled,issueEnabled:enabled,origin,issuer:origin+'/auth/buyer',audience:developmentAppId,keyId:env.EUPOVA_BUYER_AUTH_KEY_ID,privateKey,resolveSession,resolveEnrollment,clock});
  const publicKey=bridge.publicKeys().keys[0];
  if(trustedKeys.keys.length!==1||!['kid','kty','alg','use','n','e'].every(k=>publicKey[k]===trustedKeys.keys[0][k]))throw Error('published_key_mismatch');
  return createBuyerConnectionHttp({origin,enabled,resolveSession,resolveEnrollment,clock,
   document:()=>readFile(path.join(staticRoot,'buyer-connection.html')),
   rate:async owner=>{await store.rate('buyer-connection:global',60,60);await store.rate('buyer-connection:'+owner,6,60);},
   issue:async(token,expected)=>{
    // Bind every bridge identity lookup to the context reviewed in this browser.
    const bound=async t=>{const s=await resolveSession(t),e=s&&await resolveEnrollment(s.owner);return s&&e&&context(s,e)===expected?s:null;};
    const b=createBuyerAuthBridge({enabled,issueEnabled:enabled,origin,issuer:origin+'/auth/buyer',audience:developmentAppId,keyId:env.EUPOVA_BUYER_AUTH_KEY_ID,privateKey,resolveSession:bound,resolveEnrollment,clock});
    return b.issue(token,{method:'POST',origin,fetchSite:'same-origin',contentType:'application/json',body:{intent:'buyer_wallet_setup'}});
   }
  });
 }catch{return createBuyerConnectionHttp({origin,enabled});}
}
