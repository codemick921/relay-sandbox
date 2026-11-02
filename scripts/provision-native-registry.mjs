// Explicit one-off operation, never imported by app startup.
// Secrets stay in process environment and parameter/literal handling; output is booleans only.
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {nativeRegistryRole,nativeRegistryConnection} from '../server/quote-first/native-privy-database.mjs';
const required=(v,message)=>{if(!v)throw Error(message);};
export async function provisionNativeRegistry({env=process.env,Client=pg.Client}={}){
 required(env.EUPOVA_PRIVY_NATIVE_ENABLED!=='true','disable_native_before_provision');
 required(/^[a-f0-9]{64}$/.test(env.EUPOVA_PRIVY_NATIVE_DB_PASSWORD??''),'native_registry_credentials_required');
 const target=new URL(nativeRegistryConnection({...env,EUPOVA_PRIVY_NATIVE_DATABASE_URL:undefined}));
 const admin=new Client({connectionString:env.DATABASE_URL,statement_timeout:10000});
 let runtime,tx=false;
 try{
  await admin.connect();await admin.query('BEGIN');tx=true;
  await admin.query("SET LOCAL lock_timeout='3s'");
  // Serialize provisioning, including a retry after a lost commit acknowledgement.
  await admin.query("SELECT pg_advisory_xact_lock(hashtext('eupova-native-registry-provision-v1'))");
  const existing=await admin.query('SELECT rolname FROM pg_roles WHERE rolname=$1',[nativeRegistryRole]);
  if(!existing.rows.length){
   // Hex-only generated password and constant role name are validated before SQL.
   await admin.query(`CREATE ROLE ${nativeRegistryRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD '${env.EUPOVA_PRIVY_NATIVE_DB_PASSWORD}'`);
  }
  const role=(await admin.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1',[nativeRegistryRole])).rows[0];
  required(role&&!role.rolsuper&&!role.rolcreatedb&&!role.rolcreaterole&&!role.rolinherit&&!role.rolreplication&&!role.rolbypassrls&&role.rolcanlogin,'unexpected_role_permissions');
  required((await admin.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',[nativeRegistryRole])).rows.length===0,'unexpected_role_membership');
  // Refuse broad access rather than modifying other schemas or PUBLIC privileges.
  const outside=await admin.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','eupova_native_auth') AND c.relkind IN ('r','p','v','m','S','f') AND (CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE') ELSE has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END) LIMIT 1`,[nativeRegistryRole]);
  required(outside.rows.length===0,'runtime_has_unrelated_data_access');
  const creators=await admin.query(`SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' AND has_schema_privilege($1,oid,'CREATE') LIMIT 1`,[nativeRegistryRole]);
  required(creators.rows.length===0,'runtime_has_schema_create');
  const definers=await admin.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','eupova_native_auth') AND has_schema_privilege($1,n.oid,'USAGE') AND has_function_privilege($1,p.oid,'EXECUTE') LIMIT 1`,[nativeRegistryRole]);
  required(definers.rows.length===0,'runtime_has_unrelated_definer_access');
  const sql=(await readFile(new URL('../migrations/manual/native-privy-links.sql',import.meta.url),'utf8')).replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'');
  await admin.query(sql);
  await admin.query(`GRANT USAGE ON SCHEMA eupova_native_auth TO ${nativeRegistryRole}; GRANT SELECT,INSERT ON eupova_native_auth.links TO ${nativeRegistryRole}; GRANT SELECT,INSERT ON eupova_native_auth.intents TO ${nativeRegistryRole}; GRANT UPDATE(did,sid_hash,fingerprint,address,consumed_at) ON eupova_native_auth.intents TO ${nativeRegistryRole}`);
  const forbidden=(await admin.query(`SELECT has_schema_privilege($1,'eupova_native_auth','CREATE') OR has_table_privilege($1,'eupova_native_auth.links','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege($1,'eupova_native_auth.intents','DELETE,TRUNCATE,REFERENCES,TRIGGER') AS forbidden`,[nativeRegistryRole])).rows[0];
  required(forbidden?.forbidden===false,'registry_permissions_too_broad');
  await admin.query('COMMIT');tx=false;
  runtime=new Client({connectionString:target.href,statement_timeout:5000});await runtime.connect();
  await runtime.query('SELECT 1 FROM eupova_native_auth.links LIMIT 0');await runtime.query('SELECT 1 FROM eupova_native_auth.intents LIMIT 0');
  return {schemaReady:true,dedicatedRole:true,unrelatedDataAccess:false,customerRowsChanged:false,runtimeConnection:true};
 }finally{if(tx)await admin.query('ROLLBACK').catch(()=>{});await runtime?.end().catch(()=>{});await admin.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 provisionNativeRegistry().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({ok:false,code:/^[a-z_]{1,70}$/.test(e.message)?e.message:'provision_failed',sqlState:/^[A-Z0-9]{5}$/.test(e.code??'')?e.code:undefined}));process.exitCode=1;});
}
