import {randomUUID} from 'node:crypto';
import {encodeEventTopics,encodeAbiParameters,erc20Abi} from 'viem';
import {InputError,pence,TOKEN,address} from '../server/validation.mjs';
import {verifyRampDelivery,rampQuoteRequest} from '../server/ramp.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const customer=owner=>{if(!/^customer:/.test(owner))throw new InputError('Customer sign-in required.',403);};
const view=r=>({id:r.id,kind:'ramp',provider:'ramp',fixture:true,source:'simulation',agent:r.agent,quote:{pence:r.pence,platform:'ramp'},status:r.result.status??'waiting',stage:r.stage,cryptoAmount:r.expected_raw,feePence:r.fee_pence,createdAt:r.created_at,delivery:r.result.delivery??null,simulated:true});
export function createRampSimulation(base){
 async function owned(c,owner,id){customer(owner);if(!uuid(id))throw new InputError('Ramp test not found.',404);const r=(await c.query('SELECT * FROM relay_ramp_simulations WHERE owner=$1 AND id=$2 FOR UPDATE',[owner,id])).rows[0];if(!r)throw new InputError('Ramp test not found.',404);return r;}
 return Object.freeze({simulated:true,
  async migrate(){await base.query(`CREATE TABLE IF NOT EXISTS relay_ramp_simulations(id uuid PRIMARY KEY,owner text NOT NULL,request_id uuid NOT NULL,agent jsonb NOT NULL,pence integer NOT NULL CHECK(pence BETWEEN 200 AND 100000),expected_raw text NOT NULL,fee_pence integer NOT NULL,stage integer NOT NULL DEFAULT 0 CHECK(stage BETWEEN 0 AND 3),result jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner,request_id))`);},
  async state(owner){customer(owner);return (await base.query('SELECT * FROM relay_ramp_simulations WHERE owner=$1 ORDER BY created_at DESC LIMIT 100',[owner])).rows.map(view);},
  async create(owner,input){customer(owner);if(!input||Object.keys(input).some(k=>!['requestId','agentId','amount','confirm'].includes(k))||!uuid(input.requestId)||!uuid(input.agentId)||input.confirm!==true)throw new InputError('Review the test amount and saved wallet.');const amount=pence(input.amount);rampQuoteRequest(input.amount);
   return base.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['ramp:'+owner]);
    const old=(await c.query('SELECT * FROM relay_ramp_simulations WHERE owner=$1 AND request_id=$2',[owner,input.requestId])).rows[0];if(old){if(old.pence!==amount||old.agent.id!==input.agentId)throw new InputError('Test request differs.',409);return {id:old.id};}
    const agent=(await c.query('SELECT data FROM relay_agents WHERE owner=$1 AND id=$2 FOR SHARE',[owner,input.agentId])).rows[0]?.data;if(!agent||agent.network!=='Base'||agent.token!=='USDC')throw new InputError('Choose your saved Base USDC wallet.');address(agent.address);
    if(Number((await c.query('SELECT count(*) FROM relay_ramp_simulations WHERE owner=$1',[owner])).rows[0].count)>=100)throw new InputError('Test history limit reached.',409);
    const id=randomUUID(),fee=Math.max(1,Math.round(amount*.02)),net=String(BigInt(amount-fee)*12500n);
    await c.query('INSERT INTO relay_ramp_simulations(id,owner,request_id,agent,pence,expected_raw,fee_pence) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,owner,input.requestId,agent,amount,net,fee]);return {id};
   });
  },
  async advance(owner,input){if(!input||Object.keys(input).some(k=>!['id','stage'].includes(k))||!Number.isInteger(input.stage))throw new InputError('Invalid test step.');return base.tx(async c=>{const r=await owned(c,owner,input.id);if(input.stage!==r.stage||r.stage===3)return {id:r.id};
   const stage=r.stage+1,tx='0x'+r.id.replaceAll('-','').repeat(2),blockHash='0x'+'aa'.repeat(32),expected={purchaseId:r.id,recipient:r.agent.address,pence:r.pence,cryptoAmount:r.expected_raw};
   const purchase={id:r.id,status:stage===1?'FIAT_RECEIVED':'RELEASED',fiatValue:r.pence/100,fiatCurrency:'GBP',receiverAddress:r.agent.address,asset:{chain:'BASE',symbol:'USDC',address:TOKEN,decimals:6},cryptoAmount:r.expected_raw,appliedFee:r.fee_pence/100,paymentMethodType:'MANUAL_BANK_TRANSFER',finalTxHash:tx};
   const receipt={status:'success',transactionHash:tx,blockHash,blockNumber:120n,logs:[{address:TOKEN,topics:encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:'0x3333333333333333333333333333333333333333',to:r.agent.address}}),data:encodeAbiParameters([{type:'uint256'}],[BigInt(r.expected_raw)])}]};
   const rpc={getChainId:async()=>8453,getTransactionReceipt:async()=>receipt,getBlock:async({blockTag})=>({hash:blockHash,number:blockTag==='finalized'&&stage===2?119n:120n})};
   const result=await verifyRampDelivery(purchase,expected,rpc);await c.query('UPDATE relay_ramp_simulations SET stage=$2,result=$3 WHERE id=$1',[r.id,stage,result]);return {id:r.id};
  });}
 });
}
