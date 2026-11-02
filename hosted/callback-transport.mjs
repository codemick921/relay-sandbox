import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {InputError} from '../server/validation.mjs';
export function callbackUrl(value,allowed=[]){
 let u;try{u=new URL(value);}catch{throw new InputError('Use an approved HTTPS callback URL.');}
 if(typeof value!=='string'||value.length>1000||u.protocol!=='https:'||u.username||u.password||u.hash||u.search||u.port||isIP(u.hostname)||u.hostname.includes(':')||u.hostname.includes('[')||!allowed.includes(u.href))throw new InputError('Use an approved HTTPS callback URL.',403);
 return u;
}
// IPv4-only initially; fail closed on IPv6, mixed DNS, private, reserved and metadata ranges.
export function publicIpv4(ip){
 if(isIP(ip)!==4)return false;const [a,b,c]=ip.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
export const callbackSecret=(hash,id)=>createHmac('sha256',Buffer.from(hash,'hex')).update('eupova-callback-v1:'+id).digest('hex');
export const callbackSignature=(secret,timestamp,raw)=>createHmac('sha256',Buffer.from(secret,'hex')).update(timestamp+'.'+raw).digest('hex');
export function verifyCallback(secret,raw,header,now=Date.now()){
 const m=/^t=([0-9]{10}),v1=([a-f0-9]{64})$/.exec(header??'');
 if(!/^[a-f0-9]{64}$/.test(secret??'')||!m||Math.abs(now/1000-Number(m[1]))>300)return false;
 return timingSafeEqual(Buffer.from(m[2],'hex'),Buffer.from(callbackSignature(secret,m[1],raw),'hex'));
}
export async function deliverCallback(url,payload,secret,{allowed=[],resolve=lookup,request=https.request,now=Date.now()}={}){
 const u=callbackUrl(url,allowed);
 let timer;const addresses=await Promise.race([resolve(u.hostname,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('dns_timeout')),3000);})]).finally(()=>clearTimeout(timer));
 if(!addresses.length||addresses.some(a=>!publicIpv4(a.address)))throw Error('destination_blocked');
 const address=addresses[0].address,raw=JSON.stringify(payload),stamp=String(Math.floor(now/1000));
 return new Promise((resolve,reject)=>{
  // Pin validated DNS result, preserve TLS hostname validation, disable pooling and redirects.
  const req=request(u,{method:'POST',agent:false,lookup:(_host,options,cb)=>options.all?cb(null,[{address,family:4}]):cb(null,address,4),headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw),'eupova-signature':`t=${stamp},v1=${callbackSignature(secret,stamp,raw)}`,'eupova-event-id':payload.id,'user-agent':'Eupova-Callbacks/1'}},res=>{const code=res.statusCode;res.destroy();if(code>=200&&code<300)resolve();else reject(Error('http_'+code));});
  const timeout=setTimeout(()=>req.destroy(Error('delivery_timeout')),5000);req.on('error',reject);req.on('close',()=>clearTimeout(timeout));req.end(raw);
 });
}
