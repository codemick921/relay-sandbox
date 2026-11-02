import React,{useState,useEffect} from 'react';
import PartnerFunding from './PartnerFunding';
import {createRoot} from 'react-dom/client';
import Access from './Access';
import './styles.css';
function Root(){const [partner,setPartner]=useState(()=>location.hash==='#partners');useEffect(()=>{const follow=()=>setPartner(location.hash==='#partners');window.addEventListener('hashchange',follow);return()=>window.removeEventListener('hashchange',follow);},[]);return partner?<PartnerFunding/>:<Access/>;}
createRoot(document.getElementById('root')).render(<Root/>);
