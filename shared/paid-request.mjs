// Saved settlement evidence is payment evidence, not proof of wallet delivery.
export function hasRecordedPayment(order){
 return order?.verification?.providerFulfilled===true && Array.isArray(order.verification.payments) &&
  order.verification.payments?.some(p=>p.status==='SETTLED'&&typeof p.amountRaw==='string'&&/^[0-9]{1,16}$/.test(p.amountRaw)&&BigInt(p.amountRaw)>0n)===true;
}
