import {supportsFunding, currencyCode} from '../shared/fiat.mjs';
// Pure projection of saved observations. Never fetches, writes or authorises payment.
const raw=v=>typeof v==='string'&&/^\d{1,24}$/.test(v)?BigInt(v):null;
const decimal=v=>typeof v==='string'&&/^\d{1,18}\.\d{6}$/.test(v)?BigInt(v.replace('.','')):null;
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const rate=v=>typeof v==='string'&&/^(0|[1-9]\d{0,15})(\.\d{1,18})?$/.test(v)&&Number(v)>0;
const units=n=>{const s=(n<0n?-n:n).toString().padStart(7,'0');return (n<0n?'-':'')+s.slice(0,-6)+'.'+s.slice(-6);};
const change=n=>`${units(n<0n?-n:n)} USDC ${n<0n?'less':'more'}`;
const schemas=['peer-wise-gbp-v1','peer-revolut-gbp-v1','peer-fiat-v2'];
function selectedOffer(o,e,now){
 const x=e?.receiveEstimate,net=raw(x?.netUsdcRaw),gross=raw(x?.grossUsdcRaw),fee=raw(x?.feeUsdcRaw);
 const checked=iso(e?.checkedAt),expires=iso(e?.expiresAt),created=iso(typeof o.createdAt==='string'?o.createdAt:o.createdAt?.toISOString?.());
 if(!schemas.includes(e?.schema)||e.status!=='within_peer_limit'||e.settlement||e.providerOrderId!==o.providerOrderId||typeof e.paymentId!=='string'||!e.paymentId||!hash(e.quoteFingerprint)||e.currency!==currencyCode(o.quote?.currency)||e.rail!==o.quote?.platform||!supportsFunding(e.rail,e.currency))return null;
 if(!checked||!expires||Date.parse(checked)>now||Date.parse(checked)>=Date.parse(expires)||created&&Date.parse(checked)<Date.parse(created)||!Number.isSafeInteger(e.totalPence)||e.totalPence<=0||!Number.isSafeInteger(o.quote?.pence)||e.totalPence>o.quote.pence)return null;
 if(x?.schema!=='peer-standard-pro-net-v2'||x.basis!=='selected_offer_standard_pro'||x.conditional!==true||x.spreadIncluded!==true||x.feeBps!==495||!hash(x.feeConfigFingerprint)||x.currency!==e.currency||x.rail!==e.rail||!rate(x.offerRate)||net===null||gross===null||fee===null||net<=0n||gross-fee!==net||net!==gross*9505n/10000n)return null;
 return {paymentId:e.paymentId,fingerprint:e.quoteFingerprint,observedAt:checked,pay:(e.totalPence/100).toFixed(2)+' '+e.currency,currency:e.currency,rail:e.rail,netUsdc:units(net),grossUsdc:units(gross),feeUsdc:units(fee),offerRate:x.offerRate};
}
export function costComparison(order,record,snapshots=[],now=Date.now()){
 const o=order??{},v=o.verification??{},settled=Array.isArray(v.payments)?v.payments.filter(p=>p?.status==='SETTLED'):[];
 const result={status:'unavailable',title:'Saved offer unavailable',explanation:'Eupova does not have a comparable selected offer saved for this request. Recorded payment and arrival details remain available below.',offer:null,actualUsdc:record.confirmedUsdc??null,actualFiat:null,fiatDifference:null,differenceUsdc:null,breakdown:[],notes:[],simulated:record.simulated===true};
 if(record.simulated)return {...result,status:'simulation',title:'Simulation only',explanation:'Example amounts do not confirm a real payment or wallet arrival.',actualUsdc:null};
 if(snapshots.length>100)return {...result,explanation:'This request has more saved offer observations than this comparison can safely review. No difference has been calculated.'};
 if(settled.length>1)return {...result,title:'Multiple payments recorded',explanation:'This request includes several settled payments. A single selected offer cannot be compared with their combined arrival.'};
 // Only the matching settled payment, or explicitly saved current selection, can supply the baseline.
 const target=settled[0]?.id??v.currentAttempt?.id??v.payIn?.currentSelection?.paymentId??v.payIn?.paymentId;
 const observations=[...snapshots,v.payIn].filter(Boolean).flatMap(e=>[e,e.currentSelection].filter(Boolean));
 const candidates=observations.map(e=>selectedOffer(o,e,now)).filter(e=>e&&e.paymentId===target&&(!iso(v.checkedAt)||e.observedAt<=iso(v.checkedAt)));
 candidates.sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
 const offer=candidates[0];
 if(!offer)return result;
 const sameTime=candidates.filter(x=>x.observedAt===offer.observedAt);
 if(sameTime.some(x=>JSON.stringify(x)!==JSON.stringify(offer)))return {...result,title:'Saved offers need review',explanation:'The saved offer observations disagree. No difference has been calculated.'};
 result.offer=offer;
 const settlement=v.payIn?.settlement;
 if(settled.length===1&&v.payIn?.paymentId===settled[0].id&&settlement?.currency===offer.currency&&settled[0].currency===offer.currency&&typeof settlement.paymentAmount==='string'&&/^\d{1,12}(\.\d{1,2})?$/.test(settlement.paymentAmount)&&raw(settlement.netUsdcRaw)===raw(settled[0].amountRaw)&&raw(settlement.netUsdcRaw)!==null&&raw(settlement.feeUsdcRaw)===raw(settled[0].feeRaw)&&raw(settlement.feeUsdcRaw)!==null){
  result.actualFiat=settlement.paymentAmount+' '+settlement.currency;
  const minor=text=>{const [a,b='']=text.split('.');return BigInt(a)*100n+BigInt(b.padEnd(2,'0'));};
  const delta=minor(settlement.paymentAmount)-minor(offer.pay.split(' ')[0]);
  const a=(delta<0n?-delta:delta).toString().padStart(3,'0');
  result.fiatDifference=(delta<0n?'-':'')+a.slice(0,-2)+'.'+a.slice(-2);
  if(delta!==0n)result.notes.push(`Peer recorded ${a.slice(0,-2)}.${a.slice(-2)} ${offer.currency} ${delta<0n?'less':'more'} than the saved offer payment amount. This excludes any bank or payment-app charges.`);
 }
 result.notes.push('The saved offer estimate already includes its seller rate and estimated Peer fee. Bank or payment-app charges are not included.');
 if(record.chargeback)result.notes.push('A dispute is recorded. Any wallet arrival shown here is historical and does not resolve the dispute.');
 if(record.trackingUnavailable)result.notes.push('Tracking is temporarily unavailable. These are the last saved figures.');
 if(record.code==='review'||o.reviewRequired)return {...result,status:'review',title:'Comparison needs review',explanation:'Payment evidence needs review. No final USDC arrival difference has been calculated.'};
 if(!record.deliveryConfirmed)return {...result,status:'pending',title:'Waiting for confirmed arrival',explanation:record.confirmedUsdc===null?'The saved offer is an estimate. Eupova will compare it once the full wallet delivery is confirmed.':'An arrival is recorded, but full delivery is not confirmed. It is too early to calculate a final difference.'};
 const actual=decimal(record.confirmedUsdc),net=decimal(record.netUsdc),expected=decimal(offer.netUsdc),paymentNet=raw(settled[0]?.amountRaw);
 if(actual===null||net===null||actual!==net||paymentNet!==net||raw(v.expectedNetRaw)!==net||raw(v.receivedRaw)!==actual||settled[0]?.currency!==offer.currency)return {...result,status:'review',title:'Amounts cannot be compared',explanation:'The saved payment and arrival figures are inconsistent, or the payment currency differs from the saved offer. No USDC arrival difference has been calculated.'};
 const diff=actual-expected;
 result.differenceUsdc=units(diff);
 result.status=diff===0n?'matched':'different';result.title=diff===0n?'Arrival matches the saved offer':change(diff)+' than the saved offer';
 result.explanation=diff===0n?'The confirmed USDC arrival matches the saved estimate after the Peer fee.':'The confirmed arrival differs from the saved estimate. The recorded figures below show what changed; the difference is not an additional charge to pay.';
 const fee=decimal(record.peerFeeUsdc),gross=decimal(offer.grossUsdc),estimatedFee=decimal(offer.feeUsdc);
 if(fee!==null&&fee===raw(settled[0]?.feeRaw)){
  const grossDiff=net+fee-gross,feeDiff=fee-estimatedFee;
  if(diff!==0n){
   result.breakdown.push(grossDiff===0n?'Converted USDC before the Peer fee is unchanged.':`Converted USDC before the Peer fee: ${change(grossDiff)} than the saved offer.`);
   result.breakdown.push(feeDiff===0n?'The recorded Peer fee matches the estimate.':`Recorded Peer fee: ${change(feeDiff)} than the estimate. A higher fee reduces the amount received.`);
   if(grossDiff!==0n)result.breakdown.push('The saved record does not establish why the converted amount changed.');
  }
 }else if(diff!==0n)result.breakdown.push('The recorded Peer fee is unavailable or inconsistent, so the difference cannot be fully broken down.');
 if(diff!==0n&&settled[0]?.adjustments?.some(a=>['CROSS_CURRENCY','PURCHASE_PROTECTION'].includes(a?.kind)))result.notes.push('Peer recorded a settlement adjustment. It is not treated as a separate charge or assumed to explain the entire difference.');
 return result;
}
export function comparisonRows(c){
 if(!c)return [];
 return [['Offer comparison',c.title],['Comparison explanation',c.explanation],['Saved selected offer at',c.offer?.observedAt],['Selected offer payment',c.offer?.pay],['Selected offer net USDC',c.offer?.netUsdc],['Selected offer estimated Peer fee (USDC)',c.offer?.feeUsdc],['Recorded wallet arrival (USDC)',c.actualUsdc],['Matched Peer payment amount',c.actualFiat],['Peer payment minus offer (same fiat currency)',c.fiatDifference],['Arrival minus selected offer (USDC)',c.differenceUsdc],...c.breakdown.map((v,i)=>[`Difference detail ${i+1}`,v]),...c.notes.map((v,i)=>[`Comparison note ${i+1}`,v])];
}
