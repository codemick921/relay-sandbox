// Operator-only sandbox setup. Run from the project with node --env-file=.env.
// Secrets stay in owner-only local files; never send them to the browser or stdout.
import {readFileSync,writeFileSync,existsSync,chmodSync,renameSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {getMerchant} from '@zkp2p/pay-sdk';
import {atomicJson} from '../server/pay-webhooks.mjs';
import {sandboxPath} from '../server/webhook-ingress.mjs';
const api='https://api.pay.peer.xyz/api/v1',key=process.env.PEER_PAY_SANDBOX_API_KEY;
const stateFile='.data/sandbox-webhook-registration.json';
const events=['ORDER_CREATED','ORDER_FULFILLED','ORDER_CANCELLED','ORDER_RESIZED','ORDER_AMOUNT_SET','PAYMENT_CREATED','PAYMENT_SETTLED','PAYMENT_FAILED','PAYMENT_EXPIRED','PAYMENT_CANCELLED','PAYMENT_CHARGEBACKED','ORDER_PARTIALLY_CHARGEBACKED','ORDER_CHARGEBACKED'];
async function request(path,method='GET',body){
 const res=await fetch(api+path,{method,headers:{'X-API-Key':key,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(20000)});
 const json=await res.json();if(!res.ok||json.success!==true)throw Error(`Peer ${method} ${path} failed (HTTP ${res.status}); inspect provider state before retrying a mutation.`);
 return json.responseObject;
}
function saveSecret(secret,merchantId){
 if(typeof secret!=='string'||!/^whsec_[a-zA-Z0-9_-]+$/.test(secret))throw Error('Unexpected webhook secret format; creation response saved privately for recovery.');
 let env=readFileSync('.env','utf8');
 for(const [name,value] of Object.entries({PEER_PAY_SANDBOX_WEBHOOK_SECRET:secret,PEER_PAY_SANDBOX_MERCHANT_ID:merchantId})){
  const pattern=new RegExp('^'+name+'=.*$','m');env=pattern.test(env)?env.replace(pattern,name+'='+value):env.trimEnd()+'\n'+name+'='+value+'\n';
 }
 writeFileSync('.env.tmp',env,{mode:0o600});chmodSync('.env.tmp',0o600);const fd=openSync('.env.tmp','r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync('.env.tmp','.env');chmodSync('.env',0o600);
}
const safeHook=w=>({id:w.id,url:w.url,events:w.events,active:w.active});
async function main(){
 if(!key)throw Error('Sandbox API connection missing.');
 const merchant=await getMerchant({apiKey:key,apiBaseUrl:'https://api.pay.peer.xyz',signal:AbortSignal.timeout(15000)});
 if(merchant.environment!=='SANDBOX'||merchant.id!=='cmvmejar103pp1248gbkva6ff')throw Error('Expected Relay SANDBOX workspace required.');
 const command=process.argv[2]??'status';let state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):null;
 if(command==='status'||command==='connect'){
  const list=await request('/webhooks');if(!Array.isArray(list.webhooks))throw Error('Unexpected webhook list response.');
  if(command==='status'){console.log(JSON.stringify({environment:merchant.environment,merchantId:merchant.id,webhooks:list.webhooks.map(safeHook)},null,2));return;}
  const url=new URL(process.argv[3]);if(url.protocol!=='https:'||!/^[-a-z0-9]+\.trycloudflare\.com$/.test(url.hostname)||url.pathname!==sandboxPath||url.search||url.hash||url.username||url.password||url.port)throw Error('Exact public Cloudflare sandbox webhook URL required.');
  if(state?.status==='creation_requested')throw Error('Prior creation outcome unresolved. Read status and recover its secret before creating anything else.');
  if(state?.webhookId){
   const existing=list.webhooks.find(w=>w.id===state.webhookId);
   if(!existing||!process.env.PEER_PAY_SANDBOX_WEBHOOK_SECRET||state.merchantId!==merchant.id)throw Error('Saved webhook or signing secret missing; manual recovery required.');
   // Reuse our own registration when the temporary hostname changes.
   await request('/webhooks/'+state.webhookId,'PATCH',{url:url.href,events,active:true});
   state={...state,url:url.href,status:'connected',updatedAt:new Date().toISOString()};atomicJson(stateFile,state);
  }else{
   if(list.webhooks.some(w=>w.url===url.href))throw Error('This URL is already registered; do not create a duplicate with an unknown secret.');
   atomicJson(stateFile,{status:'creation_requested',merchantId:merchant.id,url:url.href,requestedAt:new Date().toISOString(),baselineIds:list.webhooks.map(w=>w.id)});
   const created=await request('/webhooks','POST',{url:url.href,events});
   // Persist the one-time creation secret before inspecting any further fields.
   atomicJson('.data/sandbox-webhook-secret-recovery.json',created);
   if(!created.webhook?.id||created.webhook.url!==url.href)throw Error('Unexpected creation response; preserved privately for recovery.');
   saveSecret(created.secret,merchant.id);
   state={status:'connected',environment:'SANDBOX',merchantId:merchant.id,webhookId:created.webhook.id,url:url.href,events,createdAt:new Date().toISOString()};atomicJson(stateFile,state);
  }
  const readback=await request('/webhooks');const saved=readback.webhooks.find(w=>w.id===state.webhookId);
  if(!saved?.active||saved.url!==url.href||events.some(e=>!saved.events.includes(e)))throw Error('Registration readback mismatch.');
  const evidence={...state,readback:safeHook(saved),secretSavedPrivately:true,realPaymentsExecuted:0};writeFileSync('sandbox-webhook-connection.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));return;
 }
 if(!state?.webhookId||state.merchantId!==merchant.id)throw Error('Saved sandbox registration required.');
 if(command==='test'){
  const r=await request('/webhooks/'+state.webhookId+'/test','POST');
  const safe={checkedAt:new Date().toISOString(),webhookId:state.webhookId,success:r.success,deliveryId:r.deliveryId,responseCode:r.responseCode,hasError:!!r.error};
  writeFileSync('sandbox-webhook-test.json',JSON.stringify(safe,null,2)+'\n');console.log(JSON.stringify(safe,null,2));
 }else if(command==='deliveries'){
  const r=await request('/webhooks/'+state.webhookId+'/deliveries');
  const safe={checkedAt:new Date().toISOString(),webhookId:state.webhookId,hasMore:r.hasMore,deliveries:r.deliveries.map(d=>({id:d.id,type:d.payload?.type,eventId:d.payload?.id,orderId:d.payload?.data?.order?.id??null,test:d.payload?.data?.test===true,status:d.status,attempts:d.attempts,responseCode:d.responseCode,lastAttemptAt:d.lastAttemptAt}))};
  writeFileSync('sandbox-webhook-deliveries.json',JSON.stringify(safe,null,2)+'\n');console.log(JSON.stringify(safe,null,2));
 }else if(command==='disable'){
  await request('/webhooks/'+state.webhookId,'PATCH',{active:false});
  const r=await request('/webhooks');if(r.webhooks.find(w=>w.id===state.webhookId)?.active!==false)throw Error('Disable readback failed.');
  atomicJson(stateFile,{...state,status:'disabled'});console.log('Relay sandbox webhook disabled and read back.');
 }else throw Error('Supported commands: status, connect URL, test, deliveries, disable.');
}
main().catch(e=>{console.error(e instanceof Error&&/^(Peer |Expected |Sandbox |Unexpected |Exact |Prior |Saved |This URL |Registration |Disable |Supported )/.test(e.message)?e.message:'Sandbox webhook operation failed; no credentials printed. Inspect the private registration journal before retrying.');process.exitCode=1;});
