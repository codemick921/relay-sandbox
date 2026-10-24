// Synthetic checkout only: no API, RPC, browser wallet or payment client.
import {randomUUID,createHash} from 'node:crypto';
import {InputError,pence} from '../server/validation.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {validateCheckout} from '../server/pay-contract.mjs';
import {TrackingReviewError} from '../server/pay-readonly.mjs';
import {remote,payment,receipt,rpc} from '../tests/fixtures/live-evidence.mjs';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const hex=x=>createHash('sha256').update(x).digest('hex');
const units=x=>{const n=BigInt(x);return `${n/1000000n}.${String(n%1000000n).padStart(6,'0')}`;};
export const journeyMerchant='relay-fixture-only';
export function createFundingJourney({baseStore,store}){
 const tx=store.tx,query=store.query;
 async function owned(c,owner,id){if(!uuid(id))throw new InputError('Test order not found.',404);const r=(await c.query('SELECT * FROM relay_fixture_checkouts WHERE id=$1 AND owner=$2 FOR UPDATE',[id,owner])).rows[0];if(!r)throw new InputError('Test order not found.',404);return r;}
 return {
  simulated:true,
  workerStore(){return {...store,apply:async(claim,result)=>{const applied=await store.apply(claim,result);if(applied)await query("UPDATE relay_live_orders SET next_check_at=now()+interval '3 seconds' WHERE id=$1 AND status IN ('checkout_settled','checkout_confirming') AND NOT review_required AND EXISTS(SELECT 1 FROM relay_fixture_checkouts WHERE id=$1)",[claim.id]);return applied;}};},
  async migrate(){await tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431927)');await c.query(`CREATE TABLE IF NOT EXISTS relay_fixture_quotes(id uuid PRIMARY KEY,owner text NOT NULL,quote jsonb NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS relay_fixture_checkouts(id uuid PRIMARY KEY REFERENCES relay_live_orders(id),owner text NOT NULL,request_id uuid NOT NULL,quote_id uuid NOT NULL UNIQUE REFERENCES relay_fixture_quotes(id),quote jsonb NOT NULL,scenario text CHECK(scenario IN ('success','partial','review')),submitted_at timestamptz,cancelled_at timestamptz,expires_at timestamptz NOT NULL,remainder_sent boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner,request_id));`);});},
  async quote(owner,input){
   const amount=pence(input.amount);if(!uuid(input.agentId))throw new InputError('Choose a saved agent wallet.');
   const agent=(await baseStore.state(owner)).agents.find(a=>a.id===input.agentId);if(!agent)throw new InputError('Choose a saved agent wallet.');
   const gross=BigInt(amount)*12500n,fee=gross/50n,id=randomUUID();
   const quote={id,agent:{...agent},pence:amount,platform:'wise',network:'Base',token:'USDC',rate:'1.25',grossUsdc:units(gross),feeUsdc:units(fee),netUsdc:units(gross-fee),netRaw:String(gross-fee),expiresAt:new Date(Date.now()+600000).toISOString(),simulated:true};
   await tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fixture:'+owner]);await c.query('DELETE FROM relay_fixture_quotes q WHERE owner=$1 AND expires_at<now() AND NOT EXISTS(SELECT 1 FROM relay_fixture_checkouts o WHERE o.quote_id=q.id)',[owner]);const count=(await c.query('SELECT count(*) FROM relay_fixture_quotes WHERE owner=$1',[owner])).rows[0];if(Number(count.count)>=200)throw new InputError('Test quote limit reached.',409);await c.query('INSERT INTO relay_fixture_quotes(id,owner,quote,expires_at) VALUES($1,$2,$3,$4)',[id,owner,quote,quote.expiresAt]);});
   return {quote};
  },
  async create(owner,input){
   if(!uuid(input.requestId)||!uuid(input.quoteId)||input.confirm!==true)throw new InputError('Review and confirm the test quote.');
   return tx(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fixture:'+owner]);
    const old=(await c.query('SELECT * FROM relay_fixture_checkouts WHERE owner=$1 AND (request_id=$2 OR quote_id=$3)',[owner,input.requestId,input.quoteId])).rows[0];
    if(old){if(old.quote_id!==input.quoteId)throw new InputError('This request belongs to another test quote.',409);return {id:old.id};}
    const q=(await c.query('SELECT * FROM relay_fixture_quotes WHERE id=$1 AND owner=$2 AND expires_at>now()',[input.quoteId,owner])).rows[0];if(!q)throw new InputError('This test quote has expired. Get a new quote.',409);
    const rows=await c.query("SELECT 1 FROM relay_fixture_checkouts f JOIN relay_live_orders o ON o.id=f.id WHERE f.owner=$1 AND ((f.submitted_at IS NOT NULL AND o.status<>'checkout_received') OR (f.submitted_at IS NULL AND f.cancelled_at IS NULL AND f.expires_at>now())) LIMIT 1",[owner]);if(rows.rows.length)throw new InputError('Resume your existing test order before starting another.',409);
    const count=(await c.query('SELECT count(*) FROM relay_fixture_checkouts WHERE owner=$1',[owner])).rows[0];if(Number(count.count)>=100)throw new InputError('Test order limit reached.',409);
    const id=randomUUID(),quote=q.quote,intent={id,kind:'checkout',source:'live',merchantId:journeyMerchant,providerOrderId:'fixture-'+id,requestedUsdcAmount:quote.grossUsdc,agent:quote.agent,quote:{pence:quote.pence,platform:'wise'}};
    await store.bindTrustedOrder(owner,intent,{client:c});
    await c.query('INSERT INTO relay_fixture_checkouts(id,owner,request_id,quote_id,quote,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[id,owner,input.requestId,q.id,quote,quote.expiresAt]);return {id};
   });
  },
  async action(owner,id,input){
   return tx(async c=>{
    const f=await owned(c,owner,id),order=(await c.query('SELECT * FROM relay_live_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(input.action==='cancel'){
     if(f.submitted_at)throw new InputError('A submitted test payment cannot be cancelled. Track the existing order.',409);
     await c.query('UPDATE relay_fixture_checkouts SET cancelled_at=coalesce(cancelled_at,now()) WHERE id=$1',[id]);
    }else if(input.action==='submit'){
     if(!['success','partial','review'].includes(input.scenario))throw new InputError('Choose a test outcome.');
     if(f.submitted_at){if(f.scenario!==input.scenario)throw new InputError('This order already has a different test payment.',409);return {id};}
     if(f.cancelled_at||new Date(f.expires_at)<=new Date())throw new InputError('This test checkout has ended. Start with a new quote.',409);
     await c.query('UPDATE relay_fixture_checkouts SET scenario=$2,submitted_at=now() WHERE id=$1',[id,input.scenario]);
    }else if(input.action==='remainder'){
     if(f.scenario!=='partial'||!f.submitted_at||order.review_required)throw new InputError('This test order has no payable remainder.',409);
     await c.query('UPDATE relay_fixture_checkouts SET remainder_sent=true WHERE id=$1',[id]);
    }else throw new InputError('Unknown test action.');
    // Fence a worker that read older checkout input before this action.
    await c.query("UPDATE relay_live_orders SET generation=generation+1,lease_token=NULL,lease_until=NULL,next_check_at=now() WHERE id=$1",[id]);return {id};
   });
  },
  async decorate(owner,orders){
   const rows=(await query('SELECT * FROM relay_fixture_checkouts WHERE owner=$1',[owner])).rows;const map=new Map(rows.map(x=>[x.id,x]));
   return orders.map(o=>{const f=map.get(o.id);if(!f)return o;return {...o,journey:true,requestId:f.request_id,journeyQuote:f.quote,checkoutExpiresAt:new Date(f.expires_at).toISOString(),testSubmitted:!!f.submitted_at,testScenario:f.scenario,remainderSent:f.remainder_sent,checkoutEnded:!f.submitted_at&&(!!f.cancelled_at||new Date(f.expires_at)<=new Date()),checkoutExpired:!f.submitted_at&&!f.cancelled_at&&new Date(f.expires_at)<=new Date()};});
  },
  async refresh(order){
   const f=(await query('SELECT * FROM relay_fixture_checkouts WHERE id=$1',[order.id])).rows[0];if(!f)return null;
   if(f.scenario==='review')throw new TrackingReviewError('Simulated mismatched payment evidence.');
   const cancelled=!f.submitted_at&&(f.cancelled_at||new Date(f.expires_at)<=new Date());
   const partial=f.scenario==='partial',net=BigInt(f.quote.netRaw),half=net/2n;
   const segments=!f.submitted_at?[]:partial?(f.remainder_sent?[half,net-half]:[half]):[net];
   const payments=segments.map((amount,i)=>{
    const p={...payment(),id:'fixture-payment-'+order.id+'-'+i,orderId:order.providerOrderId,netSettledUsdcAmount:units(amount),totalUsdcFeeAmount:units((BigInt(order.quote.pence)*12500n-net)*amount/net),railIdentifier:'0x'+hex(order.id+':intent:'+i),fulfillTransaction:'0x'+hex(order.id+':tx:'+i)};
    p.quote={intentHash:p.railIdentifier,signalIntent:{...payment().quote.signalIntent,toAddress:order.agent.address,amount:String(amount+(BigInt(order.quote.pence)*12500n-net)*amount/net)}};return p;
   });
   const complete=!!f.submitted_at&&(!partial||f.remainder_sent),provider={...remote(),id:order.providerOrderId,merchantId:journeyMerchant,destinationAddress:order.agent.address,requestedFiat:{amount:(order.quote.pence/100).toFixed(2),currency:'GBP'},requestedUsdcAmount:order.requestedUsdcAmount,notes:{relayOrderId:order.id},status:cancelled?'CANCELLED':complete?'FULFILLED':f.submitted_at?'PARTIALLY_FULFILLED':'CREATED',remainingUsdcAmount:complete?'0':partial?units(net-half):order.requestedUsdcAmount};
   validateCheckout(provider,order,journeyMerchant);
   // Same receipt verifier as the real adapter, with synthetic chain evidence.
   const pending=complete&&!['checkout_settled','checkout_confirming','checkout_received','checkout_partial'].includes(order.status);
   const confirming=complete&&order.status==='checkout_settled';
   const chain=rpc({getTransactionReceipt:async({hash})=>{if(pending){const e=Error('Fixture receipt pending');e.name='TransactionReceiptNotFoundError';throw e;}const p=payments.find(x=>x.fulfillTransaction===hash);if(!p)throw Error('Unknown fixture transaction');return receipt(p);},getBlock:async({blockTag})=>({hash:receipt(payments[0]??payment()).blockHash,number:blockTag==='finalized'&&confirming?119n:120n})});
   const result=await verifyPayDelivery(order,provider,payments,{rpc:chain});return {...result,providerStatus:provider.status,chargebackStatus:'NONE',checkedAt:result.verification.checkedAt};
  }
 };
}
