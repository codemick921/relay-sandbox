// Fixed diagnostic vocabulary only. Never serialize errors, identities or tokens.
export const walletAuthStages=Object.freeze({
 eligibility:'Test access',session_reset:'Previous browser session',token_issuance:'Eupova sign-in token',
 provider_authentication:'Privy sign-in',client_identity:'Approved account',access_token:'Privy access token',
 server_access_token:'Server token verification',server_inventory:'Wallet details',server_identity:'Wallet match',
 server_permission:'Test access recheck',proof_validation:'Final check',disconnect:'Browser disconnect'
});
const codes=new Set(['failed','timeout','invalid','unavailable','access_changed','not_recognised','rate_limited','unexpected_session','pending_authentication','local_state_unconfirmed']);
export function safeWalletAuthDiagnostic(value){
 return value&&Object.hasOwn(walletAuthStages,value.stage)&&codes.has(value.code)?{stage:value.stage,code:value.code}:null;
}
export class WalletAuthFailure extends Error{
 constructor(stage,code='failed'){super('wallet_auth_failed');this.diagnostic=safeWalletAuthDiagnostic({stage,code});}
}
export async function walletAuthStep(stage,work){
 try{return await work();}catch(error){if(error instanceof WalletAuthFailure)throw error;throw new WalletAuthFailure(stage);}
}
