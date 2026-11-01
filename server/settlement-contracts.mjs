// Read-only receipt recognition. This does not change checkout routing or SDK signing.
// Pinned official deployment: zkp2p/zkp2p-contracts at 70b5414d6aaa417ba9a7dc38c8a2ddd7cc1826e8
// deployments/base/OrchestratorV4.json and outputs/orchestrator-v4-base.json.
export const SETTLEMENT_V4=Object.freeze({
 address:'0x74c55679268FAfB493864915aD16A320AB8c40Ba',
 deploymentBlock:53251271n,
 runtimeCodeHash:'0xa383cbe8591fb8724e6d6f26a6b7b568b780f51b66560bfadaa1d1b16f2e4bc8',
 abi:[{"anonymous": false, "inputs": [{"indexed": true, "internalType": "bytes32", "name": "intentHash", "type": "bytes32"}, {"indexed": true, "internalType": "address", "name": "fundsTransferredTo", "type": "address"}, {"indexed": false, "internalType": "uint256", "name": "amount", "type": "uint256"}, {"indexed": false, "internalType": "address", "name": "releasedBy", "type": "address"}], "name": "IntentFulfilled", "type": "event"}]
});
