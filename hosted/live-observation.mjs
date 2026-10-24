// Live tracking is independent of the explicitly enabled customer checkout writer.
import {createCustomerFunding} from './customer-funding.mjs';
import {createLiveStore} from './live-store.mjs';
import {createLiveWorker} from './live-worker.mjs';
import {createRestrictedTestPolicy} from './restricted-test.mjs';
import {createRevolutPolicy,createRevolutRelease} from './revolut-test.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
import {createReceiptRpc} from '../server/receipts.mjs';
export async function prepareLiveObservation({pool,base,connection,drafts,livePayments=false,origin,fetcher=fetch,rpc=createReceiptRpc('https://mainnet.base.org')}){
 if(connection?.environment!=='LIVE'||connection.mode!=='receive_only')throw Error('Explicit live read connection required.');
 const store=createLiveStore(pool,{merchantId:connection.merchantId});await store.migrate();
 const policy=createRestrictedTestPolicy(base);await policy.migrate();
 const revolutPolicy=createRevolutPolicy(base);await revolutPolicy.migrate();
 const reader=createLiveReadService({apiKey:connection.apiKey,merchantId:connection.merchantId,rpc,fetcher});
 const worker=createLiveWorker({store:{...store,apply:async(claim,result)=>{const applied=await store.apply(claim,result);if(applied)await drafts.closeVerified(claim.id);return applied;}},pay:reader,maxBatch:1});
 let timer=null,stopping=false,started=false,active=null,lastTick=null,lastError=false;
 async function tick(){if(stopping||active)return;active=(async()=>{try{await drafts.recoverStalled();await worker.tick();lastError=false;lastTick=new Date().toISOString();}catch{lastError=true;}finally{active=null;}})();await active;}
 async function loop(){await tick();if(!stopping)timer=setTimeout(loop,15000);}
 const funding=livePayments?createCustomerFunding({drafts,tracker:store,reader,connection,origin,fetcher}):null;
 return Object.freeze({funding,store,policy,revolutPolicy,revolutRelease:createRevolutRelease({drafts,policy:revolutPolicy,reader,store,merchantId:connection.merchantId}),simulated:false,
  async start(){if(started||stopping)return;started=true;await loop();},
  tick,
  async stop(){stopping=true;clearTimeout(timer);await worker.stop();if(active)await active;},
  async status(){return {mode:funding?'customer_payments':'read_only',paymentsEnabled:!!funding,worker:await store.health(),timer:{started,stopping,lastTick,lastError}};}
 });
}
