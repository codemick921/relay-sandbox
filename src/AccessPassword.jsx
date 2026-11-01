import React,{useState,useRef,useLayoutEffect} from 'react';

export default function AccessPassword({id,label,hint,onChange,...props}){
 const [visible,setVisible]=useState(false),input=useRef(null),selection=useRef(null),frame=useRef(null);
 // Restore after the browser changes the input type; cancel if the user types first.
 useLayoutEffect(()=>{if(!selection.current)return;const range=selection.current;selection.current=null;frame.current=requestAnimationFrame(()=>{input.current?.setSelectionRange(...range);frame.current=null;});return()=>cancelAnimationFrame(frame.current);},[visible]);
 return <div className="field auth-password">
  <label htmlFor={id}>{label}</label>
  <div className="auth-password-control">
   <input {...props} ref={input} id={id} type={visible?'text':'password'} aria-describedby={hint?`${id}-hint`:undefined} onChange={e=>{cancelAnimationFrame(frame.current);frame.current=null;onChange?.(e);}}/>
   <button type="button" className="auth-password-toggle" aria-controls={id} aria-label={visible?'Hide password':'Show password'} aria-pressed={visible} onPointerDown={e=>e.preventDefault()} onClick={()=>{cancelAnimationFrame(frame.current);selection.current=[input.current.selectionStart,input.current.selectionEnd];setVisible(v=>!v);}}>{visible?'Hide':'Show'}</button>
  </div>
  {hint&&<small id={`${id}-hint`}>{hint}</small>}
 </div>;
}
