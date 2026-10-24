// A single recoverable sandbox fixture, isolated from the user's browser session.
// Does not sign, spend, submit a real payment, or call Relay's manual refresh endpoint.
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {getMerchant} from '@zkp2p/pay-sdk';
import {atomicJson} from '../server/pay-webhooks.mjs';
const journal='.data/webhook-flow-test.json',base='http://127.0.0.1:4319',api='https://api.pay.peer.xyz/api/v1';
const key=process.env.PEER_PAY_SANDBOX_API_KEY;
async function run(){
 const command=process.argv[2];let state=existsSync(journal)?JSON.parse(readFileSync(journal,'utf8')):null;
 if(command==='create'){
  const m=await getMerchant({apiKey:key,apiBaseUrl:'https://api.pay.peer.xyz',signal:AbortSignal.timeout(15000)});
  if(m.environment!=='SANDBOX'||m.id!=='cmvmejar103pp1248gbkva6ff')throw Error('Sandbox merchant required.');
  if(!state){const r=await fetch(base+'/api/state');await r.json();const cookie=r.headers.get('set-cookie')?.split(';')[0].trim();if(!cookie)throw Error('Isolated session missing.');state={cookie,requestId:randomUUID(),startedAt:new Date().toISOString()};atomicJson(journal,state);}
  const request=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Cookie:state.cookie,Origin:base,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Relay test request failed; inspect existing fixture before retrying.');return r.json();};
  let session=await request('/api/state');
  if(!session.agents.length)session=await request('/api/agents',{name:'Webhook sandbox example — no real funds',address:'0x1111111111111111111111111111111111111111',network:'base',own:true});
  session=await request('/api/checkouts',{agentId:session.agents[0].id,amount:'10.00',requestId:state.requestId,confirm:true,consent:true});
  const order=session.orders.find(o=>o.requestId===state.requestId);if(!order?.providerOrderId||order.source!=='sandbox')throw Error('Sandbox binding missing.');
  state={...state,localOrderId:order.id,providerOrderId:order.providerOrderId,merchantId:order.merchantId};atomicJson(journal,state);
  console.log(JSON.stringify({localOrderId:order.id,providerOrderId:order.providerOrderId,status:order.status,environment:'SANDBOX',gbp:'10.00',realFunds:false},null,2));
 }else if(command==='settle'){
  if(!state?.providerOrderId||state.settlementRequestedAt)throw Error('Fresh known sandbox test order required; reconcile any previous request.');
  const m=await getMerchant({apiKey:key,apiBaseUrl:'https://api.pay.peer.xyz',signal:AbortSignal.timeout(15000)});if(m.environment!=='SANDBOX'||m.id!==state.merchantId)throw Error('Sandbox merchant mismatch.');
  state.settlementRequestedAt=new Date().toISOString();atomicJson(journal,state);
  const r=await fetch(api+'/sandbox/test-order',{method:'POST',headers:{'X-API-Key':key,'Content-Type':'application/json'},body:JSON.stringify({orderId:state.providerOrderId,rail:'wise'}),redirect:'error',signal:AbortSignal.timeout(20000)});
  const b=await r.json();if(!r.ok||b.success!==true)throw Error('Sandbox simulation outcome requires reconciliation; do not resubmit.');
  state.simulationAcknowledgedAt=new Date().toISOString();atomicJson(journal,state);console.log(JSON.stringify({status:r.status,simulationAcknowledged:true,providerOrderId:state.providerOrderId,realFunds:false}));
 }else if(command==='inspect'){
  if(!state?.providerOrderId)throw Error('Test fixture required.');
  const sessions=JSON.parse(readFileSync('.data/peer-sessions.json','utf8'));
  const order=Object.values(sessions).flatMap(s=>s.orders).find(o=>o.id===state.localOrderId);
  const inbox=JSON.parse(readFileSync('.data/peer-sessions.json.webhooks','utf8')).filter(e=>e.orderId===state.providerOrderId);
  const r=await fetch(api+'/merchants/me/orders/'+state.providerOrderId+'/payments',{headers:{'X-API-Key':key},redirect:'error',signal:AbortSignal.timeout(15000)});const b=await r.json();if(!r.ok||b.success!==true)throw Error('Authenticated payment read failed.');
  const evidence={checkedAt:new Date().toISOString(),environment:'SANDBOX',localOrderId:state.localOrderId,providerOrderId:state.providerOrderId,gbp:'10.00',relayStatus:order?.status,providerStatus:order?.providerStatus,checkedByRelayAt:order?.checkedAt,trackingError:order?.trackingError,verification:order?.verification,delivery:order?.delivery??null,events:order?.events,notifications:inbox.map(e=>({deliveryId:e.deliveryId,eventId:e.eventId,type:e.type,state:e.state,receivedAt:new Date(e.receivedAt).toISOString(),processedAt:e.processedAt?new Date(e.processedAt).toISOString():null,attempts:e.attempts})),payments:b.responseObject.payments.map(p=>({id:p.id,status:p.status,rail:p.rail,currency:p.currency,orderIdMatches:p.orderId===state.providerOrderId,netSettledUsdcAmount:p.netSettledUsdcAmount})),browserRefreshUsed:false,manualRefreshEndpointUsed:false,realFundsMoved:false,realWalletReceiptVerified:false};
  writeFileSync('sandbox-webhook-flow-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
 }else throw Error('Choose create, settle or inspect.');
}
run().catch(()=>{console.error('Sandbox test stopped. Reconcile the private fixture journal; no credentials or checkout links printed.');process.exitCode=1;});
