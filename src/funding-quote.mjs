// Exact arithmetic for the explicitly synthetic quote. Never a live pricing adapter.
const decimal=v=>typeof v==='string'&&/^\d{1,12}(\.\d{1,6})?$/.test(v)?BigInt(v.split('.')[0])*1000000n+BigInt((v.split('.')[1]??'').padEnd(6,'0')):null;
const show=v=>`${v/1000000n}.${String(v%1000000n).padStart(6,'0')}`;
export function exampleCostQuote(quote,{simulated=false,requestedPence,currency='GBP',now=Date.now()}={}){
 if(!simulated||quote?.simulated!==true||currency!=='GBP'||quote.pence!==requestedPence||!Number.isSafeInteger(quote.pence)||quote.pence<=0||quote.network!=='Base'||quote.token!=='USDC')return null;
 const gross=decimal(quote.grossUsdc),fee=decimal(quote.feeUsdc),net=decimal(quote.netUsdc);
 const expires=Date.parse(quote.expiresAt);
 if(gross===null||fee===null||net===null||net<=0n||gross!==fee+net||!Number.isFinite(expires))return null;
 return {gross:show(gross),fee:show(fee),net:show(net),expired:expires<=now,expiresAt:quote.expiresAt,
  // The demo deliberately assumes no other charges, not that real providers charge zero.
  totalMinor:quote.pence,rate:show(gross*100n/BigInt(quote.pence)),effectiveRate:show(net*100n/BigInt(quote.pence))};
}
