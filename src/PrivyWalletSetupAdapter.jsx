import {useEffect,useRef} from 'react';
import {usePrivy,useCreateWallet} from '@privy-io/react-auth';
import {createRealWalletSetupAdapter,browserWalletSetupGuards} from './real-wallet-setup-adapter.mjs';
// Mounted only after restricted-flow sign-in; creation requires a separate server capability.
// No sign-in, token issuance, creation on mount or creation from an effect.
export const walletSetupProviderConfig={embeddedWallets:{ethereum:{createOnLogin:'off'},solana:{createOnLogin:'off'},disableAutomaticMigration:true},externalWallets:{disableAllExternalWallets:true,walletConnect:{enabled:false}},appearance:{theme:'light',accentColor:'#254f3b'}};
export function useRestrictedWalletSetup({lease,observe,claimDispatch,onChange,enabled=false}){
 const sdk=usePrivy(),{createWallet}=useCreateWallet(),current=useRef(null),controller=useRef(null),facade=useRef(null);
 current.current={sdk,lease,observe,claimDispatch,onChange,createWallet,enabled};
 if(!facade.current)facade.current={inspect:()=>controller.current?.inspect(),create:input=>controller.current?.create(input),stop:()=>controller.current?.stop()};
 useEffect(()=>{
  // Browser storage can throw even on property access (private/blocked storage).
  let locks,storage;try{locks=globalThis.navigator?.locks;storage=globalThis.localStorage;}catch{}
  const guards=browserWalletSetupGuards({locks,storage});
  const c=createRealWalletSetupAdapter({enabled:()=>current.current.enabled===true,getLease:()=>current.current.lease,getSdkState:()=>current.current.sdk,
   createWallet:options=>current.current.createWallet(options),observe:()=>current.current.observe(),claimDispatch:input=>current.current.claimDispatch?.(input),onChange:s=>current.current.onChange?.(s),...guards});
  controller.current=c;return()=>{c.stop();if(controller.current===c)controller.current=null;};
 },[]);
 return facade.current;
}
