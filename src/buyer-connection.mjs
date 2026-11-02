// A browser receives no identity, signing key or JWT from the status route.
export function validBuyerConnectionStatus(value,now=Date.now()){
 return !!value&&value.visible===true&&value.environment==='development'&&value.connection==='disabled'&&value.tokenIssuanceEnabled===false&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>now&&value.expiresAt<=now+86400000;
}
export async function readBuyerConnectionStatus({signal}={}){
 const res=await fetch('/api/buyer-auth/status',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 if(res.status===404||res.status===401||res.status===403)return null;
 if(!res.ok)throw Error('status_unavailable');
 const value=await res.json();
 if(!validBuyerConnectionStatus(value))throw Error('invalid_status');
 return value;
}
