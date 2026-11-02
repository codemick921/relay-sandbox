import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/policy-reproduction.json' with {type:'json'};
import {compilerInput,verifyCompiler,verifyPolicyReproduction,policySource,policyName} from '../scripts/policy-reproduction.mjs';
test('recompiled policy creation, constructor and runtime agree with both public deployment observations',()=>{
 const r=verifyPolicyReproduction(fixture);assert.equal(r.status,'local_reproduction_match');assert.equal(r.sourceCount,14);assert.equal(r.deploymentBlock,53251261);assert.equal(r.canExecute,false);assert.equal(r.independentExplorerVerification,false);
});
test('source, compiler, ABI and runtime changes cannot be labelled a reproduction match',()=>{
 const edits=[f=>{const m=JSON.parse(f.artifact.metadata);m.sources[policySource].content+=' ';f.artifact.metadata=JSON.stringify(m);},f=>f.output.contracts[policySource][policyName].evm.bytecode.object+='00',f=>f.output.contracts[policySource][policyName].abi=[],f=>f.output.contracts[policySource][policyName].evm.deployedBytecode.object+='00',f=>f.artifact.args[0]='0x'+'a'.repeat(40),f=>f.observations[0].transaction.input+='00',f=>f.observations[0].runtime+='00',f=>f.observations[0].receipt.status='0x0',f=>f.observations[0].block.hash='0x'+'0'.repeat(64),f=>f.observations[0].transaction.from='0x'+'b'.repeat(40),f=>f.observations[0].chainId='0x1',f=>f.observations.pop()];
 for(const edit of edits){const f=structuredClone(fixture);edit(f);assert.throws(()=>verifyPolicyReproduction(f));}
 assert.throws(()=>verifyCompiler(Buffer.from('not the compiler')),/compiler_checksum_mismatch/);
 const input=compilerInput(fixture.artifact);assert.equal(input.settings.compilationTarget,undefined);assert.equal(Object.keys(input.sources).length,14);
});
