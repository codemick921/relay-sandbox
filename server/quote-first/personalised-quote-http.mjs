// Restricted quote preparation. Defaults off; no token issuance or payment route.
import {createBuyerSessionReader} from './buyer-auth-session.mjs';
import {developmentAppId} from './buyer-auth-http.mjs';
import {createPrivyAccessVerifier,createPrivyUserReader} from './privy-wallet-reader.mjs';
import {quoteTestEnrollment,createBuyerWalletResolver} from './buyer-wallet-resolver.mjs';
import {createPersonalisedQuoteService,personalisedInput} from './personalised-quote.mjs';
export const personalisedPaths=Object.freeze({context:'/api/funding-calculator/personalised/context',quotes:'/api/funding-calculator/personalised/quotes',review:'/api/funding-calculator/personalised/review'});
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache',Vary:'Cookie, Origin, Authorization','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));return true;};
function cookie(value){const parts=String(value??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('__Host-relay_sandbox='));const token=parts.length===1?parts[0].slice(21):'';return /^[a-f0-9]{64}$/.test(token)?token:null;}
function memoryLimiter(clock){const buckets=new Map();return key=>{const now=clock();for(const [k,v]of buckets)if(v.until<=now)buckets.delete(k);let bucket=buckets.get(key);if(!bucket){if(buckets.size>=256)return false;bucket={count:0,until:now+60000};buckets.set(key,bucket);}return ++bucket.count<=(key==='global'?60:12);};}
export function createPersonalisedQuoteHttp({origin,enabled=()=>false,resolveSession,resolveEnrollment,service,clock=Date.now,bodyTimeoutMs=5000}={}){
 const allow=memoryLimiter(clock);
 const handler=async(req,res)=>{
  const path=String(req.url??'').split('?')[0],operation=Object.keys(personalisedPaths).find(k=>personalisedPaths[k]===path);
  if(!operation)return false;
  const hidden=()=>send(res,404,{error:'personalised_quotes_disabled'});
  if(!enabled())return hidden();
  try{
   const site=new URL(origin);
   if(site.protocol!=='https:'||origin!==site.origin||!resolveSession||!resolveEnrollment||!service)return send(res,503,{error:'personalised_quotes_unavailable'});
   if(req.url!==path||req.headers.host!==site.host||req.headers['x-forwarded-proto']!=='https'||req.headers.origin!==origin||req.headers['sec-fetch-site']!=='same-origin'||req.headers['content-encoding'])return send(res,403,{error:'request_rejected'});
   if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
   if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))return send(res,415,{error:'invalid_content_type'});
   if(!allow('global'))return send(res,429,{error:'too_many_requests'});
   const sessionToken=cookie(req.headers.cookie),session=sessionToken&&await resolveSession(sessionToken);
   const valid=s=>s&&Number.isSafeInteger(s.expiresAt)&&s.expiresAt>clock();
   const enrollment=valid(session)&&await resolveEnrollment(session.owner);
   if(!valid(session)||!enrollment||enrollment.owner!==session.owner||enrollment.environment!=='development'||enrollment.consent!==true||enrollment.expiresAt<=clock())return hidden();
   if(!allow(session.owner))return send(res,429,{error:'too_many_requests'});
   const authorization=req.headers.authorization;
   if(typeof authorization!=='string'||authorization.length>8200||!/^Bearer [a-zA-Z0-9_.-]+$/.test(authorization))return send(res,401,{error:'privy_sign_in_required'});
   let timer;
   const read=async()=>{let size=0;const chunks=[];for await(const part of req.iterator({destroyOnReturn:false})){const c=Buffer.from(part);size+=c.length;if(size>1024)throw Error('body');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
   let input;try{input=await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>{req.destroy();reject(Error('timeout'));},bodyTimeoutMs);})]);}catch{req.resume();return send(res,400,{error:'invalid_request'});}finally{clearTimeout(timer);}
   try{if(operation==='context'){if(!input||Object.keys(input).length!==1||typeof input.receivingWalletId!=='string')throw Error('input');}else personalisedInput(input,{review:operation==='review'});}catch{return send(res,400,{error:'invalid_request'});}
   if(!enabled())return hidden();
   const result=await service[operation]({sessionToken,accessToken:authorization.slice(7)},input);
   const current=await resolveSession(sessionToken),latest=await resolveEnrollment(session.owner);
   if(!enabled()||!valid(current)||current.owner!==session.owner||current.binding!==session.binding||!latest||JSON.stringify(latest)!==JSON.stringify(enrollment)||latest.expiresAt<=clock())return hidden();
   return send(res,200,result);
  }catch{return send(res,503,{error:'personalised_quotes_unavailable'});}
 };
 handler.available=()=>enabled()===true;return handler;
}
export function configuredPersonalisedQuotes({origin,store,env=process.env,clock=Date.now,privyFetch=globalThis.fetch,quoteFetch=globalThis.fetch}={}){
 const enabled=()=>env.EUPOVA_PERSONALISED_QUOTE_DEV_ENABLED==='true';
 // Do not even read secrets or construct database/provider adapters while disabled.
 if(!enabled())return createPersonalisedQuoteHttp({enabled});
 try{
  if(env.EUPOVA_PRIVY_QUOTE_APP_ID!==developmentAppId||env.EUPOVA_PRIVY_QUOTE_ENVIRONMENT!=='development'||env.EUPOVA_PRIVY_QUOTE_CREDENTIAL_ACCESS!=='read-only')throw Error('configuration');
  const resolveSession=createBuyerSessionReader(store),resolveEnrollment=quoteTestEnrollment(JSON.parse(env.EUPOVA_PERSONALISED_QUOTE_TEST_ENROLLMENT??''),clock);
  const verifyAccessToken=createPrivyAccessVerifier({appId:developmentAppId,trustedJwks:JSON.parse(env.EUPOVA_PRIVY_ACCESS_PUBLIC_JWKS??''),clock});
  const readPrivyUser=createPrivyUserReader({appId:developmentAppId,readOnlySecret:env.EUPOVA_PRIVY_QUOTE_READONLY_SECRET,credentialAccess:'read-only',fetchImpl:privyFetch});
  const resolveContext=createBuyerWalletResolver({store,resolveSession,resolveEnrollment,verifyAccessToken,readPrivyUser,enabled,clock});
  const service=createPersonalisedQuoteService({resolveContext,fetchImpl:quoteFetch,clock});
  return createPersonalisedQuoteHttp({origin,enabled,resolveSession,resolveEnrollment,service,clock});
 }catch{return createPersonalisedQuoteHttp({origin,enabled});}
}
