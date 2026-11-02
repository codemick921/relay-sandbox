// Read-only tester visibility. This route never loads a signing key or contacts Privy.
import {createBuyerSessionReader,developmentEnrollment} from './buyer-auth-session.mjs';
import {developmentAppId} from './buyer-auth-http.mjs';
export const buyerStatusPath='/api/buyer-auth/status';
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Vary':'Cookie, Origin'};
const reply=(res,status,body)=>{res.writeHead(status,headers);res.end(JSON.stringify(body));return true;};
function cookie(value){
 if(typeof value!=='string'||value.length>8192)return null;
 const parts=value.split(';').map(s=>s.trim()).filter(s=>s.startsWith('__Host-relay_sandbox='));
 if(parts.length!==1)return null;
 const token=parts[0].slice('__Host-relay_sandbox='.length);
 return /^[a-f0-9]{64}$/.test(token)?token:null;
}
export function createBuyerStatusHttp({origin,enabled=()=>false,tokensEnabled=()=>false,resolveSession,resolveEnrollment,clock=Date.now}={}){
 return async(req,res)=>{
  if(String(req.url??'').split('?')[0]!==buyerStatusPath)return false;
  const hidden=()=>reply(res,404,{error:'buyer_auth_disabled'});
  if(enabled()!==true)return hidden();
  try{
   const site=new URL(origin);
   if(site.protocol!=='https:'||site.origin!==origin||typeof resolveSession!=='function'||typeof resolveEnrollment!=='function')throw Error('configuration');
   if(req.url!==buyerStatusPath||req.headers.host!==site.host||req.headers['x-forwarded-proto']!=='https'||req.headers.authorization||req.headers['sec-fetch-site']!=='same-origin'||(req.headers.origin&&req.headers.origin!==origin))return reply(res,403,{error:'request_rejected'});
   if(req.method!=='GET')return reply(res,405,{error:'method_not_allowed'});
   const token=cookie(req.headers.cookie),session=token&&await resolveSession(token);
   const valid=s=>s&&typeof s.owner==='string'&&typeof s.binding==='string'&&Number.isSafeInteger(s.expiresAt)&&s.expiresAt>clock();
   if(!valid(session))return hidden();
   const enrollment=await resolveEnrollment(session.owner);
   if(!enrollment||enrollment.owner!==session.owner||enrollment.consent!==true||enrollment.environment!=='development'||!Number.isSafeInteger(enrollment.expiresAt)||enrollment.expiresAt<=clock())return hidden();
   // Recheck the actual session after async enrolment lookup. No last-seen writes.
   const current=await resolveSession(token);
   if(!valid(current)||current.owner!==session.owner||current.binding!==session.binding||enabled()!==true||enrollment.expiresAt<=clock())return hidden();
   // This build only supports a disabled connection. A future activation must not
   // make this screen claim it can connect before the real SDK lifecycle is added.
   if(tokensEnabled()!==false)return reply(res,503,{error:'buyer_connection_configuration'});
   return reply(res,200,{visible:true,environment:'development',connection:'disabled',tokenIssuanceEnabled:false,expiresAt:Math.min(current.expiresAt,enrollment.expiresAt)});
  }catch{return reply(res,503,{error:'buyer_connection_unavailable'});}
 };
}
export function configuredBuyerStatusHttp({origin,store,env=process.env,clock=Date.now}={}){
 const enabled=()=>env.EUPOVA_BUYER_AUTH_DEV_PANEL_ENABLED==='true';
 if(!enabled())return createBuyerStatusHttp({enabled});
 try{
  if(env.EUPOVA_BUYER_AUTH_APP_ID!==developmentAppId||env.EUPOVA_BUYER_AUTH_ENVIRONMENT!=='development')throw Error('configuration');
  return createBuyerStatusHttp({origin,enabled,clock,tokensEnabled:()=>env.EUPOVA_BUYER_AUTH_DEV_ENABLED==='true'&&env.EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED==='true',resolveSession:createBuyerSessionReader(store),resolveEnrollment:developmentEnrollment(JSON.parse(env.EUPOVA_BUYER_AUTH_TEST_ENROLLMENT??''),clock)});
 }catch{return createBuyerStatusHttp({origin,enabled});}
}
