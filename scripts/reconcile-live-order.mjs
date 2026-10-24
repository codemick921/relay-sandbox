// Operator-only. No HTTP entrypoint. Uses existing server credentials in place.
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createPool,createStore} from '../hosted/db.mjs';
import {createLiveStore,liveOrderView} from '../hosted/live-store.mjs';
import {createLiveReadService} from '../server/pay-readonly.mjs';
import {createReceiptRpc} from '../server/receipts.mjs';
const [id,mode,reason]=process.argv.slice(2);
if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id??'')||!['--check','--resolve'].includes(mode))throw Error('Supply one existing Relay order ID and --check or --resolve with an operator reason.');
const merchantId=process.env.PEER_PAY_LIVE_MERCHANT_ID,pool=createPool(),store=createLiveStore(pool,{merchantId});
const reader=createLiveReadService({merchantId,apiKey:process.env.PEER_PAY_LIVE_API_KEY,rpc:createReceiptRpc(process.env.BASE_RPC_URL||'https://mainnet.base.org')});
try{
 const row=(await store.query('SELECT * FROM relay_live_orders WHERE id=$1 AND merchant_id=$2',[id,merchantId])).rows[0];
 if(!row)throw Error('Order not found.');
 const result=await reader.refresh(liveOrderView(row));
 console.log(JSON.stringify({id,reviewRequired:row.review_required,status:result.status,verification:result.verification,delivery:result.delivery}));
 if(mode==='--resolve'){
  if(!row.review_required||result.status!=='checkout_received'||result.chargebackStatus!=='NONE'||!reason||reason.length<12)throw Error('Resolution requires a held order, finalised delivery, no chargeback and a reason.');
  const claim=await store.claimNext({orderId:id});if(!claim)throw Error('Order is being checked; try again after its current check.');
  try{
   const fresh=await reader.refresh(liveOrderView(claim));
   if(!await store.apply(claim,fresh,{resolveReviewReason:reason}))throw Error('Order changed during verification; no resolution applied.');
   await createFundingDrafts(createStore(pool)).closeVerified(id);
   console.log('Review resolved with fresh finalised evidence.');
  }catch(e){await store.fail(claim);throw e;}
 }
}finally{await pool.end();}
