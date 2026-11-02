import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import TargetCalculator from './TargetCalculator';
import mark from './assets/eupova-mark.png';
import './styles.css';
function Preview(){const[scenario,setScenario]=useState('live');
 async function searchQuotes(input){const r=await fetch('/__calculator',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input,scenario})});const d=await r.json();if(!r.ok){const e=Error(d.error);e.status=r.status;throw e;}return d;}
 return <main className="target-preview"><header className="target-preview-header"><div className="brand"><img src={mark} alt=""/>Eupova</div><label>Preview scenario<select value={scenario} onChange={e=>setScenario(e.target.value)}><option value="live">Current public prices</option><option value="available">Sample · available</option><option value="none">Sample · no offers</option><option value="invalid">Sample · inconsistent fees</option><option value="expiry">Sample · refresh needed</option><option value="failure">Sample · provider unavailable</option></select></label></header><div className="target-preview-mode">{scenario==='live'?'Live, read-only comparison using example addresses.':'Sample data for this preview.'} No account changes, wallets, payments or checkouts.</div><TargetCalculator key={scenario} sample={scenario!=='live'} searchQuotes={searchQuotes}/></main>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
