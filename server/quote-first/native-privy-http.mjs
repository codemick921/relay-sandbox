import {readFile} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {createBuyerSessionReader} from './buyer-auth-session.mjs';
import {createPrivyAccessVerifier,createPrivyUserReader} from './privy-wallet-reader.mjs';
import {createNativePrivyService,NativeError} from './native-privy.mjs';
import {createNativePrivyStore} from './native-privy-store.mjs';
import {connectionCsp} from './buyer-connection-http.mjs';
import {nativeRegistryConnection} from './native-privy-database.mjs';
import {developmentAppId} from './buyer-auth-http.mjs';
export const nativePaths={page:'/buying-wallet-connect',status:'/api/native-privy/status',begin:'/api/native-privy/begin',review:'/api/native-privy/review',confirm:'/api/native-privy/confirm',recovery:'/api/native-privy/recovery'};
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',Vary:'Cookie, Origin, Authorization'});res.end(JSON.stringify(value));return true;};
const sessionToken=req=>{const values=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-relay_sandbox='));return values.length===1?values[0].slice(21):null;};
export function createNativePrivyHttp({origin,service,document,resolveSession,enabled=()=>false,rate=async()=>false}){
 return async(req,res)=>{
  const route=String(req.url).split('?')[0];if(!Object.values(nativePaths).includes(route))return false;
  const page=route===nativePaths.page,status=route===nativePaths.status;
  try{
   const site=new URL(origin),post=!page&&!status;
   if(req.url!==route||site.protocol!=='https:'||req.headers.host!==site.host||req.headers['x-forwarded-proto']!=='https'||(req.headers.origin&&req.headers.origin!==origin)||!(page?['same-origin','none']:['same-origin']).includes(req.headers['sec-fetch-site'])||req.headers['content-encoding'])return send(res,403,{error:'request_rejected'});
   if(req.method!==(post?'POST':'GET'))return send(res,405,{error:'method_not_allowed'});
   const token=sessionToken(req),s=token&&await resolveSession(token);if(!s||s.expiresAt<=Date.now())return send(res,401,{error:'sign_in_required'});
   if(page){const html=await document();res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','Content-Security-Policy':connectionCsp});res.end(html);return true;}
   if(!enabled()||!service)return status?send(res,200,{enabled:false,canCreateWallet:false,canCreatePayment:false}):send(res,404,{error:'native_disabled'});
   if(!await rate(s.owner,post))return send(res,429,{error:'too_many_requests'});
   if(status)return send(res,200,await service.status(token));
   if(req.headers.origin!==origin||req.headers['x-eupova-native']!=='1'||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))return send(res,403,{error:'request_rejected'});
   let size=0,chunks=[],timer;const read=async()=>{for await(const c of req){size+=c.length;if(size>2048)throw Error();chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString());};
   let input;try{input=await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>{req.destroy();reject(Error());},5000);})]);}catch{return send(res,400,{error:'invalid_request'});}finally{clearTimeout(timer);}
   const allowed=route===nativePaths.begin||route===nativePaths.recovery?[]:route===nativePaths.review?['nonce']:['nonce','consent','consentVersion'];
   if(!input||Array.isArray(input)||Object.keys(input).length!==allowed.length||Object.keys(input).some(k=>!allowed.includes(k)))return send(res,400,{error:'invalid_request'});
   const header=req.headers.authorization,access=typeof header==='string'&&header.length<=8200&&/^Bearer [a-zA-Z0-9_.-]+$/.test(header)?header.slice(7):null;
   if(route!==nativePaths.begin&&!access)return send(res,401,{error:'privy_sign_in_required'});
   const result=route===nativePaths.begin?await service.begin(token):route===nativePaths.review?await service.review(token,access,input.nonce):route===nativePaths.confirm?await service.confirm(token,access,input):await service.recovery(token,access);
   return send(res,200,result);
  }catch(e){return send(res,e instanceof NativeError?409:503,{error:e instanceof NativeError?e.code:'native_unavailable'});}
 };
}
export function configuredNativePrivy({origin,store,staticRoot,env=process.env}){
 const resolveSession=createBuyerSessionReader(store),enabled=()=>env.EUPOVA_PRIVY_NATIVE_ENABLED==='true';let service=null,pool=null;
 if(enabled())try{
  const appId=env.EUPOVA_PRIVY_NATIVE_APP_ID;
  if(!/^[a-z0-9]{10,80}$/.test(appId??'')||appId===developmentAppId||env.EUPOVA_PRIVY_NATIVE_CREDENTIAL_ACCESS!=='read-only')throw Error();
  const verifyAccessToken=createPrivyAccessVerifier({appId,trustedJwks:JSON.parse(env.EUPOVA_PRIVY_NATIVE_PUBLIC_JWKS)});
  const readPrivyUser=createPrivyUserReader({appId,readOnlySecret:env.EUPOVA_PRIVY_NATIVE_READONLY_SECRET,credentialAccess:'read-only',includeInventory:true,includeNativeIdentity:true});
  pool=new pg.Pool({connectionString:nativeRegistryConnection(env),max:2,connectionTimeoutMillis:5000,statement_timeout:5000,idle_in_transaction_session_timeout:10000});
  const db={query:(...a)=>pool.query(...a),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL synchronous_commit=on');const value=await fn(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}};
  service=createNativePrivyService({appId,store:createNativePrivyStore(db),resolveSession,verifyAccessToken,readPrivyUser,enabled});
 }catch{pool?.end().catch(()=>{});service=null;}
 const handler=createNativePrivyHttp({origin,service,resolveSession,enabled:()=>enabled()&&!!service,document:()=>readFile(path.join(staticRoot,'native-privy.html')),rate:(owner,post)=>store.rate('native-privy:'+owner,post?15:60,60)});
 handler.close=()=>pool?.end();return handler;
}
