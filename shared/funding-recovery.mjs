// Guidance over saved evidence and a local user answer. Never authorises a retry,
// cancellation, refund, new payment or a change to the underlying record.
const positive=value=>typeof value==='string'&&/^\d{1,18}(\.\d{1,6})?$/.test(value)&&Number(value)>0;
export function recoveryPlan(record={},paymentSent='unsure'){
 const sent=['yes','no','unsure'].includes(paymentSent)?paymentSent:'unsure';
 const uncertain=['uncertain','review','disputed'].includes(record.code);
 const checking=record.trackingUnavailable||record.stale||['retrying','overdue','stale','waiting','review','evidence_pending'].includes(record.tracking?.code);
 const funds=record.deliveryConfirmed===true||record.providerFulfilled===true||positive(record.confirmedUsdc)||positive(record.netUsdc);
 let action=record.next??'Review the existing request and keep your payment confirmation. Do not pay a duplicate.',owner='Eupova · payment and wallet tracking';
 if(record.code==='draft'){
  action='Review or cancel this saved draft. No checkout has been created for it. If you sent money separately, keep that confirmation for review; this draft cannot establish where it went.';
  owner='You · review the saved draft';
 }else if(record.code==='disputed'){
  action='Keep the original request and any dispute reference. A past wallet receipt does not resolve the dispute. Do not send a second payment to clear it.';owner='Payment provider and Eupova · dispute review';
 }else if(uncertain){
  action='Keep this request for review. Eupova has not established a safe replacement. Keep your bank confirmation and request reference; do not send another payment.';owner='Eupova · reconcile the original attempt';
 }else if(record.deliveryConfirmed){
  action='Save the confirmed wallet receipt. Check the agent’s service and spending permissions separately; wallet arrival does not prove that a task was paid for.';owner='You · check agent access';
 }else if(checking){
  action='The saved check is incomplete or out of date. Reload the saved status and keep this request. A delay or failed check does not prove the payment failed. Do not pay again.';
 }else if(sent!=='no'||funds){
  action='Keep following this original request. Save your payment confirmation, amount and time. Do not send a replacement while payment or wallet arrival is unresolved.';
 }else if(record.stopped||['ended','attempt_expired'].includes(record.code)){
  action='Check your payment app for sent or scheduled transfers. Do not use the old instructions. Open the existing request to review its available controls; expiry or local stopping is not a refund or provider cancellation.';owner='You · check payment history, then review request';
 }else{
  action='Open this existing request to review its current instructions or available stop controls. Confirm in your payment app that nothing was sent or scheduled before starting again.';owner='You · review the existing request';
 }
 return {action,owner,sent,mayReplace:false,steps:[
  {label:'Request saved',status:record.id?'Recorded':'Not available'},
  {label:'Full payment verified',status:record.providerFulfilled?'Confirmed':positive(record.netUsdc)?'Part payment recorded':'Not confirmed'},
  {label:'Wallet delivery',status:record.deliveryConfirmed?'Confirmed':positive(record.confirmedUsdc)?'Part arrival recorded':'Not confirmed'},
  {label:'Agent can spend',status:'Not checked'}],
  keep:['Eupova request ID and provider order ID, if available.','Payment amount, currency, time and bank/payment-app confirmation.','The original receiving instructions and any error shown.'],
  reminder:'Do not share a private key, recovery phrase, password or full bank statement.'};
}
export function recoverySummary(record={},paymentSent='unsure'){
 const plan=recoveryPlan(record,paymentSent);
 // Explicit fields only; never serialise raw provider records or checkout URLs.
 const safe=value=>typeof value==='string'?value.replace(/[\r\n]/g,' ').slice(0,180):'Not available';
 return ['Eupova funding status summary',record.simulated?'SIMULATION — no real funds':'Saved evidence — not a bank receipt',
  `Request: ${safe(record.id)}`,`Provider order: ${safe(record.providerOrderId)}`,`Status: ${safe(record.title)}`,
  `Requested: ${safe(record.requestedAmount)} ${safe(record.currency)}`,`Last successful check: ${safe(record.checkedAt)}`,
  `My payment status: ${plan.sent==='yes'?'Sent or scheduled':plan.sent==='no'?'Not sent or scheduled':'Unsure'} (self-reported; does not change verification)`,
  ...plan.steps.map(s=>`${s.label}: ${s.status}`),`Next step: ${plan.action}`,plan.reminder].join('\n');
}
