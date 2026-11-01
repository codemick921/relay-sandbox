import React,{useEffect,useRef,useState} from 'react';
import {api} from './api';
import {Button,Field,Icon,Modal,Notice} from './ui';
import {prepareProfileImage,cropProfileImage,profileInitials} from './profile-image.mjs';
import './profile-picture.css';
export default function ProfilePicture({account}){
 const [picture,setPicture]=useState(null),[draft,setDraft]=useState(null),[image,setImage]=useState(null),[zoom,setZoom]=useState(1),[opened,setOpened]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[processing,setProcessing]=useState(false),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[message,setMessage]=useState(''),[preview,setPreview]=useState(false);
 const sequence=useRef(0),trigger=useRef(null),alive=useRef(true);
 async function load(){setLoading(true);setLoadError('');try{const r=await api('profile');if(alive.current){setPicture(r.picture);setDraft(r.picture);setPreview(!!r.preview);}}catch(e){if(alive.current)setLoadError(e.message);}finally{if(alive.current)setLoading(false);}}
 useEffect(()=>{alive.current=true;load();return()=>{alive.current=false;sequence.current++;};},[]);
 function close(){if(busy)return;sequence.current++;setProcessing(false);setOpened(false);setImage(null);setDraft(picture);setError('');requestAnimationFrame(()=>trigger.current?.focus());}
 function open(){setDraft(picture);setImage(null);setZoom(1);setError('');setMessage('');setOpened(true);}
 async function choose(file){if(!file)return;const ticket=++sequence.current;setProcessing(true);setError('');setMessage('');try{const next=await prepareProfileImage(file),cropped=cropProfileImage(next);if(alive.current&&ticket===sequence.current){setImage(next);setZoom(1);setDraft(cropped);setMessage('Picture ready to save.');}}catch(e){if(alive.current&&ticket===sequence.current)setError(e.message);}finally{if(alive.current&&ticket===sequence.current)setProcessing(false);}}
 async function save(){setBusy(true);setError('');setMessage('');try{const r=await api('profile',{picture:draft});if(alive.current){setPicture(r.picture);setDraft(r.picture);setImage(null);setMessage(r.picture?'Profile picture saved.':'Profile picture removed.');}}catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}}
 const initials=profileInitials(account.name),changed=draft!==picture;
 return <><button type="button" ref={trigger} className="profile-avatar" aria-label="Edit profile picture" title="Edit profile picture" onClick={open}>{picture?<img src={picture} alt=""/>:<span>{initials}</span>}<span className="profile-avatar-edit" aria-hidden="true"><Icon name="camera" size={12}/></span></button>
 {opened&&<Modal title="Your profile picture" onClose={close}>
  <div className="profile-editor">
   <p>Add a picture to personalise your Eupova account.</p>
   {preview&&<Notice>This is a local design preview. Picture changes stay in this sample account and reset when the preview restarts.</Notice>}
   {loadError&&<Notice error>{loadError} <button type="button" className="text-button" onClick={load}>Try again</button></Notice>}
   {loading?<p role="status">Loading your picture…</p>:!loadError&&<>
    <div className="profile-image-preview" aria-label="Profile picture preview">{draft?<img src={draft} alt="Your selected profile picture"/>:<span>{initials}</span>}</div>
    <Field label="Choose a picture"><input aria-describedby="profile-image-requirements" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy||processing} onChange={e=>{choose(e.target.files?.[0]);e.target.value='';}}/></Field>
    <p id="profile-image-requirements" className="profile-image-note">JPG, PNG or WebP, up to 5 MB. The picture is cropped to a square.</p>
    {image&&<Field label="Zoom"><input type="range" min="1" max="3" step="0.05" value={zoom} disabled={busy||processing} onChange={e=>{const z=Number(e.target.value);setZoom(z);setDraft(cropProfileImage(image,z));setMessage('');}}/></Field>}
    <p className="profile-image-note">Only the cropped picture is saved when you select Save picture. Image metadata is removed.</p>
    {(picture||draft)&&<Button secondary disabled={busy||processing} onClick={()=>{setDraft(null);setImage(null);setError('');setMessage('');}}>Remove picture</Button>}
    {picture&&draft===null&&<p>Save changes to return to your initials.</p>}
    <div className="profile-editor-actions"><Button disabled={busy||processing||!changed} onClick={save}>{busy?'Saving…':draft===null?'Save changes':'Save picture'}</Button><Button secondary disabled={busy} onClick={close}>{changed?'Cancel':'Done'}</Button></div>
   </>}
   {error&&<Notice error>{error}</Notice>}<p className="profile-editor-status" role="status">{processing?'Preparing your picture…':message}</p>
  </div>
 </Modal>}
 </>;
}
