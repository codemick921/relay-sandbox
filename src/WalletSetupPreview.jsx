import WalletSetupFlow from './WalletSetupFlow';
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createWalletSetupController} from './wallet-setup-state.mjs';
import TargetCalculator from './TargetCalculator';
import {Icon} from './ui';
import mark from './assets/eupova-mark.png';
import './styles.css';
import './wallet-setup.css';
const scenarios=[['success','New wallet'],['existing','Wallet already exists'],['cancelled','User cancels setup'],['failure','Creation fails'],['timeout','Result is uncertain'],['expired','Session expired'],['wrongIdentity','Account mismatch'],['verifyFailed','Wallet check fails'],['slow','Slow response / reload']];
async function query(scenario,op,input){const r=await fetch('/__wallet_setup/'+op,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario,...(input?{input}:{})})});if(!r.ok)throw Error('sample_context_changed');return r.json();}
function Flow({scenario}){const request=React.useCallback((op,input)=>query(scenario,op,input),[scenario]);return <WalletSetupFlow scenario={scenario} request={request}/>;}
function Preview(){const initial=new URLSearchParams(location.search).get('scenario');const[scenario,setScenario]=useState(scenarios.some(([s])=>s===initial)?initial:'success'),[revision,setRevision]=useState(0),[resetting,setResetting]=useState(false),[error,setError]=useState('');
 async function reset(){setResetting(true);setError('');try{await query(scenario,'reset');setRevision(x=>x+1);}catch{setError('The sample could not be restarted. Reload the page to try again.');}finally{setResetting(false);}}
 return <main className="wallet-setup-page"><header className="wallet-setup-top"><div className="brand"><img src={mark} alt=""/>Eupova</div><div className="wallet-setup-demo-controls"><label>Sample scenario<select value={scenario} onChange={e=>{setScenario(e.target.value);setError('');history.replaceState(null,'','?scenario='+e.target.value);}}>{scenarios.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><button className="btn btn-secondary" disabled={resetting} onClick={reset}>{resetting?'Restarting…':'Restart sample'}</button></div></header><div className="wallet-setup-banner"><Icon name="info" size={19}/>Sample preview. No real sign-in, wallet or payment.</div>{error&&<p role="alert">{error}</p>}<div className="wallet-setup-intro"><span className="wallet-setup-kicker">Your direct funding setup</span><h1>Set up your buying wallet.</h1><p>Try the next step towards personalised quotes, with your agent’s destination kept separate.</p></div>{!resetting&&<Flow key={scenario+revision} scenario={scenario}/>}<footer className="wallet-setup-footer">Eupova · Development preview · Real wallet creation remains disabled</footer></main>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
