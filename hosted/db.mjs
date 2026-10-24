import {createFundingHistoryReader} from './funding-history.mjs';
import pg from 'pg';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {InputError} from '../server/validation.mjs';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const terminal=s=>['sandbox_complete','checkout_cancelled'].includes(s);
const ranks={checkout_unknown:0,checkout_recovery:1,checkout_ready:1,checkout_partial:2,sandbox_complete:3,checkout_cancelled:3};
export const orderView=r=>({...r.request,...r.result,status:r.status,id:r.id,requestId:r.request_id});
export function createPool(connectionString=process.env.DATABASE_URL,{schema}={}){
 if(schema&&!/^[a-z_][a-z0-9_]*$/.test(schema))throw Error('Invalid database schema.');
 if(!connectionString)throw Error('DATABASE_URL is required.');
 const pool=new pg.Pool({connectionString,max:3,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:10000,application_name:'relay-sandbox',...schema?{options:`-c search_path=${schema}`}:{ }});
 pool.on('error',()=>console.error('Database connection interrupted.'));
 return pool;
}
export function createStore(pool){
 const query=(sql,args=[])=>pool.query(sql,args);
 async function tx(fn){const c=await pool.connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 const owned=async(c,owner,id)=>{const r=await c.query('SELECT * FROM relay_orders WHERE id=$1 AND owner=$2',[id,owner]);if(!r.rows[0])throw new InputError('Order not found.',404);return r.rows[0];};
 return {
  query,tx,fundingHistory:createFundingHistoryReader(pool),
  async migrate(){const c=await pool.connect();try{await c.query('SELECT pg_advisory_lock(431924)');await c.query('BEGIN');await c.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));await c.query(readFileSync(new URL('./customer-notifications.sql',import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.query('SELECT pg_advisory_unlock(431924)').catch(()=>{});c.release();}},
  async rate(key,limit,seconds){const r=await query(`INSERT INTO relay_rate_limits(key,count,reset_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN relay_rate_limits.reset_at<=now() THEN 1 ELSE relay_rate_limits.count+1 END, reset_at=CASE WHEN relay_rate_limits.reset_at<=now() THEN now()+$2*interval '1 second' ELSE relay_rate_limits.reset_at END RETURNING count`,[key,seconds]);if(r.rows[0].count>limit)throw new InputError('Too many requests. Please try again later.',429);},
  async session(token,principals){if(!token||!/^[a-f0-9]{64}$/.test(token))return null;const r=await query(`UPDATE relay_sessions SET last_seen_at=now() WHERE token_hash=$1 AND NOT revoked AND expires_at>now() AND last_seen_at>now()-interval '2 hours' RETURNING owner,credential_hash`,[digest(token)]);const s=r.rows[0];return s&&principals.some(p=>p.label===s.owner&&p.sha256hex===s.credential_hash)?s.owner:null;},
  async login(token,principal){await query('INSERT INTO relay_sessions(token_hash,owner,credential_hash) VALUES($1,$2,$3)',[digest(token),principal.label,principal.sha256hex]);},
  async logout(token){await query('UPDATE relay_sessions SET revoked=true WHERE token_hash=$1',[digest(token??'')]);},
  async state(owner){const [a,o,w]=await Promise.all([query('SELECT data FROM relay_agents WHERE owner=$1 ORDER BY created_at',[owner]),query('SELECT * FROM relay_orders WHERE owner=$1 ORDER BY created_at DESC LIMIT 100',[owner]),query("SELECT max(beat_at) AS beat_at,extract(epoch FROM(now()-max(beat_at))) AS age FROM relay_workers")]);return {agents:a.rows.map(r=>r.data),orders:o.rows.map(orderView),lastQuote:null,hostedSandbox:true,worker:{lastSeen:w.rows[0].beat_at,healthy:w.rows[0].age!==null&&Number(w.rows[0].age)<90}};},
  async addAgent(owner,data){return tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner]);const n=await c.query('SELECT count(*) FROM relay_agents WHERE owner=$1',[owner]);if(Number(n.rows[0].count)>=5)throw new InputError('You can save up to five wallets in this sandbox.');try{await c.query('INSERT INTO relay_agents(id,owner,data,address_key) VALUES($1,$2,$3,$4)',[data.id,owner,data,data.address.toLowerCase()]);}catch(e){if(e.code==='23505')throw new InputError('This wallet is already saved.',409);throw e;}});},
  async createOrder(owner,{requestId,agentId,amount}){return tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner]);
   const old=(await c.query('SELECT * FROM relay_orders WHERE owner=$1 AND request_id=$2',[owner,requestId])).rows[0];
   if(old){if(old.request.agent.id!==agentId||old.request.quote.pence!==amount)throw new InputError('This request belongs to a different order.',409);return old;}
   const a=(await c.query('SELECT data FROM relay_agents WHERE owner=$1 AND id=$2',[owner,agentId])).rows[0];if(!a)throw new InputError('Choose a saved Base agent wallet.');
   const count=(await c.query("SELECT count(*) AS total,count(*) FILTER(WHERE status NOT IN('sandbox_complete','checkout_cancelled')) AS pending FROM relay_orders WHERE owner=$1",[owner])).rows[0];
   if(Number(count.total)>=100||Number(count.pending)>0)throw new InputError('Resume your existing checkout before starting another.',409);
   const id=randomUUID(),request={id,requestId,kind:'checkout',source:'sandbox',agent:a.data,quote:{pence:amount,platform:'wise',network:'Base',token:'USDC'},createdAt:new Date().toISOString()};
   return (await c.query('INSERT INTO relay_orders(id,owner,request_id,request) VALUES($1,$2,$3,$4) RETURNING *',[id,owner,requestId,request])).rows[0];
  });},
  async claimCreate(owner,id){await owned(pool,owner,id);return (await query(`UPDATE relay_orders SET generation=generation+1,lease_token=$3,lease_until=now()+interval '60 seconds',claimed_at=clock_timestamp(),creation_attempted_at=now() WHERE id=$1 AND owner=$2 AND provider_id IS NULL AND creation_attempted_at IS NULL RETURNING *`,[id,owner,randomUUID()])).rows[0]??null;},
  async owned(owner,id){return owned(pool,owner,id);},
  async schedule(owner,id){await owned(pool,owner,id);await query('UPDATE relay_orders SET next_check_at=now() WHERE id=$1 AND owner=$2 AND provider_id IS NOT NULL',[id,owner]);},
  async claimNext(worker){return tx(async c=>{
   // Unknown creation is never blindly retried. A signed hint can supply a candidate ID for independent validation.
   const r=await c.query(`SELECT o.*, (SELECT w.provider_id FROM relay_webhooks w WHERE w.relay_order_id=o.id AND w.processed_at IS NULL ORDER BY received_at LIMIT 1) AS recovery_id FROM relay_orders o WHERE (lease_until IS NULL OR lease_until<now()) AND ((provider_id IS NOT NULL AND next_check_at<=now()) OR (provider_id IS NULL AND creation_attempted_at IS NOT NULL AND EXISTS(SELECT 1 FROM relay_webhooks w WHERE w.relay_order_id=o.id AND w.processed_at IS NULL) AND (next_check_at IS NULL OR next_check_at<=now()))) ORDER BY next_check_at NULLS FIRST,created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1`);
   if(!r.rows[0])return null;const token=randomUUID();const claimed=(await c.query(`UPDATE relay_orders SET generation=generation+1,lease_token=$2,lease_until=now()+interval '60 seconds',claimed_at=clock_timestamp() WHERE id=$1 RETURNING *`,[r.rows[0].id,token])).rows[0];return {...claimed,recovery_id:r.rows[0].recovery_id,worker};
  });},
  async apply(claim,update,{creation=false}={}){return tx(async c=>{
   const current=(await c.query('SELECT * FROM relay_orders WHERE id=$1 FOR UPDATE',[claim.id])).rows[0];
   if(!current||String(current.generation)!==String(claim.generation)||current.lease_token!==claim.lease_token)return false;
   const allowed=new Set(['providerOrderId','merchantId','checkoutUrl','status','providerStatus','requestedUsdcAmount','checkedAt','verification','delivery']);
   const clean=Object.fromEntries(Object.entries(update).filter(([k])=>allowed.has(k)));
   if(!Object.hasOwn(ranks,clean.status)||clean.delivery||clean.verification?.environment==='LIVE')throw new InputError('A live or unknown state cannot be applied to this sandbox.',409);
   if(current.provider_id&&clean.providerOrderId&&current.provider_id!==clean.providerOrderId)throw new InputError('Provider order changed. Operator review required.',409);
   if((ranks[clean.status]??-1)<ranks[current.status]||(terminal(current.status)&&clean.status!==current.status))throw new InputError('Peer status conflicts with the last verified result.',409);
   const events=current.result.events??[];if(clean.status!==current.status)events.push({status:clean.status,at:new Date().toISOString()});
   const result={...current.result,...clean,events,trackingError:null};const provider=clean.providerOrderId??current.provider_id;
   if(!creation)await c.query('UPDATE relay_webhooks SET processed_at=now() WHERE provider_id=$1 AND received_at<=$2 AND processed_at IS NULL',[provider,claim.claimed_at]);
   const pending=provider?(await c.query('SELECT 1 FROM relay_webhooks WHERE provider_id=$1 AND processed_at IS NULL LIMIT 1',[provider])).rows.length>0:false;
   await c.query(`UPDATE relay_orders SET result=$2,provider_id=$3,status=$4,generation=generation+1,lease_token=NULL,lease_until=NULL,attempts=0,next_check_at=CASE WHEN $5 THEN now() WHEN $6 THEN NULL ELSE now()+interval '30 seconds' END,updated_at=now() WHERE id=$1`,[claim.id,result,provider,clean.status,pending,terminal(clean.status)]);return true;
  });},
  async fail(claim,message='Verification is temporarily unavailable. The last verified result is retained.'){
   await query(`UPDATE relay_orders SET result=result||jsonb_build_object('trackingError',$4::text,'trackingAttemptedAt',now()),generation=generation+1,lease_token=NULL,lease_until=NULL,attempts=attempts+1,next_check_at=now()+least(600,30*power(2,least(attempts,4)))*interval '1 second',updated_at=now() WHERE id=$1 AND generation=$2 AND lease_token=$3`,[claim.id,claim.generation,claim.lease_token,message]);
  },
  async accept(event){return tx(async c=>{
   const r=await c.query(`INSERT INTO relay_webhooks(event_id,digest,delivery_id,provider_id,relay_order_id,event_type,processed_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() ELSE NULL END) ON CONFLICT DO NOTHING RETURNING event_id`,[event.eventId,event.digest,event.deliveryId,event.orderId,event.relayOrderId??null,event.type,event.test]);
   if(!r.rows.length){const old=(await c.query('SELECT digest FROM relay_webhooks WHERE event_id=$1 OR digest=$2',[event.eventId,event.digest])).rows;if(old.some(x=>x.digest!==event.digest))throw new InputError('Webhook replay differs from its original body.',409);return {duplicate:true};}
   if(!event.test)await c.query('UPDATE relay_orders SET next_check_at=now() WHERE provider_id=$1 OR id=$2',[event.orderId,event.relayOrderId??null]);
   return {duplicate:false};
  });},
  async heartbeat(id){await query(`INSERT INTO relay_workers(id,version) VALUES($1,'sandbox-v1') ON CONFLICT(id) DO UPDATE SET beat_at=now()`,[id]);},
  async maintenance(){await query("DELETE FROM relay_account_mail WHERE created_at<now()-interval '7 days'");await query("DELETE FROM relay_rate_limits WHERE reset_at<now()-interval '1 hour'");await query("DELETE FROM relay_sessions WHERE expires_at<now()-interval '7 days'");await query("DELETE FROM relay_customer_sessions WHERE expires_at<now()-interval '7 days'");await query("DELETE FROM relay_workers WHERE beat_at<now()-interval '7 days'");},
  async close(){await pool.end();}
 };
}
