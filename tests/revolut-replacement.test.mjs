import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createAccounts} from '../hosted/accounts.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createRestrictedTestPolicy} from '../hosted/restricted-test.mjs';
import {createRevolutPolicy,createRevolutRelease} from '../hosted/revolut-test.mjs';
import {createRevolutOperator} from '../hosted/revolut-operator.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {recipientHash} from '../server/revolut-replacement-read.mjs';
const envelope=x=>new Response(JSON.stringify({success:true,responseObject:x}));
async function setup(){
 const f=await fixture(),drafts=createFundingDrafts(f.store);await drafts.migrate();await createRestrictedTestPolicy(f.store).migrate();
 const policy=createRevolutPolicy(f.store);await policy.migrate();const tracker=createLiveStore(f.pool,{merchantId:'merchant'});await tracker.migrate();
 const accounts=createAccounts(f.store),a=await accounts.signup({email:'replace@example.test',password:'replacement fixture account password',name:'Fixture',acceptSandbox:true}),owner=(await accounts.session(a.token)).owner;
 const agent={id:randomUUID(),name:'Agent',address:'0x1111111111111111111111111111111111111111',network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);
 const {id}=await drafts.prepare(owner,{agentId:agent.id,requestId:randomUUID(),amount:'1.94',rail:'revolut',confirm:true});
 const merchant={id:'merchant',environment:'LIVE',merchantConfig:{feePayer:'MERCHANT',buyerFeeShareBps:0,quotePreference:'PREFER_SAR'}};
 const orders=new Map(),flags={paid:false,lost:false,partialHistory:false,unknownRecipient:false},posts=[];
 const payment=o=>({id:'payment-'+o.id,orderId:o.id,status:flags.paid?'SETTLED':'CREATED',rail:'revolut',currency:'GBP',paymentAmount:flags.paid?'1.94':'0',netSettledUsdcAmount:flags.paid?'2':null,fulfillTransaction:null,chargebackStatus:'NONE',penalties:[],attestation:null,completedAt:null,payTo:flags.unknownRecipient?'':'firstrecipient'});
 const fetcher=async(url,opts={})=>{
  if(url.endsWith('/me'))return envelope(merchant);
  if(url.includes('availability'))return envelope({available:true,quoteCount:1,nearbySuggestions:null});
  if(opts.method==='POST'){
   const b=JSON.parse(opts.body),o={id:'peer-'+posts.length,merchantId:'merchant',status:'CREATED',requestedUsdcAmount:'2.59',remainingUsdcAmount:'2.59',requestedFiat:{amount:b.requestedFiatAmount,currency:b.requestedFiatCurrency},amountMode:'FIXED',destinationAddress:b.destinationAddress,destinationToken:b.destinationToken,destinationChainId:String(b.destinationChainId),enabledRails:b.enabledRails,feePayer:b.feePayer,buyerFeeShareBps:0,notes:b.notes,successUrl:b.successUrl,chargebackStatus:'NONE'};
   posts.push(b);orders.set(o.id,o);if(flags.lost)throw Error('lost response');return envelope({order:o,orderToken:'private-fixture'});
  }
  const parts=url.split('/'),key=url.endsWith('/payments')?parts.at(-2):parts.at(-1),o=orders.get(key);assert.ok(o,'known provider order');
  if(url.endsWith('/payments'))return envelope({payments:[payment(o)],hasMore:flags.partialHistory});
  return envelope({merchant,order:o,currentPayment:payment(o)});
 };
 const operator=createRevolutOperator({base:f.store,drafts,policy,tracker,merchantId:'merchant',apiKey:'fixture',origin:'https://relay.example',fetcher});
 await operator.provision(owner,id,{walletAddress:agent.address,approvalRef:'initial approval',consentRef:'initial consent'});await operator.start(owner,id);
 const replace=()=>operator.prepareReplacement(owner,id,{amount:'0.83',confirmUnpaid:true,approvalRef:'explicit second 83p now',consentRef:'same wallet and Peer'});
 return {...f,drafts,policy,tracker,operator,owner,id,agent,flags,posts,replace};
}
test('one explicitly authorised replacement preserves original history, budget exposure and one-shot concurrency',async()=>{const f=await setup();try{
 await assert.rejects(f.replace(),/approval revoked/);
 await f.store.query('UPDATE relay_revolut_policy SET revoked=true');
 const results=await Promise.allSettled([f.replace(),f.replace()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const n=results.find(r=>r.status==='fulfilled').value;assert.equal(n.amountPence+n.oldExposurePence,277);
 assert.equal((await f.drafts.review(f.owner,f.id)).status,'bound');assert.equal((await f.drafts.review(f.owner,f.id)).superseded_by,n.id);
 assert.equal(await f.policy.permit(await f.drafts.review(f.owner,f.id),'merchant'),false);
 await f.drafts.migrate();await f.policy.migrate();
 await Promise.all(Array.from({length:6},()=>f.operator.start(f.owner,n.id)));
 assert.equal(f.posts.length,2);assert.equal(f.posts[1].requestedFiatAmount,'0.83');
 assert.equal((await f.tracker.state(f.owner)).orders.length,2);
 assert.equal((await f.policy.status(f.owner)).oldExposurePence,194);
 assert.equal((await f.store.query('SELECT reserved_pence FROM relay_revolut_attempt')).rows[0].reserved_pence,1000);
 assert.equal((await f.store.query('SELECT reserved_pence FROM relay_revolut_replacement_attempt')).rows[0].reserved_pence,83);
 await assert.rejects(f.replace(),/already/);
 for(const table of ['relay_revolut_attempt','relay_revolut_replacement_attempt','relay_revolut_replacement_policy'])await assert.rejects(f.store.query('DELETE FROM '+table));
 await assert.rejects(f.store.query('UPDATE relay_funding_drafts SET superseded_by=NULL WHERE id=$1',[f.id]),/Immutable/);
 await assert.rejects(f.store.query('UPDATE relay_revolut_replacement_policy SET principal_pence=84'),/Immutable/);
 }finally{await f.close();}});
test('paid, incomplete or unknown-recipient first history blocks replacement before any second POST',async()=>{const f=await setup();try{
 await f.store.query('UPDATE relay_revolut_policy SET revoked=true');
 for(const flag of ['paid','partialHistory','unknownRecipient']){f.flags[flag]=true;await assert.rejects(f.replace());f.flags[flag]=false;}
 assert.equal(f.posts.length,1);assert.equal((await f.drafts.review(f.owner,f.id)).superseded_by,null);
 assert.equal((await f.store.query('SELECT * FROM relay_revolut_replacement_policy')).rows.length,0);
 }finally{await f.close();}});
test('ambiguous replacement retains permanent attempt and can only be reconciled using GET',async()=>{const f=await setup();try{
 await f.store.query('UPDATE relay_revolut_policy SET revoked=true');const n=await f.replace();f.flags.lost=true;
 assert.equal((await f.operator.start(f.owner,n.id)).unresolved,true);await f.operator.start(f.owner,n.id);assert.equal(f.posts.length,2);
 await f.operator.reconcile(f.owner,n.id,'peer-1');assert.equal(f.posts.length,2);assert.equal((await f.drafts.review(f.owner,n.id)).status,'bound');
 }finally{await f.close();}});
test('replacement release requires a selected different recipient and permanently revokes a matching recipient',async()=>{const f=await setup();try{
 await f.store.query('UPDATE relay_revolut_policy SET revoked=true');const n=await f.replace();await f.operator.start(f.owner,n.id);
 const row=await f.drafts.review(f.owner,n.id),result={verification:{payIn:{status:'within_peer_limit',totalPence:83}}};
 assert.equal(await f.policy.recipientPermitted(row,result),false);
 result.verification.payIn.recipientHash=recipientHash('secondrecipient');assert.equal(await f.policy.recipientPermitted(row,result),true);
 result.verification.payIn.totalPence=84;assert.equal(await f.policy.recipientPermitted(row,result),false);result.verification.payIn.totalPence=83;
 result.verification.payIn.recipientHash=recipientHash('@FirstRecipient');assert.equal(await f.policy.recipientPermitted(row,result),false);
 assert.equal((await f.policy.status(f.owner)).revoked,true);
 result.verification.payIn.recipientHash=recipientHash('secondrecipient');assert.equal(await f.policy.recipientPermitted(row,result),false);
 }finally{await f.close();}});
test('a changed wallet blocks replacement and supersession cannot be set without its linked authorisation',async()=>{const f=await setup();try{
 await f.store.query('UPDATE relay_revolut_policy SET revoked=true');
 await assert.rejects(f.store.tx(c=>c.query('UPDATE relay_funding_drafts SET superseded_by=$2 WHERE id=$1',[f.id,randomUUID()])));
 await f.store.query("UPDATE relay_agents SET data=jsonb_set(data,'{address}','\"0x2222222222222222222222222222222222222222\"') WHERE id=$1",[f.agent.id]);
 await assert.rejects(f.replace(),/changed/);assert.equal(f.posts.length,1);
 }finally{await f.close();}});
