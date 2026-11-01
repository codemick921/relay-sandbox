import React,{useState} from 'react';
import {recoveryPlan,recoverySummary} from '../shared/funding-recovery.mjs';
import {Button} from './ui';
export default function RecoveryGuide({record}){
 const [sent,setSent]=useState('unsure'),[message,setMessage]=useState('');
 const plan=recoveryPlan(record,sent);
 async function copy(){try{await navigator.clipboard.writeText(recoverySummary(record,sent));setMessage('Status summary copied. Review it before sharing.');}catch{setMessage('Copy is unavailable. Use the downloadable status summary below.');}}
 return <section className="recovery-guide" aria-label="Payment recovery guide">
  <h4>Follow this payment safely</h4>
  <ol className="recovery-milestones">{plan.steps.map(step=><li key={step.label}><strong>{step.label}</strong><span>{step.status}</span></li>)}</ol>
  <label className="field"><span>Have you sent or scheduled payment?</span><select aria-label="Have you sent or scheduled payment?" value={sent} onChange={e=>{setSent(e.target.value);setMessage('');}}><option value="unsure">I’m not sure</option><option value="yes">Yes, sent or scheduled</option><option value="no">No, neither</option></select></label>
  <p className="fine-print">Your answer stays on this screen. It does not change the payment record.</p>
  <section className="recovery-next" aria-live="polite"><h4>What to do next</h4><p>{plan.action}</p><p className="fine-print">Next step handled by: {plan.owner}</p></section>
  <details><summary>What to keep if you need help</summary><ul>{plan.keep.map(item=><li key={item}>{item}</li>)}</ul><p>{plan.reminder}</p><Button secondary onClick={copy}>Copy status summary</Button><p role="status">{message}</p><p className="fine-print">Includes request references and amounts. It contains no checkout link or bank details. Review it before sharing; nothing is sent automatically.</p></details>
 </section>;
}
