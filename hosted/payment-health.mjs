import {reconcileSavedPayment} from './payment-reconciliation.mjs';
// Saved evidence only. This reader has no provider client and no payment write path.
import {paymentRecord} from './payment-records.mjs';
import {InputError} from '../server/validation.mjs';

const date=v=>v&&Number.isFinite(new Date(v).getTime())?new Date(v).toISOString():null;
const events={bound:'Order linked to Relay',payin_observed:'Payment details saved',verified:'Verification result saved',review_required:'Evidence flagged for review',operator_review_resolved:'Earlier review resolved'};
const stages={checkout_ready:'awaiting payment',checkout_partial:'part payment recorded',checkout_settled:'settlement recorded',checkout_confirming:'transfer awaiting finality',checkout_received:'wallet receipt verified',checkout_cancelled:'provider order cancelled',checkout_review:'evidence review required'};
export const healthFilters=['attention','all','review','retry','overdue','partial','stopped_funds'];
export function healthOptions(params){
 const source=params.get('source')??'live',filter=params.get('filter')??'attention',page=params.get('page')??'1',id=params.get('id');
 if([...params.keys()].some(k=>!['source','filter','page','id'].includes(k))||[...new Set(params.keys())].some(k=>params.getAll(k).length!==1)||!['live','simulated'].includes(source)||!healthFilters.includes(filter)||!/^\d{1,6}$/.test(page)||Number(page)<1||Number(page)>100000||id&&!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))throw new InputError('Invalid payment-health filter.');
 return {source,filter,page:Number(page),id};
}

export function createPaymentHealthReader(pool,merchantId){
 return async function read({filter='attention',page=1,id=null,simulated=false}={}){
  // Defence in depth for callers other than HTTP; never interpolate request SQL.
  if(!healthFilters.includes(filter)||!Number.isInteger(page)||page<1||page>100000||id&&!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))throw new InputError('Invalid payment-health filter.');
  const c=await pool.connect();
  try{
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const now=new Date((await c.query('SELECT now() AS at')).rows[0].at).getTime();
   const hasDrafts=!!(await c.query("SELECT to_regclass('relay_funding_drafts') AS name")).rows[0].name;
   const base=`WITH saved AS (SELECT o.*, ${hasDrafts?'d.stopped_at':'NULL::timestamptz'} AS stopped_at FROM relay_live_orders o ${hasDrafts?'LEFT JOIN relay_funding_drafts d ON d.id=o.id AND d.owner=o.owner AND d.merchant_id=o.merchant_id AND d.provider_id=o.provider_id':''} WHERE o.merchant_id=$1), flags AS (SELECT *,
    (review_required OR status='checkout_review' OR coalesce(result->>'chargebackStatus','NONE') NOT IN ('NONE','') OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(result->'verification'->'payments')='array' THEN result->'verification'->'payments' ELSE '[]'::jsonb END) p WHERE coalesce(p->>'chargebackStatus','NONE') NOT IN ('NONE',''))) AS review,
    (attempts>0 OR coalesce(result->>'trackingError','')<>'') AS retry,
    (status NOT IN ('checkout_received','checkout_cancelled') AND next_check_at<now()-interval '5 minutes') AS overdue,
    (status='checkout_partial') AS partial,
    (stopped_at IS NOT NULL AND coalesce(result->'verification'->>'expectedNetRaw','') ~ '^[0-9]*[1-9][0-9]*$') AS stopped_funds
    FROM saved), records AS (SELECT *, (review OR retry OR overdue OR partial OR stopped_funds) AS attention FROM flags)`;
   const counts=(await c.query(base+` SELECT count(*) AS all, ${healthFilters.filter(x=>x!=='all').map(x=>`count(*) FILTER(WHERE ${x}) AS ${x}`).join(',')} FROM records`,[merchantId])).rows[0];
   const where=filter==='all'?'true':filter;
   const rows=(await c.query(base+` SELECT * FROM records WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $2`,[merchantId,(page-1)*25])).rows;
   const worker=(await c.query('SELECT max(beat_at) AS last FROM relay_live_workers WHERE merchant_id=$1',[merchantId])).rows[0];
   const inbox=(await c.query('SELECT count(*) AS total,count(*) FILTER(WHERE processed_at IS NULL) AS pending,count(*) FILTER(WHERE unmatched) AS unmatched,min(received_at) FILTER(WHERE processed_at IS NULL) AS oldest,max(received_at) AS last FROM relay_live_webhooks WHERE merchant_id=$1',[merchantId])).rows[0];
   const project=row=>{
    const r=paymentRecord({...row.request,...row.result,id:row.id,createdAt:row.created_at,status:row.status,reviewRequired:row.review_required,source:simulated?'fixture':'live',fixture:simulated,stoppedInRelay:!!row.stopped_at},null,now);
    return {record:r,flags:healthFilters.filter(x=>!['all','attention'].includes(x)&&row[x]),updatedAt:date(row.updated_at),nextCheckAt:date(row.next_check_at),lastAttemptAt:date(row.result.trackingAttemptedAt),failedChecks:row.attempts,stoppedAt:date(row.stopped_at)};
   };
   let detail=null;
   if(id){
    const row=(await c.query(base+' SELECT * FROM records WHERE id=$2',[merchantId,id])).rows[0];
    if(!row)throw new InputError('Payment record not found.',404);
    const audit=(await c.query('SELECT a.at,a.event,a.data FROM relay_live_audit a JOIN relay_live_orders o ON o.id=a.order_id WHERE o.merchant_id=$1 AND o.id=$2 ORDER BY a.at DESC,a.id DESC LIMIT 101',[merchantId,id])).rows;
    const ledger=(await c.query('SELECT merchant_id,payment_id,order_id,chain_id,token_address,recipient,amount_raw,intent_hash,transaction_hash,receipt,finalized FROM relay_live_payments WHERE merchant_id=$1 AND order_id=$2',[merchantId,id])).rows;
    const draft=hasDrafts?(await c.query('SELECT id,owner,merchant_id,provider_id,agent_id,agent,pence,rail,requested_usdc,status FROM relay_funding_drafts WHERE id=$1 AND owner=$2',[id,row.owner])).rows[0]:null;
    detail={...project(row),reconciliation:reconcileSavedPayment(row,ledger,draft,now),timeline:audit.slice(0,100).map(a=>({at:date(a.at),label:a.event==='verified'&&stages[a.data?.to]?'Verification saved: '+stages[a.data.to]:events[a.event]??'Saved tracking event'})),timelineTruncated:audit.length>100};
   }
   await c.query('COMMIT');
   const heartbeatAt=date(worker.last),age=heartbeatAt?(now-Date.parse(heartbeatAt))/1000:null;
   return {available:true,savedOnly:true,simulated,generatedAt:new Date(now).toISOString(),filter,page,pageSize:25,counts:Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,Number(v)])),worker:{heartbeatAt,status:age===null?'unknown':age>=0&&age<90?'recent':'stale'},notifications:{total:Number(inbox.total),pending:Number(inbox.pending),unmatched:Number(inbox.unmatched),oldestPendingAt:date(inbox.oldest),lastReceivedAt:date(inbox.last)},records:rows.map(project),detail};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 };
}
