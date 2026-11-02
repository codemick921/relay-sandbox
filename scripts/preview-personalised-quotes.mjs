// Isolated, sample-only local preview. No database, credentials, SDK or live fetch.
import {createServer} from 'vite';
import {createPersonalisedQuoteService} from '../server/quote-first/personalised-quote.mjs';
import {personalisationRecord,personalisedSamplePayload} from '../tests/fixtures/personalised-samples.mjs';
const port=4408,origin=`http://127.0.0.1:${port}`,records=new Map();let calls=[];
const scenarios=['available','noBuyer','expired','wrongAsset','changed','none','revoked'];
const app=await createServer({configFile:false,envDir:false,cacheDir:'.review-preview-cache',server:{host:'127.0.0.1',port,strictPort:true},plugins:[{name:'personalised-sample-preview',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 if(req.headers.host!==`127.0.0.1:${port}`)return send(403,{error:'request_rejected'});
 const path=new URL(req.url,origin).pathname;
 if(path.startsWith('/api/'))return send(403,{error:'Application actions blocked'});
 if(path.startsWith('/__personalised/')){
  const op=path.slice('/__personalised/'.length);
  if(!['context','quotes','review'].includes(op)||req.url!==path||req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json')return send(403,{error:'request_rejected'});
  calls=calls.filter(t=>t>Date.now()-60000);if(calls.length>=30)return send(429,{error:'Please wait before refreshing.'});calls.push(Date.now());
  let body='';for await(const c of req.iterator({destroyOnReturn:false})){body+=c;if(body.length>1024){req.resume();return send(413,{error:'too_large'});}}
  try{
   const {scenario,input}=JSON.parse(body);if(!scenarios.includes(scenario)||!['research','assistant'].includes(input?.receivingWalletId))return send(400,{error:'invalid_sample'});
   const key=scenario+':'+input.receivingWalletId;
   if(op==='context'){
    const r=personalisationRecord(input.receivingWalletId);if(scenario==='noBuyer')r.buyer=null;if(scenario==='expired')r.buyer.verifiedAt-=300001;if(scenario==='wrongAsset')r.recipient.chainId=1;records.set(key,r);
   }
   const service=createPersonalisedQuoteService({resolveContext:async()=>structuredClone(records.get(key)),fetchImpl:async(url,options)=>{
    if(url!=='https://api.zkp2p.xyz/v3/quote/exact-token?quotesToReturn=3')throw Error('Forbidden operation');
    if(scenario==='revoked')records.get(key).session.expiresAt=0;
    return new Response(JSON.stringify(personalisedSamplePayload(JSON.parse(options.body),Date.now(),scenario==='none'?'none':scenario==='changed'&&op==='review'?'changed':'available')),{headers:{'Content-Type':'application/json'}});
   }});
   return send(200,await service[op]('sample-session',input));
  }catch(e){return send(400,{error:['unsupported_receiving_asset','buyer_verification_expired','buyer_wallet_needed'].includes(e.code)?e.code:'sample_context_changed'});}
 }
 if(path==='/'){
  const html=await server.transformIndexHtml('/','<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Eupova · Wallet quote review</title></head><body><div id="root"></div><script type="module" src="/src/PersonalisedQuotePreview.jsx"></script></body></html>');res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');return res.end(html);
 }next();
});}}]});await app.listen();console.log(origin+' — sample wallets and quotes only; no live application actions.');
