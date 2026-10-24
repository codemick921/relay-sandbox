import {createFundingJourney} from './funding-journey.mjs';
// Persistent synthetic tracking only. This module has no provider or RPC client.
import {createHash} from 'node:crypto';
import {createPool} from './db.mjs';
import {createLiveStore,liveOrderView} from './live-store.mjs';
import {createLiveWorker} from './live-worker.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {TrackingReviewError} from '../server/pay-readonly.mjs';
import {local,remote,payment,receipt,rpc} from '../tests/fixtures/live-evidence.mjs';
export const trackingSchema='relay_tracking_sandbox_v1';
const merchantId='relay-fixture-only';
const hex=value=>createHash('sha256').update(value).digest('hex');
const id=value=>{const h=hex(value);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
export function sandboxIntent(owner,stage){
 const key=hex(owner+':'+stage);
 return {...local(),id:id('order:'+key),merchantId,providerOrderId:'fixture-'+key,requestedUsdcAmount:'12.5',agent:{...local().agent,id:id('wallet:'+owner),name:'Example research agent',network:'Base',token:'USDC'}};
}
export async function fixtureResult(order,stage,{initial=false}={}){
 if(stage==='review')throw new TrackingReviewError('Simulated review hold.');
 const key=hex(order.id),p={...payment(),id:'fixture-payment-'+key,orderId:order.providerOrderId,railIdentifier:'0x'+hex('intent:'+key),fulfillTransaction:'0x'+hex('tx:'+key)};
 p.quote={...p.quote,intentHash:p.railIdentifier};
 const provider={...remote(),id:order.providerOrderId,merchantId,notes:{relayOrderId:order.id},...stage==='partial'?{status:'PARTIALLY_FULFILLED',remainingUsdcAmount:'0.5'}:{}};
 const pending=stage==='confirming'&&initial;
 const chain=rpc({getTransactionReceipt:async()=>receipt(p),getBlock:async({blockTag})=>({hash:receipt(p).blockHash,number:blockTag==='finalized'&&pending?119n:120n})});
 const result=await verifyPayDelivery(order,provider,[p],{rpc:chain});
 return {...result,providerStatus:provider.status,chargebackStatus:'NONE',checkedAt:result.verification.checkedAt};
}
export async function prepareTrackingSandbox(baseStore,testers,{connectionString=process.env.DATABASE_URL,schema=trackingSchema}={}){
 if(!/^relay_tracking_sandbox_[a-z0-9_]+$/.test(schema))throw Error('Use an isolated tracking sandbox schema.');
 // Fixed namespace isolates all synthetic receipts from both existing sandbox
 // records and any future real tracking store. Never seed customer wallet data.
 await baseStore.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431928)');await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);});
 const pool=createPool(connectionString,{schema}),store=createLiveStore(pool,{merchantId});
 try{
  await store.migrate();const journey=createFundingJourney({baseStore,store});await journey.migrate();const scenarios=new Map();
  for(const tester of testers)for(const stage of ['received','confirming','partial','review']){
   const order=sandboxIntent(tester.label,stage);scenarios.set(order.providerOrderId,stage);
   // Idempotent across processes/redeploys, initial results saved only once.
   await store.bindTrustedOrder(tester.label,order);
  }
  // One seed owner at a time; it is a short fixture-only transaction, no external IO.
  const c=await pool.connect();
  try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(431926)');
   const pending=(await c.query("SELECT * FROM relay_live_orders WHERE merchant_id=$1 AND result='{}'::jsonb FOR UPDATE",[merchantId])).rows;
   for(const row of pending){
    const stage=scenarios.get(row.provider_id);if(!stage)continue;
    const result=stage==='review'?{status:'checkout_review',trackingError:'Simulated payment evidence needs operator review.'}:await fixtureResult(liveOrderView(row),stage,{initial:true});
    await c.query("UPDATE relay_live_orders SET result=$2,status=$3,review_required=$4,next_check_at=now()+interval '100 years' WHERE id=$1",[row.id,result,result.status,stage==='review']);
   }
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  const pay={refresh:async order=>{const dynamic=await journey.refresh(order);if(dynamic)return dynamic;const stage=scenarios.get(order.providerOrderId);if(!stage)throw new TrackingReviewError('Unknown fixture.');return fixtureResult(order,stage);}};
  return {store,journey,simulated:true,close:()=>pool.end(),createWorker:()=>createLiveWorker({store:journey.workerStore(),pay})};
 }catch(error){await pool.end();throw error;}
}
