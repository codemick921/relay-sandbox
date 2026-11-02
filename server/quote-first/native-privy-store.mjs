import {NativeError} from './native-privy.mjs';
const need=rows=>{if(rows.length!==1)throw new NativeError('intent_expired');return rows[0];};
export function createNativePrivyStore(db){
 return {
  async link(appId,owner){const {rows}=await db.query('SELECT did, sid_hash AS "sidHash", fingerprint FROM eupova_native_auth.links WHERE app_id=$1 AND owner=$2',[appId,owner]);return rows[0]??null;},
  async begin(v){await db.query(`INSERT INTO eupova_native_auth.intents(app_id,owner,binding,nonce_hash,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0))`,[v.appId,v.owner,v.binding,v.nonceHash,v.expiresAt]);},
  async review(v){need((await db.query(`UPDATE eupova_native_auth.intents SET did=$5,sid_hash=$6,fingerprint=$7,address=$8 WHERE app_id=$1 AND owner=$2 AND binding=$3 AND nonce_hash=$4 AND consumed_at IS NULL AND expires_at>clock_timestamp() AND (did IS NULL OR (did=$5 AND sid_hash=$6 AND fingerprint=$7)) RETURNING nonce_hash`,[v.appId,v.owner,v.binding,v.nonceHash,v.did,v.sidHash,v.fingerprint,v.address])).rows);},
  async confirm(v){return db.transaction(async client=>{
   need((await client.query(`UPDATE eupova_native_auth.intents SET consumed_at=clock_timestamp() WHERE app_id=$1 AND owner=$2 AND binding=$3 AND nonce_hash=$4 AND did=$5 AND sid_hash=$6 AND fingerprint=$7 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING nonce_hash`,[v.appId,v.owner,v.binding,v.nonceHash,v.did,v.sidHash,v.fingerprint])).rows);
   await v.recheck();
   await client.query(`INSERT INTO eupova_native_auth.links(app_id,owner,did,sid_hash,fingerprint,address,consent_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[v.appId,v.owner,v.did,v.sidHash,v.fingerprint,v.address,v.consentVersion]);
   const row=need((await client.query('SELECT did,fingerprint FROM eupova_native_auth.links WHERE app_id=$1 AND owner=$2',[v.appId,v.owner])).rows);
   if(row.did!==v.did||row.fingerprint!==v.fingerprint)throw new NativeError('identity_conflict');
   await v.recheck();
  });}
 };
}
