import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {erc20Abi} from 'viem';
import {InputError,TOKEN} from '../server/validation.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const customer=owner=>{if(!/^customer:[a-f0-9-]{36}$/.test(owner))throw new InputError('Customer sign-in required.',403);};
export function parseUsdc(value){
 if(typeof value!=='string'||!/^\d{1,7}(\.\d{1,6})?$/.test(value))throw new InputError('Enter a USDC amount with up to six decimal places.');
 const [whole,part='']=value.split('.'),raw=BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0'));
 if(raw>1000000000000n)throw new InputError('Choose up to 1,000,000 USDC.');return String(raw);
}
export function createWalletBalances(base,{rpc,simulated=false,clock=Date.now}={}){
 if(!rpc)throw Error('A read-only Base client is required.');
 let running=null,stopping=false,timer=null;
 async function owned(owner,id){
  customer(owner);if(!uuid(id))throw new InputError('Wallet not found.',404);
  const r=await base.query("SELECT data FROM relay_agents WHERE owner=$1 AND id=$2 AND data->>'network'='Base' AND data->>'token'='USDC'",[owner,id]);
  if(!r.rows[0])throw new InputError('Wallet not found.',404);return r.rows[0].data;
 }
 async function enrol(owner){
  customer(owner);
  await base.query(`INSERT INTO relay_wallet_balances(agent_id,address_key) SELECT id,address_key FROM relay_agents WHERE owner=$1 AND data->>'network'='Base' AND data->>'token'='USDC' ON CONFLICT(agent_id) DO UPDATE SET address_key=excluded.address_key,amount_raw=NULL,block_number=NULL,observed_at=NULL,attempted_at=NULL,failed=false,lease_token=NULL,lease_until=NULL,next_check_at=now() WHERE relay_wallet_balances.address_key<>excluded.address_key`,[owner]);
 }
 async function claim(){return base.tx(async c=>{
  const r=await c.query(`SELECT b.* FROM relay_wallet_balances b JOIN relay_agents a ON a.id=b.agent_id AND a.address_key=b.address_key WHERE b.next_check_at<=now() AND (b.lease_until IS NULL OR b.lease_until<now()) ORDER BY b.next_check_at FOR UPDATE OF b SKIP LOCKED LIMIT 1`);
  if(!r.rows[0])return null;const row=r.rows[0],token=randomUUID();
  await c.query("UPDATE relay_wallet_balances SET lease_token=$2,lease_until=now()+interval '60 seconds',attempted_at=now(),next_check_at=now()+interval '60 seconds' WHERE agent_id=$1",[row.agent_id,token]);return {...row,lease_token:token};
 });}
 async function check(row){
  try{
   if(await rpc.getChainId()!==8453)throw Error('Wrong chain');
   const block=await rpc.getBlock({blockTag:'latest'});
   if(typeof block.number!=='bigint'||block.number<0n||typeof block.timestamp!=='bigint'||Math.abs(clock()/1000-Number(block.timestamp))>120)throw Error('Stale block');
   const amount=await rpc.readContract({address:TOKEN,abi:erc20Abi,functionName:'balanceOf',args:[row.address_key],blockNumber:block.number});
   if(typeof amount!=='bigint'||amount<0n||amount>2n**256n-1n)throw Error('Invalid balance');
   // Reject a provider which moved backwards, and fence late workers after lease recovery.
   const applied=await base.query(`UPDATE relay_wallet_balances SET amount_raw=$3,block_number=$4,observed_at=$5,failed=false,lease_token=NULL,lease_until=NULL WHERE agent_id=$1 AND lease_token=$2 AND address_key=$6 AND (block_number IS NULL OR block_number::numeric<=$4::numeric)`,[row.agent_id,row.lease_token,String(amount),String(block.number),new Date(clock()),row.address_key]);
   if(!applied.rowCount)throw Error('Superseded or backwards observation');
  }catch{
   await base.query('UPDATE relay_wallet_balances SET failed=true,lease_token=NULL,lease_until=NULL WHERE agent_id=$1 AND lease_token=$2',[row.agent_id,row.lease_token]);
  }
 }
 const service={
  simulated,
  async migrate(){await base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(431937)');await c.query(readFileSync(new URL('./wallet-balances.sql',import.meta.url),'utf8'));});},
  async state(owner){
   await enrol(owner);
   const rows=(await base.query('SELECT b.* FROM relay_wallet_balances b JOIN relay_agents a ON a.id=b.agent_id AND a.address_key=b.address_key WHERE a.owner=$1 ORDER BY a.created_at',[owner])).rows;
   return {simulated,chainId:8453,tokenAddress:TOKEN,refreshSeconds:60,wallets:rows.map(r=>{
    const fresh=!r.failed&&r.observed_at&&clock()-new Date(r.observed_at).getTime()<=180000;
    return {agentId:r.agent_id,amountRaw:r.amount_raw,blockNumber:r.block_number,observedAt:r.observed_at,attemptedAt:r.attempted_at,status:r.amount_raw===null?'unavailable':fresh?'fresh':'stale',refreshFailed:r.failed,alertsEnabled:r.alerts_enabled,thresholdRaw:r.threshold_raw,targetRaw:r.target_raw,lowBalance:fresh&&r.alerts_enabled?BigInt(r.amount_raw)<BigInt(r.threshold_raw):null};
   })};
  },
  async preferences(owner,input){
   if(!input||Object.keys(input).some(k=>!['agentId','enabled','threshold','target'].includes(k))||typeof input.enabled!=='boolean')throw new InputError('Check your wallet alert settings.');
   await owned(owner,input.agentId);const threshold=parseUsdc(input.threshold),target=parseUsdc(input.target);
   if(BigInt(target)<BigInt(threshold))throw new InputError('Your target must be at least your low-balance threshold.');
   await enrol(owner);await base.query('UPDATE relay_wallet_balances SET alerts_enabled=$3,threshold_raw=$4,target_raw=$5 WHERE agent_id=$1 AND EXISTS(SELECT 1 FROM relay_agents WHERE id=$1 AND owner=$2)',[input.agentId,owner,input.enabled,threshold,target]);
  },
  async refresh(owner,input){
   if(!input||Object.keys(input).some(k=>k!=='agentId'))throw new InputError('Choose a saved wallet.');await owned(owner,input.agentId);await enrol(owner);
   await base.query("UPDATE relay_wallet_balances SET next_check_at=now() WHERE agent_id=$1 AND (attempted_at IS NULL OR attempted_at<now()-interval '30 seconds') AND (lease_until IS NULL OR lease_until<now())",[input.agentId]);
  },
  async tick(){
   if(stopping||running)return running;
   running=(async()=>{for(let i=0;i<5&&!stopping;i++){const row=await claim();if(!row)break;await check(row);}})();
   try{await running;}finally{running=null;}
  },
  start(){if(timer||stopping)return;const loop=async()=>{try{await service.tick();}catch{console.error('Wallet balance check unavailable.');}if(!stopping)timer=setTimeout(loop,15000);};timer=setTimeout(loop,0);},
  async stop(){stopping=true;clearTimeout(timer);if(running)await running;}
 };
 return service;
}
