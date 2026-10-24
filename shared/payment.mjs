// These checks are shared with the browser; capture material is never persisted.
export const ROUTES = {
  revolut: {platform:'revolut', actionType:'transfer_revolut', index:true},
  wise: {platform:'wise', actionType:'transfer_wise', index:false},
  monzo: {platform:'monzo', actionType:'transfer_monzo', index:false},
};
export function extensionSupported(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [a,b,c]=version.split('.').map(Number);
  return a>0 || b>6 || (b===6 && c>=3);
}
export function fiatMinor(value) {
  if (typeof value!=='string' || !/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const [a,b='']=value.trim().split('.');
  return BigInt(a)*100n+BigInt(b.padEnd(2,'0'));
}
export function captureExpiry(message) {
  const n=message?.expiresAt;
  return typeof n==='number' && Number.isFinite(n) ? (n<1e12?n*1000:n) : 0;
}
export function matchingPayment(row,order) {
  const flat=row?.params && !Array.isArray(row.params) && typeof row.params==='object' && Object.keys(row.params).length>0 && Object.values(row.params).every(v=>['string','number','boolean'].includes(typeof v));
  return row?.hidden===false && flat && fiatMinor(row.amount)===BigInt(order.quote.pence)
    && row.currency==='GBP' && typeof row.recipient==='string'
    && row.recipient.trim().toLowerCase()===order.payment?.recipient.trim().toLowerCase();
}
export function buildProof(message,row,order,now=Date.now()) {
  const config=ROUTES[order.quote.platform];
  if (!config || message.platform!==config.platform || captureExpiry(message)<=now || !matchingPayment(row,order)) throw Error('The captured payment does not match this order, or the capture expired.');
  if (!message.metadata.includes(row) || !message.buyerTeeCapture?.encryptedSessionMaterial) throw Error('Capture data is missing. Verify the payment again.');
  if(config.index && (!Number.isInteger(row.originalIndex)||row.originalIndex<0)) throw Error('The payment is missing its original verification index.');
  return {proofType:'buyerTee', encryptedSessionMaterial:message.buyerTeeCapture.encryptedSessionMaterial, params:{...row.params,...(config.index?{index:row.originalIndex}:{})}, actionPlatform:config.platform, actionType:config.actionType};
}
