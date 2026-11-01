import {fundingCatalog,knownCurrency,supportsFunding,minimumMinor} from './fiat.mjs';

// Local capability checks only. An EVM address cannot prove network support,
// ownership, service acceptance or an agent's permission to spend.
export const fundingAssets=Object.freeze([
 {id:'base-usdc',label:'USDC on Base',network:'Base',token:'USDC',chainId:8453,contract:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'},
 {id:'tempo-ousd',label:'OUSD on Tempo',network:'Tempo',token:'OUSD',chainId:4217,contract:'0x20c0000000000000000000006a37da5c996874be'},
 {id:'tempo-usdce',label:'USDC.e on Tempo',network:'Tempo',token:'USDC.e',chainId:4217,contract:'0x20c000000000000000000000b9537d11c60e8b50'}
]);
const address=value=>typeof value==='string'&&/^0x[\da-f]{40}$/i.test(value)&&!/^0x0{40}$/i.test(value);
export function fundingCompatibility({agent,rail,currency='GBP',amountMinor,targetAsset='base-usdc',route='merchant',walletCurrent=true}={}){
 const checks=[],add=(id,label,status,detail)=>checks.push({id,label,status,detail});
 const target=fundingAssets.find(x=>x.id===targetAsset),method=fundingCatalog.methods.find(x=>x.id===rail);
 const savedWallet=!!agent&&address(agent.address)&&agent.network==='Base'&&agent.token==='USDC'&&walletCurrent!==false;
 add('wallet','Receiving wallet',savedWallet?'pass':'blocked',savedWallet?'Saved Base USDC address. Ownership has not been verified.':walletCurrent===false?'The saved wallet changed. Prepare a new draft with the updated address.':'Choose a saved wallet that supports USDC on Base.');
 const destination=target?.id==='base-usdc';
 add('asset','Asset your agent needs',destination?'pass':'blocked',destination?'This route delivers native USDC on Base.':target?`${target.label} needs a different route. Eupova has no connected Tempo delivery or conversion for this checkout.`:'Choose the exact token and network your agent needs.');
 const connected=route==='merchant'&&knownCurrency(currency)&&supportsFunding(rail,currency);
 add('route','Payment route',connected?'pass':'blocked',route==='p2p'?'Direct P2P funding is not available here yet. No request will be created.':connected?`${method.label} supports ${currency} in this checkout. A current offer and account eligibility are still unconfirmed.`:'This method and currency are not connected to Eupova checkout.');
 const amountOK=Number.isSafeInteger(amountMinor)&&amountMinor>=minimumMinor(rail,currency)&&amountMinor<=100000;
 add('amount','Request amount',amountOK?'pass':'blocked',amountOK?`Within Eupova’s request bounds for ${currency}. Provider limits may differ.`:'Enter an amount within the bounds shown above.');
 add('policy','Payment-account rules',rail==='wise'?'blocked':'unknown',rail==='wise'?'Wise account policy prohibits transfers to individuals to buy crypto. This can be saved for review, but it is not a supported payment recommendation.':'Payment-account rules, country eligibility and own-name requirements must be checked before a real payment.');
 add('verification','Verification on your device','unknown','Phone, identity or extension requirements depend on the actual offer. Eupova has not confirmed an installation-free route.');
 add('spending','Agent spending readiness','unknown','A matching address does not prove that your agent can spend. Service acceptance, available balance and spending permissions have not been checked.');
 return {checks,target:target??null,canSaveDraft:savedWallet&&destination&&connected&&amountOK,readyForPayment:false,
  title:!savedWallet||!destination||!connected||!amountOK?'Change these details before saving':rail==='wise'?'Payment method needs attention':'Destination matches · live checks still needed'};
}
