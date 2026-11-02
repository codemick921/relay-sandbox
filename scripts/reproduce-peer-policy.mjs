// Offline only. Inputs are public pinned artifacts, compiler and RPC observations.
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {compilerInput,verifyCompiler,verifyPolicyReproduction} from './policy-reproduction.mjs';
const [artifactPath,compilerPath,observationsPath,outPath]=process.argv.slice(2);
if(!outPath)throw Error('Usage: node scripts/reproduce-peer-policy.mjs artifact.json soljson.js observations.json report.json');
const artifact=JSON.parse(readFileSync(artifactPath,'utf8'));
verifyCompiler(readFileSync(compilerPath));
const solc=createRequire(import.meta.url)(resolve(compilerPath));
const output=JSON.parse(solc.cwrap('solidity_compile','string',['string','number','number'])(JSON.stringify(compilerInput(artifact)),0,0));
const result=verifyPolicyReproduction({artifact,output,observations:JSON.parse(readFileSync(observationsPath,'utf8'))});
writeFileSync(outPath,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
