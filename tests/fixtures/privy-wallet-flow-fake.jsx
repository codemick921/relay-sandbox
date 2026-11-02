// Only used by isolated browser tests. No provider imports or external calls.
export {PrivyProvider,useSubscribeToJwtAuthWithFlag} from './privy-wallet-auth-fake';
import {usePrivy} from './privy-wallet-auth-fake';
export {usePrivy};
export function useCreateWallet(){const sdk=usePrivy();return{createWallet:async options=>{
 window.__sample.creates++;if(options.createAdditional!==false)throw Error('Unexpected creation option');
 window.__sample.user={...window.__sample.user,linkedAccounts:[...window.__sample.user.linkedAccounts,window.__sample.wallet]};sdk.setState({authenticated:true,user:window.__sample.user});return window.__sample.wallet;
}};}
