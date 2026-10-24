import {createFundingDrafts,fundingDisabled} from './funding-drafts.mjs';
import {configuredAccountMail} from './mail-transport.mjs';
import {createAccountMail} from './account-mail.mjs';
import {createAccounts} from './accounts.mjs';
import {createLiveTrackingHandler,presentTrackedOrder} from './live-http.mjs';
import {prepareTrackingSandbox} from './tracking-sandbox.mjs';
import {migrateWhenReady} from './startup.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {InputError,address,pence} from '../server/validation.mjs';
import {createSandboxPayService} from '../server/pay-sandbox.mjs';
import {verifyWebhook} from '../server/pay-webhooks.mjs';
import {createPool,createStore,digest,orderView} from './db.mjs';
import {config as readConfig} from './config.mjs';
import {createPeerConnection,liveWebhookPath} from './peer-connection.mjs';
const dist=fileURLToPath(new URL('../dist/',import.meta.url));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
async function body(req,max=16384){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw new InputError('Request too large.',413);chunks.push(chunk);}return Buffer.concat(chunks);}
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
export function createHostedServer({store,config,pay=createSandboxPayService(),staticRoot=dist,allowHttpForTests=false,tracking=null,paymentsDisabled=false,localPreview=false,accountMail=null,customerAccountsEnabled=true,peerConnection=null,fundingDrafts=null}){
 const origin=new URL(config.origin),mail=accountMail??createAccountMail(store),accounts=customerAccountsEnabled?createAccounts(store,{mail}):null;
 if(fundingDrafts&&!paymentsDisabled)throw Error('Funding preparation requires payments to remain disabled.');
 if(tracking?.journey&&(!tracking.simulated||!tracking.journey.simulated||!paymentsDisabled))throw Error('Test funding requires simulated tracking and disabled payments.');
 if(mail.preview&&!localPreview)throw Error('Email previews are local only.');
 if(localPreview&&(!tracking?.simulated||!paymentsDisabled||origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'))throw Error('Local preview requires simulated tracking, disabled payments and loopback HTTP.');
 if(tracking&&!paymentsDisabled)throw Error('Tracking integration currently requires payments to remain disabled.');
 if(peerConnection&&(!paymentsDisabled||localPreview||peerConnection.mode!=='receive_only'))throw Error('Peer connection requires disabled payments and hosted receive-only mode.');
 const cookie=localPreview?'relay_local_preview':'__Host-relay_sandbox';
 const cookiePolicy=`${localPreview?'':'Secure; '}HttpOnly; SameSite=Strict; Path=/`;
 const getToken=req=>(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookie+'='))?.slice(cookie.length+1);
 const authenticate=async req=>(await accounts?.session(getToken(req)))?.owner??await store.session(getToken(req),config.testers);
 const stateFor=async owner=>{const base=await store.state(owner);const state={...base,...fundingDrafts&&owner.startsWith('customer:')?{liveFunding:fundingDisabled,fundingDrafts:await fundingDrafts.list(owner)}:{}};if(!tracking)return {...state,paymentsDisabled};const [tracked,worker]=await Promise.all([tracking.store.state(owner),tracking.store.health()]);return {...state,paymentsDisabled,previewMode:!!tracking.simulated,trackingEnabled:true,worker,fundingJourneyEnabled:!!tracking.journey,orders:[...(await tracking.journey?.decorate(owner,tracked.orders)??tracked.orders).map(o=>presentTrackedOrder(o,tracking.simulated)),...state.orders]};};
 const handleTracking=tracking&&createLiveTrackingHandler({store:tracking.store,origin:config.origin,authenticate,rateLimit:(owner,kind)=>store.rate(kind==='read'?'read:'+owner:'mutation:'+owner,kind==='read'?120:30,60),simulated:!!tracking.simulated,localPreview,allowHttpForTests});
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   // Health probes disclose no customer/provider state and require no proxy headers.
   if(req.url==='/healthz'&&req.method==='GET'){try{await store.query('SELECT 1');return send(res,200,{ok:true,mode:'sandbox',paymentsDisabled,realPaymentsEnabled:false,providerConnectionsEnabled:!paymentsDisabled,liveConnectionMode:peerConnection?'receive_only':'disabled',tracking:tracking?'simulated':null,release:process.env.RENDER_GIT_COMMIT??null});}catch{return send(res,503,{ok:false});}}
   if(req.headers.host!==config.host)return send(res,421,{error:'Unexpected host.'});
   if(!allowHttpForTests&&!localPreview&&req.headers['x-forwarded-proto']!=='https'){
    if(req.method==='GET'){res.writeHead(308,{Location:config.origin+'/'});return res.end();}return send(res,400,{error:'HTTPS required.'});
   }
   const url=new URL(req.url,config.origin);
   if(peerConnection&&url.pathname===liveWebhookPath){
    if(req.method!=='POST')throw new InputError('Method not allowed.',405);
    if(!String(req.headers['content-type']).startsWith('application/json'))throw new InputError('JSON required.',415);
    const accepted=await peerConnection.accept(await body(req,262144),req.headers);
    return send(res,202,{accepted:true,...accepted});
   }
   if(url.pathname==='/api/operator/peer-connection'){
    if(req.method!=='GET')throw new InputError('Method not allowed.',405);
    // Only an existing private tester/operator session; customer sessions cannot inspect connections.
    if(!await store.session(getToken(req),config.testers))throw new InputError('Operator sign-in required.',403);
    return send(res,200,peerConnection?await peerConnection.status():{mode:'disabled',realPaymentsEnabled:false});
   }
   if(handleTracking&&await handleTracking(req,res))return;
   if(url.pathname==='/api/webhooks/peer/sandbox'){
    if(paymentsDisabled)throw new InputError('External payment connections are disabled.',403);
    if(req.method!=='POST')throw new InputError('Method not allowed.',405);
    if(!String(req.headers['content-type']).startsWith('application/json'))throw new InputError('JSON required.',415);
    const event=verifyWebhook(await body(req,262144),req.headers,config.webhook);
    if(event.environment!=='SANDBOX')throw new InputError('Sandbox webhook required.',403);
    const accepted=await store.accept(event);return send(res,202,{accepted:true,...accepted});
   }
   if(!url.pathname.startsWith('/api/')){
    if(req.method!=='GET')throw new InputError('Not found.',404);
    const decoded=decodeURIComponent(url.pathname);if(decoded!=='/'&&!/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg)$/.test(decoded))throw new InputError('Not found.',404);
    const file=path.join(staticRoot,decoded==='/'?'index.html':decoded.slice(1));const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'})[path.extname(file)]);return res.end(data);
   }
   const allowed=new Set(['/api/funding/drafts','/api/funding/cancel','/api/funding/checkout','/api/funding/resume','/api/funding/availability','/api/test-funding/quote','/api/test-funding/create','/api/test-funding/action','/api/account/signup','/api/account/login','/api/account/recover','/api/account/password','/api/account/requestVerification','/api/account/requestReset','/api/account/verifyEmail','/api/account/resetPassword','/api/account/emailPreview','/api/access','/api/login','/api/logout','/api/state','/api/agents','/api/checkouts','/api/checkout-resume','/api/checkout-refresh','/api/checkout-setup']);
   if(!allowed.has(url.pathname))throw new InputError('Not found.',404);
   if(req.headers['sec-fetch-site']==='cross-site')throw new InputError('Cross-site access blocked.',403);
   if(req.method==='POST'&&(req.headers.origin!==config.origin||!String(req.headers['content-type']).startsWith('application/json')))throw new InputError('Same-origin JSON required.',403);
   if(!['GET','POST'].includes(req.method))throw new InputError('Method not allowed.',405);
   let b={};if(req.method==='POST'){try{b=JSON.parse((await body(req)).toString());}catch(e){if(e instanceof InputError)throw e;throw new InputError('Invalid JSON.');}if(!b||typeof b!=='object'||Array.isArray(b))throw new InputError('Invalid request.');}
   if(url.pathname.startsWith('/api/account/')){
    if(!accounts||req.method!=='POST')throw new InputError('Not found.',404);
    const action=url.pathname.split('/').at(-1);
    if(action==='emailPreview'){
     if(!localPreview||!mail.preview)throw new InputError('Not found.',404);
     const session=await accounts.session(getToken(req));if(!session)throw new InputError('Sign in to view local test emails.',401);
     await store.rate('mail:preview:'+session.account.id,30,60);
     return send(res,200,{emails:mail.previewFor(session.account.id)});
    }
    const result=await accounts[action](b,getToken(req));
    if(['requestVerification','requestReset','verifyEmail'].includes(action))return send(res,200,result);
    // Never retain the previous signed-in principal when changing account.
    await accounts.logout(getToken(req));await store.logout(getToken(req));
    if(result.token)res.setHeader('Set-Cookie',`${cookie}=${result.token}; ${cookiePolicy}; Max-Age=43200`);
    else res.setHeader('Set-Cookie',`${cookie}=; ${cookiePolicy}; Max-Age=0`);
    const {token,...safe}=result;return send(res,200,{...safe,authenticated:!!token,hostedSandbox:true,previewMode:!!tracking?.simulated,customerAccounts:true,emailSendingEnabled:mail.enabled,localEmailPreview:!!mail.preview});
   }
   if(url.pathname==='/api/login'&&req.method==='POST'){
    // The global DB-backed cap cannot be bypassed with forged forwarding headers or parallel instances.
    await store.rate('login:global',50,900);
    const presented=digest(typeof b.code==='string'?b.code.slice(0,256):'');let principal=null;
    for(const p of config.testers)if(timingSafeEqual(Buffer.from(p.sha256hex,'hex'),Buffer.from(presented,'hex')))principal=p;
    if(!principal)throw new InputError('Access code not recognised.',401);
    await accounts?.logout(getToken(req));await store.logout(getToken(req));
    const token=randomBytes(32).toString('hex');await store.login(token,principal);
    res.setHeader('Set-Cookie',`${cookie}=${token}; ${cookiePolicy}; Max-Age=43200`);return send(res,200,{authenticated:true,hostedSandbox:true,previewMode:!!tracking?.simulated,customerAccounts:!!accounts});
   }
   const customer=await accounts?.session(getToken(req));
   const owner=customer?.owner??await store.session(getToken(req),config.testers);
   if(url.pathname==='/api/access'&&req.method==='GET')return send(res,200,{hostedSandbox:true,authenticated:!!owner,previewMode:!!tracking?.simulated,customerAccounts:!!accounts,emailSendingEnabled:mail.enabled,localEmailPreview:!!mail.preview,account:customer?.account??null});
   if(!owner)throw new InputError('Sign in to the private sandbox.',401);
   if(req.method==='GET'){
    await store.rate('read:'+owner,120,60);
    if(url.pathname==='/api/state')return send(res,200,{...await stateFor(owner),account:customer?.account??null});
    if(url.pathname==='/api/checkout-setup')return send(res,200,paymentsDisabled?{ready:false,reason:'Payments and external provider connections are disabled.'}:await pay.readiness());
    throw new InputError('Not found.',404);
   }
   await store.rate('mutation:'+owner,30,60);
   if(url.pathname.startsWith('/api/funding/')){
    if(!customer||!fundingDrafts)throw new InputError('Customer funding preparation is unavailable.',403);
    if(!['/api/funding/drafts','/api/funding/cancel'].includes(url.pathname))throw new InputError('Real payments are disabled. No provider request was made.',403);
    const result=url.pathname.endsWith('/drafts')?await fundingDrafts.prepare(owner,b):await fundingDrafts.cancel(owner,b);
    return send(res,200,{...await stateFor(owner),account:customer.account,selectedFundingDraftId:result.id});
   }
   if(url.pathname.startsWith('/api/test-funding/')){
    if(!tracking?.journey||!paymentsDisabled||!customer)throw new InputError('Sign in to a customer account to test funding.',403);
    const action=url.pathname.split('/').at(-1);
    if(action==='quote')return send(res,200,await tracking.journey.quote(owner,b));
    const result=action==='create'?await tracking.journey.create(owner,b):await tracking.journey.action(owner,b.id,b);
    return send(res,200,{...await stateFor(owner),account:customer.account,selectedOrderId:result.id});
   }
   switch(url.pathname){
    case '/api/logout':await accounts?.logout(getToken(req));await store.logout(getToken(req));res.setHeader('Set-Cookie',`${cookie}=; ${cookiePolicy}; Max-Age=0`);return send(res,200,{authenticated:false});
    case '/api/agents':{
     const name=typeof b.name==='string'?b.name.trim():'';if(name.length<2||name.length>60||b.own!==true||b.network!=='base')throw new InputError('Enter a name and confirm your own Base wallet.');
     await store.addAgent(owner,{id:randomUUID(),name,address:address(b.address),network:'Base',token:'USDC',ownership:'self_declared_unverified'});break;
    }
    case '/api/checkouts':{
     if(paymentsDisabled)throw new InputError('Payments are disabled. No checkout was created.',403);
     if(b.confirm!==true||b.consent!==true||!uuid(b.requestId)||!uuid(b.agentId))throw new InputError('Review the destination and confirm sharing it with Peer Pay.');
     const order=await store.createOrder(owner,{requestId:b.requestId,agentId:b.agentId,amount:pence(b.amount)});
     const claim=await store.claimCreate(owner,order.id);
     if(claim){try{await store.apply(claim,await pay.create(orderView(claim),config.origin),{creation:true});}catch{await store.fail(claim,'Checkout creation needs recovery. Keep this order; an operator must reconcile it before another attempt.');}}
     break;
    }
    case '/api/checkout-resume':case '/api/checkout-refresh':{
     if(paymentsDisabled)throw new InputError('External payment connections are disabled.',403);
     if(!uuid(b.id))throw new InputError('Order not found.',404);
     const order=await store.owned(owner,b.id);
     if(!order.provider_id)throw new InputError('Creation is unresolved. Keep this order for operator recovery; no new checkout has been created.',409);
     // Browser requests only schedule work; the worker owns provider reads and fenced writes.
     await store.schedule(owner,b.id);break;
    }
    default:throw new InputError('Not found.',404);
   }
   return send(res,200,{...await stateFor(owner),account:customer?.account??null});
  }catch(e){if(!res.headersSent)send(res,e instanceof InputError?e.status:e.code==='ENOENT'?404:503,{error:e instanceof InputError?e.message:'Service temporarily unavailable. Your saved records are retained.'});else res.end();}
 });
 server.requestTimeout=20000;server.headersTimeout=15000;
 return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const config=readConfig(),store=createStore(createPool());await migrateWhenReady(store);
 const tracking=await prepareTrackingSandbox(store,config.testers);
 const fundingDrafts=createFundingDrafts(store);await migrateWhenReady(fundingDrafts);
 const peerConnection=config.liveConnection?createPeerConnection({connection:config.liveConnection,store}):null;
 if(peerConnection)await migrateWhenReady(peerConnection);
 const server=createHostedServer({store,config,tracking,peerConnection,fundingDrafts,accountMail:configuredAccountMail(store),paymentsDisabled:true,pay:{readiness:async()=>({ready:false})}});server.listen(Number(process.env.PORT??10000),'0.0.0.0',()=>console.log('Relay hosted sandbox ready.'));
 // One read at startup, no polling. Until verified, the receiver returns 503.
 if(peerConnection)void peerConnection.checkIdentity();
 let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(closing)return;closing=true;server.close(async()=>{await tracking.close();await store.close();process.exit(0);});setTimeout(()=>process.exit(1),25000).unref();});
}
