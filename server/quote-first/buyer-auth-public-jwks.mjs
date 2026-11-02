import {createPublicKey} from 'node:crypto';
import publishedKeys from './buyer-auth-public-jwks.json' with {type:'json'};

export const publicBuyerJwksPath='/.well-known/eupova-buyer-auth-jwks.json';
const publicFields=new Set(['kty','n','e','alg','use','kid']);

// Public verification material only. This module never reads a signing key,
// customer record, enrolment, session or auth flag, and cannot issue a token.
export function createPublicBuyerJwksHandler(jwks=publishedKeys){
 if(!jwks||Object.keys(jwks).length!==1||!Array.isArray(jwks.keys)||jwks.keys.length!==1)
  throw Error('Invalid public buyer JWKS');
 const key=jwks.keys[0];
 if(!key||Object.keys(key).length!==publicFields.size||Object.keys(key).some(k=>!publicFields.has(k))||
    key.kty!=='RSA'||key.alg!=='RS256'||key.use!=='sig'||typeof key.kid!=='string'||!/^eupova-dev-[a-zA-Z0-9-]{1,64}$/.test(key.kid)||
    ![key.n,key.e].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]+$/.test(v)))
  throw Error('Public RSA verification key required');
 const publicKey=createPublicKey({key,format:'jwk'});
 if(publicKey.asymmetricKeyType!=='rsa'||publicKey.asymmetricKeyDetails.modulusLength<2048)
  throw Error('Public RSA verification key too small');
 const payload=JSON.stringify({keys:[Object.fromEntries([...publicFields].map(k=>[k,key[k]]))]});
 return (req,res)=>{
  if(String(req.url??'').split('?')[0]!==publicBuyerJwksPath)return false;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.url!==publicBuyerJwksPath){res.writeHead(404);res.end(JSON.stringify({error:'not_found'}));return true;}
  if(!['GET','HEAD'].includes(req.method)){
   res.setHeader('Allow','GET, HEAD');res.writeHead(405);res.end(JSON.stringify({error:'method_not_allowed'}));return true;
  }
  res.setHeader('Content-Length',Buffer.byteLength(payload));
  res.writeHead(200);res.end(req.method==='HEAD'?undefined:payload);return true;
 };
}
export const handlePublicBuyerJwks=createPublicBuyerJwksHandler();
