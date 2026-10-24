// Separate, non-spending visual QA server. Never used by npm start.
import {createApp} from '../server/index.mjs';
import {ORCHESTRATOR,ESCROW} from '../server/live.mjs';
import {TOKEN} from '../server/peer.mjs';
const address='0x1111111111111111111111111111111111111111',payer='0x2222222222222222222222222222222222222222';
const hash='0x'+'ab'.repeat(32),future=new Date(Date.now()+3600000).toISOString();
const agent={id:'fixture-agent',name:'Research assistant · example',address,network:'Base',token:'USDC'};
const quote={payer,recipient:address,pence:1000,platform:'revolut',expiresAt:future,offers:[{id:'0',output:'12.000000',fee:'0.12 USDC'}]};
const template={kind:'native',source:'live',fixture:true,quote,agent,offerId:'0',tx:{expiresAt:future,to:ORCHESTRATOR.address,data:'0x',value:'0',chainId:8453},execution:{recipient:'example-seller',net:'12000000',params:{escrowAddress:ESCROW}},events:[],expiresAt:future};
const checkout={kind:'checkout',source:'live',fixture:true,agent,quote:{pence:2500,platform:'wise'},providerOrderId:'example-order',checkedAt:new Date().toISOString(),events:[]};
const receipt={amountRaw:'12000000',transactionHash:hash,recipient:address,tokenAddress:TOKEN,chainId:8453,blockNumber:'123456',finalized:true};
const verified={environment:'LIVE',providerFulfilled:true,expectedNetRaw:'12000000',receivedRaw:'12000000',payments:[{id:'example-payment',status:'SETTLED',amountRaw:'12000000',receipt}]};
const orders=[
 {...checkout,id:'wallet-arrived',status:'checkout_received',verification:verified,delivery:{...receipt,receipts:[receipt]}},
 {...checkout,id:'wallet-confirming',status:'checkout_confirming',verification:{...verified,receivedRaw:'0',payments:[{...verified.payments[0],receipt:{...receipt,finalized:false}}]}},
 {...checkout,id:'wallet-partial',status:'checkout_partial',verification:{...verified,providerFulfilled:false}},
 {...checkout,id:'wallet-unavailable',status:'checkout_settled',trackingError:'Verification is temporarily unavailable. The last verified result is retained.',verification:{...verified,receivedRaw:'0',payments:[]}},

 {...template,id:'ready',status:'ready_to_reserve'},
 {...template,id:'pay',status:'awaiting_payment',intentHash:hash},
 {...template,id:'received',status:'received',intentHash:hash,delivery:{amountRaw:'12000000',transactionHash:hash,recipient:address,tokenAddress:TOKEN,chainId:8453}},
 {...template,id:'unknown',status:'reservation_unknown'},
];
const server=createApp({workerIntervalMs:0,payService:{readiness:async()=>({ready:false,reason:'Visual preview only'}),refresh:async()=>{throw Error('Visual preview only');},create:async()=>{throw Error('Visual preview only');}},cookieName:'relay_peer_fixture',initialSession:()=>({previewMode:true,agents:[agent],orders:structuredClone(orders),lastQuote:null}),offerService:async()=>{throw Error('Visual preview only');},prepareService:async()=>{throw Error('Visual preview only');},reconcileService:async()=>{throw Error('Visual preview only');},rpcService:async()=>{throw Error('Visual preview only');}});
server.listen(4320,'127.0.0.1',()=>console.log('Fixture-only visual preview on 4320. No wallet or payment actions.'));
