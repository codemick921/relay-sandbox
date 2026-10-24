import {randomUUID} from 'node:crypto';
import {paymentRecord,units} from './payment-records.mjs';
import {InputError} from '../server/validation.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const customer=owner=>{if(typeof owner!=='string'||!owner.startsWith('customer:')||!uuid(owner.slice(9)))throw new InputError('Customer sign-in required.',403);};
const exact=(b,keys)=>{if(!b||Array.isArray(b)||typeof b!=='object'||Object.keys(b).some(k=>!keys.includes(k)))throw new InputError('Check the notification settings.');};
const date=v=>typeof v==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export const londonDay=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export function nextReminder(anchor,frequency,today){
 if(!date(anchor)||!date(today)||!['weekly','monthly'].includes(frequency))throw new InputError('Check the reminder date.');
 if(anchor>today)return anchor;
 if(frequency==='weekly'){const start=Date.parse(anchor),n=Math.floor((Date.parse(today)-start)/604800000)+1;return new Date(start+n*604800000).toISOString().slice(0,10);}
 const [y,m,d]=anchor.split('-').map(Number),[ty,tm]=today.split('-').map(Number);let months=(ty-y)*12+tm-m;
 const at=n=>{const first=new Date(Date.UTC(y,m-1+n,1)),last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();return new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),Math.min(d,last))).toISOString().slice(0,10);};
 if(at(months)<=today)months++;return at(months);
}
const safeName=v=>typeof v==='string'?v.slice(0,60):'Agent wallet';
export function createCustomerNotifications(base,{scopes=[],simulatedBalances=false,clock=Date.now}={}){
 const merchants=scopes.map(s=>s.merchantId),simulation=new Map(scopes.map(s=>[s.merchantId,!!s.simulated]));
 const lock=async(c,owner)=>{customer(owner);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['notices:'+owner]);await c.query('INSERT INTO relay_notice_preferences(owner) VALUES($1) ON CONFLICT DO NOTHING',[owner]);};
 async function emit(c,owner,key,kind,simulated,data,now){await c.query('INSERT INTO relay_customer_notices(id,owner,event_key,kind,simulated,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner,event_key) DO NOTHING',[randomUUID(),owner,key,kind,simulated,data,new Date(now)]);}
 async function transition(c,owner,subject,fingerprint){const old=(await c.query('SELECT * FROM relay_notice_seen WHERE owner=$1 AND subject=$2',[owner,subject])).rows[0];if(old?.fingerprint===fingerprint)return null;const generation=(old?.generation??0)+1;await c.query('INSERT INTO relay_notice_seen(owner,subject,fingerprint,generation) VALUES($1,$2,$3,$4) ON CONFLICT(owner,subject) DO UPDATE SET fingerprint=excluded.fingerprint,generation=excluded.generation',[owner,subject,fingerprint,generation]);return `${subject}:${generation}`;}
 async function sync(owner){return base.tx(async c=>{
  await lock(c,owner);const prefs=(await c.query('SELECT * FROM relay_notice_preferences WHERE owner=$1',[owner])).rows[0],now=clock(),today=londonDay(now);
  if(prefs.last_sync&&now-new Date(prefs.last_sync).getTime()<30000)return;
  const tables=(await c.query("SELECT to_regclass('relay_live_orders') AS live,to_regclass('relay_wallet_balances') AS balances")).rows[0];
  // Saved order snapshots are traversed by immutable ID; no provider refresh or checkout access.
  if(tables.live&&merchants.length){let cursor='00000000-0000-0000-0000-000000000000';for(;;){
   const rows=(await c.query('SELECT id,request,result,status,created_at,review_required,merchant_id FROM relay_live_orders WHERE owner=$1 AND merchant_id=ANY($2::text[]) AND id>$3 ORDER BY id LIMIT 250',[owner,merchants,cursor])).rows;
   for(const row of rows){const scopeSim=simulation.get(row.merchant_id),r=paymentRecord({...row.request,...row.result,id:row.id,createdAt:row.created_at,status:row.status,reviewRequired:row.review_required,fixture:scopeSim,source:scopeSim?'simulation':'live'},null,now),sim=r.simulated;
    const kind=['review','disputed','uncertain','partial'].includes(r.code)||r.trackingUnavailable?'attention':r.deliveryConfirmed?'arrival':null;
    const fingerprint=kind==='arrival'?'arrival:'+r.receipts.map(t=>t.transactionHash).sort().join(','):kind==='attention'?'attention:'+r.code+':'+r.trackingUnavailable:'quiet';
    const key=await transition(c,owner,'order:'+row.id,fingerprint);
    if(key&&kind&&prefs.payments&&(!sim||prefs.simulations))await emit(c,owner,key,kind,sim,{title:kind==='arrival'?(sim?'Simulated funds arrived':'Funds arrived'):r.trackingUnavailable&&!['review','disputed','uncertain','partial'].includes(r.code)?'Tracking check unavailable':r.title,message:kind==='arrival'?`${r.confirmedUsdc} USDC confirmed for ${r.agentName}.`:'Open the saved funding record for its current status and next steps. Do not send another payment to clear this notice.',agentName:r.agentName,requestId:r.id,evidenceAt:r.checkedAt,amountUsdc:r.confirmedUsdc},now);
   }
   if(rows.length<250)break;cursor=rows.at(-1).id;
  }}
  if(tables.balances){const rows=(await c.query('SELECT b.*,a.data FROM relay_wallet_balances b JOIN relay_agents a ON a.id=b.agent_id AND a.address_key=b.address_key WHERE a.owner=$1',[owner])).rows;
   for(const w of rows){const age=now-new Date(w.observed_at).getTime(),fresh=w.observed_at&&!w.failed&&age>=0&&age<=180000&&w.amount_raw!==null;
    // Unknown/stale balances must neither create an alert nor reset a low-balance episode.
    if(!fresh)continue;const low=w.alerts_enabled&&BigInt(w.amount_raw)<BigInt(w.threshold_raw),key=await transition(c,owner,'balance:'+w.agent_id+':'+w.address_key,low?'low:'+w.threshold_raw:'normal');
    if(key&&low&&prefs.balances&&(!simulatedBalances||prefs.simulations))await emit(c,owner,key,'balance',simulatedBalances,{title:'Low wallet balance',message:`${safeName(w.data.name)} was below your alert threshold. Review the latest balance before choosing a top-up.`,agentName:safeName(w.data.name),agentId:w.agent_id,evidenceAt:w.observed_at,amountUsdc:units(w.amount_raw),targetUsdc:units(w.target_raw)},now);
   }
  }
  const due=(await c.query("SELECT r.*,to_char(r.anchor_date,'YYYY-MM-DD') AS anchor,to_char(r.next_due,'YYYY-MM-DD') AS due,a.data FROM relay_funding_reminders r JOIN relay_agents a ON a.id=r.agent_id AND a.owner=r.owner WHERE r.owner=$1 AND r.enabled AND r.next_due<=$2::date FOR UPDATE OF r",[owner,today])).rows;
  for(const r of due){await emit(c,owner,'reminder:'+r.id+':'+r.revision+':'+r.due,'reminder',false,{title:'Funding reminder',message:`Review ${safeName(r.data.name)} and decide whether it needs funding. This reminder has not created a checkout or payment.`,agentName:safeName(r.data.name),agentId:r.agent_id,dueDate:r.due},now);await c.query('UPDATE relay_funding_reminders SET next_due=$2 WHERE id=$1',[r.id,nextReminder(r.anchor,r.frequency,today)]);}
  await c.query('UPDATE relay_notice_preferences SET last_sync=$2 WHERE owner=$1',[owner,new Date(now)]);
 });}
 async function list(owner,params=new URLSearchParams()){
  customer(owner);if([...params.keys()].some(k=>!['page','filter'].includes(k))||['page','filter'].some(k=>params.getAll(k).length>1)||!/^\d{1,6}$/.test(params.get('page')??'1'))throw new InputError('Check the notification filters.');
  const page=Number(params.get('page')??1),filter=params.get('filter')??'all';if(page<1||page>100000||!['all','unread'].includes(filter))throw new InputError('Check the notification filters.');
  const rows=(await base.query(`SELECT id,kind,simulated,data,created_at,read_at FROM relay_customer_notices WHERE owner=$1 ${filter==='unread'?'AND read_at IS NULL':''} ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $2`,[owner,(page-1)*25])).rows;
  const counts=(await base.query('SELECT count(*) AS total,count(*) FILTER(WHERE read_at IS NULL) AS unread FROM relay_customer_notices WHERE owner=$1',[owner])).rows[0];
  const prefs=(await base.query('SELECT payments,balances,simulations,last_sync FROM relay_notice_preferences WHERE owner=$1',[owner])).rows[0]??{payments:true,balances:true,simulations:false,last_sync:null};
  const reminders=(await base.query("SELECT r.id,r.agent_id,r.enabled,r.frequency,to_char(r.anchor_date,'YYYY-MM-DD') AS start_date,to_char(r.next_due,'YYYY-MM-DD') AS next_due,a.data->>'name' AS agent_name FROM relay_funding_reminders r JOIN relay_agents a ON a.id=r.agent_id AND a.owner=r.owner WHERE r.owner=$1 ORDER BY a.created_at",[owner])).rows;
  return {items:rows,preferences:prefs,reminders,unread:Number(counts.unread),total:Number(counts.total),page,pages:Math.ceil(Number(counts[filter==='unread'?'unread':'total'])/25),savedOnly:true};
 }
 async function preferences(owner,b){exact(b,['payments','balances','simulations']);if(['payments','balances','simulations'].some(k=>typeof b[k]!=='boolean'))throw new InputError('Choose notification preferences.');await base.tx(async c=>{await lock(c,owner);await c.query('UPDATE relay_notice_preferences SET payments=$2,balances=$3,simulations=$4,last_sync=NULL WHERE owner=$1',[owner,b.payments,b.balances,b.simulations]);});}
 async function reminder(owner,b){exact(b,['agentId','enabled','frequency','startDate']);customer(owner);if(!uuid(b.agentId)||typeof b.enabled!=='boolean'||!['weekly','monthly'].includes(b.frequency)||!date(b.startDate))throw new InputError('Choose a wallet, frequency and valid reminder date.');const today=londonDay(clock());
  await base.tx(async c=>{await lock(c,owner);if(!(await c.query('SELECT id FROM relay_agents WHERE id=$1 AND owner=$2 FOR UPDATE',[b.agentId,owner])).rows.length)throw new InputError('Wallet not found.',404);
   const old=(await c.query("SELECT *,to_char(anchor_date,'YYYY-MM-DD') AS start FROM relay_funding_reminders WHERE owner=$1 AND agent_id=$2",[owner,b.agentId])).rows[0];
   if(old&&old.enabled===b.enabled&&old.frequency===b.frequency&&old.start===b.startDate)return;
   if(b.enabled&&(b.startDate<today||Date.parse(b.startDate)-Date.parse(today)>366*86400000))throw new InputError('Choose a first reminder date from today to one year ahead.');
   await c.query('INSERT INTO relay_funding_reminders(id,owner,agent_id,enabled,frequency,anchor_date,next_due) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(owner,agent_id) DO UPDATE SET enabled=excluded.enabled,frequency=excluded.frequency,anchor_date=excluded.anchor_date,next_due=excluded.next_due,revision=relay_funding_reminders.revision+1',[randomUUID(),owner,b.agentId,b.enabled,b.frequency,b.startDate]);await c.query('UPDATE relay_notice_preferences SET last_sync=NULL WHERE owner=$1',[owner]);
  });
 }
 async function read(owner,b){exact(b,['id','read','all']);customer(owner);if(b.all===true){if(Object.keys(b).length!==1)throw new InputError('Check the read action.');await base.query('UPDATE relay_customer_notices SET read_at=$2 WHERE owner=$1 AND read_at IS NULL',[owner,new Date(clock())]);return;}
  if(!uuid(b.id)||typeof b.read!=='boolean'||'all'in b)throw new InputError('Choose a notification.');if(!(await base.query('UPDATE relay_customer_notices SET read_at=$3 WHERE owner=$1 AND id=$2 RETURNING id',[owner,b.id,b.read?new Date(clock()):null])).rows.length)throw new InputError('Notification not found.',404);
 }
 return {sync,list,preferences,reminder,read};
}
