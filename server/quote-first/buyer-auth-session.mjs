// Read-only authentication: never calls accounts.session(), which updates last_seen_at.
import {createHash} from 'node:crypto';
import {BuyerAuthError} from './buyer-auth-bridge.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function createBuyerSessionReader(store){
 return async token=>{
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
  const tokenHash=hash(token);
  const {rows}=await store.query(`SELECT c.id, s.session_id, s.version,
   LEAST(s.expires_at, s.last_seen_at + interval '2 hours') AS valid_until
   FROM relay_customer_sessions s JOIN relay_customers c ON c.id=s.customer_id
   WHERE s.token_hash=$1 AND s.version=c.version AND NOT s.revoked AND NOT c.disabled
   AND c.email_verified_at IS NOT NULL AND s.expires_at>now()
   AND s.last_seen_at>now()-interval '2 hours'`,[tokenHash]);
  const row=rows[0];if(!row)return null;
  const expiresAt=new Date(row.valid_until).getTime();
  if(!Number.isSafeInteger(expiresAt))return null;
  return {owner:'customer:'+row.id,binding:hash(tokenHash+':'+row.session_id+':'+row.version),expiresAt};
 };
}

// One explicitly approved development identity. No customer migration or registration.
// Persist its opaque subject in deployment secrets; do not regenerate it on restart/rotation.
export function developmentEnrollment(record,clock=Date.now){
 const allowed=['owner','subject','consent','consentRecordedAt','expiresAt'];
 if(!record||Object.keys(record).some(k=>!allowed.includes(k))||
    typeof record.owner!=='string'||!record.owner.startsWith('customer:')||!uuid.test(record.owner.slice(9))||!uuid.test(record.subject??'')||
    record.owner.slice(9).toLowerCase()===record.subject.toLowerCase()||record.consent!==true||
    !Number.isSafeInteger(record.consentRecordedAt)||!Number.isSafeInteger(record.expiresAt)||
    record.consentRecordedAt<=0||record.consentRecordedAt>clock()||
    record.expiresAt<=record.consentRecordedAt||record.expiresAt-record.consentRecordedAt>86400000)
  throw new BuyerAuthError('buyer_auth_configuration');
 const saved=Object.freeze({...record});
 return async owner=>owner===saved.owner&&clock()<saved.expiresAt?
  {owner,subject:saved.subject,consent:true,environment:'development',expiresAt:saved.expiresAt}:null;
}
