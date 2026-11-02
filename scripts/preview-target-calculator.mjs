// Loopback-only preview. Does not load .env, connect a database or import signing code.
import {createServer} from 'vite';
import {createTargetCalculator,calculatorInput} from '../server/quote-first/target-calculator.mjs';
import {calculatorSamples} from '../tests/fixtures/calculator-samples.mjs';
const port=4406,origin=`http://127.0.0.1:${port}`,calculator=createTargetCalculator();
let calls=[];
const app=await createServer({configFile:false,envDir:false,cacheDir:'.target-preview-cache',server:{host:'127.0.0.1',port,strictPort:true},plugins:[{name:'readonly-target-preview',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403);return res.end();}
 const path=new URL(req.url,origin).pathname;
 if(path.startsWith('/api/')){res.writeHead(403);return res.end('Application actions blocked.');}
 if(path==='/__calculator'){
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json')return send(403,{error:'request_rejected'});
  calls=calls.filter(t=>t>Date.now()-60000);if(calls.length>=12)return send(429,{error:'Please wait before refreshing.'});calls.push(Date.now());
  let body='';for await(const c of req.iterator({destroyOnReturn:false})){body+=c;if(body.length>512){req.resume();return send(413,{error:'too_large'});}}
  let input,scenario;try{({input,scenario}=JSON.parse(body));calculatorInput(input);if(!['live','available','none','invalid','expiry','failure'].includes(scenario))throw Error();}catch{return send(400,{error:'Invalid target'});}
  try{return send(200,scenario==='live'?await calculator.quotes(input):calculatorSamples(input,scenario));}catch{return send(503,{error:'Quotes unavailable'});}
 }
 if(path==='/'){
  const html=await server.transformIndexHtml('/', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Eupova · USDC target calculator</title></head><body><div id="root"></div><script type="module" src="/src/TargetCalculatorPreview.jsx"></script></body></html>');res.setHeader('Content-Type','text/html');return res.end(html);
 }next();
});}}]});
await app.listen();console.log(origin+' — read-only quotes; all application writes blocked.');
