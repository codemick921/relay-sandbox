// Local sample-only runner. Never load .env, app routes, a database or Privy SDK.
import {createServer} from 'vite';
import {randomUUID} from 'node:crypto';
import {createSetupSample,setupScenarios} from '../tests/fixtures/buyer-wallet-setup-sample.mjs';
const port=4409,origin=`http://127.0.0.1:${port}`,sessions=new Map();
const app=await createServer({configFile:false,envDir:false,cacheDir:'.wallet-setup-preview-cache',server:{host:'127.0.0.1',port,strictPort:true},plugins:[{name:'wallet-setup-samples',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 if(req.headers.host!==`127.0.0.1:${port}`)return send(403,{error:'request_rejected'});
 const path=new URL(req.url,origin).pathname;
 if(path.startsWith('/api/')||path==='/.well-known/eupova-buyer-auth-jwks.json')return send(403,{error:'Application actions blocked'});
 const cookie=req.headers.cookie?.match(/(?:^|;\s*)eupova_wallet_sample_4409=([a-f0-9-]{36})(?:;|$)/)?.[1];
 let id=cookie;if(!id||!sessions.has(id)){id=randomUUID();sessions.set(id,{samples:new Map(),calls:[],last:Date.now()});res.setHeader('Set-Cookie',`eupova_wallet_sample_4409=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);}
 const session=sessions.get(id);session.last=Date.now();
 if(path.startsWith('/__wallet_setup/')){
  const op=path.slice('/__wallet_setup/'.length);
  if(!['inspect','create','verify','quotes','review','reset','stats'].includes(op)||req.url!==path||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json')return send(403,{error:'request_rejected'});
  session.calls=session.calls.filter(t=>t>Date.now()-60000);if(session.calls.length>=90)return send(429,{error:'Please wait before checking again.'});session.calls.push(Date.now());
  let body='';for await(const chunk of req.iterator({destroyOnReturn:false})){body+=chunk;if(body.length>2048){req.resume();return send(413,{error:'too_large'});}}
  try{const value=JSON.parse(body),{scenario,input}=value;if(!setupScenarios.includes(scenario)||Object.keys(value).some(k=>!['scenario','input'].includes(k)))return send(400,{error:'invalid_sample'});
   if(!session.samples.has(scenario)||op==='reset')session.samples.set(scenario,createSetupSample({scenario}));
   const sample=session.samples.get(scenario);
   const result=op==='reset'?{reset:true,sample:true}:['quotes','review'].includes(op)?await sample.quote(op,input):await sample[op]();return send(200,result);
  }catch{return send(400,{error:'sample_context_changed'});}
 }
 if(path==='/'){
  const html=await server.transformIndexHtml('/','<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eupova · Buying wallet setup preview</title></head><body><div id="root"></div><script type="module" src="/src/WalletSetupPreview.jsx"></script></body></html>');res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:4409; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'");return res.end(html);
 }next();
});}}]});
setInterval(()=>{for(const[id,s]of sessions)if(s.last<Date.now()-3600000)sessions.delete(id);},60000).unref();
await app.listen();console.log(origin+' — sample wallets and quotes; real actions blocked.');
