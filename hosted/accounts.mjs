import {randomUUID,randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {digest} from './db.mjs';
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
async function verifyPassword(value,encoded){
 if(typeof value!=='string'||Buffer.byteLength(value)>512)return false;
 const parts=String(encoded).split('$');if(parts[0]!=='scrypt-v1'||!/^[a-f0-9]{32}$/.test(parts[1])||!/^[a-f0-9]{64}$/.test(parts[2]))throw Error('Unsupported password encoding.');
 return timingSafeEqual(await derive(value,parts[1]),Buffer.from(parts[2],'hex'));
}
const view=row=>({id:row.id,name:row.name,email:row.email,emailVerified:false});
const owner=id=>'customer:'+id;
const recovery=()=>randomBytes(32).toString('hex');
export function createAccounts(store){
 async function limits(email,kind){await store.rate('accounts:global',60,900);await store.rate('accounts:'+kind+':'+digest(email),kind==='signup'?3:10,900);}
 async function issue(row){
  const token=randomBytes(32).toString('hex');
  const saved=await store.query(`INSERT INTO relay_customer_sessions(token_hash,customer_id,version) SELECT $1,id,version FROM relay_customers WHERE id=$2 AND password_hash=$3 AND NOT disabled RETURNING token_hash`,[digest(token),row.id,row.password_hash]);
  if(!saved.rows.length)throw new InputError('Please sign in again.',401);
  return {token,account:view(row)};
 }
 return {
  async signup(input){
   const email=emailKey(input.email);await limits(email,'signup');
   const name=typeof input.name==='string'?input.name.trim():'';
   if(name.length<2||name.length>60||input.acceptSandbox!==true)throw new InputError('Enter your name and confirm that payments are disabled.');
   const password=await hashPassword(input.password),code=recovery(),id=randomUUID();
   try{
    return await store.tx(async c=>{
     const row=(await c.query('INSERT INTO relay_customers(id,email,name,password_hash,recovery_hash) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,email,name,password,digest(code)])).rows[0];
     const token=randomBytes(32).toString('hex');
     await c.query('INSERT INTO relay_customer_sessions(token_hash,customer_id,version) VALUES($1,$2,1)',[digest(token),id]);
     return {token,account:view(row),recoveryCode:code};
    });
   }catch(e){if(e.code==='23505')throw new InputError('Unable to create this account. Try signing in or recovering access.',409);throw e;}
  },
  async login(input){
   const email=emailKey(input.email);await limits(email,'login');
   const row=(await store.query('SELECT * FROM relay_customers WHERE email=$1',[email])).rows[0];
   const valid=await verifyPassword(input.password,row?.password_hash??dummy);
   if(!valid||!row||row.disabled)throw new InputError('Email or password not recognised.',401);
   return issue(row);
  },
  async recover(input){
   const email=emailKey(input.email);await limits(email,'recover');
   if(typeof input.recoveryCode!=='string'||!/^[a-f0-9]{64}$/i.test(input.recoveryCode))throw new InputError('Email or recovery code not recognised.',401);
   const password=await hashPassword(input.password),code=recovery();
   const result=await store.tx(async c=>{
    const row=(await c.query(`UPDATE relay_customers SET password_hash=$3,recovery_hash=$4,version=version+1 WHERE email=$1 AND recovery_hash=$2 AND NOT disabled RETURNING id`,[email,digest(input.recoveryCode.toLowerCase()),password,digest(code)])).rows[0];
    if(!row)throw new InputError('Email or recovery code not recognised.',401);
    await c.query('UPDATE relay_customer_sessions SET revoked=true WHERE customer_id=$1',[row.id]);return row;
   });
   return {recovered:!!result,recoveryCode:code};
  },
  async password(input,token){
   const session=await this.session(token);if(!session)throw new InputError('Sign in to change your password.',401);
   await limits(session.account.email,'password');
   const row=(await store.query('SELECT * FROM relay_customers WHERE id=$1',[session.account.id])).rows[0];
   if(!await verifyPassword(input.currentPassword,row.password_hash))throw new InputError('Current password not recognised.',401);
   const password=await hashPassword(input.password),code=recovery(),nextToken=randomBytes(32).toString('hex');
   return store.tx(async c=>{
    const updated=(await c.query('UPDATE relay_customers SET password_hash=$3,recovery_hash=$4,version=version+1 WHERE id=$1 AND password_hash=$2 AND version=$5 AND NOT disabled RETURNING *',[row.id,row.password_hash,password,digest(code),row.version])).rows[0];
    if(!updated)throw new InputError('Please sign in again.',401);
    await c.query('UPDATE relay_customer_sessions SET revoked=true WHERE customer_id=$1',[row.id]);
    await c.query('INSERT INTO relay_customer_sessions(token_hash,customer_id,version) VALUES($1,$2,$3)',[digest(nextToken),row.id,updated.version]);
    return {token:nextToken,account:view(updated),recoveryCode:code};
   });
  },
  async session(token){
   if(!/^[a-f0-9]{64}$/.test(token??''))return null;
   const r=await store.query(`UPDATE relay_customer_sessions s SET last_seen_at=now() FROM relay_customers c WHERE s.token_hash=$1 AND s.customer_id=c.id AND s.version=c.version AND NOT s.revoked AND NOT c.disabled AND s.expires_at>now() AND s.last_seen_at>now()-interval '2 hours' RETURNING c.id,c.email,c.name`,[digest(token)]);
   return r.rows[0]?{owner:owner(r.rows[0].id),account:view(r.rows[0])}:null;
  },
  async logout(token){await store.query('UPDATE relay_customer_sessions SET revoked=true WHERE token_hash=$1',[digest(token??'')]);}
 };
}
