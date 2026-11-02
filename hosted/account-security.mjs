import {emailVerificationState} from './email-verification.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {digest} from './db.mjs';
import {verifyPassword} from './accounts.mjs';
import {InputError,walletAddress} from '../server/validation.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const audit=(c,id,event,details={})=>c.query('INSERT INTO relay_security_events(customer_id,event,details) VALUES($1,$2,$3)',[id,event,details]);
const fields=(input,names)=>{if(!input||Object.keys(input).some(k=>!names.includes(k)))throw new InputError('Unsupported security details.');};
export function createAccountSecurity(store,accounts,{mailEnabled=false,mailPreview=false}={}){
 async function identity(token){const s=await accounts.session(token);if(!s)throw new InputError('Sign in again to manage account security.',401);return s;}
 async function locked(token,proof,fn){
  return store.tx(async c=>{
   // Match password/reset lock order: customer first, session second. Recheck after hashing.
   const row=(await c.query('SELECT * FROM relay_customers WHERE id=$1 FOR UPDATE',[proof.id])).rows[0];
   const session=(await c.query(`SELECT session_id FROM relay_customer_sessions WHERE token_hash=$1 AND customer_id=$2 AND version=$3 AND NOT revoked AND expires_at>now() AND last_seen_at>now()-interval '2 hours' FOR UPDATE`,[digest(token),proof.id,row?.version??0])).rows[0];
   if(!row||row.disabled||!session||row.password_hash!==proof.password_hash||row.version!==proof.version)throw new InputError('Your session changed. Sign in again before continuing.',401);
   return fn(c,row,session);
  });
 }
 async function protectedChange(token,password,fn){
  const s=await identity(token);await store.rate('security:global',60,900);await store.rate('security:'+s.account.id,10,900);
  const row=(await store.query('SELECT * FROM relay_customers WHERE id=$1',[s.account.id])).rows[0];
  if(!await verifyPassword(password,row.password_hash))throw new InputError('Current password not recognised.',403);
  return locked(token,row,fn);
 }
 return {
  protectedChange,
  async security(_input,token){
   const s=await identity(token),id=s.account.id;await store.rate('security:read:'+id,60,60);
   const row=(await store.query('SELECT recovery_saved_at,recovery_rotated_at,email_verified_at,version FROM relay_customers WHERE id=$1',[id])).rows[0];
   const mailJob=(await store.query("SELECT state,created_at,attempted_at,expires_at,consumed_at FROM relay_account_mail WHERE customer_id=$1 AND version=$2 AND purpose='verify' ORDER BY created_at DESC,id DESC LIMIT 1",[id,row.version])).rows[0];
   const emailVerification=emailVerificationState({verifiedAt:row.email_verified_at,mailEnabled,mailPreview,job:mailJob});
   const sessions=(await store.query(`SELECT session_id,client_label,created_at,last_seen_at,expires_at,token_hash=$2 AS current FROM relay_customer_sessions WHERE customer_id=$1 AND version=(SELECT version FROM relay_customers WHERE id=$1) AND NOT revoked AND expires_at>now() AND last_seen_at>now()-interval '2 hours' ORDER BY created_at DESC`,[id,digest(token)])).rows;
   const events=(await store.query('SELECT event,created_at FROM relay_security_events WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 20',[id])).rows;
   return {emailVerification,recoveryConfirmedAt:row.recovery_saved_at,recoveryRotatedAt:row.recovery_rotated_at,emailRecoveryAvailable:mailEnabled&&!mailPreview&&emailVerification.verified,emailRecoveryPreview:mailPreview,sessions:sessions.map(r=>({id:r.session_id,label:r.client_label,current:r.current,createdAt:r.created_at,lastSeenAt:r.last_seen_at,expiresAt:r.expires_at})),events:events.map(r=>({event:r.event,at:r.created_at}))};
  },
  async revokeSession(input,token){
   fields(input,['id','allOthers','currentPassword']);if(input.allOthers!==true&&!uuid(input.id))throw new InputError('Choose a session.');
   return protectedChange(token,input.currentPassword,async(c,row,current)=>{
    if(input.id===current.session_id)throw new InputError('Use Sign out to end this session.');
    const r=await c.query(`UPDATE relay_customer_sessions SET revoked=true WHERE customer_id=$1 AND session_id<>$2 AND NOT revoked AND ($3::boolean OR session_id=$4::uuid) RETURNING session_id`,[row.id,current.session_id,input.allOthers===true,input.allOthers===true?null:input.id]);
    if(!input.allOthers&&!r.rows.length)throw new InputError('Session unavailable or already signed out.',404);
    await audit(c,row.id,input.allOthers?'other_sessions_revoked':'session_revoked',{count:r.rows.length});return {message:'Selected sessions signed out. This session stays open.'};
   });
  },
  async rotateRecovery(input,token){
   fields(input,['currentPassword']);return protectedChange(token,input.currentPassword,async(c,row)=>{
    const code=randomBytes(32).toString('hex');await c.query('UPDATE relay_customers SET recovery_hash=$2,recovery_saved_at=NULL,recovery_rotated_at=now() WHERE id=$1',[row.id,digest(code)]);
    await audit(c,row.id,'recovery_rotated');return {recoveryCode:code};
   });
  },
  async confirmRecovery(input,token){
   fields(input,['recoveryCode']);const s=await identity(token);await store.rate('security:confirm:'+s.account.id,10,900);
   if(typeof input.recoveryCode!=='string'||!/^[a-f0-9]{64}$/i.test(input.recoveryCode))throw new InputError('Enter your current recovery code.',403);
   const row=(await store.query('SELECT * FROM relay_customers WHERE id=$1',[s.account.id])).rows[0];
   return locked(token,row,async(c,r)=>{
    if(r.recovery_hash!==digest(input.recoveryCode.toLowerCase()))throw new InputError('Recovery code not recognised. Use the latest saved code.',403);
    await c.query('UPDATE relay_customers SET recovery_saved_at=now() WHERE id=$1',[r.id]);await audit(c,r.id,'recovery_confirmed');return {message:'Your current recovery code is confirmed. Keep it somewhere safe.'};
   });
  },
  async saveWallet(input,token,{update=false}={}){
   fields(input,update?['id','name','address','expectedAddress','expectedName','own','network','currentPassword']:['name','address','own','network','currentPassword','owner']);
   const name=typeof input.name==='string'?input.name.trim():'';
   if(name.length<2||name.length>60||input.own!==true||input.network!=='base'||(update&&!uuid(input.id)))throw new InputError('Check the name and confirm your own Base USDC wallet.');
   const receiving=walletAddress(input.address);
   return protectedChange(token,input.currentPassword,async(c,row)=>{
    const owner='customer:'+row.id;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner]);
    let before=null;const id=update?input.id:randomUUID();
    if(update){
     before=(await c.query('SELECT data FROM relay_agents WHERE id=$1 AND owner=$2 FOR UPDATE',[id,owner])).rows[0]?.data;
     if(!before)throw new InputError('Wallet not found.',404);
     if(typeof input.expectedAddress!=='string'||before.address.toLowerCase()!==input.expectedAddress.toLowerCase()||before.name!==input.expectedName)throw new InputError('This wallet changed. Close this form and review its latest details.',409);
    }else if(Number((await c.query('SELECT count(*) FROM relay_agents WHERE owner=$1',[owner])).rows[0].count)>=5)throw new InputError('You can save up to five wallets in this sandbox.');
    const after={id,name,address:receiving,network:'Base',token:'USDC',ownership:'self_declared_unverified'};
    try{
     if(update)await c.query('UPDATE relay_agents SET data=$3,address_key=$4 WHERE id=$1 AND owner=$2',[id,owner,after,receiving.toLowerCase()]);
     else await c.query('INSERT INTO relay_agents(id,owner,data,address_key) VALUES($1,$2,$3,$4)',[id,owner,after,receiving.toLowerCase()]);
    }catch(e){if(e.code==='23505')throw new InputError('This wallet is already saved.',409);throw e;}
    // Existing drafts/orders retain their immutable destination snapshots; no provider call.
    await audit(c,row.id,update?'wallet_updated':'wallet_added',{id,before,after});return {id};
   });
  }
 };
}
