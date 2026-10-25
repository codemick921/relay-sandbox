// Operator-only composition. Never import this from an HTTP server or worker.
import {getMerchant,checkQuoteAvailability} from '@zkp2p/pay-sdk';
import {createLiveCheckoutWriter} from '../server/pay-live-create.mjs';
import {fundingIntent} from './funding-drafts.mjs';
import {createLiveFunding} from './live-funding.mjs';
import {revolutFingerprint} from './revolut-test.mjs';
import {InputError} from '../server/validation.mjs';
import {randomUUID} from 'node:crypto';
import {readUnpaidRevolut} from '../server/revolut-replacement-read.mjs';
export function createRevolutOperator({base,drafts,policy,tracker,merchantId,apiKey,origin,fetcher=fetch}){
 const authorise=async intent=>policy.permit(await drafts.review(intent.owner??(await base.query('SELECT owner FROM relay_funding_drafts WHERE id=$1',[intent.id])).rows[0]?.owner,intent.id),merchantId);
 const options=()=>({apiBaseUrl:'https://api.pay.peer.xyz',apiKey,fetcher:(url,opts)=>fetcher(url,{...opts,redirect:'error'}),signal:AbortSignal.timeout(15000)});
 const writer=createLiveCheckoutWriter({apiKey,merchantId,authorise,rail:'revolut',fetcher});
 const flow=createLiveFunding({drafts:{...drafts,claim:(owner,id,merchant)=>drafts.claim(owner,id,merchant,{guard:(c,row)=>policy.reserve(c,row,merchant)})},tracker,writer,merchantId,origin,authorise});
 async function originalUnpaid(owner,id){
  const row=await drafts.review(owner,id),p=(await base.query('SELECT p.*,a.draft_id AS attempted_draft FROM relay_revolut_policy p JOIN relay_revolut_attempt a ON a.policy_id=p.singleton WHERE p.owner=$1 AND p.draft_id=$2',[owner,id])).rows[0];
  if(!p?.revoked||p.attempted_draft!==id||p.draft_hash!==revolutFingerprint(row)||row.status!=='bound'||row.pence!==194||row.rail!=='revolut'||row.merchant_id!==merchantId)throw new InputError('The original test must be bound and its approval revoked.',409);
  const tracked=await tracker.owned(owner,id);
  if(tracked.review_required||tracked.status!=='checkout_ready'||tracked.result?.delivery||(tracked.result?.verification?.payments??[]).some(x=>x.status==='SETTLED')||(await base.query('SELECT 1 FROM relay_live_payments WHERE order_id=$1',[id])).rows.length)throw new InputError('The first test needs reconciliation.',409);
  const proof=await readUnpaidRevolut({...fundingIntent(row),providerOrderId:row.provider_id,requestedUsdcAmount:row.requested_usdc},{apiKey,merchantId,fetcher});
  return {row,proof};
 }
 return Object.freeze({
  async prepareReplacement(owner,id,{amount,confirmUnpaid,approvalRef,consentRef}){
   if(amount!=='0.83'||confirmUnpaid!==true||![approvalRef,consentRef].every(x=>typeof x==='string'&&x.length>0&&x.length<=200))throw new InputError('Explicit approval for one unpaid 83p replacement is required.');
   if((await base.query('SELECT 1 FROM relay_revolut_replacement_policy')).rows.length)throw new InputError('The replacement has already been prepared.',409);
   const {row,proof}=await originalUnpaid(owner,id);
   const m=await getMerchant(options()),cfg=m.merchantConfig;
   if(m.id!==merchantId||m.environment!=='LIVE'||cfg?.feePayer!=='MERCHANT'||cfg?.buyerFeeShareBps!==0||cfg?.quotePreference!=='PREFER_SAR')throw new InputError('Merchant settings differ.',409);
   return base.tx(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['funding:'+owner]);await c.query('SELECT pg_advisory_xact_lock(431932)');
    const old=(await c.query('SELECT * FROM relay_funding_drafts WHERE id=$1 AND owner=$2 FOR UPDATE',[id,owner])).rows[0];
    const a=(await c.query('SELECT data,funding_revision FROM relay_agents WHERE owner=$1 AND id=$2 FOR SHARE',[owner,row.agent_id])).rows[0];
    if(!old||old.superseded_by||old.status!=='bound'||revolutFingerprint(old)!==revolutFingerprint(row)||!a||String(a.funding_revision)!==String(row.agent_revision)||a.data.address.toLowerCase()!==row.agent.address.toLowerCase()||Date.now()-Date.parse(proof.checkedAt)>30000)throw new InputError('Replacement preflight changed.',409);
    const next=randomUUID();
    await c.query('UPDATE relay_funding_drafts SET superseded_by=$2,updated_at=now() WHERE id=$1',[id,next]);
    await c.query("INSERT INTO relay_funding_drafts(id,owner,request_id,agent_id,agent_revision,agent,pence,rail) VALUES($1,$2,$3,$4,$5,$6,83,'revolut')",[next,owner,randomUUID(),row.agent_id,row.agent_revision,row.agent]);
    const n={...row,id:next,pence:83};
    await c.query('INSERT INTO relay_revolut_replacement_policy(old_draft_id,draft_id,owner,draft_hash,merchant_id,wallet_address,old_exposure_pence,principal_pence,max_total_pence,blocked_recipient_hash,preflight_hash,expires_at,approval_ref,consent_ref) VALUES($1,$2,$3,$4,$5,$6,194,83,1000,$7,$8,now()+interval \'2 hours\',$9,$10)',[id,next,owner,revolutFingerprint(n),merchantId,row.agent.address.toLowerCase(),proof.recipientHash,proof.hash,approvalRef,consentRef]);
    await c.query("INSERT INTO relay_funding_audit(draft_id,event) VALUES($1,'superseded_by_explicit_83p_authorisation'),($2,'replacement_83p_authorised_old_exposure_194p_retained')",[id,next]);
    return {id:next,oldId:id,amountPence:83,oldExposurePence:194,totalBudgetPence:1000,totalDebitCapEnforced:false};
   });
  },
  async provision(owner,id,{walletAddress,maxTotalPence=1000,approvalRef,consentRef,hours=2}){
   const row=await drafts.review(owner,id);
   if((row.currency??'GBP')!=='GBP'||row.status!=='draft'||row.rail!=='revolut'||row.agent.network!=='Base'||row.agent.token!=='USDC'||row.agent.address.toLowerCase()!==walletAddress?.toLowerCase()||row.pence>maxTotalPence||!Number.isInteger(maxTotalPence)||maxTotalPence>1000||maxTotalPence<200||!Number.isInteger(hours)||hours<1||hours>24)throw new InputError('Review the exact Revolut test draft and receiving wallet.');
   await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431932)');
    if((await c.query('SELECT 1 FROM relay_restricted_attempt UNION ALL SELECT 1 FROM relay_revolut_attempt')).rows.length)throw new InputError('A controlled test has already been attempted.',409);
    await c.query("INSERT INTO relay_revolut_policy(owner,draft_id,draft_hash,merchant_id,wallet_address,max_total_pence,expires_at,approval_ref,consent_ref) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 hour',$8,$9)",[owner,id,revolutFingerprint(row),merchantId,row.agent.address.toLowerCase(),maxTotalPence,hours,approvalRef,consentRef]);
   });return policy.status(owner);
  },
  async start(owner,id){
   const row=await drafts.review(owner,id);if(!await policy.permit(row,merchantId))throw new InputError('This test is not approved.',403);
   if((row.currency??'GBP')!=='GBP'||row.status!=='draft')return {id,attempted:false,status:row.status};
   const replacement=(await base.query('SELECT old_draft_id FROM relay_revolut_replacement_policy WHERE draft_id=$1',[id])).rows[0];
   if(replacement)await originalUnpaid(owner,replacement.old_draft_id);
   const m=await getMerchant(options()),cfg=m.merchantConfig;
   if(m.id!==merchantId||m.environment!=='LIVE'||cfg?.feePayer!=='MERCHANT'||cfg?.buyerFeeShareBps!==0||cfg?.quotePreference!=='PREFER_SAR')throw new InputError('Live Revolut merchant settings could not be verified.',409);
   const q=await checkQuoteAvailability({amount:(row.pence/100).toFixed(2),quoteMode:'exact-fiat',fiatCurrency:'GBP',enabledRails:['revolut'],destinationChainId:8453,destinationToken:'USDC',destinationAddress:row.agent.address},options());
   if(q.available!==true||!Number.isInteger(q.quoteCount)||q.quoteCount<1)throw new InputError('No Revolut offer is available at the saved amount. No checkout was attempted.',409);
   return flow.start(owner,{id,confirm:true,consent:true});
  },
  reconcile:flow.reconcile
 });
}
