import pg from 'pg';
export function createRestrictedSetupDatabase(connectionString,{Pool=pg.Pool}={}){
 if(typeof connectionString!=='string'||!/^postgres(?:ql)?:\/\//.test(connectionString))throw Error('wallet_setup_storage_unavailable');
 const pool=new Pool({connectionString,max:2,connectionTimeoutMillis:4000,idleTimeoutMillis:10000});
 pool.on?.('error',()=>{}); // Do not log connection credentials.
 return {query:(...args)=>pool.query(...args),async tx(work){
  const client=await pool.connect();let failed=false;
  try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
  catch(error){failed=true;await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release(failed);}
 },close:()=>pool.end()};
}
