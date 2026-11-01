// Presentation groups over saved record statuses. No payment-state changes.
export function matchesPaymentStatus(record,status='all'){
 if(status==='all')return true;
 if(status==='in_progress')return !['received','ended'].includes(record.code);
 return record.code===status;
}
export function paymentTone(record){
 if(record.simulated)return 'simulation';
 if(record.code==='disputed'||record.code==='review'||record.code==='uncertain')return 'attention';
 if(record.deliveryConfirmed&&record.code==='received')return 'received';
 return 'pending';
}
const positive=v=>typeof v==='string'&&/^\d+(\.\d+)?$/.test(v)&&Number(v)>0;
export function paymentMilestones(record){
 return [
  {label:'Request saved',confirmed:!!record.id,detail:record.createdAt??null},
  {label:'Payment confirmed by Peer',confirmed:record.providerFulfilled===true,detail:record.providerFulfilled?'Confirmed':positive(record.netUsdc)?'Payment recorded · full confirmation pending':'Not yet confirmed'},
  {label:'USDC received on Base',confirmed:record.deliveryConfirmed===true,detail:record.deliveryConfirmed?'Wallet delivery confirmed':positive(record.confirmedUsdc)?'Arrival recorded; full confirmation pending':'Not yet confirmed'}
 ];
}
