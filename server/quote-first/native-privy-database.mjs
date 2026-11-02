// Dedicated registry credentials; never return or log this connection string.
export const nativeRegistryRole='eupova_native_auth_runtime';
export function nativeRegistryConnection(env){
 if(env.EUPOVA_PRIVY_NATIVE_DATABASE_URL)return env.EUPOVA_PRIVY_NATIVE_DATABASE_URL;
 const password=env.EUPOVA_PRIVY_NATIVE_DB_PASSWORD;
 if(typeof password!=='string'||!/^[a-f0-9]{64}$/.test(password))throw Error('native_registry_credentials_required');
 const u=new URL(env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(u.protocol)||!u.hostname||!u.pathname||u.pathname==='/')throw Error('native_registry_database_required');
 u.username=nativeRegistryRole;u.password=password;return u.href;
}
