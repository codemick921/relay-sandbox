import {randomUUID} from 'node:crypto';
import {InputError} from '../server/validation.mjs';
import {walletAddressCheck} from '../shared/wallet-address.mjs';
import {targetRaw} from '../shared/funding-request.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const customer=owner=>{if(typeof owner!=='string'||!owner.startsWith('customer:')||!uuid(owner.slice(9)))throw new InputError('Customer sign-in required.',403);};
const fields=(v,allowed)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw new InputError('Unsupported request details.');};
const view=r=>({id:r.id,agent:r.agent,walletRevision:String(r.agent_revision),purpose:r.purpose,targetRaw:String(r.target_raw),expiresAt:r.expires_at,createdAt:r.created_at,cancelledAt:r.cancelled_at,draftId:r.draft_id,source:'customer',walletCurrent:r.current_revision===undefined?true:!!r.current_agent&&String(r.current_revision)===String(r.agent_revision)&&r.current_agent.address.toLowerCase()===r.agent.address.toLowerCase()&&r.current_agent.network===r.agent.network&&r.current_agent.token===r.agent.token});
export async function ownedAgentRequest(c,owner,id){customer(owner);if(!uuid(id))throw new InputError('Funding request not found.',404);const r=(await c.query('SELECT * FROM relay_agent_funding_requests WHERE owner=$1 AND id=$2 FOR UPDATE',[owner,id])).rows[0];if(!r)throw new InputError('Funding request not found.',404);return r;}
// Called inside the existing draft transaction and owner lock: no provider operations.
export async function validateAgentRequest(c,owner,id,agent,revision,now){
 const r=await ownedAgentRequest(c,owner,id);
 if(r.draft_id)throw new InputError('This request already has a funding draft. Review the existing request.',409);
 if(r.cancelled_at||new Date(r.expires_at).getTime()<=now)throw new InputError('This funding request has expired or was cancelled.',409);
 if(r.agent_id!==agent.id||r.agent.address.toLowerCase()!==agent.address.toLowerCase()||r.agent.network!==agent.network||r.agent.token!==agent.token||String(r.agent_revision)!==String(revision))throw new InputError('The request destination changed. Save and review a new request.',409);
 return r;
}
export function createAgentFundingRequests(base,{clock=Date.now}={}){
 const lock=(c,owner)=>c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['funding:'+owner]);
 return {
 async list(owner){customer(owner);return (await base.query('SELECT r.*,a.funding_revision AS current_revision,a.data AS current_agent FROM relay_agent_funding_requests r LEFT JOIN relay_agents a ON a.id=r.agent_id AND a.owner=r.owner WHERE r.owner=$1 ORDER BY r.created_at DESC LIMIT 100',[owner])).rows.map(view);},
 async create(owner,input){
  customer(owner);fields(input,['requestKey','agentId','purpose','targetUsdc','expiresInHours','confirmDestination']);
  const target=targetRaw(input.targetUsdc),purpose=typeof input.purpose==='string'?input.purpose.trim():'';
  if(!uuid(input.requestKey)||!uuid(input.agentId)||!target||purpose.length<3||purpose.length>240||/[\x00-\x1f\x7f]/.test(purpose)||![1,24,168].includes(input.expiresInHours)||input.confirmDestination!==true)throw new InputError('Choose a wallet, purpose, USDC target and expiry, then confirm the receiving network.');
  return base.tx(async c=>{await lock(c,owner);
   const old=(await c.query('SELECT * FROM relay_agent_funding_requests WHERE owner=$1 AND request_key=$2',[owner,input.requestKey])).rows[0];
   if(old){if(old.agent_id!==input.agentId||old.purpose!==purpose||String(old.target_raw)!==target||new Date(old.expires_at)-new Date(old.created_at)!==input.expiresInHours*3600000)throw new InputError('This request key was already used for different details.',409);return view(old);}
   const a=(await c.query('SELECT data,funding_revision FROM relay_agents WHERE owner=$1 AND id=$2 FOR SHARE',[owner,input.agentId])).rows[0];
   if(!a||a.data.network!=='Base'||a.data.token!=='USDC'||!walletAddressCheck(a.data.address).valid)throw new InputError('Choose your saved USDC receiving wallet on Base.');
   if(Number((await c.query('SELECT count(*) FROM relay_agent_funding_requests WHERE owner=$1',[owner])).rows[0].count)>=100)throw new InputError('Your request limit has been reached.',409);
   const now=clock(),row=(await c.query('INSERT INTO relay_agent_funding_requests(id,owner,request_key,agent_id,agent,agent_revision,purpose,target_raw,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[randomUUID(),owner,input.requestKey,input.agentId,{id:a.data.id,name:a.data.name,address:a.data.address,network:'Base',token:'USDC'},a.funding_revision,purpose,target,new Date(now+input.expiresInHours*3600000),new Date(now)])).rows[0];
   return view(row);
  });
 },
 async cancel(owner,input){customer(owner);fields(input,['id']);return base.tx(async c=>{await lock(c,owner);const r=await ownedAgentRequest(c,owner,input.id);if(r.draft_id)throw new InputError('Funding has already been prepared. Review its payment status instead.',409);if(!r.cancelled_at)await c.query('UPDATE relay_agent_funding_requests SET cancelled_at=$2 WHERE id=$1',[r.id,new Date(clock())]);return {id:r.id};});}
 };
}
