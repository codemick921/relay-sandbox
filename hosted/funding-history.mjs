import {knownCurrency} from '../shared/fiat.mjs';
// Customer-owned saved evidence only. No provider clients or payment mutations.
import {InputError} from '../server/validation.mjs';
import {paymentRecord,units} from './payment-records.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export const historyStatuses=['all','draft','awaiting','uncertain','partial','settled','confirming','stopped','ended','review','received','disputed'];
export function historyOptions(params){
 const allowed=['source','status','q','address','from','to','page','format'];
 if([...params.keys()].some(k=>!allowed.includes(k))||allowed.some(k=>params.getAll(k).length>1))throw new InputError('Invalid history filters.');
 const o={source:params.get('source')??'live',status:params.get('status')??'all',q:(params.get('q')??'').trim(),address:(params.get('address')??'').trim().toLowerCase(),from:params.get('from')??'',to:params.get('to')??'',page:Number(params.get('page')??1)};
 const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&v<='9998-12-31'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
 if(!['live','simulated','all'].includes(o.source)||!historyStatuses.includes(o.status)||o.q.length>128||o.address&&!/^0x[0-9a-f]{40}$/.test(o.address)||o.from&&!validDate(o.from)||o.to&&!validDate(o.to)||o.from&&o.to&&o.from>o.to||!/^\d{1,6}$/.test(params.get('page')??'1')||o.page<1||o.page>100000)throw new InputError('Check the history dates, wallet address and filters.');
 return o;
}
const amount=(v,decimals)=>typeof v==='string'&&new RegExp('^\\d{1,24}\\.\\d{'+decimals+'}$').test(v)?BigInt(v.replace('.','')):null;
export function summarize(records){
 const totals={};
 for(const [key,d] of [['requestedGbp',2],['netUsdc',6],['confirmedUsdc',6],['peerFeeUsdc',6]]){
  let total=0n,known=0;for(const r of records){const n=amount(r[key],d);if(n!==null){total+=n;known++;}}
  totals[key]={amount:known?units(String(total),d):null,known,missing:records.length-known};
 }
 const fiat={};for(const r of records){const m=r.recordedFiat?.match(/^(\d{1,12}(?:\.\d{1,2})?) ([A-Z]{3})$/);if(!m||!knownCurrency(m[2]))continue;const [whole,fraction='']=m[1].split('.'),n=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));const a=fiat[m[2]]??{raw:0n,known:0};a.raw+=n;a.known++;fiat[m[2]]=a;}
 const requestedFiat={};for(const r of records){const currency=r.currency??'GBP',n=amount(r.requestedAmount??r.requestedGbp,2);if(n===null||!knownCurrency(currency))continue;const a=requestedFiat[currency]??{amount:'0.00',known:0};a.amount=units(String(amount(a.amount,2)+n),2);a.known++;requestedFiat[currency]=a;}
 return {...totals,requestedFiat,recordedFiat:Object.fromEntries(Object.entries(fiat).map(([k,v])=>[k,{amount:units(String(v.raw),2),known:v.known}])),fiatMissing:records.filter(r=>!r.recordedFiat).length,disputed:records.filter(r=>r.chargeback).length,deliveryConfirmed:records.filter(r=>r.deliveryConfirmed).length};
}
// Filter SQL is static and parameterised. Batch traversal holds a single snapshot;
// only a page is retained for browsing; exports fail explicitly above 10,000 rows.
export function createFundingHistoryReader(pool){
 return async function read(owner,options={},scopes=[],{id=null,download=false}={}){
  if(!/^customer:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner))throw new InputError('Customer sign-in required.',403);
  if(id&&!uuid(id))throw new InputError('Funding record not found.',404);
  const opts=historyOptions(new URLSearchParams(Object.entries(options).map(([k,v])=>[k,String(v)])));
  if(download&&opts.source==='all')throw new InputError('Choose live records or simulations before downloading.');
  const scopeMap=new Map(scopes.filter(s=>s&&typeof s.merchantId==='string').map(s=>[s.merchantId,!!s.simulated]));
  const c=await pool.connect();
  try{
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const now=new Date((await c.query('SELECT now() AS at')).rows[0].at).getTime();
   const tables=(await c.query("SELECT to_regclass('relay_live_orders') AS live,to_regclass('relay_funding_drafts') AS drafts,to_regclass('relay_ramp_simulations') AS ramp")).rows[0];
   const args=[owner,...id?[id]:[]],idWhere=id?' AND id=$2':'';
   const pieces=[`SELECT id,created_at,'sandbox'::text AS source,request,result,status,NULL::text AS merchant_id,false AS review_required,NULL::jsonb AS draft FROM relay_orders WHERE owner=$1${idWhere}`];
   if(tables.live&&scopeMap.size){args.push([...scopeMap.keys()]);pieces.push(`SELECT id,created_at,'tracked'::text,request,result,status,merchant_id,review_required,NULL::jsonb FROM relay_live_orders WHERE owner=$1${idWhere} AND merchant_id=ANY($${args.length}::text[])`);}
   // Draft projection deliberately excludes checkout links, attempt tokens and private diagnostics.
   if(tables.drafts)pieces.push(`SELECT id,created_at,'draft'::text,NULL::jsonb,NULL::jsonb,status,merchant_id,false,jsonb_build_object('id',id,'agent',agent,'pence',pence,'currency',currency,'status',status,'createdAt',created_at,'stoppedAt',stopped_at) FROM relay_funding_drafts WHERE owner=$1${idWhere}`);
   if(tables.ramp)pieces.push(`SELECT id,created_at,'ramp'::text,jsonb_build_object('agent',agent,'quote',jsonb_build_object('pence',pence)),result,coalesce(result->>'status','waiting'),NULL::text,false,NULL::jsonb FROM relay_ramp_simulations WHERE owner=$1${idWhere}`);
   // Merge drafts by id in SQL so an old draft is never counted separately from its bound order.
   const base=`WITH candidates AS (${pieces.join(' UNION ALL ')}), orders AS (SELECT * FROM candidates WHERE source<>'draft'), merged AS (
    SELECT o.*,d.draft AS linked_draft FROM orders o LEFT JOIN candidates d ON d.id=o.id AND d.source='draft'
    UNION ALL SELECT d.*,NULL::jsonb FROM candidates d WHERE d.source='draft' AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.id=d.id))
    SELECT * FROM merged WHERE true`;
   let where='',idx=args.length;
   if(opts.from){args.push(opts.from);where+=` AND created_at>=($${++idx}::date::timestamp AT TIME ZONE 'Europe/London')`;}
   if(opts.to){args.push(opts.to);where+=` AND created_at<(($${++idx}::date+1)::timestamp AT TIME ZONE 'Europe/London')`;}
   const retained=[],pageSize=25;let total=0,offset=0;
   // Aggregate exact decimal strings without retaining raw evidence or full history.
   let summary=summarize([]);
   const add=r=>{const one=summarize([r]);for(const k of ['requestedGbp','netUsdc','confirmedUsdc','peerFeeUsdc']){const d=k==='requestedGbp'?2:6,a=summary[k],b=one[k];a.known+=b.known;a.missing+=b.missing;if(b.amount!==null)a.amount=units(String((amount(a.amount,d)??0n)+amount(b.amount,d)),d);}
    for(const [currency,b] of Object.entries(one.requestedFiat)){const a=summary.requestedFiat[currency]??{amount:'0.00',known:0};a.amount=units(String(amount(a.amount,2)+amount(b.amount,2)),2);a.known+=b.known;summary.requestedFiat[currency]=a;}
    for(const [currency,b] of Object.entries(one.recordedFiat)){const a=summary.recordedFiat[currency]??{amount:'0.00',known:0};a.amount=units(String(amount(a.amount,2)+amount(b.amount,2)),2);a.known+=b.known;summary.recordedFiat[currency]=a;}summary.fiatMissing+=one.fiatMissing;summary.disputed+=one.disputed;summary.deliveryConfirmed+=one.deliveryConfirmed;};
   for(;;){
    const rows=(await c.query(base+where+` ORDER BY created_at DESC,id DESC,source LIMIT 500 OFFSET $${args.length+1}`,[...args,offset])).rows;
    for(const row of rows){
     const simulated=row.source==='sandbox'||row.source==='ramp'||row.source==='tracked'&&scopeMap.get(row.merchant_id)===true;
     const order=row.source==='draft'?null:{...row.request,...row.result,id:row.id,createdAt:row.created_at,status:row.status,reviewRequired:row.review_required,source:simulated?'simulation':'live',fixture:simulated};
     const r=paymentRecord(order,row.linked_draft??row.draft,now);
     if(row.source==='ramp'){r.provider='Ramp';r.code='awaiting';r.title='Ramp simulation · '+(row.status==='received'?'completed':'in progress');r.next='This is a saved Ramp test. It does not confirm a real payment or wallet arrival.';r.document='summary';r.deliveryConfirmed=false;r.receipts=[];r.netUsdc=null;r.confirmedUsdc=null;r.peerFeeUsdc=null;}
     r.source=row.source==='draft'?'draft':simulated?'simulated':'live';r.agentId=row.request?.agent?.id??row.draft?.agent?.id??null;
     if(!id&&(opts.source!=='all'&&(opts.source==='simulated')!==r.simulated||opts.status!=='all'&&opts.status!==r.code||opts.address&&r.address?.toLowerCase()!==opts.address||opts.q&&![r.agentName,r.id,r.providerOrderId,r.address].some(v=>v?.toLowerCase().includes(opts.q.toLowerCase()))))continue;
     total++;add(r);
     if(download&&total>10000)throw new InputError('This statement exceeds 10,000 records. Choose a shorter date range.',413);
     if(id||download||total>(opts.page-1)*pageSize&&total<=opts.page*pageSize)retained.push(r);
    }
    if(rows.length<500)break;offset+=500;
   }
   if(id&&retained.length!==1)throw new InputError('Funding record not found.',404);
   await c.query('COMMIT');
   return {records:retained,total,page:opts.page,pageSize,pages:Math.ceil(total/pageSize),filters:opts,summary:opts.source==='all'?null:summary,generatedAt:new Date(now).toISOString(),dateBasis:'Request creation date · Europe/London',savedOnly:true};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 };
}
const esc=v=>String(v??'Not available').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const csv=rows=>'\ufeff'+rows.map(row=>row.map(v=>'"'+(/^[\s]*[=+\-@]/.test(String(v??''))?"'":'')+String(v??'Not available').replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
export function renderStatement(data,format){
 const f=data.filters,title=f.source==='simulated'?'SIMULATED funding statement · no real funds':'Funding statement';
 const coverage=v=>`${v.amount??'Not available'} (${v.known} recorded; ${v.missing} unavailable)`;
 const metadata=[['Document',title],['Request dates (Europe/London)',`${f.from||'All dates'} to ${f.to||'latest'}`],['Search',f.q||'None'],['Receiving wallet filter',f.address||'All wallets'],['Status filter',f.status],['Requests',data.total],['Generated at',data.generatedAt],...Object.entries(data.summary.requestedFiat??{GBP:data.summary.requestedGbp}).map(([c,v])=>[`Requested ${c}`,`${v.amount??'Not available'} (${v.known} recorded)`]),...Object.entries(data.summary.recordedFiat).map(([currency,v])=>[`Payments recorded (${currency})`,`${v.amount} (${v.known} recorded)`]),['Payment amount unavailable',data.summary.fiatMissing],['USDC after Peer fees',coverage(data.summary.netUsdc)],['Arrival confirmed USDC',coverage(data.summary.confirmedUsdc)],['Peer fees USDC',coverage(data.summary.peerFeeUsdc)],['Requests with a dispute',data.summary.disputed],['Basis','Requests created in the selected period, with their latest saved details at download. This is not a statement of transfers made during that period.'],['Amounts','Requested amounts are not proof of payment. Currencies are not converted or combined. Bank fees and any markup in the seller’s exchange rate are not included. Missing amounts are not zero. Disputed deliveries remain historical arrivals.'],['Record type',f.source==='simulated'?'Simulation only. No real payment or wallet arrival is confirmed.':'Saved funding records, not a bank receipt, tax invoice or current wallet balance.']];
 const headings=['Request ID','Provider','Provider order ID','Agent','Receiving address','Network','Token','Created at','Status','Requested amount','Requested currency','Payments recorded','USDC after Peer fees','Arrival confirmed USDC','Peer fees USDC','Last successful check','Tracking unavailable','Stopped in Eupova','Dispute','Confirmed transfer references'];
 const rows=data.records.map(r=>[r.id,r.provider,r.providerOrderId,r.agentName,r.address,r.network,r.token,r.createdAt,r.title,r.requestedAmount??r.requestedGbp,r.currency??'GBP',r.recordedFiat,r.netUsdc,r.confirmedUsdc,r.peerFeeUsdc,r.checkedAt,r.trackingUnavailable?'Yes':'No',r.stopped?'Yes':'No',r.chargeback?'Yes':'No',r.receipts.map(t=>t.transactionHash).join(' | ')||null]);
 if(format==='csv')return csv([...metadata,[],headings,...rows]);
 if(format!=='html')throw new InputError('Choose HTML or CSV.');
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Eupova · ${esc(title)}</title><style>body{font:15px/1.5 system-ui;color:#17271f;max-width:1100px;margin:30px auto;padding:0 20px}h1,h2{line-height:1.2}table{border-collapse:collapse;width:100%;margin:24px 0}th,td{border-bottom:1px solid #ddd;padding:9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{width:36%}article{border:1px solid #ccc;border-radius:12px;margin:24px 0;padding:20px;break-inside:avoid}p{overflow-wrap:anywhere}@media print{body{font-size:10pt}article{break-inside:auto}tr{break-inside:avoid}}</style><h1>Eupova · ${esc(title)}</h1><p>Open this file in a browser to print or save as PDF. It contains your wallet addresses and payment details.</p><table>${metadata.slice(1).map(([k,v])=>`<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>${rows.map((row,i)=>`<article><h2>${esc(data.records[i].agentName)}</h2><table>${headings.map((h,n)=>`<tr><th>${esc(h)}</th><td>${esc(row[n])}</td></tr>`).join('')}</table></article>`).join('')}${!rows.length?'<p>No requests match these filters.</p>':''}</html>`;
}
