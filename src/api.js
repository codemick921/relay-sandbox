import {fundingCatalog} from '../shared/fiat.mjs';
export {formatFiat} from '../shared/fiat.mjs';
export async function api(path,body){const r=await fetch('/api/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();if(!r.ok){const e=new Error(d.error??'The request failed.');e.status=r.status;if(r.status===401&&path!=='login'&&!path.startsWith('account/'))window.dispatchEvent(new Event('relay-session-expired'));throw e;}return d;}
export const gbp=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(n/100);
export const short=a=>a.slice(0,8)+'…'+a.slice(-6);
export const labels={offer_selected:'Example offer selected',payment_sent:'Example payment sent',payment_verified:'Example payment verified',delivered:'Example USDC delivered',handoff_prepared:'Peer handoff prepared · outcome unknown'};
export const platformNames={...Object.fromEntries(fundingCatalog.methods.map(m=>[m.id,m.label])),ramp:'Ramp preview',revolut:'Revolut',wise:'Wise',monzo:'Monzo'};
