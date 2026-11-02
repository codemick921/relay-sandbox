import React,{useCallback,useEffect,useRef,useState} from 'react';
import {PrivyProvider,usePrivy,useSubscribeToJwtAuthWithFlag} from '@privy-io/react-auth';
import {PRIVY_APP_ID} from './privy-connection-client.mjs';
import {createWalletAuthSession,walletAuthConfig} from './wallet-bootstrap-client.mjs';
export const walletAuthMessages={idle:'Ready to check your buying wallet.',preparing:'Preparing your private connection…',connecting:'Checking your Eupova sign-in with Privy…',verifying:'Checking the wallet against your approved test details…',no_wallet:'Your sign-in is confirmed. There is no buying wallet yet.',wallet_recognised:'Your approved buying wallet was found. This does not enable payments.',verification_expired:'The wallet check has expired. Check again for a fresh result.',disconnecting:'Disconnecting…',disconnected:'Disconnected. Return to Eupova to start a fresh test.',blocked:'The account or wallet could not be confirmed. This test has stopped.',cleanup_failed:'Disconnect could not be confirmed. Retry when you are online.'};
function Session({initial}){
 const sdk=usePrivy(),sdkRef=useRef(sdk);sdkRef.current=sdk;
 const [view,setView]=useState({phase:'idle',proof:null}),session=useRef(null);
 if(!session.current)session.current=createWalletAuthSession({initial,logout:()=>sdkRef.current.logout(),getAccessToken:()=>sdkRef.current.getAccessToken(),onChange:setView});
 const sync=session.current.active,getExternalJwt=useCallback(()=>session.current.getExternalJwt(),[]);
 useSubscribeToJwtAuthWithFlag({enabled:sync,isAuthenticated:sync,isLoading:false,getExternalJwt,onError:()=>void session.current.end('blocked')});
 useEffect(()=>{if(sdk.ready&&view.phase==='idle')void session.current.start(true);},[sdk.ready,view.phase]);
 useEffect(()=>{if(sdk.ready)void session.current.providerState(sdk.authenticated,sdk.user);},[sdk.ready,sdk.authenticated,sdk.user]);
 useEffect(()=>{
  const refresh=()=>void session.current.refresh(),stop=()=>void session.current.end('disconnected');
  const t=setInterval(refresh,15000),expiry=setTimeout(stop,Math.max(0,initial.expiresAt-Date.now()));
  const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('eupova-auth-events'):null;if(channel)channel.onmessage=stop;
  window.addEventListener('focus',refresh);window.addEventListener('online',refresh);window.addEventListener('pagehide',stop);
  return()=>{clearInterval(t);clearTimeout(expiry);channel?.close();window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);window.removeEventListener('pagehide',stop);void session.current.close();};
 },[initial]);
 useEffect(()=>{if(!['preparing','connecting','verifying'].includes(view.phase))return;const t=setTimeout(()=>void session.current.end('blocked'),30000);return()=>clearTimeout(t);},[view.phase]);
 const ended=['disconnected','blocked'].includes(view.phase);
 return <section className="privy-test-status"><h2>Buying wallet check</h2><p role="status">{walletAuthMessages[view.phase]}</p>{view.proof?.address&&<p className="wallet-auth-address">{view.proof.address}</p>}{view.phase==='verification_expired'&&<button className="btn" onClick={()=>void session.current.recheck()}>Check again</button>}{!ended&&<button className="btn" disabled={view.phase==='disconnecting'} onClick={()=>void session.current.end()}>{view.phase==='cleanup_failed'?'Retry disconnect':'Disconnect'}</button>}<p className="buyer-connection-footnote">This checks the account and wallet only. Quotes, wallet creation and payments remain unavailable.</p></section>;
}
export default function PrivyWalletAuthSdk({initial}){return <PrivyProvider appId={PRIVY_APP_ID} config={walletAuthConfig}><Session initial={initial}/></PrivyProvider>;}
