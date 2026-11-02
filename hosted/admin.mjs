import {InputError} from '../server/validation.mjs';
export const isAccountAdmin=(account,emails=[])=>!!account?.emailVerified&&emails.includes(account.email);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export function createAdmin(store,{emails=[],security}){
 return {
  async overview(){
   const counts=(await store.query(`SELECT count(*)::int AS total, count(*) FILTER(WHERE email_verified_at IS NOT NULL)::int AS verified, count(*) FILTER(WHERE disabled)::int AS disabled, count(*) FILTER(WHERE setup_pending)::int AS pending FROM relay_customers`)).rows[0];
   const invitations=(await store.query(`SELECT count(*)::int AS total, count(*) FILTER(WHERE claimed_at IS NOT NULL AND revoked_at IS NULL)::int AS joined, count(*) FILTER(WHERE claimed_at IS NULL AND revoked_at IS NULL AND expires_at>now())::int AS waiting FROM relay_test_invites`)).rows[0];
   const mail=(await store.query(`SELECT count(*) FILTER(WHERE state='queued')::int AS queued,count(*) FILTER(WHERE state='unknown' AND created_at>now()-interval '24 hours')::int AS uncertain FROM relay_account_mail`)).rows[0];
   return {generatedAt:new Date().toISOString(),accounts:counts,invitations,mail};
  },
  async customers(params){
   const q=(params.get('q')??'').trim(),page=Number(params.get('page')??1);
   if(q.length>254||!Number.isInteger(page)||page<1||page>10000)throw new InputError('Invalid account search.');
   // Substring search treats punctuation literally, with no SQL wildcard expansion.
   const where="($1='' OR strpos(lower(email),lower($1))>0 OR strpos(lower(name),lower($1))>0)";
   const total=Number((await store.query(`SELECT count(*) FROM relay_customers WHERE ${where}`,[q])).rows[0].count);
   const rows=(await store.query(`SELECT id,name,email,email_verified_at,disabled,setup_pending,created_at FROM relay_customers WHERE ${where} ORDER BY created_at DESC,id LIMIT 25 OFFSET $2`,[q,(page-1)*25])).rows;
   return {page,pageSize:25,total,accounts:rows.map(r=>({id:r.id,name:r.name,email:r.email,verified:!!r.email_verified_at,disabled:r.disabled,pending:r.setup_pending,createdAt:r.created_at,admin:emails.includes(r.email)}))};
  },
  async change(token,b){
   if(Object.keys(b).some(k=>!['id','action','currentPassword','confirm'].includes(k))||!uuid(b.id)||!['disable','enable','signout'].includes(b.action)||b.confirm!==true)throw new InputError('Choose an account action and confirm it.');
   return security.protectedChange(token,b.currentPassword,async(c,actor)=>{
    if(!actor.email_verified_at||!emails.includes(actor.email))throw new InputError('Admin access required.',403);
    // Administrators cannot change their own or another administrator's access here.
    const target=(await c.query('SELECT id,email,disabled FROM relay_customers WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
    if(!target)throw new InputError('Account not found.',404);
    if(target.id===actor.id||emails.includes(target.email))throw new InputError('Administrator access is managed outside this dashboard.',403);
    if(b.action==='disable'||b.action==='enable')await c.query('UPDATE relay_customers SET disabled=$2,version=version+1 WHERE id=$1',[target.id,b.action==='disable']);
    if(b.action!=='enable')await c.query('UPDATE relay_customer_sessions SET revoked=true WHERE customer_id=$1',[target.id]);
    await c.query('INSERT INTO relay_admin_audit(actor,event,target) VALUES($1,$2,$3)',[actor.email,'account_'+b.action,target.email]);
    return {ok:true};
   });
  },
  async audit(){return {events:(await store.query(`SELECT event,actor,target,at FROM relay_admin_audit UNION ALL SELECT 'invitation_'||a.event,COALESCE(c.email,a.actor),COALESCE(i.label,'Invitation'),a.at FROM relay_test_access_audit a LEFT JOIN relay_customers c ON 'customer:'||c.id::text=a.actor LEFT JOIN relay_test_invites i ON i.id=a.invite_id ORDER BY at DESC LIMIT 100`)).rows};}
 };
}
