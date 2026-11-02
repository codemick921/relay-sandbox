// Offline proof checker for the pinned public IntentSignalPolicy deployment.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {encodeAbiParameters,getContractAddress,keccak256,toBytes} from 'viem';
const fail=(ok,reason)=>{if(!ok)throw Error(reason);};
export const compilerSha256='d82bdcba2c386d60b33aca148a9cfdf097551f68c5e45d8ec01aebbafacf5075';
export const policySource='contracts/hooks/IntentSignalPolicy.sol';
export const policyName='IntentSignalPolicy';
export function compilerInput(artifact){
 const m=JSON.parse(artifact.metadata);
 fail(m.compiler.version==='0.8.18+commit.87f61d96','wrong_compiler');
 const {compilationTarget,...settings}=m.settings;
 fail(isDeepStrictEqual(compilationTarget,{[policySource]:policyName}),'wrong_target');
 const sources=Object.fromEntries(Object.entries(m.sources).map(([path,s])=>{
  fail(typeof s.content==='string'&&keccak256(toBytes(s.content))===s.keccak256,'source_hash_mismatch');
  return [path,{content:s.content}];
 }));
 return {language:m.language,sources,settings:{...settings,outputSelection:{'*':{'*':['abi','metadata','evm.bytecode','evm.deployedBytecode'],'':['ast']}}}};
}
export function verifyCompiler(bytes){
 fail(createHash('sha256').update(bytes).digest('hex')===compilerSha256,'compiler_checksum_mismatch');
}
export function verifyPolicyReproduction({artifact,output,observations}){
 compilerInput(artifact);
 fail(!output.errors?.some(e=>e.severity==='error'),'compilation_failed');
 const c=output.contracts?.[policySource]?.[policyName];
 fail(c&&'0x'+c.evm.bytecode.object===artifact.bytecode,'creation_bytecode_mismatch');
 fail(c.metadata===artifact.metadata&&isDeepStrictEqual(c.abi,artifact.abi),'metadata_or_abi_mismatch');
 fail('0x'+c.evm.deployedBytecode.object===artifact.deployedBytecode,'runtime_template_mismatch');
 fail(c.evm.bytecode.linkReferences&&Object.keys(c.evm.bytecode.linkReferences).length===0,'linked_libraries_not_supported');
 fail(Array.isArray(artifact.args)&&artifact.args.length===2&&artifact.args.every(a=>/^0x[0-9a-f]{40}$/i.test(a)),'invalid_constructor');
 const expected=new Map([['gatingService',artifact.args[0]],['whitelistPolicy',artifact.args[1]]]);
 const declarations=new Map();
 function walk(v){if(!v||typeof v!=='object')return;if(v.nodeType==='VariableDeclaration'&&v.mutability==='immutable')declarations.set(String(v.id),v.name);for(const x of Object.values(v))if(typeof x==='object')Array.isArray(x)?x.forEach(walk):walk(x);}
 walk(output.sources?.[policySource]?.ast);
 let runtime=c.evm.deployedBytecode.object;
 const used=new Set(),ranges=[];
 for(const [id,refs] of Object.entries(c.evm.deployedBytecode.immutableReferences)){
  const name=declarations.get(id),address=expected.get(name);
  fail(address&&Array.isArray(refs)&&refs.length>0,'unknown_immutable');used.add(name);
  for(const {start,length}of refs){
   fail(Number.isSafeInteger(start)&&start>=0&&length===32&&(start+length)*2<=runtime.length,'invalid_immutable_reference');
   fail(!ranges.some(([a,b])=>start<b&&start+length>a),'overlapping_immutable_reference');ranges.push([start,start+length]);
   fail(/^0+$/.test(runtime.slice(start*2,(start+length)*2)),'nonzero_immutable_template');
   runtime=runtime.slice(0,start*2)+address.slice(2).toLowerCase().padStart(64,'0')+runtime.slice((start+length)*2);
  }
 }
 fail(used.size===expected.size,'missing_immutable');
 const endpoints=['https://mainnet.base.org/','https://base-rpc.publicnode.com/'];
 fail(Array.isArray(observations)&&observations.length===2&&new Set(observations.map(o=>o.endpoint)).size===2,'missing_corroboration');
 const creation=artifact.bytecode+encodeAbiParameters([{type:'address'},{type:'address'}],artifact.args).slice(2);
 for(const o of observations){
  const t=o.transaction,r=o.receipt,b=o.block;
  fail(endpoints.includes(o.endpoint)&&o.chainId==='0x2105','wrong_chain_or_source');
  fail(t&&r&&b&&t.hash===artifact.transactionHash&&r.transactionHash===t.hash&&r.status==='0x1'&&t.to===null,'deployment_not_successful');
  fail(t.blockHash===r.blockHash&&r.blockHash===b.hash&&t.blockNumber===r.blockNumber&&r.blockNumber===b.number,'deployment_block_mismatch');
  fail(getContractAddress({from:t.from,nonce:BigInt(t.nonce)}).toLowerCase()===artifact.address.toLowerCase()&&r.contractAddress.toLowerCase()===artifact.address.toLowerCase(),'deployment_address_mismatch');
  fail(t.input.toLowerCase()===creation.toLowerCase(),'deployment_input_mismatch');
  fail(o.runtime.toLowerCase()==='0x'+runtime,'deployed_runtime_mismatch');
 }
 fail(observations[0].block.hash===observations[1].block.hash,'deployment_source_disagreement');
 return {status:'local_reproduction_match',sourceVerification:'recompiled_creation_and_runtime',compiler:'0.8.18+commit.87f61d96',compilerSha256,
  address:artifact.address.toLowerCase(),deploymentTransaction:artifact.transactionHash,deploymentBlock:Number(BigInt(observations[0].block.number)),deploymentBlockHash:observations[0].block.hash,
  runtimeCodeHash:keccak256('0x'+runtime),creationCodeHash:keccak256(artifact.bytecode),sourceCount:Object.keys(JSON.parse(artifact.metadata).sources).length,
  constructorAddresses:Object.fromEntries([...expected].map(([name,address])=>[name,address.toLowerCase()])),sources:endpoints,independentExplorerVerification:false,canExecute:false};
}
