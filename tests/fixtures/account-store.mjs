import {randomUUID} from 'node:crypto';
import {afterEach, after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {createStore} from '../../hosted/db.mjs';
// Every fixture is closed when the test that made it finishes, whether or not the test remembered to. An open pool or embedded database
// would otherwise keep the process alive and its memory held until the whole file ends (slow, and heavy on a small machine).
const openFixtures = new Set();
const closeAll = async () => { for (const f of [...openFixtures]) await f.close().catch(() => {}); };
afterEach(closeAll); after(closeAll);
export async function fixture(){
 const f = await makeFixture(); openFixtures.add(f);
 const close = f.close; f.close = async () => { if (!openFixtures.delete(f)) return; await close(); };
 return f;
}
async function makeFixture(){
 if(process.env.TEST_DATABASE_URL){
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});const schema='test_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:8});
  const store=createStore(pool);await store.migrate();return {store,pool,close:async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
 }
 const db=new PGlite();let tail=Promise.resolve();
 async function connect(){let release;const old=tail;tail=new Promise(r=>release=r);await old;return {query:async(sql,args=[])=>sql.includes('CREATE TABLE')?(await db.exec(sql)).at(-1):db.query(sql,args),release};}
 const pool={connect,query:async(sql,args)=>{const c=await connect();try{return await c.query(sql,args);}finally{c.release();}},end:()=>db.close()};const store=createStore(pool);await store.migrate();return {store,pool,close:()=>pool.end()};
}
