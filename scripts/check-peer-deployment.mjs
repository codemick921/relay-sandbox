// Explicit on-demand public RPC check. Does not load .env, account storage or a signer.
import {checkPeerDeployment} from '../server/quote-first/deployment-readiness.mjs';
const result=await checkPeerDeployment();
console.log(JSON.stringify(result,null,2));
process.exitCode=result.status==='matches_snapshot'?0:1;
