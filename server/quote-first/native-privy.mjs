// Native authentication links two verified identities; it never issues JWTs or creates wallets.
import {createHash,randomBytes} from 'node:crypto';
import {getAddress} from 'viem';
import {validPrivyDid} from './privy-wallet-reader.mjs';
export const nativeConsent='native-wallet-link-v1';
export const hashNative=value=>createHash('sha256').update(value).digest('hex');
export class NativeError extends Error {constructor(code){super(code);this.code=code;}}
const check=(v,c)=>{if(!v)throw new NativeError(c);};
export function nativeInventory(user,did){
 check(user?.id===did&&Array.isArray(user.linkedAccounts),'identity_unavailable');
 const accounts=user.linkedAccounts;
 check(accounts.some(a=>['email','passkey'].includes(a.type))&&!accounts.some(a=>a.type==='custom_auth'),'native_identity_required');
 const loginHint=accounts.find(a=>a.type==='email')?.loginHint??'Native Privy account';
 const wallets=accounts.filter(a=>a.type==='wallet');
 check(wallets.length<=1,'wallet_review_required');
 if(!wallets.length)return {status:'no_wallet',address:null,fingerprint:'none',loginHint};
 const w=wallets[0];
 check(w.chainType==='ethereum'&&w.walletClientType==='privy'&&w.connectorType==='embedded'&&w.userCanSign===true&&w.delegated===false&&w.imported===false,'wallet_review_required');
 let address;try{address=getAddress(w.address).toLowerCase();}catch{throw new NativeError('wallet_review_required');}
 check(!/^0x0{40}$/.test(address),'wallet_review_required');
 return {status:'wallet_checked',address,loginHint,fingerprint:hashNative(JSON.stringify(['native-wallet-v1',did,address]))};
}
export function createNativePrivyService({appId,store,resolveSession,verifyAccessToken,readPrivyUser,enabled=()=>false,clock=Date.now}){
 async function session(token){
  check(enabled()===true,'native_disabled');const s=structuredClone(await resolveSession(token));
  check(s&&/^customer:[a-f0-9-]{36}$/i.test(s.owner)&&/^[a-f0-9]{64}$/.test(s.binding)&&s.expiresAt>clock(),'sign_in_required');return s;
 }
 async function unchanged(token,s){const n=await session(token);check(n.owner===s.owner&&n.binding===s.binding,'session_changed');return n;}
 async function identity(accessToken){
  const a=await verifyAccessToken(accessToken);check(validPrivyDid(a?.did)&&typeof a.sid==='string'&&a.expiresAt>clock(),'privy_sign_in_required');
  const inventory=nativeInventory(await readPrivyUser(a.did),a.did);check(a.expiresAt>clock(),'privy_sign_in_required');return {access:a,inventory};
 }
 return Object.freeze({
  async status(token){const s=await session(token),link=await store.link(appId,s.owner);await unchanged(token,s);return {enabled:true,appId,consentVersion:nativeConsent,linked:!!link,canCreateWallet:false,canCreatePayment:false};},
  async begin(token){const s=await session(token),nonce=randomBytes(32).toString('hex'),expiresAt=Math.min(clock()+300000,s.expiresAt);
   await store.begin({appId,owner:s.owner,binding:s.binding,nonceHash:hashNative(nonce),expiresAt});await unchanged(token,s);return {nonce,expiresAt,consentVersion:nativeConsent};},
  async review(token,accessToken,nonce){
   check(/^[a-f0-9]{64}$/.test(nonce??''),'intent_expired');const s=await session(token),{access,inventory}=await identity(accessToken),link=await store.link(appId,s.owner);
   check(!link||link.did===access.did,'identity_conflict');await unchanged(token,s);
   await store.review({appId,owner:s.owner,binding:s.binding,nonceHash:hashNative(nonce),did:access.did,sidHash:hashNative(access.sid),fingerprint:inventory.fingerprint,address:inventory.address});
   await unchanged(token,s);return {did:access.did,loginHint:inventory.loginHint,wallet:inventory.status,address:inventory.address,consentVersion:nativeConsent,canCreateWallet:false,canCreatePayment:false};
  },
  async confirm(token,accessToken,input){
   check(input?.consent===true&&input.consentVersion===nativeConsent&&/^[a-f0-9]{64}$/.test(input.nonce??''),'consent_required');
   const s=await session(token),{access,inventory}=await identity(accessToken);await unchanged(token,s);
   await store.confirm({appId,owner:s.owner,binding:s.binding,nonceHash:hashNative(input.nonce),did:access.did,sidHash:hashNative(access.sid),fingerprint:inventory.fingerprint,address:inventory.address,consentVersion:nativeConsent,recheck:()=>{check(access.expiresAt>clock(),'privy_sign_in_required');return unchanged(token,s);}});
   await unchanged(token,s);return {linked:true,canCreateWallet:false,canCreatePayment:false};
  },
  async recovery(token,accessToken){
   const s=await session(token),{access,inventory}=await identity(accessToken),link=await store.link(appId,s.owner);check(link&&link.did===access.did,'identity_conflict');await unchanged(token,s);
   check(link.fingerprint===inventory.fingerprint,'wallet_review_required');
   const newSession=link.sidHash!==hashNative(access.sid);
   return {status:inventory.status==='no_wallet'?'no_wallet':newSession?'reauthentication_checked':'new_sign_in_needed',address:inventory.address,identityChecked:true,walletChecked:inventory.status==='wallet_checked',newSession,checkedAt:clock(),validUntil:Math.min(clock()+15000,access.expiresAt,s.expiresAt),browserRecoveryProven:false,exportTested:false,canCreateWallet:false,canCreatePayment:false};
  }
 });
}
