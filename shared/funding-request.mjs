// Exact decimal targets. A target is a user's goal, never a quote or payment authority.
export function targetRaw(value){
 if(typeof value!=='string'||!/^\d{1,6}(\.\d{1,6})?$/.test(value))return null;
 const [whole,fraction='']=value.split('.'),n=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
 return n>0n&&n<=100000000000n?String(n):null;
}
export function targetUnits(raw){const s=String(raw).padStart(7,'0');return (s.slice(0,-6)+'.'+s.slice(-6)).replace(/\.?0+$/,'');}
export function requestState(request,agent,now=Date.now()){
 if(request.draftId)return 'linked';
 if(request.connectionAvailable===false)return 'connection_unavailable';
 if(request.cancelledAt)return 'cancelled';
 if(!Number.isFinite(Date.parse(request.expiresAt))||Date.parse(request.expiresAt)<=now)return 'expired';
 if(request.walletCurrent===false||!agent||agent.id!==request.agent.id||agent.address.toLowerCase()!==request.agent.address.toLowerCase()||agent.network!==request.agent.network||agent.token!==request.agent.token||agent.revision!==undefined&&String(agent.revision)!==String(request.walletRevision))return 'wallet_changed';
 return 'open';
}
export function compareTarget(target,amount){
 if(!/^\d{1,18}$/.test(target??'')||!/^\d{1,24}$/.test(amount??'')||BigInt(target)<=0n)return null;
 const difference=BigInt(amount)-BigInt(target);
 return {met:difference>=0n,differenceRaw:String(difference),shortfall:targetUnits(String(difference<0n?-difference:0n))};
}
