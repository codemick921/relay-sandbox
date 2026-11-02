import {sessionWithinLease} from './session-lease.mjs';
// Server-owned, read-only wallet context. Never persists an identity or wallet link.
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {getAddress} from 'viem';
import {BASE_USDC,QuoteError} from './direct-quote.mjs';
import {createBuyerSessionReader} from './buyer-auth-session.mjs';
import {validPrivyDid} from './privy-wallet-reader.mjs';
const check=(value,code)=>{if(!value)throw new QuoteError(code);};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function address(value){try{check(/^0x[0-9a-f]{40}$/i.test(value??'')&&!/^0x0{40}$/i.test(value),'invalid_wallet_address');const normal=getAddress(value);check(value===value.toLowerCase()||value===normal,'invalid_wallet_address');return normal.toLowerCase();}catch{throw new QuoteError('invalid_wallet_address');}}
export function quoteTestEnrollment(record,clock=Date.now){
 const allowed=['owner','subject','privyDid','buyingAddress','consent','consentRecordedAt','expiresAt'];
 check(record&&Object.keys(record).every(k=>allowed.includes(k))&&typeof record.owner==='string'&&record.owner.startsWith('customer:')&&uuid.test(record.owner.slice(9))&&uuid.test(record.subject??'')&&record.subject!==record.owner.slice(9)&&validPrivyDid(record.privyDid)&&record.consent===true&&Number.isSafeInteger(record.consentRecordedAt)&&record.consentRecordedAt>0&&record.consentRecordedAt<=clock()&&Number.isSafeInteger(record.expiresAt)&&record.expiresAt>record.consentRecordedAt&&record.expiresAt-record.consentRecordedAt<=1800000,'buyer_quote_configuration');
 const saved=Object.freeze({...record,buyingAddress:record.buyingAddress===null?null:address(record.buyingAddress),environment:'development'});
 return async owner=>owner===saved.owner&&clock()<saved.expiresAt?saved:null;
}
export function createSavedRecipientReader(store){
 return async(owner,id)=>{
  check(typeof owner==='string'&&owner.startsWith('customer:')&&uuid.test(owner.slice(9))&&uuid.test(id??''),'receiving_wallet_unavailable');
  const {rows}=await store.query('SELECT id, owner, data, address_key, funding_revision FROM relay_agents WHERE owner=$1 AND id=$2',[owner,id]);
  const row=rows.length===1?rows[0]:null;
  check(row&&row.id===id&&row.owner===owner&&row.data?.network==='Base'&&row.data?.token==='USDC'&&/^[1-9][0-9]{0,18}$/.test(String(row.funding_revision)),'receiving_wallet_unavailable');
  const receivingAddress=address(row.data.address);
  check(row.address_key===receivingAddress,'receiving_wallet_unavailable');
  return {id,owner,address:receivingAddress,chainId:8453,token:BASE_USDC,revision:String(row.funding_revision),enabled:true};
 };
}
export function createBuyerWalletResolver({store,resolveSession=store&&createBuyerSessionReader(store),resolveEnrollment,verifyAccessToken,readPrivyUser,readRecipient=store&&createSavedRecipientReader(store),enabled=()=>false,clock=Date.now,windowMs=60000,maxWindows=128}={}){
 check([resolveSession,resolveEnrollment,verifyAccessToken,readPrivyUser,readRecipient,enabled].every(f=>typeof f==='function')&&Number.isInteger(windowMs)&&windowMs>0&&windowMs<=60000&&Number.isInteger(maxWindows)&&maxWindows>0&&maxWindows<=128,'buyer_quote_configuration');
 const secret=randomBytes(32),slots=new Map(),digest=value=>createHmac('sha256',secret).update(value).digest('hex');
 const validSession=s=>s&&typeof s.owner==='string'&&typeof s.binding==='string'&&s.binding.length>=16&&Number.isSafeInteger(s.expiresAt)&&s.expiresAt>clock();
 const validEnrollment=(e,s)=>e&&e.owner===s.owner&&e.environment==='development'&&e.consent===true&&validPrivyDid(e.privyDid)&&Number.isSafeInteger(e.expiresAt)&&e.expiresAt>clock();
 return async(actor,receivingWalletId)=>{
  check(enabled()===true,'buyer_quotes_disabled');
  check(actor&&Object.keys(actor).length===2&&typeof actor.sessionToken==='string'&&/^[a-f0-9]{64}$/.test(actor.sessionToken)&&typeof actor.accessToken==='string'&&actor.accessToken.length<=8192,'sign_in_required');
  const session=await resolveSession(actor.sessionToken);check(validSession(session),'sign_in_required');
  const enrollment=await resolveEnrollment(session.owner);check(validEnrollment(enrollment,session),'buyer_not_enrolled');
  const slotKey=digest(session.binding);let slot=slots.get(slotKey);
  if(!slot){if(slots.size>=maxWindows){const key=slots.keys().next().value;slots.get(key).generation++;slots.delete(key);}slot={generation:0,proof:null};slots.set(slotKey,slot);}
  const generation=slot.generation;
  try{
   const access=await verifyAccessToken(actor.accessToken);
   check(access.did===enrollment.privyDid&&access.expiresAt>clock(),'buyer_identity_mismatch');
   const beforeRecipient=await readRecipient(session.owner,receivingWalletId);
   check(enabled()===true&&session.expiresAt>clock()&&enrollment.expiresAt>clock(),'buyer_quotes_disabled');
   const user=await readPrivyUser(access.did);
   check(user?.id===access.did&&Array.isArray(user.linkedAccounts),'buyer_identity_mismatch');
   const identities=user.linkedAccounts.filter(a=>a.type==='custom_auth');
   check(identities.length===1&&identities[0].subject===enrollment.subject,'buyer_identity_mismatch');
   let buyingWallet=null;
   if(enrollment.buyingAddress){
    const candidates=user.linkedAccounts.filter(a=>a.type==='wallet'&&typeof a.address==='string'&&a.address.toLowerCase()===enrollment.buyingAddress);
    check(candidates.length===1,'buyer_wallet_not_linked');buyingWallet=candidates[0];
    check(address(buyingWallet.address)===enrollment.buyingAddress&&buyingWallet.chainType==='ethereum'&&buyingWallet.walletClientType==='privy'&&buyingWallet.connectorType==='embedded'&&buyingWallet.userCanSign===true&&buyingWallet.delegated===false&&[false,undefined].includes(buyingWallet.imported),'buyer_wallet_unsupported');
   }
   // Recheck local records after all upstream awaits. No last_seen_at or records updated.
   const current=await resolveSession(actor.sessionToken),currentEnrollment=await resolveEnrollment(session.owner),recipient=await readRecipient(session.owner,receivingWalletId);
   check(validSession(current)&&hash(sessionWithinLease(current,enrollment))===hash(sessionWithinLease(session,enrollment))&&validEnrollment(currentEnrollment,current)&&hash(currentEnrollment)===hash(enrollment)&&hash(recipient)===hash(beforeRecipient),'buyer_context_changed');
   check(enabled()===true&&access.expiresAt>clock()&&slot.generation===generation&&slots.get(slotKey)===slot,'buyer_context_changed');
   if(!buyingWallet){slot.generation++;slot.proof=null;return {session:sessionWithinLease(current,enrollment),recipient,buyer:null};}
   const fingerprint=hash([digest(actor.accessToken),access.did,access.sid,enrollment.subject,enrollment.expiresAt,sessionWithinLease(current,enrollment),buyingWallet,recipient]);
   // Fresh GET on every resolution, but unchanged evidence retains the first proof
   // time. Polling cannot extend its absolute 60-second review window.
   if(!slot.proof||slot.proof.fingerprint!==fingerprint||slot.proof.expiresAt<=clock()){
    slot.generation++;
    slot.proof={fingerprint,reference:randomUUID(),verifiedAt:clock(),expiresAt:Math.min(clock()+windowMs,current.expiresAt,access.expiresAt,enrollment.expiresAt)};
   }
   const p=slot.proof;
   return {session:sessionWithinLease(current,enrollment),recipient,buyer:{owner:current.owner,sessionBinding:current.binding,address:enrollment.buyingAddress,chainId:8453,verification:'server_verified_wallet_link',reference:p.reference,verifiedAt:p.verifiedAt,expiresAt:p.expiresAt}};
  }catch(error){slot.generation++;slot.proof=null;throw error instanceof QuoteError?error:new QuoteError('buyer_verification_unavailable');}
 };
}
