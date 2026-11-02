import {createServer} from 'vite';
import {chromium} from '/Users/mickelwilliams-brown/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),dir=path.resolve(root,'../evidence'),origin='http://127.0.0.1:4410';
const subject='22222222-2222-4222-8222-222222222222',did='did:privy:sample',address='0x1111111111111111111111111111111111111111';
let current=null;
const server=await createServer({configFile:false,envDir:false,cacheDir:'.wallet-auth-test-cache',resolve:{alias:{'@privy-io/react-auth':path.join(root,'tests/fixtures/privy-wallet-auth-fake.jsx')}},server:{host:'127.0.0.1',port:4410,strictPort:true},plugins:[{name:'sample-only',configureServer(s){s.middlewares.use(async(req,res,next)=>{
 if(req.headers.host!=='127.0.0.1:4410'){res.writeHead(403);return res.end();}
 const url=new URL(req.url,origin);const json=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
 if(url.pathname==='/'){
  const scenario=url.searchParams.get('sample')??'none';const now=Date.now();current={scenario,context:'c'.repeat(64),expiresAt:now+300000,expectedAddress:scenario==='existing'?address:null,calls:[]};
  const sample={logouts:0,user:{id:did,linkedAccounts:[{type:'custom_auth',customUserId:subject},...scenario==='existing'?[{type:'wallet',address,chainType:'ethereum',walletClientType:'privy',connectorType:'embedded',delegated:false,imported:false}]:[]]}};
  const html=await s.transformIndexHtml('/',`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eupova test</title></head><body><div id="root"></div><script>window.__sample=${JSON.stringify(sample)}</script><script type="module" src="/src/wallet-auth-entry.jsx"></script></body></html>`);res.setHeader('Content-Type','text/html');return res.end(html);
 }
 if(url.pathname.startsWith('/api/')){
  if(!current)return json(403,{});current.calls.push({path:url.pathname,method:req.method});
  if(current.scenario==='disabled')return json(404,{});
  if(url.pathname==='/api/buyer-wallet-auth/status')return json(200,{visible:true,environment:'development',purpose:'wallet_auth',appId:'cmvypq4k600vm0hjvdqvg7hxn',context:current.context,subject,privyDid:did,expectedAddress:current.expectedAddress,expiresAt:current.expiresAt});
  if(req.method!=='POST'||req.headers.origin!==origin)return json(403,{});
  let body='';for await(const b of req){body+=b;if(body.length>512)return json(413,{});}const input=JSON.parse(body);if(input.intent!=='wallet_auth'||input.consent!==true||input.context!==current.context)return json(409,{});
  if(url.pathname==='/api/buyer-wallet-auth/token')return json(200,{token:'sample-jwt',expiresAt:Date.now()+60000,walletCreated:false});
  if(url.pathname==='/api/buyer-wallet-auth/verify'){
   if(current.scenario==='failure')return json(503,{});
   const state=current;if(state.scenario==='slow')await new Promise(r=>setTimeout(r,1200));
   return json(200,{status:state.expectedAddress?'wallet_recognised':'no_wallet',address:state.expectedAddress,context:state.context,observedAt:Date.now(),validUntil:Date.now()+15000,canQuote:false,canCreateWallet:false,canCreatePayment:false});
  }
  return json(403,{});
 }
 next();
 });}}]});
await server.listen();
const browser=await chromium.launch({headless:true,executablePath:'/Users/mickelwilliams-brown/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],external=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',r=>{if(new URL(r.request().url()).origin!==origin){external.push(r.request().url());return r.abort();}return r.continue();});
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function visit(scenario){await page.goto(origin+'/?sample='+scenario);await page.getByRole('heading',{name:scenario==='disabled'?'Test access unavailable.':'Ready when you are.'}).waitFor();}
async function connect(){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Connect and check',exact:true}).click();}
try{
 await visit('none');check('initial consent is required',!await page.getByRole('button',{name:'Connect and check'}).isEnabled());check('only status before consent',current.calls.every(x=>x.path.endsWith('/status')));
 await page.screenshot({path:dir+'/wallet-auth-desktop.png',fullPage:true});await connect();await page.getByText('Your sign-in is confirmed. There is no buying wallet yet.',{exact:true}).waitFor();
 check('automatic creation off for both chains',await page.evaluate(()=>['ethereum','solana'].every(x=>window.__sample.config.embeddedWallets[x].createOnLogin==='off')));
 check('one sample issuance',current.calls.filter(x=>x.path.endsWith('/token')).length===1);
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByText('Disconnected. Return to Eupova to start a fresh test.',{exact:true}).waitFor();check('no restart or payment control after disconnect',await page.getByRole('button').count()===0);
 await visit('existing');await connect();await page.getByText('Your approved buying wallet was found. This does not enable payments.',{exact:true}).waitFor();check('expected wallet displayed',await page.getByText(address,{exact:true}).count()===1);await page.screenshot({path:dir+'/wallet-auth-recognised.png',fullPage:true});
 for(const width of[393,320]){await page.setViewportSize({width,height:852});check(width+'px no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:dir+'/wallet-auth-mobile-'+width+'.png',fullPage:true});}
 await visit('failure');await connect();await page.getByText('The account or wallet could not be confirmed. This test has stopped.',{exact:true}).waitFor();check('failure has no recognised address',await page.locator('.wallet-auth-address').count()===0);
 await visit('slow');await connect();await page.getByText('Checking the wallet against your approved test details…',{exact:true}).waitFor();await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByText('Disconnected. Return to Eupova to start a fresh test.',{exact:true}).waitFor();await page.waitForTimeout(1400);check('late server response does not revive UI',await page.getByText('Disconnected. Return to Eupova to start a fresh test.',{exact:true}).count()===1);
 await visit('disabled');check('disabled route offers no connection',await page.getByRole('button').count()===0);check('no external requests',external.length===0);check('no page errors',errors.length===0);
 await writeFile(dir+'/browser-tests.json',JSON.stringify({passed:true,count:checks.length,checks,external,errors},null,2));console.log(JSON.stringify({passed:true,count:checks.length,checks}));
}catch(e){await page.screenshot({path:dir+'/browser-failure.png',fullPage:true});await writeFile(dir+'/browser-tests.json',JSON.stringify({passed:false,error:String(e),checks,errors,external},null,2));throw e;}finally{await browser.close();await server.close();}
