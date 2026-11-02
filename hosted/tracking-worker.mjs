// Dedicated observation process. No checkout writer, signing key or payment execution.
import {fileURLToPath} from 'node:url';
import {createPool,createStore} from './db.mjs';
import {createLiveStore} from './live-store.mjs';
import {createLiveWorker} from './live-worker.mjs';
import {createFundingDrafts} from './funding-drafts.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
import {createReceiptRpc} from '../server/receipts.mjs';
import {createPeerlyticsReader} from '../server/peerlytics-readonly.mjs';
import {migrateTrackingOperations} from './tracking-operations.mjs';
export function trackingWorkerConfig(env){
 if(env.EUPOVA_DEDICATED_TRACKING_ENABLED!=='true')throw Error('Dedicated tracking must be explicitly enabled.');
 if(!env.DATABASE_URL||!env.PEER_PAY_LIVE_API_KEY||!env.PEER_PAY_LIVE_MERCHANT_ID)throw Error('Read-only tracking configuration incomplete.');
 return {merchantId:env.PEER_PAY_LIVE_MERCHANT_ID,apiKey:env.PEER_PAY_LIVE_API_KEY,rpc:env.BASE_RPC_URL||'https://mainnet.base.org'};
}
export function webTrackingEnabled(env){if(!['web','dedicated',undefined].includes(env.EUPOVA_TRACKING_ROLE))throw Error('Invalid tracking role.');return env.EUPOVA_TRACKING_ROLE!=='dedicated';}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const config=trackingWorkerConfig(process.env),pool=createPool(),base=createStore(pool);
 const store=createLiveStore(pool,{merchantId:config.merchantId});await store.migrate();await migrateTrackingOperations(base);
 const drafts=createFundingDrafts(base);
 const reader=createLiveReadService({...config,rpc:createReceiptRpc(config.rpc),corroborator:createPeerlyticsReader({})});
 const worker=createLiveWorker({store:{...store,apply:async(claim,result)=>{const applied=await store.apply(claim,result);if(applied)await drafts.closeVerified(claim.id);return applied;}},pay:reader,maxBatch:5});
 await base.query('INSERT INTO eupova_tracking_runtime(merchant_id,revision) VALUES($1,$2) ON CONFLICT(merchant_id) DO UPDATE SET revision=$2',[config.merchantId,process.env.RENDER_GIT_COMMIT??'local']);
 let timer,stopping=false;
 async function loop(){
  // A blocked provider/database must not keep a misleading fresh heartbeat alive.
  const watchdog=setTimeout(()=>{console.error('Tracking cycle exceeded deadline; restarting for lease recovery.');process.exit(1);},180000);watchdog.unref();
  try{await drafts.recoverStalled();await worker.tick();await base.query('UPDATE eupova_tracking_runtime SET beat_at=now() WHERE merchant_id=$1',[config.merchantId]);console.log('Tracking cycle complete.');}catch{console.error('Tracking cycle failed; saved evidence retained.');}finally{clearTimeout(watchdog);if(!stopping)timer=setTimeout(loop,15000);}
 }
 void loop();
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopping)return;stopping=true;clearTimeout(timer);setTimeout(()=>process.exit(1),25000).unref();await worker.stop();await pool.end();process.exit(0);});
}
