import {randomBytes,randomUUID} from 'node:crypto';
import {digest} from './db.mjs';
import {InputError} from '../server/validation.mjs';
const customerId=owner=>{if(!/^customer:[a-f0-9-]{36}$/.test(owner??''))throw new InputError('Customer sign-in required.',403);return owner.slice(9);};
const fields=(b,allowed)=>{if(!b||Object.keys(b).some(k=>!allowed.includes(k)))throw new InputError('Invalid test access request.');};
const codeHash=code=>{if(typeof code!=='string'||!/^EUP-[A-F0-9]{32}$/i.test(code.trim()))throw new InputError('This invitation is invalid, used or expired.');return digest(code.trim().toUpperCase());};
const view=r=>r?{mode:r.mode,allowLive:r.allow_live,revoked:!!r.revoked_at,joinedAt:r.joined_at}:null;
export function createTestInvites(store){
 const audit=(c,id,actor,event)=>c.query('INSERT INTO relay_test_access_audit(invite_id,actor,event) VALUES($1,$2,$3)',[id,actor,event]);
 const membership=(c,owner,lock='')=>c.query(`SELECT m.*,i.allow_live,i.revoked_at FROM relay_test_members m JOIN relay_test_invites i ON i.id=m.invite_id WHERE m.customer_id=$1 ${lock}`,[customerId(owner)]).then(r=>r.rows[0]);
 async function claimIn(c,owner,code){
  const hash=codeHash(code),id=customerId(owner);
  await c.query('SELECT id FROM relay_customers WHERE id=$1 AND NOT disabled FOR UPDATE',[id]);
  if((await c.query('SELECT 1 FROM relay_test_members WHERE customer_id=$1',[id])).rows.length)throw new InputError('This account has already joined a testing invitation.',409);
  const r=(await c.query('UPDATE relay_test_invites SET claimed_at=now() WHERE code_hash=$1 AND revoked_at IS NULL AND claimed_at IS NULL AND expires_at>now() RETURNING id',[hash])).rows[0];
  if(!r)throw new InputError('This invitation is invalid, used or expired.');
  await c.query('INSERT INTO relay_test_members(customer_id,invite_id) VALUES($1,$2)',[id,r.id]);await audit(c,r.id,owner,'joined_simulation');
 }
 return {
  claimIn,
  async issue(actor,b){fields(b,['label','allowLive','days','confirmRealAccess']);const label=typeof b.label==='string'?b.label.trim():'';
   if(label.length<2||label.length>60||typeof b.allowLive!=='boolean'||![1,7,30].includes(b.days)||b.allowLive&&b.confirmRealAccess!==true)throw new InputError('Choose a label, expiry and access level. Confirm any real-funding permission.');
   const code='EUP-'+randomBytes(16).toString('hex').toUpperCase(),id=randomUUID();
   return store.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431940)');if(Number((await c.query('SELECT count(*) FROM relay_test_invites')).rows[0].count)>=1000)throw new InputError('Invitation limit reached.',409);
    const r=(await c.query("INSERT INTO relay_test_invites(id,code_hash,label,allow_live,created_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 day') RETURNING expires_at",[id,digest(code),label,b.allowLive,actor,b.days])).rows[0];await audit(c,id,actor,'issued');return {id,code,expiresAt:r.expires_at};});
  },
  async list(){return {invites:(await store.query(`SELECT i.id,i.label,i.allow_live,i.created_at,i.expires_at,i.revoked_at,i.claimed_at,m.mode FROM relay_test_invites i LEFT JOIN relay_test_members m ON m.invite_id=i.id ORDER BY i.created_at DESC,i.id LIMIT 1000`)).rows};},
  async revoke(actor,b){fields(b,['id']);if(!/^[a-f0-9-]{36}$/.test(b.id??''))throw new InputError('Invitation not found.',404);return store.tx(async c=>{const r=(await c.query('SELECT * FROM relay_test_invites WHERE id=$1 FOR UPDATE',[b.id])).rows[0];if(!r)throw new InputError('Invitation not found.',404);if(!r.revoked_at){await c.query('UPDATE relay_test_invites SET revoked_at=now() WHERE id=$1',[b.id]);await audit(c,b.id,actor,'revoked');}return {ok:true};});},
  async claim(owner,b){fields(b,['code']);await store.rate('test-invite-claim:'+owner,5,900);await store.rate('test-invite-claim:global',50,900);return store.tx(c=>claimIn(c,owner,b.code));},
  async status(owner){return owner?.startsWith('customer:')?view(await membership(store,owner)):null;},
  async mode(owner,b){fields(b,['mode','confirmRealMoney']);if(!['simulation','live'].includes(b.mode))throw new InputError('Choose simulation or real funding.');return store.tx(async c=>{
   const r=await membership(c,owner,'FOR UPDATE OF m,i');if(!r||r.revoked_at)throw new InputError('Testing access is unavailable.',403);
   if(b.mode==='live'&&(!r.allow_live||b.confirmRealMoney!==true))throw new InputError('Real funding requires permission and your confirmation.',403);
   await c.query('UPDATE relay_test_members SET mode=$2 WHERE customer_id=$1',[customerId(owner),b.mode]);if(r.mode!==b.mode)await audit(c,r.invite_id,owner,'mode_'+b.mode);return {ok:true};});},
  // Admission is checked before each action, without holding a pool connection
  // across provider IO. An admitted action may finish after a revoke or mode change.
  async withMode(owner,mode,action){if(!owner?.startsWith('customer:'))return action();
   const r=await membership(store,owner);
   if(r&&(r.revoked_at||r.mode!==mode||mode==='live'&&!r.allow_live))throw new InputError(r.revoked_at?'Testing access was revoked. Existing records remain available.':mode==='live'?'Switch to real funding with an eligible invitation before opening a checkout.':'Switch to simulation mode before creating a test payment.',403);
   return action();}
 };
}
