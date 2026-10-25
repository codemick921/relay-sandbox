import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fundingCatalog,supportsFunding,formatFiat} from '../shared/fiat.mjs';
import {getPaymentMethodsCatalog,getCurrencyInfoFromHash} from '@zkp2p/sdk';
import {FIAT_SUPPORTED_RAILS} from '@zkp2p/pay-shared';
import {fundingPence} from '../server/funding-amount.mjs';
import {checkoutRequest,validateCheckout} from '../server/pay-contract.mjs';
import {observePeerPayIn} from '../server/pay-payin.mjs';
import {verifyPayDelivery} from '../server/pay-delivery.mjs';
import {createLiveCheckoutWriter} from '../server/pay-live-create.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {paymentRecord,renderRecord} from '../hosted/payment-records.mjs';
import {summarize,createFundingHistoryReader,renderStatement} from '../hosted/funding-history.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {local,remote,payment,receipt,rpc} from './fixtures/live-evidence.mjs';
import {fundingCosts} from '../src/funding-costs.mjs';
const envelope=data=>new Response(JSON.stringify({success:true,responseObject:data}));

test('catalogue matches pinned production methods and checkout SDK, excludes PayPal, and never invents currency-method pairs',()=>{
 const catalog=getPaymentMethodsCatalog(8453);
 assert.equal(fundingCatalog.currencies.length,35);
 assert.ok(!fundingCatalog.methods.some(m=>m.id==='paypal'));
 for(const m of fundingCatalog.methods){assert.deepEqual(m.currencies,catalog[m.id].currencies.map(getCurrencyInfoFromHash).map(x=>x.currencyCode).sort());assert.equal(m.checkoutSupported,FIAT_SUPPORTED_RAILS.includes(m.id));}
 assert.ok(supportsFunding('monzo','GBP'));assert.ok(!supportsFunding('monzo','EUR'));assert.ok(!supportsFunding('alipay','CNY'));assert.ok(!supportsFunding('paypal','USD'));
 for(const m of fundingCatalog.methods.filter(m=>m.checkoutSupported))for(const c of m.currencies){assert.equal(fundingPence('25.17',m.id,c),2517);const o={...local(),quote:{pence:2517,platform:m.id,currency:c}};assert.equal(checkoutRequest(o,'https://example.test').requestedFiatCurrency,c);const r={...remote(),requestedFiat:{amount:'25.17',currency:c},enabledRails:[m.id]};assert.equal(validateCheckout(r,o,'merchant'),r);assert.throws(()=>validateCheckout({...r,requestedFiat:{amount:'25.17',currency:c==='EUR'?'GBP':'EUR'}},o,'merchant'));}
 for(const x of ['1e2','-1','10.001','1000.01','0'])assert.throws(()=>fundingPence(x,'revolut','EUR'));
 assert.throws(()=>fundingPence('25','wise','ZZZ'));assert.throws(()=>fundingPence('25','monzo','USD'));
 assert.equal(formatFiat(2517,'JPY'),'JP¥25.17');
});

test('foreign-currency settlement verifies exact wallet delivery and keeps requested and paid currencies distinct',async()=>{
 for(const [rail,currency] of [['wise','JPY'],['revolut','EUR'],['monzo','GBP'],['venmo','USD'],['cashapp','USD'],['chime','USD'],['zelle','USD']]){
 const o={...local(),quote:{pence:2500,platform:rail,currency}};
 const r={...remote(),requestedFiat:{amount:'25',currency},enabledRails:[rail]};
 const p={...payment(),rail,currency,paymentAmount:'25.00'};p.quote.signalIntent={...p.quote.signalIntent,processorName:rail};
 validateCheckout(r,o,'merchant');
 const update=await verifyPayDelivery(o,r,[p],{rpc:rpc({getTransactionReceipt:async()=>receipt(p)})});assert.equal(update.status,'checkout_received');
 const payIn=observePeerPayIn(o,{order:r,currentPayment:p,merchant:{id:'merchant',environment:'LIVE'}},[p]);assert.equal(payIn.status,'settled_observation');assert.equal(payIn.currency,currency);
 const record=paymentRecord({...o,...update,verification:{...update.verification,payIn}});assert.equal(record.currency,currency);assert.equal(record.requestedAmount,'25.00');assert.equal(record.requestedGbp,currency==='GBP'?'25.00':null);assert.equal(record.recordedFiat,'25.00 '+currency);assert.equal(record.deliveryConfirmed,true);assert.match(renderRecord(record,'csv'),new RegExp('Requested amount \\('+currency+'\\)'));
 const costs=fundingCosts({requestedPence:2500,currency,verification:{...update.verification,payIn}});assert.equal(costs.rows[0].value,formatFiat(2500,currency));
 }
});

