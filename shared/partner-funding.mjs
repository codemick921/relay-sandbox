const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function partnerReviewLink(origin,id){
 if(typeof id!=='string'||!uuid.test(id))throw Error('Invalid funding request ID.');
 const u=new URL(origin);
 if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Secure Eupova origin required.');
 return `${u.origin}/#request=${id}`;
}
export function fundingButtonMarkup(url){
 const u=new URL(url);
 if(u.username||u.password||u.origin!=='https://app.eupova.com'||u.pathname!=='/'||u.search||!/^#request=[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(u.hash))throw Error('Use the reviewUrl returned by Eupova.');
 return `<a href="${u.href}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;padding:14px 22px;border-radius:12px;background:#244f3e;color:#fff;font:600 16px/1.4 system-ui,sans-serif;text-decoration:none">Fund with Eupova</a>`;
}
// Operator-owned configuration only. Never accepts a return URL from a visitor or request body.
export function partnerDestinations(raw='{}'){
 let entries;try{entries=JSON.parse(raw);}catch{throw Error('Invalid partner return configuration.');}
 if(!entries||typeof entries!=='object'||Array.isArray(entries)||Object.keys(entries).length>100)throw Error('Invalid partner return configuration.');
 const result=Object.create(null);
 for(const [id,v] of Object.entries(entries)){
  if(!uuid.test(id)||!v||Object.keys(v).some(k=>!['name','url'].includes(k))||typeof v.name!=='string'||!v.name.trim()||v.name.length>60||/[\x00-\x1f\x7f]/.test(v.name)||typeof v.url!=='string'||v.url.length>500)throw Error('Invalid partner return configuration.');
  let u;try{u=new URL(v.url);}catch{throw Error('Invalid partner return URL.');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.href!==v.url||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(u.hostname)||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local')||u.hostname.endsWith('.internal')||u.hostname.endsWith('.test'))throw Error('Invalid partner return URL.');
  result[id]=Object.freeze({name:v.name.trim(),url:u.href});
 }
 return Object.freeze(result);
}
