// Explicit operator commands; each mutation is journalled before it is sent.
// Private access codes and cookies never appear in stdout or deployment exports.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {getMerchant} from '@zkp2p/pay-sdk';
import {atomicJson} from '../server/pay-webhooks.mjs';
const command=process.argv[2],base=process.env.RELAY_HOSTED_ORIGIN;
if(!base||!/^https:\/\/[-a-z0-9]+\.onrender\.com$/.test(base))throw Error('Exact hosted Render origin required.');
const journal='.data/hosted-sandbox-test.json',privateFile='.data/render-private.json';
let state=existsSync(journal)?JSON.parse(readFileSync(journal,'utf8')):{origin:base,requestId:randomUUID()};
if(state.origin!==base)throw Error('Fixture belongs to a different origin.');
const key=process.env.PEER_PAY_SANDBOX_API_KEY,api='https://api.pay.peer.xyz/api/v1';
async function relay(endpoint,body){const r=await fetch(base+'/api/'+endpoint,{method:body?'POST':'GET',headers:{Cookie:state.cookie??'',Origin:base,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(40000)});if(!r.ok)throw Error('Relay returned '+r.status+' for '+endpoint);return r;}
async function login(){const privateState=JSON.parse(readFileSync(privateFile,'utf8')),code=privateState.testers.find(p=>p.label==='verification')?.code;if(!code)throw Error('Verification principal missing.');const r=await relay('login',{code});state.cookie=r.headers.get('set-cookie')?.split(';')[0];if(!state.cookie)throw Error('Session missing.');atomicJson(journal,state);}
async function merchant(){const m=await getMerchant({apiKey:key,apiBaseUrl:'https://api.pay.peer.xyz',signal:AbortSignal.timeout(15000)});if(m.environment!=='SANDBOX'||m.id!==process.env.PEER_PAY_SANDBOX_MERCHANT_ID)throw Error('Sandbox merchant mismatch.');return m;}
async function run(){
 if(command==='create'){
  await merchant();await login();let s=await(await relay('state')).json();
  if(!s.agents.length)s=await(await relay('agents',{name:'Hosted sandbox verification',address:'0x1111111111111111111111111111111111111111',network:'base',own:true})).json();
  if(!state.createRequestedAt){state.createRequestedAt=new Date().toISOString();atomicJson(journal,state);}
  s=await(await relay('checkouts',{agentId:s.agents[0].id,amount:'10.00',requestId:state.requestId,confirm:true,consent:true})).json();
  const o=s.orders.find(o=>o.requestId===state.requestId);if(!o?.providerOrderId||o.source!=='sandbox')throw Error('Creation unresolved. Keep the existing fixture.');
  state={...state,localOrderId:o.id,providerOrderId:o.providerOrderId,merchantId:o.merchantId};atomicJson(journal,state);console.log(JSON.stringify({environment:'SANDBOX',localOrderId:o.id,providerOrderId:o.providerOrderId,status:o.status,realFunds:false}));
 }else if(command==='settle'){
  await merchant();if(!state.providerOrderId||state.settlementRequestedAt)throw Error('Unknown or already requested simulation; reconcile before retry.');state.settlementRequestedAt=new Date().toISOString();atomicJson(journal,state);
  const r=await fetch(api+'/sandbox/test-order',{method:'POST',headers:{'X-API-Key':key,'Content-Type':'application/json'},body:JSON.stringify({orderId:state.providerOrderId,rail:'wise'}),redirect:'error',signal:AbortSignal.timeout(20000)});const b=await r.json();if(!r.ok||b.success!==true)throw Error('Unknown simulation outcome.');state.simulationAcknowledgedAt=new Date().toISOString();atomicJson(journal,state);console.log(JSON.stringify({simulationAcknowledged:true,realFunds:false}));
 }else if(command==='inspect'){
  await login();const s=await(await relay('state')).json(),o=s.orders.find(o=>o.id===state.localOrderId);if(!o)throw Error('Known test order missing.');
  const evidence={checkedAt:new Date().toISOString(),origin:base,environment:'SANDBOX',localOrderId:o.id,providerOrderId:o.providerOrderId,relayStatus:o.status,providerStatus:o.providerStatus,checkedByRelayAt:o.checkedAt,verification:o.verification,delivery:o.delivery??null,trackingError:o.trackingError,worker:s.worker,manualRefreshUsed:false,realFundsMoved:false,realWalletReceiptVerified:false};writeFileSync('deployment/2026-10-24-render/hosted-flow-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
 }else throw Error('Choose create, settle or inspect.');
}
run().catch(e=>{console.error('Hosted test stopped:',e.message.replace(/https?:\/\/\S+/g,'[URL]'));process.exitCode=1;});