test('multi-currency drafts persist currency, migrate twice, forbid currency mutation and prevent idempotent currency substitution',async()=>{
 const f=await fixture();try{
 const drafts=createFundingDrafts(f.store);await drafts.migrate();const owner='customer:'+randomUUID();const agent={id:randomUUID(),name:'Fixture',address:local().agent.address,network:'Base',token:'USDC'};await f.store.addAgent(owner,agent);
 const input={requestId:randomUUID(),agentId:agent.id,amount:'25',rail:'revolut',currency:'EUR',confirm:true};
 const {id}=await drafts.prepare(owner,input);await drafts.migrate();assert.equal((await drafts.list(owner))[0].currency,'EUR');await assert.rejects(drafts.prepare(owner,{...input,currency:'GBP'}));
 await assert.rejects(f.store.query("UPDATE relay_funding_drafts SET currency='GBP' WHERE id=$1",[id]),/Immutable/);
 const history=await createFundingHistoryReader(f.pool)(owner);assert.equal(history.records[0].currency,'EUR');assert.equal(history.summary.requestedGbp.amount,null);assert.equal(history.summary.requestedFiat.EUR.amount,'25.00');assert.match(renderStatement(history,'csv'),/Requested EUR/);
 await drafts.cancel(owner,{id});await assert.rejects(drafts.prepare(owner,{...input,requestId:randomUUID(),rail:'monzo',currency:'EUR'}));await assert.rejects(drafts.prepare(owner,{...input,requestId:randomUUID(),rail:'paypal',currency:'USD'}));
 const legacy=await drafts.prepare(owner,{...input,requestId:randomUUID(),currency:undefined,rail:'wise'});assert.equal((await drafts.review(owner,legacy.id)).currency,'GBP');
 const tracker=createLiveStore(f.pool,{merchantId:'merchant'});await tracker.migrate();const intent={...local(),id:randomUUID(),agent,quote:{pence:2500,platform:'revolut',currency:'EUR'},requestedUsdcAmount:'12.5'};await tracker.bindTrustedOrder(owner,intent);assert.equal((await tracker.state(owner)).orders[0].quote.currency,'EUR');await assert.rejects(tracker.bindTrustedOrder(owner,{...intent,quote:{...intent.quote,currency:'USD'}}));
 }finally{await f.close();}
});

test('statements sum each fiat currency separately; legacy GBP never absorbs foreign requests',()=>{
 const record=(currency,pence)=>paymentRecord({...local(),quote:{pence,platform:'wise',...currency?{currency}:{}}});
 const total=summarize([record(undefined,2500),record('EUR',1700),record('EUR',301),record('JPY',100)]);
 assert.equal(total.requestedGbp.amount,'25.00');assert.deepEqual(total.requestedFiat,{GBP:{amount:'25.00',known:1},EUR:{amount:'20.01',known:2},JPY:{amount:'1.00',known:1}});
});

test('new rail checks merchant enablement before POST, and one pinned currency is sent without weakening destination or fee checks',async()=>{
 let posts=0,enabled=false;
 const writer=createLiveCheckoutWriter({apiKey:'fixture',merchantId:'merchant',rail:'monzo',authorise:()=>true,fetcher:async(url,opts)=>{
  if(url.endsWith('/me'))return envelope({id:'merchant',environment:'LIVE',merchantConfig:{enabledRails:enabled?['monzo']:['wise'],feePayer:'MERCHANT',buyerFeeShareBps:0,quotePreference:'PREFER_SAR'}});
  posts++;const body=JSON.parse(opts.body);assert.equal(body.requestedFiatCurrency,'GBP');assert.deepEqual(body.enabledRails,['monzo']);return envelope({order:{...remote(),status:'CREATED',enabledRails:['monzo'],buyerFeeShareBps:0,successUrl:body.successUrl},orderToken:'fixture-only-token'});
 }});
 const o={...local(),agent:{...local().agent,network:'Base',token:'USDC'},quote:{pence:2500,platform:'monzo',currency:'GBP'}};
 await assert.rejects(writer.create(o,'https://example.test'));assert.equal(posts,0);enabled=true;const result=await writer.create(o,'https://example.test');assert.equal(posts,1);assert.match(result.checkoutUrl,/method=monzo/);
 await assert.rejects(writer.create({...o,quote:{...o.quote,currency:'EUR'}},'https://example.test'));assert.equal(posts,1);
});
