import {supportsFunding} from '../shared/fiat.mjs';
// USDC uses six decimals. Keep money as integer strings across the API boundary.
export function formatUsdc(raw){
 if(typeof raw!=='string'||!/^\d+$/.test(raw))return 'Unavailable';
 const n=BigInt(raw),fraction=String(n%1000000n).padStart(6,'0').replace(/0+$/,'');
 return (n/1000000n).toLocaleString('en-GB')+(fraction?'.'+fraction:'.00');
}
export function inputUsdc(raw){
 const n=BigInt(raw);return String(n/1000000n)+'.'+String(n%1000000n).padStart(6,'0').replace(/0+$/,'').padEnd(2,'0');
}
export function walletShortfall(wallet){
 if(!wallet||wallet.status!=='fresh')return null;
 return String(BigInt(wallet.targetRaw)>BigInt(wallet.amountRaw)?BigInt(wallet.targetRaw)-BigInt(wallet.amountRaw):0n);
}
export function totalWalletBalance(wallets){
 // Never present a partial/old aggregate as a current total.
 if(!wallets.length||wallets.some(w=>w.status!=='fresh'))return null;
 return String(wallets.reduce((n,w)=>n+BigInt(w.amountRaw),0n));
}
export function repeatFunding(order,agents){
 if(order?.source!=='live'||order.kind!=='checkout'||order.status!=='checkout_received'||order.fixture||order.journey||!order.delivery?.finalized)return null;
 const agent=agents.find(a=>a.id===order.agent?.id&&a.address.toLowerCase()===order.agent?.address?.toLowerCase()&&a.network==='Base'&&a.token==='USDC');
 if(!agent||!Number.isSafeInteger(order.quote?.pence)||order.quote.pence<1||order.quote.pence>100000||!supportsFunding(order.quote.platform,order.quote.currency??'GBP'))return null;
 return {agentId:agent.id,amount:(order.quote.pence/100).toFixed(2),rail:order.quote.platform,...order.quote.currency!==undefined?{currency:order.quote.currency}:{}};
}

export function visibleWallet(wallet,now=Date.now()){
 if(wallet.status==='fresh'&&(!wallet.observedAt||!Number.isFinite(Date.parse(wallet.observedAt))||now-Date.parse(wallet.observedAt)>180000))return {...wallet,status:'stale',lowBalance:null};
 return wallet;
}
