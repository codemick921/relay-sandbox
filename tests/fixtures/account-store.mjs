import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {createStore} from '../../hosted/db.mjs';
export async function fixture(){
 if(process.env.TEST_DATABASE_URL){
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});const schema='test_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:8});
  const store=createStore(pool);await store.migrate();return {store,pool,close:async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
 }
 const db=new PGlite();let tail=Promise.resolve();
 async function connect(){let release;const old=tail;tail=new Promise(r=>release=r);await old;return {query:async(sql,args=[])=>sql.includes('CREATE TABLE')?(await db.exec(sql)).at(-1):db.query(sql,args),release};}
 const pool={connect,query:async(sql,args)=>{const c=await connect();try{return await c.query(sql,args);}finally{c.release();}},end:()=>db.close()};const store=createStore(pool);await store.migrate();return {store,pool,close:()=>pool.end()};
}
