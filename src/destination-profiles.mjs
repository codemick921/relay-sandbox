// Documentation-backed guidance, not account verification or payment eligibility.
export const destinationProfiles = [
 {id:'base',name:'Base wallet',description:'A receiving address in your wallet.',icon:'wallet',title:'Receive USDC on Base',route:'USDC · Base mainnet',intro:'Open your wallet’s Receive screen and copy the address for USDC on Base.',steps:[
  ['Choose the asset and network','Select native USDC and Base mainnet. Ethereum, Base Sepolia and other networks are different destinations.'],
  ['Copy your receiving address','Copy the full address shown for your account. The USDC token contract is not your receiving address.'],
  ['Check before funding','Compare the full address in Eupova with your wallet. Check any receiving restrictions before saving it.']
 ],sources:[{label:'Circle: USDC networks',url:'https://developers.circle.com/stablecoins/usdc-contract-addresses'}],checked:'2026-11-02',evidence:'Token and network documentation checked'},
 {id:'hosted',name:'Another platform',description:'An agent wallet or deposit account inside a platform.',icon:'robot',title:'Use your platform’s deposit instructions',route:'Requires a Base USDC deposit route',intro:'Open Deposit or Add funds in the platform that holds your agent’s balance. Use the instructions for your own account.',steps:[
  ['Check what the platform accepts','The instructions must explicitly accept native USDC on Base. A wallet name or a 0x address does not establish this.'],
  ['Check the deposit conditions','Look for a minimum amount, expiry, memo, reference, sender restriction or required contract call. This checkout cannot add a deposit memo or make a special contract call.'],
  ['Copy the account’s deposit address','Use a current receiving address, not a token contract or an example from documentation. Check the expected USDC against any minimum before paying.']
 ],sources:[],evidence:'General checklist · follow your platform’s current instructions'},
 {id:'tempo',name:'Tempo Wallet',description:'Funding an account on the Tempo network.',icon:'bank',title:'Check Tempo’s funding route first',route:'Tempo delivery is not connected in Eupova',intro:'Eupova’s current Peer checkout delivers USDC on Base. Sending to a Tempo account address on Base does not establish a deposit on Tempo.',steps:[
  ['Open Add funds in Tempo Wallet','Choose a funding method available to your account and read the instructions it provides.'],
  ['Review any cross-network deposit','If Tempo offers funding from another network, check its source token, network, receiving address, minimum, fees and expiry. Do not reuse a Tempo address as a Base deposit address unless the supplied instructions explicitly say to.'],
  ['Confirm credit in Tempo','A transfer on Base and a credited Tempo balance are separate events. Eupova does not yet bridge to Tempo or verify credit in your Tempo account.']
 ],sources:[{label:'Tempo: funding an account',url:'https://tempo.xyz/developers/docs/guide/getting-funds'},{label:'Tempo: deposit flow',url:'https://accounts.tempo.xyz/docs/guides/deposits'}],checked:'2026-11-02',evidence:'Provider documentation checked'}
];
export const receivingQuestions=[
 {id:'network',label:'Do the instructions explicitly accept native USDC on Base?'},
 {id:'simple',label:'Can this deposit receive a normal token transfer without a memo, reference or special contract call?'},
 {id:'conditions',label:'Have you checked the minimum, expiry and any sender restrictions for this payment route?'}
];
export function receivingGuidance(profileId,answers={}){
 if(profileId==='tempo')return {kind:'unsupported',title:'Tempo delivery needs a separate route',detail:'Follow Tempo’s own funding instructions. This guide does not make the current Eupova checkout a Tempo deposit route.'};
 if(!['base','hosted'].includes(profileId))return {kind:'pending',title:'Choose a receiving guide',detail:'Choose where your agent will receive funds.'};
 if(answers.network==='no')return {kind:'unsupported',title:'Use a different receiving route',detail:'This checkout sends native USDC on Base. Use a receiving destination whose instructions accept that asset and network.'};
 if(answers.simple==='no')return {kind:'unsupported',title:'Extra deposit steps are needed',detail:'Do not use this checkout for a deposit that requires a memo, payment reference or special contract call. Follow the platform’s supported deposit method.'};
 if(answers.conditions==='no')return {kind:'pending',title:'Check the deposit conditions first',detail:'Review the minimum, expiry and sender restrictions in your receiving platform before funding.'};
 if(receivingQuestions.every(q=>answers[q.id]==='yes'))return {kind:'reviewed',title:'Your instructions checklist is complete',detail:'This reflects your answers, not verification of the account. Check the full address and the final USDC amount before paying.'};
 return {kind:'pending',title:'Check your receiving instructions',detail:'Answer each question using your wallet or platform’s current deposit screen. Eupova has not checked this account.'};
}
