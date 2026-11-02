import {readAgentRequestProgress} from './agent-request-progress.mjs';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {digest} from './db.mjs';
import {InputError} from '../server/validation.mjs';
import {targetRaw,targetUnits} from '../shared/funding-request.mjs';
import {walletAddressCheck} from '../shared/wallet-address.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const fields=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new InputError('Unsupported connection details.');};
const lock=(c,owner)=>c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['funding:'+owner]);
const query=`SELECT k.*,a.data AS current_agent,a.funding_revision AS current_revision,u.version AS current_version,u.disabled FROM relay_agent_connections k LEFT JOIN relay_agents a ON a.id=k.agent_id AND a.owner=k.owner LEFT JOIN relay_customers u ON k.owner='customer:'||u.id::text`;
const valid=(r,now)=>!!r&&!r.disabled&&r.current_version===r.customer_version&&!r.revoked_at&&new Date(r.expires_at).getTime()>now&&!!r.current_agent&&String(r.current_revision)===String(r.agent_revision)&&r.current_agent.address.toLowerCase()===r.agent.address.toLowerCase()&&r.current_agent.network==='Base'&&r.current_agent.token==='USDC';
const view=(r,now)=>({id:r.id,name:r.name,agent:r.agent,maxTargetRaw:String(r.max_target_raw),dailyLimit:r.daily_limit,createdAt:r.created_at,expiresAt:r.expires_at,revokedAt:r.revoked_at,active:valid(r,now)});
export async function validateRequestConnection(c,owner,id,now){const r=(await c.query(query+' WHERE k.owner=$1 AND k.id=$2',[owner,id])).rows[0];if(!valid(r,now))throw new InputError('This agent connection is no longer active. Review a new request before preparing payment.',409);return r;}
export function createAgentConnections(base,security,{clock=Date.now,merchantId=null}={}){
 async function authenticate(c,token){
  const parts=typeof token==='string'?/^eupova_agent_([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token):null;
  if(!parts||!uuid(parts[1]))throw new InputError('Agent connection unavailable.',401);
  const r=(await c.query(query+' WHERE k.id=$1',[parts[1]])).rows[0];
  if(!r||!timingSafeEqual(Buffer.from(digest(token),'hex'),Buffer.from(r.secret_hash,'hex'))||!valid(r,clock()))throw new InputError('Agent connection unavailable.',401);
  return r;
 }
 const machineView=r=>({id:r.id,purpose:r.purpose,targetUsdc:targetUnits(String(r.target_raw)),asset:'USDC',network:'Base',createdAt:r.created_at,expiresAt:r.expires_at,status:r.cancelled_at?'dismissed':r.draft_id?'funding_prepared':new Date(r.expires_at).getTime()<=clock()?'expired':'awaiting_review'});
 return {
  async list(owner){return (await base.query(query+' WHERE k.owner=$1 ORDER BY k.created_at DESC',[owner])).rows.map(r=>view(r,clock()));},
  async create(input,token){
   fields(input,['agentId','name','maxTargetUsdc','dailyLimit','expiresInDays','confirm','currentPassword']);
   const name=typeof input.name==='string'?input.name.trim():'',max=targetRaw(input.maxTargetUsdc);
   if(!uuid(input.agentId)||name.length<2||name.length>60||/[\x00-\x1f\x7f]/.test(name)||!max||![1,7,30].includes(input.expiresInDays)||!Number.isInteger(input.dailyLimit)||input.dailyLimit<1||input.dailyLimit>10||input.confirm!==true)throw new InputError('Choose a wallet, name, request limits and expiry, then confirm this access.');
   return security.protectedChange(token,input.currentPassword,async(c,user)=>{
    const owner='customer:'+user.id;await lock(c,owner);
    if(Number((await c.query('SELECT count(*) FROM relay_agent_connections WHERE owner=$1',[owner])).rows[0].count)>=20)throw new InputError('Connection limit reached. Contact Eupova before creating more.',409);
    const a=(await c.query('SELECT data,funding_revision FROM relay_agents WHERE owner=$1 AND id=$2 FOR SHARE',[owner,input.agentId])).rows[0];
    if(!a||a.data.network!=='Base'||a.data.token!=='USDC'||!walletAddressCheck(a.data.address).valid)throw new InputError('Choose a saved USDC receiving wallet on Base.');
    const id=randomUUID(),key='eupova_agent_'+id+'.'+randomBytes(32).toString('base64url'),now=clock();
    await c.query('INSERT INTO relay_agent_connections(id,owner,customer_version,agent_id,agent_revision,agent,name,secret_hash,max_target_raw,daily_limit,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,owner,user.version,input.agentId,a.funding_revision,a.data,name,digest(key),max,input.dailyLimit,new Date(now),new Date(now+input.expiresInDays*86400000)]);
    await c.query("INSERT INTO relay_security_events(customer_id,event,details) VALUES($1,'agent_connection_created',$2)",[user.id,{id,agentId:input.agentId}]);
    return {id,key};
   });
  },
  async revoke(input,token){fields(input,['id','currentPassword']);if(!uuid(input.id))throw new InputError('Choose a connection.');return security.protectedChange(token,input.currentPassword,async(c,user)=>{const owner='customer:'+user.id;await lock(c,owner);const r=await c.query('UPDATE relay_agent_connections SET revoked_at=COALESCE(revoked_at,$3) WHERE owner=$1 AND id=$2 RETURNING id',[owner,input.id,new Date(clock())]);if(!r.rows.length)throw new InputError('Connection unavailable.',404);await c.query("INSERT INTO relay_security_events(customer_id,event,details) VALUES($1,'agent_connection_revoked',$2)",[user.id,{id:input.id}]);return {id:input.id};});},
  async submit(token,key,input){
   fields(input,['purpose','targetUsdc','expiresInHours']);const purpose=typeof input.purpose==='string'?input.purpose.trim():'',target=targetRaw(input.targetUsdc);
   if(!uuid(key)||!target||purpose.length<3||purpose.length>240||/[\x00-\x1f\x7f]/.test(purpose)||![1,24,168].includes(input.expiresInHours))throw new InputError('Use a unique UUID Idempotency-Key, purpose, USDC target and review period of 1, 24 or 168 hours.');
   // Global authentication cap is independent of caller-controlled identity headers.
   await base.rate('agent-api:global',300,60);
   const initial=await authenticate(base,token);await base.rate('agent-api:'+initial.id,30,60);
   return base.tx(async c=>{
    await c.query('SELECT id FROM relay_customers WHERE id=$1 FOR SHARE',[initial.owner.slice(9)]);await lock(c,initial.owner);const k=await authenticate(c,token);
    if(BigInt(target)>BigInt(k.max_target_raw))throw new InputError('The USDC target exceeds this connection’s request limit.',403);
    const old=(await c.query('SELECT * FROM relay_agent_funding_requests WHERE owner=$1 AND request_key=$2',[k.owner,key])).rows[0];
    if(old){if(old.source_connection_id!==k.id||old.purpose!==purpose||String(old.target_raw)!==target||new Date(old.expires_at)-new Date(old.created_at)!==input.expiresInHours*3600000)throw new InputError('Idempotency key already used for different details.',409);return machineView(old);}
    const now=clock();if(Number((await c.query('SELECT count(*) FROM relay_agent_funding_requests WHERE source_connection_id=$1 AND created_at>$2',[k.id,new Date(now-86400000)])).rows[0].count)>=k.daily_limit)throw new InputError('This connection reached its request limit for the last 24 hours.',429);
    if(Number((await c.query('SELECT count(*) FROM relay_agent_funding_requests WHERE owner=$1',[k.owner])).rows[0].count)>=100)throw new InputError('This account’s funding-request limit is reached.',409);
    const r=(await c.query('INSERT INTO relay_agent_funding_requests(id,owner,request_key,agent_id,agent,agent_revision,purpose,target_raw,expires_at,created_at,source_connection_id,source_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[randomUUID(),k.owner,key,k.agent_id,k.agent,k.agent_revision,purpose,target,new Date(now+input.expiresInHours*3600000),new Date(now),k.id,k.name])).rows[0];return machineView(r);
   });
  },
  async status(token,id){await base.rate('agent-api:global',300,60);const k=await authenticate(base,token);await base.rate('agent-api:'+k.id,30,60);if(!uuid(id))throw new InputError('Request unavailable.',404);const r=(await base.query('SELECT * FROM relay_agent_funding_requests WHERE owner=$1 AND source_connection_id=$2 AND id=$3',[k.owner,k.id,id])).rows[0];if(!r)throw new InputError('Request unavailable.',404);return {...machineView(r),progress:await readAgentRequestProgress(base,r,{merchantId,now:clock()})};}
 };
}
