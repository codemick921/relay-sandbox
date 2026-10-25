import {createTestInvites} from './test-invites.mjs';
import {checkoutRails,fundingCatalog} from '../shared/fiat.mjs';
import {createCustomerNotifications} from './customer-notifications.mjs';
import {historyOptions,renderStatement} from './funding-history.mjs';
import {healthOptions} from './payment-health.mjs';
import {paymentRecords,renderRecord} from './payment-records.mjs';
import {createAccountSecurity} from './account-security.mjs';
import {createWalletBalances} from './wallet-balances.mjs';
import {createReceiptRpc} from '../server/receipts.mjs';
import {createRampSimulation} from './ramp-simulation.mjs';
import {prepareLiveObservation} from './live-observation.mjs';
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
export function createHostedServer({store,config,pay=createSandboxPayService(),staticRoot=dist,allowHttpForTests=false,tracking=null,paymentsDisabled=false,localPreview=false,accountMail=null,customerAccountsEnabled=true,peerConnection=null,fundingDrafts=null,liveObservation=null,ramp=null,walletBalances=null}){
 const origin=new URL(config.origin),mail=accountMail??createAccountMail(store),accounts=customerAccountsEnabled?createAccounts(store,{mail}):null;
 if(fundingDrafts&&!paymentsDisabled)throw Error('Funding preparation requires payments to remain disabled.');
 if(tracking?.journey&&(!tracking.simulated||!tracking.journey.simulated||!paymentsDisabled))throw Error('Test funding requires simulated tracking and disabled payments.');
 if(mail.preview&&!localPreview)throw Error('Email previews are local only.');
 if(localPreview&&(!tracking?.simulated||!paymentsDisabled||origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'))throw Error('Local preview requires simulated tracking, disabled payments and loopback HTTP.');
 if(tracking&&!paymentsDisabled)throw Error('Tracking integration currently requires payments to remain disabled.');
 if(peerConnection&&(!paymentsDisabled||localPreview||!['receive_only','tracking_read_only'].includes(peerConnection.mode)))throw Error('Peer connection requires disabled payments and hosted receive-only mode.');
 if(liveObservation&&(!paymentsDisabled||localPreview||liveObservation.simulated!==false))throw Error('Live observation requires disabled payments and hosted reads.');
 const security=accounts&&createAccountSecurity(store,accounts,{mailEnabled:mail.enabled,mailPreview:!!mail.preview});
 const cookie=localPreview?'relay_local_preview':'__Host-relay_sandbox';
 const cookiePolicy=`${localPreview?'':'Secure; '}HttpOnly; SameSite=Strict; Path=/`;
 const getToken=req=>(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookie+'='))?.slice(cookie.length+1);
 const authenticate=async req=>(await accounts?.session(getToken(req)))?.owner??await store.session(getToken(req),config.testers);
 const isHealthAdmin=owner=>typeof owner==='string'&&!owner.startsWith('customer:')&&Array.isArray(config.paymentHealthAdmins)&&config.paymentHealthAdmins.includes(owner)&&config.testers.some(t=>t.label===owner);
 const invites=createTestInvites(store);
 const isInviteAdmin=owner=>typeof owner==='string'&&!owner.startsWith('customer:')&&config.testInviteAdmins?.includes(owner)&&config.testers.some(t=>t.label===owner);
 const stateFor=async owner=>{
  const base=await store.state(owner);let state={...base,paymentsDisabled:paymentsDisabled&&!liveObservation?.funding,...fundingDrafts&&owner.startsWith('customer:')?{liveFunding:liveObservation?.funding?{...fundingDisabled,paymentsEnabled:true,rails:checkoutRails,catalog:fundingCatalog}:fundingDisabled,fundingDrafts:await fundingDrafts.list(owner)}:{}};
  if(tracking){const [tracked,worker]=await Promise.all([tracking.store.state(owner),tracking.store.health()]);state={...state,previewMode:!!tracking.simulated,trackingEnabled:true,worker,fundingJourneyEnabled:!!tracking.journey,orders:[...(await tracking.journey?.decorate(owner,tracked.orders)??tracked.orders).map(o=>presentTrackedOrder(o,tracking.simulated)),...state.orders]};}
  if(liveObservation){const [live,status,restrictedTest,revolutTest]=await Promise.all([liveObservation.store.state(owner),liveObservation.status(),liveObservation.policy.status(owner),liveObservation.revolutPolicy?.status(owner)]);state={...state,liveTracking:{...status,enabled:true},restrictedTest,revolutTest,orders:[...live.orders.map(o=>({...presentTrackedOrder(o,false),trackingPath:'wallet-tracking'})),...state.orders]};}
  if(ramp&&owner.startsWith('customer:'))state={...state,rampFunding:{mode:'simulation',paymentsEnabled:false,externalConnectionsEnabled:false},orders:[...await ramp.state(owner),...state.orders]};
  if(state.fundingDrafts)state.orders=state.orders.map(o=>({...o,stoppedInRelay:!!state.fundingDrafts.find(d=>d.id===o.id)?.stoppedAt}));
  if(walletBalances&&owner.startsWith('customer:'))state.walletBalances=await walletBalances.state(owner);
  const testAccess=await invites.status(owner);
  if(testAccess){const canLive=!testAccess.revoked&&testAccess.allowLive&&testAccess.mode==='live';state={...state,testAccess:{...testAccess,realFundingAvailable:!!liveObservation?.funding},paymentsDisabled:state.paymentsDisabled||!canLive,liveFunding:state.liveFunding?{...state.liveFunding,paymentsEnabled:state.liveFunding.paymentsEnabled&&canLive}:undefined,fundingJourneyEnabled:state.fundingJourneyEnabled&&!testAccess.revoked&&testAccess.mode==='simulation'};}
  return {...state,adminTestInvites:!!isInviteAdmin(owner)};
 };
 const notifications=createCustomerNotifications(store,{scopes:[liveObservation?.store?.historyScope&&{...liveObservation.store.historyScope,simulated:false},tracking?.store?.historyScope&&{...tracking.store.historyScope,simulated:!!tracking.simulated}].filter(Boolean),simulatedBalances:!!walletBalances?.simulated});
 const handleTracking=tracking&&createLiveTrackingHandler({store:tracking.store,origin:config.origin,authenticate,rateLimit:(owner,kind)=>store.rate(kind==='read'?'read:'+owner:'mutation:'+owner,kind==='read'?120:30,60),simulated:!!tracking.simulated,localPreview,allowHttpForTests});
 const handleLive=liveObservation&&createLiveTrackingHandler({store:liveObservation.store,origin:config.origin,authenticate,rateLimit:(owner,kind)=>store.rate((kind==='read'?'read:':'mutation:')+owner,kind==='read'?120:30,60),simulated:false,allowHttpForTests,prefix:'/api/wallet-tracking'});
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   // Health probes disclose no customer/provider state and require no proxy headers.
   if(req.url==='/healthz'&&req.method==='GET'){try{await store.query('SELECT 1');return send(res,200,{ok:true,mode:liveObservation?.funding?'live':'sandbox',paymentsDisabled:paymentsDisabled&&!liveObservation?.funding,realPaymentsEnabled:!!liveObservation?.funding,restrictedCheckoutMode:liveObservation?.funding?'customer':liveObservation?'operator_only':'disabled',providerConnectionsEnabled:!!liveObservation?.funding||!paymentsDisabled,liveConnectionMode:peerConnection?.mode??'disabled',tracking:tracking?'simulated':null,liveTracking:liveObservation?'enabled':'disabled',release:process.env.RENDER_GIT_COMMIT??null});}catch{return send(res,503,{ok:false});}}
   if(req.headers.host!==config.host)return send(res,421,{error:'Unexpected host.'});
   if(!allowHttpForTests&&!localPreview&&req.headers['x-forwarded-proto']!=='https'){
    if(req.method==='GET'){res.writeHead(308,{Location:config.origin+'/'});return res.end();}return send(res,400,{error:'HTTPS required.'});
   }
   const url=new URL(req.url,config.origin);
   if(url.pathname==='/api/operator/payment-health'){
    if(req.method!=='GET')throw new InputError('Method not allowed.',405);
    if(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==config.origin)throw new InputError('Same-origin access required.',403);
    const token=getToken(req),customer=await accounts?.session(token),operator=customer?null:await store.session(token,config.testers);
    if(!isHealthAdmin(operator))throw new InputError('Payment-health admin access required.',403);
    await store.rate('payment-health:'+operator,60,60);
    const options=healthOptions(url.searchParams),selected=options.source==='live'?liveObservation:tracking;
    if(!selected?.store?.paymentHealth||options.source==='simulated'&&selected.simulated!==true)return send(res,200,{available:false,savedOnly:true,simulated:options.source==='simulated',reason:'Saved tracking evidence is not connected for this source.'});
    return send(res,200,await selected.store.paymentHealth({...options,simulated:options.source==='simulated'}));
   }
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
    return send(res,200,peerConnection?{...await peerConnection.status(),...liveObservation?{tracking:await liveObservation.status(),liveOrdersEnabled:!!liveObservation.funding,realPaymentsEnabled:!!liveObservation.funding}:{} }:{mode:'disabled',realPaymentsEnabled:false});
   }
   if(handleLive&&url.pathname.startsWith('/api/wallet-tracking/')&&await handleLive(req,res))return;
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
    const decoded=decodeURIComponent(url.pathname);if(decoded!=='/'&&!/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|png)$/.test(decoded))throw new InputError('Not found.',404);
    const file=path.join(staticRoot,decoded==='/'?'index.html':decoded.slice(1));const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]);return res.end(data);
   }
   const allowed=new Set(['/api/operator/test-invites','/api/operator/test-invites/create','/api/operator/test-invites/revoke','/api/test-access/claim','/api/test-access/mode','/api/notifications','/api/notifications/sync','/api/notifications/read','/api/notifications/preferences','/api/notifications/reminder','/api/wallet-balances/preferences','/api/wallet-balances/refresh','/api/ramp-test/create','/api/ramp-test/advance','/api/revolut-test/checkout','/api/funding/drafts','/api/funding/cancel','/api/funding/stop','/api/funding/request-cancellation','/api/funding/checkout','/api/funding/resume','/api/funding/availability','/api/test-funding/quote','/api/test-funding/create','/api/test-funding/action','/api/agents/update','/api/account/security','/api/account/revokeSession','/api/account/rotateRecovery','/api/account/confirmRecovery','/api/account/signup','/api/account/login','/api/account/recover','/api/account/password','/api/account/requestVerification','/api/account/requestReset','/api/account/verifyEmail','/api/account/resetPassword','/api/account/emailPreview','/api/access','/api/login','/api/logout','/api/state','/api/agents','/api/checkouts','/api/checkout-resume','/api/checkout-refresh','/api/checkout-setup']);
   const historyRoute=url.pathname==='/api/funding-history'||url.pathname==='/api/funding-history/download'||/^\/api\/funding-history\/[a-f0-9-]{36}$/i.test(url.pathname);
   const recordRoute=url.pathname==='/api/payment-records'||/^\/api\/payment-records\/[a-f0-9-]{36}\/download$/i.test(url.pathname);
   if(!allowed.has(url.pathname)&&!recordRoute&&!historyRoute)throw new InputError('Not found.',404);
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
    if(['security','revokeSession','rotateRecovery','confirmRecovery'].includes(action))return send(res,200,await security[action](b,getToken(req)));
    const result=await accounts[action](b,getToken(req),{userAgent:req.headers['user-agent']});
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
    res.setHeader('Set-Cookie',`${cookie}=${token}; ${cookiePolicy}; Max-Age=43200`);return send(res,200,{authenticated:true,hostedSandbox:true,previewMode:!!tracking?.simulated,customerAccounts:!!accounts,adminPaymentHealth:isHealthAdmin(principal.label)});
   }
   const customer=await accounts?.session(getToken(req));
   const owner=customer?.owner??await store.session(getToken(req),config.testers);
   if(url.pathname==='/api/access'&&req.method==='GET')return send(res,200,{hostedSandbox:true,authenticated:!!owner,previewMode:!!tracking?.simulated,customerAccounts:!!accounts,emailSendingEnabled:mail.enabled,localEmailPreview:!!mail.preview,account:customer?.account??null,adminPaymentHealth:!customer&&isHealthAdmin(owner)});
   if(!owner)throw new InputError('Sign in to the private sandbox.',401);
   if(url.pathname.startsWith('/api/operator/test-invites')){
    if(customer||!isInviteAdmin(owner))throw new InputError('Test invitation admin access required.',403);
    if(req.headers.origin&&req.headers.origin!==config.origin)throw new InputError('Same-origin access required.',403);
    await store.rate('test-invites-admin:'+owner,20,60);
    if(url.pathname==='/api/operator/test-invites'&&req.method==='GET')return send(res,200,await invites.list());
    if(req.method!=='POST')throw new InputError('Method not allowed.',405);
    if(url.pathname.endsWith('/create'))return send(res,200,await invites.issue(owner,b));
    if(url.pathname.endsWith('/revoke'))return send(res,200,await invites.revoke(owner,b));
    throw new InputError('Method not allowed.',405);
   }
   if(url.pathname.startsWith('/api/test-access/')){
    if(!customer)throw new InputError('Customer sign-in required.',403);
    if(req.method!=='POST')throw new InputError('Method not allowed.',405);
    if(url.pathname.endsWith('/claim'))await invites.claim(owner,b);
    else {if(b.mode==='live'&&!liveObservation?.funding)throw new InputError('Real payments are currently unavailable. Your account stays in simulation mode.',403);await invites.mode(owner,b);}
    return send(res,200,{...await stateFor(owner),account:customer.account});
   }
   if(url.pathname.startsWith('/api/notifications')){
    if(!customer)throw new InputError('Customer sign-in required.',403);
    if(req.headers.origin&&req.headers.origin!==config.origin)throw new InputError('Same-origin access required.',403);
    await store.rate('notices:'+owner,60,60);
    if(url.pathname==='/api/notifications'&&req.method==='GET')return send(res,200,await notifications.list(owner,url.searchParams));
    const action=url.pathname.split('/').at(-1);
    if(req.method!=='POST'||!['sync','read','preferences','reminder'].includes(action))throw new InputError('Method not allowed.',405);
    if(action==='sync'&&Object.keys(b).length)throw new InputError('Invalid notification request.');
    await notifications[action](owner,b);return send(res,200,{ok:true});
   }
   if(req.method==='GET'){
    await store.rate('read:'+owner,120,60);
    if(url.pathname==='/api/state')return send(res,200,{...await stateFor(owner),account:customer?.account??null,adminPaymentHealth:!customer&&isHealthAdmin(owner)});
    const historyScopes=[liveObservation?.store?.historyScope&&{...liveObservation.store.historyScope,simulated:false},tracking?.store?.historyScope&&{...tracking.store.historyScope,simulated:!!tracking.simulated}].filter(Boolean);
    if(historyRoute){
     if(!customer)throw new InputError('Sign in to your customer account to view funding history.',403);
     if(req.headers.origin&&req.headers.origin!==config.origin)throw new InputError('Same-origin access required.',403);
     await store.rate('history:'+owner,30,60);
     const options=historyOptions(url.searchParams),download=url.pathname==='/api/funding-history/download',id=/[a-f0-9-]{36}$/i.test(url.pathname)?url.pathname.split('/').at(-1):null;
     const data=await store.fundingHistory(owner,options,historyScopes,{id,download});
     if(!download)return send(res,200,data);
     const format=url.searchParams.get('format');if(!['html','csv'].includes(format))throw new InputError('Choose HTML or CSV.');
     res.setHeader('Content-Type',format==='html'?'text/html; charset=utf-8':'text/csv; charset=utf-8');
     res.setHeader('Content-Disposition',`attachment; filename="eupova-${options.source}-statement-${options.from||'all'}-${options.to||'latest'}.${format}"`);
     return res.end(renderStatement(data,format));
    }
    if(recordRoute){
     if(!customer)throw new InputError('Sign in to your customer account to view funding records.',403);
     const fullRecord=url.pathname!=='/api/payment-records'&&store.fundingHistory&&historyScopes.length;
     const records=fullRecord?(await store.fundingHistory(owner,{},historyScopes,{id:url.pathname.split('/')[3]})).records:paymentRecords(await stateFor(owner));
     if(url.pathname==='/api/payment-records')return send(res,200,{records});
     const record=records.find(r=>r.id===url.pathname.split('/')[3]);
     if(!record)throw new InputError('Funding record not found.',404);
     const format=url.searchParams.get('format');
     if(!['html','csv'].includes(format))throw new InputError('Choose HTML or CSV.');
     res.setHeader('Content-Type',format==='html'?'text/html; charset=utf-8':'text/csv; charset=utf-8');
     res.setHeader('Content-Disposition',`attachment; filename="eupova-${record.simulated?'simulated-':''}${record.document}-${record.id}.${format}"`);
     return res.end(renderRecord(record,format));
    }

    if(url.pathname==='/api/checkout-setup')return send(res,200,paymentsDisabled?{ready:false,reason:'Payments and external provider connections are disabled.'}:await pay.readiness());
    throw new InputError('Not found.',404);
   }
   if(recordRoute||historyRoute)throw new InputError('Method not allowed.',405);
   await store.rate('mutation:'+owner,30,60);
   if(url.pathname.startsWith('/api/wallet-balances/')){
    if(!customer||!walletBalances)throw new InputError('Customer wallet monitoring is unavailable.',403);
    await walletBalances[url.pathname.endsWith('/preferences')?'preferences':'refresh'](owner,b);
    return send(res,200,{...await stateFor(owner),account:customer.account});
   }
   if(url.pathname.startsWith('/api/ramp-test/')){
    if(!customer||!ramp?.simulated)throw new InputError('Ramp simulation is unavailable.',403);
    const result=await invites.withMode(owner,'simulation',()=>url.pathname.endsWith('/create')?ramp.create(owner,b):ramp.advance(owner,b));
    return send(res,200,{...await stateFor(owner),account:customer.account,selectedOrderId:result.id});
   }
   if(url.pathname==='/api/revolut-test/checkout'){
    if(!customer||!liveObservation?.revolutRelease)throw new InputError('Customer test access is unavailable.',403);
    return send(res,200,await invites.withMode(owner,'live',()=>liveObservation.revolutRelease(owner,b)));
   }
   if(url.pathname.startsWith('/api/funding/')){
    if(!customer||!fundingDrafts)throw new InputError('Customer funding preparation is unavailable.',403);
    if(url.pathname==='/api/funding/stop'&&liveObservation?.funding){
     const result=await liveObservation.funding.stop(owner,b);
     return send(res,200,{...await stateFor(owner),account:customer.account,selectedFundingDraftId:result.id});
    }
    if(url.pathname==='/api/funding/request-cancellation'&&liveObservation?.funding){
     const result=await liveObservation.funding.requestCancellation(owner,b);
     return send(res,200,{...await stateFor(owner),account:customer.account,selectedFundingDraftId:result.id});
    }
    if(url.pathname==='/api/funding/checkout'&&liveObservation?.funding){
     const result=await invites.withMode(owner,'live',()=>liveObservation.funding.start(owner,b));
     return send(res,200,{...await stateFor(owner),account:customer.account,selectedFundingDraftId:result.id});
    }
    if(url.pathname==='/api/funding/resume'&&liveObservation?.funding){
     if(b.confirm!==true||Object.keys(b).some(k=>!['id','confirm'].includes(k)))throw new InputError('Confirm opening your existing checkout.');
     return send(res,200,await invites.withMode(owner,'live',()=>liveObservation.funding.checkout(owner,b.id)));
    }
    if(!['/api/funding/drafts','/api/funding/cancel'].includes(url.pathname))throw new InputError('Real payments are disabled. No provider request was made.',403);
    const result=url.pathname.endsWith('/drafts')?await fundingDrafts.prepare(owner,b):await fundingDrafts.cancel(owner,b);
    return send(res,200,{...await stateFor(owner),account:customer.account,selectedFundingDraftId:result.id});
   }
   if(url.pathname.startsWith('/api/test-funding/')){
    if(!tracking?.journey||!paymentsDisabled||!customer)throw new InputError('Sign in to a customer account to test funding.',403);
    const action=url.pathname.split('/').at(-1);
    if(action==='quote')return send(res,200,await invites.withMode(owner,'simulation',()=>tracking.journey.quote(owner,b)));
    const result=await invites.withMode(owner,'simulation',()=>action==='create'?tracking.journey.create(owner,b):tracking.journey.action(owner,b.id,b));
    return send(res,200,{...await stateFor(owner),account:customer.account,selectedOrderId:result.id});
   }
   switch(url.pathname){
    case '/api/logout':await accounts?.logout(getToken(req));await store.logout(getToken(req));res.setHeader('Set-Cookie',`${cookie}=; ${cookiePolicy}; Max-Age=0`);return send(res,200,{authenticated:false});
    case '/api/agents':case '/api/agents/update':{
     if(customer){await security.saveWallet(b,getToken(req),{update:url.pathname.endsWith('/update')});break;}
     if(url.pathname.endsWith('/update'))throw new InputError('Customer sign-in required.',403);
     const name=typeof b.name==='string'?b.name.trim():'';if(name.length<2||name.length>60||b.own!==true||b.network!=='base')throw new InputError('Enter a name and confirm your own Base wallet.');
     await store.addAgent(owner,{id:randomUUID(),name,address:address(b.address),network:'Base',token:'USDC',ownership:'self_declared_unverified'});break;
    }
    case '/api/checkouts':{
     if(paymentsDisabled||await invites.status(owner))throw new InputError('Payments are disabled. No checkout was created.',403);
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
 const config=readConfig(),pool=createPool(),store=createStore(pool);await migrateWhenReady(store);
 const tracking=await prepareTrackingSandbox(store,config.testers);
 const fundingDrafts=createFundingDrafts(store);await migrateWhenReady(fundingDrafts);
 const liveObservation=config.liveConnection?await prepareLiveObservation({pool,base:store,connection:config.liveConnection,drafts:fundingDrafts,livePayments:config.livePayments,origin:config.origin}):null;
 const peerConnection=config.liveConnection?createPeerConnection({connection:config.liveConnection,store,tracker:liveObservation?.store}):null;
 if(peerConnection)await migrateWhenReady(peerConnection);
 const ramp=createRampSimulation(store);await ramp.migrate();
 const walletBalances=liveObservation?createWalletBalances(store,{rpc:createReceiptRpc(process.env.BASE_RPC_URL||'https://mainnet.base.org')}):null;
 if(walletBalances)await walletBalances.migrate();
 const server=createHostedServer({store,config,tracking,ramp,walletBalances,peerConnection,fundingDrafts,liveObservation,accountMail:configuredAccountMail(store),paymentsDisabled:true,pay:{readiness:async()=>({ready:false})}});server.listen(Number(process.env.PORT??10000),'0.0.0.0',()=>console.log('Eupova hosted sandbox ready.'));
 // One read at startup, no polling. Until verified, the receiver returns 503.
 if(peerConnection)void peerConnection.checkIdentity();
 if(liveObservation)void liveObservation.start();
 walletBalances?.start();
 let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(closing)return;closing=true;server.close(async()=>{await walletBalances?.stop();await liveObservation?.stop();await tracking.close();await store.close();process.exit(0);});setTimeout(()=>process.exit(1),25000).unref();});
}
