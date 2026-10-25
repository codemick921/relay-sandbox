// Pure projections of saved evidence. No provider calls, timers or payment writes.
const time=v=>v&&(typeof v==='string'||v instanceof Date)&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
export function paymentAttemptState(order,now=Date.now()){
 const v=order?.verification,payments=Array.isArray(v?.payments)?v.payments:[];
 if(!order||order.status!=='checkout_ready'||order.reviewRequired||v?.providerFulfilled||payments.some(p=>p?.status==='SETTLED'))return null;
 const current=v?.currentAttempt;
 if(current&&payments.some(p=>p.id===current.id&&p.status===current.status)){
  if(current.status==='EXPIRED')return 'expired';
  if(current.status==='CREATED'&&time(current.quoteExpiresAt)!==null&&time(current.quoteExpiresAt)<=now)return 'quote_elapsed';
  return null;
 }
 return payments.length>0&&payments.every(p=>p?.status==='EXPIRED')?'expired':null;
}
export function trackingState(order,now=Date.now()){
 if(!order)return null;
 const checked=time(order.checkedAt??order.verification?.checkedAt),next=time(order.trackingSchedule?.nextCheckAt);
 const terminal=['checkout_received','checkout_cancelled'].includes(order.status);
 const code=order.reviewRequired||order.status==='checkout_review'?'review':order.trackingError?'retrying':
  next!==null&&now-next>300000?'overdue':order.trackingPending===true?'evidence_pending':
  !terminal&&checked!==null&&(now-checked>900000||checked>now+5000)?'stale':checked===null?'waiting':'current';
 return {code,checkedAt:checked===null?null:new Date(checked).toISOString(),lastAttemptAt:time(order.trackingAttemptedAt)===null?null:new Date(order.trackingAttemptedAt).toISOString(),nextCheckAt:next===null?null:new Date(next).toISOString()};
}
export const trackingMessages={
 review:'Payment details need review. Do not send another payment to resolve this status.',
 retrying:'The latest check could not complete. Eupova has kept the last saved payment result and will retry. This does not mean your payment failed.',
 overdue:'The next tracking check is overdue. The payment result below may be out of date. If you have paid, keep your confirmation and do not pay again.',
 evidence_pending:'Eupova is still waiting for payment or network records. It will check again. A delay does not mean the payment failed.',
 stale:'The last successful check is over 15 minutes old or its timestamp needs checking. If you have paid, keep your confirmation and do not pay again.',
 waiting:'Eupova has not completed its first successful check. This does not confirm whether you have paid.'
};
export const attemptMessage=state=>(state==='quote_elapsed'?'The saved quote has expired.':'The previous payment attempt has expired.')+' Do not pay its old instructions. Expiry does not cancel the checkout, prove that a bank transfer failed or confirm a refund. If you already paid, keep tracking this request for late funds.';
