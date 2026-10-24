import {randomUUID,randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {digest} from './db.mjs';
import {createAccountMail} from './account-mail.mjs';
import {InputError} from '../server/validation.mjs';

const scrypt=promisify(scryptCallback), options={N:32768,r:8,p:3,maxmem:64*1024*1024};
const dummy=`scrypt-v1$${'00'.repeat(16)}$${'00'.repeat(32)}`;
let hashing=0;
export function emailKey(value){
 if(typeof value!=='string'||value.length>254)throw new InputError('Enter a valid email address.');
 const email=value.trim().toLowerCase();
 if(!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)||email.includes('..'))throw new InputError('Enter a valid email address.');
 return email;
}
function passwordInput(value){
 if(typeof value!=='string'||[...value].length<15||[...value].length>128||Buffer.byteLength(value)>512)throw new InputError('Use a password with 15 to 128 characters.');
 if(/^(.)\1+$/.test(value)||['passwordpassword','123456789012345','qwertyuiopasdfgh'].includes(value.toLowerCase()))throw new InputError('Choose a less predictable password.');
 return value;
}
async function derive(value,salt){
 // Bound memory/CPU on the existing small host; excess requests fail promptly.
 if(hashing>=2)throw new InputError('Sign-in is busy. Please try again shortly.',503);
 hashing++;try{return await scrypt(value,salt,32,options);}finally{hashing--;}
}
async function hashPassword(value){const salt=randomBytes(16).toString('hex');return `scrypt-v1$${salt}$${(await derive(passwordInput(value),salt)).toString('hex')}`;}
export async function verifyPassword(value,encoded){
 if(typeof value!=='string'||Buffer.byteLength(value)>512)return false;
 const parts=String(encoded).split('$');if(parts[0]!=='scrypt-v1'||!/^[a-f0-9]{32}$/.test(parts[1])||!/^[a-f0-9]{64}$/.test(parts[2]))throw Error('Unsupported password encoding.');
 return timingSafeEqual(await derive(value,parts[1]),Buffer.from(parts[2],'hex'));
}
const view=row=>({id:row.id,name:row.name,email:row.email,emailVerified:!!row.email_verified_at});
const owner=id=>'customer:'+id;
const recovery=()=>randomBytes(32).toString('hex');
export function createAccounts(store,{mail=createAccountMail(store)}={}){
 async function limits(email,kind){await store.rate('accounts:global',60,900);await store.rate('accounts:'+kind+':'+digest(email),kind==='signup'?3:10,900);}
 async function issue(row,context){
  const token=randomBytes(32).toString('hex');
  const saved=await store.query(`INSERT INTO relay_customer_sessions(token_hash,customer_id,version,client_label) SELECT $1,id,version,$4 FROM relay_customers WHERE id=$2 AND password_hash=$3 AND NOT disabled RETURNING token_hash`,[digest(token),row.id,row.password_hash,sessionLabel(context?.userAgent)]);
  if(!saved.rows.length)throw new InputError('Please sign in again.',401);
  return {token,account:view(row)};
 }
 async function consume(token,purpose,change){
  const invalid=()=>new InputError('This link is invalid or has expired. Request a new one.',400);
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw invalid();
  return store.tx(async c=>{
   const id=(await c.query('SELECT customer_id FROM relay_account_mail WHERE token_hash=$1 AND purpose=$2',[digest(token),purpose])).rows[0]?.customer_id;
   if(!id)throw invalid();
   const row=(await c.query('SELECT * FROM relay_customers WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!row||row.disabled||(purpose==='reset'&&!row.email_verified_at)||(purpose==='verify'&&row.email_verified_at))throw invalid();
   const used=await c.query(`UPDATE relay_account_mail SET consumed_at=now() WHERE token_hash=$1 AND purpose=$2 AND customer_id=$3 AND version=$4 AND consumed_at IS NULL AND expires_at>now() AND state IN ('sending','accepted','unknown') RETURNING id`,[digest(token),purpose,id,row.version]);
   if(!used.rows.length)throw invalid();
   return change(c,row);
  });
 }
 return {
  async signup(input,_token,context){
   const email=emailKey(input.email);await limits(email,'signup');
   const name=typeof input.name==='string'?input.name.trim():'';
   if(name.length<2||name.length>60||input.acceptSandbox!==true)throw new InputError('Enter your name and confirm that payments are disabled.');
   const password=await hashPassword(input.password),code=recovery(),id=randomUUID();
   try{
    return await store.tx(async c=>{
     const row=(await c.query('INSERT INTO relay_customers(id,email,name,password_hash,recovery_hash) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,email,name,password,digest(code)])).rows[0];
     const token=randomBytes(32).toString('hex');
     await c.query('INSERT INTO relay_customer_sessions(token_hash,customer_id,version,client_label) VALUES($1,$2,1,$3)',[digest(token),id,sessionLabel(context?.userAgent)]);
     await mail.enqueue(c,row,'verify');
     return {token,account:view(row),recoveryCode:code};
    });
   }catch(e){if(e.code==='23505')throw new InputError('Unable to create this account. Try signing in or recovering access.',409);throw e;}
  },
  async login(input,_token,context){
   const email=emailKey(input.email);await limits(email,'login');
   const row=(await store.query('SELECT * FROM relay_customers WHERE email=$1',[email])).rows[0];
   const valid=await verifyPassword(input.password,row?.password_hash??dummy);
   if(!valid||!row||row.disabled)throw new InputError('Email or password not recognised.',401);
   return issue(row,context);
  },
  async recover(input){
   const email=emailKey(input.email);await limits(email,'recover');
   if(typeof input.recoveryCode!=='string'||!/^[a-f0-9]{64}$/i.test(input.recoveryCode))throw new InputError('Email or recovery code not recognised.',401);
   const password=await hashPassword(input.password),code=recovery();
   const result=await store.tx(async c=>{
    const row=(await c.query(`UPDATE relay_customers SET password_hash=$3,recovery_hash=$4,recovery_saved_at=NULL,recovery_rotated_at=now(),version=version+1 WHERE email=$1 AND recovery_hash=$2 AND NOT disabled RETURNING *`,[email,digest(input.recoveryCode.toLowerCase()),password,digest(code)])).rows[0];
    if(!row)throw new InputError('Email or recovery code not recognised.',401);
    await c.query('UPDATE relay_customer_sessions SET revoked=true WHERE customer_id=$1',[row.id]);if(row.email_verified_at)await mail.enqueue(c,row,'changed');return row;
   });
   return {recovered:!!result,recoveryCode:code};
  },
  async password(input,token,context){
   const session=await this.session(token);if(!session)throw new InputError('Sign in to change your password.',401);
   await limits(session.account.email,'password');
   const row=(await store.query('SELECT * FROM relay_customers WHERE id=$1',[session.account.id])).rows[0];
   if(!await verifyPassword(input.currentPassword,row.password_hash))throw new InputError('Current password not recognised.',401);
   const password=await hashPassword(input.password),code=recovery(),nextToken=randomBytes(32).toString('hex');
   return store.tx(async c=>{
    const updated=(await c.query('UPDATE relay_customers SET password_hash=$3,recovery_hash=$4,recovery_saved_at=NULL,recovery_rotated_at=now(),version=version+1 WHERE id=$1 AND password_hash=$2 AND version=$5 AND NOT disabled RETURNING *',[row.id,row.password_hash,password,digest(code),row.version])).rows[0];
    if(!updated)throw new InputError('Please sign in again.',401);
    await c.query('UPDATE relay_customer_sessions SET revoked=true WHERE customer_id=$1',[row.id]);
    await c.query('INSERT INTO relay_customer_sessions(token_hash,customer_id,version,client_label) VALUES($1,$2,$3,$4)',[digest(nextToken),row.id,updated.version,sessionLabel(context?.userAgent)]);
    if(updated.email_verified_at)await mail.enqueue(c,updated,'changed');
    return {token:nextToken,account:view(updated),recoveryCode:code};
   });
  },
  async requestVerification(input,token){
   const session=await this.session(token);if(!session)throw new InputError('Sign in to verify your email.',401);
   if(!mail.enabled)throw new InputError('Email sending is not connected yet. Keep your recovery code safe.',503);
   await store.rate('mail:global',60,3600);await store.rate('mail:verify:'+session.account.id,3,900);
   await store.tx(async c=>{
    const row=(await c.query('SELECT * FROM relay_customers WHERE id=$1 AND NOT disabled FOR UPDATE',[session.account.id])).rows[0];
    if(row&&!row.email_verified_at)await mail.enqueue(c,row,'verify');
   });return {message:mail.preview?'Verification preview requested. Open Account security and select View local test emails. No email will be sent.':'Verification requested. Use the newest email link to confirm your address.'};
  },
  async requestReset(input){
   const email=emailKey(input.email);
   if(!mail.enabled)throw new InputError('Email sending is not connected yet. Use your saved recovery code instead.',503);
   await store.rate('mail:global',60,3600);await store.rate('mail:reset:'+digest(email),3,900);
   await store.tx(async c=>{
    const row=(await c.query('SELECT * FROM relay_customers WHERE email=$1 AND NOT disabled AND email_verified_at IS NOT NULL FOR UPDATE',[email])).rows[0];
    if(row)await mail.enqueue(c,row,'reset');
   });return {message:mail.preview?'If this email belongs to a verified test account, a reset preview has been requested. View local test emails from that account’s security screen. No email will be sent.':'If this email belongs to a verified account, a password reset has been requested. Check your inbox and spam folder. You can also use your saved recovery code.'};
  },
  async verifyEmail(input,token){
   const session=await this.session(token);if(!session)throw new InputError('Sign in to the account you are verifying, then open the link again.',401);
   await store.rate('mail:consume:'+session.account.id,10,900);
   return consume(input.linkToken,'verify',async(c,row)=>{
    if(row.id!==session.account.id)throw new InputError('Sign in to the account this link was sent to.',403);
    const updated=(await c.query('UPDATE relay_customers SET email_verified_at=now() WHERE id=$1 RETURNING *',[row.id])).rows[0];
    return {account:view(updated),message:mail.preview?'Test verification complete. No inbox access was checked.':'Your email address is verified.'};
   });
  },
  async resetPassword(input){
   await store.rate('mail:reset-consume:global',30,900);
   if(typeof input.linkToken!=='string'||!/^[a-f0-9]{64}$/.test(input.linkToken))throw new InputError('This link is invalid or has expired. Request a new one.',400);
   const password=await hashPassword(input.password),code=recovery();
   return consume(input.linkToken,'reset',async(c,row)=>{
    const updated=(await c.query('UPDATE relay_customers SET password_hash=$2,recovery_hash=$3,recovery_saved_at=NULL,recovery_rotated_at=now(),version=version+1 WHERE id=$1 RETURNING *',[row.id,password,digest(code)])).rows[0];
    await c.query('UPDATE relay_customer_sessions SET revoked=true WHERE customer_id=$1',[row.id]);
    await mail.enqueue(c,updated,'changed');
    return {recovered:true,recoveryCode:code};
   });
  },
  async session(token){
   if(!/^[a-f0-9]{64}$/.test(token??''))return null;
   const r=await store.query(`UPDATE relay_customer_sessions s SET last_seen_at=now() FROM relay_customers c WHERE s.token_hash=$1 AND s.customer_id=c.id AND s.version=c.version AND NOT s.revoked AND NOT c.disabled AND s.expires_at>now() AND s.last_seen_at>now()-interval '2 hours' RETURNING c.id,c.email,c.name,c.email_verified_at`,[digest(token)]);
   return r.rows[0]?{owner:owner(r.rows[0].id),account:view(r.rows[0])}:null;
  },
  async logout(token){await store.query('UPDATE relay_customer_sessions SET revoked=true WHERE token_hash=$1',[digest(token??'')]);}
 };
}

export function sessionLabel(value=''){
 const ua=String(value).slice(0,512);
 const device=/iPhone|iPad/.test(ua)?'iPhone/iPad':/Android/.test(ua)?'Android':/Macintosh/.test(ua)?'Mac':/Windows/.test(ua)?'Windows':/Linux/.test(ua)?'Linux':'Device';
 const browser=/Edg/.test(ua)?'Edge':/Firefox|FxiOS/.test(ua)?'Firefox':/Chrome|CriOS/.test(ua)?'Chrome':/Safari/.test(ua)?'Safari':'Browser';
 return `${browser} · ${device}`;
}
