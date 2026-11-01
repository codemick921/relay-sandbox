// Narrow, read-only estimate for the independently checked standard Pro configuration.
// A dashboard headline alone never supplies this calculation. No payment authorisation.
import {createHash} from 'node:crypto';
import {supportsFunding} from '../shared/fiat.mjs';
// Standard Pro software fees are uniform across fiat apps. Keep this explicit:
// Venmo purchase-protection deductions/held payouts need separate tracker support.
// PayPal/N26/crypto are not activated by extending an informational estimate.
const estimateRails=new Set(['wise','revolut','cashapp','zelle','monzo','chime']);
export const merchantFeeKey=m=>createHash('sha256').update(JSON.stringify([m?.id,m?.environment,m?.tier,m?.merchantConfig])).digest('hex');
export function selectedNetEstimate(merchant,order,payment){
 try{
  const c=merchant?.merchantConfig,q=payment?.quote,s=q?.signalIntent;
  if(merchant?.environment!=='LIVE'||merchant.id!==order.merchantId||merchant.tier!=='PRO'||!c||c.merchantId!==merchant.id)return null;
  if(c.feePayer!=='MERCHANT'||c.buyerFeeShareBps!==0||c.flatFeePricing!==false||c.dynamicOrdersEnabled!==false||String(c.destinationChainId)!=='8453'||c.destinationToken!=='USDC')return null;
  const fee=c.platformReferralFeeConfig;
  if(fee?.mode!=='flat'||fee.currency!=='USDC'||fee.valueBps!==495||(c.referralSplitConfig!=null&&(!Array.isArray(c.referralSplitConfig)||c.referralSplitConfig.length)))return null;
  if(!Array.isArray(order.referralSplitConfig)||order.referralSplitConfig.length||order.feePayer!=='MERCHANT'||order.buyerFeeShareBps!==0||order.amountMode!=='FIXED'||order.status!=='CREATED'||order.bridgeInfo)return null;
  // Current settings cannot establish an older order's pricing. Withhold instead of guessing.
  const configured=Date.parse(c.updatedAt??c.createdAt),created=Date.parse(order.createdAt);
  if(!Number.isFinite(configured)||!Number.isFinite(created)||configured>created)return null;
  if(payment.status!=='CREATED'||!estimateRails.has(payment.rail)||!supportsFunding(payment.rail,payment.currency)||payment.orderId!==order.id||payment.netSettledUsdcAmount!=null||!Array.isArray(payment.penalties)||payment.penalties.length)return null;
  if(!q||q.amountAdjustment!=null||q.crossCurrency!=null||s?.processorName!==payment.rail)return null;
  if(order.enabledRails?.length!==1||order.enabledRails[0]!==payment.rail)return null;
  // SAR is a release/verification capability, not proof that pricing exists.
  // Preserve the existing Wise seller-verification guard; other fiat apps may use buyer proof.
  if(typeof q.sellerAutomatedReleaseAvailable!=='boolean'||payment.rail==='wise'&&!q.sellerAutomatedReleaseAvailable)return null;
  if(payment.payout?.status!=null||payment.payout?.releaseEligibleAt!=null||payment.payout?.releasedAt!=null)return null;
  if(typeof s.amount!=='string'||!/^\d{1,18}$/.test(s.amount))return null;
  const gross=BigInt(s.amount);if(gross<=0n)return null;
  // Floor net at six decimals; actual per-recipient fee rounding may differ by micro-USDC.
  const net=gross*9505n/10000n;if(net<=0n)return null;
  return {schema:'peer-standard-pro-net-v1',grossUsdcRaw:String(gross),netUsdcRaw:String(net),feeUsdcRaw:String(gross-net),feeBps:495,feeConfigFingerprint:merchantFeeKey(merchant),basis:'selected_offer_standard_pro',conditional:true};
 }catch{return null;}
}
